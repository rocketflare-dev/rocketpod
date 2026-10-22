/**
 * `StorageService` over any S3-compatible object store (M6, `docs/DESIGN-SELFHOSTED.md` §5.5):
 * AWS S3, MinIO, Cloudflare R2's S3 endpoint, Ceph/RGW, GCS in interoperability mode. They differ
 * only by endpoint and path style, so ONE adapter covers them; `STORAGE_DRIVER=s3` and the
 * `STORAGE_*` vars configure it (`storageConfigOf`), and a missing piece leaves the platform's
 * `storage` null — the 503 `storage_not_configured` every caller already answers.
 *
 * It reproduces the R2 adapter (`src/platform/cloudflare/storage.ts`) exactly where the app can
 * see it:
 * - keys are used verbatim (the tenant prefix is the caller's — `buildStorageKey`);
 * - the ETag is R2's quoted, HTTP-ready form;
 * - a listing carries no content type or custom metadata (R2's `list` without `include` does not
 *   either), so `contentType` is the default and `metadata` is `{}` on a listed object;
 * - downloads stream through the server (no presigned URLs);
 * - a ranged `get` is a `Range` header on `GetObject`, its `Content-Range` parsed back into
 *   `range`, and S3's 416 (`InvalidRange`) is `StorageRangeNotSatisfiableError`; a store that
 *   ignored the `Range` (answered 200 from byte 0) is an error, never a silently wrong body;
 * - `putStream` is `@aws-sdk/lib-storage`'s `Upload`: a multipart upload of a body whose length is
 *   unknown, `PART_SIZE` at a time (one plain PutObject when the whole body fits in one part).
 *
 * S3 lower-cases user-metadata keys (they are HTTP headers); R2 preserves them. The original keys
 * ride in one extra header, `x-amz-meta-rp-keys`, so a `get`/`head` hands back `tenantId`, not
 * `tenantid`. Values travel as headers: printable ASCII only, which every value the kit writes
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
import { Upload } from '@aws-sdk/lib-storage'
import type { AppConfig } from '../config'
import {
  type StorageBody,
  type StorageRange,
  StorageRangeNotSatisfiableError,
  type StorageService,
  type StoredObject,
  type StoredObjectMeta,
  type StoredRange,
} from '../platform/types'

const DEFAULT_CONTENT_TYPE = 'application/octet-stream'
/** The header that carries the original (case-preserved) metadata keys. */
const KEYS_HEADER = 'rp-keys'
/** S3's `DeleteObjects` and R2's `delete([...])` both stop at 1 000 keys per call. */
const DELETE_BATCH = 1000
/** A multipart part: S3's 5 MiB minimum for every part but the last. */
const PART_SIZE = 5 * 1024 * 1024
/** Parts in flight at once — bounds a `putStream`'s memory to about PART_SIZE × this. */
const UPLOAD_QUEUE = 2

export interface S3StorageConfig {
  /** `https://s3.eu-west-1.amazonaws.com`, `http://localhost:9000`, `https://<acct>.r2.cloudflarestorage.com`. Unset = AWS's default endpoint for the region. */
  endpoint?: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** `true` for MinIO and most self-hosted stores (`http://host/bucket/key`). */
  forcePathStyle: boolean
}

/** The S3 settings the config names, or null when storage is not (fully) configured. */
export function storageConfigOf(config: AppConfig): S3StorageConfig | null {
  if (config.STORAGE_DRIVER !== 's3') return null
  const { STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY } = config
  if (!STORAGE_BUCKET || !STORAGE_ACCESS_KEY_ID || !STORAGE_SECRET_ACCESS_KEY) return null
  return {
    endpoint: config.STORAGE_ENDPOINT,
    region: config.STORAGE_REGION,
    bucket: STORAGE_BUCKET,
    accessKeyId: STORAGE_ACCESS_KEY_ID,
    secretAccessKey: STORAGE_SECRET_ACCESS_KEY,
    forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
  }
}

/** A client for the store. Exported so tests and scripts address the same bucket the same way. */
export function createS3Client(cfg: S3StorageConfig): S3Client {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // The SDK's default (a CRC checksum on every request that supports one) is refused by several
    // S3-compatible stores; send one only where the API demands it.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

/** R2's form: the hex digest in double quotes, whatever the store returned. */
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
          throw new Error(
            `storage.deleteMany: ${failed.length} key(s) not deleted (${first?.Key}: ${first?.Code} ${first?.Message ?? ''})`.trim()
          )
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
