/**
 * Run an ENQUEUED agent run to its end, in-process: the three step bodies inline (`claimStep`
 * → `executeRun` → `finishStep`) exactly as the run body (`runAgentRun`) calls them, with no run
 * engine. `executeRun` throws only to ask for a step retry, so it is retried here up to the same
 * limit the engine gives it (`EXECUTE_RETRIES`). Call it inside `withEvalScope`.
 *
 * A run that PARKS on a person (`ask_human`, an approval) cannot be answered by an eval: the final
 * `finishStep` settles it `cancelled`, and the target scores it as the miss it is.
 */
import {
  claimStep,
  EXECUTE_RETRIES,
  type ExecuteOutcome,
  executeRun,
  finishStep,
} from '@/api/services/agents/runtime'
import type { Logger } from '@/api/utils/core/logger'
import type { CaseWorld } from './fixtures'

export async function runAgentInProcess(
  world: CaseWorld,
  logger: Logger,
  runId: string
): Promise<void> {
  const params = { runId, tenantId: world.tenantId }
  let outcome: ExecuteOutcome | undefined
  if (await claimStep(world.db, world.env, logger, params)) {
    for (let attempt = 0; attempt <= EXECUTE_RETRIES && !outcome; attempt++) {
      try {
        outcome = await executeRun(world.db, world.cfg, world.env, logger, params, { round: 0 })
      } catch (err) {
        if (attempt === EXECUTE_RETRIES) throw err
      }
    }
  }
  await finishStep(world.db, world.env, logger, params, outcome, { cfg: world.cfg })
}
