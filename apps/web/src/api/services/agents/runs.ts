/**
 * `agent_runs` lifecycle service:
 *   enqueueRun  — validate input → (an active run already holds this run's exclusive SLOT — the
 *                 tenant for an `exclusive` agent, or the caller's `concurrencyKey`? return it,
 *                 `deduplicated`) → the tenant's active-run cap (429 `agent_runs_limit`) and daily
 *                 spend (429 `ai_budget_exceeded`) → insert `queued` with the slot (the partial
 *                 unique index rejects a second active run in it → the existing one) →
 *                 `platform.runs.create({ id: runId })` → store `instanceId`. No run engine →
 *                 `AgentRunsNotConfiguredError` (503) BEFORE any write. An `idempotencyKey` derives
 *                 the run id from (tenant, agent, key), so a second call — a redelivered job —
 *                 answers the run the first one started, whatever its status, `deduplicated`.
 *   enqueueRunBatch — up to `AGENT_RUN_BATCH_MAX` inputs of ONE non-exclusive agent, one
 *                 multi-row insert sharing a `batch_id`, then one engine `create()` per run (the
 *                 engine has no batch call); only the inputs that really cannot start are marked
 *                 failed.
 *   claimRun    — `UPDATE … SET running, attempt+1 WHERE status IN (queued,running) RETURNING`:
 *                 the row is the idempotency gate; a retried step re-claims, a settled row is a no-op.
 *   requestCancel — queued → `cancelled` outright; running → `cancelRequestedAt` (the run polls).
 *   reconcileRun — on read: an active row whose instance is `not_found|errored|terminated|complete`
 *                 is stale → settle it. `not_found` is an ANSWER, not an error; no engine: no-op.
 *                 A caller with the run's log in hand passes `lastEventAt` and a recent row skips
 *                 the engine query entirely — see RECONCILE_LIVENESS_MS.
 *   appendEvent — durable progress row + `entity.changed { entity: 'agent-run' }` nudge (D8).
 *   loadCheckpoint / saveCheckpoint — the tool loop's resume point on `agent_runs.checkpoint`, so a
 *                 retried `execute` continues the conversation instead of replaying it. Cleared by
 *                 `settle`; an unparseable value reads as "no checkpoint", never as a failure.
 *   runOnce     — the durable-effect key (`agent_run_effects`): work that must not repeat across
 *                 attempts (an ingest, a ledger write) runs once and replays its recorded result.
 * Every query carries the tenant predicate; `runId` alone is never trusted.
 */
import type {
  AgentKey,
  AgentRun,
  AgentRunEvent,
  AgentRunEventType,
} from '@rocketpod/shared/ai/agents'
import {
  ACTIVE_RUN_STATUSES,
  AGENT_RESUME_EVENT,
  CLAIMABLE_RUN_STATUSES,
} from '@rocketpod/shared/ai/agents'
import { ERROR_CODES } from '@rocketpod/shared/errors'
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import { type Database, isUniqueViolation, rows } from '../../../db/client'
import {
  type AgentRunEventRow,
  type AgentRunRow,
  agentRunEffects,
  agentRunEvents,
  agentRuns,
} from '../../../db/schema'
import type { RunEngine, RunStatus } from '../../../platform/types'
import { traceIdForRun } from '../../observability/trace-ids'
import {
  ApiError,
  BadRequestError,
  ServiceUnavailableError,
  ValidationError,
} from '../../utils/core/errors'
import { parseToolLoopCheckpoint, type ToolLoopCheckpoint } from '../ai/agent-loop'
import { nudge, type Realtime, realtimeEvent } from '../realtime'
import { assertTenantDailyBudget } from './budget'
import { expireInterrupts, listInterrupts } from './interrupts'
import { getAgent } from './registry'

/** `{ runId, tenantId }` — everything else is re-read from the row (a retry must not trust a message). */
export interface AgentRunParams {
  runId: string
  tenantId: string
}

/** The run engine the service uses (`src/platform/types.ts`); the test `RecordingWorkflow` satisfies it. */
export type AgentRunWorkflowBinding = RunEngine<AgentRunParams>

/** What the service reads from the platform (`Platform` satisfies it). */
export interface AgentRunsEnv {
  readonly runs?: RunEngine | null
}

/** 503 `agent_runs_not_configured`: the process has no run engine (a web-only bare platform). */
export class AgentRunsNotConfiguredError extends ServiceUnavailableError {
  constructor() {
    super(
      'Agent runs are not configured: this server has no run engine (the Node server builds one from DATABASE_URL — src/node/runs.ts)',
      ERROR_CODES.agentRunsNotConfigured
    )
    this.name = 'AgentRunsNotConfiguredError'
  }
}

/** Thrown inside a run when `cancelRequestedAt` is set. A TYPE, so no message can reclassify it. */
export class AgentCancelledError extends Error {
  constructor() {
    super('Agent run cancelled')
    this.name = 'AgentCancelledError'
  }
}

export function toAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentKey: row.agentKey,
    status: row.status,
    input: row.input,
    output: row.output ?? null,
    error: row.error,
    requestedByUserId: row.requestedByUserId,
    instanceId: row.instanceId,
    attempt: row.attempt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    cancelRequestedAt: row.cancelRequestedAt,
    createdAt: row.createdAt,
    exclusive: row.concurrencyKey !== null,
    batchId: row.batchId,
  }
}

