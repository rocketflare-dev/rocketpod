# DEPLOY — running Rocketpod in containers

Rocketpod ships as **one image** that runs three ways, plus a one-shot:

| Process | Command | What it does | Scale |
|---|---|---|---|
| `web` | `node dist/server.js web` (the default `CMD`) | API, UI (SPA fallback), `/ws`, `/healthz`, `/readyz` on `:3001` | Stateless — any number of replicas |
| `worker` | `node dist/server.js worker` | Jobs (pg-boss), cron (pg-boss schedules), agent runs (OpenWorkflow); only `/healthz` + `/readyz` on `:3001` | Any number — each cron occurrence runs once across replicas |
| `all` | `node dist/server.js all` | Both in one process | Small installs, one replica |
| migrate | `node dist/migrate.js` | `db-roles` (role) → drizzle migrations + the `pgboss` and `openworkflow` schemas → `db-roles` (grants) — exactly `pnpm db:migrate` | Once per release, before the new version starts; idempotent |

The image (`Dockerfile`) is multi-stage: `pnpm build` bundles the server and the migrate entry with
esbuild (every dependency inside the bundle) and Vite builds the UI. The runtime stage is
`node:24-alpine` with npm, corepack and yarn removed — two bundles, `dist/ui`, the drizzle SQL and
the Guide's content (`content/guide`: pages, images, any committed vectors — every `web` boot
chunks the pages into `guide_chunks`, so a release with edited pages needs nothing else run),
about 14 MB on top of Node — running as the `node` user (uid 1000). It writes nothing to its
filesystem, so a read-only root filesystem works (`/tmp` is mounted for libraries that expect one).

**What it needs outside itself:**

- **Postgres 17 with pgvector.** Migrate runs `CREATE EXTENSION IF NOT EXISTS vector`, so the owner
  role must be allowed to create it, or it must already exist. One owner connection,
  `DATABASE_URL`, is used by migrate and by every process's pool (`DATABASE_POOL_MAX`, default 10 per
  process — plus a small pool each for pg-boss and OpenWorkflow, and one dedicated connection per
  `web` process for realtime).
- **A LISTEN-capable connection for realtime.** `/ws` fans out across pods with Postgres
  `LISTEN/NOTIFY` on one dedicated connection per `web`/`all` process. PgBouncer in
  **transaction** mode breaks `LISTEN`: point `DATABASE_LISTEN_URL` straight at Postgres (or at a
  session-mode pool). Unset, it is `DATABASE_URL`.
- **An S3-compatible bucket** (`STORAGE_*`): AWS S3, Cloudflare R2, GCS (interoperability mode),
  MinIO, Versity, Ceph… — only the endpoint and path style differ. Unset, uploads answer 503. The
  store must honour `Range` on `GetObject` (a ranged download from one that ignores it is an error,
  not a wrong body) and multipart uploads (`putStream`); every store named here does.
- **An AI provider key**, for chat, agents or knowledge: `ANTHROPIC_API_KEY`, or `AI_API_KEY`
  (+ `AI_BASE_URL`/`AI_MODEL` for any OpenAI-compatible endpoint such as OpenRouter). Knowledge
  uploads also need `EMBEDDINGS_API_KEY` (+ `EMBEDDINGS_BASE_URL`/`EMBEDDINGS_MODEL`) for an
  endpoint that returns **1024-dimension** vectors. No key → those features answer 503 and the rest
  of the app works.
- **Email** for magic links and invitations: `RESEND_API_KEY`. Without it the link is logged by the
  process that sends it: a magic link by **web** (sent inline — a person is waiting), an invitation
  by **worker** (`email.send` is a job).

## Docker Compose

`docker-compose.yml` at the repository root is self-contained: `postgres` (pgvector 17), `s3`
(Versity S3 Gateway over a volume, bucket created on start), `migrate` (one-shot), `web` and
`worker`. Every value has a default, so it runs as-is on a laptop:

```bash
docker compose up -d --build          # builds rocketpod:local once (the migrate service builds it)
open http://localhost:3001
docker compose logs -f web worker     # magic links (web) and invitations (worker) without RESEND_API_KEY
docker compose down                   # keeps the volumes; `down -v` deletes the data
```

Settings go in a root `.env` (compose reads it for interpolation) — start from
`deploy/compose.env.example`. The ones that matter first:

- `APP_URL` — the origin people type. The session cookie is `__Host-session`, which is always
  `Secure`; browsers accept it over plain http **only on localhost**. Anywhere else, put TLS in
  front (Caddy, Traefik, a cloud load balancer), set `APP_URL=https://…` and
  `TRUSTED_PROXY_HOPS=1` (one proxy appending to `X-Forwarded-For`).
