# Self-hosted runtime: Node on Docker/k8s, Postgres + object storage

Status: **adopted** (2026-10-12). This file records why Rocketpod runs as a plain Node container,
how each runtime mechanism works, and the decisions behind them (§6). The working summary is `docs/CONCEPTS.md` §3–§6 and §10; the rules are in
`.claude/rules/runtime.md`.

## 1. Decision

**The shape.** Rocketpod is one Node 24 image run under Docker Compose or Kubernetes, with Postgres
(+ pgvector) as the only platform service. Jobs, cron, durable agent runs, realtime fan-out, rate
limits and locks all live in Postgres. Two external dependencies stay, by decision (§6): an
**object store reached through the S3 API** (AWS S3, MinIO, Ceph, GCS in interoperability mode,
or any other S3-compatible store), and **a real AI provider key** (Anthropic, OpenRouter or any
OpenAI-compatible endpoint), locally as well as deployed.

**Why.** A container runs anywhere a team already runs workloads — a VM with Compose, a managed
Kubernetes cluster, an on-premises cluster — with no account on a specific edge platform and no
vendor runtime to emulate in tests. Keeping every stateful mechanism in Postgres means one backup,
one set of credentials, one place where tenant isolation (RLS, the tenant FK cascade) applies, and
work claimed by rows rather than by an in-memory map, so `web` and `worker` replicas scale freely.

**The seam.** Every runtime capability the app uses sits behind a neutral interface in
`apps/web/src/platform/types.ts`, bundled as one `Platform`; the Node adapters live in
`apps/web/src/node/`. Routes read `c.get('platform')`; queue handlers, cron tasks and the agent-run
body are handed the same object, and plugins get it as `ctx.platform`.
`tests/config/platform-seam.test.ts` keeps edge-runtime types and imports out of the tree, and
`tests/mocks/bindings.ts` carries the in-memory implementations the api tests use.

## 2. Mechanisms at a glance

| Capability | Semantics | Node mechanism |
|---|---|---|
| HTTP + static UI | SPA fallback to `index.html`; API paths (`isApiPath`) get a JSON 404 | `@hono/node-server` + static `dist/ui` (`src/node/server.ts`, `src/node/assets.ts`) |
| Jobs (`platform.jobs`) | At-least-once; `delaySeconds` (≤ 12 h); batches of 10; `retry` with 30 s doubling backoff (cap 15 min); 3 retries, then a dead-letter queue | **pg-boss** (`src/node/jobs.ts`); the consumer wraps each job as `{ body, attempts, ack, retry }` for `processJobsBatch` |
| Cron | `SCHEDULED_TASKS` keyed by cron expression (core `0 4 * * *`, plus plugin crons); one run per occurrence | pg-boss schedules, singleton across replicas, calling `dispatchScheduled` |
| Durable agent runs (`platform.runs`) | Steps checkpointed by name and replayed; per-step retries and timeout; `waitForEvent` parks up to `AGENT_INTERRUPT_TIMEOUT` (168 h); `status`, `terminate`, `sendEvent`; restart as `<runId>-rN` | **OpenWorkflow** in the `openworkflow` schema (`src/node/runs.ts`, §3.3) |
| Realtime (`platform.realtime`) | Per-tenant fan-out to a user, a set of users or a topic; best effort ("DB is truth, WS is a nudge") | `ws`, an in-process tenant → socket map, cross-process fan-out over `LISTEN/NOTIFY` (`src/node/realtime.ts`, §3.4) |
| Files (`platform.storage`) | Tenant-prefixed keys, content type + custom metadata, quoted ETag, upload date, cursor listing, `deleteMany` ≤ 1000, streamed and ranged downloads | `StorageService` over the S3 API (`src/node/storage.ts`, `@aws-sdk/client-s3`, §3.5) |
| Rate limit + operation locks | Sliding window per `rl:<name>:<ip>` (auth: 10 per 60 s, `Retry-After`); `operationLock` with a 600 s TTL safety net, 409 `operation_in_progress` | `rate_limits` and `operation_locks` tables with atomic upserts (`src/node/limits.ts`); the prune cron cleans both |
| Post-response work (`defer`) | DB close, auth sliding expiry, tracer flush, activity writes, realtime nudges | A tracked promise set, drained on SIGTERM (`src/node/defer.ts`) |
| Document conversion | PDF/Office → markdown for `document.convert` | `unpdf` (PDF) and `mammoth` (docx), plus passthrough for text/markdown (`src/node/converter.ts`) |
| Database | Connection reuse, per-request tenant scope | postgres.js with **one pool per process** (`DATABASE_POOL_MAX`, prepared statements on); `openDatabase` hands out views of it |
| Client IP | Rate limits and auth audit | `x-forwarded-for`, trusting `TRUSTED_PROXY_HOPS` proxies |
| Config | Typed vars and secrets | `loadConfig(process.env)` (zod) plus the `Platform` object |

