/**
 * `/api/files`: upload / download / delete over the `StorageService` seam. Objects live in
 * object storage (S3) under a tenant prefix; the `files` row is the index and the ONLY thing the
 * browser can name (`/api/files/:id`). Every query filters by the auth context's `tenantId` — a
 * file uploaded in one organisation is a 404 in another, including avatars (known gap: the
 * person's `avatarUrl` is global, the object is not). Bytes stream through the server with `Cache-Control: private`.
 *
 * `avatars` scope: image MIME allowlist, and the caller's `users.avatarUrl` is set to the new URL.
 * Images and PDFs (`INLINE_MIME_TYPES`) are served `inline`; anything else is an attachment, so a
 * stored `text/html` or SVG can never execute on this origin. A PDF additionally opts into being
 * FRAMED (`c.set('embeddable', true)` → `SAMEORIGIN` + `frame-ancestors 'self'`, see
 * `middleware/security-headers.ts`) so the document viewer can embed it — a separate list from the
 * inline one on purpose, because inline and framable are not the same property. `documents` scope rows are created by `/api/ai/documents/upload`
 * and only deleted with their document (409 `owned_by_document` here).
 *
 * A download honours ONE `Range` (`bytes=a-b`, `a-`, `-n` — `parseByteRange`) with a 206 and
 * `Content-Range`, so a browser can seek a stored video or resume a download; a range it ignores
 * (malformed, several, another unit) is the whole file as a 200; a range starting past the end is
 * a 416 with `Content-Range: bytes *\/<size>`. `If-Range` naming anything but the current ETag gets
 * the whole file. The body is the store's stream, never buffered.
 */

import { ERROR_CODES } from '@rocketpod/shared/errors'
import {
  AVATAR_MIME_TYPES,
  type FileScope,
  filePath,
  isAvatarMimeType,
  isEmbeddableMimeType,
  isInlineMimeType,
  MAX_UPLOAD_BYTES,
  type StoredFile,
  uploadQuerySchema,
} from '@rocketpod/shared/files'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { documents, type FileRow, files, users } from '../../db/schema'
import { uploadBodyLimit } from '../middleware/body-limit'
import { can, guardPermission } from '../middleware/permissions'
import { type AccessScope, accessScopeOf, visibleDocuments } from '../services/access'
import { recordActivity } from '../services/activity'
import {
  deleteStoredFile,
  StorageRangeNotSatisfiableError,
  type StorageService,
  type StoredObject,
  storeUploadedFile,
} from '../services/storage'
import type { AppContext } from '../types'
import {
  ApiError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from '../utils/core/errors'
import { parseByteRange } from '../utils/routes/byte-range'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const filesRouter = createRouter()

/**
 * May this reader open the document this object belongs to? A `documents`-scope object always has
 * one; an orphan (the document was deleted but the row survived a failure) reads as NOT visible,
 * which is the safe direction.
 */
async function canReadOwningDocument(
  db: Database,
  scope: AccessScope,
  fileId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.fileId, fileId),
        eq(documents.tenantId, scope.tenantId),
        visibleDocuments(scope)
      )
    )
    .limit(1)
  return Boolean(row)
}

/** The platform's storage or a 503 — a deployment without it must fail loudly, not 500 on `null`. */
function storageFor(c: AppContext): StorageService {
  const storage = c.get('platform').storage
  if (!storage) {
    throw new ServiceUnavailableError('File storage is not configured', 'storage_not_configured')
  }
  return storage
}

export function toStoredFile(row: FileRow): StoredFile {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerUserId: row.ownerUserId,
    scope: row.scope,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    url: filePath(row.id),
    createdAt: row.createdAt,
  }
}

/** Per-scope acceptance. `uploads` takes anything (served as attachment unless it is an image). */
function checkContentType(scope: FileScope, contentType: string): void {
  if (scope === 'avatars' && !isAvatarMimeType(contentType)) {
    throw new ApiError(
      415,
      'Avatars must be a PNG, JPEG, GIF or WebP image',
      'unsupported_media_type',
      {
        allowed: AVATAR_MIME_TYPES,
      }
    )
  }
}

// ---- POST /api/files?scope= --------------------------------------------------------------

filesRouter.post('/', uploadBodyLimit, validate('query', uploadQuerySchema), async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'create', 'File')
  const { scope } = c.req.valid('query')
  const storage = storageFor(c)

  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) {
    throw new BadRequestError('Expected multipart form data with a `file` field', 'file_required')
  }
  if (file.size === 0) throw new BadRequestError('The file is empty', 'file_empty')
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError(
      413,
      `File exceeds the ${MAX_UPLOAD_BYTES} byte limit`,
      'payload_too_large',
      {
        maxBytes: MAX_UPLOAD_BYTES,
        sizeBytes: file.size,
      }
    )
  }
  const contentType = file.type || 'application/octet-stream'
  checkContentType(scope, contentType)

  const row = await storeUploadedFile(db, storage, {
    tenantId,
    ownerUserId: user.id,
    scope,
    file,
    filename: file.name || 'file',
    contentType,
  })
  if (scope === 'avatars') {
    try {
      await db
        .update(users)
        .set({ avatarUrl: filePath(row.id) })
        .where(eq(users.id, user.id))
    } catch (err) {
      // Still no orphans: an avatar whose pointer could not be written is rolled back whole.
      await deleteStoredFile(db, storage, row).catch(() => {})
      throw err
    }
  }

  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'file.uploaded',
      subjectType: 'File',
      subjectId: row.id,
      metadata: { scope, contentType, sizeBytes: row.sizeBytes, filename: row.filename },
    })
  )
  return c.json(toStoredFile(row), 201)
})

