# The plugin seam

A plugin is a **separate git repository copied into an app** — never installed from npm, exactly
like the app itself — that contributes contracts, schema, routes, jobs, agents, UI and CLI commands;
this is the contract for writing one. This directory is the host half: the types, the plugin API
(`api/`), the three web barrels, and every installed plugin's tree. Design: `docs/CONCEPTS.md` §16 ·
importable symbols: `docs/plugin-api.md` · example: `example-feature/` · **`/rp-plugin`** for
anything procedural (add, upgrade, remove, `check`; `.claude/skills/rp-plugin/`).

The whole seam is **five barrel lines**. Installing a plugin is writing them; removing it is
deleting them. Nothing else in the host ever names a plugin, which is what makes both reversible.

| Barrel | Exports | Read by |
|---|---|---|
| `packages/shared/src/plugins/index.ts` | `SHARED_PLUGINS` / `sharedPlugins` | the five composers: `ai/agents.ts`, `jobs.ts`, `permissions.ts`, `features.ts`, `realtime.ts` — plus `apps/web/src/config.ts` |
| `server.ts` | `SERVER_PLUGINS` / `serverPlugins` | `api/index.ts`, `utils/routes/api-prefixes.ts`, `queues/jobs.ts`, `scheduled.ts`, `agents/registry.ts`, `agents/tools/index.ts`, `prompts.ts`, `permissions/abilities.ts`, `utils/db/tenant-helpers.ts`, `services/access.ts`, `plugins/api/peers.ts`, `routes/auth/session.ts` (`loginMethods`), `routes/auth/sso.ts` (`ssoPolicy`), `scripts/seed.ts`, the `rls-coverage` and unscoped-allowlist tests (never `db/schema/rls.ts` — a cycle) |
| `ui.ts` | `UI_PLUGINS` / `uiPlugins` | `App.tsx`, `SideNav.tsx`, `Home.tsx`, `SettingsLayout.tsx`, `lib/query-keys.ts`, `pages/agents/forms/index.ts` |
| `schema.ts` | one `export *` per plugin | one `export *` line in `db/schema/index.ts` (position irrelevant — a duplicated name is TS2308) |
| `apps/cli/src/plugins/index.ts` | `CLI_PLUGINS` / `cliPlugins` | `cli.ts` |

- **The `export *` barrel carries an empty marker** (`export {}`) — never delete it: with no plugin
  line `schema.ts` would have no top-level export, TypeScript reads it as a SCRIPT, and its one
  importer fails TS2306. `addBarrelLine` displaces the marker and `removeBarrelLine` puts it back,
  byte for byte.
- **Two names per barrel, not style**: the `as const` TUPLE is what type-level derivations read (the
  job-variant union, the agent-key enum, the subject union) — use `SERVER_PLUGINS` in a type
  position; an EMPTY tuple indexes to `never`, so everything that only ITERATES reads the widened
  list (`serverPlugins`).
- `ServerPlugin<S>` / `UiPlugin<S>` (`types.ts`) are generic over the plugin's own `SharedPlugin`:
  `jobHandlers`, `agents`, `prompts`, `agentForms` must cover exactly the keys THAT plugin declared —
  a missing handler is a type error in the plugin, not a dispatch failure in the host. Only the merge
  is cast.

## Boundaries — what a plugin imports, and what it may never do

- **Exactly four published entries** — `src/plugins/<id>/index.ts`, `<id>/ui/index.ts`,
  `packages/shared/src/plugins/<id>/index.ts`, `apps/cli/src/plugins/<id>/index.ts`; everything else
  under it is private, which is what lets its semver cover a knowable surface. **No deep import
  across a plugin boundary**, in either direction, except the five barrel lines
  (`tests/config/plugins.test.ts`). `plugin.json` is the surface ANCHOR, read by the tooling, never
  imported.
- **A plugin imports the host only from a DECLARED entry, and receives everything else as injected
  context.** Server: `@/plugins/api` — `const ctx: RequestCtx = requestCtx(c)` in a route, `jobCtx`
  in a handler, `cronCtx` in a task, `toolCtx` in an agent tool, `workflowCtx` in a durable run,
  `publicCtx` in a public mount, `HookCtx` / `SeedCtx` in the two hooks, `DetachedCtx` for a
  callback that outlives the handler. The methods are the kit's own helpers under another name —
  `ctx.guard`, `ctx.uuid`, `ctx.page`, `ctx.enqueue`, `ctx.nudge`, `ctx.notFound`, `ctx.defer`,
  `ctx.storage`, `ctx.scope` — and the ADAPTER (`requestCtx` and its siblings) is the only thing that
  reads the kit's internal context, which is what lets `cfg` stay `cfg` in a kit route while every
  plugin says `config`. `tests/helpers/plugins.ts` enforces the rule and every diagnostic carries
  the replacement import. **Annotate the context explicitly** — `ctx.notFound()` returns `never`,
  and TypeScript narrows on that only when the call target is explicitly typed, so `const ctx =
  requestCtx(c)` throws at runtime while the compiler still believes the row may be undefined.
