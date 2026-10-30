// @vitest-isolate
// Mocks `@/api/services/ai/resolve` (the chat provider seam) and runs OpenWorkflow workers against the
// test database in schemas of its own, so no other file's worker can claim these runs.
// Also mocks both plugin barrels to register the test-only agents (tests/helpers/test-agents.ts).
/**
 * Durable agent runs on Node (`src/node/runs.ts`): OpenWorkflow under the neutral `Step`.
 *
 * The engine, through a workflow written for the test: a completed step is not re-executed when a
 * second worker takes over a run whose lease lapsed (crash replay); a step retries in-process and
 * a final failure reaches the body's `catch` — the same error again on replay; a step times out;
 * `waitForEvent` parks (`waiting`), resumes on `sendEvent`, times out into the body's `catch`, and
 * skips the park when `arrived` says the answer already landed; an event sent BEFORE the run
 * reaches its wait is still delivered (signals are not buffered — the race `sendEvent` closes);
 * `terminate` stops a parked and a running run.
 *
 * The agent run itself, end to end: `enqueueRun` → the worker runs `runAgentRun` → `succeeded`;
 * an interrupt parks the run, the resolve-route sequence wakes it and it completes with the answer;
 * nobody answering expires the park `cancelled`; and a `runOnce` effect is not repeated by a replay.
 */
import { and, eq } from 'drizzle-orm'
import { OpenWorkflow } from 'openworkflow'
import { BackendPostgres } from 'openworkflow/postgres'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { listInterrupts, resolveInterrupt } from '@/api/services/agents/interrupts'
import { AGENTS, type AgentContext, type AnyAgentDefinition } from '@/api/services/agents/registry'
import {
  enqueueRun,
  getRun,
  nudgeOrRestartInstance,
  reconcileRun,
  resumeRun,
  runOnce,
} from '@/api/services/agents/runs'
import { AiError } from '@/api/services/ai/errors'
import type { ChatClient } from '@/api/services/ai/types'
import type { AppBindings } from '@/api/types'
import { loadConfig } from '@/config'
import { agentRunEffects } from '@/db/schema'
import { createNodePlatform } from '@/node/platform'
import {
  createNodeRuns,
  durationMs,
  mapRunStatus,
  type NodeRuns,
  openWorkflowInstance,
  openWorkflowStep,
  retryDelayMs,
} from '@/node/runs'
import { installRunsSchema } from '@/node/runs-schema'
import type { Platform, Step } from '@/platform/types'
import { FakeChatClient, type FakeScript } from '../helpers/ai'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase, testDatabaseUrl } from '../helpers/db'
import { TEST_SUMMARIZE } from '../helpers/test-agents-shared'

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
        provider: 'anthropic_compatible',
        model: 'fake-model',
        source: 'tenant',
        maxOutputTokens: 2048,
      }
    }),
  }
})

