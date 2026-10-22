/**
 * A test-only plugin that declares realtime TOPIC kinds (`SharedPlugin.realtimeTopics`), so a test
 * can drive the real hub over topics when the kit ships none and no installed plugin declares one.
 * Its subjects are CORE ones with different grants: `Document` is readable by every member,
 * `Trace` by owner/admin/support only — the pair that proves `/ws` hands the hub what this
 * member's role may read.
 *
 *     vi.mock('@rocketpod/shared/plugins', async importOriginal =>
 *       (await import('../helpers/test-topics-shared')).withTestTopics(await importOriginal())
 *     )
 *
 * Like `test-agents-shared.ts`, nothing here is a runtime import of a shared composer: the mock
 * factory loads this module while the barrel it replaces is being evaluated.
 */
import type { SharedPlugin } from '@rocketpod/shared/plugins'

export const TEST_TOPICS_SHARED = {
  id: 'test-topics',
  label: 'Test topics',
  realtimeTopics: [
    { prefix: 'test-topics.doc', subject: 'Document' },
    { prefix: 'test-topics.trace', subject: 'Trace' },
    { prefix: 'test-topics.platform', subject: 'Document', scope: 'platform' },
  ],
} as const satisfies SharedPlugin

/** The mocked shared barrel: the installed plugins plus the test one. */
export function withTestTopics<T extends { sharedPlugins: readonly SharedPlugin[] }>(actual: T): T {
  const plugins = [...actual.sharedPlugins, TEST_TOPICS_SHARED]
  return { ...actual, SHARED_PLUGINS: plugins, sharedPlugins: plugins }
}
