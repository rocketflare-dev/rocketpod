/**
 * Cron dispatcher: tasks are registered per cron EXPRESSION and looked up by `event.cron`,
 * so adding a schedule is one entry here — the worker process schedules every expression in the
 * registry with pg-boss, once across replicas (`src/node/jobs.ts`). Every task is try/caught and
 * logged individually; one failing task never blocks the others. Config is validated the same way
 * `fetch` does. To run one expression now, call `dispatchScheduled` (the tests do).
 */
import { ACTIVE_RUN_STATUSES } from '@rocketpod/shared/ai/agents'
import { and, asc, eq, exists, inArray, isNull, lt, sql } from 'drizzle-orm'
import { type AppConfig, loadConfig } from '../config'
import { affected, type Database, openDatabase } from '../db/client'
import {
  agentRunEvents,
  agentRunInterrupts,
  agentRuns,
  agentRunTurns,
  aiSpans,
  operationLocks,
  pluginEvents,
  rateLimits,
  userSessions,
} from '../db/schema'
import { resolvePlatform } from '../platform'
import type { Platform, WaitUntil } from '../platform/types'
import { serverPlugins } from '../plugins/server'
import { pruneMagicLinkTokens } from './auth/magic-link'
import { claimReminder, notifyApprovers } from './services/agents/hitl'
import { getAgent, isAgentKey } from './services/agents/registry'
import { sweepRun } from './services/agents/runs'
import { pruneInvitationSendCounters, pruneInvitations } from './services/invitations'
import { runPruneMcp } from './services/mcp/retention'
import { prunePendingUploads } from './services/uploads/service'
import type { AppBindings } from './types'
import { type Logger, loggerFor } from './utils/core/logger'
import { pruneTenantCreationCounters } from './utils/db/tenant-helpers'

export interface TaskContext {
  env: AppBindings
  /** The runtime's capabilities (storage, jobs, realtime, AI…) — never read off `env`. */
  platform: Platform
  config: AppConfig
  db: Database
  logger: Logger
  /** `ctx.waitUntil` — for fire-and-forget side effects that must outlive the task. */
  waitUntil: (p: Promise<unknown>) => void
}

export interface ScheduledTask {
  name: string
  run(ctx: TaskContext): Promise<void>
}

export interface TaskReport {
  cron: string
  task: string
  status: 'ok' | 'failed'
  durationMs: number
  error?: unknown
}

/**
 * Expired sessions, expired/consumed magic links, expired invitations older than 30 days, the daily
 * invitation-mail and organisation-creation counters from before yesterday, and the Node
 * platform's expired rate-limit windows and abandoned operation locks.
 */
export async function runPruneExpired(db: Database) {
  const sessions = (
    await db
      .delete(userSessions)
      .where(sql`${userSessions.expiresAt} < now()`)
      .returning({ id: userSessions.id })
  ).length
  const magicLinks = await pruneMagicLinkTokens(db)
  const invitations = await pruneInvitations(db)
  const invitationSendCounters = await pruneInvitationSendCounters(db)
  const tenantCreationCounters = await pruneTenantCreationCounters(db)
  // The platform's limiter and locks: a key whose newest hit left its window, a lock whose
  // holder never released it.
  const rateLimitKeys = affected(
    await db.delete(rateLimits).where(lt(rateLimits.expiresAt, sql`now()`))
  )
  const operationLockKeys = affected(
    await db.delete(operationLocks).where(lt(operationLocks.expiresAt, sql`now()`))
  )
  return {
    sessions,
    magicLinks,
    invitations,
    invitationSendCounters,
    tenantCreationCounters,
    rateLimitKeys,
    operationLockKeys,
  }
}

/** Nightly prune of expired rows: counts are logged so the run is auditable. */
export const pruneExpired: ScheduledTask = {
  name: 'pruneExpired',
  async run({ db, logger }) {
    const counts = await runPruneExpired(db)
    logger.info(
      counts,
      'pruneExpired: removed expired sessions, magic links, invitations, rate limits and locks'
    )
  },
}

