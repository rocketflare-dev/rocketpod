# Jobs (pg-boss)

Producer `enqueueJob(queue, input)` / `enqueueJobs` (`../services/jobs.ts`: validates
`jobInputSchema` from `@rocketpod/shared/jobs`, stamps `{ id, enqueuedAt }`) onto `platform.jobs`.
Consumer `processJobsBatch(batch, { env, config, logger })` (`jobs.ts`), dispatching on `type` to
`handlers/*`; `../queue.ts` routes `batch.queue` by prefix (`isJobsQueue`); `src/node/jobs.ts` feeds
it from pg-boss. Fire-and-forget work under ~30 s is a job; multi-step work or minutes+ is a durable
run (`../services/agents/CLAUDE.md`).

## Adding a job type

- A variant in `CORE_JOB_VARIANTS` (`packages/shared/src/jobs.ts` — `jobInputSchema`,
  `jobEnvelopeSchema`, `JobType`, `JOB_TYPES` are all DERIVED from that one list), a handler in
  `handlers/`, and its entry in `coreHandlers` (`jobs.ts`). **There is no `runHandler` switch**: the
  mapped type `{ [T in CoreJobType]: JobHandler<T> }` is the completeness check, and dispatch is
  `handlers[job.type](job as never, ctx)`. A plugin brings its variants in `SharedPlugin.jobs` and
  its handlers in `ServerPlugin.jobHandlers`, checked against the types IT declared
- The `type` string is the version seam: a breaking payload change is a new type
  (`email.send.v2`), never an edited schema. Messages carry ids, not rows
- Copy `handlers/document-index.ts` (the shortest kit handler) or
  `src/plugins/example-feature/jobs/ping.ts` (the shortest one full stop)

## Handler contract

- `(job: JobOf<'x'>, ctx: { env, platform, config, logger, db, tracer? })`. `tracer` is the
  message's span recorder, flushed by the consumer before `db` closes — an AI handler brackets its
  work in `withAgentTrace(..., { kind: 'job', spanName: 'invoke_workflow <type>' })`. Each message gets its own
  DB client, closed in `finally`
- **Never `waitUntil` in a consumer — await everything.** A handler that throws is retried, one that
  returns is acked
- Poison policy: an envelope that fails `jobEnvelopeSchema` is logged and **`ack()`ed** (retrying
  cannot make it valid). Handler error → `retry({ delaySeconds: backoffSeconds(attempts) })`, 30 s
  doubling to a 15 min cap — but the queue's policy (same curve, jittered up to 2×, 3 retries, then
  `rocketpod-jobs-dlq`) picks the actual delay, so `retry()`'s figure is a floor. Unknown queue →
  `ackAll()`
- **A job naming a tenant runs only while it is `active`**: before dispatch the consumer reads
  `tenants.status` for a payload `tenantId` (a UUID) and acks the message unrun otherwise —
  suspended or deleted, kit and plugin jobs alike, and a delayed re-enqueue (the extract job's
  next-UTC-day `startAfter`) is the same message through the same check; `RUN_FOR_ANY_TENANT`
  (`tenant.purge`, `activity.record`) is the exception list. `afterDropped` leaves a dropped
  `document.index` / `document.convert`'s `pending` row `failed` for Retry. A test consuming such
  a job creates the tenant first (`docs/CONCEPTS.md` §1)
- Missing jobs queue → `JobsQueueNotConfiguredError` (503 `jobs_not_configured`), never a silent
  inline fallback

## The kit's jobs

- Queued in the kit: `tenant.purge`, invitation (create/bulk/resend) and access-request-decided
  emails (`email.send`), `activity.record`, `document.index`, `document.convert`,
  `document.reembed`, `chat.compact`, `event.deliver`, `knowledge.extract`,
  `document.contextualize`. The **magic-link email
  stays inline** — a person is waiting on it
- A message that throws on every retry goes to the dead-letter queue (`rocketpod-jobs-dlq`).
  Nothing consumes it, so a handler must leave its rows in a state a person can recover from
  (`failed` + Retry, a re-requestable job), never half-written
