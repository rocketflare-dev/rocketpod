---
version: unreleased
previous: 0.1.0
date: null
breaking: true
migrations: ["pgboss schema + queues (pg-boss, installed by pnpm db:migrate)", "openworkflow schema (OpenWorkflow, installed by pnpm db:migrate)", "rate_limits and operation_locks tables (Node rate limiter and locks)", "the kit's drizzle chain squashed into 0000_kit-baseline + 0001_plugin-example-feature-0.1.0"]
areas: [api, db, config, shared, ui, docs, tooling]
touches_surfaces: []
requires_surfaces: []
manual: true
---

## What changed

Every runtime capability is now a neutral `Platform`, a Node entry (`src/node/server.ts`) serves the app with one Postgres pool per process, and the Neon serverless driver is removed.

- `src/platform/types.ts`: neutral `JobsQueue`/`JobBatch`, `StorageService`, `RealtimeHub`, `RunEngine` + `Step`, `RateLimiter`, `Locks`, `PlatformAi`, `DocumentConverter`, `Defer`, and the `Platform` bundle.
- `src/platform/cloudflare/`: R2 storage, KV rate limiter and locks, the Durable Object hub, the Workflow step adapter and `createCloudflarePlatform(env)`; `createR2Storage` and `checkRateLimit` moved here.
- `platformMiddleware` sets `c.get('platform')` after config; routes, job handlers (`ctx.platform`), cron tasks (`ctx.platform`) and services read it instead of `c.env.FILES|JOBS_QUEUE|NOTIFICATIONS_HUB|AGENT_RUN_WORKFLOW|RATE_LIMIT_KV|AI`.
- `AppBindings` is neutral (vars by name, `PLATFORM?`, `HYPERDRIVE?`, `ASSETS?`); `CloudflareBindings` is the Worker's type.
- The agent run's body moved to `api/workflows/agent-run-body.ts` (`runAgentRun`) over the neutral `Step`; `AgentRunWorkflow` is a shim.
- `Realtime` is `{ defer, hub }` (was `{ defer, env }`); `operationLock` takes `Locks`; `AiEnv` is `{ ai?, converter? }`; agent and tool contexts' `env` is the `Platform`.
- Plugin API: `PluginContext.platform` added; `ToolCtx`/`AgentCtx` carry `platform` instead of `env`; `durableObject` removed from `RequestCtx`, `BackgroundMethods` and `@/plugins/api`; `workflowCtx(step, env, config, logger, platform)` takes the neutral `Step`.
- `GET /ws` answers 503 `realtime_not_configured` when the platform has no hub (it threw a 500 before).
- `tests/config/platform-seam.test.ts` fails on any Cloudflare type, binding name or `cloudflare:` import outside the adapters, `src/worker.ts` and the two Worker classes.
- Node entry (M2): `src/node/server.ts` runs the Hono app on `@hono/node-server` in `web`, `worker` or `all` mode (`SERVER_MODE` or the first argument), with `/healthz`, `/readyz` (503 while draining), static files plus an SPA fallback, a tracked `waitUntil` set and a SIGTERM drain.
- `pnpm build` adds `build:server` (`scripts/build-server.mjs`, esbuild) → `dist/server.js`, one file with no `node_modules` at runtime; `pnpm web dev:node` runs the entry under `tsx watch`.
- The Node platform (`src/node/platform.ts`) has `jobs` (pg-boss) and every other member null for now: uploads, agent runs, `/ws` and rate limits answer "not configured".
- Jobs and cron on Node (M3): pg-boss 12 (`src/node/jobs.ts`, `src/node/jobs-schema.ts`) in schema `pgboss`. The producer is `Platform.jobs` (`send` → `startAfter`, `sendBatch` → `insert`); `worker`/`all` modes consume batches of 10 through the Worker's own `queue()` and settle per job (unsettled = acked, a throwing batch retries whole); the queue retries 3 times on the 30 s-doubling, 15 min-capped curve (pg-boss jitters it up to 2×) and then dead-letters to `rocketpod-jobs-dlq`; every `SCHEDULED_TASKS` expression is a pg-boss schedule (UTC, singleton across replicas) run through `scheduled()`. New config: `JOBS_CONCURRENCY` (2), `JOBS_POLL_INTERVAL_SECONDS` (2).
- `pnpm db:migrate` (`runMigrations`) also installs the `pgboss` schema and the queues (`installJobsSchema`; `jobs: false` skips it).
- `JobsQueueNotConfiguredError` is a 503 `ServiceUnavailableError` with code `jobs_not_configured` (new in `ERROR_CODES`), not a 500.
- `installProcessPool(env, { max, prepare })` in `db/client.ts`: ONE postgres.js pool per process; `openDatabase` for the same URL returns a view whose `close()` is a no-op. New config: `DATABASE_POOL_MAX` (10), `TRUSTED_PROXY_HOPS` (0).
- The Neon serverless driver is gone: `@neondatabase/serverless`, `createNeonDatabase`/`createNeonPool`/`routeNeonThroughProxy`, `NEON_LOCAL_PROXY`, the neon-proxy image and compose profiles, `pnpm dev:db:up --neon`, `test:db:up:neon`, `GATE_SUITE_DRIVER`, the driver project's second pass, `docs/NEON-DRIVER.md`, `ws-pg-relay`. `DATABASE_DRIVER` accepts only `postgres`; `neon` fails config validation (and `bootstrap --driver neon`) naming the fix; both tomls and `launch.kit.json` say `postgres`.
- Raw arrays are parsed by the kit's own `parseArrayLiteral` (`ARRAY_PARSERS`), no longer by Neon's parsers; the conformance suite adds quoting, NULL, nesting and `bytea[]` cases and a process-pool case.
- `clientIpOf(c)` (`api/utils/routes/client-ip.ts`) is the one client-IP rule: on Node the socket peer, or the Nth `X-Forwarded-For` entry from the right behind `TRUSTED_PROXY_HOPS = N`; on the Worker `cf-connecting-ip`. `clientIp(headers)` in `rate-limit.ts` is removed.
- `HUB_HEADERS` moved to `src/platform/cloudflare/hub-headers.ts` (re-exported by the DO module) so the Node bundle never pulls `cloudflare:workers` in.
- `platform-seam.test.ts` also keeps `process`, Node server modules and `@hono/node-server` inside `src/node/`, and bans importing `src/node/` from anywhere else; `driver-results.test.ts` exempts `src/node/` and drops its Neon rules.
- A refused `localhost` connect (`AggregateError`) is classified `database_unavailable`, and `waitForDatabase` prints its inner causes.
- Agent runs on Node (M4): OpenWorkflow 0.10.1 (`src/node/runs.ts`, `src/node/runs-schema.ts`) in schema `openworkflow` is `Platform.runs`. `create` uses the requested id as the idempotency key and returns the engine's id; status maps onto `queued|running|waiting|complete|errored|terminated`; `worker`/`all` modes run `RUNS_CONCURRENCY` (new config, 4) runs at once and drain them on SIGTERM.
- `Step` gains `isControlFlow?(err)` and `waitForEvent`'s options gain `arrived?()` (`WaitForEventOptions`). `runAgentRun` rethrows engine control flow from both `catch` blocks and passes `arrived` (the row left `awaiting_input`); the Cloudflare adapter ignores both.
- `pnpm db:migrate` also installs the `openworkflow` schema (`installRunsSchema`; `runs: false` skips it).
- Realtime on Node (M5): `src/node/realtime.ts` is `Platform.realtime` in every mode. Publishing is `pg_notify('rp_realtime', …)`; `web`/`all` processes hold the `/ws` sockets (on `ws` 8.21.3) and LISTEN on one dedicated connection, so a nudge from any process reaches a socket on any pod. Same wire protocol as the DO (`ping` → `pong`), a 30 s protocol heartbeat, 1001 on shutdown, payloads over 7999 bytes dropped with a warning. New config: `DATABASE_LISTEN_URL` (optional; direct or session-mode Postgres behind PgBouncer).
- `/ws` on Node: the server runs the app inside `upgradeScope` and completes the upgrade only when `hub.accept()` recorded the member; refusals keep their statuses (401, 403, 426).
- Storage on Node (M6): `src/node/storage.ts` (`@aws-sdk/client-s3` 3.1150.0) is `Platform.storage` when `STORAGE_DRIVER=s3` and `STORAGE_BUCKET`/`STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` are set (plus `STORAGE_ENDPOINT`, `STORAGE_REGION` = `us-east-1`, `STORAGE_FORCE_PATH_STYLE`); same answers as the R2 adapter (quoted ETag, metadata-less listings, `deleteMany` in calls of ≤ 1000), metadata keys case-preserved through `x-amz-meta-rp-keys`.
- The dev and test compose files run the Versity S3 Gateway (`versity/versitygw:v1.8.0`, Apache-2.0; MinIO's images are no longer pullable anonymously): test on `:7433`, bucket `rocketpod-test` (`.env.test`); dev from `:7070`, bucket `rocketpod-dev`, started by `pnpm dev:db:up`, which writes the `STORAGE_*` lines into `.env`.
- Rate limits and operation locks on Node (M6): `src/node/limits.ts` over the new `rate_limits` and `operation_locks` tables (`RLS_REVOKED_TABLES`). Same sliding-window answers and `Retry-After` as KV, exact under concurrency (row lock), database time; a lock is one `INSERT … ON CONFLICT DO UPDATE WHERE expires_at <= now()`. `runPruneExpired` also drops expired rows of both (`rateLimitKeys`, `operationLockKeys`).
- Document conversion on Node (M6): `src/node/converter.ts` is `Platform.converter` — `unpdf` 1.8.1 (PDF → text), `mammoth` 1.13.0 (.docx → markdown), HTML stripped to text, XML/text decoded; Excel and OpenDocument answer a permanent `format: 'error'`.
- **No Cloudflare (M6b).** The Worker entry (`src/worker.ts`), `src/platform/cloudflare/`, the `NotificationsHub` Durable Object, the `AgentRunWorkflow` shim, both wrangler tomls, `worker-configuration.d.ts`, `HYPERDRIVE`, and the `wrangler`, `@cliftonc/cfld` dependencies are deleted; `tests/config/platform-seam.test.ts` now fails any Workers package, `cloudflare:*` import, Workers type, binding read or wrangler script anywhere.
- Tooling removed (M6b): `pnpm types`, `build:api`, `pnpm deploy[:staging]`, `pnpm provision` (+ `cf-provision.sh`, `scripts/provision/**`, `.provision.env.example`), `pnpm dev:tunnel` / `cfld`, `scripts/deployer.mjs` + `docs/DEPLOYER.md`, `scripts/bundle.mjs`, `.github/workflows/deploy.yml` and the `rf-provision` skill. `pnpm dev` now runs the Node server under `tsx watch` (with Vite); `pnpm build` is `build:ui` + `build:server`.
- `apps/web/.dev.vars` / `.dev.vars.example` → `apps/web/.env` / `.env.example` everywhere (scripts, bootstrap, `dev-db.mjs`, drizzle config, evals).
- Bootstrap step 8 is `ai` — one line saying which AI provider keys `.env` holds, never a failure; `--offline` / `--online` are accepted and ignored; exit 5 is gone; `ROCKETPOD_BOOTSTRAP_SKIP` names `ai` instead of `cloudflare`.
- Plugins: `bindings[]` and `workerExports` are refused at `plugin add` and failed by `plugin check` (`<id>:cloudflare-only`); the `worker-exports` barrel is gone (five barrels); a plugin's vars are environment keys (`.env.example`), its crons are registry-only.
- The upgrade manifest drops the `manual-toml` class; `isDeployable(manifest)` no longer reads tomls (the kit never deploys, a copy does).
- `launch.kit.json` keeps its Cloudflare-shaped `worker`/`release` blocks only for schema validity and says so in `$runtime`; `kit.yml` no longer runs `scripts/kit-check.mjs`.
- `.claude/rules/cloudflare.md` → `.claude/rules/runtime.md`. Client IP: without a socket address the first `X-Forwarded-For` entry; `cf-connecting-ip` is never read. The `/cdn-cgi/*` 404 handler is gone.
- Test fakes are native `Platform` implementations: `createTestEnv()` puts an in-memory platform on `env.PLATFORM` (and as getters on `env`); override a member with `{ jobs: null }`, `{ storage: null }`, `{ ai: null }`…; `MemoryStorage`, `RecordingRealtime` (`accepted[]`), `createMemoryRateLimiter`/`createMemoryLocks`; `tests/mocks/step.ts` `createFakeStep` replaces `createFakeWorkflowStep`.
- Platform AI without Workers AI (M6): chat resolves `ANTHROPIC_API_KEY` → `AI_API_KEY` (OpenAI-compatible at `AI_BASE_URL` with `AI_MODEL`, else OpenAI with `AI_MODEL` or `gpt-4.1-mini`) → Workers AI (the Worker only); embeddings resolve Workers AI (the Worker only) → `EMBEDDINGS_API_KEY` (OpenAI-compatible at `EMBEDDINGS_BASE_URL` with `EMBEDDINGS_MODEL`, else OpenAI). `readiness` mirrors both. The 503 messages name `AI_API_KEY` and no longer suggest binding Workers AI.

- Packaging (M7): a root `Dockerfile` builds ONE image (`node:24-alpine`, npm/corepack/yarn removed, non-root `node`, `HEALTHCHECK` on `/healthz`) holding only `dist/server.js`, `dist/migrate.js`, `dist/ui` and `migrations/` — no `node_modules`; `ENTRYPOINT node dist/server.js`, `CMD web`. `scripts/build-server.mjs` now also bundles `scripts/migrate-all.ts` → `dist/migrate.js`, the migrate one-shot (`db-roles` role → migrations + `pgboss` + `openworkflow` → `db-roles` grants, as `pnpm db:migrate`; `MIGRATIONS_DIR` overrides the SQL folder). `db-roles.ts` and `migrate.ts` start their CLIs only when run as `.ts`, so a bundle that imports them does not.
- `node dist/server.js worker` answers `/healthz` and `/readyz` (nothing else) on `PORT` (`startServer({ probePort })`), so a container healthcheck or a Kubernetes probe can watch a worker.
- Root `docker-compose.yml` (postgres + pgvector, Versity S3 Gateway, `migrate`, `web`, `worker`, every value defaulted, `deploy/compose.env.example` for `.env`) and `deploy/compose.single.yml` (one `all` process).
- Helm chart `deploy/helm/rocketpod`: `web` and `worker` Deployments, a migrate `pre-install,pre-upgrade` Job, Service, optional Ingress, PodDisruptionBudgets, a ConfigMap (`config:`) and Secret (`secrets:`, or `existingSecret`) whose keys are exactly `src/config.ts`'s (`tests/config/packaging.test.ts`), non-root read-only pods.
- `.github/workflows/image.yml` builds the image on every PR and push (pushes `ghcr.io/<owner>/rocketpod` on a version tag) and lints, renders and kubeconform-checks the chart. `docs/DEPLOY.md` is the container runbook (Compose, Helm, secrets, Postgres and PgBouncer requirements, scaling, rollback).

- Code and skills (M8a): the `workers_ai` provider is gone — `AI_PROVIDERS`, the settings catalog, the client adapter, pricing, `DEFAULT_MODELS.workers_ai`, `WORKERS_AI_CHAT_MODEL`, the `workers_ai_no_token_streaming` notice, `Platform.ai` and `PlatformAi`. History contracts (`ai_usage`, conversations, messages, the chat-stats model breakdown) parse `recordedAiProviderSchema`, which still accepts `workers_ai`, so old rows stay readable; `priceFor` takes a `RecordedAiProvider`.
- `DocumentConverter` is an object, `{ contentTypes, convert }`: the upload route refuses a `convert`-kind type the converter does not declare with 415 `unsupported_media_type` (`UnsupportedConversionTypeError`) before anything is stored. `DOCUMENT_UPLOAD_TYPES` drops `.xlsx`, `.xls`, `.odt` and `.ods` (no converter reads them), so the UI's accept list follows.
- The test env's model runner is a recording OpenAI-compatible endpoint (`RecordingAi`, `FAKE_MODELS_BASE_URL`) reached through `fetch`; `createTestEnv()` points `AI_*` and `EMBEDDINGS_*` at it, and `ai: null` leaves them to `process.env`.
- Skills are `rp-*` (`rp-setup`, `rp-preflight`, `rp-adapt`, `rp-how-do-i`, `rp-upgrade`, `rp-plugin`, `rp-traces`, `rp-evals`), plus the new `rp-deploy` — Compose or Helm, the secrets checklist, and a stop before anything that pushes, touches a cluster or bills.
- The drizzle migration chain is squashed: `0000_kit-baseline.sql` is the whole kit schema and `0001_plugin-example-feature-0.1.0.sql` the vendored plugin's table (so `plugin check` still finds the plugin's migration). A schema dump of a database built from them equals one built from the old 19-file chain, column order aside.
- Docs describe the container runtime (D41): `docs/CONCEPTS.md` replaces every removed-in-M6b banner with the Node design and its known gaps (pg-boss, OpenWorkflow, `ws` + NOTIFY, S3, three pools per process, no zero-key AI), and `SETUP.md`, `README.md`, `docs/ADAPTING.md`, `docs/RLS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CLAUDE.md`, `.claude/rules/*` and the per-directory guides follow; `docs/ROADMAP.md` gains a Next list.
- The test Postgres publishes host port 5533 instead of 5433 (`apps/web/docker-compose.test.yml`, `apps/web/.env.test`, `TEST_DB_PORT`, CI), so Rocketpod's tests no longer collide with a Rocketflare checkout's test database.
- Every renamed app gets its own local port block between 5600 and 6999 (`choosePortBlock` in `scripts/lib/rename-lib.mjs`, rename row (g)): its test Postgres and S3 ports are rewritten wherever they are written down, and its dev ranges start inside the block (`DEV_DB_PORT_START` / `DEV_S3_PORT_START` in `scripts/lib/bootstrap-lib.mjs`), so the kit, Rocketflare and any number of apps can test and run side by side.
- The rename moves the Helm chart directory to `deploy/helm/<slug>/` (row (h)), and the baseline migration is `0000_kit-baseline.sql`; before both, a renamed copy's gate failed (`kit.yml` "Gate on a renamed copy").
- AI models (Rocketflare `fix/current-models`): the adapters follow each model's own rules, so Claude 5.x and GPT-6 work; the `openai` provider speaks the Responses API; defaults are `claude-haiku-5-5` and `gpt-6-luna`; prices corrected.
  - New `@rocketpod/shared/ai/models`: `modelTraits(provider, model)` gives the thinking mode, what "off" sends, and whether the model takes a `temperature` or a forced `tool_choice`. The adapters, `POST /api/ai/config` and the settings form all read it.
  - Anthropic thinking per model:
    - Claude 4.5 and earlier keep `enabled` + budget.
    - 4.6+ send `adaptive`, and a stored budget is ignored.
    - "Off" sends `disabled`, `between_tools` (Sonnet 5.5), or no field on Opus 5.5 and Fable, which always think.
    - Before this, a 5.5 model answered every call with a 400.
  - Anthropic: a `temperature` is dropped where the model refuses one (4.7+, or any model while it thinks). A forced tool on Opus/Sonnet 5.5 or Fable 5.1 becomes a prompt instruction plus `tool_choice: auto`. `max_tokens` is floored at `ADAPTIVE_THINKING_MIN_MAX_TOKENS` (4096) while a model thinks.
  - First-party `openai` now calls `/v1/responses` with `store: false`, because Chat Completions cannot call tools on GPT-6 Astra or 6.1 Sol, or on Luna while it reasons. `openai_compatible` stays on Chat Completions.
  - `openai` configs now have a thinking switch. Off sends the lowest `reasoning.effort` the model takes (`none`, or `low` on Astra / 6.1 Sol / GPT-5.0–5.5 / o-series). On sends the model's default.
  - Reasoning blocks:
    - Reasoning (Claude thinking blocks, OpenAI reasoning items) rides a tool loop as an opaque `ContentBlock` of `type: 'reasoning'` and is sent back unmodified to the provider that produced it.
    - Checkpoints keep it. Chat history never stores it.
  - Each adapter recovers once from a refusal the traits misjudged, then remembers it:
    - a refused thinking value, sampling value, forced tool or effort;
    - a replayed reasoning block whose signature is refused, which is stripped for that one call.
  - Defaults and suggested models:
    - `DEFAULT_MODELS.anthropic` is `claude-haiku-5-5`, which also means the platform `ANTHROPIC_API_KEY` tier now answers with it.
    - The `openai` chat default is `gpt-6-luna`.
    - Suggestions are Haiku/Sonnet/Opus 5.5 and Fable 5.1, and Luna / 5.6 Luna / 6.1 Sol / Astra.
    - `claude-opus-4-1` (retired on the Claude API) is gone from the list.
  - Pricing (`PRICES_UPDATED` 2026-10-13):
    - Opus 4.5–4.8 dropped from $15/$75 to $5/$25. They had been priced 3× too high.
    - Every Claude 5.x model, GPT-6, GPT-5.x and their `-pro` variants now have their own entries.
    - Haiku 5.5 uses its ≤ 100k-token rate.
  - Why: `docs/CONCEPTS.md` §9, "The request body is per MODEL".
