// @vitest-isolate
// Mocks the AI resolve seam and both plugin barrels (the test-only agents), so this file needs its own module registry.
/**
 * What the RUNTIME gives a `runToolLoop` agent, driven through `claimStep` → `executeRun` against
 * Postgres with the test-only `test-research` agent (`tests/helpers/test-agents.ts`) and a
 * `FakeChatClient`. The loop itself is `agent-tool-loop-interrupt.test.ts`'s (no database); this
 * file is the wiring the loop cannot see:
 *
 * - **`ctx.checkpoint`**: a retryable failure mid-loop leaves the transcript on `agent_runs`, and
 *   the next `execute` attempt continues it instead of replaying (and re-billing) it; settling
 *   drops it; a stored value that does not parse starts the run fresh rather than failing it.
 * - **`ctx.approvals` + `runApproved: ctx.once`**: a gated tool parks the run with NOTHING written,
 *   and the approved call — with the approver's edited arguments — runs exactly once.
 */
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listArtifacts } from '@/api/services/agents/artifacts'
import { listInterrupts, resolveInterrupt } from '@/api/services/agents/interrupts'
import { enqueueRun, getRun, resumeRun } from '@/api/services/agents/runs'
import { claimStep, executeRun } from '@/api/services/agents/runtime'
import { AiError } from '@/api/services/ai/errors'
import { parseToolLoopCheckpoint } from '@/api/services/ai/kit'
import type { ChatClient } from '@/api/services/ai/types'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { agentRunEffects, agentRuns, aiUsage, documents } from '@/db/schema'
import { FakeChatClient, type FakeScript } from '../helpers/ai'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import {
  SAVE_NOTE_TOOL,
  SUBMIT_ANSWER_TOOL,
  TEST_RESEARCH,
  testResearchOutputSchema,
} from '../helpers/test-agents'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

vi.mock('@rocketpod/shared/plugins', async importOriginal =>
  (await import('../helpers/test-agents-shared')).withTestAgents(await importOriginal())
)
vi.mock('@/plugins/server', async () =>
  (await import('../helpers/test-agents')).testAgentsServerBarrel()
)

const state: { client: ChatClient | null } = { client: null }

vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  return {
    ...actual,
    resolveChat: vi.fn(async () => {
      if (!state.client) throw new AiError('auth', 'anthropic_compatible', 'no client scripted')
      return {
        client: state.client,
        provider: 'anthropic_compatible' as const,
        model: 'fake-model',
        source: 'tenant' as const,
        maxOutputTokens: 2048,
      }
    }),
  }
})

const db = setupTestDatabase()

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as Logger & typeof log
}

function script(s: FakeScript) {
  const client = new FakeChatClient(s, 'anthropic_compatible')
  state.client = client
  return client
}

/** Enqueue and claim — the workflow's first step — leaving the run ready for `execute`. */
async function claimed(env: TestEnv, topic: string) {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const { run } = await enqueueRun(db, env, {
    tenantId: tenant.id,
    agentKey: TEST_RESEARCH,
    input: { topic },
    userId: user.id,
  })
  const params = { runId: run.id, tenantId: tenant.id }
  expect(await claimStep(db, env, fakeLogger(), params)).toBe(true)
  return { user, tenant, params }
}

const execute = (env: TestEnv, params: { runId: string; tenantId: string }) =>
  executeRun(db, loadConfig(env), env, fakeLogger(), params)

beforeEach(() => {
  state.client = null
})