- **Two things cannot be injected and are entries instead**: `@/db/schema/kit` for a table file (a
  `pgTable(...)` runs at module scope and drizzle-kit reads it statically — imported by RELATIVE
  path, since drizzle-kit bundles that file and resolves no tsconfig alias) and the split UI kit.
  `@testkit/{integration,unit}` is the third, for a plugin's tests.
- **Module-evaluation order is the one trap the type system cannot see.** `queues/jobs.ts`,
  `agents/registry.ts`, `prompts.ts`, `scheduled.ts`, `api-prefixes.ts` and `access.ts` read the
  barrels at MODULE SCOPE; a plugin module reading one of their values at its own module scope
  closes a cycle and one side holds `undefined` — a crash at import, not a compile error. Avoid it
  with **`import type`** for anything only needed as a type (`AgentToolContext`, `Tool`) and by
  **never reading a barrel-backed value at module scope**: `example-feature/api/hooks.ts` reaches
  the core `feature_flags` through `allTables()` (`@/plugins/api/peers`) called INSIDE `seedDemo`.
  Host code names a file directly rather than a barrel that re-exports the plugin
  (`db/schema/index.ts` re-exports `plugins/schema.ts`).
- **Its shared module imports no composer at runtime** (the five above): two zod modules in a cycle
  crash at module evaluation rather than failing to compile. Whole-declaration `import type` is
  fine; `import { type X } from` is not (`tests/config/shared-imports.test.ts`). Host side, for the
  same reason: **a registry a plugin composes into is a FUNCTION, not a const**
  (`visibilityResources()`), and a VALUE a plugin needs moves to a leaf (`services/access-sql.ts`)
  and is re-exported so no core importer moves.
- **It declares no Cloudflare `bindings` and no `workerExports`.** Plugins are shared with
  Rocketflare, the Cloudflare Workers kit, and a plugin that works on both declares neither:
  Rocketpod has nothing to bind them to, so `pnpm plugin` refuses either at install and
  `plugin check` fails one on an installed plugin. A plugin reaches jobs, storage, realtime,
  durable runs, rate limits and locks through `ctx.platform`.
- **It ships no migration** — the HOST generates it (`/rp-plugin` §3). Its `migrations/` holds
  plain-SQL DATA fragments (backfills), never DDL — a foreign snapshot makes the next `db:generate`
  drop app tables.
