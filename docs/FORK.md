# Fork point

Rocketpod is a hard fork of [Rocketflare](https://github.com/rocketflare-dev/rocketflare), taken so
the kit can run with no Cloudflare dependency: Node 26 in a container (Docker Compose or Kubernetes),
Postgres + pgvector for everything stateful, and S3-compatible object storage for files.

| | |
|---|---|
| Forked from | `rocketflare-dev/rocketflare` `main` |
| Rocketflare version | 0.19.0 |
| Rocketflare commit | `46706df95c20c9f8ee90217ef60bf4f162e012bd` |
| Date | 2026-10-12 |

**Relationship.** Concept parity, not code parity: tenancy, auth, CASL, contracts first, jobs,
durable agent runs, realtime, knowledge, tracing, evals, plugins and the CLI mean the same thing in
both kits. Rocketflare releases are **ported by hand**: read Rocketflare's
`docs/upgrades/<version>.md` for each release after 0.19.0 and apply what still holds without
Cloudflare. Record each one in the table below so the next port knows its baseline.

**Rocketpod is itself a kit.** Copies of Rocketpod upgrade from Rocketpod releases through
`pnpm kit:upgrade` and `/rp-upgrade`, exactly as Rocketflare copies do. `.rocketflare.json` and
`rocketflare-plugin.json` keep their names on purpose: they are the plugin ecosystem's fixed
filenames, so a plugin that uses only the neutral plugin context installs in either kit.

The design is in [`DESIGN-SELFHOSTED.md`](DESIGN-SELFHOSTED.md); the milestones are in
[`ROADMAP.md`](ROADMAP.md).

## Rocketflare releases ported

| Rocketflare | Ported in Rocketpod | Notes |
|---|---|---|
| 0.19.0 | 0.1.0 (fork point) | — |
| 0.20.0 | unreleased | Current models (per-model request rules, `openai` on the Responses API); the Workers AI parts do not apply |
| 0.21.0 | unreleased | Agents at volume: active-run cap and daily spend gates, `POST /runs/batch` (one `platform.runs.create()` per row — OpenWorkflow has no `createBatch`), `ctx.scope`/`ctx.map`, per-call `ai_usage` metering and budgets, tool-loop policies and `authorizeTool`, replay (`pnpm web agent:replay`, `rp-agent-replay`; live mode uses the `.env` keys, no Workers AI borrowing), plugin `AgentCtx.interrupt`/`chatModel`, CLI `agents list\|run\|runs list`. `concurrency_key` was already ported. Not ported: the `wrangler` toml vars (they are `.env.example` + Helm `config`) |
| 0.22.0 | unreleased | Concurrent tool calls in `runToolLoop` (`policy.maxConcurrentToolCalls`, default 4) and `storage()` on `JobCtx`/`CronCtx`/`PublicCtx` over `platform.storage` (`plugins/api/storage.ts`). Not ported: inbound email (`emailHandlers`, `api/email.ts`, the Worker `email` export, `EmailCtx`) — it rides Cloudflare Email Routing, which Rocketpod has no equivalent of; recorded in CONCEPTS §16 known gaps |
| 0.23.0 | unreleased | `ctx.startAgentRun` with `idempotencyKey` on `JobCtx`/`CronCtx`/`PublicCtx` (`enqueueRun` over `platform`), `idempotentRunId` (no "already exists" handling — OpenWorkflow's `create` is idempotent on the run id), `storage()` on `AgentCtx`/`ToolCtx`, `stripControlChars` in ingest and the span store, `composeNav` folding, testkit `Fake{Job,Cron}Ctx` with `startedRuns`. Not ported: `EmailCtx`'s `startAgentRun` and `makeEmailCtx` (no inbound email, see 0.22.0); decision row 24 is a placeholder for it |
| 0.24.0 | 0.2.0 | Already in Rocketpod: its own "A renamed copy carries no kit machinery" (`cd68de8`) was the same change, made alongside upstream — the extra `kitOnly` entries (plus `docs/FORK.md` and `docs/ROADMAP.md`), the rename dropping `kit:release` and the nudge hook and writing the app's `SECURITY.md`, kit-only tests in `tests/kit-only/`, `kit-manifest`'s "called by nothing in this copy", `ToolCtx.features()`, the example agents removable (Rocketpod's `tests/helpers/test-agents.ts` is `fixture-agents.ts`), `agent-loop.ts`, comments without decision numbers, the self-contained ancestry case. Not ported: `gate-string.test.ts` (Rocketpod dropped it as a docs grep, `8d11044`) |
| 0.25.0 | unreleased | Every dependency current: Node 26 (`.nvmrc`, `engines`, `@types/node`, the esbuild target, and both `Dockerfile` stages — Node 26 has no corepack, so the image installs the `packageManager` pnpm with npm), React 19 + React Router 7 (`react-router-dom` kept for plugins, `defaultClientConditions` on the `ui` project), vitest 5 (evals stays on 4), Vite 8, postgres.js 4, CASL 7 without `@casl/react`, Anthropic SDK 1.x (no `temperature` for `anthropic`, Bearer auth), AG-UI 1.0.3, jsdom 30, jest-dom 7, chalk 6, esbuild 0.28, Biome 2.6, the CLI callback's `Connection: close`, `MagicLinkSentCard` moved; plus pg-boss 12.38.1, OpenWorkflow 0.11.0, ws 8.22.2, AWS SDK 3.1164.0, unpdf 2.1.0. CI hardening on Rocketpod's own workflows (SHA pins incl. Docker/Helm actions, `persist-credentials: false`, timeouts, least privilege, gitleaks SHA-256, no gha cache in `publish`). zod 4 was already ported (`c138d03`). Not ported: `worker-configuration.d.ts`, `cloudflare:sockets`, `provision.ts`, the deploy workflow's steps, the analytics 3.8.1 bump (no analytics plugin installed). Held back: TypeScript 7, React Router 8, jsdom 31, vitest 5 / vitest-evals 0.18 in `apps/evals`, AG-UI 1.0.4 (a later release), `arctic` (deprecated, no successor taken upstream) |
| 0.26.0 | unreleased | Already Rocketpod's own: IdP-managed tenancy (`OIDC_MANAGED_TENANCY`, the claims reconcile, identity events, capped sessions, `idp_managed`, adopt-by-slug, admin org linking and deletion, the Cognito `logout_uri` and `no_access` fixes) — Rocketflare's `ab99658` ported it FROM Rocketpod and matches it line for line, migrations included (`0006_idp-managed-tenancy`). Ported: the plugin identity seam (`identityFor().signIn`, `provisionFor()` with `deprovision` and `listMembers`, `linkByEmail`/`account_exists`, `ProviderKey`/`linkPluginIdentity`), single-tenancy deprovision blocks (`users.blocked_source`, migration `0008_idp-blocked-source`), `ServerPlugin.loginMethods` + `GET /auth/methods` `pluginMethods` + their login-page copy, `ServerPlugin.ssoPolicy` on every sign-in path, the public-mount guards (the rate limit over `platform.rateLimiter`, not KV; `bodyLimitBytes` ≤ 10 MB), example-feature's dev-only SSO, the stricter base64 in the Standard Webhooks verifier, the scheduled tests' append tolerance, the note-length warning and the commercial plugins repo in `notify-plugins.yml`. `identityFor` reads `c.get('platform') ?? resolvePlatform(c.env)` and passes `platform.jobs` to `admitUser`. Vite already watched `src/plugins` |
| 0.27.0 | unreleased | `rp-agent-docs` (`SKILL.md` + `check.mjs`, rf→rp names, `@rocketpod/web`, `build:server`), `tests/ui/contrast.test.ts` (Rocketpod's theme had the same two failing tokens; both changed), `pluginIdProblem` refusing `api`, the `example-orders.md` marker, the Vite `coreEdits` comments, the `visibilityResources()` comment fixes. The doc split was redone on Rocketpod's own text: `rules/api.md` 56 KB → 11 KB and `ui/CLAUDE.md` 42 KB → 9 KB into nested files (plus a Rocketpod-only `ui/pages/guide/CLAUDE.md`), `plugins/CLAUDE.md` owning the plugin rules with detail in `rp-plugin/reference.md`; stale claims found on the way were corrected against the code. Not ported: the `cloudflare.md` edit (`runtime.md` already said `pnpm web`), `rf-provision` |