/**
 * Drop `ai_spans` older than `OBSERVABILITY_SPAN_RETENTION_DAYS`. The local trace store is
 * written on every traced request whether or not a backend is configured, so without this it grows
 * for ever.
 *
 * ONE statement for every tenant. It used to be one DELETE per tenant, ten at a time, on the belief
 * that a cross-tenant cutoff would read the whole table; it does not — Postgres answers
 * `started_at < $1` from the `(tenant_id, started_at)` index with a bitmap scan when the cutoff is
 * selective, and a sequential scan only when most rows are going anyway. Per tenant it cost
 * `tenants / 10` round trips: minutes for a large fleet over a slow link, and a cron test whose
 * time grew with the size of the suite until it timed out.
 */
export async function runPruneAiSpans(db: Database, retentionDays: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  // No `.returning()`: a first prune after a busy fortnight can be a lot of rows, and the ids are
  // not needed — both drivers report the affected count, which `affected()` reads.
  const spans = affected(await db.delete(aiSpans).where(lt(aiSpans.startedAt, cutoff)))
  return { spans, cutoff: cutoff.toISOString() }
}

/**
 * Drop the tool-loop journal (`agent_run_turns`) of runs that settled more than
 * `AGENT_TRANSCRIPT_RETENTION_DAYS` ago — after that a strict replay of the run reports a miss,
 * which is the documented trade. ONE statement across every tenant, like the span prune: a row
 * goes when it is itself older than the cutoff (the `(tenant_id, updated_at)` index) AND its run
 * settled before it. An ACTIVE run's journal is never touched however old it is — `finished_at`
 * stays NULL until the run settles, and a parked run resumes from it.
 */
export async function runPruneAgentTurns(db: Database, retentionDays: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const turns = affected(
    await db.delete(agentRunTurns).where(
      and(
        lt(agentRunTurns.updatedAt, cutoff),
        exists(
          db
            .select({ one: sql`1` })
            .from(agentRuns)
            .where(and(eq(agentRuns.id, agentRunTurns.runId), lt(agentRuns.finishedAt, cutoff)))
        )
      )
    )
  )
  return { turns, cutoff: cutoff.toISOString() }
}

/** An active run whose row has not changed for this long is checked against the runtime. */
export const SWEEP_STALE_MS = 10 * 60 * 1000
/** Runs checked per sweep: each costs one run-engine `status()` read. Oldest first. */
export const SWEEP_BATCH = 100

/**
 * Find active runs nobody has touched for {@link SWEEP_STALE_MS} — across every tenant, which is why
 * it lives here — and hand each to `sweepRun`, which settles only what the runtime says has
 * ended. The newest event time goes with each row so a run that wrote an event recently is never
 * probed. One failing row is logged and skipped: the next sweep tries it again.
 */
export async function runSweepLostRuns(
  db: Database,
  platform: Pick<Platform, 'runs'>,
  logger: Logger,
  now = new Date()
) {
  const stale = new Date(now.getTime() - SWEEP_STALE_MS)
  const candidates = await db
    .select({
      run: agentRuns,
      // Text, parsed below: a raw subquery's timestamp comes back as a string from both drivers.
      lastEventAt: sql<
        string | null
      >`(SELECT max(${agentRunEvents.at})::text FROM ${agentRunEvents} WHERE ${agentRunEvents.runId} = ${agentRuns.id})`,
    })
    .from(agentRuns)
    .where(and(inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]), lt(agentRuns.updatedAt, stale)))
    .orderBy(asc(agentRuns.updatedAt))
    .limit(SWEEP_BATCH)
  const counts = { checked: candidates.length, dispatched: 0, settled: 0, failed: 0 }
  for (const { run, lastEventAt } of candidates) {
    try {
      const at = lastEventAt ? new Date(lastEventAt) : null
      const { action } = await sweepRun(db, platform, run, { lastEventAt: at })
      if (action !== 'none') counts[action]++
    } catch (err) {
      counts.failed++
      logger.warn({ err, runId: run.id }, 'sweepLostRuns: could not check run')
    }
  }
  return counts
}