## 3. The adapters

### 3.1 Entry point and processes

`src/node/server.ts` builds the `Config` with `loadConfig(process.env)` and the Node `Platform`. The
same image runs in one of three modes:

- **`web`**: Hono on `@hono/node-server`, static UI, `/ws`, `/healthz` and `/readyz`.
- **`worker`**: the pg-boss consumer (jobs, cron) and the OpenWorkflow worker (agent runs).
- **`all`**: both in one process, for small installs and local dev.

Every mode handles SIGTERM: stop accepting work, drain the `defer` set and in-flight jobs, then
close the pool.

**Tenant scope is safe on a shared pool.** `withTenantScope` sets `app.tenant_id` with
`set_config(..., true)` inside a transaction (`src/db/tenant-scope.ts`), so nothing leaks between
requests on a pooled connection.

### 3.2 Jobs and crons: pg-boss

- pg-boss owns its schema (`pgboss.*`), installed by its own `pnpm db:migrate` step.
- The producer maps `delaySeconds` → `startAfter`, and `sendBatch` → `insert`.
- The consumer fetches up to 10, wraps each job as `{ body, attempts, ack, retry(delay) }` and calls
  `processJobsBatch`. The retry policy and dead-letter queue are configured per queue, and
  plugin job handlers are untouched.
- Cron goes through pg-boss schedules → `dispatchScheduled`. pg-boss guarantees a single run across
  replicas, so no k8s CronJob is needed.

### 3.3 Agent runs: OpenWorkflow (spike, 2026-10-12)

The business state of a run is in Postgres (`agent_runs` with claim, checkpoint and
`cancelRequestedAt`, `agent_run_effects` via `runOnce`, and `agent_run_interrupts`; see
`src/api/workflows/CLAUDE.md`). OpenWorkflow adds durable replay. The spike read
`openworkflow@0.10.1` (Apache-2.0, pinned exactly) from its shipped types and source, not its docs.
Answers:

| Question | Answer |
|---|---|
| In-process worker? | **Yes.** `ow.newWorker({ concurrency })` → `start()` / graceful `stop()` (waits for active runs). It polls (100 ms doubling to 1 s, jittered) and heartbeats a 30 s lease. The CLI is not needed. |
| Status by run id? | **Yes**, through the backend: `backend.getWorkflowRun({ workflowRunId })`. Statuses: `pending`, `running`, `sleeping` (legacy), `completed`/`succeeded`, `failed`, `canceled`. A PARKED run stays `running` with `workerId` NULL and `availableAt` in the future. |
| Cancel a run waiting on a signal? | **Yes.** `cancelWorkflowRun` takes `pending`/`running`, and a parked run is `running`. A run mid-step finishes that step and starts no other (its lease fence trips). Cancelling a completed or failed run throws; an already-cancelled one is a no-op. |
| Does `sendSignal` report recipients? | **Yes**, `{ workflowRunIds }` — the runs whose running `signal-wait` step took it. Empty means nobody was waiting, and the signal is dropped (NOT buffered). |
| Custom run ids / idempotency? | **No custom ids**: the engine generates them (TEXT). `runWorkflow(spec, input, { idempotencyKey })` returns the existing run for the same key for 24 h. The kit's requested id (`<runId>`, `<runId>-rN`) becomes the key, and the engine's id is what `agent_runs.instanceId` stores. |
| Existing postgres.js client? | **Yes**: `BackendPostgres.fromPool(sql, { schema })`. It expects camel-cased columns (`transform.column.from = postgres.toCamel`), and the kit builds that pool itself. It is a separate small pool (`RUNS_CONCURRENCY + 4`), because the backend reserves a connection per transaction. |
| Migrations with `runMigrations: false` + an explicit call? | `fromPool` never migrates. `BackendPostgres.connect(url, { runMigrations: true })` does, and `installRunsSchema` (the `pnpm db:migrate` step) calls it once and closes. No `web`/`worker` boot migrates. |
| Step timeout inside `step.run`? | No native option. A `Promise.race` around `fn` inside `step.run` works. The losing promise keeps running. |
| Replay model? | The body re-executes from the top and completed steps return their recorded output. **Engine specifics:** (1) a failing step reschedules the WHOLE run, and the error never reaches the body's `catch` until attempts run out; (2) a park (`waitForSignal`, `sleep`) is a THROWN `SleepSignalError`; (3) a repeated step name is auto-suffixed (`name:1`) rather than replaying the first result; (4) signals are not buffered; (5) a 1000-attempt cap per run. |