- **It edits no `package.json`.** A cron it declares is a `scheduledTasks` entry (the registry is
  the schedule, `.claude/rules/runtime.md`); a var is an environment variable, declared in
  `.env.example` by the install plan; dependencies are declared in `plugin.json`. A line it needs in
  any other core file (`vite.config.ts`'s dev proxy or an alias) is a declared `coreEdits` entry —
  anchored on text, applied by `plugin add`, reverted by `remove` — never a hand edit. The host owns
  every byte of its own files; the plugin only declares.
- **It never renames anything across releases** — expand/contract only. `drizzle-kit`'s rename
  prompt has no non-interactive answer, so a rename stops an unattended install dead.
- **It composes, never redefines.** A tenant credential goes through `sealSecret` / `openSecret`,
  never crypto of its own. A change to the core tables, to auth, to tenancy or to a cross-cutting
  middleware is a CORE change.
- **Compatibility is OBSERVED, not versioned**: a top-level `minKit` floor (bare `X.Y.Z`, no
  ceiling) and `uses` (written by `pnpm plugin export`, **never by hand**), checked as
  `uses \ ledger` against the `## Surface ledger` of `docs/plugin-api.md` — a set difference that
  names each missing symbol with its replacement import. `requires.kit` and `requires.pluginApi`
  were predictions that went stale and are refused by name (field notes: `/rp-plugin` reference §
  The manifest).
- **Changed or removed a member of a declared entry** (`plugins/api/**`, `@/plugins/types`,
  `@/db/schema/kit`, the shared/CLI plugin APIs, `@testkit/*`)? Regenerate `docs/plugin-api.md`
  (`node scripts/plugin-api-doc.mjs`) and commit it; the gate diffs the file, and any plugin naming
  the removed symbol fails `pnpm plugin check` by name.
- **It declares the eval coverage of its own prompts and agents** in `SharedPlugin.evalCoverage`
  (`@rocketpod/shared/ai/eval-coverage`): a key it registers with no entry fails the host's gate
  (`tests/config/eval-coverage.test.ts`). It cannot write a suite under `apps/evals`, so it usually
  declares `{ exempt: '<why>' }`; the host overrides that in the core map once it writes one.

## Namespacing

The id is `^[a-z][a-z0-9-]*$`, never a barrel filename or `api` (the host's `plugins/api/`), and never contains `rocketpod`: a plugin is
written in the original `rocketpod` vocabulary so `applyReplacements` can translate it into a
renamed app on the way in, and an id carrying that name would be rewritten with everything else.
Everything carries it: tables prefixed with the id's first hyphen-separated segment
(`example-feature` → `example_*`, `analytics` → `analytics_*`; longer is welcome — the CHECK is that
no two installed plugins declare the same table name); job types `<id>.verb`; CASL subjects;
prompt/agent/feature keys; query-key roots `<id>:…`; `/api/<id>`; public routes `/api/hooks/<id>`;
the CLI command `<id>`; skills `<id>` / `<id>-<what>`; realtime topics `<id>` / `<id>.<name>`;
AG-UI CUSTOM events `<id>.` — **never `kit.`**, the core namespace, which may grow in a later
release.

## Server slots (`ServerPlugin`)

- **Its routes are kit routes in every respect** — `createRouter()`, `validate()` with a contract
  from its own shared entry, `ctx.guard` with its own subject, the tenant id from the context, typed
  errors, a tenant predicate on every query. Only REGISTRATION differs: `mounts`
  (`['/api/<id>', router, middleware?]`, the same tuple a kit mount is), spread LAST into the mount
  table of `api/index.ts`, so the enumerable auth surface stays one list and a plugin can never
  shadow a kit prefix. The `/api/<id>` convention is what stops two plugins claiming one path.
- **A feature flag gates the MOUNT, not each route** — `requireFeature('<id>')` as the third element
  (404 `feature_disabled`), exactly like a kit surface. Never `access Feature:<id>`: a global admin's
  `manage all` satisfies the CASL form.
- **A prefix outside `/api`** goes in `apiPrefixes`, which feeds `API_PREFIXES` (the SPA catch-all's
  JSON-404 guard and the Node server's static-file fallthrough) — else the catch-all answers
  `index.html` for it. The Vite dev proxy is a core file the plugin never touches: its line is a
  `coreEdits` entry after `'/ws': proxyTo(` (or `pnpm plugin add` prints it).
- **Unauthenticated routes live under `/api/hooks/<id>` and nowhere else** (`publicMounts`), mounted
  before the authed table with no `authMiddleware` and no gate. The handler (`const ctx: PublicCtx =
  publicCtx(c)` — no tenant, no auth fields) PROVES the caller first — `verifyState` over a token it
  minted with `signState`, a stored per-subscription secret, the provider's signature; every failure
  the same 401 — then uses only the tenant that proof carried. It re-checks its flag with
  `ctx.features(tenantId)` (a `requireFeature` gate reads `auth.features`, which does not exist here)
  and answers by `ctx.enqueue` — a provider's webhook timeout is seconds. A callback completing a
  flow an admin started re-checks them with `memberCan(ctx, { tenantId, userId }, action, subject)`
  — membership, role, block and tenant status as of now — right after `verifyState`, because a
  signed state outlives a demotion. `JobCtx` and `CronCtx`
  carry the same `features(tenantId)`, so a fan-out cron skips dark tenants.
  `tests/config/plugins.test.ts` refuses a public mount outside the plugin's own `/api/hooks/<id>`
  and any authed mount under `/api/hooks`. The host's per-IP rate limit and body cap, and the
  overrides: `/rp-plugin` reference § Public mounts.
- **It signs people in through `identityFor(c, '<id>').signIn(...)` and provisions through
  `provisionFor(ctx, '<id>')`** (`api/identity.ts`), **never by writing a session** — no
  `user_sessions` row, cookie, `admitUser` or `tenant_users` write of its own. Both trust the caller
  about the tenant, exactly as `PublicCtx` does — prove it first. `linkByEmail: true` ONLY for a domain the connection proved it owns, or one
  tenant's IdP can sign in as anyone; without it the seam refuses to claim or CREATE any address no
  link covers (`account_exists`), and a `BOOTSTRAP_ADMIN_EMAILS` address is refused always. A
  suspended tenant answers 403 `tenant_suspended` from every tenant-taking method. `loginMethods(cfg)` feeds `GET /auth/methods`
  `pluginMethods`; a `startPath` outside `/api/hooks/<id>/` is dropped and logged at runtime and
  fails `tests/config/plugins.test.ts`. Semantics (links, `idp` memberships, leaver vs block,
  `single` mode, error codes): `/rp-plugin` reference § Identity and SSO.
- **`ssoPolicy`** answers `{ required: true, methodId }` only for a domain your connection proved; a
  throw fails CLOSED. A plugin with several tenants' connections sets `connectionId` on the answer
  and passes the same id to `signIn`, or another tenant's connection satisfies the claim. Host side: **every sign-in path asks the policy before it admits**
  (`../api/routes/CLAUDE.md`) — a new path that skips it is a hole in every customer's SSO
  requirement. Never import `routes/auth/sso` statically from `plugins/api/**` (it reads the barrel;
  `identity.ts` uses `await import`). Worked examples: `example-feature/api/sso.ts` (dev-only),
  `sso-policy.ts`.
- **`ctx.startAgentRun`** (`JobCtx`, `CronCtx`, `PublicCtx`): `{ agentKey, tenantId, input,
  idempotencyKey?, concurrencyKey?, triggeredBy? }` → `{ runId, status, deduplicated }`, through the
  route's own `enqueueRun`, so every gate applies and each refusal is a throw (a job retries). **A
  job always passes an `idempotencyKey` naming the work** (`receipt:<documentId>`, never the message
  id) — a queue delivers at least once, and the key is what makes the redelivery answer the first
  run. Never insert into `agent_runs` or call `platform.runs` from a plugin.
- **Storage is `ctx.storage()`** on every context (`RequestCtx`, `JobCtx`, `CronCtx`, `PublicCtx`,
  `AgentCtx`, `ToolCtx`; `platform.storage`, 503 `storage_not_configured` without one), keyed
  `tenants/<tenantId>/<id>/…` so `tenant.purge` removes it — never `platform.storage` with a
  hand-built prefix.
- **Knowledge goes through `ingestDocument` / `ingestDocumentFile`**, never a `documents` insert:
  `source: '<id>:<kind>'` + the item's upstream `externalId`, so a re-sync UPDATES the row rather
  than adding one; `deleteIngestedDocument` for upstream deletes. Visibility defaults to the whole
  organisation — a plugin syncing ONE person's data passes the owner's `userId` + `visibility:
  'groups'` + `groupIds: []` (owner and admins only). A plugin that ingests declares
  `requires.surfaces: ["feature-knowledge"]`.
- **`jobHandlers` is checked against the plugin's OWN `shared.jobs`** (`{ [T in JobTypeOf<S>]: … }`),
  so a declared variant with no handler is a type error in the plugin. Namespace every `type`
  `<id>.verb`; the handler contract is the kit's (own DB client, await everything, throw to retry —
  `../api/queues/CLAUDE.md`).
- **`agentTools(ctx)` is bound to the run's `AgentToolContext`**, which carries the `AccessScope` —
  so a plugin tool reads what its REQUESTER may read, never a bare `tenantId` it chose itself. A
  tool that writes is offered on `ToolCtx.can('manage', YOUR_SUBJECT)`, never on `scope.bypass`,
  which is row visibility.
  Appended after the kit's three knowledge tools (async allowed, `[]` for a tenant that has not
  turned the tool on, a throw is logged and skipped); a test that pinned the exact tool list must
  become a prefix assertion.
- **`grants` are ADDITIVE and over the plugin's OWN subjects** (declared in
  `SharedPlugin.subjects`), run after the kit's matrix in `buildAbility`. CASL can take a rule back
  only with `cannot`, so a plugin that revoked a kit grant would change what every role may do
  merely by being installed.
