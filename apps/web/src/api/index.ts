/**
 * Hono app assembly. Middleware order is load-bearing — see
 * middleware/CLAUDE.md before reordering. `export { app }` only: the Node entry
 * (`src/node/server.ts`) serves it, the jobs worker (`src/node/jobs.ts`) drives `queue.ts` and
 * `scheduled.ts` beside it, and tests drive `app.request(path, init, env, ctx)` without starting
 * a server.
 */

import type { Hono, MiddlewareHandler } from 'hono'
import { serverPlugins } from '../plugins/server'
import { authMiddleware, globalAdminMiddleware } from './middleware/auth'
import { apiBodyLimit, isUnderPrefix, jsonBodyLimit } from './middleware/body-limit'
import { configMiddleware } from './middleware/config'
import { corsMiddleware } from './middleware/cors'
import { csrfProtection } from './middleware/csrf'
import { databaseMiddleware } from './middleware/database'
import { errorHandler, notFoundBody, notFoundHandler } from './middleware/error-handler'
import { platformMiddleware } from './middleware/platform'
import { mountPublicRoutes, publicBodyLimitOverrides } from './middleware/public-mounts'
import { publicSitesMiddleware } from './middleware/public-sites'
import { authRateLimit } from './middleware/rate-limit'
import { requestIdMiddleware, requestLogger } from './middleware/request-logger'
import { securityHeaders } from './middleware/security-headers'
import { tracerMiddleware } from './middleware/tracing'
import { accessRequestsRouter } from './routes/access-requests'
import { activityRouter } from './routes/activity'
import { adminRouter } from './routes/admin'
import { agentsRouter } from './routes/agents'
import { aguiRouter } from './routes/agui'
import { aiAgentModelsRouter } from './routes/ai-agent-models'
import { aiConfigRouter } from './routes/ai-config'
import { aiDocumentsRouter } from './routes/ai-documents'
import { aiPromptsRouter } from './routes/ai-prompts'
import { aiUsageRouter } from './routes/ai-usage'
import { authRouter } from './routes/auth/index'
import { chatRouter } from './routes/chat'
import { evalsRouter } from './routes/evals'
import { featuresRouter } from './routes/features'
import { feedbackRouter } from './routes/feedback'
import { filesRouter } from './routes/files'
import { groupsRouter } from './routes/groups'
import { guideRouter } from './routes/guide'
import { healthRouter } from './routes/health'
import { identityEventsRouter } from './routes/identity-events'
import { invitationsRouter } from './routes/invitations'
import { inviteRouter } from './routes/invite'
import { keysRouter } from './routes/keys'
import { mcpRouter } from './routes/mcp'
import { meRouter } from './routes/me'
import { membersRouter } from './routes/members'
import { notificationsRouter } from './routes/notifications'
import { tenantRouter } from './routes/tenant'
import { tenantsRouter } from './routes/tenants'
import { tracesRouter } from './routes/traces'
import { wsRouter } from './routes/ws'
import type { AppEnv } from './types'
import { isApiPath } from './utils/routes/api-prefixes'
import { createRouter } from './utils/routes/router'

const app = createRouter()

/** Every installed plugin's unauthenticated mounts — read twice below (body cap, then routes). */
const publicMounts = serverPlugins.flatMap(p => p.publicMounts ?? [])

// 1. Error envelope first so every later failure (including config validation) uses it.
app.onError(errorHandler)
app.notFound(notFoundHandler)

// 2–4. Request id + logger → validated config → the runtime's capabilities → security
//      headers (wraps everything below).
app.use('*', requestIdMiddleware, requestLogger)
app.use('*', configMiddleware)
app.use('*', platformMiddleware)
app.use('*', securityHeaders)

