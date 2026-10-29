# SETUP — step-by-step walkthrough

Everything needed to take this kit from a fresh copy to a configured, deployed app. Work through
the parts in order; **every step ends with a verification line — do not move on until it passes.**

**This file is instructions, not design.** What the kit does and why is in
[`docs/CONCEPTS.md`](docs/CONCEPTS.md); running it in containers is [`docs/DEPLOY.md`](docs/DEPLOY.md);
code conventions are in `.claude/rules/`. If this is a freshly copied kit, do
[`docs/ADAPTING.md`](docs/ADAPTING.md) §1 (renames) before Part 1.

**Where commands run.** The repo is a pnpm workspace (`apps/web`, `apps/cli`, `packages/shared`).
**Every command below runs from the repository root** unless it says otherwise: the root
`package.json` delegates to the packages (`pnpm dev` → web, `pnpm cli …` → the CLI via `tsx`,
`pnpm web <script>` → any `apps/web` script).

Legend: `[ready]` works out of the box · `[config]` needs your configuration

**Fix missing prerequisites proactively rather than reporting them.** If Node is missing or too
old, install 24 (`nvm install` reads `.nvmrc`, or `fnm use`, or the system package manager). If
pnpm is missing, `corepack enable` (it reads `packageManager` from the root `package.json`). If
Docker is unavailable on macOS, `brew install colima docker && colima start`; on Linux install Docker
Engine and add your user to the `docker` group. Confirm the tool works, then carry on.

---

## Part 1 — First run (local) `[ready]`

> **The short way.** `bash scripts/bootstrap.sh` (or `/rp-setup` in Claude Code; `pnpm bootstrap` once
> Node and pnpm exist) does 1.1–1.7 in one go — ten steps, one `✔ n/10 <name> <what it verified>`
> line each, a `✖` line plus a `fix:` hint on the first failure — and ends with the browser open at
> `http://localhost:3000/login?as=owner@example.test`. macOS or Linux (Windows: WSL2). Re-runnable on
> a half-done machine: it inspects before it acts and never overwrites a value you wrote. Steps:
> `toolchain`, `install`, `secrets`, `database`, `migrate`, `plugins`, `seed`, `ai` (reports which AI
> provider keys `.env` holds; never fails), `cli`, `dev`. Flags: `--no-demo` (plain `pnpm seed`),
> `--no-plugins` (do not install `defaultPlugins`, §1.4b), `--no-dev` (stop after step 8 and print
> what to run next), `--no-open`, `--as <email>`, `--yes`, `--verbose`, `--db-url <url>` (an
> existing Postgres instead of Docker, §1.4); `--check` is `pnpm preflight`.
> **A caller that did part of the work itself** (a coding sandbox): `--no-install` skips step 2 (it
> still checks `tsx` is installed); `ROCKETPOD_BOOTSTRAP_SKIP=<steps>` leaves out any of
> `toolchain,install,secrets,database,migrate,plugins,seed,ai` (each line then reads
> `skipped (ROCKETPOD_BOOTSTRAP_SKIP)`; an unknown name is exit `2`); `ROCKETPOD_ALLOW_ROOT=1` lets it run as root. None is for a
> person's own machine.
> Exit codes: `0` ok · `1` a step failed · `2` usage · `3` prerequisite missing · `4` port/container
> held by another checkout (`node scripts/bootstrap.mjs --help`).
> The numbered steps below are what it runs — for doing it by hand, or for debugging one step.

### 1.1 Toolchain
```bash
node -v            # v24.x — from .nvmrc
corepack enable && pnpm -v   # 10.x — from package.json packageManager
docker info >/dev/null && echo docker-ok
```
Verify: three lines — `v24.*`, `10.*`, `docker-ok`. `pnpm preflight` is the same check as one
read-only command (toolchain, `.env`, Postgres, AI provider keys, `pnpm dev:status`; exit 3
when anything is missing) — `bash scripts/bootstrap.sh` installs Node through an fnm/nvm that is
already present and pnpm through corepack, and never pipes a URL into a shell.

### 1.2 Dependencies
```bash
pnpm install
```
Verify: exits 0; `ls apps/web/node_modules/.bin/tsx` exists. `packages/shared` is linked into both apps as TypeScript source — there is nothing
to build for it. (`ls node_modules/.bin` at the root shows only `biome`, `tsc`, `tsx`: that is
expected.)

