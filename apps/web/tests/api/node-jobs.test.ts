// @vitest-isolate
// Runs pg-boss workers against the test database in a pg-boss schema of its own, so no other file's
// worker can take these jobs (and the `node-server` worker cannot take them either).
/**
 * Jobs and cron on Node (M3, `src/node/jobs.ts`): pg-boss as the transport under the unchanged
 * consumer. A job sent through the producer reaches `processJobsBatch` and writes its row;
 * `delaySeconds` becomes `startAfter`; a retried job comes back on the queue's backoff curve and,
 * after `max_retries`, lands in the dead-letter queue; an acked, unsettled or poison message
 * completes and a throwing batch is retried; two workers run a cron occurrence once; and `stop()`
 * lets an in-flight job finish.
 */
import { and, eq } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BACKOFF_BASE_SECONDS, BACKOFF_MAX_SECONDS } from '@/api/queues/jobs'
import { buildJobEnvelope } from '@/api/services/jobs'
import type { AppBindings } from '@/api/types'
import { loadConfig } from '@/config'
import { activityEvents } from '@/db/schema'
import {
  createNodeJobs,
  cronScheduleKey,
  type NodeJobs,
  syncCronSchedules,
  toJobBatch,
} from '@/node/jobs'
import {
  CRON_QUEUE,
  createBoss,
  installJobsSchema,
  JOBS_DEAD_LETTER_QUEUE,
  JOBS_QUEUE,
  JOBS_RETRY_LIMIT,
  QUEUES,
} from '@/node/jobs-schema'
import { createNodePlatform } from '@/node/platform'
import type { JobBatch } from '@/platform/types'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase, testDatabaseUrl } from '../helpers/db'

const db = setupTestDatabase()
const SCHEMA = `pgboss_test_${process.pid}`
const rawEnv = {
  ...process.env,
  DATABASE_URL: testDatabaseUrl(),
  JOBS_POLL_INTERVAL_SECONDS: '0.5',
  JOBS_CONCURRENCY: '1',
}
const config = loadConfig(rawEnv)
const quiet = (m?: unknown) => {
  if (process.env.DEBUG_JOBS) console.log('[jobs]', m)
}

let admin: PgBoss
const running: NodeJobs[] = []

function nodeJobs(
  role: 'producer' | 'worker',
  extra: Partial<Parameters<typeof createNodeJobs>[0]> = {}
): NodeJobs {
  const jobs = createNodeJobs(
    { config, log: quiet, crons: [], ...extra, boss: { schema: SCHEMA, ...extra.boss } },
    role
  )
  running.push(jobs)
  return jobs
}

function appEnv(jobs: NodeJobs): AppBindings {
  return { ...rawEnv, PLATFORM: createNodePlatform(config, { jobs: jobs.queue }) } as AppBindings
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function jobById(queue: string, id: string) {
  const [job] = await admin.findJobs(queue, { id })
  return job
}

/** Make a job in `retry` due now instead of after its backoff (the policy is asserted first). */
async function fastForward(id: string) {
  const sql = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {} })
  try {
    await sql.unsafe(`UPDATE ${SCHEMA}.job SET start_after = now() WHERE id = $1`, [id])
  } finally {
    await sql.end({ timeout: 5 })
  }
}

beforeAll(async () => {
  await installJobsSchema(rawEnv, { schema: SCHEMA })
  admin = createBoss(rawEnv, 'producer', { schema: SCHEMA })
  admin.on('error', quiet)
  await admin.start()
}, 60_000)

// A failed test must not leave its worker consuming the next test's jobs.
afterEach(async () => {
  for (const jobs of running.splice(0)) await jobs.stop(5_000)
}, 30_000)

afterAll(async () => {
  await admin?.stop({ graceful: false, close: true })
  const sql = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {} })
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}, 60_000)

describe('the queue policy', () => {
  it('is the consumer’s backoff curve, max_retries = 3, then the dead-letter queue', () => {
    const jobs = QUEUES.find(q => q.name === JOBS_QUEUE)
    expect(jobs).toMatchObject({
      retryLimit: 3,
      retryDelay: BACKOFF_BASE_SECONDS,
      retryBackoff: true,
      retryDelayMax: BACKOFF_MAX_SECONDS,
      deadLetter: JOBS_DEAD_LETTER_QUEUE,
    })
    // The dead-letter queue is created first: a queue naming one needs it to exist.
    expect(QUEUES.findIndex(q => q.name === JOBS_DEAD_LETTER_QUEUE)).toBeLessThan(
      QUEUES.findIndex(q => q.name === JOBS_QUEUE)
    )
    expect(QUEUES.find(q => q.name === CRON_QUEUE)?.retryLimit).toBe(0)
  })

  it('maps pg-boss jobs onto the neutral batch: attempts, ack, retry, ackAll', () => {
    const { batch, settlements } = toJobBatch(JOBS_QUEUE, [
      { id: 'a', data: { n: 1 }, retryCount: 0 },
      { id: 'b', data: { n: 2 }, retryCount: 2 },
      { id: 'c', data: { n: 3 }, retryCount: 0 },
    ])
    expect(batch.queue).toBe(JOBS_QUEUE)
    expect(batch.messages.map(m => m.attempts)).toEqual([1, 3, 1])
    batch.messages[0]?.ack()
    batch.messages[1]?.retry({ delaySeconds: 60 })
    expect(Object.fromEntries(settlements)).toEqual({ a: 'completed', b: 'failed' })
    batch.ackAll()
    expect(settlements.get('c')).toBe('completed')
  })

  it('keys a schedule by its expression, reversibly and within pg-boss’s key alphabet', () => {
    for (const cron of ['0 4 * * *', '*/5 * * * *', '15 2,14 * * 1-5']) {
      const key = cronScheduleKey(cron)
      expect(key).toMatch(/^[A-Za-z0-9_./-]+$/)
      expect(Buffer.from(key, 'base64url').toString('utf8')).toBe(cron)
    }
  })
})

