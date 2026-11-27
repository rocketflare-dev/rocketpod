/**
 * The storage tenant fence (`createTenantStorage`, docs/TENANT-ISOLATION.md): each tenant's
 * session is an STS AssumeRole of `FILES_ROLE_ARN` tagged with that tenant, cached, and used for
 * every call under `on`; `shadow` serves a refusal with the process's credentials and logs it.
 *
 * STS is a fake endpoint on node:http (it records each AssumeRole and answers the credentials a
 * case chose); S3 is the gateway `pnpm test` starts. The gateway knows one key pair, so a session
 * answered with that pair is "the files role admits this", and one with a wrong secret is "the
 * files role refuses it" — every call it signs is a 403, which is what IAM answers.
 */

import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { STSClient } from '@aws-sdk/client-sts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '@/config'
import {
  createS3Client,
  createS3Storage,
  createTenantStorage,
  type S3StorageConfig,
  storageConfigOf,
  TENANT_CREDENTIALS_MARGIN_MS,
  type TenantCredentials,
  tenantCredentialCache,
} from '@/node/storage'
import { StorageTenantMismatchError, StorageTenantRequiredError } from '@/platform/types'
import { testDatabaseUrl } from '../helpers/db'

const ROLE = 'arn:aws:iam::000000000000:role/files'
const s3 = storageConfigOf(loadConfig({ ...process.env, DATABASE_URL: testDatabaseUrl() }))

/** What the fake STS answers: the gateway's own pair (admitted), or a pair it does not know. */
let issue: 'admitted' | 'refused' | 'fail' = 'admitted'
const assumed: URLSearchParams[] = []
/** Every session token a tenant client was handed. */
const tokens: string[] = []
let sts: Server
let stsUrl = ''
let s3Reachable = false

beforeAll(async () => {
  sts = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
    })
    req.on('end', () => {
      const params = new URLSearchParams(body)
      assumed.push(params)
      if (issue === 'fail') {
        res.writeHead(403, { 'content-type': 'text/xml' })
        res.end(
          '<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>no</Message></Error><RequestId>r</RequestId></ErrorResponse>'
        )
        return
      }
      const [id, secret] =
        issue === 'admitted' ? ['test', 'test-secret-key'] : ['test', 'not-the-secret']
      const expiration = new Date(Date.now() + 3600_000).toISOString()
      res.writeHead(200, { 'content-type': 'text/xml' })
      res.end(
        `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>${id}</AccessKeyId><SecretAccessKey>${secret}</SecretAccessKey><SessionToken>session-${params.get('RoleSessionName')}</SessionToken><Expiration>${expiration}</Expiration></Credentials><AssumedRoleUser><Arn>${ROLE}/x</Arn><AssumedRoleId>AROA:x</AssumedRoleId></AssumedRoleUser></AssumeRoleResult><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></AssumeRoleResponse>`
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
      console.warn(`S3 gateway not reachable at ${s3.endpoint}: skipping the fence's S3 cases`)
    }
  }
})

afterAll(async () => {
  await new Promise(resolve => sts.close(resolve))
})

type Logged = { level: string; event: string; fields: Record<string, unknown> }

function fence(mode: 'on' | 'shadow', cfg: S3StorageConfig) {
  const logged: Logged[] = []
  const storage = createTenantStorage(cfg, {
    fence: mode,
    filesRoleArn: ROLE,
    sts: new STSClient({
      endpoint: stsUrl,
      region: 'us-east-1',
      credentials: { accessKeyId: 'task', secretAccessKey: 'task-secret' },
    }),
    // The gateway refuses any session token (it has no STS), so the token the fake STS issued is
    // checked here and left off the wire; the key pair the session resolved to still signs.
    clientFor: provider =>
      createS3Client(cfg, async () => {
        const { accessKeyId, secretAccessKey, sessionToken } = await provider()
        tokens.push(sessionToken)
        return { accessKeyId, secretAccessKey }
      }),
    log: (level, event, fields) => logged.push({ level, event, fields }),
  })
  return { storage, logged }
}