export function toAgentRunEvent(row: AgentRunEventRow): AgentRunEvent {
  return { id: row.id, runId: row.runId, seq: row.seq, type: row.type, data: row.data, at: row.at }
}

/**
 * The three status lists diverge on purpose, and collapsing them back into one is how
 * a parked run gets claimed by nobody or failed by the backstop:
 *
 * - `ACTIVE` ({@link ACTIVE_RUN_STATUSES}, incl. `awaiting_input`) — "still owes an answer": the
 *   exclusive partial unique index, `findActiveRun`, `settle()` and `saveCheckpoint`. A parked run
 *   is still *the* active run for its agent, and it must remain cancellable.
 * - `CLAIMABLE` ({@link CLAIMABLE_RUN_STATUSES}) — `claimRun` ONLY. A parked row is not claimable;
 *   the resolve route flips it back to `running` before it nudges, so **the answer is the
 *   transition** and by the time any claim runs the row is `running` again.
 * - `finishStep`'s backstop keeps its own inline `queued|running` (in `runtime.ts`), because
 *   widening THAT one turns every legitimately parked run into a `failed` row.
 */
const ACTIVE = ACTIVE_RUN_STATUSES
const CLAIMABLE = CLAIMABLE_RUN_STATUSES

export async function getRun(
  db: Database,
  tenantId: string,
  runId: string
): Promise<AgentRunRow | null> {
  const row = await db.query.agentRuns.findFirst({
    where: and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)),
  })
  return row ?? null
}

/** The active run holding an exclusive slot (`''` = the agent's tenant-wide one), if any. */
export async function findActiveRun(
  db: Database,
  tenantId: string,
  agentKey: AgentKey,
  concurrencyKey = ''
): Promise<AgentRunRow | null> {
  const row = await db.query.agentRuns.findFirst({
    where: and(
      eq(agentRuns.tenantId, tenantId),
      eq(agentRuns.agentKey, agentKey),
      eq(agentRuns.concurrencyKey, concurrencyKey),
      inArray(agentRuns.status, [...ACTIVE])
    ),
  })
  return row ?? null
}

export interface EnqueueRunInput {
  tenantId: string
  agentKey: AgentKey
  input: unknown
  userId: string | null
  realtime?: Realtime
  /**
   * The exclusive slot, narrowed: at most one ACTIVE run per (tenant, agent, key), whatever the
   * agent's `exclusive` flag says. Omitted, an `exclusive` agent holds ONE slot per tenant and a
   * non-exclusive one none — it runs freely. One run per document, say: `document:<id>`.
   */
  concurrencyKey?: string
  /**
   * At most one run EVER per (tenant, agent, key) — not just one active one. The run id is derived
   * from the three (`idempotentRunId`), so the primary key is the gate: a second call returns the
   * first call's run, settled or not, with `deduplicated: true`. What a background caller passes
   * so a redelivered message cannot start the same work twice.
   */
  idempotencyKey?: string
}

export interface EnqueueRunResult {
  run: AgentRunRow
  /**
   * An active run already held this run's exclusive slot; `run` is THAT run. Never true for a
   * non-exclusive agent enqueued without a `concurrencyKey`: it holds no slot, so every enqueue
   * is a run of its own.
   */
  deduplicated: boolean
}

/** 429 `agent_runs_limit`: the tenant has `AGENT_MAX_ACTIVE_RUNS_PER_TENANT` runs active already. */
export class AgentRunsLimitError extends ApiError {
  constructor(active: number, max: number) {
    super(
      429,
      `This organisation already has ${active} agent runs queued, running or waiting (the limit is ${max})`,
      ERROR_CODES.agentRunsLimit,
      { active, max }
    )
    this.name = 'AgentRunsLimitError'
  }
}

/** 400 `agent_exclusive`: a batch names an agent that runs one at a time. */
export class AgentExclusiveError extends BadRequestError {
  constructor(agentKey: AgentKey) {
    super(
      `${agentKey} is exclusive — one run at a time per organisation — so it cannot be batched`,
      ERROR_CODES.agentExclusive,
      { agentKey }
    )
    this.name = 'AgentExclusiveError'
  }
}

/**
 * The run id an `idempotencyKey` stands for: SHA-256 of (tenant, agent, key), shaped as a version-8
 * UUID. Deterministic, so the same three always name the same row and the same engine run.
 */
