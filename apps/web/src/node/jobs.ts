/**
 * Jobs and cron on Node (M3, `docs/ROADMAP.md`): **pg-boss** over the app's own Postgres stands in
 * for Cloudflare Queues (`JOBS_QUEUE` + the `queue()` consumer) and for `[triggers] crons` (the
 * `scheduled()` entry). The app side is unchanged — the consumer hands pg-boss's jobs to the same
 * `queue()` the Worker exports (`src/api/queue.ts` → `processJobsBatch`), and a cron occurrence to
 * the same `scheduled()` — so what changes is only the transport:
 *
 * - **Producer** (`createPgBossJobsQueue`): `send` → `boss.send`, `sendBatch` → `boss.insert`,
 *   `delaySeconds` → `startAfter`. It is the Node `Platform`'s `jobs`; pg-boss starts on the first
 *   send, so a `web` process boots (and answers `/healthz`) with the database down.
 * - **Consumer** (`worker`/`all` modes): batches of up to 10 (`max_batch_size`), settled PER JOB
 *   (`perJobResults`) from the `ack()`/`retry()` calls `processJobsBatch` makes. A message neither
 *   acked nor retried counts as acked — a Cloudflare consumer that returns acks its whole batch —
 *   and a batch whose processing THROWS fails every job in it, as a thrown `queue()` retries the
 *   batch.
 * - **Retries**: the queue carries the policy, so `retry({ delaySeconds })` FAILS the job and
 *   pg-boss reschedules it on the queue's own curve — 30 s doubling to a 15 min cap, the
 *   `backoffSeconds` curve the consumer computes, as a floor: pg-boss's jitter lands each delay
 *   between that figure and twice it (still capped at 15 min). Three retries after the first delivery (`max_retries = 3`), then the job
 *   moves to the dead-letter queue (`<queue>-dlq`), which Cloudflare's config only had commented
 *   out. A crashed or stuck consumer's job comes back after `expireInSeconds` (15 min, the
 *   Cloudflare consumer's wall-clock limit) and counts as an attempt.
 * - **Cron**: every expression in `SCHEDULED_TASKS` is a pg-boss schedule (keyed by the
 *   expression, UTC) on the cron queue; expressions no longer registered are unscheduled at start. pg-boss
 *   claims each cron pass with a database row and files each occurrence under a singleton key, so
 *   N worker replicas send ONE job per occurrence, and one consumer runs it. Cron jobs never
 *   retry — Cloudflare does not re-run a failed `scheduled()` either.
 *
 * The queues, their policies and the schema install live in `jobs-schema.ts`, which imports nothing
 * of the app, so `scripts/migrate.ts` can install them without loading it.
 */
import type { PgBoss } from 'pg-boss'
import { queue as runJobsBatch } from '../api/queue'
import { SCHEDULED_TASKS, scheduled } from '../api/scheduled'
import type { AppBindings } from '../api/types'
import type { AppConfig } from '../config'
import type { JobBatch, JobMessage, JobSendRequest, JobsQueue } from '../platform/types'
import {
  type BossOptions,
  CRON_QUEUE,
  createBoss,
  JOBS_BATCH_SIZE,
  JOBS_QUEUE,
} from './jobs-schema'

function startAfter(delaySeconds: number | undefined): { startAfter?: number } {
  return delaySeconds && delaySeconds > 0 ? { startAfter: delaySeconds } : {}
}

/** The Node `Platform.jobs`: pg-boss's producer, started on first use. */
export function createPgBossJobsQueue(boss: () => Promise<PgBoss>): JobsQueue {
  return {
    async send(body, options) {
      return (await boss()).send(JOBS_QUEUE, body, startAfter(options?.delaySeconds))
    },
    async sendBatch(messages: Iterable<JobSendRequest>, options) {
      const jobs = [...messages].map(m => ({
        data: m.body,
        ...startAfter(m.delaySeconds ?? options?.delaySeconds),
      }))
      if (jobs.length === 0) return []
      return (await boss()).insert(JOBS_QUEUE, jobs)
    },
  }
}

type Settlement = 'completed' | 'failed'

/** pg-boss's batch as the neutral `JobBatch`, recording what the consumer decided per message. */
export function toJobBatch(
  queueName: string,
  jobs: readonly { id: string; data: unknown; retryCount: number }[]
): { batch: JobBatch; settlements: Map<string, Settlement> } {
  const settlements = new Map<string, Settlement>()
  const messages: JobMessage[] = jobs.map(job => ({
    id: job.id,
    body: job.data,
    attempts: job.retryCount + 1,
    ack: () => settlements.set(job.id, 'completed'),
    // The queue's policy picks the delay (see the header); the consumer's figure is the same curve.
    retry: () => settlements.set(job.id, 'failed'),
  }))
  return {
    batch: {
      queue: queueName,
      messages,
      ackAll: () => {
        for (const job of jobs) settlements.set(job.id, 'completed')
      },
    },
    settlements,
  }
}

