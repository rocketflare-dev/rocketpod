/**
 * Request body caps. 1 MB of JSON is plenty for every route and protects the DB/LLM paths. The
 * Node server (`@hono/node-server`) sets no body limit of its own, so these caps are the only ones.
 * **No core route takes a multipart file**: uploads go through `/api/uploads` (`services/uploads`),
 * straight to the object store when `STORAGE_DIRECT_UPLOADS` is on. Off, the file comes to the
 * server's own `PUT /api/upload-content/:id`, capped at the largest target's `maxBytes` within
 * `MAX_SERVER_UPLOAD_BYTES` (`serverUpload`); the route streams the body to the store and holds
 * it to the exact declared length.
 *
 * A plugin's public mount may declare its own `bodyLimitBytes` (≤ `MAX_PUBLIC_MOUNT_BODY_BYTES`),
 * which REPLACES the 1 MB cap beneath its prefix.
 *
 * **Deprecated plugin seam, kept so an installed plugin's upload route keeps working** until it
 * moves to `uploadTargets`: beneath a plugin's `uploadPaths` a NON-JSON body gets
 * `MAX_UPLOAD_PATH_BODY_BYTES` (10 MB + 64 KB multipart overhead) and a JSON body keeps 1 MB; a
 * plugin's `uploadLimits` names EXACT paths whose non-JSON body may go higher, up to
 * `MAX_PLUGIN_UPLOAD_LIMIT_BYTES` (50 MiB) plus overhead — checked first, for that path alone.
 *
 * Hono's `bodyLimit` counts bytes whatever the content type, so a cap covers JSON, form-encoded
 * and `application/scim+json` alike. Over-limit → 413 in the shared envelope.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

export const MAX_JSON_BODY_BYTES = 1024 * 1024

/** Multipart boundaries + part headers, for a plugin's deprecated multipart upload route. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024

/**
 * The most a public mount may ask for: a SCIM bulk request or a signed SAML POST, not a file.
 * Also the largest file a plugin's deprecated `uploadPaths` route may take.
 */
export const MAX_PUBLIC_MOUNT_BODY_BYTES = 10 * 1024 * 1024

const tooLarge = (c: Context) =>
  c.json({ error: 'Request body too large', statusCode: 413, code: 'payload_too_large' }, 413)

export const jsonBodyLimit = bodyLimit({ maxSize: MAX_JSON_BODY_BYTES, onError: tooLarge })

/**
 * @deprecated with `ServerPlugin.uploadPaths`: what a non-JSON body beneath a plugin's upload
 * prefix may carry before its route sees it. The route's own limit is the real one.
 */
export const MAX_UPLOAD_PATH_BODY_BYTES = MAX_PUBLIC_MOUNT_BODY_BYTES + MULTIPART_OVERHEAD_BYTES

/**
 * The most an exact plugin upload path (`ServerPlugin.uploadLimits`, deprecated) may ask for: a
 * 25 MiB mail attachment and the `.eml` built from it (~34 MiB) fit. A route that buffers the body
 * holds it in the Node process's memory, and the ingress in front has its own cap (ingress-nginx's
 * `proxy-body-size`, `docs/DEPLOY.md`). Values above it are clamped, and
 * `tests/config/plugins.test.ts` refuses them. Also the most the server's own upload URL takes
 * (`MAX_SERVER_UPLOAD_BYTES`, `services/uploads/service.ts`): the same ingress sits in front of it.
 */
export const MAX_PLUGIN_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024

/** One exact path with its own non-JSON cap — a plugin's (deprecated) `uploadLimits` entry. */
export interface UploadLimit {
  path: string
  maxBytes: number
}

/** `uploadLimits` records from every plugin, as the list `apiBodyLimit` takes. */
export function pluginUploadLimits(
  plugins: readonly { uploadLimits?: Readonly<Record<string, number>> }[]
): UploadLimit[] {
  return plugins.flatMap(p =>
    Object.entries(p.uploadLimits ?? {}).map(([path, maxBytes]) => ({ path, maxBytes }))
  )
}

/** `application/json`, `application/<x>+json` — a body a JSON route parses. */
function isJsonBody(c: Context): boolean {
  const type = (c.req.header('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json'))
}

/** `pathname` is `prefix` or beneath it — `/api/hooks/a` never claims `/api/hooks/ab`. */
export function isUnderPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** A prefix that replaces the JSON cap with its own — a public mount's `bodyLimitBytes`. */
export interface BodyLimitOverride {
  prefix: string
  maxBytes: number
}

/** The server's own upload URL (`STORAGE_DIRECT_UPLOADS` off): its prefix and the largest body. */
export interface ServerUploadLimit {
  prefix: string
  maxBytes: number
}

export interface ApiBodyLimitOptions {
  overrides?: readonly BodyLimitOverride[]
  serverUpload?: ServerUploadLimit
  /** @deprecated — `ServerPlugin.uploadPaths`. */
  pluginUploadPaths?: readonly string[]
  /** @deprecated — `ServerPlugin.uploadLimits`. */
  uploadLimits?: readonly UploadLimit[]
}

/**
 * The `/api/*` body cap (middleware step 5), first match wins: an exact `uploadLimits` path (its
 * cap for a non-JSON body, clamped); beneath a plugin's `uploadPaths`,
 * `MAX_UPLOAD_PATH_BODY_BYTES` for a non-JSON body; beneath the server's upload prefix, its cap
 * (whatever the content type: the body is the file); beneath an override prefix, its own cap — the longest matching prefix wins,
 * clamped to `MAX_PUBLIC_MOUNT_BODY_BYTES`; everything else (and every JSON body) `jsonBodyLimit`.
 */
export function apiBodyLimit(options: ApiBodyLimitOptions = {}): MiddlewareHandler {
  const { overrides = [], serverUpload, pluginUploadPaths = [], uploadLimits = [] } = options
  const exact = new Map(
    uploadLimits.map(u => [
      u.path,
      bodyLimit({
        maxSize:
          Math.min(Math.max(0, u.maxBytes), MAX_PLUGIN_UPLOAD_LIMIT_BYTES) +
          MULTIPART_OVERHEAD_BYTES,
        onError: tooLarge,
      }),
    ])
  )
  const uploadPathLimit = bodyLimit({ maxSize: MAX_UPLOAD_PATH_BODY_BYTES, onError: tooLarge })
  const serverUploadLimit = serverUpload
    ? bodyLimit({ maxSize: Math.max(0, serverUpload.maxBytes), onError: tooLarge })
    : null
  const limits = [...overrides]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .map(o => ({
      prefix: o.prefix,
      limit: bodyLimit({
        maxSize: Math.min(Math.max(0, o.maxBytes), MAX_PUBLIC_MOUNT_BODY_BYTES),
        onError: tooLarge,
      }),
    }))
  return (c, next) => {
    const path = c.req.path
    const sized = exact.get(path)
    if (sized) return (isJsonBody(c) ? jsonBodyLimit : sized)(c, next)
    if (pluginUploadPaths.some(p => isUnderPrefix(path, p))) {
      return (isJsonBody(c) ? jsonBodyLimit : uploadPathLimit)(c, next)
    }
    if (serverUpload && serverUploadLimit && isUnderPrefix(path, serverUpload.prefix)) {
      return serverUploadLimit(c, next)
    }
    const own = limits.find(l => isUnderPrefix(path, l.prefix))
    return (own?.limit ?? jsonBodyLimit)(c, next)
  }
}
