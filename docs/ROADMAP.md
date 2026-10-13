# Rocketpod roadmap: a Cloudflare-free hard fork of Rocketflare

## Context

Rocketpod is a version of Rocketflare that runs fully detached from Cloudflare: **Node 24 in Docker or
Kubernetes**, with **Postgres** (+ pgvector) for everything stateful and **S3-compatible storage** for
files. It keeps the same concepts: tenancy, auth, CASL, contracts-first, jobs, agents with durable
runs, realtime, knowledge/RAG, tracing, evals, plugins and the CLI.

Decisions taken (2026-10-12):

- **Runtime:** Node 24. No workerd, wrangler or miniflare.
- **Upstream:** a **hard fork with concept parity**. Rocketflare itself gets no seam work, and kit
  features are ported by hand from the `docs/upgrades/*` notes.
- **Deploy:** Compose **and** Helm from day one. That means multiple replicas, cross-pod realtime and
  a singleton cron.

The detailed adapter design already exists in `docs/SELF-HOSTED.md` (untracked in rocketflare,
§3 inventory, §5 adapters). This plan reuses it, with two changes: no Phase 1 in the kit, and the
"stay upgradable" constraints are dropped.

## Where it lives

- A new repo at `~/work/rocketpod`, cloned from rocketflare `main` as one squashed initial commit
  ("forked from rocketflare <sha>"), so CF-era history isn't carried along.
- Remote: `rocketflare-dev/rocketpod`, in the same GitHub org as the kit. The name is free.
- npm: the CLI publishes under its own name (`rocketpod` / `@rocketpod/cli`, both free), with its own
  release workflow. `@rocketpod/shared` stays private, as shared is in the kit.
- `gh repo create rocketflare-dev/rocketpod --private` happens only when you say so (M0 commits locally).
- The rename uses rocketflare's own `scripts/rename.mjs` (`/rp-adapt rocketpod`). It produces the
  `@rocketpod/*` scope, the CLI bin `rocketpod`, the `~/.rocketpod/config.json` config path and
  the DB names.
- Copy `docs/SELF-HOSTED.md` into the fork as `docs/DESIGN-SELFHOSTED.md`, the design of record. Remove
  it from rocketflare, or leave it untracked there; you choose.

## Milestones (each ends with the fork's `pnpm gate` green and a commit)

### M0. Clone, rename, strip the kit machinery (1–2 d) — done

**Status: done (2026-10-12).** Rocketpod stayed a kit (its own release chain from 0.1.0), so the
upgrade machinery was re-pointed at it rather than deleted (`docs/FORK.md`).

- Rename with `scripts/rename.mjs`.
- Delete the upgrade and release machinery that only makes sense for a kit:
  - `.rocketflare.json`, `scripts/upgrade.mjs`, `scripts/kit-update-check.mjs`
  - the release-site nudge and `docs/upgrades/*`
  - the `rp-upgrade` skill
  - the `kit-only` vitest project
- Keep `scripts/release*.mjs` and a fresh `CHANGELOG.md` for Rocketpod's own versioning.
- `launch.kit.json` and `kit-check.mjs` go if you're not shipping Rocketpod as a Launch kit (to confirm).
- Record the fork point in `docs/FORK.md` (rocketflare sha + version), so later hand-porting has a baseline.

### M1. Platform seam inside the fork (3–4 d) — done
- Add `apps/web/src/platform/` with neutral interfaces:
  - `Storage`, `Jobs`, `Realtime`, `RunEngine`, `Locks`, `RateLimit`, `defer`, `DocumentConverter`
- Add a `Platform` object on the Hono context, set as `c.set('platform')`. Rewrite the ~54 `c.env.X`
  reads and the 11 files typed on `Cloudflare.Env`.
- Reuse the existing seams named in SELF-HOSTED §2:
  - `StorageService` (`services/storage.ts`)
  - `JobsQueue` (`services/jobs.ts`); consumer `processJobsBatch` (`queues/jobs.ts`)
  - `Broadcaster` (`services/realtime.ts`)
  - `AgentRunWorkflowBinding` (`services/agents/runs.ts`)
  - `RateLimitKv` (`middleware/rate-limit.ts`)
  - `deferOrAwait` (`middleware/database.ts`)
- Turn `tests/mocks/bindings.ts` into in-memory `Platform` fakes (mostly a rename), so the api tests
  keep running.
