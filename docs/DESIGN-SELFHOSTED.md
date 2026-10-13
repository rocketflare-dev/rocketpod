# Self-hosted runtime: Node on Docker/k8s, Postgres + object storage (proposal)

Status: **adopted as Rocketpod** (2026-10-12). Written in Rocketflare as a proposal; Rocketpod is the
resulting hard fork. Phase 1 (§4) now happens in this repository rather than in Rocketflare, and the
upgradability constraints toward Rocketflare no longer apply (`docs/FORK.md`). Agent runs use
OpenWorkflow rather than the hand-rolled engine of §5.3 (`docs/ROADMAP.md` M4). The milestones are in
`docs/ROADMAP.md`.

This file records the question, the survey of the Cloudflare coupling (2026-10-03, kit 0.16.0),
the recommended shape, and the decisions taken on it (§7).

## 1. Decision

**The question.** Could Rocketflare run as a plain Node container under Docker Compose or
Kubernetes, with Postgres (+ pgvector) as the only platform service? That means no KV, no Queues,
no Durable Objects, no Workflows and no Workers AI. Two external dependencies stay, by decision
(§7): an **object store reached through the S3 API** (AWS S3, R2, MinIO, GCS…, or Azure Blob through
its own adapter), and **a real AI provider key** (Anthropic, OpenRouter or any OpenAI-compatible
endpoint), locally as well as deployed.

**The answer: yes, as a fork, with the kit's seams hardened first.**

- **Not both platforms in one repo.** At runtime a second platform would be cheap: §2 shows the
  seams already exist. Everything around the runtime is Cloudflare-shaped, though: both tomls and
  their parity test, `pnpm provision` and `cf-provision.sh`, the plugin `bindings[]` model (D31),
  `rf-provision`, `docs/DEPLOY.md`, SETUP Part 3, and the `manual-toml` class in the upgrade
  manifest. Supporting both would double each of those and the gate. D35 shows what a dual seam
  costs, and that seam is one file (`apps/web/src/db/client.ts`). This one would be every binding.
- **A fork, but not a clean-room one.** Phase 1 (§4) lands in the **kit**. It makes the seams
  platform-neutral so that no Cloudflare type escapes them. The fork then replaces adapters and the
  entry point, and keeps every interface name. That is what keeps `/rp-upgrade` working: a later
  kit release that touches routes, services, the UI or the CLI ports into the fork just as it ports
  into any copy. A release aimed at tomls, provisioning or Durable Objects lands on a surface the
  fork deleted, and the manifest already knows to skip those (§6).

## 2. What is already portable

The survey found the coupling much narrower than the README suggests:

- **Tests already run on plain Node.** There is no miniflare, no `@cloudflare/vitest-pool-workers`
  and no `cloudflare:test`. `apps/web/vitest.config.ts` runs the `api*`, `driver` and `config`
  projects in Node and points `cloudflare:workers` at `tests/mocks/cloudflare-workers.ts`.
  `tests/mocks/bindings.ts` hand-writes every binding: `MemoryKV`, `RecordingQueue`,
  `MemoryR2Bucket`, `RecordingDurableObjectNamespace`, `RecordingAi`, `RecordingWorkflow` and
  `createExecutionContext`. Those fakes are already the contract each Node adapter has to meet.
- **The Hono app is importable from Node.** `src/api/index.ts` has no platform imports. The
  Durable Object and Workflow classes are exported only from `src/worker.ts`.
- **Only three files import `cloudflare:workers`:**
  - `src/api/durable-objects/notifications-hub.ts`
  - `src/api/workflows/agent-run.ts`
  - `src/plugins/api/workflow.ts` (types only)