- `BOOTSTRAP_ADMIN_EMAILS` — the first global admin; they sign in by magic link.
- `POSTGRES_PASSWORD`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` — change these before
  exposing anything.
- `ROCKETPOD_IMAGE` — a published `ghcr.io/rocketflare-dev/rocketpod:<version>` instead of a local build.
- `APP_ENV=development` turns on `POST /auth/dev-login` (password-less) — never on a reachable host.

**One process instead of two** (small installs):

```bash
docker compose -f docker-compose.yml -f deploy/compose.single.yml up -d --build
```

**Managed services instead of the bundled ones:** set `DATABASE_URL` / `STORAGE_*` in `.env` and
remove `postgres` / `s3` (and their `depends_on` entries) from your copy of the file.

## Kubernetes (Helm)

The chart is `deploy/helm/rocketpod`. It deploys `web` (a Deployment + Service, an optional Ingress,
a PodDisruptionBudget), `worker` (a Deployment, no Service) and the migrate Job as a
`pre-install,pre-upgrade` hook. Postgres and the bucket are **external** — the chart bundles
neither.

```bash
helm upgrade --install rocketpod deploy/helm/rocketpod -n rocketpod --create-namespace \
  --set image.tag=0.1.0 \
  --set config.APP_URL=https://app.example.com \
  --set config.STORAGE_BUCKET=rocketpod-files --set config.STORAGE_ENDPOINT=https://s3.example.com \
  --set existingSecret=rocketpod-secrets \
  --set ingress.enabled=true --set ingress.className=nginx \
  --set 'ingress.hosts[0].host=app.example.com' --set 'ingress.hosts[0].paths[0].path=/' \
  --set 'ingress.hosts[0].paths[0].pathType=Prefix'
```

`values.yaml` is the reference; the parts that need a decision:

- **`config`** (→ ConfigMap) mirrors the settings in `apps/web/src/config.ts`. An empty value is left
  out, so the app's default applies. `config.APP_URL` is required (the render fails without it).
  `TRUSTED_PROXY_HOPS` defaults to `1` (an ingress controller in front).
- **`secrets`** (→ Secret) or **`existingSecret`** — the name of a Secret you manage (External
  Secrets, Sealed Secrets, Vault) with the same keys. `DATABASE_URL` is required either way. The
  migrate hook runs before the release's own Secret exists, so it reads `DATABASE_URL` and
  `APP_DATABASE_URL` from `existingSecret`, or from a hook-scoped copy the chart renders.
- **Ingress and `/ws`.** ingress-nginx proxies WebSocket upgrades as they are. Raise its timeouts so
  idle sockets survive (`nginx.ingress.kubernetes.io/proxy-read-timeout` / `proxy-send-timeout:
  "3600"`) and allow 5 MB uploads (`nginx.ingress.kubernetes.io/proxy-body-size: "6m"`).
- **Drain.** `web` gets a 5 s `preStop` sleep (the `sleep` lifecycle action, Kubernetes ≥ 1.30), so
  the endpoint is removed before the process stops accepting. SIGTERM then drains requests,
  deferred work and sockets (closed with 1001, so clients reconnect to another pod). `worker`
  finishes in-flight jobs and runs within `terminationGracePeriodSeconds` (60). A run cut off by the
  deadline is replayed by another worker after its 30 s lease, from its last completed step.
- **Probes.** `web`: readiness `/readyz` (a database ping; 503 while draining), liveness
  `/healthz`. `worker`: liveness `/healthz` on its probe port.
- **Security.** Non-root (1000), `readOnlyRootFilesystem`, all capabilities dropped,
  `RuntimeDefault` seccomp, no service-account token mounted.

**Scaling.** `web` replicas are stateless; realtime crosses pods through `LISTEN/NOTIFY`. `worker`
replicas share the pg-boss queue (`JOBS_CONCURRENCY` jobs each) and OpenWorkflow's runs
(`RUNS_CONCURRENCY` each), and pg-boss keeps every cron occurrence to one run however many workers
there are. Size Postgres `max_connections` for roughly
`(web + worker replicas) × (DATABASE_POOL_MAX + 8)`.

## Secrets checklist

| Key | Needed for |
|---|---|
| `DATABASE_URL` | Everything (required) |
| `DATABASE_LISTEN_URL` | Realtime behind PgBouncer in transaction mode |
| `APP_DATABASE_URL` | Only with `TENANT_SCOPE_MODE=enforce` (`docs/RLS.md`) |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | Uploads, documents, avatars |
| `OAUTH_ENCRYPTION_KEY` (32+ chars) | OAuth/OIDC sign-in and tenant AI keys at rest |
| `RESEND_API_KEY` | Delivering magic links and invitations (otherwise logged) |
| `BOOTSTRAP_ADMIN_EMAILS` | The first global admin |
| `GOOGLE_*`, `MICROSOFT_*`, `OIDC_CLIENT_SECRET` | The matching sign-in buttons |
| `ANTHROPIC_API_KEY` / `AI_API_KEY` | Chat and agents |
| `EMBEDDINGS_API_KEY` | Knowledge uploads and search |
| `TYPESAFE_API_KEY` | Platform `ctx.decide` (Jev) |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `OTEL_EXPORTER_OTLP_HEADERS` | Trace export (§ Tracing) |

## Releases and images

`.github/workflows/image.yml` builds the image on every pull request and push to `main` (no push),
and lints, renders and schema-checks the chart (`helm lint`, `helm template`, kubeconform). A
version tag pushes `ghcr.io/<owner>/rocketpod:<version>` and `:latest`, with `RELEASE_VERSION`
baked in (it is what `/auth/session` reports as `releaseVersion`). The quality gate itself stays
`ci.yml`'s one job, but a tag waits for it: image.yml's `ci` job holds the push until the CI
workflow has passed on the tagged commit (30 minutes at most), and a failed or missing run stops
the release — so push the commit to `main` first, then tag it.

**A tag is a release, and once a deploy job hangs off it, a production deploy.** A copy that adds
one (`needs: [ci, chart, image]`) deploys every version tag it pushes; nothing asks again. Before
tagging, read the gate's own verdict (`✔ pnpm gate passed`, or `.gate/last.json`), never an exit
code piped through `tail`.

The CLI (`apps/cli`) is not part of the image: it runs on people's machines
(`rocketpod login --server https://app.example.com`).

