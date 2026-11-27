/**
 * `StorageService` over any S3-compatible object store:
 * AWS S3, MinIO, Ceph/RGW, GCS in interoperability mode, any other S3 endpoint. They differ
 * only by endpoint and path style, so ONE adapter covers them; `STORAGE_DRIVER=s3` and the
 * `STORAGE_*` vars configure it (`storageConfigOf`; the keys are optional — without them the
 * SDK's default credential chain, e.g. an ECS task role), and no bucket leaves the platform's
 * `storage` null — the 503 `storage_not_configured` every caller already answers.
 *
 * What the app can see is fixed, whatever the store:
 * - keys are used verbatim (the tenant prefix is the caller's — `buildStorageKey` — and the
 *   platform hands storage out per tenant, refusing a key outside it: `createPlatformStorage`);
 * - the ETag is always quoted and HTTP-ready;
 * - a listing carries no content type or custom metadata (`ListObjectsV2` returns neither), so
 *   `contentType` is the default and `metadata` is `{}` on a listed object;
 * - downloads stream through the server (no presigned URLs);
 * - a ranged `get` is a `Range` header on `GetObject`, its `Content-Range` parsed back into
 *   `range`, and S3's 416 (`InvalidRange`) is `StorageRangeNotSatisfiableError`; a store that
 *   ignored the `Range` (answered 200 from byte 0) is an error, never a silently wrong body;
 * - `putStream` is `@aws-sdk/lib-storage`'s `Upload`: a multipart upload of a body whose length is
 *   unknown, `PART_SIZE` at a time (one plain PutObject when the whole body fits in one part).
 *
 * S3 lower-cases user-metadata keys (they are HTTP headers); the app's keys are camel-case. The
 * original keys ride in one extra header, `x-amz-meta-rp-keys`, so a `get`/`head` hands back
 * `tenantId`, not `tenantid`. Values travel as headers: printable ASCII only, which every value the app writes
 * (ids, scopes) is.
 */
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts'
import { Upload } from '@aws-sdk/lib-storage'
import type { AppConfig } from '../config'
import { fenceToTenant, requireTenantId, tenantStorageOver } from '../platform/tenant-storage'
import {
  type StorageBody,
  type StorageRange,
  StorageRangeNotSatisfiableError,
  type StorageService,
  type StoredObject,
  type StoredObjectMeta,
  type StoredRange,
  type TenantStorageFactory,
} from '../platform/types'

const DEFAULT_CONTENT_TYPE = 'application/octet-stream'
/** The header that carries the original (case-preserved) metadata keys. */
const KEYS_HEADER = 'rp-keys'
/** S3's `DeleteObjects` stops at 1 000 keys per call. */
const DELETE_BATCH = 1000
/** A multipart part: S3's 5 MiB minimum for every part but the last. */
const PART_SIZE = 5 * 1024 * 1024
/** Parts in flight at once — bounds a `putStream`'s memory to about PART_SIZE × this. */
const UPLOAD_QUEUE = 2

export interface S3StorageConfig {
  /**
   * `https://s3.eu-west-1.amazonaws.com`, `http://localhost:9000` (MinIO). Unset = AWS's default
   * endpoint for the region.
   */
  endpoint?: string
  region: string
  bucket: string
  /**
   * Static keys (`STORAGE_ACCESS_KEY_ID` + `STORAGE_SECRET_ACCESS_KEY`). Absent = the AWS SDK's
   * default credential chain: `AWS_*` env, a profile, an ECS task role, an instance profile.
   */
  credentials?: { accessKeyId: string; secretAccessKey: string }
  /** `true` for MinIO and most self-hosted stores (`http://host/bucket/key`). */
  forcePathStyle: boolean
}

/**
 * The S3 settings the config names, or null when storage is not configured: `STORAGE_DRIVER=s3`
 * and a `STORAGE_BUCKET`. The keys are optional — both or neither, which `loadConfig` enforces;
 * neither means the SDK's default credential chain (an ECS task role on AWS).
 */
