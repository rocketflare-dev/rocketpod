/**
 * The agent target (D33): one case → one real agent run, IN-PROCESS, through the real runtime —
 * `enqueueRun` (the row, validated input), then the three step bodies inline (`runAgentInProcess`:
 * `claimStep` → `executeRun` → `finishStep`) exactly as the run body (`runAgentRun`) calls them,
 * with no run engine.
 *
 * A run that PARKS on a person (`ask_human`, an approval) cannot be answered by an eval: the final
 * `finishStep` settles it `cancelled`, the output is null, and the judges score it as the miss it
 * is. The transcript is built from `agent_run_events`, the same rows the run page and the AG-UI
 * projection read.
 *
 * `promptVersions` names every registry prompt the run used (`promptVersion`, the TEMPLATE): the
 * agent's own, plus `agent-decide` when a `ctx.decide` answer came from the chat-model fallback
 * (`llm_self_report`) rather than Jev — so a baseline records the decisions prompt only when the
 * suite actually measured it.
 */
import type { AgentKey } from '@rocketpod/shared/ai/agents'
import { decisionAnswerLabel } from '@rocketpod/shared/ai/decisions'
import type { EvalCase } from '@rocketpod/shared/ai/evals'
import { and, asc, eq } from 'drizzle-orm'
import { createHarness, type Harness, type JsonValue } from 'vitest-evals'
import { withEvalScope } from '@/api/observability/context'
import { listDecisions } from '@/api/services/agents/decisions'
import { getAgent } from '@/api/services/agents/registry'
import { enqueueRun, getRun } from '@/api/services/agents/runs'
import { promptVersion } from '@/api/services/ai/prompt-version'
import { getPrompt, type RegistryPromptKey } from '@/api/services/prompts'
import { loggerFor } from '@/api/utils/core/logger'
import { agentRunEvents } from '@/db/schema'
import { caseWorld } from './fixtures'
import { runAgentInProcess } from './run-agent'
import type { RecordedDecisions } from './scoring'
import { tenantSpend } from './spend'
import { transcriptFromRunEvents } from './transcript'

export function agentHarness(agentKey: AgentKey): Harness<EvalCase, JsonValue | undefined> {
  return createHarness<EvalCase, JsonValue | undefined>({
    name: `rocketpod-agent:${agentKey}`,
    run: async ({ input: evalCase }) => {
      const agent = getAgent(agentKey)
      const world = await caseWorld(evalCase, [agent.meta.promptKey])
      const logger = loggerFor(world.cfg, { eval: evalCase.id })
      const started = Date.now()
      const runId = await withEvalScope(async () => {
        const { run } = await enqueueRun(world.db, world.env, {
          tenantId: world.tenantId,
          agentKey,
          input: evalCase.input,
          userId: world.userId,
        })
        await runAgentInProcess(world, logger, run.id)
        return run.id
      })
      const totalMs = Date.now() - started

      const row = await getRun(world.db, world.tenantId, runId)
      if (!row) throw new Error(`agent run ${runId} vanished`)
      if (row.status === 'failed') throw new Error(`agent run failed: ${row.error ?? 'no reason'}`)
      const events = await world.db
        .select({ type: agentRunEvents.type, data: agentRunEvents.data })
        .from(agentRunEvents)
        .where(and(eq(agentRunEvents.tenantId, world.tenantId), eq(agentRunEvents.runId, runId)))
        .orderBy(asc(agentRunEvents.seq))
      const output = (row.output ?? undefined) as JsonValue | undefined
      const transcript = transcriptFromRunEvents(events, row.input, output, row.error)
      // D37: every `ctx.decide` answer, keyed for `DecisionJudge` — read from the table, not a model.
      const decisions: RecordedDecisions = {}
      const recorded = await listDecisions(world.db, world.tenantId, runId)
      for (const d of recorded) {
        decisions[d.key] = Object.fromEntries(
          Object.entries(d.answers).map(([id, a]) => [
            id,
            {
              type: a.type,
              label: decisionAnswerLabel(a),
              confidence: a.confidence,
              ...(a.noul !== undefined && { noul: a.noul }),
              ...(a.probabilities && { probabilities: a.probabilities }),
            },
          ])
        )
      }
      // The TEMPLATE (override or default), not the interpolated text: every case has its own
      // tenant name, and "which prompt ran" must hash the same across cases.
      const versionOf = async (key: RegistryPromptKey) =>
        promptVersion(key, (await getPrompt(world.db, world.tenantId, key)).effectiveText)
      const promptKey = agent.meta.promptKey as RegistryPromptKey
      const version = await versionOf(promptKey)
      const promptVersions: Record<string, string> = { [promptKey]: version }
      if (recorded.some(d => d.method === 'llm_self_report')) {
        promptVersions['agent-decide'] = await versionOf('agent-decide')
      }
      return {
        output,
        events: transcript.events,
        usage: {
          toolCalls: transcript.toolCalls.length,
          ...(await tenantSpend(world.db, world.tenantId)),
        },
        timings: { totalMs },
        artifacts: {
          retrieved: transcript.retrieved,
          status: row.status,
          runId,
          promptKey,
          promptVersion: version,
          promptVersions,
          decisions: decisions as unknown as JsonValue,
        },
      }
    },
  })
}