export async function idempotentRunId(
  tenantId: string,
  agentKey: string,
  idempotencyKey: string
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`agent-run\u0000${tenantId}\u0000${agentKey}\u0000${idempotencyKey}`)
  )
  const bytes = new Uint8Array(digest).slice(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Runs the tenant has queued, running or parked — what the concurrency cap counts. */
export async function countActiveRuns(db: Database, tenantId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(agentRuns)
    .where(and(eq(agentRuns.tenantId, tenantId), inArray(agentRuns.status, [...ACTIVE])))
  return row?.n ?? 0
}

/**
 * The two tenant-wide gates every enqueue passes: the active-run cap, counting the runs this
 * call would ADD, and the daily agent spend. Both are counted then inserted, not locked — a burst
 * of simultaneous requests can overshoot the cap by a few, which is fine for a brake.
 */
async function assertCapacity(db: Database, cfg: AppConfig, tenantId: string, adding: number) {
  const active = await countActiveRuns(db, tenantId)
  if (active + adding > cfg.AGENT_MAX_ACTIVE_RUNS_PER_TENANT) {
    throw new AgentRunsLimitError(active, cfg.AGENT_MAX_ACTIVE_RUNS_PER_TENANT)
  }
  await assertTenantDailyBudget(db, cfg, tenantId)
}

/**
 * Validate → (exclusive: return the active run) → capacity → insert `queued` → create the run
 * instance (id = run id) → store `instanceId`. A `create()` failure marks the row `failed`
 * (visible, releases the exclusive slot) and rethrows.
 *
 * An exclusive agent's active run is looked for BEFORE the capacity check, so asking again for a
 * run that is already going is never a 429; the unique index still decides a genuine race.
 *
 * With an `idempotencyKey` the derived run's row is looked for first of all (after validation), and
 * a hit is the answer. A hit still `queued` with no instance — the caller that inserted it died
 * before `create()`, or is mid-call — gets its engine run created here: the engine's `create` is
 * idempotent on the run id, so a racing creator lands on the same run. A `create()` failure
 * DELETES an idempotent row instead of failing it, because a failed row under the derived id
 * would answer every retry with "deduplicated" and the work would never run.
 */
export async function enqueueRun(
  db: Database,
  cfg: AppConfig,
  env: AgentRunsEnv,
  input: EnqueueRunInput
): Promise<EnqueueRunResult> {
  const workflow = env.runs
  if (!workflow) throw new AgentRunsNotConfiguredError()
  const agent = getAgent(input.agentKey)
  const parsed = agent.meta.inputSchema.safeParse(input.input)
  if (!parsed.success) throw new ValidationError(parsed.error.issues, 'Invalid agent input')
  const concurrencyKey = input.concurrencyKey ?? (agent.meta.exclusive ? '' : null)
  const runId = input.idempotencyKey
    ? await idempotentRunId(input.tenantId, input.agentKey, input.idempotencyKey)
    : crypto.randomUUID()

  if (input.idempotencyKey) {
    const existing = await getRun(db, input.tenantId, runId)
    if (existing) {
      return {
        run: await ensureInstance(db, workflow, existing, input.tenantId),
        deduplicated: true,
      }
    }
  }
  if (concurrencyKey !== null) {
    const existing = await findActiveRun(db, input.tenantId, input.agentKey, concurrencyKey)
    if (existing) return { run: existing, deduplicated: true }
  }
  await assertCapacity(db, cfg, input.tenantId, 1)

  let row: AgentRunRow | undefined
  try {
    ;[row] = await db
      .insert(agentRuns)
      .values({
        // Minted here rather than by the column default so the trace id — derived from it —
        // is on the row from the first write.
        id: runId,
        traceId: traceIdForRun(runId),
        tenantId: input.tenantId,
        agentKey: input.agentKey,
        status: 'queued',
        input: parsed.data,
        requestedByUserId: input.userId,
        concurrencyKey,
      })
      .returning()
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    if (input.idempotencyKey) {
      // A concurrent call with the same key inserted first — its row is the answer.
      const same = await getRun(db, input.tenantId, runId)
      if (same) return { run: same, deduplicated: true }
    }
    if (concurrencyKey === null) throw err
    const existing = await findActiveRun(db, input.tenantId, input.agentKey, concurrencyKey)
    if (!existing) throw err // the slot freed between the insert and the read — a retry will win
    return { run: existing, deduplicated: true }
  }
  if (!row) throw new Error('agent_runs: insert returned no row')

  try {
    const instance = await workflow.create({
      id: row.id,
      params: { runId: row.id, tenantId: input.tenantId },
    })
    row = (await storeInstanceId(db, input.tenantId, row.id, instance.id)) ?? row
  } catch (err) {
    if (input.idempotencyKey) {
      // Leave nothing under the derived id, so the caller's retry starts the run afresh.
      await db
        .delete(agentRuns)
        .where(and(eq(agentRuns.id, row.id), eq(agentRuns.tenantId, input.tenantId)))
    } else {
      await failRun(
        db,
        input.tenantId,
        row.id,
        `Could not start the workflow: ${errorMessage(err)}`
      )
    }
    throw err
  }
  nudgeRun(input.realtime, input.tenantId, row.id)
  return { run: row, deduplicated: false }
}

/**
 * An idempotent hit that never got its engine run (`queued`, no `instanceId`): create it now. The
 * engine's `create` is idempotent on the run id, so a racing creator lands on the same run.
 */
async function ensureInstance(
  db: Database,
  workflow: RunEngine,
  row: AgentRunRow,
  tenantId: string
): Promise<AgentRunRow> {
  if (row.instanceId || row.status !== 'queued') return row
  const instance = await workflow.create({ id: row.id, params: { runId: row.id, tenantId } })
  return (await storeInstanceId(db, tenantId, row.id, instance.id)) ?? row
}

async function storeInstanceId(
  db: Database,
  tenantId: string,
  runId: string,
  instanceId: string
): Promise<AgentRunRow | undefined> {
  const [updated] = await db
    .update(agentRuns)
    .set({ instanceId })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)))
    .returning()
  return updated
}

export interface EnqueueBatchInput {
  tenantId: string
  agentKey: AgentKey
  inputs: unknown[]
  userId: string | null
  realtime?: Realtime
}

/** One input's fate — `row` whenever a row exists, `error` whenever it did not start. */
export interface EnqueueBatchItem {
  index: number
  row: AgentRunRow | null
  error: { code: string; message: string; details?: unknown } | null
}

export interface EnqueueBatchResult {
  batchId: string
  items: EnqueueBatchItem[]
}

