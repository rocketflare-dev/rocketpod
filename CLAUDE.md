# Rocketpod

Multi-tenant SaaS starter for internal tools and B2B products, a **pnpm workspace**: Hono API + React UI in one
Node server built to run in a container (`apps/web`), a CLI (`apps/cli`), private zod contracts
(`packages/shared`). A hard fork of Rocketflare 0.19.0 (0.20.0 ported since) with no Cloudflare
dependency (D41, `docs/FORK.md`): Postgres for everything stateful, an S3-compatible store for
files. `AGENTS.md` symlinks here.

> **How it works**: `docs/CONCEPTS.md` — one section per subsystem with its known gaps. **Check it
> before assuming a capability exists; update it when you change one.**
> **Setup**: asked for setup help → run `/rp-setup` (it drives `scripts/bootstrap.sh --no-dev`, then
> starts the server): show each `✔ n/10` line, stop on failure. By hand: `SETUP.md` Part 1.
> **Fresh copy?** `/rp-adapt <slug>`, then `docs/ADAPTING.md`. `/rp-setup`, `/rp-adapt`, `/rp-preflight`,
> `/rp-traces`, `/rp-evals` and `/rp-plugin` you may run yourself. **Deploying** (image, Compose,
> Helm — `docs/DEPLOY.md`) is `/rp-deploy`: it renders and checks locally, and asks the user before
> it pushes an image, touches a cluster or creates anything billed.
> **Plugins** (D31, `docs/CONCEPTS.md` §16): a plugin is a git repository copied in, wired through five
> barrels — `pnpm plugin add|upgrade|remove|list|check`, driven by `/rp-plugin`, which always shows the
> plan before `--apply`. It imports the host only through the DECLARED entries (`docs/plugin-api.md`,
> generated and diff-checked) and receives everything else as injected context. `.rocketflare.json`'s `defaultPlugins` is what a fresh clone installs
> (bootstrap step `6/10 plugins`).
> **Copies of the kit upgrade.** `.rocketflare.json` records the kit version, the app's names and the
> manifest of replaceable surfaces; `/rp-upgrade` ports later releases into a copy and never
> recreates a surface whose anchor file is gone. **A behaviour change here needs an entry in
> `docs/upgrades/unreleased.md` in the same commit** — CI fails without one, and the tag gate refuses
> a release with no note. `pnpm kit:release <version>` writes the release assets.

## Stack

- **Runtime**: Node 24 — `src/node/server.ts` serves the Hono app on `@hono/node-server`
  (`SERVER_MODE` `web|worker|all`; `/healthz`, `/readyz`; one Postgres pool per process; SIGTERM
  drains), bundled to `dist/server.js`. Every runtime capability is a `Platform` member
  (`src/platform/types.ts`, `.claude/rules/runtime.md`). pnpm 10
- **API**: Hono 4, zod contracts from `@rocketpod/shared`, CASL. **DB**: Postgres 17 + pgvector —
  Docker locally; Drizzle over postgres.js, the ONE driver (D35, narrowed — Neon's serverless
  driver is gone); `openDatabase(env)` = a view of the Node process pool; raw results only through
  `rows()`/`affected()`
- **Auth**: arctic (Google, Microsoft, any OIDC issuer — jose-verified `id_token`, off by default) + magic link + dev-login; `__Host-session`; API keys; Postgres rate limit
- **Async / realtime**: pg-boss jobs + cron, `ws` on `/ws` with LISTEN/NOTIFY fan-out, S3-compatible
  storage (`STORAGE_*`), OpenWorkflow durable agent runs — all on Postgres but the object store
