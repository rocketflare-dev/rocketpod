# Fork point

Rocketpod is a hard fork of [Rocketflare](https://github.com/rocketflare-dev/rocketflare), taken so
the kit can run with no Cloudflare dependency: Node 24 in a container (Docker Compose or Kubernetes),
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
