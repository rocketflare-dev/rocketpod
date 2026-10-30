/**
 * Queue consumer dispatcher: one `queue` export routing on `batch.queue`. The jobs queue is
 * matched by PREFIX (`isJobsQueue`), so an environment-suffixed name (`rocketpod-jobs-staging`)
 * routes like the pg-boss queue `rocketpod-jobs` (`src/node/jobs-schema.ts`). Any other queue is
 * logged and acked so a stray queue cannot retry forever. Config is validated like `fetch`.
 */
import { loadConfig } from '../config'
import type { JobBatch } from '../platform/types'
import { processJobsBatch } from './queues/jobs'
import { isJobsQueue } from './services/jobs'
import type { AppBindings } from './types'
import { loggerFor } from './utils/core/logger'

export async function queue(batch: JobBatch, env: AppBindings): Promise<void> {
  const config = loadConfig(env)
  const logger = loggerFor(config, { handler: 'queue', queue: batch.queue })

  if (isJobsQueue(batch.queue)) {
    logger.info({ messages: batch.messages.length }, 'queue: processing jobs batch')
    return processJobsBatch(batch, { env, config, logger })
  }

  logger.warn(
    { messages: batch.messages.length },
    'queue: no consumer registered for this queue; acknowledging batch'
  )
  batch.ackAll()
}
