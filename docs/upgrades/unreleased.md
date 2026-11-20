---
version: unreleased
previous: 0.32.2
date: null
breaking: true
migrations:
  - "agent_runs gains input_from_requester, a boolean NOT NULL DEFAULT false"
  - "new table tenant_creation_counters (user_id, day, created), no foreign key to tenants"
  - "the pg_trgm extension; knowledge_entities + knowledge_facts; chunks gain embedding_model (backfilled), heading_path, table_header, page, char_start, char_end and a rebuilt search_vector (table rewrite); documents gain content_hash, origin, reviewer_user_id"
  - "new table knowledge_value_judgements (tenant-isolated); knowledge_facts gains value_ref"
  - "new table agent_run_turns (tenant-isolated, the tool-loop journal); agent_runs gains agent_version, worker_version_id, parent_run_id (self-FK cascade) and budget; agent_run_interrupts gains assignee_user_ids, assignee_group_ids, remind_at and reminded_at"
areas: [api, config, shared, docs, db, ui, evals, cli, tooling]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

A remote MCP server at `/mcp` offers the agents' tools to MCP clients, authorised by an outside OAuth server's access tokens (`MCP_AUTHORIZATION_SERVER`), off until that is set.

- `/mcp` (stateless Streamable HTTP) and RFC 9728 metadata at `/.well-known/oauth-protected-resource[/mcp]`; docs/CONCEPTS.md §19.
- The token's person passes the SSO policy and `admitUser`, and under `OIDC_MANAGED_TENANCY` its orgs claim is reconciled like an id_token's.
- The tools are `buildAgentTools` for the call's tenant and grant (approval-gated tools left out), plus `list_tenants`; a person with several tenants names one per call (`tenant` argument or `mcp-tenant` header).
- CORS answers any origin without credentials on `/mcp` and the metadata.
- New dependency `@modelcontextprotocol/sdk`.

## How to apply

1. Add `@modelcontextprotocol/sdk` (`^1.32.2`) to `apps/web/package.json` and run `pnpm install`.
2. Copy `packages/shared/src/mcp.ts`, `apps/web/src/api/auth/mcp.ts`, `apps/web/src/api/routes/mcp.ts` and `apps/web/tests/api/mcp.test.ts` from the release.
3. In `apps/web/src/config.ts`, add `MCP_AUTHORIZATION_SERVER` (optional URL, blank = unset) to the schema, and the `hasMcp` and `mcpResource` helpers beside `hasOidc`.
4. Add `MCP_AUTHORIZATION_SERVER=` to `apps/web/.env.example` and `MCP_AUTHORIZATION_SERVER: ""` to the chart's `config` in `deploy/helm/<app>/values.yaml`.
5. In `apps/web/src/api/index.ts`, import `mcpRouter` from `./routes/mcp`, add `app.use('/mcp', jsonBodyLimit)` after the `/auth/*` body limit, and `app.route('/', mcpRouter)` right after `app.route('/ws', wsRouter)`, before the mount table.
6. In `apps/web/src/api/middleware/cors.ts`, add the `mcpCors` handler and the `isMcpPath` branch to `corsMiddleware` from the release.
7. In `apps/web/src/api/utils/routes/api-prefixes.ts`, add `/mcp` and `/.well-known/oauth-protected-resource` to `CORE_API_PREFIXES` and de-duplicate `API_PREFIXES` with a `Set`.
8. If your app adds kit-wide agent tools in `buildAgentTools`, check each one is safe to offer to an MCP client: `/mcp` offers every tool that has a handler and no approval gate.
9. Add docs/CONCEPTS.md §19 from the release.

## Conflicts to expect

- `apps/web/src/api/index.ts` → two lines near the `/ws` mount and the body limits → keep yours and add the two.
- `apps/web/src/api/utils/routes/api-prefixes.ts` → `CORE_API_PREFIXES` grew → if you installed the analytics plugin, its `/mcp` is now shadowed by core's; keep both entries.

