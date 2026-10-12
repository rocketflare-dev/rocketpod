/**
 * `AgentRunWorkflow` (D5, D7) — the ONE Workflow class, bound as `AGENT_RUN_WORKFLOW`; the agent
 * runtime IS the example workflow. M1: a shim. The run's steps, rounds and guards live in
 * `./agent-run-body.ts` against the neutral `Step`; this class adapts Cloudflare's `WorkflowStep`
 * and builds the platform from the Worker's bindings. Exported from `src/worker.ts`, never from
 * `api/index.ts`.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { MAX_INTERRUPT_ROUNDS } from '@rocketpod/shared/ai/agents'
import { resolvePlatform } from '../../platform'
import { type CloudflareBindings, cloudflareStep } from '../../platform/cloudflare'
import type { AgentRunParams } from '../services/agents/runs'
import type { ExecuteOutcome } from '../services/agents/runtime'
import type { AppBindings } from '../types'
import { runAgentRun } from './agent-run-body'

export { runAgentRun, withStepDatabase } from './agent-run-body'

export class AgentRunWorkflow extends WorkflowEntrypoint<CloudflareBindings, AgentRunParams> {
  /**
   * The runaway guard's round count. An instance field so the test can lower it: the behaviour
   * under test is what happens AT the cap, and 32 rounds of real queries is latency-bound on a slow
   * link (30 s on a remote gate branch). Nothing else sets it.
   */
  maxInterruptRounds: number = MAX_INTERRUPT_ROUNDS

  async run(event: WorkflowEvent<AgentRunParams>, step: WorkflowStep): Promise<ExecuteOutcome> {
    const env = this.env as unknown as AppBindings
    return runAgentRun(event.payload, cloudflareStep(step), {
      env,
      platform: resolvePlatform(env),
      maxInterruptRounds: this.maxInterruptRounds,
    })
  }
}
