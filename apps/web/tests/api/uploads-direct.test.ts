/**
 * `STORAGE_DIRECT_UPLOADS=true` against the S3 gateway `pnpm test` starts (Versity, which checks a
 * presigned URL's signature and `If-None-Match` as S3 does): `POST /api/uploads` answers a
 * presigned PutObject, the bytes go to the GATEWAY — never through the app — and confirm `head`s
 * what arrived. The store itself refuses another type, another length, a missing
 * `If-None-Match: *` and a second write.
 *
 * Under `STORAGE_TENANT_FENCE=on` the URL is signed with the tenant's own STS session (a fake STS
 * on node:http, as in `storage-fence.test.ts`); the gateway has no STS and refuses any session
 * token, so that case reads the URL's token rather than sending the PUT (and the route's `head`,
 * refused, reads as "no object yet").
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { STSClient } from '@aws-sdk/client-sts'
import { ERROR_CODES } from '@rocketpod/shared/errors'
import { uploadResponseSchema } from '@rocketpod/shared/files'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '@/config'
import { pendingUploads } from '@/db/schema'
import {
  createS3Client,
  createS3Storage,
  createTenantStorage,
  storageConfigOf,
} from '@/node/storage'
import { tenantStorageOver } from '@/platform/tenant-storage'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase, testDatabaseUrl } from '../helpers/db'
import { json, request } from '../helpers/request'
import { confirmUploadRequest, createUploadRequest, ticketOf } from '../helpers/uploads'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const s3 = storageConfigOf(loadConfig({ ...process.env, DATABASE_URL: testDatabaseUrl() }))
const ROLE = 'arn:aws:iam::000000000000:role/files'

let s3Reachable = false
let sts: Server
let stsUrl = ''

beforeAll(async () => {
  sts = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
    })
    req.on('end', () => {
      const name = new URLSearchParams(body).get('RoleSessionName')
      const expiration = new Date(Date.now() + 3600_000).toISOString()
      res.writeHead(200, { 'content-type': 'text/xml' })
      res.end(
        `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>test</AccessKeyId><SecretAccessKey>test-secret-key</SecretAccessKey><SessionToken>session-${name}</SessionToken><Expiration>${expiration}</Expiration></Credentials><AssumedRoleUser><Arn>${ROLE}/x</Arn><AssumedRoleId>AROA:x</AssumedRoleId></AssumedRoleUser></AssumeRoleResult><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></AssumeRoleResponse>`
      )
    })
  })
  await new Promise<void>(resolve => sts.listen(0, '127.0.0.1', resolve))
  stsUrl = `http://127.0.0.1:${(sts.address() as AddressInfo).port}`
  if (s3?.endpoint) {
    try {
      await fetch(s3.endpoint, { signal: AbortSignal.timeout(2000) })
      s3Reachable = true
    } catch {
      console.warn(`S3 gateway not reachable at ${s3.endpoint}: skipping the direct-upload cases`)
    }
  }
})

afterAll(async () => {
  await new Promise(resolve => sts.close(resolve))
})

function config() {
  if (!s3) throw new Error('.env.test has no STORAGE_*: the gate configures the S3 gateway')
  return s3
}

async function actor() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  return { tenant, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)) }
}

const file = { bytes: 'hello world', name: 'notes.txt', type: 'text/plain' }

describe('STORAGE_DIRECT_UPLOADS=true over the S3 gateway', () => {
  it('presigns a write-once PUT of one type and length, which the store holds the client to', async ({
    skip,
  }) => {
    if (!s3Reachable) skip()
    const { tenant, cookie } = await actor()
    const base = createS3Storage(config())
    const env = createTestEnv({ STORAGE_DIRECT_UPLOADS: 'true', storage: tenantStorageOver(base) })
    const t = await ticketOf(await createUploadRequest(env, cookie, 'uploads', file))
    const url = new URL(t.url)
    expect(url.origin).toBe(new URL(config().endpoint ?? '').origin)
    expect(url.pathname).toMatch(
      new RegExp(`^/${config().bucket}/tenants/${tenant.id}/uploads/[0-9a-f-]{36}-notes\\.txt$`)
    )
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match'
    )
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
    expect(url.search).not.toContain(config().credentials?.secretAccessKey ?? 'never')
    expect(t.headers).toEqual({ 'Content-Type': 'text/plain', 'If-None-Match': '*' })
    const row = await db.query.pendingUploads.findFirst({
      where: eq(pendingUploads.id, t.uploadId),
    })
    expect(row?.tokenHash).toBeNull()

    const put = (body: string, headers: Record<string, string>) =>
      fetch(t.url, { method: 'PUT', body, headers }).then(r => r.status)
    expect(await put('hello world', { ...t.headers, 'Content-Type': 'text/html' })).toBe(403)
    expect(await put('hello', t.headers)).toBe(403)
    expect(await put('hello world', { 'Content-Type': 'text/plain' })).toBe(403)
    expect(await base.head(row?.key ?? '')).toBeNull()
    expect(await put('hello world', t.headers)).toBe(200)
    expect(await put('HELLO WORLD', t.headers)).toBe(412)

    const confirmed = await confirmUploadRequest(env, cookie, t.uploadId)
    expect(confirmed.status).toBe(201)
    const stored = uploadResponseSchema.parse(await json(confirmed))
    const download = await request(stored.url, { headers: cookie }, { env })
    expect(await download.text()).toBe('hello world')
    await base.delete(row?.key ?? '')
  })

  it('confirm refuses an object the gateway holds under another type, and deletes it', async ({
    skip,
  }) => {
    if (!s3Reachable) skip()
    const { cookie } = await actor()
    const base = createS3Storage(config())
    const env = createTestEnv({ STORAGE_DIRECT_UPLOADS: 'true', storage: tenantStorageOver(base) })
    const t = await ticketOf(await createUploadRequest(env, cookie, 'uploads', file))
    const row = await db.query.pendingUploads.findFirst({
      where: eq(pendingUploads.id, t.uploadId),
    })
    // What a store that did not hold the signature would have let through.
    await base.put(row?.key ?? '', 'hello world', { contentType: 'text/html' })
    const res = await confirmUploadRequest(env, cookie, t.uploadId)
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ code: ERROR_CODES.uploadMismatch })
    expect(await base.head(row?.key ?? '')).toBeNull()
  })

  it("under STORAGE_TENANT_FENCE=on the URL is signed with the tenant's own session", async () => {
    const { tenant, cookie } = await actor()
    const cfg = config()
    const storage = createTenantStorage(cfg, {
      fence: 'on',
      filesRoleArn: ROLE,
      sts: new STSClient({
        endpoint: stsUrl,
        region: 'us-east-1',
        credentials: { accessKeyId: 'task', secretAccessKey: 'task-secret' },
      }),
      clientFor: provider => {
        const client = createS3Client(cfg, provider)
        // The token stays in the signature but leaves the wire: the gateway refuses the head
        // (403, a fenced "not found") instead of failing on a token it cannot know.
        client.middlewareStack.add(
          next => async args => {
            const req = args.request as { headers?: Record<string, string> }
            if (req.headers) delete req.headers['x-amz-security-token']
            return next(args)
          },
          { step: 'deserialize', name: 'dropSessionToken' }
        )
        return client
      },
    })
    const env = createTestEnv({ STORAGE_DIRECT_UPLOADS: 'true', storage })
    const t = await ticketOf(await createUploadRequest(env, cookie, 'uploads', file))
    expect(new URL(t.url).searchParams.get('X-Amz-Security-Token')).toBe(
      `session-tenant-${tenant.id}`
    )
    expect(new URL(t.url).pathname).toContain(`/tenants/${tenant.id}/uploads/`)
  })
})
