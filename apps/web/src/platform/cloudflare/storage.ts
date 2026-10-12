/**
 * `StorageService` over the native `FILES` R2 binding (D23). Bytes stream THROUGH the Worker on
 * download (no presigned URLs — the binding cannot mint them). `wrangler dev` emulates R2 locally.
 */
import type { StorageService, StoredObjectMeta } from '../types'

const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

function toMeta(obj: R2Object): StoredObjectMeta {
  return {
    key: obj.key,
    size: obj.size,
    contentType: obj.httpMetadata?.contentType ?? DEFAULT_CONTENT_TYPE,
    etag: obj.httpEtag,
    uploaded: obj.uploaded,
    metadata: obj.customMetadata ?? {},
  }
}

/** The kit's `StorageService`: a thin adapter over the R2 binding. */
export function createR2Storage(bucket: R2Bucket): StorageService {
  return {
    async put(key, body, options) {
      const obj = await bucket.put(key, body, {
        httpMetadata: { contentType: options.contentType },
        customMetadata: options.metadata,
      })
      if (!obj) throw new Error(`storage.put: R2 returned no object for ${key}`)
      return toMeta(obj)
    },
    async get(key) {
      const obj = await bucket.get(key)
      if (!obj) return null
      return { ...toMeta(obj), body: obj.body }
    },
    async head(key) {
      const obj = await bucket.head(key)
      return obj ? toMeta(obj) : null
    },
    async delete(key) {
      await bucket.delete(key)
    },
    async deleteMany(keys) {
      if (keys.length === 0) return
      await bucket.delete([...keys])
    },
    async listPage(prefix, options) {
      const page = await bucket.list({ prefix, cursor: options?.cursor, limit: options?.limit })
      return {
        objects: page.objects.map(toMeta),
        cursor: page.truncated ? page.cursor : undefined,
      }
    },
    async list(prefix) {
      const out: StoredObjectMeta[] = []
      let cursor: string | undefined
      do {
        const page = await bucket.list({ prefix, cursor })
        for (const obj of page.objects) out.push(toMeta(obj))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      return out
    },
  }
}