### 1.3 Local secrets
```bash
cp apps/web/.env.example apps/web/.env
openssl rand -hex 32   # → OAUTH_ENCRYPTION_KEY in apps/web/.env
```
The only secret `.env` needs is `OAUTH_ENCRYPTION_KEY` (≥ 32 characters); the bootstrap
generates it (`3/10 secrets`), by hand it is the `openssl` line above.
Verify: `grep -c '^[A-Z_]*=.\+' apps/web/.env` is at least 2 (`DATABASE_URL` and
`OAUTH_ENCRYPTION_KEY` are set). Leave every optional key blank for now — each
feature degrades gracefully (Part 2). `.env` is git-ignored; never paste other environments'
credentials into it, not even as comments.

### 1.4 Database
```bash
pnpm dev:db:up        # pgvector/pgvector:pg17, first free port from :5432, + the S3 gateway from :7070 (apps/web/scripts/dev-db.mjs)
pnpm dev:db:status    # every dev database on this machine, and which one is this checkout's
pnpm web db:check     # apps/web/scripts/test-db-connection.ts
pnpm db:migrate       # db-roles --phase=role → migrations → db-roles --phase=grants
```
Verify: `db:up` prints the port it chose; `db:check` prints the server version; `db:migrate` ends
with the applied migration count and no `role "rocketpod_app" does not exist` error.