/** Reminders sent per sweep. */
export const REMIND_BATCH = 100

/**
 * Remind whoever can answer an ask that is still pending past its `remind_at`
 * (`meta.hitl.remindAfter`) — ONCE: `claimReminder` is a compare-and-set on `reminded_at`. Across
 * every tenant, which is why it lives here; each reminder then goes through the tenant-scoped
 * `notifyApprovers`. An ask of an agent no longer registered is reminded under `requester`.
 */
export async function runSendReminders(db: Database, logger: Logger, now = new Date()) {
  const due = await db
    .select({ ask: agentRunInterrupts, run: agentRuns })
    .from(agentRunInterrupts)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunInterrupts.runId))
    .where(
      and(
        eq(agentRunInterrupts.status, 'pending'),
        isNull(agentRunInterrupts.remindedAt),
        lt(agentRunInterrupts.remindAt, now)
      )
    )
    .orderBy(asc(agentRunInterrupts.remindAt))
    .limit(REMIND_BATCH)
  let sent = 0
  for (const { ask, run } of due) {
    try {
      if (!(await claimReminder(db, ask))) continue
      const meta = isAgentKey(run.agentKey) ? getAgent(run.agentKey).meta : undefined
      await notifyApprovers(
        db,
        run,
        meta?.title ?? run.agentKey,
        meta?.approvers ?? 'requester',
        ask,
        undefined,
        {
          reminder: true,
        }
      )
      sent++
    } catch (err) {
      logger.warn({ err, interruptId: ask.id }, 'sendReminders: could not remind')
    }
  }
  return { due: due.length, sent }
}

/** Every ten minutes: remind the people an agent is still waiting on. */
export const sendReminders: ScheduledTask = {
  name: 'sendReminders',
  async run({ db, logger }) {
    const result = await runSendReminders(db, logger)
    if (result.due > 0) logger.info(result, 'sendReminders: reminded pending asks')
  },
}

/** Every ten minutes: settle agent runs whose engine run ended without settling them. */
export const sweepLostRuns: ScheduledTask = {
  name: 'sweepLostRuns',
  async run({ db, platform, logger }) {
    const result = await runSweepLostRuns(db, platform, logger)
    if (result.checked > 0) logger.info(result, 'sweepLostRuns: checked stale active runs')
  },
}

/** Nightly retention for the tool-loop journal. */
export const pruneAgentTurns: ScheduledTask = {
  name: 'pruneAgentTurns',
  async run({ db, config, logger }) {
    const result = await runPruneAgentTurns(db, config.AGENT_TRANSCRIPT_RETENTION_DAYS)
    logger.info(result, 'pruneAgentTurns: removed expired tool-loop journals')
  },
}

/** Nightly retention for the local trace store. */
export const pruneAiSpans: ScheduledTask = {
  name: 'pruneAiSpans',
  async run({ db, config, logger }) {
    const result = await runPruneAiSpans(db, config.OBSERVABILITY_SPAN_RETENTION_DAYS)
    logger.info(result, 'pruneAiSpans: removed expired trace spans')
  },
}

/**
 * Drop `plugin_events` older than `EVENTS_RETENTION_DAYS`. A payload may hold personal data —
 * a form's fields — so the window is short (7 days) and this runs nightly; one DELETE across every
 * tenant from the `(tenant_id, created_at)` index, for the reason `runPruneAiSpans` gives. A
 * delivery still retrying past the cutoff (it cannot be: the backoff ends within the hour) finds no
 * row and is acknowledged.
 */
export async function runPruneEvents(db: Database, retentionDays: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const events = affected(await db.delete(pluginEvents).where(lt(pluginEvents.createdAt, cutoff)))
  return { events, cutoff: cutoff.toISOString() }
}

/** Nightly retention for recorded plugin events. */
export const pruneEvents: ScheduledTask = {
  name: 'pruneEvents',
  async run({ db, config, logger }) {
    const result = await runPruneEvents(db, config.EVENTS_RETENTION_DAYS)
    logger.info(result, 'pruneEvents: removed expired plugin events')
  },
}