- A kit with no plugins passes its own gate. Read a flag's definition through `featureDefinition(key)` (`@rocketpod/shared/features`), never `FEATURE_FLAGS[key]`. With no plugin installed `FeatureName` is `never`, so a direct index types as `never` and `.label`/`.defaultState` stop compiling. `tests/config/features.test.ts` refuses a direct index outside plugin trees. The config tests that read `example-feature`'s files skip once it is removed.

## How to apply

1. Copy `apps/web/src/platform/` and `apps/web/src/api/middleware/platform.ts`, and register `platformMiddleware` after `configMiddleware` in `apps/web/src/api/index.ts`.
2. In every route and service of your own, replace a `c.env.<BINDING>` read with the matching `c.get('platform')` member (`jobs`, `storage`, `realtime`, `runs`, `locks`, `rateLimiter`, `ai`, `converter`).
3. In every job handler and cron task of your own, read capabilities from `ctx.platform` instead of `ctx.env.<BINDING>`.
4. In every plugin tool or agent of your own, replace `ctx.env` with `ctx.platform`, and replace a `durableObject(...)` call with a capability on `ctx.platform`.
5. Copy `apps/web/tests/config/platform-seam.test.ts`.
6. Copy `apps/web/src/node/`, `apps/web/scripts/build-server.mjs` and `apps/web/src/api/utils/routes/client-ip.ts`; add `@hono/node-server` and `esbuild` to `apps/web/package.json` and the `build:server` script; make `build` run `build:server` last.
7. Replace `apps/web/src/db/client.ts` with the kit's (one driver, `installProcessPool`, `parseArrayLiteral`), remove `@neondatabase/serverless` from `apps/web` and `apps/evals`, and set `DATABASE_DRIVER = "postgres"` in both tomls and `.env`; delete `NEON_LOCAL_PROXY` everywhere.
8. Replace any `clientIp(…)` / hand-read `cf-connecting-ip` of your own with `clientIpOf(c)`.
9. Remove the `neon` profile from `apps/web/docker-compose.{dev,test}.yml` and `--profile neon` / `GATE_SUITE_DRIVER` from your workflows.
10. Add `pg-boss` (exact `12.37.1`) to `apps/web/package.json`, copy `apps/web/src/node/jobs.ts` and `apps/web/src/node/jobs-schema.ts`, and take the kit's `apps/web/scripts/migrate.ts`, `apps/web/src/node/server.ts` and `apps/web/src/node/platform.ts`; delete `apps/web/src/node/worker-loop.ts`.
11. Run `pnpm db:migrate` once against every database so the `pgboss` schema and queues exist before a Node `worker` starts.
12. Add `openworkflow` (exact `0.10.1`) to `apps/web/package.json`, copy `apps/web/src/node/runs.ts` and `apps/web/src/node/runs-schema.ts`, and take the kit's `apps/web/src/platform/types.ts` (`Step.isControlFlow`, `WaitForEventOptions`) and `apps/web/src/api/workflows/agent-run-body.ts`.
13. In every durable-run body of your own, rethrow `step.isControlFlow?.(err)` at the top of each `catch` around a step, and pass `arrived` to each `waitForEvent` whose event can arrive before the wait.
14. Run `pnpm db:migrate` once more so the `openworkflow` schema exists before a Node `worker` starts.
15. Add `ws` (exact `8.21.3`) and `@types/ws` to `apps/web/package.json`, copy `apps/web/src/node/realtime.ts`, and take the kit's `apps/web/src/node/server.ts` and `apps/web/src/node/platform.ts`.
16. Behind PgBouncer in transaction mode, set `DATABASE_LISTEN_URL` to a direct (or session-mode) Postgres URL.
17. Add `@aws-sdk/client-s3` (exact `3.1150.0`), `unpdf` (exact `1.8.1`) and `mammoth` (exact `1.13.0`) to `apps/web/package.json`; copy `apps/web/src/node/storage.ts`, `apps/web/src/node/limits.ts` and `apps/web/src/node/converter.ts`, and take the kit's `apps/web/src/node/platform.ts`.
18. Copy `apps/web/src/db/schema/platform-limits.ts`, export it from `apps/web/src/db/schema/index.ts`, add `rate_limits` and `operation_locks` to `RLS_REVOKED_TABLES`, then run `pnpm db:generate` and `pnpm db:migrate`.
19. Take the kit's `runPruneExpired` in `apps/web/src/api/scheduled.ts` and `platformChat`/`resolveEmbeddings`/`readiness` in `apps/web/src/api/services/ai/resolve.ts`, and add the `STORAGE_*`, `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `EMBEDDINGS_BASE_URL` and `EMBEDDINGS_MODEL` keys to `apps/web/src/config.ts`.
20. Add the `s3-test` service to `apps/web/docker-compose.test.yml` and the `STORAGE_*` lines to `apps/web/.env.test`; add the `s3-dev` service and its two volumes to `apps/web/docker-compose.dev.yml` and take the kit's `apps/web/scripts/dev-db.mjs`.

