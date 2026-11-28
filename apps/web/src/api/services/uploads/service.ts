/**
 * Uploads: straight to the object store when `STORAGE_DIRECT_UPLOADS` is on, through the server
 * otherwise. The same three steps either way:
 *
 *   createUpload    every check the target makes, then a `pending_uploads` row, then the `PUT` URL:
 *                   a presigned S3 PutObject (`storage.presignPut`, on the TENANT's storage handle,
 *                   so under `STORAGE_TENANT_FENCE=on` it is signed with the tenant's own session and
 *                   can write under `tenants/<tenantId>/` only) with `content-type`,
 *                   `content-length` and `if-none-match: *` SIGNED — another type, another length or
 *                   a second write to the key is refused by the store itself.
 *   confirmUpload   resolves the row's target and the storage, then claims the row (compare-and-set
 *                   on `confirmed_at`, so once), `head`s the object, checks it against what was
 *                   declared, and hands it to the target. A mismatch or a target that throws
 *                   deletes the object and un-claims the row.
 *   receiveServerUpload   the URL when direct uploads are off: the server's own
 *                   (`PUT /api/upload-content/:id?token=`), which STREAMS the body to the store
 *                   (`putStream`, multipart, never held whole) with a conditional write
 *                   (`ifAbsent`, `If-None-Match: *`). Same headers, same checks, same confirm — the
 *                   client cannot tell — and spent once the upload is confirmed. It takes at most
 *                   `MAX_SERVER_UPLOAD_BYTES` a file.
 *   prunePendingUploads   the nightly sweep: an upload whose URL died unconfirmed loses its object,
 *                   and so does a confirmed core upload whose key no `files` row records.
 *
 * Tenancy: the key is built on the server under `tenants/<tenantId>/` (asserted for every target; a
 * plugin's under its own `tenants/<tenantId>/<pluginId>/`, naming the upload id), every object call
 * goes through `platform.storage.forTenant(row.tenantId)`, and no URL is handed out for a key that
 * already holds an object. Confirm finds the row by id AND the caller's tenant AND user, so another
 * tenant's upload id is the same 404 as an unknown one. Two lookups are deliberately cross-tenant
 * (the allow-list scan reads them as scoped, since each names `tenantId`): `receiveServerUpload`
 * runs before any session, so the id names the row and its stored token hash is the credential;
 * `prunePendingUploads` sweeps every tenant's expired rows in one statement, and looks confirmed
 * keys up in `files` by key alone (a key embeds its tenant's prefix and is unique).
 */