/**
 * Uploads whose URL and confirm window are both over: an unconfirmed one loses its object (it was
 * never recorded, or its confirm failed), a confirmed one its row — and, for a core target, its
 * object too when no `files` row records the key.
 */
export const prunePendingUploadsTask: ScheduledTask = {
  name: 'prunePendingUploads',
  async run({ db, platform, logger }) {
    const result = await prunePendingUploads(db, platform)
    logger.info(result, 'prunePendingUploads: removed expired uploads')
  },
}

/** Nightly retention for the MCP server: the call log, expired tokens, spent OAuth requests. */
export const pruneMcp: ScheduledTask = {
  name: 'pruneMcp',
  async run({ db, config, logger }) {
    const result = await runPruneMcp(db, config.MCP_CALL_RETENTION_DAYS)
    logger.info(result, 'pruneMcp: removed expired MCP calls and tokens')
  },
}

/** Cron expression → tasks. The registry IS the schedule: nothing else lists an expression. */
const CORE_SCHEDULED_TASKS: Record<string, ScheduledTask[]> = {
  '0 4 * * *': [
    pruneExpired,
    pruneAiSpans,
    pruneEvents,
    pruneAgentTurns,
    pruneMcp,
    prunePendingUploadsTask,
  ],
  '*/10 * * * *': [sweepLostRuns, sendReminders],
}

/**
 * Core tasks plus every installed plugin's. A plugin naming a cron core already runs
 * APPENDS to it — each task is try/caught on its own, so a plugin's failure cannot stop core's
 * prune — and a plugin naming a new cron expression gets its own pg-boss schedule.
 */
export const SCHEDULED_TASKS: Record<string, ScheduledTask[]> = Object.entries(
  CORE_SCHEDULED_TASKS
).reduce<Record<string, ScheduledTask[]>>(
  (registry, [cron, tasks]) => Object.assign(registry, { [cron]: [...tasks] }),
  {}
)
for (const plugin of serverPlugins) {
  for (const [cron, tasks] of Object.entries(plugin.scheduledTasks ?? {})) {
    SCHEDULED_TASKS[cron] = [...(SCHEDULED_TASKS[cron] ?? []), ...tasks]
  }
}

/** Runs every task registered for `cron` and returns a per-task report (used by tests). */
export async function dispatchScheduled(
  cron: string,
  env: AppBindings,
  ctx: WaitUntil,
  registry: Record<string, ScheduledTask[]> = SCHEDULED_TASKS,
  platform: Platform = resolvePlatform(env)
): Promise<TaskReport[]> {
  const config = loadConfig(env)
  const logger = loggerFor(config, { handler: 'scheduled', cron })
  const tasks = registry[cron]
  if (!tasks || tasks.length === 0) {
    logger.warn({ cron }, 'scheduled: no tasks registered for this cron expression')
    return []
  }

  const handle = openDatabase(config)
  const reports: TaskReport[] = []
  try {
    for (const task of tasks) {
      const started = Date.now()
      const taskLogger = logger.child({ task: task.name })
      try {
        await task.run({
          env,
          platform,
          config,
          db: handle.db,
          logger: taskLogger,
          waitUntil: p => ctx.waitUntil(p),
        })
        reports.push({ cron, task: task.name, status: 'ok', durationMs: Date.now() - started })
      } catch (error) {
        taskLogger.error({ err: error }, 'scheduled task failed')
        reports.push({
          cron,
          task: task.name,
          status: 'failed',
          durationMs: Date.now() - started,
          error,
        })
      }
    }
  } finally {
    ctx.waitUntil(handle.close())
  }
  logger.info({ tasks: reports.map(r => `${r.task}:${r.status}`) }, 'scheduled run complete')
  return reports
}

/** The runtime's cron entry: one fired expression (`src/node/jobs.ts` hands it pg-boss's). */
export async function scheduled(
  event: { cron: string },
  env: AppBindings,
  ctx: WaitUntil
): Promise<void> {
  await dispatchScheduled(event.cron, env, ctx)
}
