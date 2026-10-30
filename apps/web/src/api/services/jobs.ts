/**
 * The jobs producer (pg-boss): `enqueueJob(platform.jobs, input)` validates the input against
 * `jobInputSchema`, stamps the envelope (`id`, `enqueuedAt`) and sends. Routes and services call
 * this instead of doing the work inline — "a route never runs long work; it enqueues".
 *
 * The queue is passed in (never read from a global) so the same service code runs from a route
 * (`c.get('platform').jobs`), a cron, a run step or a test (`RecordingQueue`).
 */
import { ERROR_CODES } from '@rocketpod/shared/errors'
import {
  type JobEnvelope,
  type JobInput,
  jobEnvelopeSchema,
  jobInputSchema,
} from '@rocketpod/shared/jobs'
import type { JobsQueue } from '../../platform/types'
import { ServiceUnavailableError } from '../utils/core/errors'
import { newId } from '../utils/core/ids'

/**
 * The jobs queue's NAME (`rocketpod-jobs`, `src/node/jobs-schema.ts`). The consumer matches
 * `batch.queue` by PREFIX rather than exact name, so an environment-suffixed queue
 * (`rocketpod-jobs-staging`) needs no application change. ADAPTING: change this one constant.
 */
export const JOBS_QUEUE_NAME_PREFIX = 'rocketpod-jobs'

/** `true` for every environment's jobs queue (`rocketpod-jobs`, `rocketpod-jobs-staging`, …). */
export function isJobsQueue(queueName: string): boolean {
  return queueName.startsWith(JOBS_QUEUE_NAME_PREFIX)
}

/** The producer (`src/platform/types.ts`): any transport, or the test `RecordingQueue`. */
export type { JobsQueue }

export interface EnqueueOptions {
  /** Deliver no earlier than this many seconds from now (0–43200). Delays, does not dedupe. */
  delaySeconds?: number
}

/**
 * Thrown when a code path needs the queue and the platform has none: a 503 `jobs_not_configured`
 * (a process built without the pg-boss producer).
 */
export class JobsQueueNotConfiguredError extends ServiceUnavailableError {
  constructor() {
    super('Background jobs are not configured', ERROR_CODES.jobsNotConfigured)
    this.name = 'JobsQueueNotConfiguredError'
  }
}

/** The queue or a clear configuration error — never a silent no-op. */
export function requireJobsQueue(queue: JobsQueue | undefined | null): JobsQueue {
  if (!queue) throw new JobsQueueNotConfiguredError()
  return queue
}

/** Validate an input and stamp the envelope. Pure; exported so tests can assert the shape. */
export function buildJobEnvelope(input: JobInput): JobEnvelope {
  const parsed = jobInputSchema.parse(input)
  return jobEnvelopeSchema.parse({
    ...parsed,
    id: newId(),
    enqueuedAt: new Date().toISOString(),
  })
}

export async function enqueueJob(
  queue: JobsQueue | undefined | null,
  input: JobInput,
  options: EnqueueOptions = {}
): Promise<JobEnvelope> {
  const target = requireJobsQueue(queue)
  const job = buildJobEnvelope(input)
  await target.send(job, options.delaySeconds ? { delaySeconds: options.delaySeconds } : undefined)
  return job
}

/** Messages per `sendBatch` call: a large fan-out is sent in bounded chunks. */
const SEND_BATCH_LIMIT = 100

export async function enqueueJobs(
  queue: JobsQueue | undefined | null,
  inputs: readonly JobInput[],
  options: EnqueueOptions = {}
): Promise<JobEnvelope[]> {
  const target = requireJobsQueue(queue)
  const jobs = inputs.map(buildJobEnvelope)
  for (let i = 0; i < jobs.length; i += SEND_BATCH_LIMIT) {
    await target.sendBatch(
      jobs.slice(i, i + SEND_BATCH_LIMIT).map(body => ({
        body,
        ...(options.delaySeconds ? { delaySeconds: options.delaySeconds } : {}),
      }))
    )
  }
  return jobs
}