// ---- GET /api/files/:id ----------------------------------------------------------------

filesRouter.get('/:id', async c => {
  const { db, tenantId, auth, logger } = withAuthAndDb(c)
  guardPermission(c, 'read', 'File')
  const id = uuidParam(c, 'id')
  const row = await db.query.files.findFirst({
    where: and(eq(files.id, id), eq(files.tenantId, tenantId)),
  })
  if (!row) throw new NotFoundError('File not found')
  // A `documents`-scope object is the ORIGINAL behind a knowledge document, so it inherits
  // that document's visibility. Without this the restriction is one `/api/files/:id` away from
  // being nothing at all — the id is on the document card of anyone who ever could see it.
  if (
    row.scope === 'documents' &&
    !(await canReadOwningDocument(db, accessScopeOf(auth), row.id))
  ) {
    throw new NotFoundError('File not found')
  }

  const storage = storageFor(c)
  let range = parseByteRange(c.req.header('Range'))
  let object: StoredObject | null
  try {
    object = await storage.get(row.key, range ? { range } : undefined)
  } catch (err) {
    if (!(err instanceof StorageRangeNotSatisfiableError)) throw err
    // `c.header` before the throw: the error handler's `c.json` keeps headers already set.
    const total = err.total ?? (await storage.head(row.key))?.size
    c.header('Accept-Ranges', 'bytes')
    if (total !== undefined) c.header('Content-Range', `bytes */${total}`)
    throw new ApiError(416, 'That byte range is outside the file', ERROR_CODES.rangeNotSatisfiable)
  }
  if (!object) {
    logger.warn({ fileId: row.id, key: row.key }, 'files: row exists but the object is missing')
    throw new NotFoundError('File not found')
  }
  if (range && c.req.header('If-Range') !== undefined) {
    if (c.req.header('If-Range')?.trim() !== object.etag) {
      // The client's copy is of another version: the whole file, not a slice it cannot splice.
      await object.body.cancel().catch(() => {})
      object = await storage.get(row.key)
      range = null
      if (!object) throw new NotFoundError('File not found')
    }
  }

  // BEFORE the 304: a revalidation from inside the viewer's `<object>` must carry the relaxed
  // framing headers too, or the embed dies on its second view with nothing in the log.
  if (isEmbeddableMimeType(row.contentType)) c.set('embeddable', true)

  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    ETag: object.etag,
  }
  if (!range && c.req.header('If-None-Match') === object.etag) {
    await object.body.cancel().catch(() => {})
    return c.body(null, 304, headers)
  }
  headers['Content-Type'] = row.contentType
  // Images and PDFs render inline; everything else downloads, so a stored `text/html` or SVG can
  // never execute script on this origin. A PDF is safe because the browser hands it to its own
  // viewer, which does not run the file's script in this document's context.
  headers['Content-Disposition'] = isInlineMimeType(row.contentType)
    ? 'inline'
    : `attachment; filename="${row.filename.replace(/"/g, '')}"`
  if (object.range) {
    const { start, end, total } = object.range
    headers['Content-Range'] = `bytes ${start}-${end}/${total}`
    headers['Content-Length'] = String(end - start + 1)
    return c.body(object.body, 206, headers)
  }
  headers['Content-Length'] = String(object.size)
  return c.body(object.body, 200, headers)
})

// ---- DELETE /api/files/:id -------------------------------------------------------------

filesRouter.delete('/:id', async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'read', 'File')
  const id = uuidParam(c, 'id')
  const row = await db.query.files.findFirst({
    where: and(eq(files.id, id), eq(files.tenantId, tenantId)),
  })
  if (!row) throw new NotFoundError('File not found')
  // A knowledge-base original belongs to its `documents` row: delete the document instead.
  if (row.scope === 'documents') {
    throw new ConflictError(
      'This file is the original of a knowledge document; delete the document instead',
      'owned_by_document'
    )
  }
  // "Owner or admin+": the uploader may always delete their own file; others need `delete File`.
  if (row.ownerUserId !== user.id && !can(c, 'delete', 'File')) {
    throw new ForbiddenError('You can only delete your own files')
  }

  await storageFor(c).delete(row.key)
  await db.delete(files).where(and(eq(files.id, row.id), eq(files.tenantId, tenantId)))
  if (user.avatarUrl === filePath(row.id)) {
    await db.update(users).set({ avatarUrl: null }).where(eq(users.id, user.id))
  }
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'file.deleted',
      subjectType: 'File',
      subjectId: row.id,
      metadata: { scope: row.scope, ownerUserId: row.ownerUserId },
    })
  )
  return c.body(null, 204)
})