// 5. Reject oversized bodies before any parsing or DB work. The upload routes mount their own
//    (larger) limit, and a public mount's `bodyLimitBytes` replaces the 1 MB cap beneath its
//    prefix — see middleware/body-limit.ts.
app.use(
  '/api/*',
  apiBodyLimit(
    publicBodyLimitOverrides(publicMounts),
    serverPlugins.flatMap(p => p.uploadPaths ?? [])
  )
)
// A plugin may own a prefix outside `/api` (a protocol endpoint); it gets the JSON cap too.
for (const prefix of serverPlugins.flatMap(p => p.apiPrefixes ?? [])) {
  if (!isUnderPrefix(prefix, '/api')) app.use(`${prefix}/*`, jsonBodyLimit)
}
app.use('/auth/*', jsonBodyLimit)
app.use('/mcp', jsonBodyLimit)

// 6–7. CORS answers preflights before CSRF can reject them; CSRF is cookie-only, no DB.
app.use('*', corsMiddleware)
app.use('*', csrfProtection)

// 8. Per-request DB client — last of the globals because it is the first thing with real cost.
app.use('*', databaseMiddleware)

// 9. Public site hosts: on a host a plugin claims, its router answers everything, so none of the
//    mounts below is reachable there. Unconditional pass-through with no `publicSites` plugin.
app.use('*', publicSitesMiddleware(serverPlugins))

// 10. Per-request tracer: OTLP export when a backend is configured + the `ai_spans` store; flushed in
//    `waitUntil` after the handler. Streaming routes flush again before their stream closes.
app.use('/api/*', tracerMiddleware)

// 11. Mounts — auth is applied PER MOUNT so the public surface is enumerable: health, /auth/*,
//    /api/invite/:token (details; accept resolves the cookie itself), /api/identity/events
//    (signed by the OIDC issuer). `/api/admin/*` is the only tenant-free cross-tenant path
//    (globalAdminMiddleware); everything else is `authMiddleware`.
app.route('/api', healthRouter)
app.route('/auth', authRouter)
// The OIDC issuer's signed identity events; the signature is the authentication.
app.route('/api/identity', identityEventsRouter)
app.use('/api/invite/:token/accept', authRateLimit)
app.route('/api/invite', inviteRouter)
app.use('/api/admin/*', globalAdminMiddleware)
app.route('/api/admin', adminRouter)
// WebSocket upgrade resolves the cookie itself (no authMiddleware: browsers can't set headers here).
app.route('/ws', wsRouter)
// The remote MCP server and its protected-resource metadata: an OAuth access token from
// MCP_AUTHORIZATION_SERVER is the credential (`routes/mcp.ts`), never the cookie or an API key;
// 404 while that is unset. Before the authed table and every plugin mount, so `/mcp` is core's.
app.route('/', mcpRouter)
// A mount may carry a third element: a feature gate. `requireFeature('x')` 404s
// `feature_disabled` on every route beneath the prefix, so a surface that ships dark is dark as a
// WHOLE rather than route by route — declared once here, like auth, instead of remembered in each
// handler. Core ships no gated mount; an app adds `['/api/thing', thingRouter, requireFeature('thing')]`.
// Remember the other doors too: a surface with no nav entry (an analytics cube, a dashboard
// template, a CLI command) leaks independently of this one.
// A plugin's PUBLIC mounts — consent callbacks and webhooks a third party calls with no
// session. Only under `/api/hooks/<plugin id>` (the config test refuses anything else, and refuses
// an authed mount there), so this line is the whole of the plugin-owned unauthenticated surface.
// Before the authed table, which never claims `/api/hooks`, so order is belt and braces. Each is
// rate-limited per IP in its own bucket unless it opts out (`middleware/public-mounts.ts`).
mountPublicRoutes(app, publicMounts)
const mounts: readonly (readonly [string, Hono<AppEnv>, MiddlewareHandler?])[] = [
  ['/api/me', meRouter],
  ['/api/tenant', tenantRouter],
  ['/api/tenants', tenantsRouter],
  ['/api/members', membersRouter],
  ['/api/groups', groupsRouter],
  ['/api/features', featuresRouter],
  ['/api/invitations', invitationsRouter],
  ['/api/keys', keysRouter],
  ['/api/notifications', notificationsRouter],
  ['/api/activity', activityRouter],
  ['/api/access-requests', accessRequestsRouter],
  ['/api/files', filesRouter],
  ['/api/ai/config', aiConfigRouter],
  ['/api/ai/prompts', aiPromptsRouter],
  ['/api/ai/usage', aiUsageRouter],
  ['/api/ai/agent-models', aiAgentModelsRouter],
  ['/api/ai/documents', aiDocumentsRouter],
  ['/api/chat', chatRouter],
  // A protocol surface with its own auth story, mounted beside chat rather than under it: this
  // list is the enumerable auth surface.
  ['/api/agui', aguiRouter],
  ['/api/agents', agentsRouter],
  // The local AI trace store, read by `rocketpod traces` — admin+ (`read Trace`).
  ['/api/traces', tracesRouter],
  // Thumbs on AI answers (member create; admin+ read) and the eval-case export (admin+).
  ['/api/feedback', feedbackRouter],
  ['/api/evals', evalsRouter],
  // The Guide: the in-app user guide and Ask the Guide — every member, global static content.
  ['/api/guide', guideRouter],
  // Installed plugins, last, so a plugin can never shadow a core prefix — Hono matches in
  // registration order. Each mount gets `authMiddleware` and its own optional gate exactly like a
  // core mount; the convention is `/api/<plugin id>`, and `tests/config/plugins.test.ts` is what
  // keeps two plugins from claiming the same one.
  ...serverPlugins.flatMap(p => p.mounts ?? []),
]
for (const [prefix, router, gate] of mounts) {
  app.use(prefix, authMiddleware)
  app.use(`${prefix}/*`, authMiddleware)
  // After auth, never before: the gate reads `auth.features`, which `authMiddleware` sets.
  if (gate) {
    app.use(prefix, gate)
    app.use(`${prefix}/*`, gate)
  }
  app.route(prefix, router)
}