/**
 * Many runs of ONE non-exclusive agent. The order of the gates is the contract:
 *
 * 1. no run engine → 503; an exclusive agent → 400 `agent_exclusive` (it can only ever run one)
 * 2. every input is validated against the agent's schema; an invalid one is an item error with no
 *    row, and the rest carry on
 * 3. capacity for the VALID inputs only → 429 for the whole batch (never half a batch)
 * 4. ONE multi-row insert, all sharing a fresh `batch_id`
 * 5. one `create()` per row — the engine has no batch call, and its `create` is idempotent on the
 *    run id, so a retry of a call that half-landed starts nothing twice. Only the rows whose
 *    `create()` really fails are settled `failed`; the rest are queued
 */
export async function enqueueRunBatch(
  db: Database,
  cfg: AppConfig,
  env: AgentRunsEnv,
  input: EnqueueBatchInput
): Promise<EnqueueBatchResult> {
  const workflow = env.runs
  if (!workflow) throw new AgentRunsNotConfiguredError()
  const agent = getAgent(input.agentKey)
  if (agent.meta.exclusive) throw new AgentExclusiveError(input.agentKey)

  const batchId = crypto.randomUUID()
  const items: EnqueueBatchItem[] = []
  const valid: { index: number; data: unknown }[] = []
  input.inputs.forEach((raw, index) => {
    const parsed = agent.meta.inputSchema.safeParse(raw)
    if (parsed.success) valid.push({ index, data: parsed.data })
    else {
      items.push({
        index,
        row: null,
        error: {
          code: ERROR_CODES.validationFailed,
          message: 'Invalid agent input',
          details: parsed.error.issues,
        },
      })
    }
  })
  if (valid.length === 0) return { batchId, items }
  await assertCapacity(db, cfg, input.tenantId, valid.length)

  const ids = valid.map(() => crypto.randomUUID())
  const inserted = await db
    .insert(agentRuns)
    .values(
      valid.map((v, i) => ({
        id: ids[i] as string,
        traceId: traceIdForRun(ids[i] as string),
        tenantId: input.tenantId,
        agentKey: input.agentKey,
        status: 'queued' as const,
        input: v.data,
        requestedByUserId: input.userId,
        batchId,
      }))
    )
    .returning()
  // Matched by the ids minted above, not by position: nothing promises `RETURNING`'s order.
  const byId = new Map(inserted.map(row => [row.id, row]))
  const rowsInOrder = valid.map((v, i) => {
    const row = byId.get(ids[i] as string)
    if (!row) throw new Error('agent_runs: batch insert returned fewer rows than it was given')
    return { index: v.index, row }
  })

  for (const entry of rowsInOrder) {
    let instanceId: string | undefined
    let failure: string | null = null
    try {
      instanceId = (
        await workflow.create({
          id: entry.row.id,
          params: { runId: entry.row.id, tenantId: input.tenantId },
        })
      ).id
    } catch (err) {
      failure = errorMessage(err)
    }
    if (instanceId) {
      const row = (await storeInstanceId(db, input.tenantId, entry.row.id, instanceId)) ?? entry.row
      items.push({ index: entry.index, row, error: null })
      nudgeRun(input.realtime, input.tenantId, row.id)
      continue
    }
    const message = `Could not start the workflow: ${failure}`
    const row = (await failRun(db, input.tenantId, entry.row.id, message)) ?? entry.row
    items.push({
      index: entry.index,
      row,
      error: { code: 'workflow_create_failed', message: message.slice(0, 500) },
    })
  }
  items.sort((a, b) => a.index - b.index)
  return { batchId, items }
}

/**
 * The claim: queued|running → running, `attempt + 1`, `startedAt` kept from the first claim.
 * Returns the row, or null when it is already terminal (cancelled while queued, or settled by an
 * earlier attempt) — the caller skips.
 */
export async function claimRun(
  db: Database,
  tenantId: string,
  runId: string
): Promise<AgentRunRow | null> {
  const [row] = await db
    .update(agentRuns)
    .set({
      status: 'running',
      startedAt: sql`coalesce(${agentRuns.startedAt}, now())`,
      attempt: sql`${agentRuns.attempt} + 1`,
    })
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.tenantId, tenantId),
        inArray(agentRuns.status, [...CLAIMABLE])
      )
    )
    .returning()
  return row ?? null
}

/**
 * Terminal transitions only ever apply to an ACTIVE row — a settled run is never rewritten. Every
 * lifecycle timestamp is the DATABASE clock (`now()`), like `startedAt` in `claimRun`: a worker
 * process's `Date` can sit behind Postgres, and `finishedAt < startedAt` is not a row we want.
 */
async function settle(
  db: Database,
  tenantId: string,
  runId: string,
  patch: Partial<Pick<AgentRunRow, 'status' | 'output' | 'error'>>
): Promise<AgentRunRow | null> {
  const [row] = await db
    .update(agentRuns)
    // The checkpoint is scratch space for a retry, so a settled run drops it: nothing will resume,
    // and a verbatim model transcript should not sit in the table for the life of the row.
    .set({ ...patch, finishedAt: sql`now()`, checkpoint: null })
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.tenantId, tenantId),
        inArray(agentRuns.status, [...ACTIVE])
      )
    )
    .returning()
  return row ?? null
}

export function finishRun(db: Database, tenantId: string, runId: string, output: unknown) {
  return settle(db, tenantId, runId, { status: 'succeeded', output, error: null })
}

