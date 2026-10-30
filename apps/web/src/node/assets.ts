/**
 * The server's static handler for the SPA's build, in two halves:
 *
 * - **Files first.** A GET/HEAD for a path outside the app's own prefixes (`isApiPath`: `/api`,
 *   `/auth`, `/ws` and any plugin prefix) that names a file under the UI build is served
 *   straight from disk, before the app runs.
 * - **SPA fallback.** The app's catch-all (`api/index.ts`) asks `ASSETS.fetch` for anything else
 *   that is not an API path; a GET/HEAD gets `index.html` with 200 (client-side routes), anything
 *   else 404. API-shaped paths never reach it — they are a JSON 404 in the app.
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { MiddlewareHandler } from 'hono'
import { isApiPath } from '../api/utils/routes/api-prefixes'

export interface NodeAssets {
  /** Middleware: serve an existing file for a non-API GET/HEAD, else fall through. */
  files: MiddlewareHandler
  /** The `ASSETS` handler the app's catch-all calls: `index.html` for a navigation. */
  binding: { fetch(request: Request): Promise<Response> }
}

export function createNodeAssets(root: string): NodeAssets {
  const absolute = path.resolve(root)
  const indexPath = path.join(absolute, 'index.html')
  const statics = serveStatic({ root: absolute })
  const files: MiddlewareHandler = async (c, next) => {
    if ((c.req.method !== 'GET' && c.req.method !== 'HEAD') || isApiPath(c.req.path)) {
      return next()
    }
    return statics(c, next)
  }
  const binding = {
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Not Found', { status: 404 })
      }
      try {
        await stat(indexPath)
      } catch {
        return new Response('Not Found', { status: 404 })
      }
      const body = request.method === 'HEAD' ? null : await readFile(indexPath)
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // The shell names hashed assets; it must never be cached past a deploy.
          'cache-control': 'no-cache',
        },
      })
    },
  }
  return { files, binding }
}