**Object storage.** `dev:db:up` also starts the S3 gateway beside Postgres (Versity S3 Gateway,
bucket `rocketpod-dev`, first free port from :7070, sticky like the database's) and writes the
`STORAGE_*` lines into `apps/web/.env`. Point `STORAGE_ENDPOINT` at any other S3-compatible store
(AWS S3, Cloudflare R2's S3 endpoint, MinIO) and `dev:db:up` leaves it alone (a `STORAGE_ENDPOINT`
on localhost is treated as its own gateway and rewritten); blank `STORAGE_DRIVER` turns uploads off (503).

**The port is chosen, not fixed.** `dev:db:up` runs `apps/web/scripts/dev-db.mjs`, which gives this
checkout its own compose project, container and port: it keeps the port already in `DATABASE_URL`
whenever that is still free or still this checkout's, and otherwise takes the next free one from
`DEV_DB_PORT_START` (`scripts/lib/bootstrap-lib.mjs`: 5432 in the kit; a renamed app starts inside
its own port block, `scripts/rename.mjs` row (g)), skipping every test database port — this
checkout's and both kits' — and writes it back to `apps/web/.env`. So a SECOND
checkout on the same machine starts its own database instead of failing on a taken port or quietly
attaching to the first one's container — and a re-run never moves a database that is working.
Everything downstream reads that one value: `db:migrate`, `seed` and `drizzle-kit` through dotenv,
and the Node server from `.env` too (`pnpm dev` points it at this checkout's database).
`pnpm dev:db:down` stops this checkout's database and never another's.

**One driver: `postgres`.** postgres.js over TCP, locally and deployed (D35; Rocketflare's `neon`
driver was removed, and `DATABASE_DRIVER=neon` is refused). The bootstrap writes
`DATABASE_DRIVER=postgres` to `.env`. Verify: `pnpm db:check` prints `Connected to …
(postgres driver)`.

`db:migrate` also installs the `pgboss` (jobs, cron) and `openworkflow` (agent runs) schemas — the
server never creates them at boot.

Why three steps: a policy's `TO rocketpod_app` needs the role
before migrations; the `REVOKE`s need the tables after. With `APP_DATABASE_URL` unset the role is
created `NOLOGIN` and RLS stays inert ([`docs/RLS.md`](docs/RLS.md)).

**No Docker: use an existing database.** Where Docker is not available (a coding sandbox with a
hosted branch, a shared dev server), point the bootstrap at the database you already have:
```bash
bash scripts/bootstrap.sh --no-dev --db-url "postgresql://user:pass@db.example.com/app?sslmode=require"
```
It still runs ten steps. `1/10 toolchain` skips the Docker checks, and `3/10 secrets` writes the URL
to `DATABASE_URL` in `apps/web/.env` (reached over TCP, `postgres`). `4/10 database` doesn't start a container; it waits for
`db:check` to answer (`external <host>/<db> · Connected to …`). `7/10 seed` runs with
`SEED_ALLOW_REMOTE=1`, because the seed refuses a non-local host otherwise. The seed always prints
`seeding <host>/<db>`, never the credentials. The database needs the pgvector extension available
(most managed Postgres offers it). Uploads then need `STORAGE_*` pointed at a reachable S3 store. Afterwards `pnpm dev` uses that URL unchanged, `pnpm dev:db:up` reports there is
nothing to start, and `pnpm preflight` skips its Docker checks while `DATABASE_URL` points off this
machine. `--db-url` can't be combined with `--check`. A loopback URL (`localhost`, `127.0.0.1`)
still counts as this checkout's Docker database to `pnpm preflight` and `dev:db:*`. The URL, password
included, lands in your shell history.

### 1.4b Plugins `[ready]`
```bash
pnpm plugin list                  # what is installed (id, version, repo, when)
pnpm plugin check                 # audit them: exit 1 with one line per failure
```
A **plugin** is a git repository copied into this app — never an npm package — that contributes
contracts, schema, routes, jobs, agents, UI and CLI commands through five barrel files
(`docs/CONCEPTS.md` §16), importing the host only through the declared entries
(`docs/plugin-api.md`) and receiving everything else as injected context. `.rocketflare.json`'s `defaultPlugins` lists the ones a fresh clone should
have; the bootstrap's `6/10 plugins` step installs each one that is not already there with
`pnpm plugin add <repo> --apply`, then generates and applies its migration:

> In the kit itself (`app: null` in `.rocketflare.json`) the step records each install in the
> git-ignored `.rocketflare.local.json` sidecar rather than the committed manifest, so a fresh clone
> of the kit never commits a plugin's surface — the installed FILES are not ignored, though, so do not
> `git add -A` them into the kit. In an app (`app` set) the surface goes into `.rocketflare.json`.

```bash
pnpm plugin add <repo|path>[@ref]          # prints the plan and stops
pnpm plugin add <repo|path>[@ref] --apply  # copies, writes the barrel lines, records the surface
pnpm db:generate --name plugin-<id>-<version> && pnpm db:migrate   # the HOST's migration, always
```

**It runs before the seed on purpose**: a plugin can contribute demo data, so installing one after
`pnpm seed` leaves the demo workspace missing exactly the rows it exists to show. `pnpm bootstrap
--no-plugins` skips the step; an id already installed is skipped anyway, so a re-run is safe.

Verify: `pnpm plugin list` shows a line per plugin (the kit ships the vendored `example-feature`),
and `pnpm plugin check` prints `✔ n plugin(s) check out` and exits 0. `defaultPlugins` is `[]` in
the kit today (the analytics plugin's published release still declares Cloudflare bindings), so the
bootstrap step reports `no defaultPlugins declared — nothing to install`.

A plugin ships **no migration**: the host runs `pnpm db:generate`; a cron it registers is scheduled
by the worker, and a var it declares goes into `.env.example`. A plugin declaring Cloudflare
`bindings` is refused. `/rp-plugin` drives all of it and always shows the plan before anything is written.

### 1.5 Seed
```bash
pnpm seed             # idempotent: demo tenant, owner/admin/member users, one API key
pnpm seed --demo      # the same, plus a populated workspace (what the bootstrap runs; or SEED_DEMO=1)
```
`pnpm seed` creates the tenant `Acme` (`acme`), `owner@` / `admin@` / `member@example.test`, a
pending invitation for `invited@example.test`, the global admin `admin@rocketpod.example.com` and one API
key. `--demo` additionally fills that workspace with a logistics company in use (the tenant is
renamed `Acme Logistics` in `multi` mode) — more members, two
sibling tenants, two weeks of activity, conversations, an indexed knowledge base, finished agent
runs (`summarize-text`, `research-topic`), an AI usage ledger and rebuilt fact tables — so every
page has something to show. Every demo row has a fixed id and is inserted `onConflictDoNothing`, so
re-running adds nothing; the chunk vectors are deterministic stand-ins (`embeddingModel:
'seed:deterministic'`), so a seeded passage is found by the lexical half of the hybrid search, not
the dense half. Local database only — it is a `tsx` script over `DATABASE_URL`.
Verify: the output lists the seeded emails and prints the API key **once** (on the first run only;
later runs say it already exists); with `--demo` it ends with a "Workspace `acme` now holds" table.
`pnpm db:studio` shows the rows.

### 1.6 Run it
```bash
pnpm dev              # apps/web: Node server (tsx watch) :3001 + vite :3000 (strict ports; a preflight
                      # clears this repo's leftovers and names any other port holder)
# pnpm dev:stop       # kill this repo's dev tree (parent first, loops until quiet)
# pnpm dev:status     # what is running here + who holds :3000/:3001
```

> **Ports taken?** (a sandbox holds :3000, or another app does.) Set `DEV_UI_PORT` and
> `DEV_API_PORT` — in the shell or in `apps/web/.env` (the shell wins; unset = 3000/3001) —
> and change `APP_URL` in `.env` to the new UI port, because the server builds its OAuth
> redirects, magic links and CORS/CSRF allow-list from it. `DEV_ALLOWED_HOSTS=a.example,b.example`
> lets Vite answer for extra hostnames (a sandbox preview URL). `pnpm dev`, Vite, the bootstrap and
> the seed all read these through `scripts/lib/dev-ports.mjs`; `pnpm dev:api` on its own reads only
> the shell. Substitute your ports for 3000/3001 everywhere below; the CLI's default server stays
> :3001, so pass `--server http://localhost:<DEV_API_PORT>`.

> **AI keys.** Chat, agents and uploads need a provider key in `apps/web/.env`
> (`ANTHROPIC_API_KEY` or `AI_API_KEY`, and `EMBEDDINGS_API_KEY`); without one they answer 503 and
> everything else works (§2.5).

Verify: both processes report ready; `curl -s localhost:3001/api/health` returns `{"status":"ok",…}`;
http://localhost:3000 renders the shell. Sign in: enter the seeded owner email, copy the magic-link
URL from the **`pnpm dev` server log** (no `RESEND_API_KEY` → links are logged, not sent), open it,
press **Sign in** on the confirm page, land on Home. Shortcut (dev only): `http://localhost:3000/login?as=owner@example.test` signs in
through `/auth/dev-login` on load — honoured only when the server reports `devLogin`
(`APP_ENV=development`) and for the four seeded accounts, so an arbitrary address does nothing.

**Analytics** is a plugin (`docs/CONCEPTS.md` §8, §16) and is not installed by default in
Rocketpod: its published release still declares Cloudflare bindings, which `pnpm plugin add`
refuses. Until a container-ready release exists there is no `/api/analytics`, `/cubejs-api` or
`/mcp`, and no dashboards.

> **Cookie note.** The session cookie is `__Host-session`, and the `__Host-` prefix *requires* the
> `Secure` flag even in development. Chrome and Firefox treat `http://localhost` as a secure context so
> this just works; Safari has historically been flaky about it. If Safari won't stay signed in locally,
> use an HTTPS tunnel (§1.10) or another browser.

### 1.7 CLI first run
The bootstrap already did this once: its `9/10 cli` step ran `pnpm cli whoami` with the seed's
one-time key (first run only — a re-run finds the key exists and skips; not with `--no-dev`, which
`/rp-setup` uses — run `pnpm cli login` yourself then). To use the CLI yourself, with `pnpm dev` still
running, in a second terminal:
```bash
pnpm cli login --server http://localhost:3001   # opens the browser; sign in, pick the tenant
pnpm cli whoami
```

> **Headless / no browser** (CI, agents): skip `pnpm cli login`. Sign in with the dev-login cookie
> (or any session) and hit `GET /auth/cli?redirect_uri=http://127.0.0.1:8765/callback` — the
> `Location` header carries `key=`; export it as `ROCKETPOD_API_KEY` with `ROCKETPOD_URL=http://localhost:3001`,
> then `pnpm cli whoami`. In real environments create a tenant API key in Settings → API keys instead.

`login` starts a loopback listener on the first free port in `127.0.0.1:8765–8770` and opens
`/auth/cli?redirect_uri=http://127.0.0.1:<port>/callback`; after login + tenant select the server
mints a tenant API key named `cli:<your hostname>` and redirects back. The key is stored in
`~/.rocketpod/config.json` (mode `0600`) and is never printed in full.
Verify: `whoami` prints your email, the tenant name and a key prefix; `pnpm cli members list --json |
head` prints JSON; `ls -l ~/.rocketpod/config.json` shows `-rw-------`; a wrong key exits `2`. For CI or
scripts, `ROCKETPOD_API_KEY` + `ROCKETPOD_URL` in the environment replace the config file (no browser).

### 1.8 Tests
```bash
pnpm test             # starts Postgres on :5533 (apps/web/docker-compose.test.yml), then every package:
                      # web api + api-isolated + driver (real DB), ui (jsdom), config (no DB); cli
                      # (the S3 gateway on :7433 starts beside it)
# No Docker (a coding sandbox's gate): the same command against a throwaway hosted GATE branch over
# TCP — DATABASE_URL + TEST_DATABASE_BRANCH=gate-<short>-<n> + TEST_DATABASE_ENDPOINT=ep-…
# (docs/CONCEPTS.md §4; the safety check knows Neon's branch shape). It refuses any other remote
# database.
```
Verify: all projects green — including every installed plugin's own tests, which run in the host's
projects (`src/plugins/*/tests/{api,ui,config}`). The analytics plugin's `cube-isolation.test.ts`
is the one to watch, once installed: two tenants, every cube, disjoint rows.
`apps/web/tests/config/platform-seam.test.ts` proves no Cloudflare dependency came back.
Single web projects: `pnpm web test:api`, `pnpm web test:ui`, `pnpm web test:config`.

### 1.9 The gate
```bash
pnpm gate
```
Verify: exits 0. This is the pre-commit gate for the whole workspace — lint, typecheck, test,
build, stopping at the first failure (`--keep-going` runs them all, `pnpm gate --list` shows them)
— and what a copy's CI runs, split into parallel jobs (`pnpm gate lint typecheck build`, `pnpm test
--only packages|api|rest [--shard i/N]`) behind one required `Gate` check. `build` produces `apps/web/dist/ui`, the two server bundles
`apps/web/dist/{server,migrate}.js` and `apps/cli/dist/cli.js`.

### 1.10 Public URL via tunnel

OAuth providers and webhooks need a public HTTPS origin. Any tunnel that forwards to :3000 works
(`cloudflared tunnel --url http://localhost:3000`, `ngrok http 3000`, Tailscale Funnel…): set
`APP_URL` in `apps/web/.env` to the tunnel's origin (redirect URIs, magic links and the CSRF
allow-list derive from it) and `DEV_ALLOWED_HOSTS=<tunnel host>` so Vite answers for it, then
restart `pnpm dev`. Verify: the tunnel URL renders the login page and a magic link sent from it
opens on the tunnel host.

## Part 2 — External services `[config]`

None of these block local development. Each states what happens when it is absent. Every value —
secret or not — is an environment variable: `apps/web/.env` locally; deployed, the root `.env` for
Compose or the chart's `config` (ConfigMap) / `secrets` (Secret, or your `existingSecret`) for Helm
(`docs/DEPLOY.md`). A secret never goes into a committed values file.

### 2.1 Email — Resend
1. resend.com → verify your sending domain (SPF/DKIM)
2. Create an API key → `RESEND_API_KEY`
3. `EMAIL_FROM` in the environment (`apps/web/.env` locally): a verified sender,
   `App <noreply@mail.example.com>`

Absent: magic links, invitations and admin notifications are logged, never sent. Verify: request a
magic link — it arrives by email.

### 2.2 Google OAuth
1. Google Cloud Console → APIs & Services → OAuth consent screen: External; scopes `openid`,
   `email`, `profile` only. While the screen is in *Testing* only listed test users can sign in —
   **Publish** it to let anyone reach the sign-up gate
2. Credentials → OAuth client ID → Web application. Authorized redirect URIs — Google matches
   exactly, add every origin you use:
   `http://localhost:3000/auth/google/callback`, `https://<tunnel-host>/auth/google/callback`,
   `https://<staging-host>/auth/google/callback`, `https://<app-host>/auth/google/callback`
3. `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`

Absent: the button is hidden (`GET /auth/methods`). Verify: "Continue with Google" round-trips.
An account whose `email_verified` is false is refused — for every provider.

### 2.3 Microsoft OAuth (Entra ID)
1. Azure Portal → App registrations → New; account type "any organizational directory and
   personal accounts" (the kit uses the `common` tenant)
2. Redirect URI (Web): `{APP_URL}/auth/microsoft/callback` for each origin as in 2.2
3. Certificates & secrets → new client secret → `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`

Absent: button hidden. Verify: round trip. Redirect URIs are always derived from `APP_URL`; there
is no `*_REDIRECT_URI` variable to set.

### 2.3b Sign in with any OIDC issuer (Keycloak, Okta, Entra single-tenant, Auth0…)
One generic OpenID Connect issuer per deployment, beside or instead of the buttons above
(`docs/CONCEPTS.md` §2).
1. At the issuer, create a **confidential web client** (or a public one — PKCE only, no secret) with
   the authorization-code flow. Redirect URI: `{APP_URL}/auth/oidc/callback` for each origin, as in
   2.2. Post-logout redirect URI (if the issuer asks): `{APP_URL}/login?signedOut=1`
2. Set `OIDC_ISSUER` to the issuer's `issuer` value **exactly** (open
   `<issuer>/.well-known/openid-configuration` and copy it, trailing slash and all — a mismatch is
   refused), `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` unless the client is public. Optional:
   `OIDC_LABEL` (button text, default "Single sign-on"), `OIDC_SCOPES` (default
   `openid email profile`), `AUTH_OIDC_ONLY=true` (the login page shows only the "Continue with <label>"
   button — signing in is still a click, never an automatic redirect — and hides every other method; the magic-link endpoint stays live for invitations — it hides, it does
   not disable), `OIDC_TRUST_EMAIL=true` (see Entra below). Locally these go in `.env`; deployed,
   everything but the secret is plain config and `OIDC_CLIENT_SECRET` is a secret (Part 3)
3. Issuer notes:
   - **Keycloak**: `OIDC_ISSUER=https://<host>/realms/<realm>`; "Client authentication" on for a
     confidential client. A `groups` mapper is optional — the claim is read, not stored
   - **Okta**: `OIDC_ISSUER=https://<org>.okta.com` (org server) or
     `https://<org>.okta.com/oauth2/default`; app type "Web", grant "Authorization Code"
   - **Entra ID, single tenant**: `OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`;
     add the optional `email` claim to the ID token (Token configuration) — without it the kit
     falls back to the userinfo endpoint. Entra sends no `email_verified`, and the kit refuses a
     missing flag by default, so set **`OIDC_TRUST_EMAIL=true`** — only for a single tenant whose
     directory controls the `email` claim. (Multi-tenant Entra is the Microsoft button, 2.3)
   - **Auth0**: `OIDC_ISSUER=https://<tenant>.auth0.com/` — **with** the trailing slash, which is
     how Auth0 spells its issuer; Regular Web Application

Absent (`OIDC_ISSUER` blank): no `oidc` provider, the login page is unchanged. `AUTH_OIDC_ONLY=true`
without issuer and client id refuses to boot (config error). Verify: `/auth/methods` shows
`"oidc": { "label": … }`; "Continue with <label>" round-trips; `Sign out` returns to
`/login?signedOut=1` (through the issuer's logout page when it advertises `end_session_endpoint`).
An account whose `email_verified` is `false` — or missing, unless `OIDC_TRUST_EMAIL=true` — is
refused (`?error=email_unverified`); an existing kit user is linked by verified email.

### 2.4 First admin
`BOOTSTRAP_ADMIN_EMAILS=you@example.com` (comma-separated). Promoted to global admin on the first
**verified** login, logged loudly. Absent: promote by hand once —
`UPDATE users SET is_global_admin = true WHERE email = '…'` — or every sign-up parks on `/pending`
with nobody to approve it (`SIGNUP_MODE=invite_only` default). On an install with no workspace yet,
that first login also creates one, named `APP_NAME`, with the admin as owner — in multi mode too,
so there is someone to invite people into it. Verify: `/admin` is reachable, and the app opens on
that workspace.

### 2.5 AI — chat, agents, embeddings
Resolution (`docs/CONCEPTS.md` §9): a per-agent assignment → the tenant's default provider in
Settings → AI → the platform `ANTHROPIC_API_KEY` → the platform `AI_API_KEY` → 503
`ai_not_configured`. **There is no zero-key default**: with nothing configured, chat, agents and
document indexing answer 503 and everything else works. Pick any of these:

1. **Platform Anthropic key.** `ANTHROPIC_API_KEY=` in `apps/web/.env` (deployed: a secret, Part 3).
   Every tenant without its own chat provider then uses `claude-haiku-5-5`. Verify: Settings → AI
   (as owner/admin) shows chat readiness `Anthropic · claude-haiku-5-5 · platform default`;
   `curl -b <cookie> localhost:3001/api/ai/config/readiness` →
   `"chat":{…,"source":"platform","provider":"anthropic"…}`.
2. **Platform OpenAI-compatible key.** `AI_API_KEY=` with `AI_BASE_URL=` (OpenRouter, vLLM,
   Ollama… including `/v1`) and `AI_MODEL=`; without `AI_BASE_URL` the key is OpenAI's own
   (`AI_MODEL` defaults to `gpt-6-luna`, through the Responses API). It ranks after `ANTHROPIC_API_KEY`. The floor is a
   model that can run the AGENTS, not just the chat box: pick one with real tool calling. Verify:
   readiness reads `"source":"platform","provider":"openai_compatible"` (or `openai`).
3. **Tenant provider (no platform key).** Settings → AI → *Add provider*: scope `chat`, a label (it is
   the upsert key — renaming later means delete + re-add), provider `anthropic` / `anthropic_compatible`
   (Fireworks, Moonshot presets; base URL required) / `openai` / `openai_compatible`, model, API key
   (encrypted with `OAUTH_ENCRYPTION_KEY`, never shown again — the row reports `hasCredential`). The
   first row in a scope becomes the default. Press **Test connection** before saving (a 10-token
   completion; 10 per minute per IP). Verify: the test reports `ok` and a latency; readiness reads
   `tenant`.
4. **Local model — develop with no paid key.** Run any OpenAI-compatible server (Ollama, vLLM, a
   proxy) and point option 2 at it (`AI_BASE_URL=http://localhost:11434/v1`, `AI_MODEL=<model>`,
   **any non-empty `AI_API_KEY`** — the adapter refuses an empty key; a local server ignores the
   bearer), or add it as an `openai_compatible` tenant config. Verify: `/chat` streams a reply.

Absent everywhere: `/chat` shows "configure AI"; `POST /api/chat/conversations` and the agent's
`execute` step answer 503 `ai_not_configured` (the agent enqueue itself still returns 202 and the run
settles `failed`). Thinking is OFF unless a config enables it with a budget (cost decision).

**Embeddings** (documents / hybrid search, `index: true` on the example agent): an
`embeddings`-scope tenant config (`openai`, `openai_compatible`), or `EMBEDDINGS_API_KEY` for
platform OpenAI `text-embedding-3-small` (reduced to 1024 dims) — or, with `EMBEDDINGS_BASE_URL` +
`EMBEDDINGS_MODEL`, any OpenAI-compatible endpoint whose model honours `dimensions: 1024`. Anthropic
has no embeddings API, so an Anthropic-only install still needs one of these to index. Verify:
`POST /api/ai/documents/ingest` `{ "title": "t", "text": "hello world" }` → `status: "indexed"`;
`pnpm web db:check` reports the pgvector extension installed. Changing the dimension is a new table
(`docs/ADAPTING.md` §3).

**Document uploads** (Knowledge → Upload file): Markdown/text/CSV/JSON index straight away; PDF
(`unpdf`), Word `.docx` (`mammoth`), HTML and XML are converted on the server in the
`document.convert` queue job — no external service. Excel and OpenDocument are refused at upload
(415). Uploads need storage (`STORAGE_*`, §1.4) and embeddings. Verify: upload a small PDF on
`/documents`, watch the row go `Indexing → Indexed` within the 5 s poll (the `pnpm dev` log shows
`document.convert` finishing), search a phrase from it, and click the download icon to get the
original back from the S3 store.

**Decisions** (`ctx.decide`, D37 — typed questions agents ask, e.g. the `triage-research` example's
relevance screen): with nothing configured the chat model answers them with its own probabilities,
recorded `llm_self_report` and shown as *self-reported* (uncalibrated). For calibrated answers from
TypeSafe's Jev, either set `TYPESAFE_API_KEY=` in `apps/web/.env` (deployed: a secret, Part 3) or add
one per tenant in Settings → AI → *Add decision provider* (provider TypeSafe, model `jev-latest`,
the key; **Test connection** asks one yes/no question). Verify: `curl -b <cookie>
localhost:3001/api/ai/config/readiness` → `"decisions":{"ready":true,"source":"platform","provider":"typesafe"…}`
(`"source":"fallback"` without a key), and a `triage-research` run's timeline shows *Decided* rows
badged `Jev`.

Agent runs run on OpenWorkflow in the worker (`pnpm dev` runs mode `all`, so the worker is
in-process). Verify (from the Agents page in the nav, or by hand):
`POST /api/agents/runs` `{ "agentKey": "summarize-text", "input": { "text": "<a paragraph>" } }` →
202; `GET /api/agents/runs/<id>` reaches `succeeded` with `output.summary`.

**Human-in-the-loop walkthrough** (`docs/CONCEPTS.md` §9). A run can stop and ask a person — the
park is OpenWorkflow's `waitForSignal` behind the kit's `step.waitForEvent`. Nothing extra to
configure; `AGENT_INTERRUPT_TIMEOUT` defaults to `168 hours`. With `pnpm dev` running and signed in at
`/login?as=owner@example.test`:

1. **Agents → Summarise text**, paste a paragraph, turn *index the result* ON, run it. Watch the
   timeline fill **live** (token-by-token it is not — the stream carries durable rows — but it
   arrives in well under a second, not in 3-second lumps), then stop on *"Add this summary to the
   knowledge base?"*. The Agents nav item shows a badge of 1, and the notification bell deep-links
   to the run.
   Verify: `GET /api/agents/runs/<id>` reports `status: "awaiting_input"` with one pending interrupt.
2. **Answer it from a second browser** signed in as `admin@example.test`, then answer the same one
   in the first. One gets a 200, the other a 409 `interrupt_not_pending` rendered as *"somebody else
   answered"* — not an error toast. The run resumes on its own.
   Verify: the run reaches `succeeded` and the document appears in `/documents` **exactly once**
   (the write is behind `ctx.once`; a second copy means that broke).
3. **Restart `pnpm dev` while a run is parked**, then answer it. The run resumes across the
   restart — its state is in the `openworkflow` schema, not in the process. This is the durability
   claim; if anything is going to be wrong, it is this.
4. **Cancel a parked run.** It settles `cancelled` with `error` NULL and its interrupts `expired` —
   a refusal is a status, not a fault.
5. **Ask `research-topic` something ambiguous.** It calls `ask_human` and raises a `choice` from
   inside a tool handler; answer it, then type a **steering note** into the still-running run and
   watch it appear in the timeline and change the answer. Ask it to *save* what it finds and it
   calls `index_finding`, which is gated by `Tool.requiresApproval` — approve it (editing the text
   first, which `allowEdits` permits) and the note lands in the knowledge base.
6. **Reload a settled run**: identical to the streamed version.
   `curl -N -H 'Accept: text/event-stream' "http://localhost:3001/api/agents/runs/<id>/agui/stream"`
   shows `data:`-only frames with `id:` on group boundaries only.

### 2.6 Tracing (D32)
Nothing to set up: every chat turn, agent run, tool call, retrieval and embeddings batch is
recorded as spans in the local `ai_spans` table, with zero credentials. Verify: send a chat message
or run the example agent, then (as an owner/admin, logged in with `pnpm cli login`):
```bash
pnpm cli traces list                  # newest first; --agent chat · --status error · --run <id>
pnpm cli traces show <traceId|runId>  # the span tree: model, tokens, latency, tool args/results
```
A chat turn shows `invoke_agent chat` with `chat <model>` and `execute_tool <name>` children, and
retrieval/embeddings under the tool. `OBSERVABILITY_CAPTURE_CONTENT=false` drops prompts and tool
I/O. Optional backend (Langfuse keys keep working with no new setting; Phoenix locally is
`docker run -p 6006:6006 arizephoenix/phoenix` + `OBSERVABILITY_PRESET=phoenix` +
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006` in `.env`): `docs/DEPLOY.md` § Tracing.

### 2.6b Evals (D33)
Optional, and it costs tokens: put `ANTHROPIC_API_KEY` in `apps/web/.env`, then
```bash
pnpm test:db:up     # evals run against the TEST database and migrate it themselves
pnpm eval           # three starter suites: knowledge chat, summarize-text, research-topic
pnpm eval:view      # the score diff against the previous run, then the report UI
```
Without a key every suite skips and says why. Thumbs on chat replies and run output are live with
no setup; `pnpm cli feedback list --rating down` then `pnpm cli evals promote <id> --dataset <name>`
turns a bad answer into a case. Everything else — suites, judges, baselines, CI — is in
`docs/EVALS.md`.

### 2.7 Plugins `[ready]` (D31)

```bash
pnpm plugin list                                   # what is installed, and from where
pnpm plugin check                                  # anchors, kit range, barrel lines, migrations
pnpm plugin add <repo|path>[@ref]                  # read the plan; --apply installs it
pnpm plugin remove <id> --apply                    # then pnpm db:generate && pnpm db:migrate
```

**Every command prints its plan and stops until `--apply`.** Installing a plugin gives it full
server and database access — it is as trusting as merging a pull request — and the plan is what you
say yes to. It never generates a migration: that arrives as a numbered step you run yourself, as do
any env keys it declares (add them to `.env`, and to the chart's `config`/`secrets` when deployed).
A plugin that declares Cloudflare `bindings` or Worker exports is refused (`cloudflare-only`).
`defaultPlugins` is empty in Rocketpod today (`docs/CONCEPTS.md` §8).

Writing one of your own: `/rp-plugin`, or `apps/web/src/plugins/CLAUDE.md` and
`apps/web/src/plugins/example-feature/` — the vendored reference plugin, which exists to be read
and then deleted.

### 2.8 Feature flags `[ready]` (D30)

Nothing to configure — flags work out of the box, and the kit itself ships none: the one inert demo
flag (`example-feature`, a nav item, a page and a notes API) belongs to the reference PLUGIN of the
same name (D31, `apps/web/src/plugins/example-feature/`), which is installed by default and safe to
delete. As a global admin, open **Admin → Feature flags**: set it to On and the nav item appears; to
Rollout and the percentage decides deterministically; force it on or off for one organisation and
that beats the percentage either way.

Two things worth knowing before you add your own:

- **`FEATURES_ENABLED` is the release gate**, read per deployment from the environment
  (`apps/web/.env` locally, the chart's `config` when deployed). A flag you mark
  `environmentGated` is dark everywhere its key is not listed — your laptop included — which is why
  `.env.example` carries the key.
- **A flag is not a permission.** Gate with `requireFeature` / `{ feature: 'x' }`, never with
  `access Feature:x` — a global admin's `manage all` satisfies the CASL form and would show them a
  surface the deployment does not ship. `docs/CONCEPTS.md` §15 has the incident this rule came from.

Verify: `pnpm cli features list --json` prints the effective flags for your tenant; flipping one in
`/admin` changes it on the next call.

### 2.9 Rebrand checklist
See [`docs/ADAPTING.md`](docs/ADAPTING.md) §1 — package names (`@rocketpod/*`), image and chart names,
DB names, CLI bin / config dir / env prefix, themes, logo, `EMAIL_FROM`.

---

## Part 3 — Deploy

One image, run as `web`, `worker` (or `all`) plus a one-shot `migrate`, configured entirely by
environment variables. **[`docs/DEPLOY.md`](docs/DEPLOY.md) is the runbook** — Compose quickstart,
Helm install, the secrets checklist, external Postgres and S3 requirements, scaling. `/rp-deploy`
walks it with you and stops before anything that pushes an image, touches a cluster or creates a
billed resource.