export function storageConfigOf(config: AppConfig): S3StorageConfig | null {
  if (config.STORAGE_DRIVER !== 's3') return null
  const { STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY } = config
  if (!STORAGE_BUCKET) return null
  return {
    endpoint: config.STORAGE_ENDPOINT,
    region: config.STORAGE_REGION,
    bucket: STORAGE_BUCKET,
    credentials:
      STORAGE_ACCESS_KEY_ID && STORAGE_SECRET_ACCESS_KEY
        ? { accessKeyId: STORAGE_ACCESS_KEY_ID, secretAccessKey: STORAGE_SECRET_ACCESS_KEY }
        : undefined,
    forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
  }
}

/**
 * A client for the store. Exported so tests and scripts address the same bucket the same way.
 * `provider` (a tenant's STS session, `createTenantStorage`) replaces the config's credentials.
 */
export function createS3Client(
  cfg: S3StorageConfig,
  provider?: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>
): S3Client {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    // Undefined = the SDK resolves credentials itself (env, profile, ECS task role, IMDS).
    credentials: provider ?? cfg.credentials,
    // The SDK's default (a CRC checksum on every request that supports one) is refused by several
    // S3-compatible stores; send one only where the API demands it.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

/** The hex digest in double quotes (weak prefix dropped), whatever the store returned. */
export function quoteEtag(etag: string | undefined): string {
  const bare = (etag ?? '').replace(/^W\//, '').replace(/^"+|"+$/g, '')
  return `"${bare}"`
}

/** The bytes and length of a `put` body: S3 needs the length up front. */
async function toBytes(body: StorageBody): Promise<Uint8Array> {
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  return new Uint8Array(await body.arrayBuffer())
}

/** S3 user metadata as written: lower-cased keys plus the header that remembers the originals. */
function toS3Metadata(metadata: Record<string, string> | undefined): Record<string, string> {
  const entries = Object.entries(metadata ?? {})
  if (entries.length === 0) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of entries) out[key.toLowerCase()] = value
  out[KEYS_HEADER] = entries.map(([key]) => key).join(',')
  return out
}

/** The metadata a `get`/`head` answers, with the original keys restored. */
function fromS3Metadata(raw: Record<string, string> | undefined): Record<string, string> {
  if (!raw) return {}
  const originals = (raw[KEYS_HEADER] ?? '').split(',').filter(Boolean)
  const byLower = new Map(originals.map(key => [key.toLowerCase(), key]))
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === KEYS_HEADER) continue
    out[byLower.get(key) ?? key] = value
  }
  return out
}

/** The `Range` header for a `StorageRange`; a malformed one is a caller bug, not a 416. */
export function rangeHeader(range: StorageRange): string {
  const whole = (n: number) => Number.isSafeInteger(n) && n >= 0
  if ('suffix' in range) {
    if (!whole(range.suffix)) throw new RangeError(`storage: bad suffix range ${range.suffix}`)
    return `bytes=-${range.suffix}`
  }
  const { start, end } = range
  if (!whole(start) || (end !== undefined && (!whole(end) || end < start))) {
    throw new RangeError(`storage: bad range ${start}-${end ?? ''}`)
  }
  return `bytes=${start}-${end ?? ''}`
}

/** `bytes 0-99/1000` → `{ start: 0, end: 99, total: 1000 }`; null for anything else. */
export function parseContentRange(header: string | undefined): StoredRange | null {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header?.trim() ?? '')
  if (!m) return null
  return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) }
}

/** S3's 416 for a range that starts past the object. */
function isRangeNotSatisfiable(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === 'InvalidRange' || e?.$metadata?.httpStatusCode === 416
}

/** The object size a 416 reports (`Content-Range: bytes *\/n`), when the store sent one. */
function parseUnsatisfiedTotal(err: unknown): number | undefined {
  const headers = (err as { $response?: { headers?: Record<string, string> } })?.$response?.headers
  const m = /\/(\d+)$/.exec(headers?.['content-range'] ?? '')
  return m ? Number(m[1]) : undefined
}

