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
`node:26-alpine` with npm and yarn removed (Node 26 ships no corepack) — two bundles, `dist/ui`, the drizzle SQL and
the Guide's content (`content/guide`: pages, images, any committed vectors — every `web` boot
chunks the pages into `guide_chunks`, so a release with edited pages needs nothing else run),
about 14 MB on top of Node — running as the `node` user (uid 1000). It writes nothing to its
filesystem outside `/tmp`, so a read-only root filesystem works (Kubernetes
`readOnlyRootFilesystem`, AWS ECS Fargate `readonlyRootFilesystem`): `/tmp` is a declared `VOLUME`
owned by `node`, so Docker and Fargate mount a fresh writable volume there and the chart mounts an
`emptyDir`. Nothing the server or the migrate entry runs writes anywhere else (the only `writeFile`
in the app is `pnpm web guide:index`, a dev script). The image also carries the AWS RDS CA bundle
for `DATABASE_SSL=verify-full` (§ TLS to Postgres).

**What it needs outside itself:**

- **Postgres 17 with pgvector.** Migrate runs `CREATE EXTENSION IF NOT EXISTS vector`, so the owner
  role must be allowed to create it, or it must already exist. The same goes for `pg_trgm`
  (created the same way, used by the knowledge-facts entity matcher), which every managed Postgres
  offers but some only allow-list on request. Migration `0014_kit-knowledge-base` rebuilds
  `chunks.search_vector` and so rewrites the whole `chunks` table under an exclusive lock: with
  more than about a million chunks, run it in a maintenance window. One owner connection,
  `DATABASE_URL`, is used by migrate and by every process's pool (`DATABASE_POOL_MAX`, default 10 per
  process — plus a small pool each for pg-boss and OpenWorkflow, and one dedicated connection per
  `web` process for realtime). `DATABASE_SSL` puts every one of them on TLS (§ TLS to Postgres).
- **A LISTEN-capable connection for realtime.** `/ws` fans out across pods with Postgres
  `LISTEN/NOTIFY` on one dedicated connection per `web`/`all` process. PgBouncer in
  **transaction** mode breaks `LISTEN`: point `DATABASE_LISTEN_URL` straight at Postgres (or at a
  session-mode pool). Unset, it is `DATABASE_URL`.
- **An S3-compatible bucket** (`STORAGE_*`): AWS S3, GCS (interoperability mode),
  MinIO, Versity, Ceph… — only the endpoint and path style differ. Unset, uploads answer 503. The
  store must honour `Range` on `GetObject` (a ranged download from one that ignores it is an error,
  not a wrong body) and multipart uploads (`putStream`); every store named here does.
  `STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` are a pair or neither: with neither, the
  client signs with the AWS SDK's default credential chain — on AWS (ECS task role) no key is
  stored at all (§ Storage on AWS).
- **An AI provider key**, for chat, agents or knowledge: `ANTHROPIC_API_KEY`, or `AI_API_KEY`
  (+ `AI_BASE_URL`/`AI_MODEL` for any OpenAI-compatible endpoint such as OpenRouter). Knowledge
  uploads also need `EMBEDDINGS_API_KEY` (+ `EMBEDDINGS_BASE_URL`/`EMBEDDINGS_MODEL`) for an
  endpoint that returns **1024-dimension** vectors. No key → those features answer 503 and the rest
  of the app works.
- **Email** for magic links and invitations: `EMAIL_PROVIDER` (`log|resend|ses`; unset = `resend`
  when `RESEND_API_KEY` is set, else `log`) and `EMAIL_FROM`. Without a provider the link is logged
  by the process that sends it: a magic link by **web** (sent inline — a person is waiting), an
  invitation by **worker** (`email.send` is a job). See § Email.

## Docker Compose

`docker-compose.yml` at the repository root is self-contained: `postgres` (pgvector 17), `s3`
(Versity S3 Gateway over a volume, bucket created on start), `migrate` (one-shot), `web` and
`worker`. Every value has a default, so it runs as-is on a laptop:

