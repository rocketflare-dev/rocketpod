/**
 * Object storage helpers over the neutral `StorageService` (`src/platform/types.ts`; the
 * S3 adapter is `src/node/storage.ts`). Routes read it as
 * `c.get('platform').storage`, so a test can pass an in-memory bucket and an app can swap the
 * backend without touching callers. Keys are tenant-prefixed
 * (`tenants/<tenantId>/<scope>/<uuid>-<name>`) so one prefix scopes a whole tenant for listing
 * or bulk deletion; the UUID makes every key unique regardless of the client's filename.
 *
 * Bytes stream THROUGH the server on download (no presigned URLs).
 */
import {
  AVATAR_MIME_TYPES,
  type FileScope,
  isAvatarMimeType,
  MAX_UPLOAD_BYTES,
} from '@rocketpod/shared/files'
import { eq } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { type FileRow, files } from '../../db/schema'
import type { StorageListPage, StorageService } from '../../platform/types'
import { newId } from '../utils/core/ids'

export type {
  GetOptions,
  PutOptions,
  StorageBody,
  StorageListPage,
  StorageRange,
  StorageService,
  StoredObject,
  StoredObjectMeta,
  StoredRange,
} from '../../platform/types'
export { StorageRangeNotSatisfiableError } from '../../platform/types'
export { AVATAR_MIME_TYPES, isAvatarMimeType, MAX_UPLOAD_BYTES }

export const MAX_FILENAME_LENGTH = 120

/**
 * Reduce a client filename to ONE safe path segment: no separators or traversal, only
 * `[A-Za-z0-9._-]`, bounded length, never empty. The extension survives so `Content-Disposition`
 * downloads keep a sensible name.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+/, '')
  if (cleaned.length === 0) return 'file'
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned
  const dot = cleaned.lastIndexOf('.')
  const ext = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : ''
  return `${cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length)}${ext}`
}

export interface StorageKeyInput {
  tenantId: string
  scope: FileScope
  /** The client's filename; sanitised here. */
  name: string
  /** Supplied by tests for determinism; defaults to a fresh UUID. */
  id?: string
}

/** `tenants/<tenantId>/<scope>/<uuid>-<sanitised name>`. */
export function buildStorageKey({ tenantId, scope, name, id }: StorageKeyInput): string {
  return `tenants/${tenantId}/${scope}/${id ?? newId()}-${sanitizeFilename(name)}`
}

/** Keys deleted per round trip. Under S3's 1 000-key `DeleteObjects` cap, with room to spare. */
export const PURGE_PAGE_SIZE = 500

/** The prefix that scopes every object of a tenant (or one scope of it). */
export function tenantStoragePrefix(tenantId: string, scope?: FileScope): string {
  return scope ? `tenants/${tenantId}/${scope}/` : `tenants/${tenantId}/`
}

/**
 * Delete every object of a tenant, a page at a time, and answer how many went (the tenant purge).
 *
 * This is the other half of what the FK cascade does in Postgres: `tenants/<tenantId>/` is the one
 * prefix that scopes an organisation's bytes, which is exactly why keys carry it. It is
 * **idempotent by construction** — a second run lists nothing and deletes nothing — so the
 * `tenant.purge` job may be retried, and a run that dies halfway resumes from what is left rather
 * than from the beginning.
 *
 * Paged rather than `list()`-then-delete: a large tenant's whole key set must not be held in
 * memory at once, and one `deleteMany` per page keeps the store round trips to two per page
 * instead of one per object.
 */
export async function purgeTenantObjects(
  storage: StorageService,
  tenantId: string,
  options: { limit?: number } = {}
): Promise<number> {
  return purgePrefix(storage, tenantStoragePrefix(tenantId), options)
}

/**
 * Delete every object under a prefix, a page at a time; answers how many went. Idempotent: a second
 * run lists nothing. The tenant purge is this over `tenants/<tenantId>/`; a feature that owns a
 * narrower prefix inside it (one record's objects) purges that the same way.
 *
 * The prefix must be a whole DIRECTORY under `tenants/`: `tenants/t/rec-1` would also take
 * `tenants/t/rec-10/…`, and an empty one is the whole bucket — both refused before any listing.
 */
export async function purgePrefix(
  storage: StorageService,
  prefix: string,
  options: { limit?: number } = {}
): Promise<number> {
  if (!/^tenants\/[^/]+\/(?:[^/]+\/)*$/.test(prefix) || prefix.split('/').includes('..')) {
    throw new Error(`purgePrefix: not a tenant directory prefix: ${JSON.stringify(prefix)}`)
  }
  const limit = options.limit ?? PURGE_PAGE_SIZE
  let deleted = 0
  let cursor: string | undefined
  for (;;) {
    const page: StorageListPage = await storage.listPage(prefix, { cursor, limit })
    if (page.objects.length === 0) return deleted
    await storage.deleteMany(page.objects.map(o => o.key))
    deleted += page.objects.length
    cursor = page.cursor
    if (!cursor) return deleted
  }
}

// ---- Upload = object + row ---------------------------------------------------------------------

export interface StoreUploadInput {
  tenantId: string
  ownerUserId: string
  scope: FileScope
  /** The multipart part — a Blob carries its length, which the S3 upload needs. */
  file: Blob
  /** The client's filename (sanitised here). */
  filename: string
  contentType: string
}

/**
 * Put the bytes under a tenant-scoped key, then insert the `files` row that is the ONLY thing the
 * browser can name. No orphaned objects: if the row cannot be written the object is deleted again.
 * Shared by `/api/files` (avatars, generic uploads) and `/api/ai/documents/upload` (originals).
 */
export async function storeUploadedFile(
  db: Database,
  storage: StorageService,
  input: StoreUploadInput
): Promise<FileRow> {
  const filename = sanitizeFilename(input.filename || 'file')
  const key = buildStorageKey({ tenantId: input.tenantId, scope: input.scope, name: filename })
  await storage.put(key, input.file, {
    contentType: input.contentType,
    metadata: { tenantId: input.tenantId, ownerUserId: input.ownerUserId, scope: input.scope },
  })
  try {
    const [row] = await db
      .insert(files)
      .values({
        tenantId: input.tenantId,
        ownerUserId: input.ownerUserId,
        scope: input.scope,
        key,
        filename,
        contentType: input.contentType,
        sizeBytes: input.file.size,
      })
      .returning()
    if (!row) throw new Error('files: insert returned no row')
    return row
  } catch (err) {
    await storage.delete(key).catch(() => {})
    throw err
  }
}

/** Delete an object and its row together (idempotent on both sides). Tenant predicate on the row. */
export async function deleteStoredFile(
  db: Database,
  storage: StorageService | null,
  row: Pick<FileRow, 'id' | 'key'>
): Promise<void> {
  if (storage) await storage.delete(row.key)
  await db.delete(files).where(eq(files.id, row.id))
}
