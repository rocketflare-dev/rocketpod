/**
 * Durable agent runs on OpenWorkflow. The run BODY is `runAgentRun`
 * (`api/workflows/agent-run-body.ts`), written against the neutral `Step`; this file is the
 * engine under it on Node:
 *
 * - `RunEngine` — `create` starts an OpenWorkflow run (the requested id becomes its idempotency
 *   key; the engine's own id is what the caller stores as `agent_runs.instanceId`), `get` reads
 *   it, and the instance maps OpenWorkflow's statuses onto the vocabulary `reconcileRun` reads.
 * - `openWorkflowStep` — the neutral `Step` over OpenWorkflow's `StepApi`. Two differences are
 *   absorbed here rather than in the body:
 *   1. **Retries happen INSIDE one step.** OpenWorkflow retries a failed step by rescheduling the
 *      whole run; a body that catches the failure (ours does, to settle the row) would see the
 *      first one and never retry. So `do` runs `fn` with the step's own retry policy in-process,
 *      and records a FINAL failure as the step's result — a replay then throws the same error
 *      instead of running a step that already gave up.
 *   2. **A park is a throw.** OpenWorkflow suspends a run by throwing out of `waitForSignal`;
 *      `isControlFlow` names those errors so the body rethrows them (`Step.isControlFlow`).
 * - **Signals are not buffered** — one sent while nobody waits is dropped. The body hands
 *   `waitForEvent` an `arrived` check (the row already left `awaiting_input`), run once as a
 *   checkpointed step before parking; and `sendEvent` re-sends for a few seconds until the run
 *   reports receiving it, stops if the run is over, and gives up quietly if the run moved on.
 *
 * The worker runs in `worker`/`all` modes (`RUNS_CONCURRENCY`). The `openworkflow` schema is
 * installed by `pnpm db:migrate` (`installRunsSchema`, `runs-schema.ts`), never at boot.
 * OpenWorkflow gets its own small postgres.js pool — it reserves a connection per transaction and
 * must not starve the app's.
 */
import { OpenWorkflow, type Worker } from 'openworkflow'
import { BackendPostgres } from 'openworkflow/postgres'
import postgres from 'postgres'
import type { AppBindings } from '../api/types'
import { runAgentRun } from '../api/workflows/agent-run-body'
import type { AppConfig } from '../config'
import { resolveDatabaseUrl } from '../db/client'
import type {
  Duration,
  Platform,
  RunEngine,
  RunInstance,
  RunStatus,
  Step,
  StepOptions,
  WaitForEventOptions,
} from '../platform/types'

import { AGENT_RUN_WORKFLOW_NAME, RUNS_SCHEMA } from './runs-schema'

export { AGENT_RUN_WORKFLOW_NAME, RUNS_SCHEMA }

/** OpenWorkflow's error names that steer a run rather than report a failure. */
const CONTROL_FLOW_ERRORS = new Set([
  'SleepSignalError',
  'StaleExecutionBranchError',
  'StepError',
  'StepLimitExceededError',
])

/** The policy of a `step.do` with no options: 5 retries, 10 s doubling; a 10-minute timeout. */
const DEFAULT_RETRIES = { limit: 5, delay: '10 seconds', backoff: 'exponential' } as const
const DEFAULT_TIMEOUT: Duration = '10 minutes'
/** How long `sendEvent` keeps re-sending a signal nobody has received yet. */
const SEND_EVENT_WINDOW_MS = 5_000
const SEND_EVENT_INTERVAL_MS = 100

const UNIT_MS: Record<string, number> = {
  millisecond: 1,
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
}

/** `Duration` → milliseconds: a number already is; `'<n> <unit>'` is parsed (`'10 seconds'`). */
export function durationMs(value: Duration | string): number {
  if (typeof value === 'number') return value
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+?)s?\s*$/i.exec(value)
  const unit = match?.[2]?.toLowerCase()
  const ms = unit ? UNIT_MS[unit] : undefined
  if (!match || ms === undefined) throw new Error(`invalid duration "${value}"`)
  return Number(match[1]) * ms
}