const db = setupTestDatabase()
const url = testDatabaseUrl()
const ENGINE_SCHEMA = `ow_engine_${process.pid}`
const AGENT_SCHEMA = `ow_agent_${process.pid}`
const rawEnv = {
  ...process.env,
  DATABASE_URL: url,
  RUNS_CONCURRENCY: '2',
  AGENT_INTERRUPT_TIMEOUT: '3 seconds',
}
const config = loadConfig(rawEnv)
const quiet = (m?: unknown) => {
  if (process.env.DEBUG_RUNS) console.log('[runs]', m)
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

const admin = postgres(url, { max: 1, onnotice: () => {} })

beforeAll(async () => {
  await installRunsSchema({ DATABASE_URL: url }, { schema: ENGINE_SCHEMA })
  await installRunsSchema({ DATABASE_URL: url }, { schema: AGENT_SCHEMA })
})

afterAll(async () => {
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${ENGINE_SCHEMA}" CASCADE`)
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${AGENT_SCHEMA}" CASCADE`)
  await admin.end({ timeout: 5 })
})

describe('the adapter’s pure parts', () => {
  it('parses durations and computes constant, linear and exponential backoff', () => {
    expect(durationMs(250)).toBe(250)
    expect(durationMs('10 seconds')).toBe(10_000)
    expect(durationMs('1 minute')).toBe(60_000)
    expect(durationMs('168 hours')).toBe(168 * 3_600_000)
    expect(() => durationMs('soon' as never)).toThrow(/invalid duration/)
    const policy = { limit: 3, delay: '10 seconds', backoff: 'exponential' } as const
    expect([1, 2, 3].map(n => retryDelayMs(policy, n))).toEqual([10_000, 20_000, 40_000])
    expect(retryDelayMs({ ...policy, backoff: 'linear' }, 3)).toBe(30_000)
    expect(retryDelayMs({ ...policy, backoff: 'constant' }, 3)).toBe(10_000)
  })

  it('maps OpenWorkflow statuses onto the vocabulary reconcileRun reads', () => {
    const base = { id: 'r', workerId: null, availableAt: null, error: null }
    const later = new Date(Date.now() + 60_000)
    expect(mapRunStatus({ ...base, status: 'pending' })).toEqual({ status: 'queued' })
    expect(mapRunStatus({ ...base, status: 'running', workerId: 'w', availableAt: later })).toEqual(
      {
        status: 'running',
      }
    )
    expect(mapRunStatus({ ...base, status: 'running', availableAt: later })).toEqual({
      status: 'waiting',
    })
    expect(mapRunStatus({ ...base, status: 'completed' })).toEqual({ status: 'complete' })
    expect(mapRunStatus({ ...base, status: 'canceled' })).toEqual({ status: 'terminated' })
    expect(
      mapRunStatus({ ...base, status: 'failed', error: { name: 'Boom', message: 'it broke' } })
    ).toEqual({ status: 'errored', error: { name: 'Boom', message: 'it broke' } })
  })
})

// ---- The engine, through a workflow written for the test ------------------------------------

describe('OpenWorkflow under the neutral Step', () => {
  const pools: postgres.Sql[] = []
  const clients: { ow: OpenWorkflow; backend: BackendPostgres }[] = []
  const workers: { stop(): Promise<void> }[] = []
  /** Every `do` callback execution, by step name. */
  let executions: Record<string, number>
  /** Per-test behaviour of the test workflow's steps. */
  let body: (step: Step) => Promise<unknown>

  function client() {
    const pool = postgres(url, {
      max: 6,
      onnotice: () => {},
      transform: { column: { from: postgres.toCamel } },
    })
    pools.push(pool)
    const backend = BackendPostgres.fromPool(pool, { schema: ENGINE_SCHEMA })
    const ow = new OpenWorkflow({ backend })
    const workflow = ow.defineWorkflow<Record<string, never>, unknown>(
      { name: 'engine-test', retryPolicy: { maximumAttempts: 1 } },
      ({ step, run }) => body(openWorkflowStep(step, { instanceId: run.id, sleep: async () => {} }))
    )
    const c = { ow, backend, workflow }
    clients.push(c)
    return c
  }

  async function startWorker(c: ReturnType<typeof client>) {
    const worker = c.ow.newWorker({ concurrency: 2 })
    await worker.start()
    workers.push(worker)
    return worker
  }

  const counted =
    <T>(name: string, fn: () => Promise<T>) =>
    () => {
      executions[name] = (executions[name] ?? 0) + 1
      return fn()
    }

  const runRow = (c: ReturnType<typeof client>, id: string) =>
    c.backend.getWorkflowRun({ workflowRunId: id })

  beforeEach(() => {
    executions = {}
  })

  afterEach(async () => {
    await Promise.all(workers.splice(0).map(w => w.stop()))
    await Promise.all(pools.splice(0).map(p => p.end({ timeout: 5 })))
    clients.splice(0)
  })

  it('a second worker replays a run whose lease lapsed: completed steps are not re-executed', async () => {
    const gate = deferred()
    let firstB = true
    body = async step => {
      const a = await step.do(
        'a',
        counted('a', async () => 'A')
      )
      const b = await step.do(
        'b',
        counted('b', async () => {
          if (firstB) {
            firstB = false
            await gate.promise // the "crashed" worker never gets past here in time
          }
          return 'B'
        })
      )
      return `${a}${b}`
    }
    const first = client()
    await startWorker(first)
    const handle = await first.workflow.run({})
    const id = handle.workflowRun.id
    await until(
      async () => executions.b ?? 0,
      n => n === 1
    )

    // The crash: the first worker's lease lapses (what a dead process leaves behind) and a second
    // worker claims the run and replays it from the top.
    await admin.unsafe(
      `UPDATE "${ENGINE_SCHEMA}".workflow_runs SET available_at = now() WHERE id = $1`,
      [id]
    )
    const second = client()
    await startWorker(second)
    const done = await until(
      () => runRow(second, id),
      run => run?.status === 'completed'
    )
    expect(done?.output).toBe('AB')
    expect(executions).toEqual({ a: 1, b: 2 })
    gate.resolve() // the stale branch finishes; its writes are fenced off
  })

  it('a step retries in-process; a final failure reaches the body’s catch, and replays the same error', async () => {
    let calls = 0
    body = async step => {
      const ok = await step.do(
        'flaky',
        { retries: { limit: 2, delay: '1 second', backoff: 'exponential' } },
        counted('flaky', async () => {
          calls += 1
          if (calls < 3) throw new Error(`attempt ${calls}`)
          return 'third time'
        })
      )
      let caught = ''
      try {
        await step.do(
          'doomed',
          { retries: { limit: 1, delay: '1 second' } },
          counted('doomed', async () => {
            throw new TypeError('never works')
          })
        )
      } catch (err) {
        if (step.isControlFlow?.(err)) throw err
        caught = `${(err as Error).name}: ${(err as Error).message}`
      }
      // A step after the catch forces nothing, but a replay of the whole body must not re-run
      // `doomed`: park once so the body is re-entered from the top.
      await step.waitForEvent('nudge', { type: 'nudge', timeout: '1 second' }).catch(err => {
        if (step.isControlFlow?.(err)) throw err
      })
      return { ok, caught }
    }
    const c = client()
    await startWorker(c)
    const handle = await c.workflow.run({})
    const done = await until(
      () => runRow(c, handle.workflowRun.id),
      run => run?.status === 'completed'
    )
    expect(done?.output).toEqual({ ok: 'third time', caught: 'TypeError: never works' })
    expect(executions).toEqual({ flaky: 3, doomed: 2 })
  })

  it('a step that outlives its timeout fails like any other error', async () => {
    body = async step => {
      try {
        await step.do(
          'slow',
          { retries: { limit: 0, delay: 0 }, timeout: 100 },
          () => new Promise(() => {})
        )
        return 'finished'
      } catch (err) {
        if (step.isControlFlow?.(err)) throw err
        return (err as Error).message
      }
    }
    const c = client()
    await startWorker(c)
    const handle = await c.workflow.run({})
    const done = await until(
      () => runRow(c, handle.workflowRun.id),
      run => run?.status === 'completed'
    )
    expect(done?.output).toMatch(/step "slow" timed out after 100 ms/)
  })

  it('waitForEvent parks (waiting), resumes on sendEvent, and a timeout reaches the body’s catch', async () => {
    body = async step => {
      const first = await step.waitForEvent('first', { type: 'go', timeout: '1 minute' })
      try {
        await step.waitForEvent('second', { type: 'go', timeout: '1 second' })
        return { first, second: 'delivered?' }
      } catch (err) {
        if (step.isControlFlow?.(err)) throw err
        return { first, second: (err as Error).message }
      }
    }
    const c = client()
    await startWorker(c)
    const id = (await c.workflow.run({})).workflowRun.id
    const instance = openWorkflowInstance(c.ow, c.backend, id)
    await until(
      () => instance.status(),
      s => s.status === 'waiting'
    )
    await instance.sendEvent({ type: 'go', payload: { answer: 42 } })
    const done = await until(
      () => runRow(c, id),
      run => run?.status === 'completed'
    )
    expect(done?.output).toEqual({
      first: { answer: 42 },
      second: expect.stringMatching(/wait_for_event_timeout/),
    })
    expect((await instance.status()).status).toBe('complete')
  })

  it('an event sent before the run reaches its wait is still delivered (signals are not buffered)', async () => {
    const reachWait = deferred()
    body = async step => {
      await step.do('work', () => reachWait.promise.then(() => 'worked'))
      return step.waitForEvent('answer', {
        type: 'go',
        timeout: '1 minute',
        arrived: async () => false,
      })
    }
    const c = client()
    await startWorker(c)
    const id = (await c.workflow.run({})).workflowRun.id
    const instance = openWorkflowInstance(c.ow, c.backend, id)
    await until(
      () => instance.status(),
      s => s.status === 'running'
    )
    // The answer is sent while the run is still inside `work` — nobody is waiting yet. Without the
    // re-send, OpenWorkflow would drop it and the run would sit parked for the full minute.
    const sending = instance.sendEvent({ type: 'go', payload: 'early' })
    await new Promise(resolve => setTimeout(resolve, 150))
    reachWait.resolve()
    await sending
    const done = await until(
      () => runRow(c, id),
      run => run?.status === 'completed'
    )
    expect(done?.output).toBe('early')
  })

  it('arrived → true skips the park entirely', async () => {
    body = async step => {
      await step.waitForEvent('answer', {
        type: 'go',
        timeout: '1 minute',
        arrived: counted('arrived', async () => true),
      })
      return 'went straight on'
    }
    const c = client()
    await startWorker(c)
    const id = (await c.workflow.run({})).workflowRun.id
    const done = await until(
      () => runRow(c, id),
      run => run?.status === 'completed'
    )
    expect(done?.output).toBe('went straight on')
    expect(executions.arrived).toBe(1)
  })

  it('terminate stops a parked run and a running one; status reads terminated', async () => {
    const stuck = deferred()
    body = async step => {
      const mode = await step.do('mode', async () => (executions.mode ? 'run' : 'park'))
      executions.mode = 1
      if (mode === 'park') return step.waitForEvent('never', { type: 'go', timeout: '1 hour' })
      await step.do('long', () => stuck.promise.then(() => 'done'))
      await step.do(
        'after',
        counted('after', async () => 'should not run')
      )
      return 'finished'
    }
    const c = client()
    await startWorker(c)
    const parked = openWorkflowInstance(c.ow, c.backend, (await c.workflow.run({})).workflowRun.id)
    await until(
      () => parked.status(),
      s => s.status === 'waiting'
    )
    await parked.terminate()
    expect((await parked.status()).status).toBe('terminated')

    const running = openWorkflowInstance(c.ow, c.backend, (await c.workflow.run({})).workflowRun.id)
    await until(
      () => running.status(),
      s => s.status === 'running'
    )
    await running.terminate()
    stuck.resolve()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect((await running.status()).status).toBe('terminated')
    expect(executions.after).toBeUndefined()
    // A terminal run is not waiting: sendEvent says so, and the caller restarts it.
    await expect(running.sendEvent({ type: 'go' })).rejects.toThrow(/canceled, not waiting/)
  })
})

// ---- The agent run, end to end ----------------------------------------------------------------

describe('agent runs on the Node worker', () => {
  let runs: NodeRuns
  let platform: Platform

  const TOOL_TURN = {
    toolUses: [
      {
        name: 'submit_summary',
        input: { summary: 'Volcanoes erupt.', keyPoints: ['Erupt'] },
      },
    ],
    usage: { inputTokens: 10, outputTokens: 5 },
  }
  const originalAgent = AGENTS[TEST_SUMMARIZE]

  function script(s: FakeScript) {
    state.client = new FakeChatClient(s, 'anthropic_compatible')
  }

  function installAgent(run: (ctx: AgentContext) => Promise<unknown>): void {
    AGENTS[TEST_SUMMARIZE] = {
      meta: { ...originalAgent.meta, inputSchema: z.any(), outputSchema: z.any() },
      run,
    } as AnyAgentDefinition
  }

  async function queuedRun(input: Record<string, unknown> = { text: 'Volcanoes erupt.' }) {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const { run } = await enqueueRun(db, platform, {
      tenantId: tenant.id,
      agentKey: TEST_SUMMARIZE,
      input,
      userId: user.id,
    })
    return { run, user, tenant }
  }

  const status = (tenantId: string, runId: string) => getRun(db, tenantId, runId)

  beforeAll(async () => {
    // Retries back off for real seconds in production; no test should wait on them.
    runs = createNodeRuns({ config, log: quiet, schema: AGENT_SCHEMA, sleep: async () => {} })
    platform = createNodePlatform(config, { runs: runs.engine })
    const env = { ...rawEnv, PLATFORM: platform } as AppBindings
    await runs.startWorker(env, platform)
  })

  afterAll(async () => {
    await runs.stop(5_000)
  })

  beforeEach(() => {
    state.client = null
  })

  afterEach(() => {
    AGENTS[TEST_SUMMARIZE] = originalAgent
  })

  it('enqueueRun → the worker runs the agent → succeeded; the instance reads complete', async () => {
    script([TOOL_TURN])
    const { run, tenant } = await queuedRun()
    expect(run.instanceId).toBeTruthy()
    const done = await until(
      () => status(tenant.id, run.id),
      row => row?.status === 'succeeded'
    )
    expect(done?.output).toMatchObject({ summary: 'Volcanoes erupt.' })
    // The row settles INSIDE `finish`; the engine marks the run completed just after it returns.
    const instance = await runs.engine.get(run.instanceId as string)
    await until(
      () => instance.status(),
      st => st.status === 'complete'
    )
    // reconcileRun leaves a settled row alone and agrees with the engine.
    expect((await reconcileRun(db, platform, done!)).status).toBe('succeeded')
  })

  it('an interrupt parks the run; the resolve-route sequence wakes it and it completes', async () => {
    script([])
    let entries = 0
    installAgent(async ctx => {
      entries += 1
      const answer = await ctx.interrupt({
        key: 'send-it',
        spec: { kind: 'approval', message: 'Send it?' },
      })
      return { entries, answer: answer.payload }
    })
    const { run, tenant, user } = await queuedRun()
    const parked = await until(
      () => status(tenant.id, run.id),
      row => row?.status === 'awaiting_input'
    )
    const instance = await runs.engine.get(parked?.instanceId as string)
    await until(
      () => instance.status(),
      s => s.status === 'waiting'
    )

    // What the resolve route does: write the answer, flip the row, THEN wake the instance.
    for (const row of await listInterrupts(db, tenant.id, run.id, 'pending')) {
      await resolveInterrupt(db, {
        tenantId: tenant.id,
        runId: run.id,
        interruptId: row.id,
        status: 'resolved',
        payload: { approved: true },
        resolvedByUserId: user.id,
      })
    }
    const resumed = await resumeRun(db, tenant.id, run.id)
    await nudgeOrRestartInstance(db, platform, resumed ?? (parked as NonNullable<typeof parked>), {
      interruptId: null,
    })

    const done = await until(
      () => status(tenant.id, run.id),
      row => row?.status === 'succeeded'
    )
    expect(done?.output).toEqual({ entries: 2, answer: { approved: true } })
    // Same instance throughout: it was woken, not restarted.
    expect(done?.instanceId).toBe(parked?.instanceId)
  })

  it('nobody answers: the park expires cancelled with a NULL error', async () => {
    script([])
    installAgent(async ctx => {
      await ctx.interrupt({ key: 'send-it', spec: { kind: 'approval', message: 'Send it?' } })
      return { never: true }
    })
    const { run, tenant } = await queuedRun()
    const done = await until(
      () => status(tenant.id, run.id),
      row => row?.status === 'cancelled',
      20_000
    )
    expect(done).toMatchObject({ status: 'cancelled', error: null })
    expect((await listInterrupts(db, tenant.id, run.id)).map(i => i.status)).toEqual(['expired'])
  })

  it('a runOnce effect is recorded once even when the step that wrote it runs again', async () => {
    script([])
    let sideEffects = 0
    let executions = 0
    installAgent(async ctx => {
      executions += 1
      await runOnce(ctx.db, ctx.tenantId, ctx.runId, 'send-email', async () => {
        sideEffects += 1
        return { sent: true }
      })
      // The first execution fails AFTER the effect: the step retries in-process and re-runs.
      if (executions === 1) throw new AiError('unavailable', 'anthropic_compatible', 'overloaded')
      return { executions }
    })
    const { run, tenant } = await queuedRun()
    await until(
      () => status(tenant.id, run.id),
      row => row?.status === 'succeeded' || row?.status === 'failed'
    )
    expect(executions).toBe(2)
    const effects = await db
      .select()
      .from(agentRunEffects)
      .where(and(eq(agentRunEffects.runId, run.id), eq(agentRunEffects.tenantId, tenant.id)))
    expect(effects).toHaveLength(1)
    expect(sideEffects).toBe(1)
  })
})
