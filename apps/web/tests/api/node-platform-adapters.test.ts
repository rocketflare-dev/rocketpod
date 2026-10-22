// @vitest-isolate
// Talks to the S3 gateway in docker-compose.test.yml and opens its own Postgres connections per
// check (no process pool), so it runs in a fork of its own.
/**
 * The Node platform's storage, rate limiter, locks, document converter and platform AI tiers
 * (M6). Storage runs against the S3 gateway `pnpm test` starts (`s3-test`, `.env.test`); the
 * limiter and locks against the test database; the converter on documents built in-test; the AI
 * tiers with a recording fetch — no network.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { DEFAULT_CHAT_MODELS } from '@rocketpod/shared/ai/config'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { operationLock } from '@/api/middleware/rate-limit'
import { runPruneExpired } from '@/api/scheduled'
import type { FetchLike } from '@/api/services/ai/client'
import { platformChat, readiness, resolveEmbeddings } from '@/api/services/ai/resolve'
import { loadConfig } from '@/config'
import { operationLocks, rateLimits } from '@/db/schema'
import { createNodeConverter, htmlToText } from '@/node/converter'
import { createPostgresLocks, createPostgresRateLimiter } from '@/node/limits'
import { createNodePlatform } from '@/node/platform'
import { createS3Storage, quoteEtag, storageConfigOf } from '@/node/storage'
import { type GetOptions, StorageRangeNotSatisfiableError } from '@/platform/types'
import { setupTestDatabase, testDatabaseUrl } from '../helpers/db'

const db = setupTestDatabase()
const env = { ...process.env, DATABASE_URL: testDatabaseUrl() }
const config = loadConfig(env)

// ---- S3 storage ---------------------------------------------------------------------------------

const s3 = storageConfigOf(config)
let s3Reachable = false
beforeAll(async () => {
  if (!s3?.endpoint) return
  try {
    // Any HTTP answer (the gateway's 403 to an unsigned GET) means it is up.
    await fetch(s3.endpoint, { signal: AbortSignal.timeout(2000) })
    s3Reachable = true
  } catch {
    console.warn(
      `S3 gateway not reachable at ${s3.endpoint} — start it with \`pnpm web test:db:up\` (docker-compose.test.yml s3-test). Skipping the storage tests.`
    )
  }
})

describe('S3 storage (StorageService over the S3 API)', () => {
  const prefix = `tenants/${randomUUID()}/`
  const storage = () => {
    if (!s3) throw new Error('.env.test has no STORAGE_* — the gate configures the S3 gateway')
    return createS3Storage(s3)
  }

  afterAll(async () => {
    if (!s3Reachable || !s3) return
    const left = await storage().list(prefix)
    await storage().deleteMany(left.map(o => o.key))
  })

  it('is configured by .env.test, and absent without STORAGE_DRIVER', () => {
    expect(s3).not.toBeNull()
    expect(storageConfigOf(loadConfig({ ...env, STORAGE_DRIVER: '' }))).toBeNull()
    expect(storageConfigOf(loadConfig({ ...env, STORAGE_BUCKET: '' }))).toBeNull()
    expect(createNodePlatform(loadConfig({ ...env, STORAGE_DRIVER: '' })).storage).toBeNull()
  })

  it('round-trips bytes, content type and case-preserved metadata, streamed', async ({ skip }) => {
    if (!s3Reachable) skip()
    const key = `${prefix}uploads/${randomUUID()}-hello.txt`
    const put = await storage().put(key, new Blob(['hello, storage']), {
      contentType: 'text/plain',
      metadata: { tenantId: 't-1', ownerUserId: 'u-1', scope: 'uploads' },
    })
    expect(put).toMatchObject({ key, size: 14, contentType: 'text/plain' })
    expect(put.etag).toMatch(/^"[0-9a-f]+"$/)

    const head = await storage().head(key)
    expect(head).toMatchObject({
      key,
      size: 14,
      contentType: 'text/plain',
      etag: put.etag,
      metadata: { tenantId: 't-1', ownerUserId: 'u-1', scope: 'uploads' },
    })
    expect(head?.uploaded).toBeInstanceOf(Date)

    const got = await storage().get(key)
    expect(got?.body).toBeInstanceOf(ReadableStream)
    expect(await new Response(got?.body).text()).toBe('hello, storage')
    expect(got?.metadata).toEqual({ tenantId: 't-1', ownerUserId: 'u-1', scope: 'uploads' })
  })

  it('accepts every body form put takes', async ({ skip }) => {
    if (!s3Reachable) skip()
    const bodies = [
      'a string',
      new TextEncoder().encode('a view'),
      new TextEncoder().encode('a buffer').buffer,
      new Blob(['a blob']),
    ]
    for (const [i, body] of bodies.entries()) {
      const key = `${prefix}forms/${i}`
      await storage().put(key, body, { contentType: 'application/octet-stream' })
      const got = await storage().get(key)
      expect(await new Response(got?.body).text()).toMatch(/^a (string|view|buffer|blob)$/)
    }
  })

  it('answers null for a missing key, and deleting one is not an error', async ({ skip }) => {
    if (!s3Reachable) skip()
    expect(await storage().get(`${prefix}missing`)).toBeNull()
    expect(await storage().head(`${prefix}missing`)).toBeNull()
    await expect(storage().delete(`${prefix}missing`)).resolves.toBeUndefined()
  })

  it('pages a prefix with a cursor, and deleteMany clears it across chunks', async ({ skip }) => {
    if (!s3Reachable) skip()
    const dir = `${prefix}paged/`
    const keys = Array.from({ length: 7 }, (_, i) => `${dir}${String(i).padStart(2, '0')}`)
    for (const key of keys) await storage().put(key, key, { contentType: 'text/plain' })

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await storage().listPage(dir, { cursor, limit: 3 })
      expect(page.objects.length).toBeLessThanOrEqual(3)
      for (const obj of page.objects) {
        // A listing carries no content type or metadata — exactly like R2's `list`.
        expect(obj).toMatchObject({ contentType: 'application/octet-stream', metadata: {} })
        expect(obj.etag).toMatch(/^"[0-9a-f-]+"$/)
        seen.push(obj.key)
      }
      cursor = page.cursor
      pages += 1
    } while (cursor)
    expect(pages).toBe(3)
    expect(seen).toEqual(keys)
    expect((await storage().list(dir)).map(o => o.key)).toEqual(keys)

    // Three keys per DeleteObjects call: seven keys take three calls.
    const chunked = createS3Storage(s3 as NonNullable<typeof s3>, undefined, 3)
    await chunked.deleteMany(keys)
    expect(await storage().list(dir)).toEqual([])
    await expect(chunked.deleteMany([])).resolves.toBeUndefined()
  })

  it('reads exactly the bytes a range names, and reports which of how many', async ({ skip }) => {
    if (!s3Reachable) skip()
    const key = `${prefix}ranges/${randomUUID()}`
    const bytes = randomBytes(1000)
    await storage().put(key, bytes, { contentType: 'video/webm' })
    const read = async (range: GetOptions | undefined) => {
      const got = await storage().get(key, range)
      return {
        bytes: new Uint8Array(await new Response(got?.body).arrayBuffer()),
        range: got?.range,
        size: got?.size,
      }
    }

    // `bytes=a-b`, end inclusive; `size` stays the whole object's, not the slice's.
    const closed = await read({ range: { start: 100, end: 199 } })
    expect(closed.bytes).toEqual(new Uint8Array(bytes.subarray(100, 200)))
    expect(closed.range).toEqual({ start: 100, end: 199, total: 1000 })
    expect(closed.size).toBe(1000)

    // `bytes=a-` to the end, and an end past the object clamped to its last byte.
    const open = await read({ range: { start: 990 } })
    expect(open.bytes).toEqual(new Uint8Array(bytes.subarray(990)))
    expect(open.range).toEqual({ start: 990, end: 999, total: 1000 })
    expect((await read({ range: { start: 995, end: 5000 } })).range).toEqual({
      start: 995,
      end: 999,
      total: 1000,
    })

    // `bytes=-n`, the last n bytes; a suffix longer than the object reads all of it.
    const suffix = await read({ range: { suffix: 7 } })
    expect(suffix.bytes).toEqual(new Uint8Array(bytes.subarray(993)))
    expect(suffix.range).toEqual({ start: 993, end: 999, total: 1000 })
    expect((await read({ range: { suffix: 5000 } })).range).toEqual({
      start: 0,
      end: 999,
      total: 1000,
    })

    // No range asked, none answered.
    const whole = await read(undefined)
    expect(whole.range).toBeUndefined()
    expect(whole.bytes).toEqual(new Uint8Array(bytes))
  })

  it('answers a range past the end as not satisfiable, and refuses a malformed one', async ({
    skip,
  }) => {
    if (!s3Reachable) skip()
    const key = `${prefix}ranges/${randomUUID()}`
    await storage().put(key, randomBytes(100), { contentType: 'video/webm' })

    await expect(storage().get(key, { range: { start: 100 } })).rejects.toBeInstanceOf(
      StorageRangeNotSatisfiableError
    )
    // A missing key is still null, ranged or not.
    expect(await storage().get(`${prefix}missing`, { range: { start: 0 } })).toBeNull()
    // S3 IGNORES a malformed Range and answers 200 with the whole object; never send one.
    await expect(storage().get(key, { range: { start: 50, end: 10 } })).rejects.toThrow(RangeError)
    await expect(storage().get(key, { range: { start: -1 } })).rejects.toThrow(RangeError)
  })

  it('streams a body of unknown length up in parts, byte-exact', async ({ skip }) => {
    if (!s3Reachable) skip()
    const key = `${prefix}streams/${randomUUID()}`
    const MiB = 1024 * 1024
    // 6.5 MiB in 1 MiB pieces: more than one 5 MiB part, the last piece short.
    const pieces = [...Array.from({ length: 6 }, () => randomBytes(MiB)), randomBytes(MiB / 2)]
    const total = pieces.reduce((n, p) => n + p.byteLength, 0)
    const expected = createHash('sha256')
    for (const p of pieces) expected.update(p)
    let i = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = pieces[i++]
        if (next) controller.enqueue(new Uint8Array(next))
        else controller.close()
      },
    })

    const put = await storage().putStream(key, body, {
      contentType: 'video/webm',
      metadata: { tenantId: 't-1', fileId: 'f-1' },
    })
    expect(put).toMatchObject({ key, size: total, contentType: 'video/webm' })

    const head = await storage().head(key)
    expect(head).toMatchObject({
      size: total,
      contentType: 'video/webm',
      metadata: { tenantId: 't-1', fileId: 'f-1' },
    })
    const got = await storage().get(key)
    const actual = createHash('sha256').update(
      new Uint8Array(await new Response(got?.body).arrayBuffer())
    )
    expect(actual.digest('hex')).toBe(expected.digest('hex'))

    // Across the first part boundary: parts reassembled in order, not merely all present.
    const seam = await storage().get(key, { range: { start: 5 * MiB - 4, end: 5 * MiB + 3 } })
    const all = Buffer.concat(pieces)
    expect(new Uint8Array(await new Response(seam?.body).arrayBuffer())).toEqual(
      new Uint8Array(all.subarray(5 * MiB - 4, 5 * MiB + 4))
    )
  })

  it('streams a body smaller than one part, and leaves nothing when the stream fails', async ({
    skip,
  }) => {
    if (!s3Reachable) skip()
    const small = `${prefix}streams/${randomUUID()}`
    const put = await storage().putStream(small, new Blob(['a short upload']).stream(), {
      contentType: 'text/plain',
    })
    expect(put.size).toBe(14)
    expect(await new Response((await storage().get(small))?.body).text()).toBe('a short upload')

    const broken = `${prefix}streams/${randomUUID()}`
    let sent = 0
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 6) controller.enqueue(new Uint8Array(1024 * 1024))
        else controller.error(new Error('the browser went away'))
      },
    })
    await expect(
      storage().putStream(broken, failing, { contentType: 'video/webm' })
    ).rejects.toThrow()
    expect(await storage().head(broken)).toBeNull()
  })

  it('normalises an ETag to the quoted form R2 answers', () => {
    expect(quoteEtag('abc')).toBe('"abc"')
    expect(quoteEtag('"abc"')).toBe('"abc"')
    expect(quoteEtag('W/"abc"')).toBe('"abc"')
  })
})

// ---- Rate limiter and locks ---------------------------------------------------------------------

describe('rate limiter over rate_limits', () => {
  const limiter = createPostgresRateLimiter(config)

  it('admits exactly max of N concurrent requests from one key', async () => {
    const key = `rl:test:${randomUUID()}`
    const decisions = await Promise.all(
      Array.from({ length: 25 }, () => limiter.check(key, { max: 10, windowSeconds: 60 }))
    )
    expect(decisions.filter(d => d.allowed)).toHaveLength(10)
    const refused = decisions.filter(d => !d.allowed)
    expect(refused).toHaveLength(15)
    for (const d of refused) {
      expect(d.remaining).toBe(0)
      expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(1)
      expect(d.retryAfterSeconds).toBeLessThanOrEqual(60)
    }
    // The admitted ones counted down to zero, as the KV limiter's `remaining` does.
    expect(
      decisions
        .filter(d => d.allowed)
        .map(d => d.remaining)
        .sort((a, b) => a - b)
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('slides: a refused request records nothing, and the window reopens', async () => {
    const key = `rl:test:${randomUUID()}`
    expect((await limiter.check(key, { max: 1, windowSeconds: 1 })).allowed).toBe(true)
    const refused = await limiter.check(key, { max: 1, windowSeconds: 1 })
    expect(refused).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 1 })
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect((await limiter.check(key, { max: 1, windowSeconds: 1 })).allowed).toBe(true)
  })

  it('keeps one row per key whose expiry follows the newest hit', async () => {
    const key = `rl:test:${randomUUID()}`
    await limiter.check(key, { max: 5, windowSeconds: 60 })
    await limiter.check(key, { max: 5, windowSeconds: 60 })
    const [row] = await db.select().from(rateLimits).where(eq(rateLimits.key, key))
    expect(row?.hits).toHaveLength(2)
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 55_000)
  })
})

describe('operation locks over operation_locks', () => {
  const locks = createPostgresLocks(config)

  it('lets exactly one of two concurrent acquirers in, until release', async () => {
    const key = `tenant:delete:${randomUUID()}`
    const won = await Promise.all([locks.acquire(key, 600), locks.acquire(key, 600)])
    expect(won.filter(Boolean)).toHaveLength(1)
    expect(await locks.acquire(key, 600)).toBe(false)
    await locks.release(key)
    expect(await locks.acquire(key, 600)).toBe(true)
    await locks.release(key)
  })

  it('reclaims a lock whose TTL passed (a crashed holder)', async () => {
    const key = `tenant:delete:${randomUUID()}`
    expect(await locks.acquire(key, 1)).toBe(true)
    expect(await locks.acquire(key, 1)).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(await locks.acquire(key, 600)).toBe(true)
    await locks.release(key)
  })

  it('operationLock answers 409 operation_in_progress to the second caller', async () => {
    const key = `tenant:delete:${randomUUID()}`
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const first = operationLock(locks, key, () => held)
    // Let the first caller take the lock before the second asks.
    for (let i = 0; i < 50; i++) {
      const [row] = await db.select().from(operationLocks).where(eq(operationLocks.key, key))
      if (row) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await expect(operationLock(locks, key, async () => 'second')).rejects.toMatchObject({
      statusCode: 409,
      code: 'operation_in_progress',
    })
    release()
    await first
    // Released in `finally`: the next caller runs.
    await expect(operationLock(locks, key, async () => 'third')).resolves.toBe('third')
  })

  it('the nightly prune drops expired windows and abandoned locks only', async () => {
    const stale = `rl:test:${randomUUID()}`
    const live = `rl:test:${randomUUID()}`
    const staleLock = `lock:${randomUUID()}`
    await db.insert(rateLimits).values([
      { key: stale, hits: [1], expiresAt: new Date(Date.now() - 60_000) },
      { key: live, hits: [Date.now()], expiresAt: new Date(Date.now() + 60_000) },
    ])
    await db
      .insert(operationLocks)
      .values({ key: staleLock, expiresAt: new Date(Date.now() - 60_000) })
    const counts = await runPruneExpired(db)
    expect(counts).toEqual(
      expect.objectContaining({
        rateLimitKeys: expect.any(Number),
        operationLockKeys: expect.any(Number),
      })
    )
    const left = await db
      .select({ key: rateLimits.key })
      .from(rateLimits)
      .where(sql`${rateLimits.key} IN (${stale}, ${live})`)
    expect(left.map(r => r.key)).toEqual([live])
    expect(
      await db.select().from(operationLocks).where(eq(operationLocks.key, staleLock))
    ).toHaveLength(0)
  })
})

// ---- Document converter -------------------------------------------------------------------------

/** A one-page PDF whose content stream shows `text` (Helvetica, standard encoding). */
function pdfWith(text: string): Uint8Array<ArrayBuffer> {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

/** A zip of stored (uncompressed) entries — enough for a .docx. */
function zip(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8')
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    chunks.push(local, nameBytes, data)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Uint8Array.from(Buffer.concat([...chunks, ...central, end]))
}

function docxWith(heading: string, paragraph: string): Uint8Array<ArrayBuffer> {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  return zip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${w}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${heading}</w:t></w:r></w:p><w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p></w:body></w:document>`,
  })
}

const PDF = 'application/pdf'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

describe('document converter (Node)', () => {
  const converter = createNodeConverter()
  const convert = converter.convert

  it('extracts a PDF’s text', async () => {
    const out = await convert({
      name: 'report.pdf',
      blob: new Blob([pdfWith('Quarterly revenue grew')], { type: PDF }),
    })
    expect(out).toMatchObject({ name: 'report.pdf', mimeType: PDF, format: 'text' })
    expect(out.format !== 'error' && out.data).toContain('Quarterly revenue grew')
    expect(out.format !== 'error' && out.tokens).toBeGreaterThan(0)
  })

  it('turns a .docx into markdown, keeping its heading', async () => {
    const out = await convert({
      name: 'notes.docx',
      blob: new Blob([docxWith('Launch plan', 'Ship on Tuesday')], { type: DOCX }),
    })
    expect(out).toMatchObject({ mimeType: DOCX, format: 'markdown' })
    const data = out.format === 'markdown' ? out.data : ''
    expect(data).toMatch(/^# Launch plan/)
    expect(data).toContain('Ship on Tuesday')
  })

  it('reads HTML as text and falls back to the extension for the type', async () => {
    const out = await convert({
      name: 'page.html',
      blob: new Blob([
        '<html><head><style>p{}</style></head><body><h1>Title</h1><p>A &amp; B</p></body></html>',
      ]),
    })
    expect(out).toMatchObject({ mimeType: 'text/html', format: 'text', data: 'Title\n\nA & B' })
    expect(htmlToText('<p>one</p><script>x()</script><p>two&#33;</p>')).toBe('one\n\ntwo!')
  })

  it('answers a permanent error for a type it cannot read, and for a corrupt file', async () => {
    const xlsx = await convert({
      name: 'sheet.xlsx',
      blob: new Blob([new Uint8Array([1, 2, 3])], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    })
    expect(xlsx).toMatchObject({ format: 'error' })
    expect(xlsx.format === 'error' && xlsx.error).toMatch(/cannot be converted on this server/)

    const corrupt = await convert({
      name: 'broken.pdf',
      blob: new Blob([deflateSync(new TextEncoder().encode('not a pdf'))], { type: PDF }),
    })
    expect(corrupt).toMatchObject({ format: 'error' })
  })
})

// ---- Platform AI tiers --------------------------------------------------------------------------

/** A fetch that records requests and answers an OpenAI-shaped embeddings body. */
function recordingFetch() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const impl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(
      JSON.stringify({ data: [{ index: 0, embedding: new Array(1024).fill(0.1) }] }),
      { headers: { 'content-type': 'application/json' } }
    )
  }
  return { calls, impl }
}

describe('platform AI keys', () => {
  const noAi = { ai: null, converter: null }
  const base = {
    ...env,
    ANTHROPIC_API_KEY: '',
    AI_API_KEY: '',
    AI_BASE_URL: '',
    AI_MODEL: '',
    EMBEDDINGS_API_KEY: '',
    EMBEDDINGS_BASE_URL: '',
    EMBEDDINGS_MODEL: '',
  }

  it('chat: Anthropic first, then the OpenAI-compatible key, then nothing', () => {
    expect(platformChat(loadConfig(base), noAi)).toBeNull()
    expect(
      platformChat(
        loadConfig({
          ...base,
          AI_API_KEY: 'k',
          AI_BASE_URL: 'https://openrouter.example/api/v1',
          AI_MODEL: 'meta/llama-4',
        }),
        noAi
      )
    ).toMatchObject({ provider: 'openai_compatible', model: 'meta/llama-4' })
    // A base URL with no model is not a usable tier: there is no default for an arbitrary endpoint.
    expect(
      platformChat(loadConfig({ ...base, AI_API_KEY: 'k', AI_BASE_URL: 'https://x.example' }), noAi)
    ).toBeNull()
    expect(platformChat(loadConfig({ ...base, AI_API_KEY: 'k' }), noAi)).toMatchObject({
      provider: 'openai',
      model: DEFAULT_CHAT_MODELS.openai,
    })
    expect(
      platformChat(loadConfig({ ...base, AI_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }), noAi)
    ).toMatchObject({ provider: 'anthropic' })
  })

  it('embeddings: EMBEDDINGS_API_KEY at EMBEDDINGS_BASE_URL, asking for 1024 dimensions', async () => {
    const cfg = loadConfig({
      ...base,
      EMBEDDINGS_API_KEY: 'e',
      EMBEDDINGS_BASE_URL: 'https://embed.example/v1/',
      EMBEDDINGS_MODEL: 'bge-m3',
    })
    const { calls, impl } = recordingFetch()
    const resolved = await resolveEmbeddings(db, cfg, noAi, randomUUID(), { fetch: impl })
    expect(resolved).toMatchObject({
      provider: 'openai_compatible',
      model: 'bge-m3',
      source: 'platform',
    })
    const [vector] = await resolved.client.embed(['hello'])
    expect(vector).toHaveLength(1024)
    expect(calls).toEqual([
      {
        url: 'https://embed.example/v1/embeddings',
        body: { model: 'bge-m3', input: ['hello'], dimensions: 1024 },
      },
    ])

    const openai = await resolveEmbeddings(
      db,
      loadConfig({ ...base, EMBEDDINGS_API_KEY: 'e' }),
      noAi,
      randomUUID()
    )
    expect(openai).toMatchObject({ provider: 'openai', model: 'text-embedding-3-small' })
    await expect(resolveEmbeddings(db, loadConfig(base), noAi, randomUUID())).rejects.toMatchObject(
      { statusCode: 503 }
    )
  })

  it('readiness mirrors both orders', async () => {
    const cfg = loadConfig({
      ...base,
      AI_API_KEY: 'k',
      AI_BASE_URL: 'https://openrouter.example/api/v1',
      AI_MODEL: 'meta/llama-4',
      EMBEDDINGS_API_KEY: 'e',
      EMBEDDINGS_BASE_URL: 'https://embed.example/v1',
      EMBEDDINGS_MODEL: 'bge-m3',
    })
    const ready = await readiness(db, cfg, noAi, randomUUID())
    expect(ready.chat).toMatchObject({
      ready: true,
      source: 'platform',
      provider: 'openai_compatible',
      model: 'meta/llama-4',
    })
    expect(ready.embeddings).toMatchObject({
      ready: true,
      source: 'platform',
      provider: 'openai_compatible',
      model: 'bge-m3',
    })
    expect((await readiness(db, loadConfig(base), noAi, randomUUID())).chat.ready).toBe(false)
  })
})