// 12. SPA via the Node assets layer (`src/node/assets.ts`). The hashed bundles (`/assets/*`, and
//     `/site-assets/*` for public sites) are served from disk before the app runs; every other
//     path reaches here. `ASSETS.fetch` answers a file of the UI build that exists and 404s
//     anything else, and the shell is fetched here for a browser navigation only, so a missing
//     `/assets/*`, `/site-assets/*` or root file is a 404 rather than `index.html`. An API-shaped
//     path must 404 as JSON.
app.all('*', async c => {
  const { pathname } = new URL(c.req.url)
  if (isApiPath(pathname)) return c.json(notFoundBody(pathname), 404)
  // No `ASSETS` handler (Vite serves the UI in dev, or a bare `app.request` in tests).
  if (!c.env.ASSETS) return c.text('Not Found', 404)
  const res = await c.env.ASSETS.fetch(c.req.raw)
  if (res.status !== 404 || !isShellNavigation(c.req.raw, pathname)) return res
  // A fresh request for `/` with the navigation's method and headers (the Node request object
  // answered 500 when passed as the init).
  const shell = new Request(new URL('/', c.req.url), {
    method: c.req.method,
    headers: c.req.raw.headers,
  })
  return c.env.ASSETS.fetch(shell)
})

/** A browser navigating to a client route, not a request for a file that does not exist. */
function isShellNavigation(req: Request, pathname: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const navigating =
    req.headers.get('Sec-Fetch-Mode') === 'navigate' ||
    (req.headers.get('Accept') ?? '').includes('text/html')
  // The bundles are hashed files, and a root-level name with a dot is `/robots.txt`, not a route.
  return (
    navigating && !/^\/(site-)?assets(\/|$)/.test(pathname) && !/^\/[^/]*\.[^/]*$/.test(pathname)
  )
}

export { app }