21. Delete `apps/web/src/worker.ts`, `apps/web/src/platform/cloudflare/`, `apps/web/src/api/durable-objects/`, `apps/web/src/api/workflows/agent-run.ts`, `apps/web/wrangler.toml`, `apps/web/wrangler.staging.toml`, `apps/web/worker-configuration.d.ts` and `apps/web/tests/mocks/cloudflare-workers.ts`, and remove `wrangler` and `@cliftonc/cfld` from `apps/web/package.json`.
22. Rename `apps/web/.dev.vars` to `apps/web/.env` and `apps/web/.dev.vars.example` to `apps/web/.env.example`, and take the kit's `.gitignore` lines for them.
23. Take the kit's `apps/web/package.json` scripts (`dev`, `dev:api`, `typecheck`, `build`) and `apps/web/scripts/dev-server.mjs`; delete your own `deploy`, `provision`, `types` and `dev:tunnel` scripts.
24. Take the kit's `apps/web/tests/mocks/bindings.ts` and `apps/web/tests/mocks/step.ts`, and in your own tests replace a binding override (`{ FILES: undefined }`) with a platform one (`{ storage: null }`) and `stubs(env).files.objects.get(k)?.httpMetadata?.contentType` with `?.contentType`.
25. Remove `bindings` and `workerExports` from every plugin manifest of your own, and reach the capability through `ctx.platform`.
26. Take the kit's `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `deploy/` and `.github/workflows/image.yml`, then replace `rocketpod` in image names, the chart name and the compose database/bucket names with your app's.
27. Take the kit's `apps/web/scripts/build-server.mjs` and `apps/web/scripts/migrate-all.ts`, and the `.ts`-only CLI guard at the bottom of `apps/web/scripts/db-roles.ts` and `apps/web/scripts/migrate.ts`.
28. Rename every `.claude/skills/rf-*` you took from the kit to `rp-*` (directory and `name:`), copy `.claude/skills/rp-deploy/`, and add `deploy/values.local.yaml` to `.gitignore`.
29. Take the kit's `apps/web/src/api/services/ai/client.ts`, `providers.ts`, `resolve.ts` and `packages/shared/src/ai/{config,pricing,usage,chat,agui}.ts`; re-point any config row of yours that names `workers_ai` at another provider.
30. Take the kit's `DocumentConverter` shape (`apps/web/src/platform/types.ts`), `apps/web/src/node/converter.ts`, `apps/web/src/api/services/ai/{convert,ingest}.ts` and `DOCUMENT_UPLOAD_TYPES`.
31. Keep your own `apps/web/migrations/` chain — do not copy the kit's baseline into a database that already ran migrations.
32. Port `packages/shared/src/ai/models.ts` and export it from `packages/shared/src/ai/index.ts`. Port the `ADAPTIVE_THINKING_MIN_MAX_TOKENS` constant and the `DEFAULT_MODELS` / `DEFAULT_CHAT_MODELS` changes in `packages/shared/src/ai/config.ts`.
33. Port `apps/web/src/api/services/ai/client.ts` whole if it is unmodified in the copy. Otherwise port these parts:
   - `anthropicThinking`, `anthropicDefaults` and `anthropicBody` (with `AnthropicQuirks`);
   - the recovery loop in `createAnthropicChatClient`;
   - `forcedToolText`;
   - the `// ---- OpenAI Responses` section;
   - the `case 'openai'` branch of `createChatClient`, which now builds `createOpenAiResponsesClient`.
