# Services

Plain modules; routes validate → authorise → call a service → respond. AI lives in `ai/`
(`ai/CLAUDE.md`), agent runs in `agents/` (`agents/CLAUDE.md`).

## Shape

- Signature `(db, cfg, logger, …args)` — dependencies are passed, never imported as process
  globals. No service reads `c.env`, `process.env` or a module-level `config`
- A runtime capability (jobs, storage, runs, realtime) is a parameter typed from the neutral
  `Platform` (`src/platform/types.ts`), never an adapter type. A service that **queues** takes it
  after the logger — `createInvitation(db, cfg, logger, jobs, input)`, `decideAccessRequest(db, cfg,
  logger, jobs, input)` (`jobs: JobsQueue`, a structural slice so tests pass a `RecordingQueue`). A
  service that **nudges** takes `realtime?: Realtime` trailing (`updateTenant(db, tenantId, patch,
  realtime?)`, `notify(db, input, realtime?)`) or inside its `input` (`changeMemberRole`,
  `removeMember`, `acceptInvitation`)
- Storage routes read the seam from the platform: `c.get('platform').storage` → `StorageService`,
  503 `storage_not_configured` when it is null
- The only paths to a capability: `jobs.ts` (`enqueueJob`) → `platform.jobs` (pg-boss),
  `realtime.ts` (`nudge*`) → `platform.realtime`, `ai/resolve.ts` → `ai_configs` / `agent_models`,
  `agents/runs.ts` → `platform.runs` (OpenWorkflow). Job handlers are in `../queues/` (the pg-boss
  worker is `src/node/jobs.ts`), the hub in `src/node/realtime.ts`, the run body in
  `../workflows/agent-run-body.ts`
- **Deleting a tenant**: `deleteTenant` proves the jobs queue (`requireJobsQueue`) BEFORE the
  `DELETE` — a deployment that cannot purge must fail while the tenant still exists — then enqueues
  `tenant.purge` with the id and slug (`../queues/CLAUDE.md`)
