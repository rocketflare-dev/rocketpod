// @vitest-isolate
// Mocks the agent registry and both plugin barrels (the test-only agents), so this file needs its own module registry.
/**
 * The exclusive SLOT a run holds (D7) — `agent_runs.concurrency_key`, which the partial unique
 * index reads:
 * - `meta.exclusive: false` — an agent that holds one person's conversation, where several people
 *   mid-way at once is the normal case — holds NO slot (NULL): every enqueue is a run of its own,
 *   never `deduplicated`, while an exclusive agent's second enqueue still answers the first run.
 * - an exclusive agent holds the tenant-wide slot `''`.
 * - a caller's `enqueueRun({ concurrencyKey })` narrows the slot to one active run per key, for
 *   either kind of agent.
 *
 * Driven through the test-only agents (`tests/helpers/test-agents.ts`): `test-summarize` is made
 * non-exclusive here by mocking the registry's `getAgent` — the only place `enqueueRun` reads the
 * definition from.
 */
import { createAgentRunResponseSchema } from '@rocketpod/shared/ai/agents'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { enqueueRun } from '@/api/services/agents/runs'
import { loadConfig } from '@/config'
import { agentRuns } from '@/db/schema'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { TEST_RESEARCH, TEST_SUMMARIZE } from '../helpers/test-agents-shared'
import { createTestEnv, stubs } from '../mocks/bindings'

vi.mock('@rocketpod/shared/plugins', async importOriginal =>
  (await import('../helpers/test-agents-shared')).withTestAgents(await importOriginal())
)
vi.mock('@/plugins/server', async () =>
  (await import('../helpers/test-agents')).testAgentsServerBarrel()
)

vi.mock('@/api/services/agents/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/agents/registry')>()
  return {
    ...actual,
    getAgent: (key: Parameters<typeof actual.getAgent>[0]) => {
      const agent = actual.getAgent(key)
      return (key as string) === 'test-summarize'
        ? { ...agent, meta: { ...agent.meta, exclusive: false } }
        : agent
    },
  }
})

const db = setupTestDatabase()

const start = (
  cookie: Record<string, string>,
  env: ReturnType<typeof createTestEnv>,
  agentKey: string,
  input: unknown
) =>
  request(
    '/api/agents/runs?strict=1',
    { method: 'POST', headers: cookie },
    { env, json: { agentKey, input } }
  )

describe('non-exclusive agents', () => {
  it('two active runs of one agent in one tenant, each its own slot-less row and Workflow instance', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const env = createTestEnv()

    const first = await start(cookie, env, TEST_SUMMARIZE, { text: 'First text.' })
    const second = await start(cookie, env, TEST_SUMMARIZE, { text: 'Second text.' })
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    const a = createAgentRunResponseSchema.parse(await json(first))
    const b = createAgentRunResponseSchema.parse(await json(second))
    expect(b.id).not.toBe(a.id)
    expect(b.deduplicated).toBe(false)
    expect(stubs(env).workflow?.created).toHaveLength(2)

    const rows = await db
      .select({ concurrencyKey: agentRuns.concurrencyKey, status: agentRuns.status })
      .from(agentRuns)
      .where(and(eq(agentRuns.tenantId, tenant.id), eq(agentRuns.agentKey, TEST_SUMMARIZE)))
    expect(rows).toEqual([
      { concurrencyKey: null, status: 'queued' },
      { concurrencyKey: null, status: 'queued' },
    ])
  })

  it('an exclusive agent beside it keeps the guarantee: the row holds the tenant slot, and a second enqueue is refused', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const env = createTestEnv()

    const first = await start(cookie, env, TEST_RESEARCH, { topic: 'Volcanoes' })
    expect(first.status).toBe(202)
    const run = createAgentRunResponseSchema.parse(await json(first))
    const [row] = await db
      .select({ concurrencyKey: agentRuns.concurrencyKey })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id))
    expect(row?.concurrencyKey).toBe('')

    const again = await start(cookie, env, TEST_RESEARCH, { topic: 'Glaciers' })
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({
      code: 'agent_run_active',
      details: { runId: run.id },
    })
  })
})

describe('per-key slots (enqueueRun({ concurrencyKey }))', () => {
  it('a non-exclusive agent with a key: one active run per key, a second enqueue deduplicated onto it', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const env = createTestEnv()
    const enqueue = (concurrencyKey: string, text: string) =>
      enqueueRun(db, loadConfig(env), env, {
        tenantId: tenant.id,
        agentKey: TEST_SUMMARIZE,
        input: { text },
        userId: user.id,
        concurrencyKey,
      })

    const k1 = await enqueue('k1', 'First.')
    const k1Again = await enqueue('k1', 'Second.')
    const k2 = await enqueue('k2', 'Third.')

    expect(k1.deduplicated).toBe(false)
    expect(k1Again).toMatchObject({ deduplicated: true, run: { id: k1.run.id } })
    expect(k2.deduplicated).toBe(false)
    expect(k2.run.id).not.toBe(k1.run.id)
    expect(stubs(env).workflow?.created).toHaveLength(2)
  })

  it('an exclusive agent with a key narrows from the tenant-wide slot to one per key', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const env = createTestEnv()
    const enqueue = (concurrencyKey: string | undefined, topic: string) =>
      enqueueRun(db, loadConfig(env), env, {
        tenantId: tenant.id,
        agentKey: TEST_RESEARCH,
        input: { topic },
        userId: user.id,
        ...(concurrencyKey === undefined ? {} : { concurrencyKey }),
      })

    const tenantWide = await enqueue(undefined, 'Volcanoes')
    const k1 = await enqueue('k1', 'Glaciers')
    const k2 = await enqueue('k2', 'Rivers')
    const k1Again = await enqueue('k1', 'Deserts')
    const tenantWideAgain = await enqueue(undefined, 'Oceans')

    // Three slots, three active runs of one exclusive agent in one tenant.
    expect([tenantWide, k1, k2].map(r => r.deduplicated)).toEqual([false, false, false])
    expect(new Set([tenantWide.run.id, k1.run.id, k2.run.id]).size).toBe(3)
    // A second enqueue into an occupied slot answers THAT slot's run, not another key's.
    expect(k1Again).toMatchObject({ deduplicated: true, run: { id: k1.run.id } })
    expect(tenantWideAgain).toMatchObject({ deduplicated: true, run: { id: tenantWide.run.id } })

    const rows = await db
      .select({ id: agentRuns.id, concurrencyKey: agentRuns.concurrencyKey })
      .from(agentRuns)
      .where(and(eq(agentRuns.tenantId, tenant.id), eq(agentRuns.agentKey, TEST_RESEARCH)))
    expect(Object.fromEntries(rows.map(r => [r.id, r.concurrencyKey]))).toEqual({
      [tenantWide.run.id]: '',
      [k1.run.id]: 'k1',
      [k2.run.id]: 'k2',
    })
  })
})