## Verify

1. `pnpm gate` passes.
2. `MCP_AUTHORIZATION_SERVER` unset: `curl -s -o /dev/null -w '%{http_code}' localhost:3001/mcp` prints `404`.
3. `MCP_AUTHORIZATION_SERVER` set: `curl -s localhost:3001/.well-known/oauth-protected-resource/mcp` names `<APP_URL>/mcp` and the server, and `curl -si -X POST localhost:3001/mcp` answers 401 with a `WWW-Authenticate` header.

## Rocketflare 0.33.0 and 0.34.0

Ported from Rocketflare's notes of the same versions, translated onto the Node platform. Plugin
tools get `ToolCtx.requesterUrls`; the UI offers "Create organisation" only when the server would
allow it; suspended organisations run no agents; invitation and ownership rules hold on every
path; API keys stay in their organisation; AI config saves lock their row; `ctx.decide`'s fallback
is metered; sign-in mail counts per mailbox; upload prefixes stay capped; Microsoft proves
addresses.

### What changed

- `GET /auth/session` answers `canCreateTenant` (`tenantCreationRefusal(cfg, auth)` in `services/tenants.ts`, the one rule `POST /api/tenants` also enforces); `OrgSwitcher` and `/select-tenant` hide "Create organisation" when it is false.
- `ToolCtx.requesterUrls` (`services/agents/tools/requester-urls.ts`): the URLs a person typed — chat turns, or an agent run's input submitted through `POST /api/agents/runs` / `/runs/batch` (`agent_runs.input_from_requester`, set only by those routes through `enqueueRun({ inputFromRequester })`). `@testkit/unit` `makeToolCtx({ requesterUrls })`.
- Suspension: `enqueueRun` / `enqueueRunBatch` refuse a non-active tenant with 403 `tenant_suspended`; `executeRun` settles such a run `cancelled` before any model call; `isCancelRequested` reads the tenant's status; `setTenantSuspended` cancels `queued` and `awaiting_input` runs and runs every plugin's new `hooks.onTenantStatusChanged(db, tenantId, status, env)`.
- Invitations: accept re-checks the issuer (410 `invitation_revoked`); a role change revokes the target's pending invitations the new role could not issue.
- `MAX_OWNED_TENANTS_PER_USER` holds on promotion to owner and on owner-invite accept (`assertMayOwnAnother`), and bounds creations per person per UTC day (`tenant_creation_counters`, pruned nightly by `runPruneExpired`).
- API keys: `withAccountAuth(c)` — `POST /api/tenants`, `GET /api/invitations/pending`, `POST /api/access-requests` answer 403 `insufficient_scope` to a key; `GET /api/tenants` lists the key's organisation alone.
- AI config saves: `upsertAiConfig` (`services/ai/configs.ts`) reads the row it overwrites `FOR UPDATE` inside its transaction.
- `ctx.decide`'s chat fallback runs through the run meter (`meterChatClient(client, meter, { feature, billedToPlatform })`; `resolveDecisions`' `wrapChat(client, { provider, billedToPlatform })`).
- Sign-in mail: the per-recipient window on `platform.rateLimiter` is keyed on `canonicalMailbox(email)` (`utils/core/mailbox.ts`).
- Body limits: beneath an upload prefix a JSON body keeps 1 MB and any other body is capped at `MAX_UPLOAD_PATH_BODY_BYTES` (10 MB + 64 KB). `@hono/node-server` sets no limit of its own, so these are the only caps.
- Microsoft: `emailVerified` from Graph `/organization` verified domains; the OAuth callback refuses an unverified address only where it would match or admit an account.

### How to apply