- `utils/db/tenant-helpers.ts` `onTenantCreated` is post-commit: core contributes none, so it is
  every installed plugin's hook, each best-effort in its own try/catch and handed the deployment's
  `features` (a hook that CREATES rows is the sharpest feature door there is — the analytics
  plugin's dashboard templates are the worked example)

## Streaming a stored object (`GET /api/files/:id`)

**A route that streams a stored object serves HTTP ranges itself**: `parseByteRange`
(`utils/routes/byte-range.ts` — ONE range, `a-b` / `a-` / `-n`; anything else is ignored and the
whole object is a 200) → `storage.get(key, { range })` → 206 with `Content-Range` from the store's
`range`, `Accept-Ranges: bytes` on every answer, and `StorageRangeNotSatisfiableError` → 416
`range_not_satisfiable` with `Content-Range: bytes */<total>` (set with `c.header` before throwing —
the error handler keeps it). A ranged request never answers 304. The body is the store's stream,
never buffered; there is no compression middleware, and none may be added in front of such a route.

## Realtime (`realtime.ts`)

- Routes never touch the hub: this module is the **only** caller — `nudge(realtime, event)`
  (tenant-wide), `nudgeUser(realtime, userId, event)`, `nudgeUsers(realtime, userIds, event)`,
  `nudgeTopic(realtime, topic, event)` — over the platform's `Broadcaster`
  (`c.get('platform').realtime`, `src/node/realtime.ts`: a `pg_notify` publish every pod's listener
  delivers to its local sockets; `{ delivered }` is always 0)
- `nudgeTopic` reaches only the sockets SUBSCRIBED to a registered topic — `tenantTopic(prefix,
  tenantId, id)`, `@rocketpod/shared/realtime` § Topics; the kinds are `CORE_REALTIME_TOPICS` + each
  plugin's `SharedPlugin.realtimeTopics`, and the hub admits a subscriber only through
  `canSubscribeTopic`: `read` on the kind's subject in the topic's own tenant, a global admin for a
  `platform` topic
- `realtime` is the `Realtime` (`{ defer, hub }`) returned by `withAuth()`; every nudge goes through
  `defer` / `waitUntil`, is never awaited on the response path and is a no-op without a hub. In a
  durable-run step there is no `waitUntil`: use `createStepRealtime()` and await `.settle()`
- Build events with `realtimeEvent(type, tenantId, payload?)`. Types and the query-key invalidation
  map (`REALTIME_INVALIDATIONS`) live in `@rocketpod/shared/realtime` — add a type there, never in a
  route. The payload is a nudge (`{ id }`, or `{ entity, id }` for `entity.changed`); the client
  re-queries. "DB is the truth, WebSocket is a nudge."
- Emit **after** the transaction commits (`acceptInvitation` defers its two nudges past the
  `db.transaction`)

## Visibility (`access.ts`)

- `accessScopeOf(auth)` → `{ tenantId, userId, groupIds, bypass }` (`bypass` = `isAdminLevel`).
  `visibleDocuments(scope)` (or a resource's registry predicate) is **ANDed with the tenant
  predicate and never replaces it**; a hidden row is the SAME 404 as an absent one. Never express it
  as a CASL condition — the kit uses none, and "own" has always been the route's own check.
  `fullAccessScope(tenantId)` is for maintenance paths only
- A restrictable resource is a `VisibilityResource` (`{ key, noun, usageKey, predicate, setGroups,
  grantRows, countGrants }`): `CORE_VISIBILITY_RESOURCES` (documents) plus each installed plugin's
  `ServerPlugin.visibilityResources`, composed by the `visibilityResources()` FUNCTION.
  `setResourceGroups` / `grantsForResources` / `countGroupGrants` dispatch through it — never an
  `if (kind === …)` branch. The 409 `group_in_use` count includes every one
- Drizzle: the EXISTS subquery uses a LITERAL alias (a column object renders with whatever table
  alias is in scope where the fragment lands), and a raw predicate cannot go into
  `db.query.X.findFirst` (it renames the table it selects from) — use `db.select()`
- A value a plugin needs at module scope lives in the leaf `access-sql.ts` and is re-exported here
  so no core importer moves, or the plugin barrel cycle leaves it `undefined` at import

## Feature flags (`features.ts`, `../../permissions/features.ts`, `../middleware/feature.ts`)

- **One seam**: `resolveFeatures(cfg, flagRows, { tenantId, userId })` is the only place the two
  layers combine — `FEATURES_ENABLED` in the environment (does this deployment ship it at all?
  fail-closed, consulted only for an `environmentGated` flag) and the `feature_flags` /
  `tenant_feature_overrides` rollout state. A third source unions in there and no consumer changes.
  It returns `[]` without a tenant
- **Keys are code**: `CORE_FEATURES` in `@rocketpod/shared/permissions` + metadata in
  `CORE_FEATURE_FLAGS` (`@rocketpod/shared/features`), the `CORE_PROMPT_REGISTRY` pattern. No
  migration to add one; evaluation iterates the registry, so an orphaned row is inert. There is no
  create endpoint by design
- **`featureBucket` is a wire format** — changing the hash, separator or modulus reshuffles every
  live rollout. Golden vectors in `tests/config/features.test.ts` are the guard. The percentage is
  never hashed in, which is what makes a rollout monotonic (raising it only ever adds)
- `requireFeature` reads `auth.features`, the same array a plugin's own registries read; an ability
  check would hand every global admin the dark surface, because `manage all` covers `access` on
  every `Feature:` subject
- Admin CRUD lives on `routes/admin.ts` behind `globalAdminMiddleware`; the override sub-routes call
  `requireMultiTenant`, the list and `PATCH` do not. `GET /api/features` is the member-level
  effective list (and the CLI's, since a Bearer key cannot reach `/api/admin/*`)

## The Guide (`guide-*.ts`, `docs/CONCEPTS.md` §18)

- **A GLOBAL corpus, reached by one tool.** `guide_chunks` has no tenant column; ACCESS is the route
  (every member) and READ SCOPE is the audience (`guideAudienceFor(auth)` — never from the client —
  applied in the TOC and as a SQL predicate in `retrieveGuide`). Only `routes/guide.ts` builds
  `search_guide` (`createGuideTools`), and nothing else may read the table, run the retrieval or
  resolve an audience — `tests/config/guide-isolation.test.ts` is the source scan
- Its query embedder is `resolvePlatformEmbeddings` (the operator's model, never a tenant's, so it
  matches the committed vectors)
- A page never types a number its code owns: `{{fact:key}}` from `guide-facts.ts`, whose PINNED
  literals (the CLI's, two heavy server modules') `tests/config/guide-facts.test.ts` holds to the
  real constants
- Its CUSTOM event is the kit's `kit.guide.answer`; an app adding a Guide-like surface of its own
  uses its own prefix