export function failRun(db: Database, tenantId: string, runId: string, error: string) {
  return settle(db, tenantId, runId, { status: 'failed', error: error.slice(0, 2000) })
}

export function cancelRun(db: Database, tenantId: string, runId: string) {
  return settle(db, tenantId, runId, { status: 'cancelled', error: null })
}

/**
 * Park a run on a human decision: `running → awaiting_input`.
 *
 * **This is deliberately NOT `settle()`** — `finishedAt` stays NULL and, above all, **the
 * checkpoint survives**, which is the entire reason a resume is cheap: the resumed `execute` step
 * picks the transcript back up at the turn that asked instead of replaying and re-paying for every
 * turn before it. `settle()` nulls the checkpoint, because for a terminal run it is scratch space.
 *
 * Returns null when the row was not `running` — cancelled from outside while the step was raising,
 * most likely — and the caller reports what the row says rather than what it intended.
 */
export async function parkRun(
  db: Database,
  tenantId: string,
  runId: string
): Promise<AgentRunRow | null> {
  const [row] = await db
    .update(agentRuns)
    .set({ status: 'awaiting_input' })
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.tenantId, tenantId),
        eq(agentRuns.status, 'running')
      )
    )
    .returning()
  return row ?? null
}

/**
 * Un-park a run: `awaiting_input → running`, compare-and-set. **The answer IS the transition**:
 * the resolve route calls this BEFORE it nudges or restarts the instance, which is
 * what lets `claimRun` keep its narrow `queued|running` predicate — a restarted instance's `claim`
 * step finds a `running` row because somebody answered, and finds nothing when nobody did.
 *
 * Null means the row was not parked: 409 `run_not_awaiting_input`.
 */
export async function resumeRun(
  db: Database,
  tenantId: string,
  runId: string
): Promise<AgentRunRow | null> {
  const [row] = await db
    .update(agentRuns)
    .set({ status: 'running' })
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.tenantId, tenantId),
        eq(agentRuns.status, 'awaiting_input')
      )
    )
    .returning()
  return row ?? null
}

/**
 * Ask a run to stop. Queued → `cancelled` at once (the claim then finds nothing). Running → set
 * the flag; the run's `checkCancelled()` sees it between turns (a step in flight finishes).
 * Terminal → unchanged. Returns the row as it now is, or null if unknown in this tenant.
 */
/**
 * Cancel a run, escalating on the second ask.
 *
 * - `queued` → `cancelled` outright (nothing is executing yet).
 * - `running`, first ask → set `cancelRequestedAt`; the run polls it between turns and settles
 *   itself, which is the graceful path (the transcript and events stay coherent).
 * - `running`, asked AGAIN → **force**: terminate the run instance and settle the row here.
 *   Cooperative cancellation only works while something is still polling, and a run whose model
 *   call hangs, whose instance was orphaned (a reset dev database) or whose step died between
 *   polls would otherwise sit in `running` with "Cancelling…" forever, with no way out short of
 *   SQL. The second click is the way out; a terminate failure (already gone, no engine) does not
 *   stop the row being settled — the row is the truth.
 */
export async function requestCancel(
  db: Database,
  tenantId: string,
  runId: string,
  realtime?: Realtime,
  env?: AgentRunsEnv
): Promise<AgentRunRow | null> {
  const row = await getRun(db, tenantId, runId)
  if (!row) return null
  // `queued` and `awaiting_input` are the two states where nothing is executing, so both settle
  // outright rather than waiting for a poll that will never come: a parked instance is asleep on
  // `step.waitForEvent` and polls nothing at all.
  if (row.status === 'queued' || row.status === 'awaiting_input') {
    const [updated] = await db
      .update(agentRuns)
      .set({ status: 'cancelled', cancelRequestedAt: sql`now()`, finishedAt: sql`now()` })
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.tenantId, tenantId),
          eq(agentRuns.status, row.status)
        )
      )
      .returning()
    if (row.status === 'awaiting_input') {
      // A question whose run is over must not sit in somebody's inbox, and the sleeping instance
      // has to be woken or it holds its seven-day `waitForEvent` for nothing — it wakes, reads a
      // settled row and exits. Both are best-effort: the ROW is the truth.
      await expireInterrupts(db, tenantId, runId)
      await sendResumeEvent(env, updated ?? row, { interruptId: null })
    }
    nudgeRun(realtime, tenantId, runId)
    return updated ?? getRun(db, tenantId, runId)
  }
  if (row.status !== 'running') return row

  if (!row.cancelRequestedAt) {
    const [updated] = await db
      .update(agentRuns)
      .set({ cancelRequestedAt: sql`now()` })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)))
      .returning()
    nudgeRun(realtime, tenantId, runId)
    return updated ?? row
  }

  await terminateInstance(env, row)
  const settled = (await cancelRun(db, tenantId, runId)) ?? row
  nudgeRun(realtime, tenantId, runId)
  return settled
}

/** Best-effort kill of the run's engine instance. Every failure is ignored on purpose. */
async function terminateInstance(env: AgentRunsEnv | undefined, run: AgentRunRow): Promise<void> {
  if (!env?.runs || !run.instanceId) return
  try {
    await (await env.runs.get(run.instanceId)).terminate()
  } catch {
    // Already terminated, already finished, or gone with the local dev server: settle anyway.
  }
}

// ---- Suspend / resume -----------------------------------------------------------------------