34. Add `ReasoningBlock` to the `ContentBlock` union in `apps/web/src/api/services/ai/types.ts`, and the `reasoning` variant to `contentBlockSchema` and `parseToolLoopCheckpoint` in `apps/web/src/api/services/ai/kit.ts`. In the copy, any code that switches over every `ContentBlock` type must skip or forward a `reasoning` block. It must never render one or persist it to chat history.
35. Replace the two thinking checks in `validateUpsert` (`apps/web/src/api/routes/ai-config.ts`) with the `modelTraits` versions. A budget is now required only for a model whose traits say `extended`.
36. Port the thinking block of `apps/web/src/ui/pages/settings/AiConfigModal.tsx` (`offersThinking`, `takesBudget`, and the help text for a model that always thinks).
37. Port `MODEL_PRICES` and `PRICES_UPDATED` in `packages/shared/src/ai/pricing.ts`. If the copy added prices of its own, keep them, and check each prefix against the new entries. The longest prefix wins.
38. Port the `suggestedModels` and `supportsThinking: true` changes for `openai` in `apps/web/src/api/services/ai/providers.ts`.
39. If the copy wants the platform `ANTHROPIC_API_KEY` tier to keep answering with a bigger model, set `DEFAULT_MODELS.anthropic` back to that model id (for example `claude-sonnet-5-5`) in the copy's `config.ts`. Seeded usage (`apps/web/scripts/seed.ts`) follows `DEFAULT_MODELS.anthropic`.
40. Any `openai` config row whose base URL points at an endpoint without `/v1/responses` (a proxy or gateway) must be changed to `openai_compatible` in Settings → AI before deploying. `openai` now speaks the Responses API only.
41. Port the tests:
    - `apps/web/tests/config/model-traits.test.ts` (new);
    - the "per-model rules", "OpenAI Responses client" and "provider catalog" blocks of `apps/web/tests/api/ai-client.test.ts`;
    - the new pricing case in `apps/web/tests/config/pricing.test.ts`;
    - the `reasoning` checkpoint case in `apps/web/tests/api/ai-kit.test.ts`;
    - the thinking cases in `apps/web/tests/api/ai-config.test.ts`.