- **`hooks.onTenantCreated`, `hooks.onTenantDeleted` and `hooks.seedDemo` are post-commit, idempotent
  and best-effort**, each try/caught by the host after the kit's own — a plugin hook that throws must
  never break sign-up or invite accept, so nothing a tenant NEEDS may arrive only that way.
  `onTenantCreated` is handed `features` (a hook that CREATES rows gates on them itself). `seedDemo`
  gets a `demoId` already namespaced with the plugin's id; fixed ids + `onConflictDoNothing`.
- **`onTenantDeleted` is for state the FK cascade cannot reach**, and nothing else: a plugin's
  TABLES are already gone. It runs from the `tenant.purge` job with the tenant id and the platform,
  so a plugin reaches its own storage prefix or external system through `ctx.platform` rather than a
  global. **Out-of-Postgres state is purgeable only because its names are DERIVED**: declare a FINITE
  key set derived from the tenant id and the purge loops the declared keys, never an enumeration.
  State keyed per ROW cannot be purged under this rule; the escape hatch is a purge-intent ledger —
  a table carrying `tenant_id` with NO foreign key, so it survives the cascade
  (`access_requests.requested_tenant_id` is the precedent) — **deferred until somebody needs it**.
- **`visibilityResources`** registers rows a group may restrict — `{ key, noun, usageKey, predicate,
  setGroups, grantRows, countGrants }` in `services/access.ts`'s registry, so the predicate is SQL
  ANDed onto the tenant one and the 409 `group_in_use` count includes it.
  `rlsExcludedTables` / `unscopedAllowlist` are its entries in the two enforcement tests, keyed
  exactly as the kit keys its own (a path under `apps/web/` → the reason).