/** `NoSuchKey` (GET) and the bare 404 a HEAD answers both mean "no such object". */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404
}

export function createS3Storage(
  cfg: S3StorageConfig,
  client = createS3Client(cfg),
  /** Keys per `DeleteObjects` call — S3's ceiling; smaller only so a test can see the chunking. */
  deleteBatch = DELETE_BATCH
): StorageService {
  const Bucket = cfg.bucket

  async function head(key: string): Promise<StoredObjectMeta | null> {
    try {
      const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }))
      return {
        key,
        size: out.ContentLength ?? 0,
        contentType: out.ContentType ?? DEFAULT_CONTENT_TYPE,
        etag: quoteEtag(out.ETag),
        uploaded: out.LastModified ?? new Date(0),
        metadata: fromS3Metadata(out.Metadata),
      }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async function listPage(prefix: string, options?: { cursor?: string; limit?: number }) {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket,
        Prefix: prefix,
        ContinuationToken: options?.cursor,
        MaxKeys: options?.limit,
      })
    )
    const objects: StoredObjectMeta[] = (out.Contents ?? []).map(obj => ({
      key: obj.Key ?? '',
      size: obj.Size ?? 0,
      contentType: DEFAULT_CONTENT_TYPE,
      etag: quoteEtag(obj.ETag),
      uploaded: obj.LastModified ?? new Date(0),
      metadata: {},
    }))
    return {
      objects,
      cursor: out.IsTruncated ? (out.NextContinuationToken ?? undefined) : undefined,
    }
  }

  return {
    async put(key, body, options) {
      const bytes = await toBytes(body)
      const out = await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ContentType: options.contentType,
          Metadata: toS3Metadata(options.metadata),
        })
      )
      return {
        key,
        size: bytes.byteLength,
        contentType: options.contentType,
        etag: quoteEtag(out.ETag),
        // PutObject does not answer the stored time; the request's is within a round trip of it.
        uploaded: new Date(),
        metadata: { ...(options.metadata ?? {}) },
      }
    },
    async putStream(key, body, options) {
      // Count what the stream hands over: the multipart answer carries no length.
      let size = 0
      const counted = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            size += chunk.byteLength
            controller.enqueue(chunk)
          },
        })
      )
      const out = await new Upload({
        client,
        params: {
          Bucket,
          Key: key,
          Body: counted,
          ContentType: options.contentType,
          Metadata: toS3Metadata(options.metadata),
        },
        partSize: PART_SIZE,
        queueSize: UPLOAD_QUEUE,
        // The default, stated: a failed upload aborts, so no parts are left billed and invisible.
        leavePartsOnError: false,
      }).done()
      return {
        key,
        size,
        contentType: options.contentType,
        etag: quoteEtag(out.ETag),
        uploaded: new Date(),
        metadata: { ...(options.metadata ?? {}) },
      }
    },
    async get(key, options): Promise<StoredObject | null> {
      const Range = options?.range ? rangeHeader(options.range) : undefined
      let out: GetObjectCommandOutput
      try {
        out = await client.send(new GetObjectCommand({ Bucket, Key: key, Range }))
      } catch (err) {
        if (isNotFound(err)) return null
        if (Range && isRangeNotSatisfiable(err)) {
          throw new StorageRangeNotSatisfiableError(key, parseUnsatisfiedTotal(err))
        }
        throw err
      }
      if (!out.Body) return null
      const body = out.Body.transformToWebStream() as ReadableStream<Uint8Array>
      const range = Range ? parseContentRange(out.ContentRange) : null
      if (Range && !range) {
        // A store that ignored the Range answered from byte 0: handing that body to a caller
        // that asked for other bytes would be silent corruption.
        await body.cancel().catch(() => {})
        throw new Error(`storage.get: the store ignored Range ${Range} for ${key}`)
      }
      return {
        key,
        // `size` is the WHOLE object's: a ranged answer's Content-Length is only the slice.
        size: range ? range.total : (out.ContentLength ?? 0),
        contentType: out.ContentType ?? DEFAULT_CONTENT_TYPE,
        etag: quoteEtag(out.ETag),
        uploaded: out.LastModified ?? new Date(0),
        metadata: fromS3Metadata(out.Metadata),
        body,
        ...(range ? { range } : {}),
      }
    },
    head,
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }))
    },
    async deleteMany(keys) {
      for (let i = 0; i < keys.length; i += deleteBatch) {
        const batch = keys.slice(i, i + deleteBatch)
        const out = await client.send(
          new DeleteObjectsCommand({
            Bucket,
            Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true },
          })
        )
        const failed = out.Errors ?? []
        if (failed.length > 0) {
          const first = failed[0]
          const error = new Error(
            `storage.deleteMany: ${failed.length} key(s) not deleted (${first?.Key}: ${first?.Code} ${first?.Message ?? ''})`.trim()
          )
          // A per-key refusal arrives in the body, not as a 403: name it so the fence sees it.
          if (failed.some(f => f.Code === 'AccessDenied')) error.name = 'AccessDenied'
          throw error
        }
      }
    },
    listPage,
    async list(prefix) {
      const all: StoredObjectMeta[] = []
      let cursor: string | undefined
      do {
        const page = await listPage(prefix, { cursor })
        all.push(...page.objects)
        cursor = page.cursor
      } while (cursor)
      return all
    },
  }
}