42. Move the test database to host port 5533: change `5433` to `5533` in `apps/web/docker-compose.test.yml` (`ports`), `apps/web/.env.test` (`DATABASE_URL`, `APP_DATABASE_URL`), `scripts/lib/bootstrap-lib.mjs` (`TEST_DB_PORT`) and the `DATABASE_URL` lines of `.github/workflows/kit.yml` and `plugin-ci.yml`, then run `docker compose -f apps/web/docker-compose.test.yml down && pnpm test:db:up` once to republish the port.
43. A copy renamed before this release keeps the kit's local ports: give it its own by taking the kit's `scripts/lib/rename-lib.mjs` port-block functions and running `node -e "import('./scripts/lib/rename-lib.mjs').then(m => console.log(m.choosePortBlock('<slug>', () => true)))"`, then replacing its test ports (`TEST_DB_PORT`, `TEST_S3_PORT` and every mention of them) and setting `DEV_DB_PORT_START` / `DEV_S3_PORT_START` in `scripts/lib/bootstrap-lib.mjs` to the block's values.
44. A copy whose Helm chart still sits in `deploy/helm/rocketpod/` while its name is the slug: `git mv deploy/helm/rocketpod deploy/helm/<slug>`.
45. Rename `apps/web/migrations/0000_rocketpod-baseline.sql` to `0000_kit-baseline.sql` and its `tag` in `apps/web/migrations/meta/_journal.json` to match (drizzle records applied migrations by hash, so an existing database is unaffected).
46. Add `featureDefinition()` to `packages/shared/src/features.ts`, and replace every `FEATURE_FLAGS[key]` outside a plugin's own tree with `featureDefinition(key)` (the kit's are in `apps/web/src/api/{routes,services}/features.ts` and `evaluateFlag`). Take the kit's `tests/config/features.test.ts` case and the `skipIf` guards in `tests/config/{plugin-lib,surface}.test.ts`.

