// @vitest-isolate
// Mocks `@/api/services/ai/resolve` (the chat provider seam), so this file needs its own module registry.
/**
 * `research-topic` — the agentic agent, driven through the real runtime against Postgres
 * with a `FakeChatClient` scripting the turns and a really-ingested document behind
 * `search_knowledge`: the loop searches, then calls the terminal `submit_answer`; the run succeeds
 * with the answer, the citation resolved to the real document, `ai_usage` summed over both turns
 * and the tool events persisted. Also the two decisions in the agent's header: a citation naming a
 * document search never returned is DROPPED, and a loop that ends in prose is salvaged by one
 * forced `submit_answer` call instead of failing.
 *
 * Plus what this agent adds to the runtime's resume contract: the documents a first attempt's
 * searches found are folded back out of the resumed transcript, so their citations are not dropped
 * as hallucinations. The contract itself (checkpoint, no replay, usage once, a gated tool parks with
 * nothing written) is the runtime's, in `agent-tool-loop-runtime.test.ts` on a test-only agent.
 *
 * And the two human-in-the-loop shapes this agent exists to demonstrate: `ask_human`
 * raising a `choice` interrupt from INSIDE a tool handler, and `index_finding` gated by
 * `Tool.requiresApproval` with edits allowed, saving the approved finding as a document artifact.
 */