1. Follow Rocketflare's `docs/upgrades/0.33.0.md` and `0.34.0.md` "How to apply", with these Rocketpod paths and differences:
   - `upsertAiConfig` lives in `apps/web/src/api/services/ai/configs.ts`, not the route: move the `FOR UPDATE` read (`lockConfig`) and the insert-or-update there.
   - `setTenantSuspended(db, { tenantId, suspended, admin, env, platform, logger, realtime })` takes `platform` (`c.get('platform')`) for `requestCancel`'s forced cancel.
   - `recipientMailAllowed` takes `platform.rateLimiter`; hash `canonicalMailbox(email)` there.
   - Tests use `tests/helpers/test-agents{,-shared}.ts` (`TEST_SUMMARIZE`, `TEST_RESEARCH`, `withTestAgents`, `testAgentsServerBarrel`) where Rocketflare's use `fixture-agents.ts`, `runAgentRun` with `createFakeStep` where they drive `AgentRunWorkflow`, and `scriptPlatformChat` on the `AI_*` fake endpoint where they stub Workers AI.
2. Run `pnpm db:generate` and `pnpm db:migrate`.
3. Regenerate `docs/plugin-api.md` with `node scripts/plugin-api-doc.mjs`.

### Conflicts to expect

- `apps/web/src/api/services/admin.ts` → `setTenantSuspended` takes one input object → update your own callers.
- `apps/web/src/api/services/ai/resolve.ts` → `wrapChat`'s second argument is `{ provider, billedToPlatform }`.
- `apps/web/src/api/routes/auth/oauth.ts` → the `emailVerified === false` refusal moved below the provider-link lookup.
- `apps/web/src/ui/pages/SelectTenant.tsx` → the create control is wrapped in `canCreateTenant`.

### Verify

1. `tests/api/security/{requester-urls,tenant-creation,agent-run-tenant-suspension,invitation-authority,api-key-account-scope,ai-config-concurrent-saves,agent-run-budget-accounting,sign-in-mail-per-recipient,upload-path-body-limit,microsoft-sign-in-email}.test.ts` pass.
2. `tests/api/plugin-tenant-status-hook.test.ts` and `tests/api/plugin-events.test.ts` pass.

## Rocketflare 0.37.0

The knowledge base gains structured chunks, re-embedding on a model change, ingest dedupe, an
optional HTTP reranker and typed knowledge facts behind the `knowledge-facts` flag.

### What changed

- Chunks are exact slices cut at headings and table rows, with `headingPath`, `tableHeader`, `charStart`/`charEnd` and `embeddingModel`; every dense leg filters on the model; `search_vector` now covers heading path + table header + text.
- `document.reembed` re-embeds stale documents after an embeddings config change; `GET /api/ai/documents/health`, `POST /reembed`, `POST /:id/retry`; an unchanged upsert skips the embed; a matching plain ingest answers `deduplicated: true`.
- Reranking: the `rerank` scope, a Cohere-style `POST {base}/rerank` client only (no Workers AI reranker), `RERANK_CANDIDATES`, `RERANK_MIN_SCORE`.
- Knowledge facts: `knowledge.extract`, `knowledge_entities`/`knowledge_facts`, `/api/knowledge`, `lookup_facts`, the review list, the entity page, chat entity cards, `ServerPlugin.knowledgeEntityTypes`, `KNOWLEDGE_TENANT_DAILY_COST_USD`.
- Metering: `knowledge.embeddings` / `knowledge.rerank` / `knowledge.extraction` usage rows.
- Tests: the fake model endpoint answers `/rerank`; the api suites install a network guard.

### How to apply

1. Follow Rocketflare's `docs/upgrades/0.37.0.md`, with these Rocketpod differences:
   - Queue producers take `platform.jobs`; the cap pause re-enqueues with `delaySeconds` (pg-boss `startAfter`, ≤ 43200).
   - `resolveRerank` reads a tenant `rerank` row only; drop every `workers_ai` reranker, preset and price.
   - `routes/ai-config.ts` calls `reembedAfterEmbeddingsChange` around `services/ai/configs.ts`'s writes.
   - Tests stub the reranker with `stubs(env).ai.respond` on `FAKE_MODELS_BASE_URL`, not an AI binding.
