/**
 * HTTP ranges without a store: `parseByteRange` (the `Range` header a download route reads, RFC
 * 9110 §14.1.2 — ONE range or none), and the S3 adapter's two refusals that keep a wrong body from
 * reaching a caller — a malformed range never sent (S3 would ignore it and answer the whole
 * object), and a store that ignored a well-formed one. The round trip against a real store is
 * `tests/api/node-platform-adapters.test.ts`; the route is `tests/api/files.test.ts`.
 */
import type { S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import { parseByteRange } from '@/api/utils/routes/byte-range'
import { createS3Storage, parseContentRange } from '@/node/storage'
import { StorageRangeNotSatisfiableError } from '@/platform/types'

describe('parseByteRange', () => {
  it('reads the three single-range forms', () => {
    expect(parseByteRange('bytes=0-9')).toEqual({ start: 0, end: 9 })
    expect(parseByteRange('bytes=100-')).toEqual({ start: 100 })
    expect(parseByteRange('bytes=-500')).toEqual({ suffix: 500 })
    // Case and whitespace are tolerated; a one-byte range is a range.
    expect(parseByteRange(' Bytes = 5 - 5 ')).toEqual({ start: 5, end: 5 })
  })

  it('ignores everything it cannot serve as ONE range (→ the whole object, 200)', () => {
    for (const header of [
      undefined,
      null,
      '',
      'bytes=',
      'bytes=-',
      'items=0-9',
      'bytes=0-1,5-6',
      'bytes=9-0',
      'bytes=a-b',
      'bytes=-1-2',
      'bytes=1234567890123456-',
    ]) {
      expect(parseByteRange(header), String(header)).toBeNull()
    }
  })

  it('leaves satisfiability to the store: a start past any end still parses', () => {
    // Only the store knows the length; the route maps its refusal to 416.
    expect(parseByteRange('bytes=999999-')).toEqual({ start: 999999 })
    expect(parseByteRange('bytes=-0')).toEqual({ suffix: 0 })
  })
})

describe('parseContentRange', () => {
  it('reads a satisfied range and nothing else', () => {
    expect(parseContentRange('bytes 0-99/1000')).toEqual({ start: 0, end: 99, total: 1000 })
    expect(parseContentRange('bytes */1000')).toBeNull()
    expect(parseContentRange(undefined)).toBeNull()
  })
})

/** A client whose every `send` answers `out` (or throws `err`) and records the command input. */
function fakeClient(answer: () => unknown) {
  const sent: Record<string, unknown>[] = []
  const client = {
    send: async (command: { input: Record<string, unknown> }) => {
      sent.push(command.input)
      return answer()
    },
  } as unknown as S3Client
  return { client, sent }
}

const cfg = {
  region: 'us-east-1',
  bucket: 'b',
  accessKeyId: 'k',
  secretAccessKey: 's',
  forcePathStyle: true,
}

const body = (text: string) => {
  let cancelled = false
  return {
    transformToWebStream: () =>
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(text))
          c.close()
        },
        cancel() {
          cancelled = true
        },
      }),
    get cancelled() {
      return cancelled
    },
  }
}

describe('the S3 adapter’s ranged get', () => {
  it('sends the Range header and reports the slice of the whole object', async () => {
    const { client, sent } = fakeClient(() => ({
      Body: body('cdef'),
      ContentLength: 4,
      ContentRange: 'bytes 2-5/10',
      ETag: 'abc',
    }))
    const got = await createS3Storage(cfg, client).get('k', { range: { start: 2, end: 5 } })
    expect(sent[0]?.Range).toBe('bytes=2-5')
    expect(got?.range).toEqual({ start: 2, end: 5, total: 10 })
    // `size` is the object's, not the slice's Content-Length.
    expect(got?.size).toBe(10)
  })

  it('refuses a body from a store that ignored the Range, rather than hand back byte 0', async () => {
    const whole = body('0123456789')
    const { client } = fakeClient(() => ({ Body: whole, ContentLength: 10 }))
    await expect(createS3Storage(cfg, client).get('k', { range: { suffix: 3 } })).rejects.toThrow(
      /ignored Range/
    )
    // The unread whole-object body is released, not left holding the connection.
    expect(whole.cancelled).toBe(true)
  })

  it('never sends a malformed range (S3 would answer the whole object)', async () => {
    const { client, sent } = fakeClient(() => ({ Body: body('x') }))
    const storage = createS3Storage(cfg, client)
    await expect(storage.get('k', { range: { start: 5, end: 1 } })).rejects.toThrow(RangeError)
    await expect(storage.get('k', { range: { start: 1.5 } })).rejects.toThrow(RangeError)
    await expect(storage.get('k', { range: { suffix: -1 } })).rejects.toThrow(RangeError)
    expect(sent).toHaveLength(0)
  })

  it('maps S3’s 416 to StorageRangeNotSatisfiableError with the size it reported', async () => {
    const { client } = fakeClient(() => {
      throw Object.assign(new Error('InvalidRange'), {
        name: 'InvalidRange',
        $metadata: { httpStatusCode: 416 },
        $response: { headers: { 'content-range': 'bytes */10' } },
      })
    })
    const err = await createS3Storage(cfg, client)
      .get('k', { range: { start: 10 } })
      .catch(e => e)
    expect(err).toBeInstanceOf(StorageRangeNotSatisfiableError)
    expect(err.total).toBe(10)
  })
})