// ---- The tenant fence -------------------------------------------------------------------------

export type StorageFence = 'off' | 'shadow' | 'on'

/** The STS session's lifetime: the files role's own maximum, one hour. */
export const TENANT_SESSION_SECONDS = 3600
/** A tenant's credentials are renewed this long before they expire. */
export const TENANT_CREDENTIALS_MARGIN_MS = 5 * 60 * 1000
/** Tenant S3 clients kept at once; the least recently used goes first. */
export const TENANT_CLIENTS = 256
/** A tenant client unused this long is dropped on the next lookup (any tenant's). */
export const TENANT_CLIENT_IDLE_MS = 50 * 60 * 1000

/** One tenant's temporary credentials, as STS issued them. */
export interface TenantCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  expiration: Date
}

export interface TenantStorageOptions {
  fence: StorageFence
  /** The role each tenant's session assumes (`FILES_ROLE_ARN`). Required unless `off`. */
  filesRoleArn?: string
  /** `storage.fence_denied` (shadow) and the debug not-found reads under `on`. */
  log?: (level: 'warn' | 'debug', event: string, fields: Record<string, unknown>) => void
  /** The STS client (tests point one at a fake endpoint). Default: the SDK's chain, the store's region. */
  sts?: STSClient
  /** A tenant's S3 client over its credentials (tests point it at their own store). */
  clientFor?: (credentials: () => Promise<TenantCredentials>) => S3Client
  maxClients?: number
  idleMs?: number
  /** The clock the credential cache and idle eviction read (tests). */
  now?: () => number
}

/**
 * `sts:AssumeRole` on `roleArn` for ONE tenant: the session tag `tenant=<tenantId>` (the only tag,
 * which the role's trust policy requires and its permissions interpolate into
 * `tenants/${aws:PrincipalTag/tenant}/`), session name `tenant-<tenantId>` (what CloudTrail shows).
 */
export async function assumeTenantRole(
  sts: STSClient,
  roleArn: string,
  tenantId: string
): Promise<TenantCredentials> {
  const id = requireTenantId(tenantId)
  const out = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `tenant-${id}`,
      DurationSeconds: TENANT_SESSION_SECONDS,
      Tags: [{ Key: 'tenant', Value: id }],
    })
  )
  const c = out.Credentials
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
    throw new Error(`storage: AssumeRole for tenant ${id} answered no credentials`)
  }
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiration: new Date(c.Expiration),
  }
}

/**
 * Each tenant's credentials, kept until `TENANT_CREDENTIALS_MARGIN_MS` before they expire;
 * concurrent asks for one tenant share one AssumeRole. `forget(tenantId)` drops them (an
 * `ExpiredToken` answer, an evicted client).
 */
