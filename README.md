<p align="center">
  <img src="apps/web/src/ui/public/logo.svg" alt="Rocketpod" width="160" />
</p>

<h1 align="center">Rocketpod</h1>

<p align="center"><strong>A multi-tenant SaaS starter kit that runs in a container — Node, Postgres and any S3-compatible store. Copy it, rename it, ship an internal tool or a B2B product.</strong></p>

Rocketpod is one repository that already solves the platform work every internal or B2B product
needs before its first real feature: tenancy, sign-in, roles and permissions, background jobs,
realtime, file storage, an AI layer (chat, agents, retrieval) and a CLI —
running as one Node server over Postgres (jobs, cron, durable agent runs and realtime fan-out all
live there) plus an S3-compatible object store, with a React UI and a shared contract package that
keeps the API, the UI and the CLI in agreement. It is a hard fork of
[Rocketflare](https://github.com/rocketflare-dev/rocketflare) with no Cloudflare dependency
([`docs/FORK.md`](docs/FORK.md)) — one container image, run with Docker Compose or the Helm chart
([`docs/DEPLOY.md`](docs/DEPLOY.md)). The first local run needs **zero external credentials** (AI
features wait for a provider key), and the codebase is written to be driven by a coding agent: `CLAUDE.md`,
`.claude/rules/`, per-directory guides and a "how it works" reference mean the next feature is a
contract → schema → route → page (→ command) loop, not a platform project.

## Getting started

The kit is a starting point, not a dependency: take a copy, cut it loose from this repository's
history, and make it your own — you will rename, delete and rewrite freely, and you never merge from
here. Cut loose is not cut off: your copy keeps a `.rocketflare.json` saying where it came from, and
`/rp-upgrade` ports later kit releases into it without recreating anything you deleted.

**Ask your coding agent.** Open the copy in Claude Code and type **`/rp-setup`** — it checks the
toolchain, starts Postgres, migrates, seeds the demo workspace and leaves you signed in, showing one
verification line per step. Then **`/rp-adapt <slug> "Your App"`** renames the kit to your app.
**`/rp-plugin`** installs a capability as a plugin — a git repository copied into your
app, with the plan shown before anything is written. Later, when the kit has moved on,
**`/rp-upgrade`**.

**One command.** Read [`scripts/install.sh`](scripts/install.sh) first — it is short — then:

```bash
curl -fsSL https://rocketpod.example.com/install.sh | bash -s -- myapp   # clone → detach → bash scripts/bootstrap.sh
```

**By hand**, if you would rather see each step (macOS or Linux; Windows through WSL2):

```bash
git clone https://github.com/rocketflare-dev/rocketpod.git myapp && cd myapp
rm -rf .git && git init && git add -A && git commit -m "Start from Rocketpod"   # your history starts here
git remote add origin git@github.com:<you>/myapp.git                              # your own repo, when ready

bash scripts/bootstrap.sh          # checks Node 24 / pnpm 10 / Docker, generates the local secret, starts
                                   # Postgres, migrates, seeds demo data, starts the app and opens the
                                   # browser signed in as the demo owner. Re-runnable.
                                   #   --no-demo  seed the bare tenant and users only (plain `pnpm seed`)
                                   #   --db-url <url>  no Docker: use an existing Postgres
```

`SETUP.md` Part 1 is the same thing written out, one verification line per step.

**Just run it in containers** (no Node toolchain needed):

```bash
cp deploy/compose.env.example .env    # set APP_URL, OAUTH_ENCRYPTION_KEY, an AI key
docker compose up --build             # postgres + S3 gateway → migrate → web + worker on :3001
```

[`docs/DEPLOY.md`](docs/DEPLOY.md) covers Compose and the Helm chart (`deploy/helm/rocketpod`).

Nothing external is required: no `RESEND_API_KEY` → magic-link URLs are logged by the server; no AI
key → chat, agents and uploads answer 503 until you set `ANTHROPIC_API_KEY` or `AI_API_KEY` (any
OpenAI-compatible endpoint) and `EMBEDDINGS_API_KEY` in `apps/web/.env`.
Then `pnpm gate` — lint, typecheck, test and build, the same command CI runs; `pnpm test` starts a
throwaway Postgres on :5533 and an S3 gateway on :7433 itself and runs every suite. Before
building your app, rename it: `/rp-adapt` or [`docs/ADAPTING.md`](docs/ADAPTING.md). Later,
`/rp-upgrade` (or `pnpm kit:upgrade`) reads `.rocketflare.json` and the release notes in
[`docs/upgrades/`](docs/upgrades/), translates the kit's diff into your names, and skips every part
you removed. [`CHANGELOG.md`](CHANGELOG.md) is what you would be catching up on.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node 24: one server (`web` / `worker` / `all` modes) — Hono on `@hono/node-server`, pg-boss jobs + cron, OpenWorkflow agent runs |
| API | Hono 4, zod contracts, CASL abilities, JSON error envelope everywhere |
| Database | Postgres 17 + pgvector — Docker locally, any Postgres deployed, over `postgres.js` with one pool per process; Drizzle |
| UI | React 18 + Vite, DaisyUI 5 on Tailwind v4, React Router 6, TanStack Query 5; served by the Node server |
| CLI | commander + chalk; browser login → tenant API key; `--json` on every list command |
| Async / realtime | pg-boss jobs and cron, OpenWorkflow durable runs, WebSockets with LISTEN/NOTIFY fan-out, S3-compatible storage |
| AI | Anthropic / OpenAI-compatible chat streamed as AG-UI, agents on OpenWorkflow, OpenAI-compatible embeddings → pgvector, local PDF/Word conversion, OTLP tracing (Langfuse, Phoenix, any backend), evals (vitest-evals) with thumbs feedback |
| Deploy | one `node:24-alpine` image (`web` / `worker` / `all` + a migrate one-shot), Docker Compose, a Helm chart |
| Analytics | optional plugin: drizzle-cube semantic layer, fact tables on a cron, dashboards (not installed by default yet) |
| Quality | Biome 2, strict TypeScript, vitest against real Postgres, gitleaks, one CI gate |

## Features

### Tenancy and access
- **Multi- or single-tenant from one schema** — `TENANCY_MODE=multi|single`. Every domain row carries a `tenant_id`; single mode auto-joins users to the one organisation and hides the org switcher. Flip later with no migration.
- **Sign-up policy as configuration** — `SIGNUP_MODE=open|invite_only|approval`: personal tenants, invite-only, or an access-request queue that global admins approve into a new or existing tenant, with an optional email-domain allow-list.
- **Roles and abilities** — `owner | admin | member` per tenant plus a platform `support` role and global admins; CASL abilities are computed server-side and shipped to the UI (`<Can>`, `RequireAbility`) so pages and nav use the same guard as the route.
- **Invitations and members** — create, bulk-invite, resend, revoke, accept; change roles, remove members, transfer ownership; activity log of everything.
- **Admin area** — `/admin` for global admins: tenants, users, access requests; "enter" a customer tenant as `support` with a real membership row, so the single "must be a member" invariant never bends.
- **Isolation by predicate, RLS in reserve** — every query filters by the session's tenant; every tenant table also ships a row-level-security policy, inert until `TENANT_SCOPE_MODE=enforce` (`docs/RLS.md`), with a catalog test that fails CI if a table is missed.

### Authentication
- **Magic link** (random single-use token, hashed at rest) — works with no email provider: the URL is logged locally.
- **OAuth registry** — Google and Microsoft via arctic; adding a provider is one definition file. Account linking by verified email, tokens AES-GCM encrypted, PKCE state in one cookie.
- **Any OIDC issuer** (Okta, Entra ID, Keycloak, Auth0…) — off until `OIDC_ISSUER` is set: discovery, PKCE + nonce, `id_token` verified against the issuer's JWKS. `AUTH_OIDC_ONLY` makes it the only sign-in; logout follows the issuer's `end_session_endpoint`.
- **Sessions as rows** — `__Host-session` cookie, 7-day sliding TTL, one LATERAL query per request.
- **Tenant API keys** — hashed, scoped, expirable, revocable from Settings; the Bearer path shares the auth middleware and abilities with the UI.
- **Hardening built in** — CSRF by origin allow-list, Postgres sliding-window rate limits on login routes, security headers, body limits, dev-login that 404s in production, `gitleaks` in CI.

### Background work and realtime
- **Jobs queue** — pg-boss in Postgres with typed envelopes (`email.send`, `document.index`, …); invalid messages are acked (never loop), handler errors retry with capped backoff into a dead-letter queue; a missing queue is a 503 rather than running work inline.
- **Durable agent runs** — OpenWorkflow in Postgres: multi-step runs (`claim → execute → finish`) that survive a crash or redeploy, park for a human answer and resume; the database row is the claim, so retries re-claim and settled rows are never rewritten; no in-memory concurrency anywhere.
- **Cron** — pg-boss schedules keyed on the cron expression, run once across any number of worker replicas: nightly pruning, plugin tasks.
- **Realtime** — WebSockets on the Node server, fanned out across pods with Postgres LISTEN/NOTIFY; the server "nudges" (`member.changed`, `invitation.changed`, `entity.changed { entity, id }`…) and the UI re-queries. **The database is the truth; the WebSocket is a nudge.** Reconnecting client with backoff, header status dot, outage banner.

### Email and files
- **Email** through Resend over plain `fetch` with shared templates (magic link, invitation, accepted, access decision); absent an API key, messages are logged, never failed. Invitation mail is queued; the magic link stays inline because someone is waiting.
- **File storage** on any S3-compatible store (AWS S3, R2, MinIO, GCS…) behind a `StorageService` seam: tenant-prefixed keys, bytes streamed through the server, an indexed `files` table, per-scope MIME and size limits, avatars wired end-to-end (upload UI → `/api/files/:id` with ETag/304).

### AI layer
- **Tiered provider resolution** — per-agent model assignment → the tenant's own provider (keys encrypted at rest, tested from Settings → AI) → a platform Anthropic key → a platform OpenAI-compatible key (OpenRouter, vLLM, Ollama…) → a clean 503. Providers: Anthropic, Anthropic-compatible (Fireworks, Moonshot presets), OpenAI, OpenAI-compatible.
- **Streamed chat** — conversations and messages persisted per user, SSE frames with a shared event contract, auto-titles, prompt caching breakpoints, extended thinking off unless a tenant turns it on.
- **Prompt registry** — prompts are code with `{{variables}}`; tenants override them in Settings → Prompts and revert with one click.
- **Agents** — `POST /api/agents/runs` enqueues and answers 202; runs are exclusive per tenant and agent via a partial unique index, emit a durable event timeline, cancel cooperatively, ask a human and wait, and reconcile against the run engine on read. The `summarize-text` example shows structured output through a forced tool call; an Agents page shows live timelines.
- **Retrieval** — ingest text into `documents`/`chunks` (paragraph-aware chunking, inline or queued indexing), `vector(1024)` embeddings with an HNSW index, and **hybrid search**: dense cosine + lexical `tsvector`, fused with Reciprocal Rank Fusion. Vectors are ordinary tenant-scoped rows.
- **Document uploads** — PDF, Word, HTML and XML are stored in object storage and converted on the server (`unpdf`, `mammoth`) in a `document.convert` job, then indexed like pasted text; the original stays downloadable. Agents read the same knowledge base through built-in `search_knowledge` / `get_document` / `list_documents` tools.
- **Usage ledger and tracing** — one `ai_usage` row per model call with token counts and a usage summary endpoint; vendor-neutral OTLP traces with GenAI conventions (agent → model calls, tools, retrieval, embeddings) exported to Langfuse, Phoenix or any OTLP backend after the response, and always recorded locally so `rocketpod traces show <runId>` works with zero config — no OpenTelemetry dependency.
- **Evals and feedback** — `pnpm eval` runs vitest-evals suites against the real chat route and agent runtime in-process, with deterministic judges (tool trajectory, schema, contains, budget) and LLM judges (rubric, faithfulness to what was retrieved, reference answer) that go through the kit's own model resolver; runs are JSON with committed baselines and `--compare` regression checks, plus a local report UI. Thumbs on chat replies and run output feed `rocketpod evals promote`, which turns a bad real answer into a draft case. The `/rp-evals` skill drives all of it.

### Analytics (plugin)
The `analytics` plugin adds these; its current release still declares Cloudflare bindings, so it is
not installed by default until a container-ready release exists (`docs/CONCEPTS.md` §8).
- **Semantic layer** — drizzle-cube mounted at `/cubejs-api` and `/mcp` behind the app's auth; every cube scopes its SQL to the current tenant, and a mandatory isolation test queries every cube as two tenants and asserts disjoint rows.
- **Fact tables** — plain tables rebuilt per tenant in one transaction by the hourly cron, with a freshness endpoint and `rocketpod analytics check-facts` for ops.
- **Dashboards** — TypeScript templates copied into each tenant's `analytics_pages` (seeded on tenant creation and lazily on first read), editable in the UI with autosave, reset-to-template and recreate; an explore/query-builder page; a shipped "Organisation Overview" dashboard.
- **MCP** — the same semantic layer is an MCP endpoint, so an AI client can query a tenant's analytics with a tenant API key.

### CLI
- `rocketpod login` opens the browser, completes sign-in and tenant selection in the app, and receives a tenant API key on a loopback callback — stored `0600` in `~/.rocketpod/config.json`, never printed in full.
- `whoami`, `status`, `members list`, `keys list`, `activity list`, `traces list|show` (the AI span tree of a run or chat turn, admin+), `feedback list` and `evals promote` (turn a thumbs-down into an eval case, admin+), `config`; `--json` prints only the parsed response so output pipes into `jq`; `ROCKETPOD_API_KEY` / `ROCKETPOD_URL` replace the config file in CI.
- Every response is parsed with the same zod schema the server validated with; exit codes distinguish "not logged in" (2) and "forbidden" (3) from other errors (1).

### Developer experience
- **Contracts first** — `packages/shared` holds the zod schemas the API validates with and the UI and CLI parse with; consumed as TypeScript source, no build step.
- **Release = root version** — tag = root `package.json` version; a tag pushes the image to `ghcr.io/rocketflare-dev/rocketpod`, and CI lints and validates the Helm chart.
- **Tests that mean something** — API tests drive the real Hono app against a real Postgres; queue consumers, the agent-run body and cron tasks are plain functions tested directly, and the Node adapters run against real Postgres and an S3 gateway; UI tests in jsdom; a config project checks the no-Cloudflare guard, permissions and dashboard templates with no database.
- **Agent-readable** — `CLAUDE.md` (also `AGENTS.md`), path-scoped rules in `.claude/rules/`, a `CLAUDE.md` in every significant directory, and `docs/CONCEPTS.md` describing each subsystem, its invariant and its known gaps.
- **Plugins** — a feature can be a separate git repository copied in (never npm-installed, exactly like the kit): five barrels take one line each, and a plugin contributes contracts, tables with RLS policies, routes, jobs, agent tools, lifecycle hooks, lazy pages, nav items and CLI commands without a core file naming it. In the other direction it imports the kit only through declared entries — a family of injected execution contexts, versioned as `PLUGIN_API` and documented in a generated, diff-checked `docs/plugin-api.md` — so the plugin surface can stand still while kit internals move. `pnpm plugin check` is an exhaustive audit whose every finding carries the file, the line and the exact edit, and CI runs the same command; `example-feature` is the vendored reference plugin, and it is meant to be deleted.
- **Design tokens** — two DaisyUI themes whose brand values live in one header block; a contrast test gates the emitted tokens.

## Layout

```
rocketpod/          workspace root: package.json (scripts delegate via pnpm -r / --filter),
│                     pnpm-workspace.yaml, biome.json, tsconfig.base.json, CLAUDE.md, docs/, .github/
├── apps/web/         @rocketpod/web — Node server (Hono API) + React UI; src/node/, migrations/, scripts/, tests/
├── apps/cli/         @rocketpod/cli — `rocketpod` CLI: login, logout, whoami, status, members/keys/activity list, traces list|show, feedback list, evals promote, config
├── apps/evals/       @rocketpod/evals — developer-run eval suites (vitest-evals): `pnpm eval`, never part of the gate
└── packages/shared/  @rocketpod/shared — PRIVATE zod contracts, error envelope, pagination, permission types;
                      consumed as TypeScript source through the workspace link (no build step)
```

Everything runs from the root: `pnpm bootstrap` (= `bash scripts/bootstrap.sh` once Node and pnpm
exist), `pnpm preflight` (the read-only check),
`pnpm dev`, `pnpm seed` / `pnpm seed --demo`, `pnpm test`, `pnpm cli …`, `pnpm web <script>` (any
`apps/web` script), `pnpm db:*`, `pnpm build` then `node apps/web/dist/server.js all` (the
production server). Root `scripts/` holds the first-run tooling: `bootstrap.sh` / `bootstrap.mjs`,
`install.sh`, `rename.mjs` (`docs/ADAPTING.md` §1 as one command) and their `lib/`.

## Not included (by design)

Billing and subscriptions, Vectorize (vectors live in pgvector under the tenant predicate), OCR of
images (document conversion covers PDF/Office/HTML, not pictures), reranking, prompt versioning,
reporting/export, and any product domain. Each is a documented extension point in `docs/CONCEPTS.md`; the subsystem sections
there list every known gap.

## Documentation

| File | Read it when |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) (`AGENTS.md`) | always — the canonical agent context: stack, commands, map, non-negotiables |
| [`SETUP.md`](SETUP.md) | getting a clone running, the CLI's first login, configuring OAuth/email/AI providers (or a local OpenAI-compatible model)/tracing |
| [`docs/CONCEPTS.md`](docs/CONCEPTS.md) | before assuming a capability exists or building a new one — one section per subsystem with its invariant and known gaps |
| [`docs/ADAPTING.md`](docs/ADAPTING.md) | you just copied the kit to start an app (package names, CLI bin, config dir, env prefix, what to delete, where the first features go) |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | running it in production: the image, Docker Compose, the Helm chart, secrets, external Postgres and S3, scaling |
| [`docs/FORK.md`](docs/FORK.md) | how Rocketpod relates to Rocketflare, and which Rocketflare releases have been ported |
| [`docs/RLS.md`](docs/RLS.md) | tenant isolation posture and how to turn row-level security on |
| `.claude/rules/*.md` | layer conventions (api, database, ui, cli, testing, code-quality, runtime) — auto-loaded by path |
| `.claude/skills/` | the slash commands a coding agent drives: `/rp-setup` (first run), `/rp-preflight` (read-only diagnosis), `/rp-adapt` (rename + checklist), `/rp-how-do-i` (coaching for a new feature — asks, plans, writes `docs/features/<slug>.md`, never the code), `/rp-upgrade` (port later kit releases into your copy), `/rp-plugin` (install, upgrade, remove or audit a plugin), `/rp-traces` (debug a run or chat turn from its span tree; pick or switch a tracing backend), `/rp-evals` (write, run and interpret evals; compare models or prompts; turn thumbs-down into cases) — an agent may run those when you ask in plain words — and `/rp-deploy` (Compose or Helm), which renders and checks locally and asks you before it pushes an image, touches a cluster or creates anything billed |

## Provenance

Forked from Rocketflare 0.19.0 (`docs/FORK.md`), itself extracted from two internal applications:
one contributed the structure, docs system, auth, tenancy and AI layer; the other the platform
substrate and the analytics layer. Rocketpod replaced that substrate's Cloudflare pieces with
Postgres-backed equivalents (`docs/DESIGN-SELFHOSTED.md`). The decisions are recorded, subsystem by
subsystem, in [`docs/CONCEPTS.md`](docs/CONCEPTS.md).

## Contributing

Bug reports, feature requests and pull requests are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md)
(setup, the pre-commit gate, test shapes, PR guidelines), [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
and [`SECURITY.md`](SECURITY.md) for reporting vulnerabilities privately.

## Licence

[MIT](LICENSE).