2. Add `KNOWLEDGE_TENANT_DAILY_COST_USD`, `RERANK_CANDIDATES` and `RERANK_MIN_SCORE` to `config.ts`, `.env.example` and the Helm `values.yaml`.
3. Run `pnpm db:generate`, then edit the SQL: `CREATE EXTENSION IF NOT EXISTS pg_trgm` first, backfill `chunks.embedding_model` from `documents`, move the `search_vector` drop and re-add after the new columns and recreate `chunks_search_vector_idx`. Then `pnpm db:migrate`.
4. Regenerate `docs/plugin-api.md` with `node scripts/plugin-api-doc.mjs`.

### Conflicts to expect

- `apps/web/src/api/services/ai/resolve.ts` → keep the `EMBEDDINGS_*` platform tier; rerank has no platform tier.
- `apps/web/src/api/services/ai/retrieval.ts` → keep the `documents` corpus option beside the rerank step.
- `apps/web/src/ui/pages/documents/DocumentsPage.tsx` → no success toasts.

### Verify

1. `tests/api/{document-reembed,knowledge-*}.test.ts` and `tests/config/rerank.test.ts` pass.
2. `tests/api/knowledge-chunk-migration.test.ts` migrates a 0013 database and finds the backfilled model.

## Rocketflare 0.38.0

Knowledge is easier to explore and its facts are judged by a decision model: a filtered Search
page, facts on each document and in a Facts view, and typed same-entity / same-value questions.

### What changed

- `POST /api/ai/documents/search` takes optional `filters` (`sources`, `contentTypes`, `createdFrom`, `createdTo`) that only narrow the visible set; the response gains `lexical: 'used' | 'no_terms'`.
- New `GET /api/ai/documents/facets`: sources, content types, date span and `staleEmbeddings` over the reader's visible indexed documents.
- New `/api/knowledge` reads (flag `knowledge-facts`): `GET /mentioned?q=`, `GET /documents/:id/facts`, `GET /entities`.
- The Search page is rewritten (filter column, URL state, highlighted passages, stale-embeddings notice with "Re-index now", "too common" for a stopword-only query); the Knowledge page gains a Facts view (`?view=facts`) and the viewer a Facts tab whose "Show in document" marks the quote (`documentPath` `end`).
- The decision model (`services/knowledge/judge.ts`, prompt key `knowledge-decide`) links a near-miss mention to a known entity and judges two differing values `same` / `more_specific` / `different`; verdicts are stored in `knowledge_value_judgements`.
- `EntityTypeDeclaration.refs` resolves a value to an entity, stored as `knowledge_facts.value_ref` (`valueEntity` on a fact, `names` on a fact hit).
- The run timeline shows entity cards for `lookup_facts` and `search_knowledge`'s facts block; `searchKnowledge` in the plugin API returns `rerankScore` and the `rerank` outcome; `resolveDecisions` takes `fallbackPromptKey`.

### How to apply

1. Follow Rocketflare's `docs/upgrades/0.38.0.md`, with these Rocketpod differences:
   - `routes/ai-documents.ts` passes `c.get('platform')` (not `c.env`) to `searchKnowledgeChunks` and `resolveEmbeddingsModel`.
   - The Search page's type filter groups by `documentTypeLabel`; Rocketpod has no Excel or OpenDocument upload types, so the grouping case in `tests/ui/search-page.test.tsx` uses `text/plain` + an unlisted `text/*` type (both read as Text).
