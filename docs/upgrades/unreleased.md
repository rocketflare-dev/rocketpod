---
version: unreleased
previous: 0.45.0
date: null
breaking: false
migrations: ["chunks.context + context_model; chunks.search_vector (STORED) regenerated to read coalesce(context, '') first and chunks_search_vector_idx recreated (rewrites chunks)"]
areas: [api, cli, db, shared, ui, config, docs]
touches_surfaces: [example-agent-summarize-text]
requires_surfaces: []
manual: true
---

## What changed

A release workflow for AWS ECS on infrastructure managed elsewhere: a version tag copies the image to ECR, syncs the UI assets, runs migrate on Fargate and rolls web and worker, configured by one `AWS_DEPLOY_CONFIG` variable.

- A release workflow for AWS ECS whose infrastructure is managed elsewhere: `.github/workflows/deploy-aws.yml` (`workflow_call` and `workflow_dispatch`, input `version`, optional `asset_dirs`, default `assets`), called by a new `deploy-aws` job in `image.yml` after `publish` on a version tag, only when the repository variable `AWS_DEPLOY_CONFIG` is set. That one JSON variable carries twelve keys (`AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY`, `ECS_CLUSTER`, `ECS_SUBNETS`, `ECS_SECURITY_GROUP`, `ECS_WEB_SERVICE`, `ECS_WORKER_SERVICE`, `ECS_FAMILY_PREFIX`, `ASSETS_BUCKET`, `IMAGE_PARAMETER`, `LOG_GROUP`), checked in the first step. The job assumes a role over OIDC in the `production` environment, copies the image GHCR → ECR (skipped when the tag exists), syncs `dist/ui/assets` to the assets bucket as immutable (never `--delete`), writes the SSM image parameter, registers `<prefix>-web|worker|migrate` revisions with only the image swapped, runs migrate on Fargate (failing with its last log lines), then rolls web and worker and checks they are stable on the new revisions. The kit ships no infrastructure. Runbook: `docs/DEPLOY.md` § AWS ECS (infrastructure managed elsewhere).
- Run timelines show model calls (Rocketflare 0.45.0): `services/agents/recording.ts` (new) — `recordingChatClient` wraps `ctx.chat.client` (outside the meter) so every call writes a `tool.start`/`tool.end` pair marked `kind: 'model'`, named for the model, id `model:<round>.<tag>:<n>` (one per `executeRun` invocation, because an OpenWorkflow step retry keeps `run.attempt`), carrying the forced tool, usage, stop reason, the tools called and a forced answer's shape (counts, never text), the end in a `finally`; `loopEventSink` is the new `ctx.journal.onEvent`.
- `ToolLoopJournal.onEvent` (new, optional): a `runToolLoop` with a journal and no `onEvent` of its own records its text, tool calls and results through it (the terminal tool skipped); a loop with its own `onEvent` is unchanged. Replay passes the same sink.
- `agentToolStartEventDataSchema` / `agentToolEndEventDataSchema` gain `kind: 'model'` (`@rocketpod/shared/ai/agents`); the AG-UI projection, the evals export (`rocketpod evals promote`) and the eval transcript (`apps/evals/kit/transcript.ts`) skip such rows.
- Run page: a model-call row ("Model call · <model> answered", duration, tokens), stage headers count model calls apart from tools (`TimelineGroup.modelCount`), the Usage tab gains "Model calls" (`selectWorkStats().modelCalls`, `failedModelCalls`, tokens, `modelUsage`), and a call an earlier invocation left open shows stopped once a `willRetry` error or a later attempt's `running` status lands.
- `TimelineGroup`: a stage with no rows renders as a plain line, without a button or chevron.
- `summarize-text` (and the test-only `test-summarize`) no longer emit their own `submit_summary` pair around the model call: the runtime writes that row.
- Agent asks: an ask's notifications are marked read once it is answered, declined, expired or its run settles (`markNotificationsReadByData` in `services/notifications.ts`, called by `resolveInterrupt` / `expireInterrupts`, which take an optional `realtime` and nudge `notification.read`; `ASK_NOTIFICATION_TYPE` in `services/agents/interrupts.ts`).
- `GET /api/agents/interrupts?mine=true` (`interruptInboxQuerySchema.mine`) lists only the asks addressed to the reader; the Agents nav badge and "N waiting on you" use it, so an admin or a support visitor is no longer counted as waited on for another person's run.
- See `docs/CONCEPTS.md` §9 "Reading runs" and the HITL paragraph above it.
- Knowledge (Rocketflare 0.45.0, #159): `GET /api/knowledge/entities/:id/promote-candidates?q=` (`promoteCandidatesResponseSchema`, at most `PROMOTE_CANDIDATES_MAX` = 10, the entity's own name when `q` is empty, `similarity` or `word_similarity` ≥ 0.3 in the reader's scope) feeds a Promote picker on the entity page in place of the row-id box (`usePromoteCandidates`).
- Knowledge: `search_knowledge`'s facts block and `GET /api/knowledge/mentioned` also find a registered type's DOMAIN rows named in the query (`mentionFinderFor`; new optional `EntityTypeRegistration.mentions`; the default reads the label and alias columns over rows some fact is about).
- Knowledge: the nav badge's count has its own query-key root, `['knowledge-review-count']` (`queryKeys.knowledgeReviewCount.all`, was `queryKeys.knowledge.reviewCount`), nudged only to the reviewers a write touched (`nudgeKnowledgeChange` in `services/knowledge/notify.ts`); `access.changed` invalidates it too.
- CLI (#150): `docs list|search|ingest|retry` (`ingest` takes a text file only, shared tenant-wide) and `facts review|confirm|reject|prefer`.
- Contextual prefixes (#148): flag `knowledge-context` (off), job `document.contextualize` (`services/ai/contextualize.ts`, enqueued by `afterTextIndexed` beside `knowledge.extract`), prompt `knowledge-context`, usage feature `knowledge.context` under the daily knowledge cap, `chunks.context` / `context_model` with the stored `search_vector` reading the context first, `embeddingInput(chunk, context?)`, a re-index of unchanged text keeping contexts, and `POST /api/ai/documents/contextualize` (admin+, at most 200 documents a call) backfilling existing documents behind the Search page's "Add context" notice (admins only, from the new `/facets` `withoutContext`). `secondsUntilNextUtcDay` moved from `knowledge/extract.ts` to `ai/usage.ts`. `pnpm eval retrieval --context` measures it; `knowledge-context` is exempt in the eval coverage contract until a copy adds a retrieval corpus.
- See `docs/CONCEPTS.md` §9 "Contextual prefixes" and the knowledge facts paragraph, and §11.

## How to apply

1. `.github/workflows/**` is a `manual` surface: `pnpm kit:upgrade` does not write these files, it shows their diff in `reference/` for you to apply what you want. To take the AWS ECS release, copy `.github/workflows/deploy-aws.yml` in whole, replacing `rocketpod` in its `GHCR_IMAGE` with the image name your `image.yml` publishes, and add the `deploy-aws` job at the end of your `image.yml`, with `needs:` naming your own CI-wait, chart and publish jobs. A copy whose `image.yml` already has a deploy job keeps its own and skips this.
2. Nothing deploys until you set `AWS_DEPLOY_CONFIG`. To use it, follow `docs/DEPLOY.md` § AWS ECS: create the `production` environment, have your infrastructure's deploy role trust `repo:<owner>/<repo>:environment:production`, then set the variable to the infrastructure's `deploy` output as JSON. From then on every version tag is a production deploy.
3. Take `apps/web/src/api/services/agents/recording.ts` and the `runtime.ts`, `replay.ts`, `agui-projection.ts`, `services/evals.ts` and `services/ai/agent-loop.ts` hunks as they are, and the `packages/shared/src/ai/agents.ts` hunk that adds `kind` to the two tool event schemas.
4. Take the run-page hunks under `apps/web/src/ui/pages/agents/run/` (`timeline/timelineModel.ts`, `timeline/TimelineGroup.tsx`, `timeline/ToolCallRow.tsx`, `output/RunUsageTab.tsx`), and the `apps/evals/kit/transcript.ts` hunk.
5. In each of your own agents and plugin agents, delete any `ctx.emit({ type: 'tool.start' | 'tool.end' })` pair that only brackets a `ctx.chat.client` call (`callStructuredTool`, `complete`, `stream`, a plugin's `ctx.structured`): the runtime now writes that row, and keeping yours shows the call twice. Keep a pair around a tool handler the agent calls directly (`triage-research`'s search).
6. In each of your own agents whose `runToolLoop` (or a plugin's `ctx.toolLoop`) passes `onEvent` only to emit `tool.start`/`tool.end`/`text` rows, consider deleting that `onEvent`: with `journal: ctx.journal` the runtime writes the same rows.
7. If code of your own reads `tool.start` events as "tools the agent called", skip those whose `data.kind === 'model'`.
8. Take the `services/notifications.ts`, `services/agents/interrupts.ts`, `hitl.ts`, `runs.ts` and `routes/agents.ts` (`addressedTo`, `realtime` on `resolveInterrupt`) hunks, the `packages/shared/src/ai/interrupts.ts` hunk (`mine`), and the `ui/hooks/useAgents.ts` line that adds `mine=true` to `useAwaitingInterruptCount`. A call of your own to `expireInterrupts` or `resolveInterrupt` should pass `realtime` where it has one, or the bells re-count only on their next fetch.
9. Take `apps/web/src/api/services/knowledge/notify.ts` and the `review.ts`, `extract.ts`, `resolve.ts`, `entities.ts`, `lookup.ts`, `types.ts` and `routes/knowledge.ts` hunks, the `packages/shared/src/ai/knowledge-facts.ts` and `packages/shared/src/realtime.ts` hunks, then `ui/lib/query-keys.ts`, `ui/hooks/useKnowledge.ts` and `ui/pages/knowledge/EntityPage.tsx`.
10. If code of your own reads `queryKeys.knowledge.reviewCount`, read `queryKeys.knowledgeReviewCount.all` instead; if code of your own sends `entity.changed { entity: 'knowledge' }` after changing review items, call `nudgeKnowledgeChange` with the affected reviewers, or their badges stop refreshing.
11. For each of your own entity types with a custom `resolve` and no `labelColumn`, add a `mentions` finder if its rows should appear in the search facts block; a type with a `labelColumn` needs nothing.
12. Take `apps/cli/src/commands/docs.ts`, `apps/cli/src/commands/facts.ts`, the `apps/cli/src/cli.ts` hunk and `apps/cli/tests/knowledge.test.ts`.
13. Take `apps/web/src/api/services/ai/contextualize.ts`, `queues/handlers/document-contextualize.ts`, the `chunking.ts`, `ingest.ts`, `usage.ts`, `knowledge/extract.ts`, `prompts.ts`, `queues/jobs.ts` and `routes/ai-documents.ts` (`/contextualize`, `/facets`) hunks, and the `packages/shared` hunks in `permissions.ts` (`CORE_FEATURES`: append `knowledge-context`, keep your own keys), `features.ts`, `jobs.ts`, `ai/usage.ts`, `ai/embeddings.ts` (`CONTEXTUALIZE_BACKFILL_MAX`, `contextualizeBackfillResponseSchema`, `withoutContext`) and `ai/eval-coverage.ts` (the `knowledge-context` entry).
14. Take the `apps/web/src/db/schema/chunks.ts` hunk, then `pnpm db:generate --name kit-knowledge-context` and read the SQL. Never copy the kit's migration file. It must add `context` and `context_model` FIRST — drizzle-kit writes them after the `search_vector` that reads `context`, which fails, so move the two `ADD COLUMN`s to the top — then drop and re-add the STORED `search_vector` as `to_tsvector('english', coalesce(context, '') || ' ' || coalesce(heading_path, '') || ' ' || coalesce(table_header, '') || ' ' || text)`, and recreate the index by hand: `CREATE INDEX "chunks_search_vector_idx" ON "chunks" USING gin ("search_vector");`. Rewriting `search_vector` rewrites the whole `chunks` table under a lock: above about 1M chunks, run it in a maintenance window. Then `pnpm db:generate --check` and `pnpm db:migrate`.
15. If you call `embeddingInput` or import `secondsUntilNextUtcDay` from `knowledge/extract` in your own code, the first gained an optional second argument and the second now lives in `services/ai/usage.ts`.
16. Take the `SearchPage.tsx` `ContextBackfillNotice` hunks and `hooks/useDocuments.ts` (`useContextualizeDocuments`, `facetsPollInterval`); `documentFacetsSchema` gained a required `withoutContext`, so a test fixture or client of your own that builds facets adds `withoutContext: 0`.
17. To use it: turn on **Contextual search** for a tenant (Admin → Feature flags), point the `knowledge-context` prompt at a cheap model (Settings → Agent models), then open Search as an admin and click **Add context**. `pnpm eval retrieval --context` needs a corpus with a `retrieval.jsonl` of your own.

## Conflicts to expect

- `.github/workflows/image.yml` → a `deploy-aws` job after `publish` and two header comment lines → keep the app's jobs; point the new job's `needs:` at the app's own job names.
- `apps/web/src/api/services/agents/examples/summarize-text.ts` → its own `submit_summary` pair removed → take the kit side unless you changed that block, then apply step 5 by hand.
- `apps/web/tests/ui/run-page.test.tsx` → the precheck stage is no longer a button, the Summarising stage is the open one → take the kit side.
- `apps/web/tests/api/agent-run-workflow.test.ts` → the event order now has `fake-model` model rows where `submit_summary` was → take the kit side.

- `apps/web/src/ui/pages/knowledge/EntityPage.tsx` → `PromotePanel` rewritten as a picker → take the kit side, then reapply your own copy edits.
- `apps/web/migrations/` → your migrations make the number differ from the kit's `0019` → never copy the kit's file; generate yours (step 14).
- `packages/shared/src/permissions.ts` `CORE_FEATURES` → you added a flag of your own → keep both keys.
- `packages/shared/src/ai/eval-coverage.ts` → you wrote a retrieval corpus → replace the `knowledge-context` exemption with the suite, dataset and baseline.

## Verify

1. `actionlint .github/workflows/deploy-aws.yml .github/workflows/image.yml` reports nothing.
2. With `AWS_DEPLOY_CONFIG` unset, a version tag's `image.yml` run shows `Deploy (AWS ECS)` skipped.
3. `pnpm gate` prints `✔ pnpm gate passed`.
4. `pnpm test api apps/web/tests/api/agent-run-workflow.test.ts` passes, including "a model call that fails closes its row as an error; the retry records its own".
5. `pnpm test api apps/web/tests/api/agent-interrupts.test.ts apps/web/tests/api/agent-interrupt-routes.test.ts` passes, including "answering the ask marks its notification read" and the `?mine=true` cases.
6. Run `summarize-text` locally: the "Summarising" stage expands to a "Model call · <model> answered" row with token counts, and "Checking the input" shows no chevron.
7. `pnpm test api apps/web/tests/api/knowledge-promote.test.ts apps/web/tests/api/knowledge-review.test.ts` passes, including "finds a row named in the query that never had a staging entity".
8. `pnpm --filter @rocketpod/cli test` passes, including `knowledge.test.ts`.
9. `pnpm test api apps/web/tests/api/knowledge-context.test.ts` passes; `\d chunks` shows `context`, `context_model`, the generated `search_vector` reading `coalesce(context, '')` first and `chunks_search_vector_idx`. With the flag on for a tenant, upload a document: its `chunks.context` rows fill in and Settings → Usage shows `knowledge.context`.