## Conflicts to expect

- `apps/web/src/api/types.ts` → `AppBindings` is no longer `Cloudflare.Env` → keep the neutral shape and read bindings through the platform.
- `apps/web/tests/mocks/bindings.ts` → `TestEnv` gained the `Platform` view → keep yours alongside.
- `apps/web/src/db/client.ts` → the neon half is gone → take the kit's file whole; a copy never edits it.
- `scripts/lib/test-plan.mjs` / `apps/web/tests/config/gate.test.ts` → one driver, no conformance second pass → take the kit's.
- `apps/web/migrations/` → the kit's chain is now one baseline (plus the example plugin's migration) → keep your own chain and generate the rate-limit and lock migration with `pnpm db:generate`; never copy the kit's baseline over it.

- `apps/web/tests/mocks/bindings.ts` → rewritten as an in-memory `Platform` → take the kit's whole, then re-add any fake of your own.
- `apps/web/src/api/services/ai/client.ts`: the Anthropic body builder and retry were rewritten. Re-apply any local change to the new `anthropicBody` / `recover` functions.
- `packages/shared/src/ai/pricing.ts`: the `anthropic` and `openai` tables were replaced. Merge a copy's own entries back in.
- `apps/web/tests/api/ai-client.test.ts`: the `openai` Chat Completions round-trip test now uses `openai_compatible`. Keep the new version.
- `apps/web/tests/api/{ai-config,agent-models}.test.ts`: the expected platform model is now `DEFAULT_MODELS.anthropic` instead of a literal. Keep the new version.

