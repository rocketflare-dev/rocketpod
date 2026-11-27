---
version: unreleased
previous: 0.45.0
date: null
breaking: false
migrations: []
areas: [api, shared, ui, config, docs]
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

## How to apply

1. `.github/workflows/**` is a `manual` surface: `pnpm kit:upgrade` does not write these files, it shows their diff in `reference/` for you to apply what you want. To take the AWS ECS release, copy `.github/workflows/deploy-aws.yml` in whole, replacing `rocketpod` in its `GHCR_IMAGE` with the image name your `image.yml` publishes, and add the `deploy-aws` job at the end of your `image.yml`, with `needs:` naming your own CI-wait, chart and publish jobs. A copy whose `image.yml` already has a deploy job keeps its own and skips this.
2. Nothing deploys until you set `AWS_DEPLOY_CONFIG`. To use it, follow `docs/DEPLOY.md` § AWS ECS: create the `production` environment, have your infrastructure's deploy role trust `repo:<owner>/<repo>:environment:production`, then set the variable to the infrastructure's `deploy` output as JSON. From then on every version tag is a production deploy.
3. Take `apps/web/src/api/services/agents/recording.ts` and the `runtime.ts`, `replay.ts`, `agui-projection.ts`, `services/evals.ts` and `services/ai/agent-loop.ts` hunks as they are, and the `packages/shared/src/ai/agents.ts` hunk that adds `kind` to the two tool event schemas.
4. Take the run-page hunks under `apps/web/src/ui/pages/agents/run/` (`timeline/timelineModel.ts`, `timeline/TimelineGroup.tsx`, `timeline/ToolCallRow.tsx`, `output/RunUsageTab.tsx`), and the `apps/evals/kit/transcript.ts` hunk.
5. In each of your own agents and plugin agents, delete any `ctx.emit({ type: 'tool.start' | 'tool.end' })` pair that only brackets a `ctx.chat.client` call (`callStructuredTool`, `complete`, `stream`, a plugin's `ctx.structured`): the runtime now writes that row, and keeping yours shows the call twice. Keep a pair around a tool handler the agent calls directly (`triage-research`'s search).
6. In each of your own agents whose `runToolLoop` (or a plugin's `ctx.toolLoop`) passes `onEvent` only to emit `tool.start`/`tool.end`/`text` rows, consider deleting that `onEvent`: with `journal: ctx.journal` the runtime writes the same rows.
7. If code of your own reads `tool.start` events as "tools the agent called", skip those whose `data.kind === 'model'`.
8. Take the `services/notifications.ts`, `services/agents/interrupts.ts`, `hitl.ts`, `runs.ts` and `routes/agents.ts` (`addressedTo`, `realtime` on `resolveInterrupt`) hunks, the `packages/shared/src/ai/interrupts.ts` hunk (`mine`), and the `ui/hooks/useAgents.ts` line that adds `mine=true` to `useAwaitingInterruptCount`. A call of your own to `expireInterrupts` or `resolveInterrupt` should pass `realtime` where it has one, or the bells re-count only on their next fetch.

## Conflicts to expect

- `.github/workflows/image.yml` → a `deploy-aws` job after `publish` and two header comment lines → keep the app's jobs; point the new job's `needs:` at the app's own job names.
- `apps/web/src/api/services/agents/examples/summarize-text.ts` → its own `submit_summary` pair removed → take the kit side unless you changed that block, then apply step 5 by hand.
- `apps/web/tests/ui/run-page.test.tsx` → the precheck stage is no longer a button, the Summarising stage is the open one → take the kit side.
- `apps/web/tests/api/agent-run-workflow.test.ts` → the event order now has `fake-model` model rows where `submit_summary` was → take the kit side.

## Verify

1. `actionlint .github/workflows/deploy-aws.yml .github/workflows/image.yml` reports nothing.
2. With `AWS_DEPLOY_CONFIG` unset, a version tag's `image.yml` run shows `Deploy (AWS ECS)` skipped.
3. `pnpm gate` prints `✔ pnpm gate passed`.
4. `pnpm test api apps/web/tests/api/agent-run-workflow.test.ts` passes, including "a model call that fails closes its row as an error; the retry records its own".
5. `pnpm test api apps/web/tests/api/agent-interrupts.test.ts apps/web/tests/api/agent-interrupt-routes.test.ts` passes, including "answering the ask marks its notification read" and the `?mine=true` cases.
6. Run `summarize-text` locally: the "Summarising" stage expands to a "Model call · <model> answered" row with token counts, and "Checking the input" shows no chevron.
