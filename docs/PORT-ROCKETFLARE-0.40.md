# Porting Rocketflare 0.33.0–0.40.0 into Rocketpod

A working plan, not a porting note. When the port ships, its result goes into `docs/FORK.md` (one
row per Rocketflare release) and one Rocketpod note in `docs/upgrades/unreleased.md`, and this file
can be deleted.

## Where things stand

- **Rocketpod** is at **0.32.2**, which is Rocketflare 0.32.2 ported (`docs/FORK.md`). By the
  versioning rule, the port ships as **Rocketpod 0.40.0**.
- **Rocketflare** is at **0.40.0** (2026-11-19). Nine releases to port: 0.33.0, 0.34.0, 0.35.0,
  0.36.0, 0.36.1, 0.37.0, 0.38.0, 0.39.0, 0.40.0.
- Each release's porting note is in the Rocketflare checkout:
  `~/work/rocketflare/docs/upgrades/<version>.md`. Read its "What changed", "How to apply" and
  "Conflicts" before porting it. The code diff for one path is
  `git -C ~/work/rocketflare diff 0.32.2..0.40.0 -- <path>`.
- This checkout is on `mcp-resource-server` (the `/mcp` server work, b79ada8 and 4bd04f3). Start
  the port on a new branch from `main` (`port/rocketflare-0.40.0`), and keep MCP out of it: the
  MCP client and server are being designed separately as one shared `/mcp` (Rocketflare #150 and
  the durable-runtime review's item 6).

## What the port brings

| Area | Rocketflare releases | Size |
|---|---|---|
| Security fixes, round 3 (run 3) | 0.34.0 | M |
| Small agent and tenancy changes | 0.33.0 | S |
| Knowledge base: structured chunks, re-embedding, dedupe, reranking, knowledge facts | 0.37.0 | L |
| Knowledge: search page, facts view, decision-model judgements | 0.38.0 | M |
| **Durable agent runtime**: journal, resume, cancel, sweeper, versions, HITL upgrades, child runs, inspector, agents pages | 0.39.0 | L |
| Security fixes, round 4 (run 4), and counts-only security reports | 0.40.0 | M |
| Security-audit skill and sandbox | 0.35.0 | M, optional |
| Upgrade and plugin tooling fixes, CLI path fixes | 0.36.0, 0.36.1 | S |

## Order

Port in release order. Later releases patch earlier ones: 0.39.0's timeline renders entity cards
that 0.38.0's tools return, and 0.40.0 changes 0.37.0's chunker, 0.38.0's knowledge reads and
0.39.0's jobs consumer. A gate run (`pnpm gate`) after each release keeps a failure attributable.

1. 0.33.0, then 0.34.0 (security round 3).
2. 0.37.0, then 0.38.0 (knowledge).
3. 0.39.0 (durable runtime).
4. 0.40.0 (security round 4 and counts-only reports).
5. 0.36.0 and 0.36.1 (the parts that apply), then 0.35.0 if the audit skill is wanted now.

## The seam is already shared

Rocketflare 0.39.0 took Rocketpod's run-engine seam upstream, so the hard part of the durable
runtime is already aligned:

- `apps/web/src/platform/types.ts` `Step` (`do`, `waitForEvent` with `arrived`, `isControlFlow`),
  `RunInstance` (`status`, `terminate`, `sendEvent`) and `RunEngine` are the same in both kits.
- `apps/web/src/api/workflows/agent-run-body.ts` (`runAgentRun`) exists in both.
- Rocketflare's `AgentRunWorkflow` is only the Cloudflare adapter; Rocketpod's adapter is
  `apps/web/src/node/runs.ts` over OpenWorkflow.

So most of 0.39.0 is new service files that port as they are, plus a short list of translations.

## Translations (Cloudflare → Rocketpod)

| Rocketflare | Rocketpod |
|---|---|
| `[version_metadata]` binding `CF_VERSION_METADATA`, read in `services/agents/versions.ts` and `registry.ts` to fill `agent_runs.worker_version_id` | An env var naming the deployed build (suggest `APP_VERSION_ID`), set by Helm from the image tag or digest and by `docker-compose.yml`; read through `config.ts`. Keep the column name so the schema matches upstream. Missing = null, as upstream |
| Crons `*/10 * * * *` (`sweepLostRuns`, reminders) and the `0 4 * * *` addition (`pruneAgentTurns`) in both tomls | `SCHEDULED_TASKS` in `src/api/scheduled.ts`; pg-boss schedules them already (`node/jobs.ts`) |
| Workflows instance states in `reconcileRun`, `sweepLostRuns` and `isMissingInstanceError` | Map OpenWorkflow's run states and its not-found error. Match the error by code or type, not by a message containing "not found" (a known weak spot upstream) |
| `nudgeOrRestartInstance` / resume events | OpenWorkflow drops a signal nobody is waiting on, which `WaitForEventOptions.arrived` already covers; check the resume path calls it |
| Cancel reaching the call in flight (3 s poll, `ctx.signal`) | Portable as is. Check that an aborted OpenWorkflow attempt settles `cancelled`, not as a retryable failure, and that `terminate()` backs the forced cancel |
| The test fake that refuses detached `step.do` (the Workflows RPC stub lesson) | Keep the fake's rule even though OpenWorkflow's step is a plain object, so agent code stays portable both ways |
| Workflows `concurrency.limit` (evaluated, not set) | Nothing to port |
| Reranker over Workers AI (`env.AI.run`, `services/ai/rerank.ts`) | Port the HTTP reranker path only (the tenant's base URL, the `rerank` scope); no binding path. The spend metering and the keep-key rule on a URL change port as they are |
| Default platform embedder through Workers AI (re-embed, replay's `workerHasAi`) | The `EMBEDDINGS_*` key, as 0.31.0 already translated (`resolvePlatformEmbeddings`) |
| `AI.toMarkdown` in document conversion | `platform.converter` (already there) |
| Queues: `knowledge.extract`, `document.reembed`, the extract job's next-UTC-day re-enqueue after a cap pause, the jobs DLQ | pg-boss jobs; the re-enqueue uses pg-boss's delayed start; the DLQ is a pg-boss dead-letter queue |
| `pg_trgm` extension (0.37.0 migration) | The Postgres image has it (contrib). A managed database must allow `CREATE EXTENSION pg_trgm` for the migration role; say so in `docs/DEPLOY.md` |
| `invocation_logs = true` and the 0.40.0 DEPLOY note that platform logs record each request's URL | No toml. The same lesson applies to the ingress and any reverse proxy: their access logs record `GET /auth/magic-link/verify?token=…` and `GET /api/invite/<token>` URLs. Check what the Helm ingress logs and add the same sentence to Rocketpod's `docs/DEPLOY.md` |
| Sign-in mail window per canonical mailbox (0.34.0) on KV | `platform.rateLimiter` (Postgres), as 0.29.0 already translated |
| Upload-path body cap (0.34.0) in the Hono middleware | Same middleware; also check the Node server applies no separate, looser limit before Hono |
| Tests stubbing the `AI` binding | `stubs(env).ai.respond` on the fake OpenAI-compatible endpoint, as in 0.31.0 |

## Per release

### 0.33.0: requester URLs and "Create organisation"

Port as is:
- `GET /auth/session` `canCreateTenant`, `tenantCreationRefusal`, and the UI hiding "Create organisation".
- `ToolCtx.requesterUrls`, `agent_runs.input_from_requester`, and `inputFromRequester` on `enqueueRun` and `enqueueRunBatch`.

Port only if Rocketpod has a `plugin-ci.yml`: the step that removes `tests/kit-only` before the
gate.

### 0.34.0: security round 3

Port all of it, with each regression test into `apps/web/tests/api/security/`:
- **Suspension:** a suspended tenant runs no agent runs at enqueue, at start or while running, and the plugin hook `onTenantStatusChanged` fires.
- **Invitations:** the issuer is re-checked at accept, and demotion revokes the invitations someone issued.
- **Ownership ceiling:** it applies on promotion and on owner-invite accept, plus the daily creation counter (new table `tenant_creation_counters`).
- **API keys:** a key stays in its organisation (`withAccountAuth`).
- **AI config saves:** the save locks its row (`FOR UPDATE`).
- **Decide fallback:** `ctx.decide`'s fallback is metered.
- **Sign-in mail:** the window is per canonical mailbox. This runs on `platform.rateLimiter`; see the translations.
- **Upload-path body cap:** see the translations.
- **Microsoft:** verified-domain proof via Graph `/organization`.

### 0.37.0 and 0.38.0: knowledge

Port as is, apart from the translations above:
- **0.37.0:**
  - Eval corpora in `apps/evals`.
  - Structured chunks: heading path, table header, page, character offsets, a stored `search_vector`.
  - `embedding_model` per chunk, and re-embed jobs with a health route.
  - Content-hash dedupe, document retry, facets.
  - The reranker seam and its spend.
  - The daily knowledge cap, which pauses extraction only.
  - Knowledge facts: entities, facts, the extraction job, review, merge and promote, behind the `knowledge-facts` flag.
- **0.38.0:**
  - The full-width Search page, and facts on documents plus a Facts view.
  - `knowledge_value_judgements` and `knowledge_facts.value_ref`.
  - The decision-model judge (TypeSafe's Jev through `ctx.decide`'s decisions scope). Rocketpod already has `services/agents/decisions.ts`.
  - `lookup_facts`, and the facts block in `search_knowledge`.
  - Chat entity cards.

Rocketpod differences to respect:
- `retrieval.ts` keeps Rocketpod's `documents` corpus option.
- The UI has the vertical settings rail and no `'success'` toast.

New files: the whole `services/knowledge/` directory. In `services/ai/`: `chunking.ts`,
`reindex.ts`, `rerank.ts` and the ingest rewrite.

### 0.39.0: the durable runtime

New service files under `services/agents/`, porting as they are:
- `turns.ts`: the journal of model turns and tool results.
- `keys.ts`: once keys hashed over inputs, and the key-conflict error.
- `cancel.ts`: cancel with no live attempt, forced cancel, and the signal.
- `versions.ts`: `meta.version`, `onVersionChange` continue, fail or rerun, and `pinned`.
- `hitl.ts`: deadlines, reminders, `onTimeout` expire or reject, and assignees by user and group.
- `children.ts`: `ctx.spawn` with a remaining-budget hand-off and the cancel cascade.
- `timeline.ts`: the run inspector contract, `GET /runs/:id/timeline`.
- `stats.ts`: `GET /api/agents/stats`.

Also port:
- **The tool loop:** `agent-loop.ts` checkpoints a turn before its tools run, records results by tool-call id, and adds `Tool.sideEffects`, `Tool.durable` and `ToolCallInfo`.
- **Replay:** it serves loop turns from the journal and reports drift and `orderDrift`.
- **Tracing:** the `run started` span, `gen_ai.conversation.id`, `invoke_workflow <type>` job spans, and semconv pinned at 1.45.0.
- **AG-UI:** a cancelled run projects as `RUN_FINISHED { outcome: cancelled }`. This is breaking; carry the note's wording.
- **UI:**
  - The agents pages: one row per agent with 30-day metrics, a page per agent, all runs, whole rows clickable (`rowLink.ts`).
  - The run inspector timeline.
- **CLI:** `agents inspect <runId>`.
- **Plugin seam:** `ctx.spawn`, `ctx.signal`, the journal on a plugin's `AgentCtx`, and `ctx.toolLoop` binding the journal.

Schema:
- The new table `agent_run_turns`, tenant-isolated, with a 30-day prune (`AGENT_TRANSCRIPT_RETENTION_DAYS`).
- New columns on `agent_runs`: `agent_version`, `worker_version_id`, `parent_run_id` and `budget`.
- New columns on `agent_run_interrupts`: assignees, `remind_at` and `reminded_at`.

### 0.40.0: security round 4 and counts-only reports

Port all of it. Each fix has its regression test in Rocketflare's `apps/web/tests/api/security/`,
plus the chunking cases in `tests/config/chunking.test.ts`:

- **Knowledge facts follow document visibility on the producing side:**
  - Extraction and the decision model see only tenant-visible documents' facts and names (`promptScope`).
  - A group-restricted document adds no entity aliases; `ResolveContext.documentVisibility` is new.
  - A fact superseded only by a hidden fact reads as its restored state, with no pointer.
  - `findEntitiesByName` and `entitiesMentionedIn` take the reader's `AccessScope`.
- **Prefer review:** a member's `prefer` is refused (403 `fact_conflict_needs_admin`) when a conflict is someone else's to review or already person-confirmed.
- **Invitations:** sign-up admission uses the same issuer rule as accept (`issuerMayIssue`), and blocking a user revokes everything they issued (`revokeEveryInvitationIssuedBy`).
- **Suspended tenants:** the jobs consumer acks a job unrun unless its tenant is active.
  - `tenant.purge` and `activity.record` always run.
  - A dropped index leaves the document `failed`.
  - The consumer is shared code, so this lands in `processJobsBatch` under pg-boss unchanged.
  - Check that the extract job's delayed re-enqueue goes through the same consumer.
- **Chunker:** headings and table delimiter rows are recognised by linear scans. A wide table header is carried as its first columns, and `embeddingInput`'s prefixed context is bounded.
- **Security reports:** `public-report` publishes counts only and names a contact address. See the 0.35.0 entry below.

### 0.36.0 and 0.36.1: tooling

Port:
- `pnpm kit:upgrade --continue` and `pnpm plugin upgrade <id> --continue`.
- `plugin upgrade` formats every file it added or patched, and warns about partial core edits.
- The CLI resolves paths from the directory it was run in, and warns when environment keys override a saved login.
- `pnpm test` refuses Node < 26 by name.

Skip, because they are Cloudflare-only:
- Provisioning: zone routes, the Neon region, R2 retries and `provision declarations`.
- The public-site cache key and `generationMaxAgeSeconds`. Rocketpod has no `publicSites.cache`.
- The module-scope random id fix, and `global-scope.test.ts`, which tests a Cloudflare upload rule.
- `invocation_logs`.

### 0.35.0: the security-audit skill (optional now)

`rf-security` becomes `rp-security`. Pieces:
- The runner, guard hook, vendored upstream skill and threat model.
- The sandbox driver and its Docker image.
- The counts-only `public-report` from 0.40.0.

Rocketpod translations:
- The sandbox image runs Rocketpod's test projects with Postgres beside them.
- The threat model describes Rocketpod's surfaces instead: Node, pg-boss, OpenWorkflow, S3 and Helm.

This can follow the release; nothing else depends on it.

## Migrations

Port the schema in `apps/web/src/db/schema/`, then run `pnpm db:generate` and `pnpm db:migrate`.
Never copy the kit's migration files. The combined list:

- **0.33.0:** `agent_runs.input_from_requester` (boolean, NOT NULL, default false).
- **0.34.0:** the `tenant_creation_counters` table (`user_id`, `day`, `created`), with no foreign key to tenants.
- **0.37.0:**
  - `chunks`:
    - `embedding_model`, backfilled from documents in the same migration;
    - `heading_path` and `table_header`;
    - `page`, `char_start` and `char_end`;
    - a generated `search_vector` with a GIN index.
  - `documents`:
    - `content_hash`, with a (`tenant_id`, `source`, `content_hash`) index;
    - `origin`;
    - `reviewer_user_id`.
  - New tables `knowledge_entities` and `knowledge_facts`, tenant-isolated.
  - The `pg_trgm` extension.
- **0.38.0:** the `knowledge_value_judgements` table and `knowledge_facts.value_ref`.
- **0.39.0:**
  - The `agent_run_turns` table.
  - New `agent_runs` columns: `agent_version`, `worker_version_id`, `parent_run_id` (a self foreign key with cascade) and `budget`.
  - New `agent_run_interrupts` columns: `assignee_user_ids`, `assignee_group_ids`, `remind_at` and `reminded_at`.

Every new tenant table calls `tenantIsolation()`, and `rls-coverage.test.ts` must pass.

## New configuration

Add each key to `.env.example`, `config.ts` and Helm `values.yaml` `config`. All are optional:
- `AGENT_TRANSCRIPT_RETENTION_DAYS` (default 30).
- `KNOWLEDGE_TENANT_DAILY_COST_USD`.
- `RERANK_MIN_SCORE` and `RERANK_CANDIDATES` (default 20).
- `CHAT_KNOWLEDGE_TOOLS`.
- The build id variable for `worker_version_id` (see the translations).

Check each release note's "How to apply" for any others.

## Verifying the durable runtime on Node

The unit and API tests prove the logic; these prove it on the real engine. Run them against
`docker compose up` with a dummy tenant:

1. **Worker crash mid-tool:**
   - Start an agent run whose tool is slow, and kill the worker process while the tool runs.
   - On restart, the run resumes from the journal and the model turn is not billed twice: count the `ai_usage` rows.
   - A finished read-only tool is not re-run.
   - A `sideEffects` tool settles as unknown outcome.
2. **Cancel during a model call:** the run settles `cancelled` within a few seconds, and the attempt does not retry.
3. **Lost run:** stop the engine after a run's instance ends without settling. The `*/10` sweeper settles it.
4. **Ask with a deadline:** the reminder goes out, and on timeout the run expires or rejects, never approves.
5. **Child run:** a parent spawns a child; cancelling the parent cancels the child. The child is visible only through its parent.
6. **Version change:** bump an agent's `meta.version` while a run is parked. `continue`, `fail` and `rerun` each behave as documented.
7. **Suspension:** suspend the tenant with jobs queued. No model call happens, and a pending document ends `failed`.

## Shipping

- Rocketpod 0.40.0: one porting note (`docs/upgrades/unreleased.md`), breaking (from 0.39.0's AG-UI and `ctx.once` keys) with migrations.
- Nine rows in `docs/FORK.md`, one per Rocketflare release, saying what was ported, translated and skipped.
- `CONCEPTS.md` sections for knowledge (§9) and durable runs, carried over in Rocketpod's own text.
- `pnpm gate` green, the Image, CI and Kit workflows green, then tag and release as for 0.32.2.

## Open questions

- **The build id variable:** which variable names the build, and where Helm takes it from: image tag or digest.
- **OpenWorkflow's errors and states:** its not-found error and run states, for reconcile and the sweeper. Check OpenWorkflow 0.11's API.
- **Port 0.35.0 now or later:** whether to port the audit skill in this release or after it.
- **Retention:** runs and events are never pruned in either kit; this is still undecided upstream.
- **MCP:** whether the `/mcp` server on `mcp-resource-server` should wait for the shared MCP design, or land first and be taken upstream.
