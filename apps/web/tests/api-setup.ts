/**
 * Per-FILE setup and teardown for the api projects. Setup: the network guard
 * (`helpers/network-guard.ts`). Teardown (`tests/setup.ts` is the per-RUN one): end every
 * pooled script handle so a fork's connection count does not climb file after file
 * (`53300 too many clients` is what that looks like). Handles are rebuilt on demand.
 *
 * `@/db/client` is imported LAZILY, at teardown: a static import here would evaluate the schema —
 * and through it `@rocketpod/shared/ai/agents` and the shared plugin barrel — before a test
 * file's `vi.mock` is registered, so a file mocking that barrel (the test-only agents,
 * `tests/helpers/test-agents.ts`) would be handed the real, already-cached module.
 */
import { afterAll, vi } from 'vitest'
import { installNetworkGuard } from './helpers/network-guard'

// No api test reaches the internet: a non-local request fails at once, naming its URL.
installNetworkGuard()

afterAll(async () => {
  // `api` shares a module registry, and Vitest undoes spies after each file but not stubs.
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  // A file's fake chat or decisions client must not answer the next file's calls.
  // (A file that mocks the module whole may not carry the setter.)
  const resolve = await import('@/api/services/ai/resolve')
  if (typeof resolve.overrideResolveChatForTests === 'function') {
    resolve.overrideResolveChatForTests(null)
  }
  if (typeof resolve.overrideResolveDecisionsForTests === 'function') {
    resolve.overrideResolveDecisionsForTests(null)
  }
  // Nor a file's fixture knowledge entity types be the next file's registry.
  const registry = await import('@/api/services/knowledge/registry')
  if (typeof registry.overrideKnowledgeEntityTypesForTests === 'function') {
    registry.overrideKnowledgeEntityTypesForTests(null)
  }
  const { closeAllDatabases } = await import('@/db/client')
  await closeAllDatabases()
})
