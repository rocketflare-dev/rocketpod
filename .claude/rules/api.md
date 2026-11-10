---
paths:
  - apps/web/src/api/**
  - apps/web/src/node/**
  - apps/web/src/config.ts
  - packages/shared/src/**
---

# API Patterns

Hono app assembled in `apps/web/src/api/index.ts` (exports `app` only). `apps/web/src/node/server.ts`
is the entry (`.claude/rules/runtime.md`): it builds the `Platform`, serves `app.fetch` and runs the
worker loops. Keeping the entry out of `api/index.ts` is what lets tests drive
`app.request(req, env, ctx)` with an in-memory platform.

## Read the nested doc before you touch…

- a middleware, the mount order, a body/CSP rule → `apps/web/src/api/middleware/CLAUDE.md`; a route
  file or an endpoint's codes → `apps/web/src/api/routes/CLAUDE.md`
- a service, realtime, visibility, feature flags, the Guide → `apps/web/src/api/services/CLAUDE.md`
- a model call, chat, a streaming route, ingest, retrieval → `apps/web/src/api/services/ai/CLAUDE.md`
- agent runs, tools, interrupts, decisions → `apps/web/src/api/services/agents/CLAUDE.md`; the
  durable run body → `apps/web/src/api/workflows/CLAUDE.md`; a job type or handler →
  `apps/web/src/api/queues/CLAUDE.md`
- anything a plugin contributes, or the analytics plugin → `apps/web/src/plugins/CLAUDE.md`
- the platform, the Node entry, cron, shutdown → `.claude/rules/runtime.md`

## Middleware order (do not reorder casually — each step needs what the earlier ones set)

1. `app.onError(errorHandler)` / `app.notFound` — every later failure, config validation included,
   gets the JSON envelope
2. `requestIdMiddleware` + `requestLogger` (hono-pino) — a request id for everything after
3. `configMiddleware` — `loadConfig(c.env)`; everything below reads `c.get('config')`, **never
   `c.env` for config**; then `platformMiddleware` — `c.get('platform')`
4. `securityHeaders` — **returns a 101 untouched**; the `embeddable` opt-in is for a route that has
   PROVED the content type, never a path allowlist
5. `apiBodyLimit` (1 MB) on `/api/*`, `jsonBodyLimit` on `/auth/*` and each plugin `apiPrefixes`
   entry outside `/api` — skipped for `UPLOAD_PATHS`, which cap per route; a plugin public mount's
   `bodyLimitBytes` replaces it beneath its prefix
6. `cors` (before CSRF so preflights are answered; **bypassed for `Upgrade: websocket`**) → `csrf`
   (cookie-only, no DB)
7. `databaseMiddleware` — one client per request from `openDatabase(config)` (a view of the Node
   process pool), closed via `deferOrAwait`
8. `tracerMiddleware` on `/api/*` — the request's span recorder, flushed after the handler
9. Mounts, in order: `/api/health|ready` → `/auth` (rate-limited login routes) → `/api/identity`
   (signed events, no session) → `/api/invite` → `/api/admin/*` behind `globalAdminMiddleware` →
   `/ws` (no `authMiddleware`; the route resolves the cookie) → plugin `publicMounts` under
   `/api/hooks/<id>` (no auth, per-IP rate limit) → the mount table, each entry with
   `authMiddleware` → **plugin authed mounts, last** (Hono matches in registration order, so a plugin
   can never shadow a kit prefix)
10. `app.all('*')` `ASSETS` catch-all (`src/node/assets.ts`: `dist/ui`, `index.html` for a
    navigation), with a JSON 404 for `/api|/auth|/ws` and every `API_PREFIXES` entry (an
    unauthenticated `/cubejs-api/*` is a 401 envelope, never `index.html` —
    `tests/api/health.test.ts`)

**Auth is per mount, not global**: the public surface stays enumerable and small. A new authed
router is a `['/api/x', xRouter]` entry in the mount table — never auth inside a route file.

## Routes are thin

- `createRouter()` (`utils/routes/router.ts`) — never `new Hono()` bare; no `declare module 'hono'`
- Validate with `validate('json'|'query'|'param', schema)` (`utils/routes/validate.ts`) over a
  schema from `@rocketpod/shared/<module>` — never `zValidator` directly; a bad input is the shared
  400
- `const { db, tenantId, user, cfg, logger, defer, realtime, tracer } = withAuthAndDb(c)` is the
  **only** way to read auth in a route (`withAuth(c)` is the tenant-free variant). Never
  `c.get('auth'|'session'|'db'|'tracer')` by hand. Runtime capabilities a service needs come from
  `c.get('platform')` (`src/platform/types.ts`: `jobs`, `storage`, `runs`, `realtime`, `locks`,
  `converter`…) and are passed from the route as arguments — never `c.env.<BINDING>`;
  `tests/config/platform-seam.test.ts` fails any Cloudflare type or binding read
- Authorise with `guardPermission(c, action, subject)` (`middleware/permissions.ts`; `can(c, …)` to
  branch). Owner-only actions use `guardOwner(c)` / `isOwnerLevel(auth)` — an explicit
  `role === 'owner'`, never `manage Tenant`
- Throw typed errors from `utils/core/errors.ts`; never `c.json({ error }, 4xx)` by hand. The
  envelope is `{ error, statusCode, code?, details? }`, owned by `middleware/error-handler.ts`
- Lists: `paginationQuerySchema` → `{ items, pagination: { page, pageSize, total, totalPages } }`
  (`@rocketpod/shared/pagination`); success bodies are bare domain objects
- `TENANCY_MODE=single`: multi-tenant-only routes (`create-org`, `delete-org`, `/select-tenant`,
  `/admin/tenants` list) call `requireMultiTenant` → 404 `tenancy_mode_single`; don't inline it
- `uuidParam(c, 'id')` for a `:id` — a non-UUID is a 404, never a DB error
- **Feature flags gate at the MOUNT, and never through CASL.** `requireFeature('x')` is the optional
  third element of a mount entry (`['/api/thing', thingRouter, requireFeature('thing')]`) → **404
  `feature_disabled`** (a 403 confirms it exists), so a surface that ships dark is dark as a whole.
  Never `access Feature:x` — a global admin's `manage all` satisfies it. **The nav is not the only
  door**: a surface with no nav entry, and above all a hook that CREATES rows, gates on `features`
  itself

## Tenancy and visibility

- Every domain query filters by `tenantId` from the auth context — never from the body or query
  (`.claude/rules/database.md`)
- **Row VISIBILITY is a predicate too.** `accessScopeOf(auth)` → `visibleDocuments(scope)` (or a
  resource's registry predicate) is **ANDed with the tenant predicate and never replaces it**, and a
  hidden row answers the SAME 404 as an absent one. Never a CASL condition; never a new
  `if (kind === …)` branch — a restrictable resource is a `visibilityResources()` entry
  (drizzle gotchas: `apps/web/src/api/services/CLAUDE.md`)

## Contracts live in `packages/shared` (`@rocketpod/shared`)

A new or changed API surface starts as a zod schema in `packages/shared/src/<module>.ts`, exported
from `index.ts`, imported as `@rocketpod/shared/<module>` by the route (`validate()`), the UI
(`api.get(..., { schema })`) and the CLI (`apps/cli/src/api.ts`): schema → route → CLI command.
Response shapes, request bodies, query params, the error envelope and pagination all come from
there; never define a response type in a route file. `packages/shared` is **private** (`"private":
true`, no `publishConfig`) and imports only `zod`, its siblings and type-only `@casl/ability` —
never `apps/web` or `apps/cli`.

## Streaming routes

Streams speak AG-UI through `services/ai/chat-turn.ts` (write: chat) or
`services/agents/run-stream.ts` (read: a run's tail) — rules in those directories' CLAUDE.md. Two
hold for any stream: everything that can fail (resolve, authorise, validate, writes) happens as JSON
**before** the first frame; inside the stream use `streamDatabase(c)` for every write, await it and
the tracer flush, and close it in `finally` — the request's `db` closes in deferred work once the
Response is returned, and there is no `defer` after it. **Never `streamSSE`.**

## Background work: a route enqueues, never runs

| Work | Use |
|---|---|
| fire-and-forget, < 30 s | `platform.jobs` (pg-boss) via `enqueueJob` / `enqueueJobs` (`services/jobs.ts`) |
| multi-step, retries, minutes+ | `platform.runs` (OpenWorkflow) via `enqueueRun` — never an agent's `run()` |
| periodic | pg-boss schedules → `SCHEDULED_TASKS` (`api/scheduled.ts`) |

- Cron: `SCHEDULED_TASKS` dispatches on `event.cron`; each task try/caught, one DB client per run.
  `0 4 * * *` → `pruneExpired`, plus every installed plugin's `scheduledTasks`. The worker schedules
  every registered expression at start (UTC) and drops stale ones — the registry is the only
  declaration
- Missing jobs queue → `JobsQueueNotConfiguredError`, never a silent inline fallback. The
  **magic-link email stays inline** — a person is waiting on it
- Side effects that can outlive the response (email, activity, tracing flush, realtime nudge) go
  through `c.executionCtx.waitUntil` — `defer()` from `withAuth` in a route — never awaited inline
  and never dropped. On Node that is the tracked defer set (`src/node/defer.ts`), drained on
  SIGTERM. Concurrency is a DB claim row or a lock, never a `Map`

## Realtime, AI, services and config

- Routes never touch the realtime hub: `services/realtime.ts` is the **only** caller. A route hands
  `realtime` to the service, which nudges **after** the transaction commits — "DB is the truth,
  WebSocket is a nudge"
- Feature code never imports an AI SDK, reads `ai_configs` / `agent_models` or decrypts a key —
  `services/ai/resolve.ts` is the only seam; 503 `ai_not_configured` is thrown before any row is
  written or any stream opens. **Never log or return a credential** (`hasCredential`,
  `redactSecrets`). A prompt is a `CORE_PROMPT_REGISTRY` entry, never a string in a route
- Services are plain modules `(db, cfg, logger, …args)` — dependencies are passed, never read from
  `c.env`, `process.env` or a module-level `config`; a runtime capability is a parameter typed from
  the neutral `Platform` (`apps/web/src/api/services/CLAUDE.md`)
- `apps/web/src/config.ts`: one zod schema over the runtime env, `loadConfig(env)` memoised per env
  object — the Node entry builds that object once from `process.env`, tests pass their own.
  `APP_ENV` (`development | staging | production`) is the environment discriminator — `NODE_ENV`
  exists only in test scripts. **`process.env` is read only in `src/config.ts` and `src/node/`**
  (`platform-seam.test.ts`); everything else reads `c.get('config')` or the `cfg` it is handed, so
  tests can drive any configuration without touching the process
- **Module-evaluation order is the trap the type system cannot see.** `queues/jobs.ts`,
  `services/agents/registry.ts`, `services/prompts.ts`, `scheduled.ts`,
  `utils/routes/api-prefixes.ts` and `services/access.ts` read the plugin barrel at module scope; a
  cycle through one leaves one side `undefined` — a crash at import, not a compile error. So a
  registry a plugin's code imports back is a FUNCTION, not a const (`visibilityResources()`), and a
  value a plugin needs moves to a leaf (`services/access-sql.ts`) and is re-exported. `@/plugins/api`
  itself reaches the barrel only through the modules `tests/config/plugin-api-load-order.test.ts`
  allows, after `http.ts` and `ai.ts` — or a second plugin evaluates mid-cycle and finds
  `createRouter` undefined (why the pure RRF helpers live in `services/ai/fusion.ts`)

## Runtime APIs

The app runs on Node, but `src/api/**` stays runtime-neutral: `process`, `node:fs`, `node:http`,
`ws`, `pg-boss` and the other server modules belong in `src/node/` and reach the app through the
`Platform` (`platform-seam.test.ts` fails a stray one). `AsyncLocalStorage`, `node:crypto` and
`Buffer` are fine anywhere; prefer WebCrypto/`TextEncoder` in shared code — see
`.claude/rules/runtime.md`.