function config(): S3StorageConfig {
  if (!s3) throw new Error('.env.test has no STORAGE_*: the gate configures the S3 gateway')
  return s3
}

describe('the tenant session (STS)', () => {
  it('assumes FILES_ROLE_ARN tagged with the tenant, once per tenant, and writes over it', async ({
    skip,
  }) => {
    if (!s3Reachable) skip()
    issue = 'admitted'
    const { storage } = fence('on', config())
    const tenant = randomUUID()
    const other = randomUUID()
    const before = assumed.length
    const tokensBefore = tokens.length
    const key = `tenants/${tenant}/fence/${randomUUID()}.txt`
    // Concurrent first calls share ONE AssumeRole.
    await Promise.all([
      storage.forTenant(tenant).put(key, 'fenced', { contentType: 'text/plain' }),
      storage.forTenant(tenant).head(`tenants/${tenant}/fence/missing.txt`),
    ])
    expect(await new Response((await storage.forTenant(tenant).get(key))?.body).text()).toBe(
      'fenced'
    )
    await storage.forTenant(other).head(`tenants/${other}/fence/missing.txt`)

    const calls = assumed.slice(before)
    expect(calls.map(p => p.get('Tags.member.1.Value'))).toEqual([tenant, other])
    const [first] = calls
    expect(first?.get('Action')).toBe('AssumeRole')
    expect(first?.get('RoleArn')).toBe(ROLE)
    expect(first?.get('RoleSessionName')).toBe(`tenant-${tenant}`)
    expect(first?.get('Tags.member.1.Key')).toBe('tenant')
    expect(first?.has('Tags.member.2.Key')).toBe(false)
    expect(first?.get('DurationSeconds')).toBe('3600')
    // Each tenant's client signed with ITS session, never another tenant's or the base pair.
    expect(new Set(tokens.slice(tokensBefore))).toEqual(
      new Set([`session-tenant-${tenant}`, `session-tenant-${other}`])
    )
    await createS3Storage(config()).delete(key)
  })

  it('refuses a missing tenant and a key outside the tenant before any STS call', async () => {
    const { storage } = fence('on', config())
    const before = assumed.length
    expect(() => storage.forTenant(undefined as unknown as string)).toThrow(
      StorageTenantRequiredError
    )
    expect(() => storage.forTenant('*')).toThrow(StorageTenantRequiredError)
    const tenant = randomUUID()
    await expect(
      storage.forTenant(tenant).get(`tenants/${randomUUID()}/fence/a.txt`)
    ).rejects.toThrow(StorageTenantMismatchError)
    await expect(storage.forTenant(tenant).list('tenants/')).rejects.toThrow(
      StorageTenantMismatchError
    )
    await expect(
      storage.forTenant(tenant).deleteMany([`tenants/${tenant}/a`, `platform/b`])
    ).rejects.toThrow(StorageTenantMismatchError)
    expect(assumed.length).toBe(before)
  })

  it('needs FILES_ROLE_ARN', () => {
    expect(() => createTenantStorage(config(), { fence: 'on' })).toThrow(/FILES_ROLE_ARN/)
  })
})

describe('STORAGE_TENANT_FENCE=on', () => {
  it('never falls back: a refused write fails, a refused read is not-found', async ({ skip }) => {
    if (!s3Reachable) skip()
    const tenant = randomUUID()
    const key = `tenants/${tenant}/fence/${randomUUID()}.txt`
    await createS3Storage(config()).put(key, 'there', { contentType: 'text/plain' })
    issue = 'refused'
    const { storage, logged } = fence('on', config())
    await expect(
      storage.forTenant(tenant).put(key, 'x', { contentType: 'text/plain' })
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } })
    // The object exists, but the session may not read it: the answer is "not found", never the bytes.
    expect(await storage.forTenant(tenant).head(key)).toBeNull()
    expect(logged.some(l => l.event === 'storage.fence_denied')).toBe(false)
    issue = 'fail'
    const failing = fence('on', config()).storage
    await expect(
      failing.forTenant(randomUUID()).head(key.replace(tenant, randomUUID()))
    ).rejects.toThrow()
    issue = 'admitted'
    await createS3Storage(config()).delete(key)
  })
})