export interface NodeJobsOptions {
  config: AppConfig
  log: (message: string) => void
  boss?: BossOptions
  /** The cron expressions to schedule. Default: every key of `SCHEDULED_TASKS`. */
  crons?: readonly string[]
  /** Replace what runs a batch / a cron occurrence (tests). Default: the Worker's `queue()` / `scheduled()`. */
  handlers?: {
    jobs?: (batch: JobBatch, env: AppBindings) => Promise<void>
    cron?: (cron: string, env: AppBindings) => Promise<void>
  }
}

export interface NodeJobs {
  /** The producer — the Node `Platform.jobs`. */
  queue: JobsQueue
  /** Start the jobs consumer and the cron schedules (`worker`/`all` modes). */
  startWorker(env: AppBindings): Promise<void>
  /** Stop fetching, let in-flight jobs finish (up to `timeoutMs`), close pg-boss's pool. */
  stop(timeoutMs?: number): Promise<void>
}

/**
 * One pg-boss per process, in the role the process needs: a `web` process only produces, so its
 * instance neither supervises nor schedules; a `worker` process's instance does both and produces
 * for the handlers that enqueue follow-up jobs.
 */
export function createNodeJobs(options: NodeJobsOptions, role: 'producer' | 'worker'): NodeJobs {
  const { config, log } = options
  const consumeJobs = options.handlers?.jobs ?? runJobsBatch
  const consumeCron = options.handlers?.cron ?? runCron
  const boss = createBoss(config, role, options.boss)
  boss.on('error', err => log(`jobs: pg-boss error: ${err instanceof Error ? err.message : err}`))
  let started: Promise<PgBoss> | undefined
  const start = () => {
    started ??= boss.start().catch(err => {
      started = undefined
      throw err
    })
    return started
  }

  return {
    queue: createPgBossJobsQueue(start),

    async startWorker(env) {
      await start()
      await boss.work(
        JOBS_QUEUE,
        {
          batchSize: JOBS_BATCH_SIZE,
          perJobResults: true,
          localConcurrency: config.JOBS_CONCURRENCY,
          pollingIntervalSeconds: config.JOBS_POLL_INTERVAL_SECONDS,
        },
        async jobs => {
          const { batch, settlements } = toJobBatch(JOBS_QUEUE, jobs)
          await consumeJobs(batch, env)
          return jobs.map(job => ({ id: job.id, status: settlements.get(job.id) ?? 'completed' }))
        }
      )

      const crons = options.crons ?? Object.keys(SCHEDULED_TASKS)
      await syncCronSchedules(boss, crons)
      await boss.work<{ cron: string }>(
        CRON_QUEUE,
        { batchSize: 1, pollingIntervalSeconds: config.JOBS_POLL_INTERVAL_SECONDS },
        async ([job]) => {
          if (!job) return
          await consumeCron(job.data.cron, env)
        }
      )
      log(
        `worker: consuming ${JOBS_QUEUE} (${config.JOBS_CONCURRENCY}×${JOBS_BATCH_SIZE}), cron ${crons.join(', ') || 'none'}`
      )
    },

    async stop(timeoutMs = 30_000) {
      if (!started) return
      try {
        await started
      } catch {
        return
      }
      await boss.stop({ graceful: true, close: true, timeout: timeoutMs })
    },
  }
}

/** One cron occurrence through the Worker's own `scheduled()`, waiting for its deferred work. */
export async function runCron(cron: string, env: AppBindings): Promise<void> {
  const pending: Promise<unknown>[] = []
  await scheduled({ cron }, env, { waitUntil: p => void pending.push(p) })
  await Promise.allSettled(pending)
}

/**
 * A schedule's key: pg-boss keys allow `[A-Za-z0-9_./-]` only, and a cron expression has spaces and
 * `*`, so the expression is base64url-encoded — reversible, and distinct per expression.
 */
export function cronScheduleKey(cron: string): string {
  return Buffer.from(cron, 'utf8').toString('base64url')
}

/** Schedule every registered expression (UTC) and drop the schedules nothing registers any more. */
export async function syncCronSchedules(boss: PgBoss, crons: readonly string[]): Promise<void> {
  const wanted = new Set(crons.map(cronScheduleKey))
  for (const existing of await boss.getSchedules(CRON_QUEUE)) {
    if (!wanted.has(existing.key)) await boss.unschedule(CRON_QUEUE, existing.key)
  }
  for (const cron of crons) {
    await boss.schedule(CRON_QUEUE, cron, { cron }, { key: cronScheduleKey(cron), tz: 'UTC' })
  }
}