describe('producer → pg-boss → processJobsBatch', () => {
  it('runs a real job end to end: activity.record writes its row, the job completes', async () => {
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const worker = nodeJobs('worker')
    await worker.startWorker(appEnv(worker))
    const subjectIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    const envelopes = subjectIds.map(subjectId =>
      buildJobEnvelope({
        type: 'activity.record',
        payload: { tenantId: tenant.id, type: 'test.m3', subjectType: 'test', subjectId },
      })
    )
    const [first, ...rest] = envelopes
    const sentId = (await worker.queue.send(first as never)) as string
    await worker.queue.sendBatch(rest.map(body => ({ body })))

    const written = await until(
      () =>
        db
          .select()
          .from(activityEvents)
          .where(and(eq(activityEvents.tenantId, tenant.id), eq(activityEvents.type, 'test.m3'))),
      found => found.length === subjectIds.length
    )
    expect(written.map(r => r.subjectId).sort()).toEqual([...subjectIds].sort())
    const done = await until(
      () => jobById(JOBS_QUEUE, sentId),
      job => job?.state === 'completed'
    )
    expect(done?.data).toMatchObject({ id: first?.id, type: 'activity.record' })
    await worker.stop(5_000)
  }, 30_000)

  it('delaySeconds becomes startAfter: the job waits, untouched by a running worker', async () => {
    const seen: string[] = []
    const worker = nodeJobs('worker', {
      handlers: {
        jobs: async batch => {
          for (const m of batch.messages) seen.push(m.id)
        },
      },
    })
    await worker.startWorker(appEnv(worker))
    const before = Date.now()
    const id = (await worker.queue.send(envelope(), { delaySeconds: 30 })) as string
    const job = await jobById(JOBS_QUEUE, id)
    expect(job?.state).toBe('created')
    const waitMs = new Date(job?.startAfter ?? 0).getTime() - before
    expect(waitMs).toBeGreaterThan(28_000)
    expect(waitMs).toBeLessThan(35_000)
    await new Promise(resolve => setTimeout(resolve, 1_500))
    expect(seen).not.toContain(id)
    await worker.stop(5_000)
  }, 20_000)
})

function envelope() {
  return buildJobEnvelope({
    type: 'activity.record',
    payload: {
      tenantId: crypto.randomUUID(),
      type: 'test.m3',
      subjectType: 'test',
      subjectId: crypto.randomUUID(),
    },
  })
}