- **AI**: `services/ai/resolve` (`agent_models` → tenant `ai_configs` → platform key — `ANTHROPIC_API_KEY`
  or `AI_*` (OpenAI-compatible); zero key → 503); Anthropic / OpenAI (Responses API) /
  OpenAI-compatible chat (per-model request rules: `packages/shared/src/ai/models.ts`; defaults
  `claude-haiku-5-5` / `gpt-6-luna`) streamed as **AG-UI**
  (`@ag-ui/core` pinned; SSE or protobuf; `POST /api/agui/run` is the protocol endpoint), chat calls
  the knowledge tools, agents on the run engine (projected to AG-UI on read) with typed
  decisions (`ctx.decide`, D37: TypeSafe's Jev as the `decisions` scope, else the chat model),
  `EMBEDDINGS_*` → pgvector (uploads: object store → unpdf/mammoth → pgvector), OTLP tracing (D32: GenAI
  spans → Langfuse/Phoenix/any backend, always also `ai_spans` → `rocketpod traces`); evals (D33:
  `apps/evals`, vitest-evals on vitest 4, `pnpm eval`, never in the gate) + thumbs feedback →
  `rocketpod evals promote`
- **Analytics**: not core — the `analytics` PLUGIN (D31), not installed by default until a
  Rocketpod-compatible release exists (`defaultPlugins` is empty, `docs/ROADMAP.md` → Next)
- **UI**: React 18 + Vite, DaisyUI 5 / Tailwind v4, React Router 6, TanStack Query 5; served by the Node server from `dist/ui`
- **CLI**: commander + chalk + open; `tsx` in dev, esbuild → `dist/cli.js` (bin `rocketpod`)
- **Tests**: vitest projects `api` · `api-isolated` · `driver` · `ui` · `config` · `kit-only` (the kit's own
  tests, `apps/web/tests/kit-only/`, deleted by the rename — never in a copy) (Postgres :5533, the
  S3 gateway :7433; `driver` is the seam's conformance suite); cli; the eval kit's unit tests (`apps/evals/tests`). Evals themselves are
  `pnpm eval`, outside the gate
- **Lint**: Biome 2 at the root (single quotes, `asNeeded` semicolons, 100 cols)

## Commands (from the workspace root)

```bash
pnpm bootstrap · pnpm preflight  # first run in one go / read-only check
pnpm dev:db:up && pnpm db:migrate  # Postgres (first free port from :5432) + S3 gateway (:7070) → .env; role → migrations → grants
pnpm seed [--demo] && pnpm dev  # tenant/users/key (+ populated workspace); Node :3001 (tsx watch) + vite :3000 (strict ports)
pnpm build && node apps/web/dist/server.js [web|worker|all]  # the production server
docker compose up -d --build  # the whole stack from the image: postgres, s3, migrate, web, worker (docs/DEPLOY.md)
helm upgrade --install rocketpod deploy/helm/rocketpod -f values.yaml  # Kubernetes; Postgres + S3 external
pnpm dev:stop · pnpm dev:status · pnpm dev:db:status  # kill this repo's dev tree / port holders / every dev database
pnpm cli login --server http://localhost:3001  # browser → ~/.rocketpod/config.json, then whoami
pnpm gate [step…] · pnpm gate --list [--json]  # THE gate: lint → typecheck → test → build (CI's one job, Launch's ship gate)
pnpm test  # every package; starts the test DB (:5533) + S3 gateway (:7433); the whole suite, driver conformance included
TEST_DATABASE_BRANCH=gate-… pnpm test  # a sandbox gate: no Docker, the whole suite on a gate branch over TCP (CONCEPTS §4)
pnpm eval [suite] [--model x] [--compare] · pnpm eval:baseline · pnpm eval:view  # real-model evals (D33, docs/EVALS.md)
pnpm lint · pnpm typecheck · pnpm build  # workspace-wide
pnpm web <script>  # any apps/web script (test:api, db:check…)
pnpm db:generate · pnpm db:studio
pnpm kit:upgrade [--to X.Y.Z] [--apply] · pnpm kit:release X.Y.Z  # port a kit release into a copy / cut one
```

Local env lives in `apps/web/.env` (`.env.example` is the template). No
`RESEND_API_KEY` → magic-link URLs are logged; no AI key → chat/agents/indexing 503 (there is no
zero-key AI); the gate needs no credentials (tests use an in-process fake model endpoint).

## Architecture

```
apps/web/          @rocketpod/web — .env(.example), .env.test, docker-compose.{dev,test}.yml,
│                  drizzle.config.ts, migrations/, scripts/, tests/
│  src/node/       the Node entry: server.ts (modes, probes, shutdown) · platform.ts · assets.ts
│                  (static + SPA fallback) · defer.ts (waitUntil) · jobs{,-schema}.ts (pg-boss) · runs{,-schema}.ts (OpenWorkflow agent runs)
│                  · realtime.ts (ws + NOTIFY) · storage.ts (S3) · limits.ts · converter.ts — `dist/server.js`
│  src/platform/   types.ts — the Platform interfaces every capability is read through
│  src/config.ts   loadConfig(env): zod over the env; routes read c.get('config')
│  src/permissions/  CASL owner/admin/member/support + isGlobalAdmin   src/db/  client, tenant-scope, schema/
│  src/api/        index.ts (Hono app, middleware order, ASSETS catch-all) · queue.ts · scheduled.ts ·
│                  middleware/ · auth/ · routes/ (thin) · services/ (ai/, agents/, prompts.ts) ·
│                  workflows/ (agent-run-body.ts) · observability/ · utils/ · queues/
│  src/ui/         React app
│  src/plugins/    D31 seam: types.ts, api/ (the context family a plugin imports) + the
│                  server/ui/schema barrels (one line per installed plugin)
│                  + each plugin's tree — `example-feature/` vendored as the reference one
│                  (per-dir CLAUDE.md: permissions, db/schema, api/*, ui, plugins, plugins/<id>)
apps/cli/          @rocketpod/cli — src/cli.ts, commands/*, api.ts (only fetch site), config.ts, login.ts,
                   plugins/ (CLI_PLUGINS barrel + each plugin's commands)
apps/evals/        @rocketpod/evals — vitest-evals suites over apps/web in-process: kit/ (targets, judges),
                   suites/, datasets/*.jsonl, baselines/; `pnpm eval` only, never the gate (docs/EVALS.md)
packages/shared/   @rocketpod/shared — src/*.ts zod contracts, errors, pagination, permissions,
                   plugins/ (SharedPlugin + the SHARED_PLUGINS barrel + each plugin's contracts) (CLAUDE.md)
scripts/           bootstrap.sh → bootstrap.mjs (10 steps), install.sh (curl one-liner), rename.mjs,
                   upgrade.mjs (port a kit release into a copy), release{,-check}.mjs, changelog-nudge.mjs
                   (PreToolUse on a commit: missing porting note),
                   kit-update-check.mjs (SessionStart: tells a copy about a newer kit release),
                   kit-check.mjs (the Launch kit conformance check, shared with the meta-kit — this
                   kit is not conformant: launch.kit.json `$runtime`), lib/
Dockerfile         ONE image: dist/server.js (web|worker|all) + dist/migrate.js + dist/ui, no node_modules
docker-compose.yml the self-contained stack; deploy/ holds compose.single.yml, compose.env.example and
                   helm/rocketpod (web/worker Deployments, migrate hook Job, ConfigMap/Secret ≡ config.ts)
.rocketflare.json  kit version + commit, the app's names, the replaceable-surface manifest
launch.kit.json    the Launch kit contract (D36), Cloudflare-shaped; kept schema-valid, its `worker` and
                   `release` blocks describe nothing here (`$runtime`)
docs/upgrades/     one porting note per kit release (+ unreleased.md) — CHANGELOG.md is the index
.claude/skills/    rp-setup · rp-preflight · rp-adapt (+ checklist.md) ·
                   rp-how-do-i (+ example-orders.md) · rp-upgrade (+ porting.md — port later kit releases) ·
                   rp-plugin (+ reference.md — install/upgrade/remove a plugin, D31) ·
                   rp-traces (debug a run from its span tree; pick a tracing backend, D32) ·
                   rp-evals (+ reference.md — author, run, compare, harvest, baseline, improve; D33) ·
                   rp-deploy (Compose or Helm, the secrets checklist, never prints a secret) ·
                   example-feature (demo the reference plugin)
```

**`packages/shared`.** Private, no build: `@rocketpod/shared/<module>` → `./src/<module>.ts` (incl. `ai/*`,
`plugins/<id>`). Imports only `zod`, siblings, type-only `@casl/ability`, and `@ag-ui/core` (pinned,
zod-only, no platform APIs) in `src/ai/agui.ts` alone — the AG-UI wire format is validated by the
protocol's own schemas on both sides, which a mirror cannot give. A fifth dependency needs the same
written justification, and `apps/web/tests/config/shared-imports.test.ts` enforces the list.

**`apps/cli`.** `login` opens `GET /auth/cli?redirect_uri=http://127.0.0.1:<port>/callback`; the server
mints a tenant API key `cli:<host>` → `?key=&tenant_id=&tenant_name=`; stored `0600` in
`~/.rocketpod/config.json` (`ROCKETPOD_API_KEY`/`ROCKETPOD_URL` for CI). Also `logout|whoami|status|config`,
`members|keys|activity|groups|features list --json`, `groups members`, `traces list|show`,
`feedback list`, `evals promote` (`.claude/rules/cli.md`)

## Config model

Environment variables — `apps/web/.env` locally; deployed, the compose `.env` or the chart's
`config` (ConfigMap) / `secrets` (Secret or `existingSecret`) — read once via `loadConfig(env)`:
`APP_ENV` (`development|staging|production`) · `APP_URL` · `TENANCY_MODE` (`multi|single` — same
schema; single auto-joins the one tenant) · `SIGNUP_MODE` (`open|invite_only|approval`;
`BOOTSTRAP_ADMIN_EMAILS` seeds the first admin) · `TENANT_SCOPE_MODE` (`off|enforce`, `docs/RLS.md`) ·
**database**: `DATABASE_URL` (secret), `DATABASE_POOL_MAX` (10), `DATABASE_LISTEN_URL` (realtime
LISTEN; direct or session-mode when PgBouncer runs in transaction mode), `DATABASE_DRIVER`
(`postgres` only) · **server**: `SERVER_MODE`/first arg (`web|worker|all`), `PORT` (3001),
`TRUSTED_PROXY_HOPS` (proxies appending `X-Forwarded-For`, 0) · secret `OAUTH_ENCRYPTION_KEY` ·
**work**: `JOBS_CONCURRENCY` (2), `JOBS_POLL_INTERVAL_SECONDS` (2), `RUNS_CONCURRENCY` (4),
`AGENT_INTERRUPT_TIMEOUT`, `AGENT_MAX_OUTPUT_TOKENS`, `AGENT_MAX_TURNS` · **storage**: `STORAGE_DRIVER` (`s3`),
`STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_FORCE_PATH_STYLE`, secrets
`STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` · **AI**: secrets `ANTHROPIC_API_KEY`,
`AI_API_KEY` (+ `AI_BASE_URL`, `AI_MODEL` — OpenAI-compatible), `EMBEDDINGS_API_KEY` (+
`EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL`; 1024 dims), `TYPESAFE_API_KEY` · `CHAT_KNOWLEDGE_TOOLS`
(`true|false`) · `CHAT_HISTORY_MAX_CHARS` (older turns summarised by `chat.compact`) ·
`FEATURES_ENABLED` (D30 — comma-separated feature keys this deployment ships at all; fail-closed,
consulted only for a flag marked `environmentGated`; the rollout state itself lives in Postgres) ·
`OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_LABEL`/`OIDC_SCOPES`/`AUTH_OIDC_ONLY`/`OIDC_TRUST_EMAIL`
(optional SSO, `SETUP.md` 2.3b; secret `OIDC_CLIENT_SECRET`) · tracing `OBSERVABILITY_*`,
`OTEL_EXPORTER_OTLP_*`, `LANGFUSE_*`. `src/config.ts` is the full list;
`tests/config/packaging.test.ts` holds the chart to it.

Rules (auto-loaded by path): `.claude/rules/api.md` · database.md · ui.md · cli.md · testing.md ·
code-quality.md · runtime.md. Runbooks: `docs/DEPLOY.md` · `docs/RLS.md`

## Non-Negotiables

- **Gate**: `pnpm gate` (lint → typecheck → test → build) passes before every commit — the same
  command a copy's CI job and Launch's ship gate run
- **Driver seam**: app code never names the driver; `apps/web/src/db/client.ts` is the only place
  it is, the guard in `driver-results.test.ts` bans the rest, and `tests/driver/` proves it (a
  per-request client and the Node process pool) and is never skipped (`apps/web/src/db/CLAUDE.md`)
- **Tenant isolation**: every domain query filters by `tenantId` from the auth context; every tenant
  table calls `tenantIsolation()` (RLS inert; `rls-coverage.test.ts` enforces), a plugin's tables
  included — and a plugin adding a query surface of its own (the analytics plugin's cubes) owns the
  test that proves it scopes, because the kit cannot
- **Contracts first**: zod schema in `packages/shared/src/` → route `validate()` → UI/CLI parse the same
  schema; errors are `{ error, statusCode, code?, details? }`
- **shared is private** — never publish it; never import `apps/web` from `packages/shared` or `apps/cli`
- **Routes enqueue, never run**: long work → `platform.jobs` or `platform.runs`; side effects in
  `waitUntil`; concurrency is a DB claim row, never a `Map`; SSE routes use `streamDatabase(c)`
- **No Cloudflare**: no wrangler/miniflare/workerd/`@cloudflare/*` package, no `cloudflare:*`
  import, no Workers type, no binding read off an env — `platform-seam.test.ts` fails any
- **Config, compose and chart agree**: a var or secret added to `src/config.ts` goes into
  `.env.example` and the chart's `config`/`secrets` (compose when it needs it) in the same change —
  `packaging.test.ts` fails otherwise; the Dockerfile ships exactly what `build-server.mjs` emits
- **Secrets** never in git, a committed values file or a response (`hasCredential`); `.env`
  comments hold no other credentials; the CLI never prints a full key; `gitleaks` in CI
- **`process` and Node server APIs only in `apps/web/src/node/`** (`node:fs`, `node:http`,
  `@hono/node-server`…), and nothing else imports `src/node/` — `platform-seam.test.ts` fails it;
  `process.env` is read only there (`server.ts` hands it to `loadConfig`). Never add `pg` to app code
- **Release = root version**: git tag == root `package.json` `version` (ships the image + cli)
- **Docs in sync**: a behaviour change updates CONCEPTS / SETUP / DEPLOY / rules in the same PR,
  **and adds an entry to `docs/upgrades/unreleased.md`** — copies of the kit absorb changes by
  reading those notes, so a change with no note never reaches them (CI and the tag gate enforce it)
- **A plugin composes, it never redefines** (D31): it namespaces everything with its id (tables
  prefixed from it — `example-feature` → `example_*`, and `plugin check` fails a collision — job
  types `<id>.x`, query-key roots `<id>:…`, `/api/<id>`, CUSTOM events `<id>.` — **never `kit.`**),
  reaches core only through the five barrels, its own four published entries and the DECLARED import
  entries (`@/plugins/api`, `@/db/schema/kit`, `@testkit/*` — `docs/plugin-api.md`), and ships
  no migration — the host generates the DDL — and declares no Cloudflare `bindings` or
  `workerExports` (`pnpm plugin` refuses them; capabilities come through `ctx.platform`)
- **Released history is never rewritten**: an adopted copy pins a kit commit in `.rocketflare.json`;
  a force-push to a released tag orphans every copy that came from it