## Observability

- **Logs:** structured JSON (pino) on stdout from every process — collect them with whatever the
  platform uses. `LOG_LEVEL` sets the floor.
- **Health:** `/healthz` (process up) and `/readyz` (database reachable, not draining) on every
  process, `worker` included.
- **Jobs:** pg-boss's tables in the `pgboss` schema. A job that fails all its retries (`retryLimit`
  3) moves to the `rocketpod-jobs-dlq` queue; redrive by hand for now.
- **Agent runs:** OpenWorkflow's `openworkflow` schema; `agent_runs.instance_id` is the engine's run
  id. A row stuck `queued`/`running` whose run is gone is settled on the next
  `GET /api/agents/runs/:id`, once it has been quiet for 30 s.
- **AI traces (D32):** every chat turn, agent run, tool call, retrieval and embeddings batch lands
  in the tenant's `ai_spans` (read with `rocketpod traces list|show`) and, with a backend
  configured, is exported as OTLP after the response — § Tracing.

## Tracing (D32)

The local store needs nothing: every environment writes `ai_spans` and prunes it nightly. A
backend is ADDITIONAL and platform-wide (one per deployment, never per tenant). After any change,
one chat turn or agent run should appear in the backend within a minute.

| Backend | Set |
|---|---|
| Langfuse Cloud | `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` select the `langfuse` preset (OTLP/JSON to `<LANGFUSE_BASE_URL>/api/public/otel`). Optional `OBSERVABILITY_TRACE_URL=https://cloud.langfuse.com/project/<id>/traces/{traceId}` for the CLI's link-out |
| Self-hosted Langfuse | The two keys + `LANGFUSE_BASE_URL` (or `OTEL_EXPORTER_OTLP_ENDPOINT` set to the full `/api/public/otel` URL) |
| Phoenix | `OBSERVABILITY_PRESET=phoenix`, `OTEL_EXPORTER_OTLP_ENDPOINT=https://phoenix.example.com` (the preset defaults to `http/protobuf`). Auth: secret `OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20<key>` |
| Any OTLP/HTTP collector | `OBSERVABILITY_PRESET=generic` (the default without Langfuse keys), `OTEL_EXPORTER_OTLP_ENDPOINT` (`/v1/traces` is appended), optionally `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` |

`OBSERVABILITY_CAPTURE_CONTENT=false` strips prompts, completions and tool I/O from both the export
and `ai_spans`. Export failures are logged (`tracing: OTLP export returned a non-OK status`) and
never fail a request.

## Rollback

| Situation | Action |
|---|---|
| Bad release, schema unchanged | Deploy the previous image tag: `helm rollback rocketpod`, or `ROCKETPOD_IMAGE=…:<previous>` then `docker compose up -d` |
| Schema migration must be undone | Migrations are forward-only: write a compensating migration and release it. Rolling the image back never touches the database (the migrate hook runs on install and upgrade only) |
| RLS enforce misbehaving | `config.TENANT_SCOPE_MODE=off` and roll the pods — no migration (`docs/RLS.md`) |
| Tenant AI keys unreadable after rotating `OAUTH_ENCRYPTION_KEY` | There is no re-encrypt path: admins re-enter the key in Settings → AI; the platform keys are unaffected |

Verify any rollback with `/auth/session` (`releaseVersion`) and `rocketpod status`.
