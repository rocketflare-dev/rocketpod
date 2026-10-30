/**
 * pg-boss's schema and queues — everything about the jobs transport that does NOT need the
 * app, so `scripts/migrate.ts` (the migrate one-shot) can install it without importing routes and
 * handlers. `jobs.ts` is the runtime on top.
 *
 * pg-boss owns the `pgboss` schema. `installJobsSchema` creates/migrates it and the queues — the
 * `pnpm db:migrate` step, never a `web` boot. It connects with `DATABASE_URL` (the schema owner)
 * through its own small `pg` pool. The retry curve is the consumer's `backoffSeconds`
 * (`src/api/queues/jobs.ts`): `tests/api/node-jobs.test.ts` holds the two together.
 */
import { JOBS_RETRY_LIMIT } from '@rocketpod/shared/jobs'
import { PgBoss, type Queue as QueueSpec } from 'pg-boss'
import { JOBS_QUEUE_NAME_PREFIX } from '../api/services/jobs'
import { type DatabaseEnv, resolveDatabaseUrl } from '../db/client'

export const PGBOSS_SCHEMA = 'pgboss'
/** The jobs queue — `JOBS_QUEUE_NAME_PREFIX` itself, so `isJobsQueue` routes it. */
export const JOBS_QUEUE = JOBS_QUEUE_NAME_PREFIX
export const JOBS_DEAD_LETTER_QUEUE = `${JOBS_QUEUE}-dlq`
export const CRON_QUEUE = 'rocketpod-cron'

/** Jobs per batch a consumer fetches and hands to `queue()`. */
export const JOBS_BATCH_SIZE = 10
/** Retries after the first delivery — shared, so a handler can tell its last delivery. */
export { JOBS_RETRY_LIMIT }
/** A consumer's wall-clock limit before its job is considered lost and retried. */
export const JOBS_EXPIRE_SECONDS = 15 * 60
/** First retry delay, doubling (`BACKOFF_BASE_SECONDS`). */
export const JOBS_RETRY_DELAY_SECONDS = 30
/** Retry delay cap (`BACKOFF_MAX_SECONDS`). */
export const JOBS_RETRY_DELAY_MAX_SECONDS = 15 * 60
const FOURTEEN_DAYS = 14 * 24 * 60 * 60

/** Every queue the app uses, dead-letter queue first (a queue naming one needs it to exist). */
export const QUEUES: readonly QueueSpec[] = [
  {
    name: JOBS_DEAD_LETTER_QUEUE,
    retryLimit: 0,
    retentionSeconds: FOURTEEN_DAYS,
    deleteAfterSeconds: FOURTEEN_DAYS,
  },
  {
    name: JOBS_QUEUE,
    retryLimit: JOBS_RETRY_LIMIT,
    retryDelay: JOBS_RETRY_DELAY_SECONDS,
    retryBackoff: true,
    retryDelayMax: JOBS_RETRY_DELAY_MAX_SECONDS,
    expireInSeconds: JOBS_EXPIRE_SECONDS,
    deadLetter: JOBS_DEAD_LETTER_QUEUE,
  },
  { name: CRON_QUEUE, retryLimit: 0, expireInSeconds: JOBS_EXPIRE_SECONDS },
]

export type BossRole = 'migrate' | 'producer' | 'worker'

export interface BossOptions {
  /** pg-boss's schema. Default `pgboss`; tests use one of their own so files cannot share jobs. */
  schema?: string
  /** Connections in pg-boss's own pool. */
  max?: number
  /** pg-boss's cron pass interval, 1–45 s (tests shorten it). */
  cronMonitorIntervalSeconds?: number
  /** How often pg-boss forwards a due occurrence into its queue, 1–45 s (tests shorten it). */
  cronWorkerIntervalSeconds?: number
}

/**
 * One pg-boss instance. `migrate` installs the schema; `producer` only sends (no maintenance, no
 * cron); `worker` also supervises the queues and runs the cron pass.
 */
export function createBoss(env: DatabaseEnv, role: BossRole, options: BossOptions = {}): PgBoss {
  return new PgBoss({
    connectionString: resolveDatabaseUrl(env),
    schema: options.schema ?? PGBOSS_SCHEMA,
    application_name: `rocketpod-${role}`,
    max: options.max ?? (role === 'worker' ? 4 : 2),
    migrate: role === 'migrate',
    createSchema: role === 'migrate',
    supervise: role === 'worker',
    schedule: role === 'worker',
    ...(options.cronMonitorIntervalSeconds
      ? { cronMonitorIntervalSeconds: options.cronMonitorIntervalSeconds }
      : {}),
    ...(options.cronWorkerIntervalSeconds
      ? { cronWorkerIntervalSeconds: options.cronWorkerIntervalSeconds }
      : {}),
  })
}

/** Create each queue, or bring an existing one's policy in line with `QUEUES`. Idempotent. */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const { name, ...options } of QUEUES) {
    if (await boss.getQueue(name)) {
      const { policy: _policy, partition: _partition, ...updatable } = options
      await boss.updateQueue(name, updatable)
    } else {
      await boss.createQueue(name, options)
    }
  }
}

/** The migrate step: create or migrate the `pgboss` schema, then the queues. */
export async function installJobsSchema(
  env: DatabaseEnv,
  options: Pick<BossOptions, 'schema'> = {}
): Promise<void> {
  const boss = createBoss(env, 'migrate', options)
  boss.on('error', () => {})
  await boss.start()
  try {
    await ensureQueues(boss)
  } finally {
    await boss.stop({ graceful: false, close: true })
  }
}