- Plugin context (`src/plugins/api/{http,jobs,events,workflow}.ts`): replace `durableObject(...)` and
  Cloudflare step types with neutral calls.

### M2. Node entry and the database (2 d) — done
- `src/node/server.ts` reads `loadConfig(process.env)` and has three modes, `web`, `worker` and `all` (dev):
  - `@hono/node-server`, the SPA's files served first (`src/node/assets.ts`) and an `index.html`
    fallback through the app's `ASSETS` catch-all (`isApiPath` paths stay JSON 404s)
  - `/healthz` (liveness) and `/readyz` (pool ping; 503 while draining)
  - SIGTERM drains the tracked `waitUntil` set (`src/node/defer.ts`) and the worker loop, then closes the pool
- `openDatabase` keeps its signature; `installProcessPool` gives **one postgres.js pool per process**
  and `openDatabase` hands out views of it. The neon driver, `NEON_LOCAL_PROXY`, the neon proxy
  image and compose profiles and the driver project's second pass are deleted; `driver-results.test.ts`
  is simplified to one driver.
- Client IP: `clientIpOf(c)` — the socket peer, or `X-Forwarded-For` behind `TRUSTED_PROXY_HOPS`.
- `dist/server.js` (`scripts/build-server.mjs`); `pnpm web dev:node`.
- **Sequencing (decided):** the Cloudflare entry (`worker.ts`, the tomls, the DO, the workflow shim,
  `src/platform/cloudflare/`, `HYPERDRIVE`) is NOT deleted here. It stays green beside the Node
  runtime until **M6b**, so every commit's gate passes on both.

### M3. Jobs and cron on pg-boss (2–3 d) — done
- The producer maps `delaySeconds` to `startAfter`.
- The consumer wraps pg-boss jobs as `{ body, attempts, ack, retry }` and calls `processJobsBatch` unchanged.
- Configure `retryLimit 3`, backoff and a real dead-letter queue.
- Cron runs through `boss.schedule()` and calls the existing `dispatchScheduled`. pg-boss keeps it
  singleton across replicas.

### M4. Agent runs on OpenWorkflow (3–4 d, down from 5–7)

**Status: done (2026-10-12).** `apps/web/src/node/runs.ts` + `runs-schema.ts`; the spike's answers are in
`docs/DESIGN-SELFHOSTED.md` §5.3a. The plan below is kept as written.