/** Best-effort wake of a parked instance. Returns false when it could not be delivered. */
async function sendResumeEvent(
  env: AgentRunsEnv | undefined,
  run: AgentRunRow,
  payload: { interruptId: string | null }
): Promise<boolean> {
  if (!env?.runs || !run.instanceId) return false
  try {
    const instance = await env.runs.get(run.instanceId)
    await instance.sendEvent({ type: AGENT_RESUME_EVENT, payload })
    return true
  } catch {
    return false
  }
}

/**
 * The instance id a restart should take: `<runId>` → `<runId>-r1` → `<runId>-r2`.
 *
 * Hyphen, not colon: a colon is not a documented-legal instance-id character, while a uuid
 * already proves hyphens are, and 36 + 3 is comfortably inside the 64-character limit.
 */
export function nextInstanceId(runId: string, current: string | null): string {
  const match = current && current.startsWith(`${runId}-r`) ? /-r(\d+)$/.exec(current) : null
  const round = match?.[1] ? Number(match[1]) + 1 : 1
  return `${runId}-r${round}`
}

/**
 * Wake the parked run, and **create a new instance when the old one is gone**.
 *
 * `instance.not_found` is an ANSWER, not an error — the same reading `reconcileRun` already takes.
 * An instance can disappear from under its row: the `openworkflow` schema was reset (a fresh dev
 * database) or its rows were deleted. Without this branch such a park could never be
 * resumed, which is the worst outcome this feature has: an answered question, a run that never
 * hears it, and the exclusive slot held forever.
 *
 * **The coupling to hold in your head:** the new instance's first step is `claim`, and `claimRun`
 * only takes `queued|running`. It succeeds solely because the caller already flipped the row with
 * {@link resumeRun} — *the answer is the transition*. Call this AFTER that, never
 * before.
 *
 * `agent_runs.instanceId` therefore becomes *the latest* instance rather than "the run id"; it
 * stays `unique()`, so a probe still maps back 1:1.
 */
export async function nudgeOrRestartInstance(
  db: Database,
  env: AgentRunsEnv,
  run: AgentRunRow,
  payload: { interruptId: string | null }
): Promise<AgentRunRow> {
  const workflow = env.runs
  if (!workflow) return run
  if (run.instanceId && (await sendResumeEvent(env, run, payload))) return run

  // Either there was no instance to send to, or it is gone. Seed a fresh one from the ROW — never
  // from a message — and try a couple of ids in case an earlier attempt already made one.
  let lastError: unknown
  let candidate = nextInstanceId(run.id, run.instanceId)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const instance = await workflow.create({
        id: candidate,
        params: { runId: run.id, tenantId: run.tenantId },
      })
      const [updated] = await db
        .update(agentRuns)
        .set({ instanceId: instance.id })
        .where(and(eq(agentRuns.id, run.id), eq(agentRuns.tenantId, run.tenantId)))
        .returning()
      return updated ?? run
    } catch (err) {
      lastError = err
      candidate = nextInstanceId(run.id, candidate)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('agent-run: could not restart instance')
}

/**
 * The read-path safety net for a park whose instance no longer exists. Lives here, beside
 * {@link reconcileRun}, because it settles a run — and is called from the same place, on read.
 *
 * A parked run whose asks have **all passed their deadline** settles `cancelled` with `error` NULL:
 * nobody answered, and the `waitForEvent` that would have expired it died with its instance.
 *
 * A park with **no pending asks at all is left alone**. That state is not "unreachable" — it is the
 * window between the resolve route's write and the `resumeRun` that follows it, and settling a run
 * somebody has just answered would be a far worse bug than a stale-looking row for a few
 * milliseconds.
 */
export async function expireParkedRun(
  db: Database,
  run: AgentRunRow,
  realtime?: Realtime,
  now: Date = new Date()
): Promise<AgentRunRow> {
  if (run.status !== 'awaiting_input') return run
  const pending = await listInterrupts(db, run.tenantId, run.id, 'pending')
  if (pending.length === 0) return run
  // One ask without a deadline, or one still in date, is a run that is legitimately waiting.
  if (pending.some(row => !row.expiresAt || row.expiresAt.getTime() > now.getTime())) return run
  await expireInterrupts(db, run.tenantId, run.id)
  const settled = (await cancelRun(db, run.tenantId, run.id)) ?? run
  nudgeRun(realtime, run.tenantId, run.id)
  return settled
}

/** `true` when a cancel was requested for the run — the poll a run makes between turns. */
export async function isCancelRequested(
  db: Database,
  tenantId: string,
  runId: string
): Promise<boolean> {
  const row = await db.query.agentRuns.findFirst({
    columns: { cancelRequestedAt: true, status: true },
    where: and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)),
  })
  return !row || row.cancelRequestedAt !== null || row.status === 'cancelled'
}

/** `instance.not_found` and friends — a definite "nothing is running", not a lookup failure. */
export function isMissingInstanceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not_found|not found|does not exist|no such instance/i.test(message)
}

/**
 * How recently a run must have written a durable event for {@link reconcileRun} to take its word
 * for it and ask the runtime nothing at all.
 *
 * 30 s is chosen from both ends. It is far longer than the gap between rows in a healthy run — a
 * tool call, a step boundary and a model turn all land inside a few seconds — so a run that is
 * genuinely working never pays for an engine query. And it is far shorter than any stall a person
 * would notice, so a crashed instance is still detected on the read after the window lapses.
 *
 * The one case that legitimately emits nothing for minutes — a single long `execute` step — falls
 * straight through to a real reconcile, which is correct: `'waiting'` and the default arm both
 * return the row untouched, so a slow step is never mistaken for a dead one.
 */