export function tenantCredentialCache(
  assume: (tenantId: string) => Promise<TenantCredentials>,
  now: () => number = Date.now
) {
  const held = new Map<string, TenantCredentials>()
  const pending = new Map<string, Promise<TenantCredentials>>()
  return {
    get(tenantId: string): Promise<TenantCredentials> {
      const cached = held.get(tenantId)
      if (cached && cached.expiration.getTime() - TENANT_CREDENTIALS_MARGIN_MS > now()) {
        return Promise.resolve(cached)
      }
      held.delete(tenantId)
      let flight = pending.get(tenantId)
      if (!flight) {
        flight = assume(tenantId)
          .then(credentials => {
            held.set(tenantId, credentials)
            return credentials
          })
          .finally(() => pending.delete(tenantId))
        pending.set(tenantId, flight)
      }
      return flight
    },
    forget(tenantId: string): void {
      held.delete(tenantId)
    },
  }
}

/** AssumeRole failed for a tenant: under `on` the call fails (closed), under `shadow` it is served. */
export class TenantSessionError extends Error {
  constructor(
    readonly tenantId: string,
    cause: unknown
  ) {
    super(`storage: no session for tenant ${tenantId}: ${String(cause)}`, { cause })
    this.name = 'TenantSessionError'
  }
}

/** The S3 error names an expired session answers with. */
function isExpired(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return (
    name === 'ExpiredToken' || name === 'ExpiredTokenException' || name === 'TokenRefreshRequired'
  )
}

/** AccessDenied: the files role's answer to a key outside its policy, or to a missing one. */
function isDenied(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null
  return (
    e?.name === 'AccessDenied' || e?.name === 'Forbidden' || e?.$metadata?.httpStatusCode === 403
  )
}

/**
 * The platform's `storage`: every tenant behind the prefix check (`platform/tenant-storage.ts`),
 * over the process's credentials (`off`) or over the tenant's own STS session of
 * `FILES_ROLE_ARN` (`on`, `shadow`).
 *
 * - `on`: the tenant's session only, never a fallback. Under the files role a HEAD/GET of a
 *   missing key answers 403 (it may not list the bucket), so a denial inside the tenant's own
 *   prefix (already checked) reads as not-found.
 * - `shadow` (the rollout aid): the tenant's session first; on a denial the call is served with
 *   the process's credentials and `storage.fence_denied` is logged, unless the base store agrees
 *   the key is missing. A `putStream` body can be sent once, so `shadow` writes it with the
 *   process's credentials and then HEADs it over the tenant's session, logging a denial there.
 * - `ExpiredToken` drops the tenant's credentials and retries once.
 */