[OpenWorkflow](https://openworkflow.dev) is an Apache-2.0 TypeScript durable-workflow engine. It runs on
Postgres 14+ through postgres.js (the same driver we use) and keeps its own `openworkflow` schema.
Like Cloudflare Workflows, it re-runs the workflow function from the top and returns saved step
results, so `agent-run.ts`'s rule (deterministic body, side effects inside steps) carries over unchanged.

**How the calls map:**

| Kit uses (Cloudflare Workflows) | OpenWorkflow | Gap |
|---|---|---|
| `step.do(name, {retries}, fn)` | `step.run({ name, retryPolicy }, fn)` | No per-step timeout: wrap `fn` in our own `withTimeout` (10 min) |
| `step.waitForEvent('resume#N', {timeout})` | `step.waitForSignal({ signal: 'agent-run:<runId>:resume#N', timeout })`, which returns `null` on timeout | **Signals aren't buffered** (see below) |
| `create({ params })` → `instanceId` | `ow.runWorkflow(spec, input)` returns a handle with the run id | Store the run id in `agent_runs.instanceId`, which already exists |
| `instance.sendEvent` | `ow.sendSignal({ signal, data, idempotencyKey })` | Addressed by name, so the run id goes in the signal name |
| `instance.terminate()` | `ow.cancelWorkflowRun(id)` | Cancelling a run that is waiting on a signal: **check in the spike** |
| `instance.status()` | Not documented by id | Read `openworkflow.workflow_runs` through one query helper. In a hard fork, coupling to that schema is acceptable |
| Restart as `<runId>-rN` | A fresh `runWorkflow` (or `rerunWorkflowRun`) | — |
| Cron, `JOBS_QUEUE` | None (cron is on OpenWorkflow's roadmap) | **Keep pg-boss for jobs and cron (M3)** |

**Closing the unbuffered-signal race.**

A human can answer between the run writing its interrupt and the run starting to wait. Postgres is
already the source of truth (`agent_run_interrupts`), so close it from both sides:

1. Before waiting, the run checks the interrupt row inside a step. If it is already resolved, the run
   carries on without waiting.
2. The resume route writes the resolution first, then sends the signal. If no run received it
   (`workflowRunIds` is empty, assuming `ow.sendSignal` reports that the way `step.sendSignal` does —
   to confirm in the spike), it retries for a few seconds while the run is still active.

A regression test drives this race.

**Wiring:**

- **Worker:** OpenWorkflow's worker runs inside our `worker` mode (in-process if the API exposes it,
  otherwise the CLI as a sidecar command in the same image). Set `concurrency` explicitly; the default is 1.
  SIGTERM drains it.
- **Migrations:** `runMigrations: false`. The migrate Job applies OpenWorkflow's schema, and
  `rls-coverage.test.ts` excludes the `openworkflow` schema. Run inputs carry `tenantId`, and the
  workflow re-scopes through `withTenantScope` as it does today.
- **Code changes:**
  - `AgentRunWorkflow` becomes `defineWorkflow({ name: 'agent-run' }, ...)` over a small `Step`
    adapter that keeps the `do` / `waitForEvent` names.
  - `plugins/api/workflow.ts` exposes the same adapter, so plugin workflows are unaffected.
  - `runs.ts` talks to a `RunEngine` that wraps `ow`.
  - An in-memory `RunEngine` replaces `RecordingWorkflow` in the api tests.
- **Dashboard:** OpenWorkflow's dashboard (with Prometheus `/metrics`) has no built-in authentication.
  It is off by default; the Helm chart exposes it as an opt-in internal Service only.

**Day-one spike before committing (½ day):**
- Can a worker run in-process?
- Does cancel work on a run waiting for a signal?
- Is there a status lookup by id?
- Does `ow.sendSignal` return its recipients?
- Does `withTimeout` behave inside `step.run`?

**Fallback:** the hand-rolled engine (tables `run_instances` / `run_steps` / `run_events`, replay on
pg-boss, around 400 lines) stays the plan B. The `RunEngine` seam makes swapping cheap.

**Risk:** OpenWorkflow is young (no 1.0, and signals and cron are still filling in). Pin the exact
version, and keep the adapter thin enough that either the engine or the fallback can sit behind it.

### M5. Realtime with `ws` + LISTEN/NOTIFY (2–3 d)

**Status: done (2026-10-12).** `apps/web/src/node/realtime.ts` on `ws` 8.21.3 directly (not
`@hono/node-ws`: the route answers through `hub.accept()`, so the server runs the app inside an
`AsyncLocalStorage` slot and completes the handshake itself); `tests/api/node-realtime.test.ts`.
`NotificationsHub` is deleted in the M6b sweep with the rest of the Worker path.

- `@hono/node-ws` on `/ws`. Keep the auth and membership check in `routes/ws.ts`, and drop the
  trusted-header hop to the DO.
- Each pod keeps a map of tenant → sockets, tagged by user, with a 30 s ping.
- `Broadcaster` uses `pg_notify('rp_realtime')`. Each pod listens on one dedicated non-pooled
  connection, set by the optional `DATABASE_LISTEN_URL` (needed behind PgBouncer in transaction mode).
- Delete `NotificationsHub`.

### M6. Storage, small adapters and AI (3–4 d)

**Status: done (2026-10-12).** `apps/web/src/node/storage.ts` (S3), `limits.ts` (rate limits and
locks over `rate_limits`/`operation_locks`, now part of the `0000_rocketpod-baseline` migration), `converter.ts`
(`unpdf`, `mammoth`, HTML/XML/text); platform `AI_*` and `EMBEDDINGS_BASE_URL`/`EMBEDDINGS_MODEL`
in `services/ai/resolve.ts`; `tests/api/node-platform-adapters.test.ts`. **Deviation:** MinIO's
images are no longer pullable anonymously, so the dev and test compose files run the **Versity S3
Gateway** (`versity/versitygw:v1.8.0`, Apache-2.0) instead; the adapter is plain S3 and still talks
to MinIO, AWS S3, R2 and GCS. Excel and OpenDocument uploads are not converted on Node (a permanent
`format: 'error'`).

- **`STORAGE_DRIVER=s3`:** `@aws-sdk/client-s3` behind `StorageService`, configured by endpoint,
  region, bucket, keys and `forcePathStyle`.
  - One adapter covers AWS S3, MinIO, R2 and GCS.
  - Keys stay tenant-prefixed and downloads are streamed.
  - Azure Blob only on request.
- Rate limit and operation lock: `rate_limits` and `operation_locks` tables with atomic upserts, and
  the prune cron cleans them.
- `DocumentConverter`: `unpdf` for PDF, `mammoth` for docx, passthrough for text/markdown.
  `canConvert` in `services/ai/convert.ts` picks one.
- AI: remove Workers AI.
  - Add platform `AI_BASE_URL/AI_API_KEY/AI_MODEL` (OpenAI-compatible) next to `ANTHROPIC_API_KEY`.
  - Add `EMBEDDINGS_BASE_URL/MODEL`, still 1024 dims.
  - No key still gives 503. Tests use the recorded fakes.

### M6b. Delete the Cloudflare path (1–2 d) — done
- Deleted `src/worker.ts`, `src/platform/cloudflare/`, the `NotificationsHub` DO, the
  `AgentRunWorkflow` shim, both wrangler tomls, `worker-configuration.d.ts`, the
  `cloudflare:workers` mock, `HYPERDRIVE`, `build:api`, `pnpm types|deploy|provision`, `cfld` /
  `dev:tunnel`, `deploy.yml`, the deployer and build-once bundle, the `rf-provision` skill, the
  plugin `bindings[]` / `workerExports` model (refused at install) and the `worker-exports` barrel,
  and the Cloudflare-config tests. `.dev.vars*` → `.env` / `.env.example`; `pnpm dev` runs Node.
- Test fakes are native in-memory `Platform` implementations (`tests/mocks/bindings.ts`,
  `tests/mocks/step.ts`); `platform-seam.test.ts` is a "no Cloudflare anywhere" guard.
- Bootstrap step 8 is `ai` (which provider keys `.env` holds); `--offline/--online` are accepted
  and ignored. `launch.kit.json` stays schema-valid with a `$runtime` note: Launch's contract is
  Cloudflare-shaped, so `kit.yml` no longer runs `kit-check.mjs`.
- Deferred to M8: the `workers-ai` provider kind (DB enum, shared contracts, UI, pricing) still
  exists but can never run (`Platform.ai` is always null); SETUP Part 2, CONCEPTS §§ beyond 10,
  DEPLOY, ADAPTING, RLS and CONTRIBUTING carry an M6b banner instead of a rewrite.

### M7. Packaging: Docker, Compose, Helm (3–4 d) — done
- Root `Dockerfile`: pnpm install + `pnpm build` (Vite UI + esbuild bundles `dist/server.js` and
  `dist/migrate.js`), then `node:24-alpine` with npm/corepack/yarn removed, non-root, no
  `node_modules` (the bundles carry every dependency). `ENTRYPOINT node dist/server.js`, `CMD web`;
  `node dist/migrate.js` is the migrate one-shot. A worker answers `/healthz`/`/readyz` on its probe
  port.
- Root `docker-compose.yml`: `postgres` (pgvector 17), `s3` (Versity S3 Gateway — MinIO images no
  longer pull anonymously), `migrate`, `web`, `worker`; `deploy/compose.single.yml` runs one `all`
  process instead.
- Helm chart `deploy/helm/rocketpod`: `web`/`worker` Deployments, migrate pre-install/pre-upgrade
  Job (hook-scoped Secret or `existingSecret`), Service, Ingress, PDBs, ConfigMap/Secret mirroring
  `src/config.ts` (`tests/config/packaging.test.ts`), non-root read-only pods. Postgres and S3
  stay external.
- `.github/workflows/image.yml`: build on PR/main, push to ghcr on a version tag; helm lint +
  template + kubeconform.
- `docs/DEPLOY.md` rewritten as the container runbook.
- Not verified: a live install on a cluster (no kind/cluster here) — `helm lint`, `helm template`
  and kubeconform (18 resources, k8s 1.30) only. `pnpm dev` already moved to Node in M6b.

### M8. Tooling, plugins, docs and skills (4–6 d, the long tail) — done

Split in two. **M8a — done:** code and skills — the `workers_ai` provider removed (history rows stay
readable through `RECORDED_AI_PROVIDERS`), the upload type gate (`DocumentConverter.contentTypes` →
415), the `rp-*` skills and the new `rp-deploy`, `plugin check` green, and the drizzle chain squashed
into `0000_rocketpod-baseline` + `0001_plugin-example-feature-0.1.0` (schema dump identical to the
old 19-file chain, column order aside). **M8b — done (2026-10-13):** the docs rewrite — CONCEPTS
(Rocketpod is D41; every "removed in M6b" banner replaced by the Node design and its known gaps),
SETUP, README, ADAPTING, RLS, CONTRIBUTING, SECURITY, CLAUDE.md (full config model, packaging and
secrets non-negotiables), the rules and per-directory guides.

- **Bootstrap:** remove the cloudflare step and the `--offline/--online` toggle; ask for an AI key instead.
- **Provisioning:** delete `pnpm provision`, `cf-provision.sh`, `scripts/provision/*`, deployer and
  `cfld`, plus their `tests/config/*` tests.
- **Skills:** replace `rf-provision` with a `rp-deploy` skill for Compose/Helm, values and a secrets
  checklist. Rename the `rf-*` skills to `rp-*` and update `rp-setup`, `rp-preflight` and `rp-plugin`.
- **Plugins (D31):** drop `bindings[]` and the toml writes in `scripts/plugin.mjs` and
  `scripts/lib/plugin-lib.mjs`. `crons` become pg-boss schedules and `vars` go to the ConfigMap. The
  analytics and example-feature plugins should install unchanged. `defaultPlugins` is empty from
  0.1.0: the analytics plugin's `minKit` is on Rocketflare's version line, so it refuses kit 0.1.0.
  Restore analytics there once a release of it declares a Rocketpod-compatible `minKit` and runs
  without Cloudflare bindings.
- **Rules:** `.claude/rules/cloudflare.md` becomes `runtime.md`, with a lint guard that keeps
  `process.env` inside `config.ts` and `server.ts`, and no `@cloudflare/*` or `cloudflare:*` imports
  anywhere (a test on the model of `shared-imports.test.ts`).
- **Docs:** CONCEPTS, SETUP, DEPLOY and CLAUDE.md are rewritten for the new runtime.

## Next

Not milestones of the port — the work that follows it, in rough order:

- **First release** — `pnpm kit:release 0.1.0`, then create `rocketflare-dev/rocketpod` and push the
  tag (user-confirmed: it publishes the repository and, through `image.yml`, the image).
- **CLI on npm** — there is no publish workflow: add one (on a tag, `apps/cli` built with `tsc`,
  published as `rocketpod` or `@rocketpod/cli`; `@rocketpod/shared` stays private, so the CLI must
  bundle what it imports from it).
- **Analytics without Cloudflare** — a release of the analytics plugin in `rocketflare-plugins` with
  no `bindings` and a Rocketpod-compatible `minKit`, then restore it in `defaultPlugins` (and the
  `launch.kit.json` mirror).
- **Operations** — dead-letter redrive tooling (a CLI command or admin page over `boss.redrive`);
  the OpenWorkflow dashboard behind the app's auth (or an authenticated proxy in the chart); pg-boss
  and realtime metrics.
- **Live verification** — `helm install` on kind with 2 web and 3 worker replicas (the Verification
  list below); image signing / SBOM in `image.yml`.
- **Plugin durable workflows** — a way for a plugin to register its own OpenWorkflow workflow
  through the plugin context.

## Effort

M0–M8 ≈ **23–32 working days** (about 5–7 weeks for one person). M4 (the step engine) and M8 (the
docs and skills long tail) carry most of the uncertainty. A **demoable Compose stack** is reachable
after M0–M3 + M6 + a minimal M7, in about 2.5 weeks, with agent runs and realtime stubbed.

## Verification

- `pnpm gate` is green with the new integration tests against test Postgres + the S3 gateway:
  - pg-boss retry and DLQ
  - step replay after a crash; `waitForEvent` timeout and resume; terminate
  - NOTIFY fan-out across two hub instances
  - an S3 round-trip, metadata, list and `deleteMany`
  - a race on the rate limit and on the lock
  - a guard that no Cloudflare imports remain
- `docker compose up` with an AI key, then:
  - dev-login
  - upload a PDF → the S3 store → converted → embedded → found by chat
  - an agent run that interrupts → resume it from the UI
  - kill `worker` mid-run → it resumes with no duplicate `agent_run_effects`
- On kind + Helm with 2 web and 3 worker replicas:
  - the migrate Job runs once
  - the daily cron fires once
  - a realtime nudge crosses pods
  - a rolling restart drops no jobs
- The CLI: `rocketpod login --server http://localhost:3001` → `whoami`, `agents run`.

## First execution step (on approval)

M0 only: clone into `~/work/rocketpod`, rename, strip the kit machinery, gate green, commit locally
(no remote push). Then review before M1.
