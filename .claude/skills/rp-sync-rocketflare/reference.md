# rp-sync-rocketflare — reference

The detail behind `SKILL.md`. Add a row to these tables whenever a port finds a new mapping, in
the same commit, so the next port starts from it.

## Translations (Rocketflare → Rocketpod)

| Rocketflare | Rocketpod |
|---|---|
| A Worker binding read off `env` (`env.AI`, `env.JOBS`, `env.FILES`, `env.AGENT_RUN_WORKFLOW`…) | A `Platform` member read through `c.get('platform')` / `ctx.platform` (`src/platform/types.ts`); never a binding off an env |
| Both wrangler tomls (vars, crons, `run_worker_first`, `[ai]`, `[version_metadata]`, `invocation_logs`) | `src/config.ts` + `.env.example` + Helm `values.yaml` (+ compose); routes need no `run_worker_first`, the Node server receives every path |
| A cron in the toml | A `SCHEDULED_TASKS` entry in `src/api/scheduled.ts`; pg-boss schedules exactly what it registers |
| Queues: a queue message, `delaySeconds`, the DLQ toml | pg-boss jobs through `platform.jobs`; delay = `startAfter` (≤ 12 h through `enqueueJob`); pg-boss's own dead-letter queue |
| Workflows: `AgentRunWorkflow`, instance states, `isMissingInstanceError` | `platform.runs` over OpenWorkflow (`src/node/runs.ts`); states mapped in `mapRunStatus`; a missing run is the typed `RunInstanceNotFoundError`, matched by type or `code`, never by message |
| Workflows `concurrency.limit` | Nothing to port (`RUNS_CONCURRENCY` is per worker) |
| `CF_VERSION_METADATA` | `APP_VERSION_ID` (Helm: image tag, else chart version) |
| Workers AI: chat, embeddings, reranker, `AI.toMarkdown` | Chat: `ANTHROPIC_API_KEY` / `AI_*`; embeddings: `EMBEDDINGS_*` (`resolvePlatformEmbeddings`); reranker: the HTTP path only, a tenant `rerank` config, no platform tier; conversion: `platform.converter` |
| KV-backed limits and windows | `platform.rateLimiter` / `platform.locks` (Postgres) |
| The realtime Durable Object (`closeUser`, `closeSession`…) | `ws` + LISTEN/NOTIFY; `Broadcaster.closeSockets({ tenantId, userId?, sessionId? })` |
| R2 | `platform.storage` (S3); ranged reads and multipart work as they are |
| Neon serverless driver, Hyperdrive | postgres.js, the one driver (`src/db/client.ts`) |
| `pg_trgm` and other extensions | In the migration (`CREATE EXTENSION IF NOT EXISTS`); DEPLOY.md says a managed database must allow it |
| Platform logs that record request URLs | The same lesson for the Helm ingress and any reverse proxy: say so in DEPLOY.md |
| The Hono body-limit middleware | The same middleware; `@hono/node-server` sets no limit of its own |
| Inbound email (`emailHandlers`, `EmailCtx`) | Not ported: no Email Routing equivalent |
| `publicSites.cache`, the Images binding, the GLM parser | Not ported (no Cache API in Node, no bindings, no Workers AI) |
| Provisioning (`provision.ts`, zone routes, Neon region, R2 retries), `wrangler types`, `global-scope.test.ts`, the offline `[ai]` switch | Not ported: Cloudflare-only tooling |
| `rf-*` skills, `@rocketflare/*`, `ROCKETFLARE_*`, `rocketflare.dev` | `rp-*`, `@rocketpod/*`, `ROCKETPOD_*`; keep `.rocketflare.json` and `rocketflare-plugin.json`, the ecosystem's fixed filenames |
| An MCP request's credential (0.41.0) | Upstream's own OAuth server, plus the outside issuer (`MCP_AUTHORIZATION_SERVER`, `api/auth/mcp.ts`): its JWT → `outsideMcpGrant` → the same `callerForGrant` as an `mcpat_` token; a change to upstream's caller lands in `callerForGrant`, never in a second pipeline |
| The Worker's egress as the CIMD fetch's private-address guard | `Platform.publicFetch` (`src/node/egress.ts`, connect-time `lookup` guard); a new fetch to a URL somebody else chose goes through it |
| `Cloudflare.Env` passed to a service | `Platform` (`env: c.get('platform')`) |
| The CF type name `Fetcher` | `PublicFetch` (or a local name): `platform-seam.test.ts` bans `Fetcher` |
| `cf-connecting-ip` in a test helper | `x-forwarded-for` (`client-ip.ts` reads its first entry for a bare `app.request`) |
| A test overriding `kv.get` to make a limiter fail | `mcpTestEnv({ rateLimiter: { check } })` — replace the platform member |
| A new settings tab | Add its rail `group` (`tabs.ts`) |
| `pnpm dev:tunnel`, `cfld`, `.dev.vars`, "ChatGPT cannot reach `wrangler dev`" | Any tunnel to :3000 with `APP_URL` + `DEV_ALLOWED_HOSTS` in `apps/web/.env` (`SETUP.md` §1.10); the ChatGPT note does not apply |
| Two migrations in one release | Generated together as one when both schema files land at once (as 0.39.0's did) |

## Test harness mappings

| Rocketflare test | Rocketpod test |
|---|---|
| `fixture-agents.ts` | `tests/helpers/test-agents{,-shared}.ts` (`TEST_SUMMARIZE`, `TEST_RESEARCH`, `withTestAgents`, `testAgentsServerBarrel`) |
| `AgentRunWorkflow` + `createFakeWorkflowStep` | `runAgentRun` + `createFakeStep` (`tests/mocks/step.ts`); keep the fake's refusal of a detached `step.do` |
| `agentRunStarter(env)` | needs `platform: resolvePlatform(env)` |
| The `AI` binding stub | `stubs(env).ai.respond` on the fake OpenAI-compatible endpoint; `scriptPlatformChat(env, turns)` for chat |
| A `workers_ai` provider case | Dropped or rewritten with a keyed provider: every Rocketpod provider needs a key |
| A KV store assertion | the recorded platform member (`stubs(env).kv`, `.queue`, `.files`, `.hub`, `.workflow`) |
| The queue name `rocketflare-jobs` | `rocketpod-jobs` |
| Driving the Durable Object | Booting the Node server (`startServer`) and real sockets |

## Rocketpod differences to keep

- `ToastType` is `'error' | 'warning'`: no success toast, and no test of toasts.
- The settings rail is vertical; `tabs.ts` carries each tab's `group`.
- `retrieval.ts` keeps the `documents` corpus option and the stored `search_vector`.
- The upload types are the converter's (no Excel or OpenDocument).
- `/mcp` also accepts tokens from an outside OAuth server (`MCP_AUTHORIZATION_SERVER`).
- Only these are deleted by the rename: `.claude/skills/rp-sync-rocketflare/`, `docs/FORK.md`,
  `docs/upgrades/unreleased.md` and the other `kitOnly` paths.

## Subagent brief

One per release group, sequential. Fill in the angle brackets:

> You are porting Rocketflare **<versions>** into Rocketpod on branch `<branch>` (latest commit
> `<sha>`; already ported: <list>). Follow `.claude/skills/rp-sync-rocketflare/SKILL.md` step 3 and
> `reference.md`.
> - Node 26: prefix pnpm with `export PATH=$HOME/.nvm/versions/node/v26.<x>/bin:$PATH;`.
> - Read `$RF/docs/upgrades/<v>.md` in full, then the code with
>   `git -C $RF diff <prev>..<v> -- <path>`.
> - Port by hand. Schema → `pnpm db:generate` (descriptive name). Port every test. Keep config in
>   agreement. Update docs, the `unreleased.md` section and the FORK.md rows, and fix Guide
>   staleness.
> - Decisions already taken: <list>. New mappings since the last brief: <list>.
> - Skip: <Cloudflare-only parts>.
> - `pnpm gate` must print `✔ pnpm gate passed`. Run nothing else against the test database while
>   it runs. On a lone timeout, rerun that file alone, then the gate. Commit, don't push.
> - Report briefly: commits, translated, skipped, unsure, gate result.

## Verifying on the Node stack

For a release that changes runs, jobs, cron or auth flows. Use one subagent and leave the tree
clean afterwards:

- Build (`pnpm build`) and run `node apps/web/dist/server.js web` and `… worker` as **separate
  processes**, so the worker can be killed mid-run. Give them their own Postgres and S3 containers
  on unused ports (`pnpm dev:db:status` shows the taken ones), then migrate and seed a dummy tenant.
- Point `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` at a small OpenAI-compatible fake under `/tmp`
  (scripted tool calls, a slow mode, `/embeddings` if needed). No real keys, no spend. Count
  `ai_usage` rows to prove a turn is not billed twice.
- For throwaway agents, temporarily edit the vendored `example-feature` plugin, then revert it.
- Fire a cron by putting an occurrence on pg-boss's queue, or call the scheduled task directly.
  Backdate rows to get past a staleness filter instead of waiting for it.
- Record pass or fail per scenario with its evidence (row states, counts, logs). Tear down what you
  started. Rebuild `dist/` afterwards: it last held the throwaway agents.

The 0.40.0 scenarios: worker killed mid-tool (resume from the journal, no double billing, a
finished read tool not re-run, a `sideEffects` tool settling as unknown outcome); cancel during a
model call; the lost-run sweeper (and the not-found path); an ask deadline (reminder,
reject/expire, never approve); a child-run cancel cascade and its visibility; a version change
(`continue`/`fail`/`rerun`); suspension with jobs queued.

## The release note

`docs/upgrades/0.32.2.md` and `0.40.0.md` are the models: four headings, `manual: true`,
`touches_surfaces` naming the surfaces changed.

- **What changed.** Paragraph 1 is one sentence of ≤ 40 words: "Rocketpod catches up with
  Rocketflare X.Y.Z: …". It is lifted verbatim into `CHANGELOG.md`. The first bullet points to
  `docs/FORK.md` and to `git show <merge sha>:docs/upgrades/unreleased.md`. Breaking changes come
  next, flagged **Breaking**. After that, one bullet per area, each a line.
- **How to apply.** Numbered steps for a copy, each self-contained:
  - `pnpm install`;
  - the schema, `db:generate` and `db:migrate`, with any hand edit to the SQL;
  - new config keys and their defaults;
  - every caller a breaking change makes a copy update;
  - a last step pointing at the FORK.md rows and the detailed text.
- **Conflicts to expect.** `path → what changed → what to do` for the files a copy most likely
  edited.
- **Verify.** The gate, a `\d` of the new tables, the security tests, a command for the new
  tooling.