export function createTenantStorage(
  cfg: S3StorageConfig,
  options: TenantStorageOptions,
  base: StorageService = createS3Storage(cfg)
): TenantStorageFactory {
  if (options.fence === 'off') return tenantStorageOver(base)
  const roleArn = options.filesRoleArn
  if (!roleArn) throw new Error(`STORAGE_TENANT_FENCE=${options.fence} needs FILES_ROLE_ARN`)
  const fence = options.fence
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const sts = options.sts ?? new STSClient({ region: cfg.region })
  const credentials = tenantCredentialCache(id => assumeTenantRole(sts, roleArn, id), now)
  const clientFor =
    options.clientFor ??
    ((provider: () => Promise<TenantCredentials>) => createS3Client(cfg, provider))
  const max = options.maxClients ?? TENANT_CLIENTS
  const idleMs = options.idleMs ?? TENANT_CLIENT_IDLE_MS
  type Session = { storage: StorageService; client: S3Client; usedAt: number }
  const sessions = new Map<string, Session>()

  function drop(tenantId: string) {
    sessions.get(tenantId)?.client.destroy()
    sessions.delete(tenantId)
    credentials.forget(tenantId)
  }

  function session(tenantId: string): StorageService {
    const at = now()
    // Least recently used first (a Map iterates in insertion order): drop the idle ones.
    for (const [id, idle] of sessions) {
      if (at - idle.usedAt <= idleMs) break
      drop(id)
    }
    let entry = sessions.get(tenantId)
    if (entry) {
      sessions.delete(tenantId)
    } else {
      const client = clientFor(() =>
        credentials.get(tenantId).catch(err => {
          throw new TenantSessionError(tenantId, err)
        })
      )
      entry = { client, storage: createS3Storage(cfg, client), usedAt: at }
    }
    entry.usedAt = at
    sessions.set(tenantId, entry)
    while (sessions.size > max) {
      const oldest = sessions.keys().next().value as string
      drop(oldest)
    }
    return entry.storage
  }

  function fenced(tenantId: string): StorageService {
    async function run<T>(
      op: string,
      key: string,
      call: (s: StorageService) => Promise<T>,
      /** HEAD/GET: a denial inside the own prefix is a missing key. */
      missing?: T,
      retried = false
    ): Promise<T> {
      try {
        return await call(session(tenantId))
      } catch (err) {
        if (isExpired(err)) {
          drop(tenantId)
          if (!retried) return run(op, key, call, missing, true)
        }
        if (fence === 'shadow' && err instanceof TenantSessionError) {
          // The rollout aid never takes the app down: no session is a warning, served as before.
          log('warn', 'storage.fence_session_failed', { tenantId, op, error: String(err.cause) })
          return call(base)
        }
        if (!isDenied(err)) throw err
        if (fence === 'shadow') {
          const answer = await call(base)
          if (missing === undefined || answer !== missing) {
            log('warn', 'storage.fence_denied', { tenantId, op, key })
          }
          return answer
        }
        if (missing !== undefined) {
          log('debug', 'storage.fence_not_found', { tenantId, op, key })
          return missing
        }
        throw err
      }
    }

    async function shadowPutStream(
      key: string,
      body: ReadableStream<Uint8Array>,
      o: Parameters<StorageService['putStream']>[2]
    ) {
      const stored = await base.putStream(key, body, o)
      try {
        await session(tenantId).head(key)
      } catch (err) {
        if (isExpired(err)) drop(tenantId)
        if (err instanceof TenantSessionError) {
          log('warn', 'storage.fence_session_failed', {
            tenantId,
            op: 'putStream',
            error: String(err.cause),
          })
        } else if (isDenied(err)) {
          log('warn', 'storage.fence_denied', { tenantId, op: 'putStream', key, probe: 'head' })
        }
      }
      return stored
    }

    return {
      put: (key, body, o) => run('put', key, s => s.put(key, body, o)),
      // One-shot body: under `on` no retry can resend it, so it is never retried.
      putStream: (key, body, o) =>
        fence === 'shadow'
          ? shadowPutStream(key, body, o)
          : run('putStream', key, s => s.putStream(key, body, o), undefined, true),
      get: (key, o) => run('get', key, s => s.get(key, o), null),
      head: key => run('head', key, s => s.head(key), null),
      delete: key => run('delete', key, s => s.delete(key)),
      deleteMany: keys => run('deleteMany', keys[0] ?? '', s => s.deleteMany(keys)),
      listPage: (prefix, o) => run('listPage', prefix, s => s.listPage(prefix, o)),
      list: prefix => run('list', prefix, s => s.list(prefix)),
    }
  }

  return { forTenant: tenantId => fenceToTenant(fenced(requireTenantId(tenantId)), tenantId) }
}

/**
 * The platform member: null without a configured bucket, else every tenant's storage under
 * `STORAGE_TENANT_FENCE` (`off` by default; `on`/`shadow` need `FILES_ROLE_ARN`, which `loadConfig`
 * enforces).
 */
export function createPlatformStorage(
  config: AppConfig,
  log?: TenantStorageOptions['log']
): TenantStorageFactory | null {
  const s3 = storageConfigOf(config)
  if (!s3) return null
  return createTenantStorage(s3, {
    fence: config.STORAGE_TENANT_FENCE,
    filesRoleArn: config.FILES_ROLE_ARN,
    log,
  })
}
