/**
 * The server's static handler for the SPA's build, in two halves:
 *
 * - **Bundles first.** A GET/HEAD under `/assets/` (the admin UI's hashed bundles) or
 *   `/site-assets/` (a public site's own scripts and styles) that names a file under the UI build
 *   is served straight from disk, before the app runs, on every host. Nothing else is: a root file
 *   (`/robots.txt`, `/favicon.svg`) goes through the app, so on a public site host the plugin's
 *   router answers it (`api/middleware/public-sites.ts`) and the app's files never leak there.
 * - **Files and the shell.** The app's catch-all (`api/index.ts`) asks `ASSETS.fetch` for anything
 *   else that is not an API path. It answers a file of the build that exists and 404s anything
 *   else; the catch-all then fetches `/` (`index.html`) for a browser navigation only, so a client
 *   route gets the shell and a missing file stays a 404. API-shaped paths never reach it.
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { MiddlewareHandler } from 'hono'
import { isApiPath } from '../api/utils/routes/api-prefixes'

export interface NodeAssets {
  /** Middleware: serve an existing bundle file for a GET/HEAD, else fall through. */
  files: MiddlewareHandler
  /** The `ASSETS` handler the app's catch-all calls: a file of the build, or a 404. */
  binding: { fetch(request: Request): Promise<Response> }
}

/** The hashed bundles, served before the app on every host. */
const BUNDLE_PATH = /^\/(?:site-)?assets\//

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

export function createNodeAssets(root: string): NodeAssets {
  const absolute = path.resolve(root)
  const statics = serveStatic({ root: absolute })
  const files: MiddlewareHandler = async (c, next) => {
    if (
      (c.req.method !== 'GET' && c.req.method !== 'HEAD') ||
      !BUNDLE_PATH.test(c.req.path) ||
      isApiPath(c.req.path)
    ) {
      return next()
    }
    return statics(c, next)
  }

  /** The file a pathname names under the build, or null — never a path outside it. */
  async function fileFor(pathname: string): Promise<string | null> {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return null
    }
    if (decoded.includes('\0')) return null
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
    const file = path.resolve(absolute, relative)
    if (file !== absolute && !file.startsWith(`${absolute}${path.sep}`)) return null
    try {
      return (await stat(file)).isFile() ? file : null
    } catch {
      return null
    }
  }

  const binding = {
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Not Found', { status: 404 })
      }
      const file = await fileFor(new URL(request.url).pathname)
      if (!file) return new Response('Not Found', { status: 404 })
      const body = request.method === 'HEAD' ? null : await readFile(file)
      const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': type,
          // The shell names hashed assets; it must never be cached past a deploy, and a root
          // file has no hash to bust a cache with either.
          'cache-control': 'no-cache',
        },
      })
    },
  }
  return { files, binding }
}