import { researchTopicOutputSchema } from '@rocketpod/shared/ai/agents'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listArtifacts } from '@/api/services/agents/artifacts'
import { listInterrupts, resolveInterrupt } from '@/api/services/agents/interrupts'
import { enqueueRun, getRun, listEvents, resumeRun } from '@/api/services/agents/runs'
import { claimStep, executeRun } from '@/api/services/agents/runtime'
import { AiError } from '@/api/services/ai/errors'
import { ingestText } from '@/api/services/ai/ingest'
import type { ChatClient } from '@/api/services/ai/types'
import type { Logger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { aiUsage, documents } from '@/db/schema'
import { FakeChatClient, type FakeScript } from '../helpers/ai'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

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

/** A tenant with one indexed document — what `search_knowledge` will find. */
async function tenantWithDocument(env: TestEnv) {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const { document } = await ingestText(db, loadConfig(env), env, {
    tenantId: tenant.id,
    userId: user.id,
    title: 'Onboarding handbook',
    text: 'Access requests are reviewed by a global admin within two working days.',
    source: 'test',
  })
  return { user, tenant, document }
}

/** Enqueue and run the agent through claim → execute (the workflow steps' bodies). */
async function runResearch(env: TestEnv, tenantId: string, userId: string, topic: string) {
  const params = await enqueueRun(db, env, {
    tenantId,
    agentKey: 'research-topic',
    input: { topic },
    userId,
  }).then(r => ({ runId: r.run.id, tenantId }))
  const logger = fakeLogger()
  expect(await claimStep(db, env, logger, params)).toBe(true)
  const outcome = await executeRun(db, loadConfig(env), env, logger, params)
  return { outcome, runId: params.runId }
}

function script(s: FakeScript) {
  const client = new FakeChatClient(s, 'anthropic_compatible')
  state.client = client
  return client
}

/** Answer the run's one pending ask and re-enter `execute` — what the route + workflow do. */
async function answerAndReExecute(
  env: TestEnv,
  tenantId: string,
  runId: string,
  userId: string,
  payload: unknown,
  status: 'resolved' | 'cancelled' = 'resolved'
) {
  const [pending] = await listInterrupts(db, tenantId, runId, 'pending')
  if (!pending) throw new Error('nothing pending to answer')
  await resolveInterrupt(db, {
    tenantId,
    runId,
    interruptId: pending.id,
    status,
    payload,
    resolvedByUserId: userId,
  })
  await resumeRun(db, tenantId, runId)
  return {
    pending,
    outcome: await executeRun(db, loadConfig(env), env, fakeLogger(), { runId, tenantId }),
  }
}

beforeEach(() => {
  state.client = null
})

describe('research-topic agent', () => {
  it('searches the knowledge base, then answers through the terminal tool with a verified citation', async () => {
    const env = createTestEnv()
    const { tenant, user, document } = await tenantWithDocument(env)
    const client = script([
      {
        toolUses: [{ name: 'search_knowledge', input: { query: 'access requests' } }],
        usage: { inputTokens: 40, outputTokens: 10 },
      },
      {
        toolUses: [
          {
            name: 'submit_answer',
            input: {
              answer: 'A global admin reviews them within two working days.',
              citations: [{ documentId: document.id, title: 'whatever the model called it' }],
            },
          },
        ],
        usage: { inputTokens: 60, outputTokens: 20 },
      },
    ])

    const { outcome, runId } = await runResearch(
      env,
      tenant.id,
      user.id,
      'Who reviews access requests?'
    )

    expect(outcome.status).toBe('succeeded')
    const row = await getRun(db, tenant.id, runId)
    const output = researchTopicOutputSchema.parse(row?.output)
    expect(output.answer).toContain('two working days')
    // The title comes from the search hit, never from the model.
    expect(output.citations).toEqual([{ documentId: document.id, title: 'Onboarding handbook' }])
    expect(output.turns).toBe(2)

    // The search really ran: the model was given the built-in tools and got hits back. An
    // installed plugin's tools arrive on `ctx.tools` too, between the three built-in ones and the
    // agent's own, so the assertion is "these, in this order, all present" rather than equality.
    const offered = client.calls[0]?.tools?.map(t => t.name) ?? []
    expect(offered.slice(0, 3)).toEqual(['search_knowledge', 'get_document', 'list_documents'])
    expect(offered.slice(-3)).toEqual(['ask_human', 'index_finding', 'submit_answer'])
    const events = await listEvents(db, tenant.id, runId)
    const toolNames = events
      .filter(e => e.type === 'tool.start' || e.type === 'tool.end')
      .map(e => (e.data as { name: string }).name)
    // One start + one end for the real tool; the TERMINAL tool emits nothing (its call is the
    // answer, which the output panel renders — emitting it showed the answer three times over).
    expect(toolNames).toEqual(['search_knowledge', 'search_knowledge'])
    expect(events.some(e => e.type === 'text')).toBe(false)

    // Usage is the sum of both turns, under the agent's feature key.
    const usage = await db.query.aiUsage.findMany({ where: eq(aiUsage.tenantId, tenant.id) })
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({
      feature: 'agent:research-topic',
      inputTokens: 100,
      outputTokens: 30,
    })
  })

  it('drops a citation naming a document the search never returned', async () => {
    const env = createTestEnv()
    const { tenant, user } = await tenantWithDocument(env)
    script([
      {
        toolUses: [
          {
            name: 'submit_answer',
            input: {
              answer: 'Answered without looking anything up.',
              citations: [{ documentId: crypto.randomUUID(), title: 'Invented source' }],
            },
          },
        ],
      },
    ])

    const { outcome, runId } = await runResearch(env, tenant.id, user.id, 'Anything at all?')

    expect(outcome.status).toBe('succeeded')
    const output = researchTopicOutputSchema.parse((await getRun(db, tenant.id, runId))?.output)
    expect(output.citations).toEqual([])
  })

  it('salvages a loop that ends in prose with one forced submit_answer call', async () => {
    const env = createTestEnv()
    const { tenant, user } = await tenantWithDocument(env)
    // Turn 1: prose, no tool call — `runToolLoop` returns `no_tool_call`. Turn 2 is the forced
    // recovery call `callStructuredTool` makes with `toolChoice: { type: 'tool' }`.
    const client = script([
      { text: 'Global admins review them within two working days.' },
      {
        toolUses: [
          {
            name: 'submit_answer',
            input: { answer: 'Global admins review them within two working days.', citations: [] },
          },
        ],
      },
    ])

    const { outcome, runId } = await runResearch(
      env,
      tenant.id,
      user.id,
      'Who reviews access requests?'
    )

    expect(outcome.status).toBe('succeeded')
    expect(client.calls[1]?.toolChoice).toEqual({ type: 'tool', name: 'submit_answer' })
    // Two ledger rows: the loop is written as soon as its tokens are spent, the recovery from its
    // own `onUsage` — so a recovery that FAILED would still leave the loop's tokens recorded.
    const usage = await db.query.aiUsage.findMany({ where: eq(aiUsage.tenantId, tenant.id) })
    expect(usage).toHaveLength(2)
    expect(usage.every(u => u.feature === 'agent:research-topic')).toBe(true)
    const output = researchTopicOutputSchema.parse((await getRun(db, tenant.id, runId))?.output)
    expect(output.answer).toContain('two working days')
    expect(output.turns).toBe(2) // the loop's one turn plus the recovery call

    const steps = (await listEvents(db, tenant.id, runId))
      .filter(e => e.type === 'step')
      .map(e => e.data as { key: string; status: string; detail?: string })
    expect(steps.some(s => s.key === 'answer' && s.detail?.includes('no_tool_call'))).toBe(true)
  })

  it('keeps a citation found before a retry: `seen` is rebuilt from the resumed transcript', async () => {
    const env = createTestEnv()
    const { tenant, user, document } = await tenantWithDocument(env)
    const logger = fakeLogger()

    // Attempt 1: one real search turn, then the provider falls over with a RETRYABLE fault, which
    // is the only way `executeRun` rethrows for a step retry.
    const first = script([
      {
        toolUses: [{ name: 'search_knowledge', input: { query: 'access requests' } }],
        usage: { inputTokens: 40, outputTokens: 10 },
      },
      { error: new AiError('unavailable', 'anthropic_compatible', 'provider overloaded') },
    ])
    const { run } = await enqueueRun(db, env, {
      tenantId: tenant.id,
      agentKey: 'research-topic',
      input: { topic: 'Who reviews access requests?' },
      userId: user.id,
    })
    const params = { runId: run.id, tenantId: tenant.id }
    expect(await claimStep(db, env, logger, params)).toBe(true)
    await expect(executeRun(db, loadConfig(env), env, logger, params)).rejects.toThrow(/overloaded/)
    expect(first.calls).toHaveLength(2)

    // Attempt 2: the model answers straight away, citing the document the FIRST attempt found.
    script([
      {
        toolUses: [
          {
            name: 'submit_answer',
            input: {
              answer: 'A global admin reviews them within two working days.',
              citations: [{ documentId: document.id, title: 'the model’s own wording' }],
            },
          },
        ],
        usage: { inputTokens: 60, outputTokens: 20 },
      },
    ])
    const outcome = await executeRun(db, loadConfig(env), env, logger, params)
    expect(outcome.status).toBe('succeeded')

    const output = researchTopicOutputSchema.parse((await getRun(db, tenant.id, run.id))?.output)
    // The document the FIRST attempt found counts as seen on the second.
    expect(output.citations).toEqual([{ documentId: document.id, title: 'Onboarding handbook' }])
  })

  it('ask_human raises a choice interrupt from inside its handler, and the re-entered handler finds the ANSWER', async () => {
    const env = createTestEnv()
    const { tenant, user } = await tenantWithDocument(env)
    const question = 'Do you mean the UK onboarding process or the US one?'
    const ask = {
      toolUses: [{ name: 'ask_human', input: { question, options: ['UK', 'US'] } }],
      usage: { inputTokens: 10, outputTokens: 4 },
    }
    // Turn 1 asks. The park loses the turn's checkpoint (a handler-raised interrupt throws before
    // the loop checkpoints), so the resumed attempt asks the model again and it asks again too —
    // which is exactly the case `(run_id, key)` exists for.
    const client = script([
      ask,
      ask,
      {
        toolUses: [
          {
            name: 'submit_answer',
            input: { answer: 'The US process.', citations: [] },
          },
        ],
        usage: { inputTokens: 12, outputTokens: 6 },
      },
    ])

    const { outcome, runId } = await runResearch(env, tenant.id, user.id, 'onboarding')
    expect(outcome.status).toBe('awaiting_input')
    const [parked] = await listInterrupts(db, tenant.id, runId, 'pending')
    expect(parked).toMatchObject({
      key: `ask-human:${question}`,
      kind: 'choice',
      status: 'pending',
    })
    const spec = parked?.spec as { options: { value: string }[] } | undefined
    expect(spec?.options.map(o => o.value)).toEqual(['UK', 'US'])
    expect(await getRun(db, tenant.id, runId)).toMatchObject({ status: 'awaiting_input' })

    const { outcome: resumed } = await answerAndReExecute(env, tenant.id, runId, user.id, {
      value: 'US',
    })
    expect(resumed.status).toBe('succeeded')
    // ONE row, not two: the second `ask_human` call landed on the same `(run_id, key)` and read the
    // answer instead of opening a second question (T2).
    expect(await listInterrupts(db, tenant.id, runId)).toHaveLength(1)
    // …and the model was told what the person said.
    const transcript = JSON.stringify(client.calls[2]?.messages ?? [])
    expect(transcript).toContain('The person answered: US.')
  })

  it('index_finding is gated with edits allowed, and the approved call saves the edited finding', async () => {
    const env = createTestEnv()
    const { tenant, user } = await tenantWithDocument(env)
    script([
      {
        toolUses: [
          {
            name: 'index_finding',
            input: { title: 'Access SLA', text: 'Access requests take two working days.' },
          },
        ],
        usage: { inputTokens: 9, outputTokens: 3 },
      },
      {
        toolUses: [{ name: 'submit_answer', input: { answer: 'Saved.', citations: [] } }],
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    ])
    const before = await db.select().from(documents).where(eq(documents.tenantId, tenant.id))

    const { outcome, runId } = await runResearch(env, tenant.id, user.id, 'access SLA')
    expect(outcome.status).toBe('awaiting_input')
    const [gate] = await listInterrupts(db, tenant.id, runId, 'pending')
    expect(gate).toMatchObject({ kind: 'approval', status: 'pending' })
    expect(gate?.key).toMatch(/^tool:/)
    expect(gate?.spec).toMatchObject({
      kind: 'approval',
      tool: { name: 'index_finding', allowEdits: true },
      onReject: 'tell_model',
    })
    // Approve, with the arguments edited — `allowEdits` is why that is allowed at all.
    const { outcome: resumed } = await answerAndReExecute(env, tenant.id, runId, user.id, {
      editedInput: { title: 'Access SLA (checked)', text: 'Two working days.' },
    })
    expect(resumed.status).toBe('succeeded')

    const after = await db.select().from(documents).where(eq(documents.tenantId, tenant.id))
    expect(after).toHaveLength(before.length + 1)
    const saved = after.find(d => !before.some(b => b.id === d.id))
    expect(saved).toMatchObject({ title: 'Access SLA (checked)', source: 'agent:research-topic' })
    const artifacts = await listArtifacts(db, tenant.id, runId)
    expect(artifacts.map(a => [a.key, a.kind])).toEqual([
      [`finding:${saved?.id}`, 'document'],
      ['answer', 'markdown'],
    ])
  })
})
