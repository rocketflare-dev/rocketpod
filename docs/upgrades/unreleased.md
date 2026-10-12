---
version: unreleased
previous: 0.1.0
date: null
breaking: true
migrations: ["pgboss schema + queues (pg-boss, installed by pnpm db:migrate)", "openworkflow schema (OpenWorkflow, installed by pnpm db:migrate)"]
areas: [api, db, config, shared, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
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

## How to apply

1. Copy `apps/web/src/platform/` and `apps/web/src/api/middleware/platform.ts`, and register `platformMiddleware` after `configMiddleware` in `apps/web/src/api/index.ts`.
2. In every route and service of your own, replace a `c.env.<BINDING>` read with the matching `c.get('platform')` member (`jobs`, `storage`, `realtime`, `runs`, `locks`, `rateLimiter`, `ai`, `converter`).
3. In every job handler and cron task of your own, read capabilities from `ctx.platform` instead of `ctx.env.<BINDING>`.
4. In every plugin tool or agent of your own, replace `ctx.env` with `ctx.platform`, and replace a `durableObject(...)` call with a capability on `ctx.platform`.
5. Copy `apps/web/tests/config/platform-seam.test.ts` and add any Worker class of your own to its `ALLOWED` list.
6. Copy `apps/web/src/node/`, `apps/web/scripts/build-server.mjs` and `apps/web/src/api/utils/routes/client-ip.ts`; add `@hono/node-server` and `esbuild` to `apps/web/package.json` and the `build:server` and `dev:node` scripts; make `build` run `build:server` last.
7. Replace `apps/web/src/db/client.ts` with the kit's (one driver, `installProcessPool`, `parseArrayLiteral`), remove `@neondatabase/serverless` from `apps/web` and `apps/evals`, and set `DATABASE_DRIVER = "postgres"` in both tomls and `.dev.vars`; delete `NEON_LOCAL_PROXY` everywhere.
8. Replace any `clientIp(…)` / hand-read `cf-connecting-ip` of your own with `clientIpOf(c)`.
9. Remove the `neon` profile from `apps/web/docker-compose.{dev,test}.yml` and `--profile neon` / `GATE_SUITE_DRIVER` from your workflows.
10. Add `pg-boss` (exact `12.37.1`) to `apps/web/package.json`, copy `apps/web/src/node/jobs.ts` and `apps/web/src/node/jobs-schema.ts`, and take the kit's `apps/web/scripts/migrate.ts`, `apps/web/src/node/server.ts` and `apps/web/src/node/platform.ts`; delete `apps/web/src/node/worker-loop.ts`.
11. Run `pnpm db:migrate` once against every database so the `pgboss` schema and queues exist before a Node `worker` starts.
12. Add `openworkflow` (exact `0.10.1`) to `apps/web/package.json`, copy `apps/web/src/node/runs.ts` and `apps/web/src/node/runs-schema.ts`, and take the kit's `apps/web/src/platform/types.ts` (`Step.isControlFlow`, `WaitForEventOptions`) and `apps/web/src/api/workflows/agent-run-body.ts`.
13. In every durable-run body of your own, rethrow `step.isControlFlow?.(err)` at the top of each `catch` around a step, and pass `arrived` to each `waitForEvent` whose event can arrive before the wait.
14. Run `pnpm db:migrate` once more so the `openworkflow` schema exists before a Node `worker` starts.

## Conflicts to expect

- `apps/web/src/api/types.ts` → `AppBindings` is no longer `Cloudflare.Env` → keep the neutral shape and read bindings through the platform.
- `apps/web/tests/mocks/bindings.ts` → `TestEnv` gained the `Platform` view → keep yours alongside.
- `apps/web/src/db/client.ts` → the neon half is gone → take the kit's file whole; a copy never edits it.
- `scripts/lib/test-plan.mjs` / `apps/web/tests/config/gate.test.ts` → one driver, no conformance second pass → take the kit's.

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