import { ERROR_CODES } from '@rocketpod/shared/errors'
import {
  CORE_UPLOAD_TARGETS,
  type CreateUploadRequest,
  type CreateUploadResponse,
  createUploadRequestSchema,
  UPLOAD_URL_TTL_SECONDS,
} from '@rocketpod/shared/uploads'
import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { files, type PendingUploadRow, pendingUploads } from '../../../db/schema'
import type { Platform } from '../../../platform/types'
import { MAX_PLUGIN_UPLOAD_LIMIT_BYTES } from '../../middleware/body-limit'
import type { AppContext } from '../../types'
import {
  ApiError,
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../utils/core/errors'
import { hashToken, safeEqual } from '../../utils/core/hash'
import { newId, randomToken } from '../../utils/core/ids'
import { withAuthAndDb } from '../../utils/routes/route-helpers'
import {
  PURGE_PAGE_SIZE,
  StorageObjectExistsError,
  type StorageService,
  sanitizeFilename,
  tenantStoragePrefix,
} from '../storage'
import { type UploadTarget, uploadTargets } from './targets'

/**
 * How long after the URL dies a confirm is still accepted: the store checks expiry when the `PUT`
 * STARTS, so a large file begun at the last second may land minutes later.
 */
export const UPLOAD_CONFIRM_GRACE_SECONDS = 15 * 60

/**
 * The most the server's own upload URL takes (`STORAGE_DIRECT_UPLOADS` off), whatever a target
 * allows: the body is streamed to the store, never held, but it still crosses the ingress in front
 * of the server, whose cap (`proxy-body-size`, `docs/DEPLOY.md`) is the same one a plugin's
 * `uploadLimits` path needs. A target allowing more needs direct uploads.
 */
export const MAX_SERVER_UPLOAD_BYTES = MAX_PLUGIN_UPLOAD_LIMIT_BYTES

/**
 * The server's upload URL — NOT under `/api/uploads`, whose mount is authed: the token is this
 * route's only credential, as the signature is on S3's URL. `apiBodyLimit` lets its body past 1 MB.
 */
export const SERVER_UPLOAD_PREFIX = '/api/upload-content'
export const serverUploadPath = (uploadId: string) => `${SERVER_UPLOAD_PREFIX}/${uploadId}`

/** The server upload URL's transport cap: the largest target, within `MAX_SERVER_UPLOAD_BYTES`. */
export function serverUploadMaxBytes(): number {
  const largest = Math.max(...[...uploadTargets().values()].map(t => t.maxBytes))
  return Math.min(largest, MAX_SERVER_UPLOAD_BYTES)
}

const STORAGE_NOT_CONFIGURED = 'storage_not_configured'

/** `Image/PNG; charset=x` → `image/png`. */
export function normaliseContentType(value: string | null | undefined): string {
  return (value ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

/** The tenant's storage, or a 503 — a deployment without a bucket fails loudly. */
function storageFor(c: AppContext, tenantId: string): StorageService {
  const storage = c.get('platform').storage
  if (!storage) {
    throw new ServiceUnavailableError('File storage is not configured', STORAGE_NOT_CONFIGURED)
  }
  return storage.forTenant(tenantId)
}

function lookupTarget(id: string): UploadTarget {
  const target = uploadTargets().get(id)
  if (!target) {
    throw new BadRequestError(`Unknown upload target: ${id}`, ERROR_CODES.unknownUploadTarget)
  }
  return target
}

// ---- POST /api/uploads ---------------------------------------------------------------------------

export async function createUpload(
  c: AppContext,
  request: CreateUploadRequest
): Promise<CreateUploadResponse> {
  const body = createUploadRequestSchema.parse(request)
  const { db, tenantId, user, cfg } = withAuthAndDb(c)
  const target = lookupTarget(body.target)
  const storage = storageFor(c, tenantId)

  const direct = cfg.STORAGE_DIRECT_UPLOADS
  const maxBytes = direct ? target.maxBytes : Math.min(target.maxBytes, MAX_SERVER_UPLOAD_BYTES)

  if (body.size === 0) throw new BadRequestError('The file is empty', 'file_empty')
  if (body.size > maxBytes) {
    throw new ApiError(
      413,
      maxBytes < target.maxBytes
        ? `File exceeds the ${maxBytes} byte limit for uploads through the server; larger files need direct uploads (docs/DEPLOY.md § Direct uploads)`
        : `File exceeds the ${maxBytes} byte limit`,
      'payload_too_large',
      { maxBytes, sizeBytes: body.size, ...(direct ? {} : { directUploads: false }) }
    )
  }

  const uploadId = newId()
  const filename = sanitizeFilename(body.name)
  const prepared = await target.prepare(c, {
    uploadId,
    tenantId,
    userId: user.id,
    filename,
    contentType: normaliseContentType(body.contentType),
    size: body.size,
    fields: body.fields ?? {},
  })
  if (!prepared.key.startsWith(tenantStoragePrefix(tenantId))) {
    throw new ApiError(
      500,
      `Upload target ${target.id} answered a storage key outside the tenant's prefix`,
      ERROR_CODES.uploadKeyInvalid
    )
  }
  // The failed confirm, the expiry and the prune delete this key: never hand out a URL for one that
  // holds an object already. (Every key names a fresh upload id, so this is the backstop.)
  if (await storage.head(prepared.key)) {
    throw new ApiError(
      409,
      'A file is already stored under this upload key; start a new upload',
      ERROR_CODES.uploadKeyExists
    )
  }

  // The row before the URL: a URL with no row could write an object the prune never finds.
  let expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000)
  const token = direct ? null : randomToken()
  await db.insert(pendingUploads).values({
    id: uploadId,
    tenantId,
    userId: user.id,
    target: target.id,
    key: prepared.key,
    filename,
    contentType: prepared.contentType,
    sizeBytes: body.size,
    state: prepared.state ?? {},
    tokenHash: token ? await hashToken(token) : null,
    expiresAt,
  })

  if (token) {
    const url = new URL(serverUploadPath(uploadId), cfg.APP_URL)
    url.searchParams.set('token', token)
    const headers = { 'Content-Type': prepared.contentType, 'If-None-Match': '*' }
    return { uploadId, method: 'PUT', url: url.toString(), headers, expiresAt }
  }
  const presigned = await storage
    .presignPut(prepared.key, {
      contentType: prepared.contentType,
      contentLength: body.size,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    })
    .catch(async err => {
      await db
        .delete(pendingUploads)
        .where(and(eq(pendingUploads.id, uploadId), eq(pendingUploads.tenantId, tenantId)))
      throw err
    })
  // Signed with temporary credentials that expire first, the URL dies with them: say so.
  if (presigned.expiresAt < expiresAt) expiresAt = presigned.expiresAt
  return {
    uploadId,
    method: 'PUT',
    url: presigned.url,
    headers: presigned.headers,
    expiresAt,
  }
}

// ---- POST /api/uploads/:id/confirm ---------------------------------------------------------------

const confirmDeadline = (row: Pick<PendingUploadRow, 'expiresAt'>) =>
  row.expiresAt.getTime() + UPLOAD_CONFIRM_GRACE_SECONDS * 1000

/** Give the claim back: a failed confirm leaves the row for the prune, never an orphaned key. */
async function unclaim(db: Database, row: PendingUploadRow): Promise<void> {
  await db
    .update(pendingUploads)
    .set({ confirmedAt: null })
    .where(and(eq(pendingUploads.id, row.id), eq(pendingUploads.tenantId, row.tenantId)))
}

export async function confirmUpload(
  c: AppContext,
  uploadId: string
): Promise<{ status: 200 | 201; body: unknown }> {
  const { db, tenantId, user, logger } = withAuthAndDb(c)
  const mine = and(
    eq(pendingUploads.id, uploadId),
    eq(pendingUploads.tenantId, tenantId),
    eq(pendingUploads.userId, user.id),
    isNull(pendingUploads.confirmedAt)
  )
  // Unknown, another tenant's, another person's and already-confirmed are the same answer.
  const pending = await db.query.pendingUploads.findFirst({ where: mine })
  if (!pending) throw new NotFoundError('Upload not found')
  // Everything that can refuse before the target runs is resolved BEFORE the claim: a target since
  // uninstalled or storage since unconfigured leaves the row unclaimed, for a retry or the prune.
  const target = lookupTarget(pending.target)
  const storage = storageFor(c, tenantId)

  const [row] = await db
    .update(pendingUploads)
    .set({ confirmedAt: new Date() })
    .where(mine)
    .returning()
  // A concurrent confirm claimed it between the read and here.
  if (!row) throw new NotFoundError('Upload not found')

  const fail = async (err: ApiError): Promise<never> => {
    await storage.delete(row.key).catch(() => {})
    await unclaim(db, row)
    throw err
  }

  if (Date.now() > confirmDeadline(row)) {
    await fail(new ApiError(410, 'This upload has expired', ERROR_CODES.uploadExpired))
  }
  const object = await storage.head(row.key)
  if (!object) {
    await unclaim(db, row)
    throw new BadRequestError('Nothing has been uploaded yet', ERROR_CODES.uploadMissing)
  }
  if (
    object.size !== row.sizeBytes ||
    normaliseContentType(object.contentType) !== row.contentType
  ) {
    await fail(
      new BadRequestError('The uploaded file is not the one declared', ERROR_CODES.uploadMismatch, {
        declared: { sizeBytes: row.sizeBytes, contentType: row.contentType },
        received: { sizeBytes: object.size, contentType: object.contentType },
      })
    )
  }

  try {
    return await target.confirm(c, {
      uploadId: row.id,
      key: row.key,
      filename: row.filename,
      contentType: row.contentType,
      size: row.sizeBytes,
      state: row.state,
      storage,
    })
  } catch (err) {
    // A core target that got as far as its `files` row owns the object now; anything else is ours.
    const owned = await db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.tenantId, tenantId), eq(files.key, row.key)))
      .limit(1)
    if (owned.length === 0) {
      await storage.delete(row.key).catch(() => {})
      await unclaim(db, row).catch(error =>
        logger.warn({ err: error, uploadId }, 'uploads: could not un-claim a failed confirm')
      )
    }
    throw err
  }
}

