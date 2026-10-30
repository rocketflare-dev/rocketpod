/**
 * The path prefixes the server owns, in ONE place, because two things read them.
 *
 * 1. The SPA catch-all in `api/index.ts`: an unmatched path under one of these is a JSON 404,
 *    never `index.html`.
 * 2. The Node server's static layer (`src/node/assets.ts`): a GET under one of these goes to the
 *    app, never to a file or the SPA shell — so an `<object>`/`<iframe>` embed or an `<a download>`
 *    of an API route is never silently answered with the app shell.
 *
 * `/ws` is the realtime upgrade. The analytics plugin adds `/cubejs-api` and `/mcp`.
 * A plugin may own a prefix OUTSIDE `/api` — a protocol endpoint, say — and those are
 * unioned in from the server barrel, so both readers follow an install with no edit.
 */
import { serverPlugins } from '../../../plugins/server'

const CORE_API_PREFIXES = ['/api', '/auth', '/ws'] as const

export const API_PREFIXES: readonly string[] = [
  ...CORE_API_PREFIXES,
  ...serverPlugins.flatMap(p => p.apiPrefixes ?? []),
]

export function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`))
}