/** The delay before retry `n` (1-based) under the policy's backoff (constant, linear, doubling). */
export function retryDelayMs(policy: NonNullable<StepOptions['retries']>, n: number): number {
  const base = durationMs(policy.delay)
  if (policy.backoff === 'constant') return base
  if (policy.backoff === 'linear') return base * n
  return base * 2 ** (n - 1)
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function withTimeout<T>(name: string, ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`step "${name}" timed out after ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** What a step that ran out of retries records instead of a value (see the header, point 1). */
interface StepFailure {
  __stepFailed: { name: string; message: string }
}

function isStepFailure(value: unknown): value is StepFailure {
  return typeof value === 'object' && value !== null && '__stepFailed' in value
}

/** The minimum of OpenWorkflow's `StepApi` the adapter uses (structural, so tests can fake it). */
export interface OpenWorkflowStepApi {
  run<Output>(
    config: { name: string; retryPolicy?: { maximumAttempts?: number } },
    fn: () => Promise<Output>
  ): Promise<Output>
  waitForSignal<Output>(options: {
    name?: string
    signal: string
    timeout?: number | string | Date
  }): Promise<{ data: Output } | null>
}

export interface StepAdapterOptions {
  /** The run's own id — signals are addressed `<id>:<type>`. */
  instanceId: string
  /** Replace the retry sleep (tests). */
  sleep?: (ms: number) => Promise<void>
}

/** The signal a run waiting for `type` listens on. One run waits on one thing at a time. */
export function signalName(instanceId: string, type: string): string {
  return `${instanceId}:${type}`
}

export function openWorkflowStep(step: OpenWorkflowStepApi, options: StepAdapterOptions): Step {
  const pause = options.sleep ?? sleep
  return {
    async do<T>(name: string, a: StepOptions | (() => Promise<T>), b?: () => Promise<T>) {
      const fn = typeof a === 'function' ? a : (b as () => Promise<T>)
      const config = typeof a === 'function' ? {} : a
      const retries = config.retries ?? DEFAULT_RETRIES
      const timeout = durationMs(config.timeout ?? DEFAULT_TIMEOUT)
      const result = await step.run<{ value: T | null } | StepFailure>(
        { name, retryPolicy: { maximumAttempts: 1 } },
        async () => {
          for (let attempt = 0; ; attempt++) {
            try {
              return { value: (await withTimeout(name, timeout, fn)) ?? null }
            } catch (err) {
              if (attempt >= retries.limit) {
                const e = err instanceof Error ? err : new Error(String(err))
                return { __stepFailed: { name: e.name, message: e.message } }
              }
              await pause(retryDelayMs(retries, attempt + 1))
            }
          }
        }
      )
      if (isStepFailure(result)) {
        const err = new Error(result.__stepFailed.message)
        err.name = result.__stepFailed.name
        throw err
      }
      return (result.value ?? undefined) as T
    },

    async waitForEvent(name: string, wait: WaitForEventOptions) {
      const { arrived } = wait
      if (arrived && (await step.run({ name: `${name}:arrived` }, () => arrived()))) {
        return undefined
      }
      const received = await step.waitForSignal<unknown>({
        name,
        signal: signalName(options.instanceId, wait.type),
        ...(wait.timeout !== undefined && { timeout: durationMs(wait.timeout) }),
      })
      if (received === null) {
        throw new Error(`workflow.wait_for_event_timeout: no "${wait.type}" event for "${name}"`)
      }
      return received.data
    },

    isControlFlow: (err: unknown) => err instanceof Error && CONTROL_FLOW_ERRORS.has(err.name),
  } as Step
}

/** OpenWorkflow's run row, as far as status mapping needs it. */
interface WorkflowRunLike {
  id: string
  status: string
  workerId: string | null
  availableAt: Date | null
  error: { name?: string; message?: string } | null
}

/** OpenWorkflow status → the `RunStatus` vocabulary `reconcileRun` reads. */
export function mapRunStatus(run: WorkflowRunLike, now = Date.now()): RunStatus {
  switch (run.status) {
    case 'pending':
      return { status: 'queued' }
    case 'sleeping':
      return { status: 'waiting' }
    case 'running': {
      // A parked run stays `running` with no worker and a wake-up time ahead of it.
      const parked = run.workerId === null && run.availableAt && run.availableAt.getTime() > now
      return { status: parked ? 'waiting' : 'running' }
    }
    case 'completed':
    case 'succeeded':
      return { status: 'complete' }
    case 'failed':
      return {
        status: 'errored',
        error: {
          name: run.error?.name ?? 'Error',
          message: run.error?.message ?? 'Workflow run failed',
        },
      }
    case 'canceled':
      return { status: 'terminated' }
    default:
      return { status: run.status }
  }
}

const TERMINAL = new Set(['completed', 'succeeded', 'failed', 'canceled'])

/**
 * One OpenWorkflow run as a `RunInstance`. `sendEvent` re-sends for up to
 * `SEND_EVENT_WINDOW_MS` while the run is alive but not yet waiting (signals are not buffered).
 */
export function openWorkflowInstance(
  ow: OpenWorkflow,
  backend: Pick<BackendPostgres, 'getWorkflowRun'>,
  id: string
): RunInstance {
  return {
    id,
    async status() {
      const run = await backend.getWorkflowRun({ workflowRunId: id })
      if (!run) throw new Error(`instance.not_found: workflow run ${id}`)
      return mapRunStatus(run)
    },
    async terminate() {
      await ow.cancelWorkflowRun(id)
    },
    async sendEvent(event) {
      const signal = signalName(id, event.type)
      const deadline = Date.now() + SEND_EVENT_WINDOW_MS
      for (;;) {
        const sent = await ow.sendSignal({
          signal,
          data: (event.payload ?? null) as Parameters<typeof ow.sendSignal>[0]['data'],
        })
        if (sent.workflowRunIds.includes(id)) return
        const run = await backend.getWorkflowRun({ workflowRunId: id })
        if (!run) throw new Error(`instance.not_found: workflow run ${id}`)
        // Over: nothing will ever wait again — the caller restarts it (`nudgeOrRestartInstance`).
        if (TERMINAL.has(run.status))
          throw new Error(`instance ${id} is ${run.status}, not waiting`)
        // Alive but not waiting: it is on its way to the wait (we retry), or it saw the answer
        // already and moved on (`arrived`), in which case the window just runs out.
        if (Date.now() >= deadline) return
        await sleep(SEND_EVENT_INTERVAL_MS)
      }
    },
  }
}

export interface NodeRunsOptions {
  config: AppConfig
  log: (message: string) => void
  /** OpenWorkflow's schema. Default `openworkflow`; tests use one of their own. */
  schema?: string
  /** Replace the retry back-off sleep inside a step (tests). */
  sleep?: (ms: number) => Promise<void>
}

export interface NodeRuns {
  engine: RunEngine
  /** Start executing runs (`worker`/`all`). The app env and platform are what a run body uses. */
  startWorker(env: AppBindings, platform: Platform): Promise<void>
  /** Stop the worker (waits up to `timeoutMs` for active runs), then close the pool. */
  stop(timeoutMs?: number): Promise<void>
  /** The OpenWorkflow backend (tests read runs through it). */
  backend: BackendPostgres
}

/** A postgres.js pool shaped the way OpenWorkflow's backend expects (camel-cased columns). */
function owPool(url: string, max: number) {
  return postgres(url, {
    max,
    onnotice: () => {},
    transform: { column: { from: postgres.toCamel } },
  })
}

export function createNodeRuns(options: NodeRunsOptions): NodeRuns {
  const { config, log } = options
  const schema = options.schema ?? RUNS_SCHEMA
  // Concurrency + headroom for the heartbeat, claims and the producer side.
  const backend = BackendPostgres.fromPool(
    owPool(resolveDatabaseUrl(config), config.RUNS_CONCURRENCY + 4),
    { schema }
  )
  const ow = new OpenWorkflow({ backend })
  let deps: { env: AppBindings; platform: Platform } | undefined

  const workflow = ow.defineWorkflow<{ runId: string; tenantId: string }, unknown>(
    // A throw OUTSIDE a step fails the run, never retries it — the body settles its own row.
    { name: AGENT_RUN_WORKFLOW_NAME, retryPolicy: { maximumAttempts: 1 } },
    async ({ input, step, run }) => {
      if (!deps) throw new Error('agent-run: the runs worker started without a platform')
      return runAgentRun(
        input,
        openWorkflowStep(step, { instanceId: run.id, sleep: options.sleep }),
        deps
      )
    }
  )

  const instance = (id: string) => openWorkflowInstance(ow, backend, id)

  const engine: RunEngine = {
    async create({ id, params }) {
      const handle = await workflow.run(params as { runId: string; tenantId: string }, {
        idempotencyKey: id,
      })
      return { id: handle.workflowRun.id }
    },
    async get(id) {
      return instance(id)
    },
  }

  let worker: Worker | undefined
  return {
    engine,
    backend,
    async startWorker(env, platform) {
      deps = { env, platform }
      worker = ow.newWorker({ concurrency: config.RUNS_CONCURRENCY })
      await worker.start()
      log(`worker: running agent runs (concurrency ${config.RUNS_CONCURRENCY})`)
    },
    async stop(timeoutMs = 30_000) {
      if (worker) {
        const w = worker
        worker = undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        const stopped = await Promise.race([
          w.stop().then(() => true),
          new Promise<false>(resolve => {
            timer = setTimeout(() => resolve(false), timeoutMs)
          }),
        ])
        clearTimeout(timer)
        // A run still mid-step keeps its lease until it lapses; another worker then replays it.
        if (!stopped) log('shutdown: agent runs still active — their leases will hand them over')
      }
      await backend.stop()
    },
  }
}
