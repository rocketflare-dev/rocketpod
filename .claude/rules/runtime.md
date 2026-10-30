---
paths:
  - apps/web/src/node/**
  - apps/web/src/platform/**
  - apps/web/src/config.ts
  - apps/web/src/api/queue.ts
  - apps/web/src/api/scheduled.ts
  - apps/web/src/api/workflows/**
  - apps/web/scripts/**
  - apps/web/.env.example
---

# The runtime (Node in a container)

One image, one Node 24 process per container, in one of three modes (`src/node/server.ts`):
`web` (Hono on `@hono/node-server`, the UI from `dist/ui`, `/ws`, `/healthz` + `/readyz`),
`worker` (pg-boss jobs and cron, OpenWorkflow agent runs) or `all` (both — dev and small installs).
Every runtime capability comes through the `Platform` (D41) — never a binding read off an env or an
edge-runtime package or type; `tests/config/platform-seam.test.ts` fails any. Design:
`docs/DESIGN-SELFHOSTED.md`.

## Configuration

- `process.env` is read in exactly two places: `src/config.ts` (`loadConfig(env)`, a zod parse of a
  plain object) and `src/node/` (the entry). Everything else reads `c.get('config')` or is handed a
  `config`. The seam test fences `process`, Node's server modules and `@hono/node-server` into
  `src/node/`, and nothing outside it may import it
- Locally the values live in `apps/web/.env` (git-ignored; `.env.example` is the committed template,
  `.env.test` the test values). `scripts/dev-db.mjs` writes `DATABASE_URL` and `STORAGE_*` into
  `.env` for THIS checkout's containers
- A new var: the `config.ts` schema, `.env.example`, and the deployment's environment

## The platform

Every runtime capability is a member of the `Platform` (`src/platform/types.ts`), built once by the
entry (`src/node/platform.ts`) and read as `c.get('platform')` / `ctx.platform`:

| Member | Node adapter |
|---|---|
| `jobs` | pg-boss producer (`src/node/jobs.ts`); the consumer runs `processJobsBatch` |
| `runs` | OpenWorkflow (`src/node/runs.ts`) driving `runAgentRun` (`api/workflows/agent-run-body.ts`) |
| `realtime` | `ws` on `/ws` + Postgres LISTEN/NOTIFY fan-out (`src/node/realtime.ts`): per tenant, per user, or per subscribed TOPIC (`toTopic`, gated by `canSubscribeTopic`) |
| `storage` | any S3-compatible store (`src/node/storage.ts`, `STORAGE_*`): ranged `get` (`StorageRange` → `StoredRange`, `StorageRangeNotSatisfiableError`), multipart `putStream` (`@aws-sdk/lib-storage`, pinned to `client-s3`'s version) |
| `rateLimiter`, `locks` | Postgres tables `rate_limits`, `operation_locks` (`src/node/limits.ts`) |
| `converter` | unpdf / mammoth (`src/node/converter.ts`) |
| `guide` | the Guide's pages and images under `content/guide` (`src/node/guide-content.ts`; cached when `NODE_ENV=production`, re-read in dev). A `web`/`all` boot also loads the pages into `guide_chunks` in the defer set (`loadGuide: false` in tests) |

There is no `ai` member: the provider keys (`ANTHROPIC_API_KEY`, `AI_*`, `EMBEDDINGS_*`) cover AI.
A null member is a configuration state the callers already answer (503 `*_not_configured`, a no-op
nudge), never a crash.

## Rules

- **Routes enqueue, never run**: long work → `platform.jobs` or `platform.runs`; post-response work
  through `waitUntil` (`deferOrAwait`), which the Node entry tracks and drains on SIGTERM
- **Concurrency is a DB claim row or a lock**, never an in-process `Map` — replicas share nothing but
  Postgres
- **Cron**: a task registered in `SCHEDULED_TASKS` (`api/scheduled.ts`) under its expression IS
  scheduled — pg-boss runs each occurrence once across replicas. No other file lists crons
- **One database pool per process** (`DATABASE_POOL_MAX`); `openDatabase(config)` returns a view
  over it whose `close()` is a no-op. pg-boss and OpenWorkflow keep their own small pools, and the
  realtime listener holds one direct connection (`DATABASE_LISTEN_URL` behind PgBouncer)
- **Client IP** comes from the socket, or the Nth `X-Forwarded-For` entry with `TRUSTED_PROXY_HOPS`
  (`api/utils/routes/client-ip.ts`)
- **A durable run body** re-executes from the top on every resume: side effects only inside
  `step.do`, unique step names (carry the round), and `if (step.isControlFlow?.(err)) throw err` in
  every catch around a wait
- **Shutdown**: SIGTERM stops accepting, closes sockets (1001), drains jobs, runs and the defer set,
  then closes the pool

## Commands

`pnpm dev` (Node under `tsx watch` :3001 + Vite :3000) · `pnpm web dev:api` (the server alone,
unfiltered) · `pnpm build` (`vite build` + `scripts/build-server.mjs` → `dist/server.js`) ·
`node dist/server.js [web|worker|all]` · `pnpm db:migrate` (app migrations + the `pgboss` and
`openworkflow` schemas). Container image, Compose and Helm: `docs/DEPLOY.md`.