describe('ctx.checkpoint', () => {
  it('resumes a retried run from its checkpoint instead of replaying the conversation', async () => {
    const env = createTestEnv()
    // Attempt 1: one real search turn, then the provider falls over with a RETRYABLE fault — the
    // only way `executeRun` rethrows for a step retry.
    const first = script([
      {
        toolUses: [{ name: 'search_knowledge', input: { query: 'access requests' } }],
        usage: { inputTokens: 40, outputTokens: 10 },
      },
      { error: new AiError('unavailable', 'anthropic_compatible', 'provider overloaded') },
    ])
    const { tenant, params } = await claimed(env, 'Who reviews access requests?')
    await expect(execute(env, params)).rejects.toThrow(/overloaded/)
    expect(first.calls).toHaveLength(2)

    // The row is still active and carries the resume point for the one completed turn.
    const afterFailure = await db.query.agentRuns.findFirst({
      where: eq(agentRuns.id, params.runId),
    })
    expect(afterFailure?.status).toBe('running')
    const checkpoint = parseToolLoopCheckpoint(afterFailure?.checkpoint)
    expect(checkpoint?.turns).toBe(1)
    expect(checkpoint?.messages).toHaveLength(3)

    // Attempt 2: the model answers straight away.
    const second = script([
      {
        toolUses: [{ name: SUBMIT_ANSWER_TOOL, input: { answer: 'A global admin does.' } }],
        usage: { inputTokens: 60, outputTokens: 20 },
      },
    ])
    expect((await execute(env, params)).status).toBe('succeeded')

    // It did NOT replay turn 1: the very first request already carries the stored transcript.
    expect(second.calls[0]?.messages.slice(0, 3)).toEqual(checkpoint?.messages)
    const output = testResearchOutputSchema.parse(
      (await getRun(db, tenant.id, params.runId))?.output
    )
    // Turns carry forward, so `maxTurns` stays a budget for the RUN, not for each attempt.
    expect(output.turns).toBe(2)

    // Ledgered ONCE for the whole run, summing both attempts.
    const usage = await db.query.aiUsage.findMany({ where: eq(aiUsage.tenantId, tenant.id) })
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ inputTokens: 100, outputTokens: 30 })

    // Settling drops the checkpoint: nothing will resume, and the transcript is not a record.
    const settled = await db.query.agentRuns.findFirst({ where: eq(agentRuns.id, params.runId) })
    expect(settled?.checkpoint).toBeNull()
  })

  it('starts fresh when the stored checkpoint cannot be parsed, rather than failing the run', async () => {
    const env = createTestEnv()
    const client = script([
      { toolUses: [{ name: SUBMIT_ANSWER_TOOL, input: { answer: 'Fresh start.' } }] },
    ])
    const { params } = await claimed(env, 'Anything?')
    // A shape an older build might have written, or a corrupted value.
    await db
      .update(agentRuns)
      .set({ checkpoint: { nonsense: true } })
      .where(eq(agentRuns.id, params.runId))

    expect((await execute(env, params)).status).toBe('succeeded')
    // Fresh start = the seed first, not a resumed transcript.
    expect(client.calls[0]?.messages.slice(0, 1)).toEqual([
      { role: 'user', content: 'Research this: Anything?' },
    ])
  })
})

describe('a gated tool through the runtime (ctx.approvals, runApproved: ctx.once)', () => {
  it('parks with NOTHING written, then the approved call runs once with the edited arguments', async () => {
    const env = createTestEnv()
    const client = script([
      {
        toolUses: [
          { name: SAVE_NOTE_TOOL, input: { title: 'Access SLA', text: 'Two working days.' } },
        ],
        usage: { inputTokens: 9, outputTokens: 3 },
      },
      {
        toolUses: [{ name: SUBMIT_ANSWER_TOOL, input: { answer: 'Saved.' } }],
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    ])
    const { user, tenant, params } = await claimed(env, 'access SLA')
    const docs = () => db.select().from(documents).where(eq(documents.tenantId, tenant.id))

    expect((await execute(env, params)).status).toBe('awaiting_input')
    const [gate] = await listInterrupts(db, tenant.id, params.runId, 'pending')
    expect(gate?.key).toMatch(/^tool:/)
    expect(gate?.spec).toMatchObject({
      kind: 'approval',
      tool: { name: SAVE_NOTE_TOOL, allowEdits: true },
      onReject: 'tell_model',
    })
    // The gate raises BEFORE any handler runs: the write has not happened.
    expect(await docs()).toEqual([])
    expect(client.calls).toHaveLength(1)

    // Approve with the arguments edited — `allowEdits` is why that is allowed at all — then
    // resume the way the route and the workflow do.
    await resolveInterrupt(db, {
      tenantId: tenant.id,
      runId: params.runId,
      interruptId: gate?.id as string,
      status: 'resolved',
      payload: { editedInput: { title: 'Access SLA (checked)', text: 'Two working days.' } },
      resolvedByUserId: user.id,
    })
    await resumeRun(db, tenant.id, params.runId)
    expect((await execute(env, params)).status).toBe('succeeded')

    const saved = await docs()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      title: 'Access SLA (checked)',
      source: `agent:${TEST_RESEARCH}`,
    })
    // `runApproved: ctx.once` is the ledger entry that stops a step retry writing it twice.
    const effects = await db.query.agentRunEffects.findMany({
      where: eq(agentRunEffects.runId, params.runId),
    })
    expect(effects.filter(e => e.key.startsWith('tool:'))).toHaveLength(1)
    expect((await listArtifacts(db, tenant.id, params.runId)).map(a => [a.key, a.kind])).toEqual([
      [`note:${saved[0]?.id}`, 'document'],
      ['answer', 'markdown'],
    ])
  })
})