describe('STORAGE_TENANT_FENCE=shadow', () => {
  it('serves a refusal with the base credentials and logs storage.fence_denied', async ({
    skip,
  }) => {
    if (!s3Reachable) skip()
    issue = 'refused'
    const { storage, logged } = fence('shadow', config())
    const tenant = randomUUID()
    const key = `tenants/${tenant}/fence/${randomUUID()}.txt`
    const scoped = storage.forTenant(tenant)

    await scoped.put(key, 'served', { contentType: 'text/plain' })
    expect(await new Response((await scoped.get(key))?.body).text()).toBe('served')
    expect(
      logged.filter(l => l.event === 'storage.fence_denied').map(l => [l.fields.op, l.fields.key])
    ).toEqual([
      ['put', key],
      ['get', key],
    ])
    expect(logged.every(l => l.fields.tenantId === tenant)).toBe(true)

    // A key that is missing for both is just missing: nothing to report.
    logged.length = 0
    expect(await scoped.head(`tenants/${tenant}/fence/none.txt`)).toBeNull()
    expect(logged).toEqual([])

    // A stream is sent once, over the base credentials; the session's probe reports the denial.
    const streamKey = `tenants/${tenant}/fence/${randomUUID()}.txt`
    await scoped.putStream(streamKey, new Blob(['streamed']).stream(), {
      contentType: 'text/plain',
    })
    expect(logged).toEqual([
      {
        level: 'warn',
        event: 'storage.fence_denied',
        fields: { tenantId: tenant, op: 'putStream', key: streamKey, probe: 'head' },
      },
    ])
    issue = 'admitted'
    await createS3Storage(config()).deleteMany([key, streamKey])
  })

  it('serves with the base credentials when the session cannot be had, and says so', async ({
    skip,
  }) => {
    if (!s3Reachable) skip()
    issue = 'fail'
    const { storage, logged } = fence('shadow', config())
    const tenant = randomUUID()
    const key = `tenants/${tenant}/fence/${randomUUID()}.txt`
    await storage.forTenant(tenant).put(key, 'still served', { contentType: 'text/plain' })
    expect(logged.map(l => l.event)).toEqual(['storage.fence_session_failed'])
    issue = 'admitted'
    await createS3Storage(config()).delete(key)
  })
})

describe('tenantCredentialCache', () => {
  const credentials = (expiresAt: number): TenantCredentials => ({
    accessKeyId: 'a',
    secretAccessKey: 's',
    sessionToken: 't',
    expiration: new Date(expiresAt),
  })

  it('keeps a tenant’s credentials until the margin before they expire, then assumes again', async () => {
    let clock = 1_000_000
    const calls: string[] = []
    const cache = tenantCredentialCache(
      async id => {
        calls.push(id)
        return credentials(clock + 3600_000)
      },
      () => clock
    )

    await cache.get('a')
    clock += 3600_000 - TENANT_CREDENTIALS_MARGIN_MS - 1
    await cache.get('a')
    expect(calls).toEqual(['a'])
    clock += 2
    await cache.get('a')
    expect(calls).toEqual(['a', 'a'])
    await cache.get('b')
    cache.forget('b')
    await cache.get('b')
    expect(calls).toEqual(['a', 'a', 'b', 'b'])
  })

  it('shares one AssumeRole among concurrent asks, and does not keep a failure', async () => {
    let attempts = 0
    const cache = tenantCredentialCache(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('sts down')
      return credentials(Date.now() + 3600_000)
    })
    await expect(Promise.all([cache.get('a'), cache.get('a')])).rejects.toThrow('sts down')
    expect(attempts).toBe(1)
    const [x, y] = await Promise.all([cache.get('a'), cache.get('a')])
    expect(x).toBe(y)
    expect(attempts).toBe(2)
  })
})