// ---- PUT /api/upload-content/:id (STORAGE_DIRECT_UPLOADS off) ------------------------------------

/** The body was not the declared length: counted as it streamed, so it is refused mid-upload. */
class BodyLengthError extends Error {}

/**
 * Pass `body` through, refusing it the moment it exceeds `size` bytes, or at its end when it fell
 * short: the store then aborts the upload, so no object of another length is ever written.
 */
function exactLength(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  let seen = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (seen > size) controller.error(new BodyLengthError())
        else controller.enqueue(chunk)
      },
      flush(controller) {
        if (seen !== size) controller.error(new BodyLengthError())
      },
    })
  )
}

/**
 * The server's stand-in for a presigned `PUT`, offered when `STORAGE_DIRECT_UPLOADS` is off, with
 * the store's rules: the token proves the URL, the URL dies at `expiresAt`, the `Content-Type` and
 * `Content-Length` must be the declared ones, and the key is written once (a conditional write).
 * Stricter than S3 in one way: the URL is spent once the upload is confirmed. The body is STREAMED
 * to the store (`putStream`), held to the declared length as it arrives; the transport cap is
 * `apiBodyLimit`'s `serverUpload` (`MAX_SERVER_UPLOAD_BYTES`).
 */
export async function receiveServerUpload(c: AppContext, uploadId: string): Promise<void> {
  const db = c.get('db')
  const token = c.req.query('token') ?? ''
  // Pre-auth: the token is the credential, exactly as a signature is on S3. The id narrows to one
  // row; the token hash must then match it.
  const row = await db.query.pendingUploads.findFirst({ where: eq(pendingUploads.id, uploadId) })
  if (!row?.tokenHash || !safeEqual(row.tokenHash, await hashToken(token))) {
    throw new ApiError(403, 'Invalid upload URL', 'forbidden')
  }
  if (Date.now() > row.expiresAt.getTime()) {
    throw new ApiError(403, 'This upload URL has expired', ERROR_CODES.uploadExpired)
  }
  // Spent once confirmed — even if the confirmed object was deleted since, which would let an
  // "only if absent" write through. A row whose uploader was deleted is spent too.
  if (row.confirmedAt || !row.userId) {
    throw new ApiError(403, 'This upload URL has already been used', 'forbidden')
  }
  const declaredLength = Number(c.req.header('Content-Length'))
  if (
    normaliseContentType(c.req.header('Content-Type')) !== row.contentType ||
    declaredLength !== row.sizeBytes ||
    c.req.header('If-None-Match') !== '*'
  ) {
    throw new ApiError(403, 'The request does not match the signed upload', 'forbidden')
  }
  const storage = storageFor(c, row.tenantId)
  const body = c.req.raw.body
  if (!body) throw new BadRequestError('The body is empty', ERROR_CODES.uploadMismatch)
  try {
    // ONE conditional write, as `If-None-Match: *` is on S3's own URL: a check-then-write would let
    // two concurrent PUTs both pass the check.
    await storage.putStream(row.key, exactLength(body, row.sizeBytes), {
      contentType: row.contentType,
      ifAbsent: true,
    })
  } catch (err) {
    if (err instanceof StorageObjectExistsError) {
      throw new ApiError(412, 'The object already exists', 'precondition_failed')
    }
    if (
      err instanceof BodyLengthError ||
      (err as { cause?: unknown })?.cause instanceof BodyLengthError
    ) {
      throw new BadRequestError('The body is not the declared length', ERROR_CODES.uploadMismatch)
    }
    throw err
  }
}