```bash
docker compose up -d --build          # builds rocketpod:local once (the migrate service builds it)
open http://localhost:3001
docker compose logs -f web worker     # magic links (web) and invitations (worker) with no email provider
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
  `TRUSTED_PROXY_HOPS` defaults to `1` (an ingress controller in front). `APP_VERSION_ID` — the
  build each agent-run attempt records as `worker_version_id`, so `rocketpod agents inspect` says
  which build a run last ran on — defaults to `image.tag` (else the chart's `appVersion`); set it
  only to override. Compose passes `APP_VERSION_ID` through from its `.env` (blank → not recorded).
  `AGENT_TRANSCRIPT_RETENTION_DAYS` (30) is how long a settled run keeps its tool-loop journal.
- **`secrets`** (→ Secret) or **`existingSecret`** — the name of a Secret you manage (External
  Secrets, Sealed Secrets, Vault) with the same keys. `DATABASE_URL` is required either way. The
  migrate hook runs before the release's own Secret exists, so it reads `DATABASE_URL` and
  `APP_DATABASE_URL` from `migrate.existingSecret`, else `existingSecret`, else a hook-scoped copy
  the chart renders; `migrate.ownerOnly` keeps `DATABASE_URL` out of what web and worker read
  (§ Two database logins).
- **Ingress and `/ws`.** ingress-nginx proxies WebSocket upgrades as they are. Raise its timeouts so
  idle sockets survive (`nginx.ingress.kubernetes.io/proxy-read-timeout` / `proxy-send-timeout:
  "3600"`) and allow 5 MB uploads (`nginx.ingress.kubernetes.io/proxy-body-size: "6m"`). An
  installed plugin may take more: up to 10 MB beneath its `uploadPaths` and up to 50 MiB on an
  exact `uploadLimits` path, so raise `proxy-body-size` to the largest cap a plugin declares, or
  the ingress answers 413 before the app sees the request.
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
there are. The worker's cron: `0 4 * * *` prunes (sessions, links, invitations, `ai_spans`,
`plugin_events`, and the tool-loop journal `agent_run_turns` of runs settled more than
`AGENT_TRANSCRIPT_RETENTION_DAYS` ago); `*/10 * * * *` runs `sweepLostRuns` (up to 100 active
runs untouched for 10 minutes, oldest first: a `queued` row with no engine run gets one, a failed
engine run → `failed`, a canceled one → `cancelled`, a completed one → `succeeded`, a park whose
asks all expired → `cancelled`; a running or waiting run is left alone) and `sendReminders` (one
reminder per pending ask past its `remind_at`, up to 100 a sweep). Size Postgres `max_connections` for roughly
`(web + worker replicas) × (DATABASE_POOL_MAX + 8)`.

## Public site hosts

A plugin declaring `publicSites` (`docs/CONCEPTS.md` §16) answers whole websites on hosts of its
own: on a claimed host its router answers every path, and `/api/*`, `/auth/*` and `/ws` do not exist
there. Its manifest names the var that lists those hosts (`"publicSites": { "hostsVar":
"SITES_HOSTS" }`), and the plugin's `hosts(config)` reads it. Nothing in Rocketpod routes by host
before the app: the Node server receives every host the ingress or proxy sends it, and
`middleware/public-sites.ts` (after the database middleware, before every mount) picks the plugin
from the request URL's own host, never a forwarded header. So a site host needs three things, per
environment:

- **The var.** Set the plugin's hosts var (`SITES_HOSTS=www.example.com,docs.example.com`, in the
  plugin's own format) in `.env`, the Compose environment or the Helm values below.
- **The proxy accepts the host and passes `Host` through.** With the chart, list the hosts once:

  ```yaml
  publicSites:
    hostsVar: SITES_HOSTS        # the manifest's publicSites.hostsVar
    hosts: [www.example.com, docs.example.com]
  ingress:
    tls:
      - secretName: sites-tls
        hosts: [www.example.com, docs.example.com]
  ```

  The chart sets `SITES_HOSTS` to the list, comma-separated, in the ConfigMap, and gives every host
  an ingress rule for `/` to the same Service; the render fails on `hosts` with no `hostsVar`. If
  the plugin's var carries more than bare hosts (`www.example.com=www`), leave `hostsVar` empty, set
  the var under `config` yourself and add the hosts to `ingress.hosts`. With Compose, or any proxy
  of your own, route the hosts to the `web` service and keep the `Host` header (Caddy and
  ingress-nginx do by default; nginx needs `proxy_set_header Host $host`).
- **DNS and a certificate** for each host, pointing at the ingress, and the hosts in the TLS
  secret. An apex host is allowed; redirecting `example.com` to `www` belongs in the proxy.

The app's own host (`APP_URL`'s) can never be claimed, and a claim the gate refuses (a duplicate,
an uppercase host, a port) fails `tests/config/plugins.test.ts` (`publicSiteIssues`). While a
plugin's `hosts` answers null (its config is bad), every host other than the app's and loopback
gets a plain, uncached 503, so a site host never falls through to the admin app.

Static files on a site host: the server serves `/assets/*` (the admin bundle) and `/site-assets/*`
(a public site's own scripts and styles) from the UI build before the app runs, on every host; any
other path, root files such as `/robots.txt` included, goes through the app, so on a site host the
plugin answers it. A site's CSP loads scripts and styles from `<origin>/site-assets/` only, so a
site page cannot load the admin bundle. A missing file under either prefix is a 404, never the
shell. `Strict-Transport-Security` carries `includeSubDomains` only on `APP_URL`'s host, so a site
on an apex domain does not pin its subdomains.

**No response cache.** Rocketflare stores a site's cacheable pages in the Workers Cache API
(`publicSites.cache`); a Node process has none, so Rocketpod accepts the declaration and every page
request reaches the plugin's router. Put a CDN in front of the site hosts for shared caching.

## The MCP server

`/mcp` (`docs/CONCEPTS.md` §19, `SETUP.md` §2.10) exists only where `FEATURES_ENABLED` lists `mcp`
— the knob that keeps it dark in production while staging has it — and then per organisation at
Settings → MCP. Three things about the deployment:

- **`APP_URL` must be the public https origin** clients reach: the resource URL, the token
  audience and the OAuth issuer all derive from it. Route `/mcp`, `/mcp/t/*`, `/oauth/*` and
  `/.well-known/oauth-*` to `web` like the rest of the app (the chart's single Service does).
- **`web` makes outbound https requests** to the URL a client names as its `client_id` (its
  metadata document, Claude's and ChatGPT's included). The fetch refuses to connect to any
  loopback, private, link-local or reserved address, judged on the resolved address
  (`src/node/egress.ts`), so it never reaches the cluster network — but an egress policy that
  blocks the internet blocks every client.
- **Optional outside issuer**: `MCP_AUTHORIZATION_SERVER` (a ConfigMap value, not a secret) makes
  `/mcp` accept that server's JWTs as well; `web` reads its JWKS over https (`SETUP.md` §2.3d).

## TLS to Postgres

`DATABASE_SSL` sets TLS for **every** Postgres connection a process opens — the pool, the realtime
publisher and `LISTEN` connection (`DATABASE_LISTEN_URL` included), pg-boss, OpenWorkflow, and
the migrate one-shot (Compose passes it to `migrate` like to every app service; the chart inlines
`config.DATABASE_SSL` into the migrate Job, which runs before the ConfigMap exists):

| `DATABASE_SSL` | Meaning |
|---|---|
| unset | As before: the URL's own `sslmode` decides, else no TLS |
| `off` | No TLS |
| `require` | TLS, the server certificate **not** verified (encrypts against a passive listener only) |
| `verify-full` | TLS, the certificate verified against Node's trust store plus `NODE_EXTRA_CA_CERTS`, and the hostname checked |

**One place decides.** With `DATABASE_SSL` set, a database URL (`DATABASE_URL`,
`PREVIEW_DATABASE_URL`, `DATABASE_LISTEN_URL`) that carries a TLS parameter of its own (`sslmode`,
`ssl`, `sslrootcert`, `sslcert`, `sslkey`, `uselibpqcompat`) is a startup error naming the var:
remove it from the URL, or unset `DATABASE_SSL`. The two drivers in the process read those
parameters differently (node-postgres, under pg-boss, lets the URL override its option and treats
`sslmode=require` as `verify-full`), so a URL and `DATABASE_SSL` that disagreed would give
different connections different TLS. Client certificates (`sslcert`/`sslkey`) stay a URL-only
setup with `DATABASE_SSL` unset.

**On AWS (RDS, Aurora).** Use `DATABASE_SSL=verify-full` with the RDS endpoint's hostname in the
URL. The image carries the AWS RDS global CA bundle at `/etc/ssl/certs/rds-global-bundle.pem`
(downloaded at build time and pinned by sha256 — `RDS_CA_BUNDLE_SHA256` in the `Dockerfile`, bumped
with the bundle) and sets `NODE_EXTRA_CA_CERTS` to it, so nothing else is needed. Set the parameter
group's `rds.force_ssl=1` so the database refuses a plain connection too. The extra bundle is
harmless anywhere else: `NODE_EXTRA_CA_CERTS` only adds trust anchors to Node's own.

**Another CA** (a self-managed Postgres, a private CA): build an image `FROM` this one that copies
your PEM bundle in and points `NODE_EXTRA_CA_CERTS` at it (one file — concatenate the RDS bundle if
you need both), or mount the file and set the variable on the container. Node reads it once, at
start, and only warns on a bad path, so with `verify-full` the server and the migrate entry check
the file themselves and refuse to start when it is missing or holds no certificate. A server
certificate a public CA signed needs no bundle at all.

## Two database logins

For an infrastructure that provides an owner login for migrate only and a separate login for the
app (`docs/TENANT-ISOLATION.md` is the model):

- **`DATABASE_URL`** is the OWNER: the role that owns the database's schema, made by an outside
  bootstrap (with the database itself) or by you. Give it CREATEROLE: the migrate one-shot creates
  roles. Only migrate needs it once the app login is in use.
- **`APP_DATABASE_URL`** is the app login: any user name but the owner's, `rocketpod_app` or
  `rocketpod_system`, with a password. Migrate creates that role if it is missing, sets the URL's
  password on it (as a SCRAM verifier), makes it NOINHERIT, grants it the two NOLOGIN roles and
  grants it CONNECT on the database, so a bootstrap that ran `REVOKE CONNECT … FROM PUBLIC` is
  fine. Set, `web` and `worker` connect with it for everything (the pool, pg-boss, OpenWorkflow,
  realtime), as `rocketpod_system`: DML on the app's tables and the engines' schemas, no DDL, no
  table of its own. `DATABASE_SSL` applies to it as to every connection.

Rollout: give `APP_DATABASE_URL` to migrate first and deploy (migrate creates the login), then to
web and worker, then take `DATABASE_URL` away from web and worker. In Compose, `&app-env` passes
both to every service, so the last step is a per-service override. In Helm, `secrets.APP_DATABASE_URL`
and `migrate.ownerOnly: true` leave `DATABASE_URL` out of the release Secret, so only the migrate
hook's Secret carries it; with `existingSecret`, name the Job's own Secret in
`migrate.existingSecret` and keep `DATABASE_URL` out of `existingSecret`.

The owner must be able to grant the login what it needs: `CREATEROLE` (and, on Postgres 16+, the
ADMIN option it gets on roles it created itself), `GRANT` on the `public` schema, and ownership of
the database for `GRANT CONNECT`. Without the last, migrate stops with a message naming the grant
to run when the login cannot connect. Watch for `42501` (permission denied) after web and worker
move over: it names a privilege the runtime uses that the grants do not cover.

## Storage on AWS

On AWS S3 set `STORAGE_DRIVER=s3`, `STORAGE_BUCKET` and `STORAGE_REGION`, leave `STORAGE_ENDPOINT`
empty (the regional AWS endpoint) and `STORAGE_FORCE_PATH_STYLE=false`, and leave both
`STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY` unset. The S3 client then reads
credentials from the AWS SDK's default chain: the ECS task role, an EKS service-account role, an
instance profile, `AWS_*` variables or a profile. Setting exactly one of the two keys is a config
error at start-up. The role needs, on the bucket (`arn:aws:s3:::<bucket>`) `s3:ListBucket`, and on
its objects (`arn:aws:s3:::<bucket>/*`) `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`,
`s3:AbortMultipartUpload` and `s3:ListMultipartUploadParts` (streamed uploads are multipart). A
bucket encrypted with a customer-managed KMS key also needs `kms:GenerateDataKey` and
`kms:Decrypt` on that key.

## The storage tenant fence

With `STORAGE_TENANT_FENCE=shadow|on` each tenant's object calls are signed by an STS session of
its own, so the bucket, not only the app, keeps tenants apart (design and rollout:
`docs/TENANT-ISOLATION.md` § The storage fence). The infrastructure provides a **files role**, set
as `FILES_ROLE_ARN`, and the app does the rest. The contract, described for any IAM-shaped setup:

- **Trust.** Only the app's identity (the ECS task role, the pod's IRSA / Pod Identity role) may
  `sts:AssumeRole` and `sts:TagSession` on it. The app sends exactly one session tag, `tenant`,
  whose value is the tenant id (a UUID), so the trust policy can require it
  (`aws:RequestTag/tenant` present, `aws:TagKeys` only `tenant`) and refuse a value containing `*`,
  `?` or `/`. Sessions last 3600 s, so the role's maximum session duration must be at least one
  hour. The session name is `tenant-<id>`, which is what the audit trail shows.
- **Permissions.** Objects under `arn:aws:s3:::<bucket>/tenants/${aws:PrincipalTag/tenant}/*`:
  `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload`,
  `s3:ListMultipartUploadParts`. On the bucket, `s3:ListBucket` with the condition `s3:prefix` in
  `tenants/${aws:PrincipalTag/tenant}/` and `tenants/${aws:PrincipalTag/tenant}/*`. A
  customer-managed KMS key: `kms:GenerateDataKey` and `kms:Decrypt` through S3 only
  (`kms:ViaService`).
- **The app's own identity** keeps the § Storage on AWS grants while `shadow` (it serves the
  fallbacks) and needs `sts:AssumeRole` + `sts:TagSession` on the files role.
- **The bucket**, once `on` has run clean: a policy denying object actions to every principal but
  the files role (and whoever operates the bucket).

The key layout is fixed: `tenants/<tenantId>/…`, nothing outside it. Leave the fence `off` on a
store without STS (MinIO, the local gateway); the per-tenant key check applies in every mode.

## Email

- **Resend**: `RESEND_API_KEY` (a secret) and `EMAIL_FROM` on a domain verified in Resend. Setting
  the key is enough; `EMAIL_PROVIDER=resend` makes a missing key a startup error instead of a
  silent fall back to the log.
- **Amazon SES** — on AWS (ECS task role, SES), with no key in config: `EMAIL_PROVIDER=ses`,
  `EMAIL_FROM` an address or domain **verified in SES** (the server refuses to start without
  `EMAIL_FROM`), and `ses:SendEmail` granted to the task role (Kubernetes: the pod's IRSA / Pod
  Identity role) on that identity — and on the configuration set when `SES_CONFIGURATION_SET` is
  set. `SES_REGION` picks the SES region; unset, the SDK uses `AWS_REGION` (ECS sets it to the
  task's region). The client reads credentials from the AWS SDK's default chain (task role,
  instance profile, `AWS_*` variables), so Compose on a plain host needs those in the container's
  environment (an override file). An account still in the SES sandbox delivers only to verified
  recipients; a refusal is logged and the `email.send` job retries it.

## Secrets checklist

| Key | Needed for |
|---|---|
| `DATABASE_URL` | The owner: migrate always; web and worker too unless `APP_DATABASE_URL` is set (required) |
| `DATABASE_LISTEN_URL` | Realtime behind PgBouncer in transaction mode |
| `APP_DATABASE_URL` | A separate non-owner login for web and worker (§ Two database logins); required by `TENANT_SCOPE_MODE=enforce` |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | Uploads, documents, avatars — a pair or neither; on AWS (ECS task role) neither (§ Storage on AWS) |
| `OAUTH_ENCRYPTION_KEY` (32+ chars) | OAuth/OIDC sign-in and tenant AI keys at rest |
| `RESEND_API_KEY` | Delivering magic links and invitations through Resend (otherwise logged; SES needs no key — § Email) |
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
`ci.yml`'s (its `Gate` check, the aggregate of its parallel jobs), but a tag waits for it:
image.yml's `ci` job holds the push until the CI workflow has passed on the tagged commit (30
minutes at most), and a failed or missing run stops the release — so push the commit to `main`
first, then tag it. The build overlaps that wait: `image` builds without pushing (layers cached to
the GitHub Actions cache) while `ci` waits; only then does `publish` log in and re-run the build
from the warm cache with `push: true`.

**Version rule.** The tag is `X.Y.Z` (or `vX.Y.Z`) and must equal `version` in the **root**
`package.json`; one tag ships the image and the CLI, and the `apps/*` and `packages/*` versions are
informational. In an app that is the whole release: bump the root version, add its section to your
own `CHANGELOG.md`, commit, push to `main`, tag. *Kit repository only:* `pnpm kit:release X.Y.Z`
does the bump instead — it folds `docs/upgrades/unreleased.md` into `docs/upgrades/X.Y.Z.md`,
stamps `.rocketflare.json` `kit.version`, prepends the `CHANGELOG.md` section, and refuses a
version whose `defaultPlugins` no longer resolve at their pinned ref — and `kit.yml` fails a PR
touching `apps/**` or `packages/**` with no porting note, because that note is how every copy
absorbs the release; a released kit tag is never force-pushed, because every copy pins a kit
commit. An app has neither the command nor the check (the rename removes both), and writes no
porting note.

**A tag is a release, and once a deploy job hangs off it, a production deploy.** A copy that adds
one (`needs: [ci, chart, publish]`) deploys every version tag it pushes; nothing asks again. Before
tagging, read the gate's own verdict (`✔ pnpm gate passed`, or `.gate/last.json`), never an exit
code piped through `tail`.

The CLI (`apps/cli`) is not part of the image: it runs on people's machines
(`rocketpod login --server https://app.example.com`).

## Observability

- **Logs:** structured JSON (pino) on stdout from every process — collect them with whatever the
  platform uses. `LOG_LEVEL` sets the floor.
- **Access logs carry credentials.** The app's own request lines log the path without its query
  string and with the token in `/api/invite/<token>` redacted, but anything in front of it does
  not: the chart's Ingress sets no logging annotations, so ingress-nginx writes its default access
  line (`$request`: method, full URL with query string, status) for every request, and so do a
  Compose reverse proxy, a load balancer and a CDN. Those lines record `GET
  /auth/magic-link/verify?token=…` and `GET /api/invite/<token>` URLs, which are sign-in and
  invitation credentials until used or expired. Treat access to those logs (and wherever they are
  shipped) as sensitive, or strip the query string in the proxy's log format.
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

Prompts, completions and tool I/O are not captured unless `OBSERVABILITY_CAPTURE_CONTENT=true`,
which records them in both the export and `ai_spans` (names, models, tokens and latency are always
kept). Export failures are logged (`tracing: OTLP export returned a non-OK status`) and
never fail a request.

## Rollback

| Situation | Action |
|---|---|
| Bad release, schema unchanged | Deploy the previous image tag: `helm rollback rocketpod`, or `ROCKETPOD_IMAGE=…:<previous>` then `docker compose up -d`. Agent runs in flight resume on the rolled-back code: a rollback that also rolls back an agent's `meta.version` applies its `onVersionChange` like any other version change |
| Schema migration must be undone | Migrations are forward-only: write a compensating migration and release it. Rolling the image back never touches the database (the migrate hook runs on install and upgrade only) |
| RLS enforce misbehaving | `config.TENANT_SCOPE_MODE=off` and roll the pods — no migration (`docs/RLS.md`) |
| Tenant AI keys unreadable after rotating `OAUTH_ENCRYPTION_KEY` | There is no re-encrypt path: admins re-enter the key in Settings → AI; the platform keys are unaffected |

Verify any rollback with `/auth/session` (`releaseVersion`) and `rocketpod status`.