## Verify

1. `pnpm typecheck` passes.
2. `pnpm web test:config` passes, including `tests/config/platform-seam.test.ts`.
3. `pnpm test` passes.
4. `node scripts/plugin-api-doc.mjs --check` passes.
5. `pnpm --filter @rocketpod/web build` writes `apps/web/dist/server.js`; `node apps/web/dist/server.js all` with `DATABASE_URL` set answers `GET /healthz` and `GET /readyz` with 200.
6. `pnpm db:migrate` prints `Jobs schema (pgboss) and queues applied`; with `node apps/web/dist/server.js all` running, creating an invitation logs `jobs: done` for its `email.send` job.
7. `pnpm web test:api` passes `tests/api/node-jobs.test.ts`.
8. `pnpm db:migrate` prints `Runs schema (openworkflow) applied`; with `node apps/web/dist/server.js all` running, `POST /api/agents/runs` produces a row in `openworkflow.workflow_runs` whose steps are `claim`, `execute#0` and `finish`.
9. `pnpm web test:api` passes `tests/api/node-runs.test.ts`.
10. `pnpm web test:api` passes `tests/api/node-realtime.test.ts`.
11. With `node apps/web/dist/server.js all` running, a signed-in browser tab shows the realtime status as connected, and inviting a member refreshes the members list in a second tab.
12. `pnpm web test:api` passes `tests/api/node-platform-adapters.test.ts` with the S3 gateway up (it skips the storage cases, saying so, when the gateway is unreachable).
13. With `pnpm dev:db:up`, `pnpm db:migrate` and `node apps/web/dist/server.js all` running, uploading a PDF in Knowledge stores an object under `tenants/<id>/documents/` in the dev bucket and the document reaches `indexed` once an embeddings key is set.
14. With the Node server running, the eleventh `POST /auth/dev-login` from one IP within a minute answers 429 with a `Retry-After` header.
15. `pnpm web test:config` passes `tests/config/platform-seam.test.ts`, and `grep -rIl "@cloudflare/\|cloudflare:" --exclude-dir=node_modules apps packages` finds nothing.
16. `pnpm dev` prints `web: listening on :3001` and `dev ready`; `http://localhost:3000` renders and dev-login signs in.
17. `docker compose up -d --build` leaves `migrate` exited 0 and `web`/`worker` healthy; `http://localhost:3001/readyz` answers 200 and the UI renders.
18. `pnpm web test:config` passes `tests/config/packaging.test.ts`.
19. `pnpm web test:api` passes `tests/api/document-upload.test.ts`, including the 415 for a type the converter does not declare.
20. `pnpm plugin check` passes, and `pnpm db:generate` reports no schema changes.
21. `pnpm gate` passes.
22. `pnpm web exec vitest run --project config model-traits pricing` passes.
23. With `ANTHROPIC_API_KEY` set, `curl -b <cookie> localhost:3001/api/ai/config/readiness` reports `"model":"claude-haiku-5-5"` for chat. A chat message gets a streamed reply.
24. In Settings → AI, add an `anthropic` config with model `claude-opus-5-5`. The thinking help text says the model always reasons, and *Test connection* answers `ok: true`.
25. In Settings → AI, add an `openai` config (default model `gpt-6-luna`). *Test connection* answers `ok: true`, and a chat turn that calls `search_knowledge` completes.
