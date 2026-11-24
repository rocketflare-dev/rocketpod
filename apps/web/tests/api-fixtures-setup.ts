/**
 * Setup for the `api-fixtures` project only, which runs BEFORE `api-setup.ts`: installs the
 * test-only agents (`helpers/test-agents.ts` — `test-summarize`, `test-research`) into the REAL
 * plugin barrels, in place, before anything that derives from them at module load is imported —
 * the agent-key enum (`z.enum(AGENT_KEYS)`), the `AGENTS` and prompt registries, the job handler
 * table.
 *
 * The project shares one module registry per worker, so this runs once per FILE but installs once
 * per WORKER: the barrels it changed stay cached, and every file in the project sees the same app
 * — the installed plugins plus the test one. That is why the test agents live in a project of
 * their own and not in `api`, whose files see the app as it ships.
 *
 * The shared barrel first, and alone: nothing in its graph reads the composed agent keys, so the
 * test plugin is in `sharedPlugins` before the server barrel's graph builds `z.enum(AGENT_KEYS)`.
 * Nothing in the server barrel's graph reads `serverPlugins` at module scope either (it would find
 * the barrel uninitialised), so its push is early enough for `AGENTS`, the prompts and the jobs.
 * `test-agents.ts` imports nothing at runtime that reads a barrel (its kit imports are lazy).
 */
import type { SharedPlugin } from '@rocketpod/shared/plugins'
import type { AnyServerPlugin } from '@/plugins/server'
import { TEST_AGENTS_SERVER } from './helpers/test-agents'
import { TEST_AGENTS_SHARED } from './helpers/test-agents-shared'

// Dynamic, and in this order: a static import is hoisted above the push, and the server barrel's
// graph evaluates the agent-key enum from the shared barrel as it stands at that moment.
const { sharedPlugins } = await import('@rocketpod/shared/plugins')
const shared = sharedPlugins as SharedPlugin[]
if (!shared.includes(TEST_AGENTS_SHARED)) shared.push(TEST_AGENTS_SHARED)

const { serverPlugins } = await import('@/plugins/server')
const server = serverPlugins as AnyServerPlugin[]
const testServer = TEST_AGENTS_SERVER as unknown as AnyServerPlugin
if (!server.includes(testServer)) server.push(testServer)