// ---- nightly prune --------------------------------------------------------------------------------

const CORE_TARGET_IDS: readonly string[] = CORE_UPLOAD_TARGETS

/**
 * Uploads whose URL and confirm window are both over. An UNCONFIRMED one loses its object (it was
 * never recorded, or its confirm failed). A CONFIRMED one is forgotten, and for a core target its
 * object goes too when no `files` row records the key: a core confirm always records one (a
 * deduplicated document deletes its bytes instead), so an unrecorded key is a file deleted since,
 * re-written through its still-live presigned URL. A plugin's confirmed object is its own — the
 * kit cannot tell which of its rows records the key (CONCEPTS §6, known gaps). A confirmed row
 * waits until its claim is past the grace too, so a confirm still running is never pruned under.
 * One statement each across every tenant, from the `(tenant_id, expires_at)` index; the objects
 * are deleted through each tenant's own storage handle (`forTenant`), so the fence holds here too.
 */
export async function prunePendingUploads(
  db: Database,
  platform: Pick<Platform, 'storage'>,
  now = new Date()
): Promise<{ objects: number; rows: number }> {
  const cutoff = new Date(now.getTime() - UPLOAD_CONFIRM_GRACE_SECONDS * 1000)
  const stale = await db
    .delete(pendingUploads)
    .where(and(lt(pendingUploads.expiresAt, cutoff), isNull(pendingUploads.confirmedAt)))
    .returning({ tenantId: pendingUploads.tenantId, key: pendingUploads.key })
  const confirmed = await db
    .delete(pendingUploads)
    .where(
      and(
        lt(pendingUploads.expiresAt, cutoff),
        isNotNull(pendingUploads.confirmedAt),
        lt(pendingUploads.confirmedAt, cutoff)
      )
    )
    .returning({
      tenantId: pendingUploads.tenantId,
      target: pendingUploads.target,
      key: pendingUploads.key,
    })

  const unrecorded: { tenantId: string; key: string }[] = []
  const core = confirmed.filter(row => CORE_TARGET_IDS.includes(row.target))
  for (let i = 0; i < core.length; i += PURGE_PAGE_SIZE) {
    const page = core.slice(i, i + PURGE_PAGE_SIZE)
    // By key alone: a key embeds its tenant's prefix and is unique across `files`.
    const recorded = await db
      .select({ key: files.key })
      .from(files)
      .where(
        inArray(
          files.key,
          page.map(row => row.key)
        )
      )
    const kept = new Set(recorded.map(row => row.key))
    unrecorded.push(...page.filter(row => !kept.has(row.key)))
  }

  const byTenant = new Map<string, string[]>()
  for (const { tenantId, key } of [...stale, ...unrecorded]) {
    byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), key])
  }
  if (platform.storage) {
    for (const [tenantId, keys] of byTenant) {
      const storage = platform.storage.forTenant(tenantId)
      for (let i = 0; i < keys.length; i += PURGE_PAGE_SIZE) {
        await storage.deleteMany(keys.slice(i, i + PURGE_PAGE_SIZE))
      }
    }
  }
  return { objects: stale.length + unrecorded.length, rows: stale.length + confirmed.length }
}