describe('settlement: retry, backoff, dead letter, ack', () => {
  it('retries on the backoff curve, max_retries times, then dead-letters the job', async () => {
    const attempts: number[] = []
    const worker = nodeJobs('worker', {
      handlers: {
        jobs: async batch => {
          for (const m of batch.messages) {
            attempts.push(m.attempts)
            m.retry({ delaySeconds: 30 })
          }
        },
      },
    })
    await worker.startWorker(appEnv(worker))
    const body = envelope()
    const id = (await worker.queue.send(body)) as string

    for (let failure = 1; failure <= JOBS_RETRY_LIMIT; failure++) {
      const failedAt = Date.now()
      // pg-boss bumps `retryCount` when it fetches the job again, so the n-th failure reads n - 1.
      const job = await until(
        () => jobById(JOBS_QUEUE, id),
        j => j?.state === 'retry' && j.retryCount === failure - 1 && attempts.length === failure
      )
      // The consumer's backoff (30 s doubling) is the floor; pg-boss's jitter can double it.
      const delay = (new Date(job?.startAfter ?? 0).getTime() - failedAt) / 1000
      const floor = Math.min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2 ** (failure - 1))
      expect(delay, `failure ${failure}`).toBeGreaterThan(floor - 3)
      expect(delay, `failure ${failure}`).toBeLessThanOrEqual(
        Math.min(BACKOFF_MAX_SECONDS, 2 * floor) + 1
      )
      await fastForward(id)
    }

    const final = await until(
      () => jobById(JOBS_QUEUE, id),
      j => j?.state === 'failed'
    )
    expect(final?.retryCount).toBe(JOBS_RETRY_LIMIT)
    expect(attempts).toEqual([1, 2, 3, 4])
    const dead = await until(
      () => admin.findJobs(JOBS_DEAD_LETTER_QUEUE, { data: { id: body.id } }),
      found => found.length === 1
    )
    expect(dead[0]?.data).toMatchObject({ id: body.id, type: 'activity.record' })
    await worker.stop(5_000)
  }, 60_000)

  it('acked and unsettled messages complete; a throwing batch is retried whole', async () => {
    const worker = nodeJobs('worker', {
      handlers: {
        jobs: async (batch: JobBatch) => {
          const modes = batch.messages.map(m => (m.body as { payload: { type: string } }).payload)
          if (modes.some(p => p.type === 'test.throw')) throw new Error('consumer crashed')
          for (const m of batch.messages) {
            if ((m.body as { payload: { type: string } }).payload.type === 'test.ack') m.ack()
          }
        },
      },
    })
    await worker.startWorker(appEnv(worker))
    const ack = envelope()
    ack.payload = { ...ack.payload, type: 'test.ack' } as never
    const unsettled = envelope()
    const throwing = envelope()
    throwing.payload = { ...throwing.payload, type: 'test.throw' } as never

    const ackId = (await worker.queue.send(ack)) as string
    const unsettledId = (await worker.queue.send(unsettled)) as string
    for (const id of [ackId, unsettledId]) {
      await until(
        () => jobById(JOBS_QUEUE, id),
        j => j?.state === 'completed'
      )
    }
    const throwId = (await worker.queue.send(throwing)) as string
    const retried = await until(
      () => jobById(JOBS_QUEUE, throwId),
      j => j?.state === 'retry'
    )
    // pg-boss counts a retry when it fetches the job again, so a fresh failure still reads 0.
    expect(retried?.retryCount).toBe(0)
    await worker.stop(5_000)
  }, 30_000)

  it('a poison message through the real consumer is acked, never retried', async () => {
    const worker = nodeJobs('worker')
    await worker.startWorker(appEnv(worker))
    const id = (await worker.queue.send({ not: 'an envelope' } as never)) as string
    const job = await until(
      () => jobById(JOBS_QUEUE, id),
      j => j?.state === 'completed'
    )
    expect(job?.retryCount).toBe(0)
    await worker.stop(5_000)
  }, 20_000)
})

describe('cron', () => {
  it('replaces stale schedules with the registered expressions', async () => {
    await admin.schedule(CRON_QUEUE, '0 1 * * *', { cron: '0 1 * * *' }, { key: 'stale' })
    await syncCronSchedules(admin, ['0 4 * * *', '*/15 * * * *'])
    const schedules = await admin.getSchedules(CRON_QUEUE)
    expect(schedules.map(s => s.cron).sort()).toEqual(['*/15 * * * *', '0 4 * * *'])
    expect(schedules.every(s => s.timezone === 'UTC')).toBe(true)
    await syncCronSchedules(admin, [])
    expect(await admin.getSchedules(CRON_QUEUE)).toEqual([])
  })

  it('two workers run an occurrence once', async () => {
    // An expression due in the current minute: one occurrence today, inside pg-boss's due window.
    const now = new Date()
    const cron = `${now.getUTCMinutes()} ${now.getUTCHours()} * * *`
    const runs: string[] = []
    const fast = { cronMonitorIntervalSeconds: 1, cronWorkerIntervalSeconds: 1 }
    const workers = [0, 1].map(() =>
      nodeJobs('worker', {
        crons: [cron],
        boss: fast,
        handlers: {
          cron: async c => {
            runs.push(c)
          },
        },
      })
    )
    for (const w of workers) await w.startWorker(appEnv(w))
    await until(
      async () => runs.length,
      n => n >= 1,
      20_000
    )
    // Several more passes by both instances: still the one run.
    await new Promise(resolve => setTimeout(resolve, 4_000))
    expect(runs).toEqual([cron])
    for (const w of workers) await w.stop(5_000)
    await syncCronSchedules(admin, [])
  }, 40_000)
})

describe('shutdown', () => {
  it('stop() stops fetching and lets the in-flight job finish', async () => {
    let started = false
    let finished = false
    const worker = nodeJobs('worker', {
      handlers: {
        jobs: async () => {
          started = true
          await new Promise(resolve => setTimeout(resolve, 1_000))
          finished = true
        },
      },
    })
    await worker.startWorker(appEnv(worker))
    const id = (await worker.queue.send(envelope())) as string
    await until(
      async () => started,
      s => s
    )
    await worker.stop(10_000)
    expect(finished).toBe(true)
    expect((await jobById(JOBS_QUEUE, id))?.state).toBe('completed')
  }, 20_000)
})
