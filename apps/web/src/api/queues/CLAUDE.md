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
  work in `withAgentTrace(..., { kind: 'job', spanName: 'job <type>' })`. Each message gets its own
  DB client, closed in `finally`
- **Never `waitUntil` in a consumer — await everything.** A handler that throws is retried, one that
  returns is acked
- Poison policy: an envelope that fails `jobEnvelopeSchema` is logged and **`ack()`ed** (retrying
  cannot make it valid). Handler error → `retry({ delaySeconds: backoffSeconds(attempts) })`, 30 s
  doubling to a 15 min cap — but the queue's policy (same curve, jittered up to 2×, 3 retries, then
  `rocketpod-jobs-dlq`) picks the actual delay, so `retry()`'s figure is a floor. Unknown queue →
  `ackAll()`
- Missing jobs queue → `JobsQueueNotConfiguredError` (503 `jobs_not_configured`), never a silent
  inline fallback

## The kit's jobs

- Queued in the kit: `tenant.purge`, invitation (create/bulk/resend) and access-request-decided
  emails (`email.send`), `activity.record`, `document.index`, `document.convert`, `chat.compact`,
  `event.deliver`. The **magic-link email stays inline** — a person is waiting on it
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