- **Its realtime topics are declared, namespaced and read-gated.** `SharedPlugin.realtimeTopics`
  lists `{ prefix, subject, scope? }`; the prefix is the plugin id or `<id>.<name>` (never `kit`),
  and `buildRealtimeTopicRegistry` (`@rocketpod/shared/realtime`) throws at import on anything else
  or a duplicate. A member subscribes only when its role may `read` the subject in the topic's own
  tenant (`canSubscribeTopic`) — so declare the subject in `subjects` and grant `read` in `grants`,
  or nobody can listen. Publish with `ctx.nudgeTopic(tenantTopic('<id>.<kind>', ctx.tenantId,
  rowId), entity, id)` (`JobCtx.nudgeTopic` awaited in a handler); the page calls
  `useRealtimeTopic(topic)` from `@/plugins/api/ui`. A topic is a nudge like any other: ids only.
  `tests/config/realtime-topics.test.ts` covers the registry with fixtures.
- Cross-plugin registries go through `extensions` (`Record<string, readonly unknown[]>`) —
  `unknown[]` at the core boundary is the point: the owning plugin narrows with zod and fails
  loudly, and the host stays ignorant of what anyone means by a "cube".

## Skills and tests a plugin owns

- **Agent skills live at `skills/<dir>/` in the plugin repo, declared in `"skills"`** — never under
  its own `.claude/`, which is never copied. `add` puts each at `.claude/skills/<dir>/` (the one
  place outside its four roots a plugin writes), `upgrade` replaces it, `remove` deletes it. Anything
  a person must SET UP or OPERATE deserves one (`/rp-plugin` §6; `.claude/skills/example-feature/`).
- **A tenant-isolation test** under `src/plugins/<id>/tests/api/` for every tenant-scoped table — a
  second organisation that can neither list, read nor delete the first's rows. The host cannot write
  it; `plugin check` only proves it exists. Every tenant table calls `tenantIsolation()`. A plugin
  with its own query surface (the analytics plugin's cubes) owns the test that proves it scopes.
- The analytics plugin's conventions (dashboards, cubes, fact tables, `/cubejs-api`, `/mcp`) left
  the kit for `rocketpod-plugin-analytics` (`docs/CONCEPTS.md` §8) and moved with it: once it is
  installed they are in the CLAUDE.md files under its own directory here.

## Adding a SLOT (a field on `ServerPlugin` / `UiPlugin` / `SharedPlugin` / `CliPlugin`)

1. The field in `plugins/types.ts` (or the shared/CLI one), with a doc comment saying what it merges
   into and what the host does NOT do for it.
2. The consumer reads the widened list. A CLOSED set becomes `X = [...CORE_X, ...plugin X]`, so the
   public name never moves and only where you ADD to it does.
3. **Not optional**: a case in `tests/config/plugins.test.ts` (or the registry's core test), written
   as a pure helper over a FIXTURE — a structural rule that runs only when a plugin is installed
   proves nothing in an app with none.
4. **Not optional**: `docs/CONCEPTS.md` §16 and the matching `.claude/rules/*.md`, same commit.

Never a slot that lets a plugin change what a role may do (`cannot`), write a migration, or edit
deployment config.