**Verdict: go.** Each engine specific is absorbed in the adapter (`openWorkflowStep`), so the body
runs on the neutral `Step` API:

1. **Retries run in-process inside one `step.run`**, under the step's own policy
   (default: 5 retries, 10 s exponential, 10 min timeout). A final failure is RECORDED as the step's
   output (`{ __stepFailed }`), and the adapter throws it, so a replay throws the same error rather
   than re-running a step that already gave up.
2. **`Step.isControlFlow(err)`** names the engine's steering errors. The body rethrows them from its
   `catch` blocks, so a park is never mistaken for a timeout.
3. **The unbuffered-signal race** is closed from both sides. `waitForEvent` takes an `arrived()`
   check, run once as a checkpointed step before parking (the row already left `awaiting_input`).
   `RunInstance.sendEvent` re-sends for up to 5 s while the run is alive but not yet waiting. It
   throws for a terminal run, so the caller restarts it.
4. A timed-out `waitForSignal` (`null`) is thrown as `workflow.wait_for_event_timeout`, which is
   what the body's `catch` expects.

**Not wired:** OpenWorkflow's dashboard (no authentication) and its OpenTelemetry spans.

### 3.4 Realtime: `ws` + LISTEN/NOTIFY

- `/ws` does the auth and membership check in `src/api/routes/ws.ts`, and the hub accepts the
  socket in-process.
- Each `web` process keeps `Map<tenantId, Set<socket>>`, tagging each socket with its user. It
  pings every 30 s and drops dead sockets.
- `Broadcaster.toTenant/toUser/toUsers/toTopic` → `pg_notify('rp_realtime', json)`. Every process
  `LISTEN`s on **one dedicated, non-pooled connection** and delivers to its local sockets. Payloads
  are nudges, well under NOTIFY's 8 KB limit; anything larger goes in a row with the nudge carrying
  its id.
- Delivery is best effort; the client refetches from the DB.

### 3.5 Files: S3-compatible object storage

- The S3 adapter implements `StorageService` with `@aws-sdk/client-s3`, configured by
  `STORAGE_DRIVER=s3` and the `STORAGE_*` vars. Mapping:
  - `put` → `PutObject`, with `ContentType` and custom metadata (`x-amz-meta-*`)
  - `putStream` → a multipart upload, aborted if the stream errors
  - `get` → `GetObject`, streamed, with an optional `Range`
  - `head` → `HeadObject`
  - `delete` → `DeleteObject`
  - `deleteMany` → `DeleteObjects` (≤ 1000)
  - `listPage` → `ListObjectsV2` with `ContinuationToken` as the cursor
- **One adapter covers most stores.** AWS S3, MinIO, Ceph/RGW, GCS in interoperability mode and
  other S3-compatible stores differ only by endpoint and path style. A store that does not speak
  the S3 API (Azure Blob) is one more `StorageService` implementation.
- Keys are tenant-prefixed, and downloads are streamed through the server. Presigned URLs are a
  possible later optimisation. The ETag is normalised to the quoted, HTTP-ready form.
- **Local and CI:** the compose files run the Versity S3 Gateway (`versity/versitygw`, Apache-2.0)
  with a bucket created on start — MinIO's images are no longer pullable anonymously. The in-memory
  `MemoryStorage` fake serves the api tests.

### 3.6 Small adapters

- **Rate limit:** `insert ... on conflict do update` over a window row, holding the row lock, so N
  concurrent requests from one key admit exactly `max`. Time is the database's.
- **Lock:** a row in `operation_locks` with `expires_at`; one statement inserts it or reclaims an
  expired one.
- **`defer`:** a tracked promise set, with errors logged.
- **Document converter:** `unpdf` and `mammoth` behind `DocumentConverter`, selected by MIME type,
  matching `canConvert` in `src/api/services/ai/convert.ts`.
- **AI provider:** platform chat resolves `ANTHROPIC_API_KEY`, then `AI_API_KEY` (OpenAI-compatible
  at `AI_BASE_URL` with `AI_MODEL`, e.g. OpenRouter); platform embeddings resolve
  `EMBEDDINGS_API_KEY` (OpenAI, or OpenAI-compatible at `EMBEDDINGS_BASE_URL` with
  `EMBEDDINGS_MODEL`). The endpoint must honour `dimensions: 1024`. No key means 503;
  `scripts/bootstrap.mjs` asks for a key in its secrets step, and tests use recorded fakes, so the
  gate needs no key.