export const RECONCILE_LIVENESS_MS = 30_000

/**
 * Reconcile an ACTIVE row against the run engine on read. The row is truth for anything the
 * runtime still owns; when the runtime says the instance is gone or finished while the row says
 * active, the row is stale (a crash between steps, a terminated instance) and is settled here.
 * No engine, no instance id, or an unreachable engine → the row is returned untouched.
 *
 * **`lastEventAt` is the liveness proof, and it is opt-in per call site.** This function costs a
 * run-engine `instance.status()` query every time, and the run page re-reads a run on *every*
 * new `seq` the stream reports — so on a bursty run that is an engine query several times a
 * second per viewer, to ask whether a run that wrote a durable event two seconds ago is still
 * alive. It manifestly is. A caller that already has the run's events to hand passes the newest
 * one's timestamp and the engine is not touched; a caller that has none passes nothing and
 * behaves exactly as it always did. The whole cost of the guard is that a genuinely dead
 * instance is detected up to {@link RECONCILE_LIVENESS_MS} later than it would have been.
 */
export async function reconcileRun(
  db: Database,
  env: AgentRunsEnv,
  run: AgentRunRow,
  options: { lastEventAt?: Date | null } = {}
): Promise<AgentRunRow> {
  if (run.status !== 'queued' && run.status !== 'running') return run
  const lastEventAt = options.lastEventAt
  if (lastEventAt && Date.now() - lastEventAt.getTime() < RECONCILE_LIVENESS_MS) return run
  if (!env.runs || !run.instanceId) return run
  let status: RunStatus
  try {
    status = await (await env.runs.get(run.instanceId)).status()
  } catch (err) {
    if (!isMissingInstanceError(err)) return run
    return (await failRun(db, run.tenantId, run.id, 'Workflow instance not found')) ?? run
  }
  switch (status.status) {
    // A `waiting` instance is parked on `step.waitForEvent` and is exactly where it should be. The
    // default arm already returns the row, but saying it explicitly is the difference between
    // correct-by-accident and correct-on-purpose: it is the ONE runtime status that looks idle and
    // is not, and settling it would strand the answer somebody is about to give.
    case 'waiting':
      return run
    // `terminated` is what a forced cancel leaves behind — settle it as cancelled, not failed.
    case 'terminated':
      return (await cancelRun(db, run.tenantId, run.id)) ?? run
    case 'errored': {
      const reason = status.error?.message ?? 'Workflow instance errored'
      return (await failRun(db, run.tenantId, run.id, reason)) ?? run
    }
    case 'complete':
      return (await finishRun(db, run.tenantId, run.id, run.output ?? null)) ?? run
    default:
      return run
  }
}

// ---- Events ---------------------------------------------------------------------------------------

/** The realtime nudge every run mutation ends with. The client re-queries; the payload is an id. */
export function nudgeRun(realtime: Realtime | undefined, tenantId: string, runId: string): void {
  nudge(realtime, realtimeEvent('entity.changed', tenantId, { entity: 'agent-run', id: runId }))
}

/**
 * The nudge for the ASKS of a run, distinct from the run's own. It exists so a screen
 * that only watches the inbox — the "3 waiting" badge — refreshes on an answer without subscribing
 * to every progress row the runtime writes, which is most of them.
 */
export function nudgeInterrupts(
  realtime: Realtime | undefined,
  tenantId: string,
  runId: string
): void {
  nudge(
    realtime,
    realtimeEvent('entity.changed', tenantId, { entity: 'agent-interrupt', id: runId })
  )
}

