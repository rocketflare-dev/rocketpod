/**
 * Per-FILE teardown for the api projects (`tests/setup.ts` is the per-RUN one): end every
 * pooled script handle so a fork's connection count does not climb file after file
 * (`53300 too many clients` is what that looks like). Handles are rebuilt on demand.
 *
 * `@/db/client` is imported LAZILY, at teardown: a static import here would evaluate the schema —
 * and through it `@rocketpod/shared/ai/agents` and the shared plugin barrel — before a test
 * file's `vi.mock` is registered, so a file mocking that barrel (the test-only agents,
 * `tests/helpers/test-agents.ts`) would be handed the real, already-cached module.
 */
import { afterAll } from 'vitest'

afterAll(async () => {
  const { closeAllDatabases } = await import('@/db/client')
  await closeAllDatabases()
})
