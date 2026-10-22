/**
 * The SHARED half of the test-only agents (`./test-agents.ts`): the plugin entry that puts their
 * keys into `AGENT_KEYS` / `agentKeySchema`, so the route, the UI and the run rows accept them.
 *
 * Kept apart from the server half on purpose: this module is what the
 * `@rocketpod/shared/plugins` mock factory loads, and a factory that imported a shared
 * composer (`ai/agents.ts` reads the very barrel being mocked) would close a cycle at module
 * evaluation. So nothing here is a runtime import.
 *
 *     vi.mock('@rocketpod/shared/plugins', async importOriginal =>
 *       (await import('../helpers/test-agents-shared')).withTestAgents(await importOriginal())
 *     )
 */
import type { AgentKey } from '@rocketpod/shared/ai/agents'
import type { SharedPlugin } from '@rocketpod/shared/plugins'

/** One forced tool call, an approval before an optional write — the single-call shape. */
export const TEST_SUMMARIZE = 'test-summarize' as AgentKey
/** A `runToolLoop` over the knowledge tools, checkpointed, with one approval-gated tool. */
export const TEST_RESEARCH = 'test-research' as AgentKey

export const TEST_AGENTS_SHARED = {
  id: 'test-agents',
  label: 'Test agents',
  agentKeys: [TEST_SUMMARIZE, TEST_RESEARCH],
  promptKeys: [TEST_SUMMARIZE, TEST_RESEARCH],
} as const satisfies SharedPlugin

/** The mocked shared barrel: the real module with the test plugin as its one installed plugin. */
export function withTestAgents<T extends object>(actual: T): T {
  return { ...actual, SHARED_PLUGINS: [TEST_AGENTS_SHARED], sharedPlugins: [TEST_AGENTS_SHARED] }
}