2. Run `pnpm db:generate` (migration `0015_kit-knowledge-judgements-and-refs`, the same SQL as upstream's apart from the role), then `pnpm db:migrate`.
3. Regenerate `docs/plugin-api.md` with `node scripts/plugin-api-doc.mjs`.

### Conflicts to expect

- `apps/web/src/api/routes/ai-documents.ts` → keep the platform argument; register `/facets` before `GET /:id`.
- `apps/web/src/ui/pages/documents/SearchPage.tsx` → take the release's, keep "no success toast".
- Any test fixture building a `SearchResponse` → add `lexical: 'used'`.

### Verify

1. `tests/api/{knowledge-search-filters,knowledge-browse,knowledge-extract}.test.ts`, `tests/config/knowledge-judge.test.ts` and `tests/ui/{search-page,knowledge-browse,run-tool-result-cards}.test.tsx` pass.
2. `psql "$DATABASE_URL" -c '\d knowledge_value_judgements'` shows the table.

## Rocketflare 0.39.0

**Breaking.** Agent runs survive what used to cost them: a retried step replays its recorded model
turns and tool results, a cancel stops the call in flight, lost runs are swept, and runs record
their agent version and build, spawn child runs and can be inspected turn by turn.

### What changed

- **Breaking — AG-UI:** a cancelled run now projects as `RUN_FINISHED { outcome: { type: 'cancelled' } }`, not `RUN_ERROR` `agent_run_cancelled`. A client that keyed on the error code must read the outcome.
- **Breaking — `ctx.once` keys:** `ctx.once(label, fn, { inputs })` stores the key as `label#<hash of inputs>`; the same key twice in one attempt throws `EffectKeyConflictError` (event code `agent_effect_key_conflict`, never retried). A `once` in a loop that reused one key must pass what differs as `inputs`.
- The turn journal (`agent_run_turns`, `ctx.journal`, `runToolLoop({ journal })`), `Tool.sideEffects` / `Tool.durable`, `ToolCallInfo { toolCallId, idempotencyKey }`; pruned nightly after `AGENT_TRANSCRIPT_RETENTION_DAYS` (30).
- Cancel in flight: `watchCancel`, `abortableChatClient`, `ctx.signal`; a silent `running` run settles at once (`ATTEMPT_DEAD_MS`).
- New `*/10 * * * *` cron: `sweepLostRuns` and `sendReminders`; `0 4 * * *` adds `pruneAgentTurns`.
- Versions: `meta.version`, `meta.onVersionChange` (`continue|fail|rerun`), `pinned`; `agent_runs.worker_version_id` from `APP_VERSION_ID`; the recordings check (`tests/agent-recordings/*.json`, `agent:replay --record`).
- HITL: `meta.hitl { timeout, remindAfter, onTimeout }`, ask `assignees { userIds, groupIds }`.
- Child runs: `ctx.spawn`, `agent_runs.parent_run_id` / `budget`; `GET /runs` leaves children out unless `?parentRunId=`.
- Inspector: `GET /api/agents/runs/:id/timeline`, `GET /api/agents/stats`, `rocketpod agents inspect`, `agents runs list --parent|--since|--agent-version`; new `/agents/:agentKey` and `/agents/runs` pages and the run page's Inspect tab.
- Tracing: a job's AI span is `invoke_workflow <type>` (was `job <type>`); a `run started` span at the first claim; `gen_ai.conversation.id` on every run span; `schemaUrl` semconv 1.45.0.
- Lint: `biome check . --error-on-warnings` — a warning now fails the gate.

### How to apply

1. Follow Rocketflare's `docs/upgrades/0.39.0.md`, with these Rocketpod differences:
   - The build id is `APP_VERSION_ID` (optional, `src/config.ts`), not the `CF_VERSION_METADATA` binding: add it to `.env.example`, Helm (`config.APP_VERSION_ID`, defaulted in `templates/configmap.yaml` to `.Values.image.tag | default .Chart.AppVersion`) and compose (`APP_VERSION_ID: ${APP_VERSION_ID:-}`). Add `AGENT_TRANSCRIPT_RETENTION_DAYS` to the same three.
   - The run engine is `env.runs` / `platform.runs`, not `env.AGENT_RUN_WORKFLOW`. A missing engine run is the typed `RunInstanceNotFoundError` (`src/platform/types.ts`), thrown by `src/node/runs.ts` and the test `RecordingWorkflow`; `isMissingInstanceError` matches the type or its `code`, never the message.
   - The crons are `SCHEDULED_TASKS` entries (`api/scheduled.ts`); there is no toml. `runSweepLostRuns` takes `Pick<Platform, 'runs'>`.
   - `claimStep(db, platform, logger, params, { cfg })` from `agent-run-body.ts`.
   - Skip the wrangler tomls, `[version_metadata]`, `wrangler types`, `provision.ts`, `AgentRunWorkflow` and the cloudflare-workers mock.
   - `scripts/plugin.mjs`: every `requireClean` call is `requireClean(args)`.
2. Run `pnpm db:generate` (migration `0016_kit-agent-durable-runtime`, upstream's `0031` + `0032` in one, apart from the role), then `pnpm db:migrate`.
3. Fix every Biome warning (`pnpm lint` now fails on them).
4. Regenerate `docs/plugin-api.md` with `node scripts/plugin-api-doc.mjs`.

### Conflicts to expect

- `apps/web/src/api/services/agents/runtime.ts` → `notifyApprovers` moved to `hitl.ts`; keep `Platform` as the env type and add `cancelPollMs`.
- `apps/web/src/api/services/agents/runs.ts` → the insert keeps `concurrencyKey` and adds `agentVersion`, `parentRunId`, `budget`.
- `apps/web/src/ui/pages/agents/AgentsPage.tsx` → take the release's; keep the Run button behind `agent.startable`.
- A test that runs the cross-tenant `runSweepLostRuns` against its own env settles other files' stale runs as not found; sweep one run with `sweepRun` instead (`agent-hitl.test.ts`).

### Verify

1. `tests/api/agent-{children,durable-loop,hitl,loop-journal,recordings,stats,sweeper,versions}.test.ts` pass.
2. `tests/api/node-runs.test.ts` passes: a cancel reaches a hung model call and the run settles `cancelled` with the engine run complete; a second cancel terminates it.
3. `psql "$DATABASE_URL" -c '\d agent_run_turns'` shows the table.

## Rocketflare 0.40.0

Knowledge facts are built only from documents every reader may see and settled only by those
allowed, invitations follow their issuer, suspended organisations run no queued jobs, and the
chunker runs in linear, bounded work.

### What changed

- Extraction and the decision model see only tenant-visible documents' entities, facts and held values (`promptScope` in `services/knowledge/extract.ts`); a group-restricted document adds no aliases (`ResolveContext.documentVisibility`, now required).
- A fact superseded only by a fact the reader cannot see reads as its restored state with `supersededById: null`, and is answerable, counted and reviewable by that reader (`supersededOutOfViewSql` / `stateInViewSql`).
- `findEntitiesByName` and `entitiesMentionedIn` take the reader's `AccessScope` instead of a tenant id.
- A member's `prefer` is refused with 403 `fact_conflict_needs_admin` (new error code) when a visible conflict is someone else's to review, has no reviewer, or was confirmed by another person.
- Sign-up admission counts an invitation only when `issuerMayIssue` holds for its issuer; blocking a person revokes every pending invitation they issued, in every tenant (`revokeEveryInvitationIssuedBy`).
- The jobs consumer (`queues/jobs.ts`, under pg-boss) acks unrun every job whose payload names a tenant that is not `active`; `tenant.purge` and `activity.record` always run; a dropped `document.index` / `document.convert` leaves a `pending` document `failed`. The knowledge-extract job's next-day delayed re-enqueue is a normal pg-boss job and meets the same check.
- `chunking.ts` finds ATX headings and GFM delimiter rows by linear scans; a table header wider than a quarter of the window is carried as its first columns plus ` …`; `embeddingInput` cuts the prefixed context to `EMBEDDING_CONTEXT_MAX_CHARS` (1600) and a heading title to `HEADING_TITLE_MAX_CHARS` (200).
- `docs/DEPLOY.md` § Observability: ingress and reverse-proxy access logs record magic-link and invitation URLs with their tokens.

### How to apply

1. Follow Rocketflare's `docs/upgrades/0.40.0.md` steps 1–10 and 15–19, with these Rocketpod differences:
   - Skip steps 11–14 (`rf-security`'s `public-report`): Rocketpod has not ported the security-audit skill yet (Rocketflare 0.35.0).
   - Skip the `invocation_logs` toml step; Rocketpod has no toml.
   - In `suspended-tenant-jobs.test.ts`, `setTenantSuspended` takes `platform: resolvePlatform(env)`, the purge case writes through `stubs(env).files`, and the batch queue is `rocketpod-jobs`.
   - In the knowledge tests, the jobs queue is `env.jobs`.
2. No migration.

### Conflicts to expect

- `apps/web/src/api/queues/jobs.ts` → Rocketpod's consumer takes `JobBatch` and a `platform` → add the imports, `tenantMayRun` / `afterDropped`, and the check at the top of `processMessage`'s `try`.
- `apps/web/tests/api/jobs-consumer.test.ts` → its jobs name real tenants now (`createTestTenantWithUser`) → drop the fixed `TENANT` id.

### Verify

1. `tests/api/security/{invitation-issuer-admission,knowledge-prefer-authority,knowledge-visibility-producer,knowledge-visibility-readers,suspended-tenant-jobs}.test.ts` pass.
2. `tests/config/chunking.test.ts` passes.

## Rocketflare 0.36.0 and 0.36.1

Upgrades and plugin upgrades finish cleanly after rejects, and the CLI and `pnpm test` say what
is wrong with the shell they run in.

### What changed

- `pnpm kit:upgrade --continue` (`scripts/upgrade.mjs`, `stampUpgrade` / `continueUpgrade`): after an `--apply` that left rejects, records the version, commit and history once every `*.rej` is resolved and deleted.
- `pnpm plugin upgrade <id> --continue`: the same finish for a plugin; it never re-patches.
- `pnpm plugin upgrade` formats every file it added or patched, and `add` / `upgrade` warn when a core edit's lines were partly in the file already (`partialCoreEdits` in `scripts/lib/plugin-lib.mjs`).
- The CLI resolves paths from the directory `pnpm cli` was typed in (`INIT_CWD`), and warns when `ROCKETPOD_API_KEY` / `ROCKETPOD_URL` from the environment override a different saved login.
- `pnpm test` refuses Node < 26 by name.

### How to apply

1. Port `scripts/upgrade.mjs`, `scripts/plugin.mjs` and `scripts/lib/plugin-lib.mjs` (+ `.d.mts`) from Rocketflare 0.36.1, leaving out `writeDeclarations` (Cloudflare provisioning) and keeping `requireClean(args)` and `host.translate`.
2. Port `apps/cli/src/{cli,config,context}.ts`, and the Node check at the top of `scripts/test.mjs`.
3. Copy `apps/web/tests/config/upgrade-continue.test.ts`, and the new cases in `plugin-host-seams.test.ts`, `plugin-lib.test.ts` and `apps/cli/tests/config.test.ts` (env names `ROCKETPOD_*`).
4. Port the `--continue` paragraphs into `.claude/skills/rp-upgrade/SKILL.md` and `rp-plugin/SKILL.md`.

### Conflicts to expect

- `scripts/plugin.mjs` → Rocketpod writes no wrangler tomls → the `--continue` branch and `formatWritten` go in without `writeWranglerTomls`.

### Verify

1. `pnpm kit:upgrade --help` and `pnpm plugin --help` list `--continue`.
2. `tests/config/{upgrade-continue,plugin-host-seams,plugin-lib}.test.ts` pass.