/** `max(seq)` for a run — the writer continues numbering from here across attempts. */
export async function lastEventSeq(db: Database, tenantId: string, runId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${agentRunEvents.seq})` })
    .from(agentRunEvents)
    .where(and(eq(agentRunEvents.tenantId, tenantId), eq(agentRunEvents.runId, runId)))
  return Number(row?.max ?? 0)
}

export async function appendEvent(
  db: Database,
  input: {
    tenantId: string
    runId: string
    seq: number
    type: AgentRunEventType
    data: unknown
    realtime?: Realtime
  }
): Promise<AgentRunEventRow> {
  const [row] = await db
    .insert(agentRunEvents)
    .values({
      tenantId: input.tenantId,
      runId: input.runId,
      seq: input.seq,
      type: input.type,
      data: input.data ?? {},
    })
    .returning()
  if (!row) throw new Error('agent_run_events: insert returned no row')
  nudgeRun(input.realtime, input.tenantId, input.runId)
  return row
}

/**
 * Append an event whose `seq` is computed **in SQL**, retrying once on the unique violation.
 *
 * `createEmitter` keeps an in-memory counter, which is correct while a run step is the only
 * writer — and stops being correct the moment a steering route writes to the same run while a step
 * is emitting. `agent_run_events_run_seq_idx` rejects the loser, so either the note or a progress
 * row would be silently dropped. Here the number comes from `max(seq) + 1` inside the INSERT, and
 * a genuine race is one retry rather than a lost row.
 *
 * It is not the hot path: the emitter's counter is still what a step uses for its own stream.
 */
export async function appendEventAtomic(
  db: Database,
  input: {
    tenantId: string
    runId: string
    type: AgentRunEventType
    data: unknown
    realtime?: Realtime
  }
): Promise<AgentRunEventRow> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // `db.execute` hands back RAW column names (no drizzle mapping, either driver), so every
      // column is aliased to the field the row type declares rather than selected with `*`.
      const result = await db.execute(sql`
        insert into ${agentRunEvents} (run_id, tenant_id, seq, type, data)
        select ${input.runId}::uuid, ${input.tenantId}::uuid,
               coalesce(max(${agentRunEvents.seq}), 0) + 1,
               ${input.type}, ${JSON.stringify(input.data ?? {})}::jsonb
          from ${agentRunEvents}
         where ${agentRunEvents.runId} = ${input.runId}::uuid
           and ${agentRunEvents.tenantId} = ${input.tenantId}::uuid
        returning id, run_id as "runId", tenant_id as "tenantId", seq, type, data, at
      `)
      const row = rows<AgentRunEventRow>(result)[0]
      if (!row) throw new Error('agent_run_events: insert returned no row')
      nudgeRun(input.realtime, input.tenantId, input.runId)
      return { ...row, seq: Number(row.seq), at: new Date(row.at) }
    } catch (err) {
      if (attempt === 1 || !isUniqueViolation(err)) throw err
    }
  }
  throw new Error('agent_run_events: could not allocate a sequence number')
}

export async function listEvents(
  db: Database,
  tenantId: string,
  runId: string
): Promise<AgentRunEventRow[]> {
  return db
    .select()
    .from(agentRunEvents)
    .where(and(eq(agentRunEvents.tenantId, tenantId), eq(agentRunEvents.runId, runId)))
    .orderBy(asc(agentRunEvents.seq))
}

// ---- Resume: the checkpoint and the effect ledger -------------------------------------------

/**
 * The tool loop's resume point for this run, or null when there is none — including when the stored
 * value does not parse. **A bad checkpoint must never fail a run**: an older build's shape, or a
 * corrupted row, costs one replayed attempt, which is exactly what happened before checkpoints
 * existed. Never widen this to a throw.
 */
export async function loadCheckpoint(
  db: Database,
  tenantId: string,
  runId: string
): Promise<ToolLoopCheckpoint | null> {
  const [row] = await db
    .select({ checkpoint: agentRuns.checkpoint })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)))
  if (!row?.checkpoint) return null
  return parseToolLoopCheckpoint(row.checkpoint)
}

/** Store the resume point. Only ever writes to an ACTIVE row — a settled run stays settled. */
export async function saveCheckpoint(
  db: Database,
  tenantId: string,
  runId: string,
  checkpoint: ToolLoopCheckpoint
): Promise<void> {
  await db
    .update(agentRuns)
    .set({ checkpoint })
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.tenantId, tenantId),
        inArray(agentRuns.status, [...ACTIVE])
      )
    )
}

/**
 * Run `fn` at most once per `(run, key)` across every attempt of this run, replaying the recorded
 * result afterwards — the durable-effect key. `agent_run_effects_run_key_idx` IS the guarantee, so
 * two processes racing the same key cannot both record: the loser re-reads the winner's value.
 *
 * The contract is at-least-once WITH a recorded result, not exactly-once — a process that dies
 * between `fn()` returning and the insert committing repeats the work. `result` is stored as jsonb,
 * so return ids and scalars, never rows with dates in them.
 */
export async function runOnce<T>(
  db: Database,
  tenantId: string,
  runId: string,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const recorded = await readEffect<T>(db, tenantId, runId, key)
  if (recorded) return recorded.result
  const result = await fn()
  const [inserted] = await db
    .insert(agentRunEffects)
    .values({ tenantId, runId, key, result: result ?? null })
    .onConflictDoNothing({ target: [agentRunEffects.runId, agentRunEffects.key] })
    .returning()
  if (inserted) return result
  // Lost the race: the other writer's value is the one every later attempt will read, so use it.
  return (await readEffect<T>(db, tenantId, runId, key))?.result ?? result
}

/**
 * "Am I the first to do this?" over the same `(run_id, key)` index {@link runOnce} uses — true
 * exactly once per run and key, across every attempt and every process.
 *
 * The difference from `runOnce` is what is replayed. `runOnce` replays a recorded **result**, which
 * is what an ingest or a ledger write needs. `claimEffect` replays a **decision**, which is what
 * once-only DELIVERY needs: "has this steering note already been handed to the model?", "has this
 * park already been notified?". Wrapping those in `runOnce` would work and would store a pointless
 * jsonb `true` while reading as though the work were replayable; it is not — it already happened.
 */
export async function claimEffect(
  db: Database,
  tenantId: string,
  runId: string,
  key: string
): Promise<boolean> {
  const [row] = await db
    .insert(agentRunEffects)
    .values({ tenantId, runId, key, result: null })
    .onConflictDoNothing({ target: [agentRunEffects.runId, agentRunEffects.key] })
    .returning({ id: agentRunEffects.id })
  return Boolean(row)
}

/** Wrapped so `null`/`undefined` results are distinguishable from "not recorded". */
async function readEffect<T>(
  db: Database,
  tenantId: string,
  runId: string,
  key: string
): Promise<{ result: T } | null> {
  const [row] = await db
    .select({ result: agentRunEffects.result })
    .from(agentRunEffects)
    .where(
      and(
        eq(agentRunEffects.tenantId, tenantId),
        eq(agentRunEffects.runId, runId),
        eq(agentRunEffects.key, key)
      )
    )
  return row ? { result: row.result as T } : null
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
