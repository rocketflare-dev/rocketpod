/**
 * The path prefixes the server owns, in ONE place, because two things read them.
 *
 * 1. The SPA catch-all in `api/index.ts`: an unmatched path under one of these is a JSON 404,
 *    never `index.html`.
 * 2. The Node server's static layer (`src/node/assets.ts`): a GET under one of these goes to the
 *    app, never to a file or the SPA shell — so an `<object>`/`<iframe>` embed or an `<a download>`
 *    of an API route is never silently answered with the app shell.
 *
 * `/ws` is the realtime upgrade; `/mcp` is the MCP server; `/oauth` and the three OAuth discovery
 * documents are its authorization server (the consent PAGE is the SPA's `/consent`, outside them).
 * The analytics plugin adds `/cubejs-api`.
 * A plugin may own a prefix OUTSIDE `/api` — a protocol endpoint, say — and those are
 * unioned in from the server barrel, so both readers follow an install with no edit.
 */
import { serverPlugins } from '../../../plugins/server'

const CORE_API_PREFIXES = [
  '/api',
  '/auth',
  '/ws',
  '/mcp',
  '/oauth',
  // The OAuth discovery documents (the rest of `/.well-known` stays the asset layer's).
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
] as const

/**
 * Paths core owns that no plugin may claim — as a mount, an `apiPrefixes` entry or a public
 * mount: the MCP server, its authorization server, and the OAuth discovery documents. A plugin
 * there would shadow the server or answer for its identity.
 */
export const RESERVED_PLUGIN_PATHS = ['/mcp', '/oauth', '/.well-known/oauth-'] as const

/** Does `path` fall on a reserved path (`/mcp`, `/mcp/…`, `/oauth/…`, `/.well-known/oauth-…`)? */
export function isReservedPath(path: string): boolean {
  const p = path.toLowerCase()
  return (
    p === '/mcp' ||
    p.startsWith('/mcp/') ||
    p === '/oauth' ||
    p.startsWith('/oauth/') ||
    p.startsWith('/.well-known/oauth-') ||
    p === '/.well-known/openid-configuration'
  )
}

interface PluginPaths {
  shared: { id: string }
  mounts?: readonly (readonly [string, ...unknown[]])[]
  apiPrefixes?: readonly string[]
  publicMounts?: readonly (readonly [string, ...unknown[]])[]
}

/** Throw, naming the plugin and the path, when any installed plugin claims a reserved path. */
export function assertNoReservedPluginPaths(plugins: readonly PluginPaths[]): void {
  for (const plugin of plugins) {
    const claimed = [
      ...(plugin.mounts ?? []).map(m => m[0]),
      ...(plugin.apiPrefixes ?? []),
      ...(plugin.publicMounts ?? []).map(m => m[0]),
    ]
    const reserved = claimed.find(isReservedPath)
    if (reserved) {
      throw new Error(
        `plugin "${plugin.shared.id}" claims ${reserved}, which core reserves for the MCP server ` +
          'and its authorization server — move it under /api/<plugin id>'
      )
    }
  }
}

export const API_PREFIXES: readonly string[] = [
  ...new Set([...CORE_API_PREFIXES, ...serverPlugins.flatMap(p => p.apiPrefixes ?? [])]),
]

export function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`))
}