- **Database:** `openDatabase` returns a view of the process pool whose `close()` is a no-op; the
  pool closes on shutdown. The driver guard (`driver-results.test.ts`) holds app code to `rows()` /
  `affected()`.

## 4. Deploy and tooling

- A multi-stage `Dockerfile`: `pnpm build` (Vite UI + server bundle) → `node dist/server.js` on a
  non-root `node:24-alpine` base; `node dist/migrate.js` is the one-shot migrate.
- `docker-compose.yml`: `postgres` (pgvector 17), the S3 gateway (+ bucket init), `migrate`
  (one-shot), `web`, `worker`; `deploy/compose.single.yml` runs one `all` process.
- A Helm chart (`deploy/helm/rocketpod`): `web` and `worker` Deployments, a migrate `Job` as a
  pre-install/pre-upgrade hook, a Service, an Ingress with WebSocket upgrade, a Secret
  (`DATABASE_URL`, `STORAGE_*` credentials, AI provider keys, `RESEND_API_KEY`, OAuth secrets) and a
  ConfigMap (the vars), a PodDisruptionBudget, liveness on `/healthz` and readiness on `/readyz`.
- `rp-deploy`: Compose or Helm, a values file, a secrets checklist.
- **Dev:** `pnpm dev` runs the Node server in `all` mode under `tsx watch`, plus Vite; `.env` holds
  local config.
- **`process.env`** is read in exactly two places, the config loader and the entry point
  (`.claude/rules/runtime.md`).
- **Plugins (D31):** `crons` and `apiPrefixes` are registry-only, and `vars` go into the ConfigMap
  or Secret. A plugin that uses only the neutral context installs unchanged; one that declares
  platform `bindings` or `workerExports` is refused as `<id>:cloudflare-only`.
- **Integration tests** against the test Postgres cover pg-boss retry, backoff and the dead-letter
  queue; step replay after a simulated crash; a `waitForEvent` timeout and resume; NOTIFY fan-out
  across two hub instances; a storage round-trip, metadata, listing and `deleteMany`; a race on the
  rate limit and on the lock.

## 5. Verification

- `pnpm gate` passes, adapter integration tests included.
- `docker compose up` with an AI key (and an embeddings key) in `.env`, then:
  - sign in with dev-login
  - upload a PDF → stored in the S3 gateway → converted → indexed → found by chat
  - start an agent run that interrupts → resume it from the UI
  - kill `worker` mid-run → it restarts and resumes from the last completed step without repeating
    an effect (`agent_run_effects`)
- **Storage portability:** the same upload against two S3-compatible stores, changing only the
  `STORAGE_*` vars.
- **Realtime across processes:** two `web` replicas behind a proxy; an activity in one tab nudges a
  tab connected to the other replica.
- **k8s (kind + Helm):** the migrate Job runs once; the daily cron fires once with three `worker`
  replicas; a rolling restart drops no jobs (SIGTERM drain).

## 6. Decisions and risks

**Decided (2026-10-03):**

1. **Files go to an S3-compatible object store**, not Postgres, through one adapter (§3.5). This
   keeps large binaries out of backups and WAL.
2. **Agent runs use a durable-execution engine over Postgres.** The kit keeps run state in Postgres,
   so the engine only has to replay steps; OpenWorkflow does that from its own schema (§3.3). The
   integration tests in §4 cover replay, timeout, resume and terminate.
3. **Realtime uses LISTEN/NOTIFY on a dedicated connection.** PgBouncer in transaction mode breaks
   `LISTEN`, so the deployment docs require that connection to go direct to Postgres (or through a
   pooler in session mode). A separate `DATABASE_LISTEN_URL` is optional.
4. **A real AI key is expected locally.** Anthropic, OpenRouter or any OpenAI-compatible endpoint
   (§3.6). There is no local model and no zero-key mode. The gate stays key-free because tests use
   fakes.

**Remaining risks:**

1. **Plugins that declare platform bindings or exported runtime classes.** `plugin check` refuses
   them as `<id>:cloudflare-only`; such a plugin needs a release that uses only the neutral context.
2. **Embeddings provider choice.** Anthropic has no embeddings API, so an Anthropic-only install
   still needs an OpenAI-compatible embeddings key for knowledge features. A provider that cannot
   return 1024 dimensions needs a vector-column migration.