- **Most bindings already sit behind a kit interface:**

  | Binding | Seam |
  |---|---|
  | `FILES` (R2) | `StorageService`, `src/api/services/storage.ts`; `createR2Storage` is the only adapter |
  | `JOBS_QUEUE` | `JobsQueue`, `src/api/services/jobs.ts`; consumer `processJobsBatch`, `src/api/queues/jobs.ts` (a plain function over the batch) |
  | `NOTIFICATIONS_HUB` | `Broadcaster`, `src/api/services/realtime.ts` (the only module touching the binding); `src/plugins/api/realtime-step.ts` for background contexts |
  | `AGENT_RUN_WORKFLOW` | `AgentRunWorkflowBinding`, `src/api/services/agents/runs.ts` |
  | `RATE_LIMIT_KV` | `RateLimitKv`, `src/api/middleware/rate-limit.ts` (a missing binding is a no-op) |
  | `AI` | `WorkersAiBinding`, `src/api/services/ai/types.ts`; already optional (`services/ai/resolve`) |
  | `ctx.waitUntil` | `deferOrAwait`, `src/api/middleware/database.ts`; awaits inline when there is no `ExecutionContext` |
  | `HYPERDRIVE` / neon | `openDatabase`, `src/db/client.ts`; the `postgres` driver is postgres.js over TCP |

- **The rest is already fetch or Node-native.** Anthropic/OpenAI-compatible AI, Resend email,
  OTLP tracing, OAuth/OIDC, `crypto.subtle` and `AsyncLocalStorage` all qualify. `loadConfig(env)`
  is a zod parse of a plain object, so `process.env` works as-is. Migrations, seed and the other
  scripts already run under `tsx`.
- **Tenant scope is safe on a shared pool.** `withTenantScope` sets `app.tenant_id` with
  `set_config(..., true)` inside a transaction (`src/db/tenant-scope.ts`), so nothing leaks between
  requests on a pooled connection.

## 3. Inventory: what each Cloudflare piece provides, and its replacement