- `knowledge.extract` (`{ tenantId, documentId, contentHash? }`) reads typed facts from one
  indexed document (`extractDocumentFacts`, `../services/knowledge/CLAUDE.md`; a run that wrote
  or removed facts nudges `entity.changed { entity: 'knowledge' }` and the affected reviewers'
  `knowledge-review-count` through `collectingRealtime`,
  flushed before the handler returns). Only `afterTextIndexed` (`services/ai/ingest.ts`) enqueues
  it — after an inline index, a `document.index` or a `document.convert` that changed the text —
  and only with the `knowledge-facts` flag on and an entity type registered; a producer whose text
  is unchanged sets `document.index`'s `skipExtraction`. The job re-checks every gate, skips (acks)
  a document whose hash moved on, and at the tenant's `KNOWLEDGE_TENANT_DAILY_COST_USD` cap
  re-enqueues ITSELF with a delay to the next UTC day (≤ 12 h a hop, pg-boss's `startAfter`)
  instead of throwing. Re-extraction replaces the document's facts, so a redelivery is idempotent
- `document.contextualize` (`{ tenantId, documentId, contentHash? }`, `knowledge-context` flag)
  writes each passage's situating context and re-embeds it (`contextualizeDocument`,
  `services/ai/contextualize.ts`). Enqueued by `afterTextIndexed` beside `knowledge.extract`
  (flag on, text changed) and by `POST /api/ai/documents/contextualize` (the backfill). Gates ack
  (document gone, not indexed or changed since, flag off, no chat model, nothing left); the daily
  cap re-enqueues ITSELF for the next UTC day (`secondsUntilNextUtcDay`, `startAfter`); a provider
  failure throws and the retry asks only the passages still without a context
- `document.reembed` (`{ tenantId, model }`) is a self-continuing chain: ONE bounded batch of the
  tenant's stale documents per message (`reembedBatch`, `services/ai/reindex.ts`), then the same
  payload re-enqueued while any remain — the stale predicate is the cursor, so a retry resumes. A
  message for a model the tenant no longer resolves is acked (the newer chain owns the work); a
  transient provider error throws with the old chunks intact; a provider refusal of one document
  marks it `failed` and the batch moves on
- `event.deliver` is ONE subscriber of one `plugin_events` row: `{ tenantId, eventId,
  subscriber }`, never the payload. It re-reads the row under the tenant, re-validates, and calls
  that subscriber only; a missing row (pruned, other tenant) or subscriber is acked, a 4xx
  `ApiError` is acked, anything else throws and retries. Queued by `emitEvent`, never by hand
- **`tenant.purge` is the out-of-database half of deleting a tenant.** The FK cascade is complete
  inside Postgres and reaches nothing else, so `deleteTenant` proves the jobs queue BEFORE the
  `DELETE`, then enqueues with the tenant id and slug — the row is gone, so the payload is all the
  handler will ever have. The handler runs every plugin's `onTenantDeleted` first (each try/caught,
  so it cannot fail the job) and then `purgeTenantObjects`, which pages `tenants/<id>/` with
  `listPage` + `deleteMany`. A missing storage is ACKED with a log — no store, no objects, and no
  retry can conjure one — which is deliberately the opposite of `document.convert`, where the bytes
  exist and are unreachable. A storage error throws and is retried: the alternative is a tenant's
  files living on for ever because one list call timed out. Everything in it is idempotent, which is
  what makes that retry free
- `example-feature.ping` is the smoke job and it belongs to the `example-feature` PLUGIN, not to the
  kit: `POST /api/example-feature/ping` (or `rocketpod example-feature ping`) enqueues it, then
  watch the server log (`pnpm dev`)
- `chat.compact` — the work is `compactConversation` (`services/ai/chat-compaction.ts`; the handler
  is one call, and anything else that compacts a thread calls the same function) — folds the
  messages outside a conversation's `CHAT_HISTORY_MAX_CHARS` budget into `conversations.summary`;
  the window comes from the same pure `selectHistoryWindow` the route uses, and the write is a
  compare-and-set on `summarised_through_id` so two deliveries cannot lose an update
- `document.index` re-indexes a `documents` row from its stored `content` (`handlers/document-index.ts`
  → `indexDocument`); the message carries ids only. `ingestText` enqueues it for texts over 50
  chunks. `document.convert` is storage → the platform `DocumentConverter` → the same
  `indexDocument`; a `ConversionFailedError` is permanent (row `failed`, acked), a missing storage
  or a storage/provider error throws (`../services/ai/CLAUDE.md`)