| Piece | Semantics to reproduce | Replacement |
|---|---|---|
| Worker `fetch` + `ASSETS` | SPA served with `not_found_handling = single-page-application`; API paths (`isApiPath`) get a JSON 404 | `@hono/node-server` + `serveStatic('dist/ui')`, falling back to `index.html` for non-API GETs; new `src/server.ts` replaces `src/worker.ts` |
| `JOBS_QUEUE` + `queue()` | At-least-once; `delaySeconds` (≤ 12 h); batches of 10; `message.retry` with 30 s doubling backoff (cap 15 min); `max_retries = 3` then drop; poison messages acked | **pg-boss**: `send` with `startAfter`, `retryLimit 3`, `retryBackoff`, a dead-letter queue (an improvement: today's DLQ is commented out). A thin wrapper gives `processJobsBatch` the same `{ body, attempts, ack, retry }` shape |
| `scheduled()` crons | `SCHEDULED_TASKS` keyed by cron expression (core `0 4 * * *`, plus plugin crons); exactly one run | pg-boss `schedule()`, which is singleton across replicas, calling the existing `dispatchScheduled` |
| `AGENT_RUN_WORKFLOW` | `step.do` results checkpointed by name and replayed; per-step retries (2, exponential) and timeout (10 min); `waitForEvent` parks up to `AGENT_INTERRUPT_TIMEOUT` (168 h); external `status`, `terminate`, `sendEvent`; restart as `<runId>-rN` | A hand-rolled Postgres step engine (§5.3) |
| `NOTIFICATIONS_HUB` + `/ws` | Per-tenant fan-out, addressing a user or a set of users; ping/pong without waking; best effort ("DB is truth, WS is a nudge") | `ws` via `@hono/node-ws`; an in-process tenant → socket map tagged by user; cross-pod fan-out with Postgres `LISTEN/NOTIFY` (§5.4) |
| `FILES` (R2) | Tenant-prefixed keys, content type plus custom metadata, quoted ETag, upload date, cursor listing, `deleteMany` ≤ 1000, streamed downloads (no presigned URLs) | A `StorageService` over the S3 API (`@aws-sdk/client-s3`), configured by endpoint, so S3, R2, MinIO and GCS all work; Azure Blob as a second adapter (§5.5) |
| `RATE_LIMIT_KV` | Sliding window per `rl:<name>:<ip>` (auth: 10 per 60 s, `Retry-After`); `operationLock` with a 600 s TTL safety net, 409 `operation_in_progress` | `rate_limits` and `operation_locks` tables with atomic upserts, which is stricter than KV (KV is not atomic); the prune cron cleans both |
| `ctx.waitUntil` | Post-response work: DB close, auth sliding expiry, tracer flush, activity writes, realtime nudges | `defer` adds the promise to a tracked set, and the set is drained on SIGTERM |
| Workers AI chat / embeddings | The zero-key default: platform chat falls back to it, and so do embeddings (`@cf/baai/bge-m3`, **1024 dims**) | Remove the provider. A real key is expected everywhere, local included; platform-level OpenAI-compatible settings let that key be OpenRouter or similar (§5.6). Embeddings stay 1024-dim (`dimensions: 1024` is already sent) |
| `AI.toMarkdown` | PDF/Office → markdown for `document.convert` | `unpdf` (PDF) and `mammoth` (docx), plus passthrough for text/markdown, behind a converter interface. **This is the only capability with no fallback today** |
| `HYPERDRIVE` / neon driver | Connection pooling at the edge | Removed. postgres.js with **one pool per process** (`max` from env, `prepare: true`) in place of a client per request |
| `cf-connecting-ip` | Client IP for rate limits and auth audit | `x-forwarded-for`, with a `TRUSTED_PROXY_HOPS` setting (2 call sites: `rate-limit.ts`, `routes/auth/helpers.ts`) |
| `Cloudflare.Env` / `worker-configuration.d.ts` | Typed bindings and vars | `Config` (zod) plus a `Platform` object (§4); the generated file is deleted |

None of these are used, so none need replacing: the `caches` API, Analytics Engine, Cloudflare
email, the native rate-limit binding, `HTMLRewriter`, `request.cf`.

## 4. Phase 1 (in the kit): platform-neutral seams

The aim is that no Cloudflare type escapes a seam. This is good kit hygiene in its own right, and it
ships as an ordinary kit release with an `unreleased.md` note.

- **`src/platform/`** gets neutral interfaces:
  - `Storage`: today's `StorageService`.
  - `Jobs`: producer plus a consumer-message shape.
  - `Realtime`: `Broadcaster`.
  - `RunEngine`: `create`, `get`, `status`, `terminate`, `sendEvent`, plus a step API (`do`, `waitForEvent`) for workflow bodies.
  - `Locks` and `RateLimit`.
  - `defer`.
  - `DocumentConverter`.
- **A `Platform` object built once per entry point.** `worker.ts` builds the Cloudflare adapters
  from `env`. Routes read `c.get('platform')` in place of `c.env.FILES`, `c.env.JOBS_QUEUE` and the
  rest. About 54 `c.env` reads change, and the 11 files that name `AppBindings`/`Cloudflare.Env`
  change too. `MessageBatch`, `R2Bucket`, `DurableObjectStub` and `ExecutionContext` stay inside
  their adapters.
- **The workflow body runs on the neutral step API.** `agent-run.ts` keeps its logic, with the
  `WorkflowEntrypoint` class reduced to a shim that adapts Cloudflare's `step` to `RunEngine`'s. The
  same goes for `src/plugins/api/workflow.ts`.
- **Plugin context (D31).** `durableObject(namespace, tenantId, key)` in `plugins/api/{http,jobs,events}.ts`
  hands out a raw `DurableObjectStub`. It is replaced by neutral calls (`realtime`, `enqueue`, `storage`).
  A plugin that genuinely needs its own Durable Object or Workflow keeps declaring it in
  `plugin.json` and is marked Cloudflare-only.
- **Test fakes.** `tests/mocks/bindings.ts` becomes in-memory `Platform` implementations. This is
  mostly a rename, and both the kit and the fork share it.

## 5. Phase 2 (in the fork): Node adapters

### 5.1 Entry point and processes

`src/server.ts` builds the `Config` with `loadConfig(process.env)`, the only place `process.env`
is read, and builds the Node `Platform`. It runs in one of two modes from the same image:

- **`web`**: Hono on `@hono/node-server`, static UI, `/ws`, `/healthz`.
- **`worker`**: the pg-boss consumer loop (jobs, cron, agent-run steps).

Both handle SIGTERM: stop accepting work, drain the `defer` set and in-flight jobs, then close the
pool. Compose can run both modes in one container for small installs.

### 5.2 Jobs and crons: pg-boss

- pg-boss owns its schema (`pgboss.*`) and gets its own migration step.
- The producer maps `delaySeconds` → `startAfter`, and `sendBatch` → `insert`.
- The consumer fetches up to 10, wraps each job as `{ body, attempts, ack, retry(delay) }` and calls
  `processJobsBatch` unchanged. The retry policy and dead-letter queue are configured per queue, and
  plugin job handlers are untouched.
- Cron goes through `boss.schedule(name, cron)` → `dispatchScheduled`. pg-boss guarantees a single
  run across replicas, so no k8s CronJob is needed.

### 5.3 Agent runs: a Postgres step engine

This is the hardest piece. The business state is already in Postgres (`agent_runs` with claim,
checkpoint and `cancelRequestedAt`, `agent_run_effects` via `runOnce`, and `agent_run_interrupts`;
see `src/api/workflows/CLAUDE.md`). What Workflows add is durable replay:

- **`run_instances`** (`id`, `run_id`, `status`, `params`, `error`, timestamps) and
  **`run_steps`** (`instance_id`, `name`, `result jsonb`, `attempts`, `completed_at`).
- **`step.do(name, opts, fn)`:** return the stored result if the step completed; otherwise run `fn`
  with a timeout, store the result, or rethrow for retry with exponential backoff up to
  `opts.retries.limit`. Results must be JSON (today's `Rpc.Serializable` constraint).
- **The instance body runs as a pg-boss job.** A crash or redeploy re-delivers the job, and the
  body replays from the stored steps. This is the same idempotency contract the Workflow has today.
- **`waitForEvent(name, { type, timeout })`:** if an event row exists, return it. Otherwise mark the
  instance `waiting`, schedule a timeout job with `startAfter = timeout`, and end the job.
  `sendEvent` stores the event and enqueues a resume. Either path re-runs the body, which replays to
  the wait and finds the event or the timeout.
- **`terminate`** sets the status and cancels pending jobs. **`status`** reads the row; the existing
  `reconcileRun` mapping (`not_found`, `errored`, `terminated`, `complete`, `waiting`) is unchanged.

### 5.3a OpenWorkflow spike (M4, 2026-10-12)

M4 put agent runs on [OpenWorkflow](https://openworkflow.dev) instead of the hand-rolled engine
above (`apps/web/src/node/runs.ts`). The spike read `openworkflow@0.10.1` (Apache-2.0, pinned
exactly) from its shipped types and source, not its docs. Answers:

| Question | Answer |
|---|---|
| In-process worker? | **Yes.** `ow.newWorker({ concurrency })` → `start()` / graceful `stop()` (waits for active runs). It polls (100 ms doubling to 1 s, jittered) and heartbeats a 30 s lease. The CLI is not needed. |
| Status by run id? | **Yes**, through the backend: `backend.getWorkflowRun({ workflowRunId })`. Statuses: `pending`, `running`, `sleeping` (legacy), `completed`/`succeeded`, `failed`, `canceled`. A PARKED run stays `running` with `workerId` NULL and `availableAt` in the future. |
| Cancel a run waiting on a signal? | **Yes.** `cancelWorkflowRun` takes `pending`/`running`, and a parked run is `running`. A run mid-step finishes that step and starts no other (its lease fence trips). Cancelling a completed or failed run throws; an already-cancelled one is a no-op. |
| Does `sendSignal` report recipients? | **Yes**, `{ workflowRunIds }` — the runs whose running `signal-wait` step took it. Empty means nobody was waiting, and the signal is dropped (NOT buffered). |
| Custom run ids / idempotency? | **No custom ids**: the engine generates them (TEXT). `runWorkflow(spec, input, { idempotencyKey })` returns the existing run for the same key for 24 h. The kit's requested id (`<runId>`, `<runId>-rN`) becomes the key, and the engine's id is what `agent_runs.instanceId` stores. |
| Existing postgres.js client? | **Yes**: `BackendPostgres.fromPool(sql, { schema })`. It expects camel-cased columns (`transform.column.from = postgres.toCamel`), and the kit builds that pool itself. It is a separate small pool (`RUNS_CONCURRENCY + 4`), because the backend reserves a connection per transaction. |
| Migrations with `runMigrations: false` + an explicit call? | `fromPool` never migrates. `BackendPostgres.connect(url, { runMigrations: true })` does, and `installRunsSchema` (the `pnpm db:migrate` step) calls it once and closes. No `web`/`worker` boot migrates. |
| Step timeout inside `step.run`? | No native option. A `Promise.race` around `fn` inside `step.run` works. The losing promise keeps running, just as on Cloudflare. |
| Same replay model as Cloudflare Workflows? | **Mostly.** The body re-executes from the top and completed steps return their recorded output. **Different:** (1) a failing step reschedules the WHOLE run, and the error never reaches the body's `catch` until attempts run out; (2) a park (`waitForSignal`, `sleep`) is a THROWN `SleepSignalError`; (3) a repeated step name is auto-suffixed (`name:1`) rather than replaying the first result; (4) signals are not buffered; (5) a 1000-attempt cap per run. |

**Verdict: go.** Each difference is absorbed in the adapter (`openWorkflowStep`), so the body
stays engine-neutral:

1. **Retries run in-process inside one `step.run`**, under the Cloudflare-style policy
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
   what the body's `catch` expects from Cloudflare.

**Not wired:** OpenWorkflow's dashboard (no authentication) and its OpenTelemetry spans.

### 5.4 Realtime: `ws` + LISTEN/NOTIFY

- `/ws` keeps the auth and membership check in `src/api/routes/ws.ts`. Because the socket is
  accepted in-process, the trusted-header hop to the Durable Object goes away.
- Each `web` pod keeps `Map<tenantId, Set<socket>>`, tagging each socket with its user. It sends a
  server ping every 30 s and drops dead sockets.
- `Broadcaster.toTenant/toUser/toUsers` → `pg_notify('rf_realtime', json)`. Every pod `LISTEN`s
  on **one dedicated, non-pooled connection** and delivers to its local sockets. Payloads are
  nudges, well under NOTIFY's 8 KB limit; anything larger goes in a row with the nudge carrying its id.
- Delivery stays best effort; the client already refetches from the DB.

### 5.5 Files: S3-compatible object storage

- `createS3Storage({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle })`
  implements the existing `StorageService` with `@aws-sdk/client-s3`. Mapping:
  - `put` → `PutObject`, with `ContentType` and custom metadata (`x-amz-meta-*`)
  - `get` → `GetObject`, streamed
  - `head` → `HeadObject`
  - `delete` → `DeleteObject`
  - `deleteMany` → `DeleteObjects` (≤ 1000, the same cap R2 has)
  - `listPage` → `ListObjectsV2` with `ContinuationToken` as the cursor
- **One adapter covers most stores.** AWS S3, Cloudflare R2 (through its S3 endpoint, so a
  self-hosted deployment can still keep its files in R2), MinIO, Ceph/RGW, and GCS in interoperability mode
  differ only by endpoint and path style. `STORAGE_DRIVER=s3|azure` selects the adapter and
  `STORAGE_*` vars configure it.
- **Azure Blob** gets its own adapter (`@azure/storage-blob`), since it does not speak the S3 API.
  Another store is one more `StorageService` implementation.
- Keys stay tenant-prefixed, and downloads stay streamed through the server. Presigned URLs are a
  possible later optimisation, not part of the port. The ETag is normalised to the quoted form R2 returns.
- **As built (M6):** MinIO's images stopped being pullable anonymously, so the compose files run the
  Versity S3 Gateway (`versity/versitygw`, Apache-2.0) instead — the adapter is unchanged S3.
- **Local and CI (as proposed):** MinIO in `docker-compose.dev.yml` and `docker-compose.test.yml`, with a bucket
  created on start. The in-memory fake (`MemoryR2Bucket` → `MemoryStorage`) still serves the api tests.

### 5.6 Small adapters

- **Rate limit:** `insert ... on conflict do update` over a window row, returning the count.
- **Lock:** a row in `operation_locks` with `expires_at`; take it with `insert ... on conflict do
  nothing`, or reclaim it when expired.
- **`defer`:** a tracked promise set, with errors logged.
- **Document converter:** `unpdf` and `mammoth` behind `DocumentConverter`, selected by MIME type,
  matching `canConvert` in `src/api/services/ai/convert.ts`.
- **AI provider:** platform chat today resolves `ANTHROPIC_API_KEY`, then Workers AI
  (`platformChat` in `src/api/services/ai/resolve.ts`), and platform embeddings resolve Workers AI,
  then `EMBEDDINGS_API_KEY` against OpenAI. With Workers AI gone:
  - Add platform `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` (OpenAI-compatible, e.g. OpenRouter)
    alongside `ANTHROPIC_API_KEY`.
  - Add `EMBEDDINGS_BASE_URL` / `EMBEDDINGS_MODEL` beside `EMBEDDINGS_API_KEY`. The endpoint must
    honour `dimensions: 1024`.
  - The adapters already exist (tenant `ai_configs` use them); this only exposes them at platform level.
  - No key still means 503, as today. `scripts/bootstrap.mjs` asks for a key in the secrets step
    instead of offering `--offline`.
  - Tests keep the recorded fakes, so the gate needs no key.
- **Database:** `openDatabase` keeps its signature and returns a handle on the process pool.
  `close()` becomes a no-op per request; the pool closes on shutdown. The neon branch,
  `NEON_LOCAL_PROXY` and `HYPERDRIVE` are deleted, and the driver guard (`driver-results.test.ts`)
  simplifies to one driver.

## 6. Phase 3 (in the fork): tooling, deploy, docs

**Remove:**
- `apps/web/wrangler*.toml`, `worker-configuration.d.ts`, `.dev.vars*`
- `apps/web/scripts/cf-provision.sh` and `apps/web/scripts/provision/{cloudflare-dns,neon,patch-toml,plugin-resources}.ts`
- The neon proxy (`apps/web/docker/Dockerfile.neon-proxy`, compose profile)
- `docs/DEPLOYER.md`, `scripts/deployer.mjs`, `docs/NEON-DRIVER.md`
- The `cfld` tunnel
- These tests in `tests/config/`: `wrangler-parity`, `patch-toml`, `plugin-resources`, `provision-{zone,neon,tokens}` and `deployer`
- The neon pass of the `driver` project

**Add:**
- A multi-stage `Dockerfile`: `vite build` plus a server bundle (`tsup`) → `node dist/server.js`,
  on a non-root, distroless or slim base.
- `docker-compose.yml`: `postgres` (pgvector 17), `minio` (+ bucket init), `migrate` (one-shot), `web`, `worker`.
- A Helm chart:
  - `web` and `worker` Deployments
  - a migrate `Job` as a pre-install/pre-upgrade hook
  - a Service
  - an Ingress with WebSocket upgrade enabled
  - a Secret (`DATABASE_URL`, `STORAGE_*` credentials, AI provider keys, `RESEND_API_KEY`, OAuth secrets) and a ConfigMap (today's `[vars]`)
  - a PodDisruptionBudget
  - liveness and readiness on `/healthz`
- `rf-deploy` (replacing `rf-provision`): Compose or Helm, a values file, a secrets checklist.

**Change:**
- **Dev:** `pnpm dev` runs `tsx watch src/server.ts` (web and worker in one process) plus Vite.
  `.env` replaces `.dev.vars`. `scripts/bootstrap.mjs` drops step 8 (cloudflare) and the
  `--offline`/`--online` `[ai]` toggle, and its secrets step asks for an AI key (§5.6).
- **Gate:** `build` becomes `vite build` plus the server bundle. The `nodejs_compat` ban in
  `.claude/rules/cloudflare.md` no longer applies. Replace it with a lint rule that keeps
  `process.env` inside `src/config.ts` and `src/server.ts`.
- **Tests:** the `Platform` fakes from Phase 1 serve the unit and api projects unchanged. New
  integration tests against the test Postgres cover:
  - pg-boss retry, backoff and the dead-letter queue
  - step replay after a simulated crash
  - a `waitForEvent` timeout and resume
  - NOTIFY fan-out across two hub instances
  - a storage round-trip, metadata, listing and `deleteMany` against MinIO
  - a race on the rate limit and on the lock
- **Plugins (D31):** the `bindings[]` types and the toml writes in `scripts/plugin.mjs` and
  `scripts/lib/plugin-lib.mjs` go away. `crons` and `apiPrefixes` become registry-only, and
  `vars` go into the ConfigMap or Secret. Plugins that use only the neutral context, including the
  vendored `example-feature` (no bindings), install unchanged. The analytics plugin needs only a
  cron.
- **Docs and skills:**
  - CONCEPTS §4, 5, 6, 9, 10, 13 and 16
  - SETUP 1.3–1.10, 2.5 and Part 3
  - DEPLOY
  - `.claude/rules/cloudflare.md` → `runtime.md`, plus the wrangler mentions in `api.md`, `database.md`, `testing.md`, `ui.md` and `code-quality.md`
  - the skills `rp-preflight`, `rp-setup`, `rp-adapt` (+ checklist), `rp-plugin` and `rp-upgrade/porting.md`
  - CLAUDE.md
  - Released `docs/upgrades/*` notes are never rewritten.
- **Upgrades:** `.rocketflare.json` keeps tracking the kit commit. The deleted Cloudflare surfaces
  are recorded as removed, so `/rp-upgrade` skips their anchors, and toml changes stay in the
  manual bucket that `scripts/lib/upgrade-lib.mjs` already has. The fork has its own version line.

## 7. Decisions and risks

**Decided (2026-10-03):**

1. **Files go to an S3-compatible object store**, not Postgres: AWS S3, R2, MinIO or GCS through one
   adapter, and Azure Blob through a second (§5.5). This keeps large binaries out of backups and WAL.
2. **Agent runs use a hand-rolled step engine** (§5.3), not DBOS or another framework. The kit
   already keeps run state in Postgres, so the engine is small. The cost is owning durable-execution
   code, which the integration tests in §6 must cover: replay, timeout, resume, terminate.
3. **Realtime uses LISTEN/NOTIFY on a dedicated connection.** PgBouncer in transaction mode breaks
   `LISTEN`, so the deployment docs require that connection to go direct to Postgres (or through a
   pooler in session mode). A separate `DATABASE_LISTEN_URL` is optional.
4. **A real AI key is expected locally.** Anthropic, OpenRouter or any OpenAI-compatible endpoint
   (§5.6). There is no local model and no zero-key mode. The gate stays key-free because tests use fakes.

**Remaining risks:**

1. **Plugins that declare a Durable Object or a Workflow.** None do today. After Phase 1 they are
   Cloudflare-only by declaration; the fork's `plugin check` refuses them.
2. **Kit drift.** The fork stays upgradable only while the kit keeps its seams neutral. Phase 1
   should add a guard test in the kit (no Cloudflare global types outside `src/platform/cloudflare/`
   and the entry point), on the model of `driver-results.test.ts`.
3. **Embeddings provider choice.** Anthropic has no embeddings API, so an Anthropic-only install
   still needs an OpenAI-compatible embeddings key for knowledge features. A provider that cannot
   return 1024 dimensions needs a vector-column migration.

## 8. Effort (rough)

| Phase | Work | Days |
|---|---|---|
| 1 (kit) | `Platform` interfaces, entry-point wiring, about 54 `c.env` reads, plugin context, fakes, guard test | 3–5 |
| 2 (fork) | step engine 4–6 · realtime 2–3 · pg-boss jobs/cron 2 · S3/Azure storage, locks, converter, platform AI vars, server entry 3–4 | 11–15 |
| 3 (fork) | Dockerfile, compose, Helm, gate, adapter tests, plugin tooling, docs and skills (the long tail) | 5–8 |

## 9. Verification (for the fork)

- `pnpm gate` passes, with the Cloudflare-config tests removed and the adapter integration tests added.
- `docker compose up` with an AI key (and an embeddings key) in `.env`, then:
  - sign in with dev-login
  - upload a PDF → stored in MinIO → converted → indexed → found by chat
  - start an agent run that interrupts → resume it from the UI
  - kill `worker` mid-run → it restarts and resumes from the last completed step without repeating
    an effect (`agent_run_effects`)
- **Storage portability:** the same upload against an R2 bucket and an AWS S3 bucket, changing only
  the `STORAGE_*` vars.
- **Realtime across pods:** two `web` replicas behind a proxy; an activity in one tab nudges a tab
  connected to the other replica.
- **k8s (kind + Helm):** the migrate Job runs once; the daily cron fires once with three `worker`
  replicas; a rolling restart drops no jobs (SIGTERM drain).
- **Upgrades:** `/rp-upgrade` against the next kit release skips the deleted Cloudflare surfaces
  and ports the rest.
