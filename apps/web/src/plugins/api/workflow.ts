/**
 * `WorkflowCtx` — a plugin's half of a durable multi-step run.
 *
 * **Unexercised.** No plugin registers a workflow step yet, so everything here is derived from
 * the core agent run (`api/workflows/agent-run-body.ts`) rather than from a plugin that needed
 * it. It is deliberately minimal: what the core workflow demonstrably needs, and nothing
 * speculative beyond it. Widen it when a second workflow exists to widen it FOR, not before.
 *
 * It exists at all because three of the rules below are things a plugin would otherwise get wrong
 * once, in production, in a way that reads as an application bug:
 *
 * 1. **A duplicate step name within one run throws, here, immediately.** To the platform a step
 *    name IS that step's identity, and a repeated one replays the first call's recorded result
 *    rather than running again. Reuse `'execute'` across an
 *    approval round and the second attempt silently returns the first one's answer, which reads
 *    exactly like "the agent ignored my approval". Carrying the round in the name (`execute#0`,
 *    `execute#1`) is the fix, and this guard is what makes forgetting it loud.
 * 2. **Each step gets a FRESH database client**, opened when the step body starts and closed when
 *    it ends, whatever happens. A client shared across steps is a client held open across a
 *    checkpoint — and across a park that may be days. `step` therefore HANDS `fn` the handle rather
 *    than letting a plugin capture one.
 * 3. **Everything is awaited.** A step has no `waitUntil`, so nudges are collected and settled
 *    before the step returns.
 *
 * `T extends Checkpointable` is the run engine's constraint, repeated rather than widened: a
 * step's return value is CHECKPOINTED, so it has to survive a round trip. Keep it a small object
 * (`{ id, status }`) — a row with a `Date` on it comes back as a string.
 *
 * `withStepDatabase` is deliberately re-implemented here rather than imported: the core copy lives
 * in `api/workflows/agent-run-body.ts`, which is inside the deletable `feature-agents` surface, and this
 * surface must not disappear with the example agents.
 */

import type { AppConfig } from '../../config'
import { type Database, openDatabase } from '../../db/client'
import type { Checkpointable, Platform, Step, StepOptions } from '../../platform/types'
import { createStepRealtimeFor, type StepRealtime } from './realtime-step'
import type { Logger, PluginBindings, PluginContext } from './types'

export type { StepOptions }

/** What a step body is handed: the base context, with a client that belongs to THIS step. */
export interface StepCtx extends PluginContext {
  /** The step's own name, so a log line can say which one it came from. */
  name: string
  /** Nudges, collected and awaited before the step returns. */
  realtime: StepRealtime
}

export interface WorkflowCtx {
  config: AppConfig
  env: PluginBindings
  platform: Platform
  logger: Logger
  /**
   * Run one durable step. The name must be unique within the run — see rule 1 above; a repeat
   * throws here rather than silently replaying.
   */
  step<T extends Checkpointable>(
    name: string,
    options: StepOptions,
    fn: (ctx: StepCtx) => Promise<T>
  ): Promise<T>
  step<T extends Checkpointable>(name: string, fn: (ctx: StepCtx) => Promise<T>): Promise<T>
  /**
   * Park the instance until somebody sends this event, or the timeout expires.
   *
   * Keep an event TYPE to `[A-Za-z0-9_-]`. OpenWorkflow accepts any signal name (it addresses the
   * wait as `<instanceId>:<type>`), but plugins are shared with Rocketflare, whose engine rejects a
   * `.` with `workflow.invalid_event_type`. A park costs nothing while it waits — it is a row in
   * the `openworkflow` schema and holds no `RUNS_CONCURRENCY` slot — and when the timeout passes
   * first the wait throws `workflow.wait_for_event_timeout`.
   *
   * The payload is deliberately `unknown`: the core answer is that **the answer is a ROW**,
   * written before the instance was woken. A payload on the wire is a second source of truth that
   * can disagree with the audit row.
   */
  waitForEvent(name: string, options: Parameters<Step['waitForEvent']>[1]): Promise<unknown>
}

/** One database client for one step, closed whatever happens. */
async function withStepDatabase<T>(
  config: AppConfig,
  fn: (db: Database) => Promise<T>
): Promise<T> {
  const handle = openDatabase(config)
  try {
    return await fn(handle.db)
  } finally {
    await handle.close()
  }
}

/** Thrown when a run reuses a step name — see rule 1. */
export class DuplicateStepNameError extends Error {
  constructor(name: string) {
    super(
      `Workflow step '${name}' has already run in this instance. A step name is its identity to ` +
        'the platform, so a repeat replays the first call’s recorded result instead of running ' +
        'again. Carry the round in the name (`sync#0`, `sync#1`), as the agent-run workflow does.'
    )
    this.name = 'DuplicateStepNameError'
  }
}

/**
 * Adapt the run engine's neutral `Step` into the plugin surface.
 *
 * The name set lives in this closure rather than anywhere durable, on purpose: it catches a reused
 * name within ONE execution, which is where the mistake is written. A replay legitimately re-runs
 * the same names, and the platform's own cache is what answers those.
 */
export function workflowCtx(
  step: Step,
  env: PluginBindings,
  config: AppConfig,
  logger: Logger,
  platform: Platform
): WorkflowCtx {
  const seen = new Set<string>()

  function run<T extends Checkpointable>(
    name: string,
    options: StepOptions | undefined,
    fn: (ctx: StepCtx) => Promise<T>
  ): Promise<T> {
    if (seen.has(name)) throw new DuplicateStepNameError(name)
    seen.add(name)
    const body = () =>
      withStepDatabase(config, async db => {
        const realtime = createStepRealtimeFor(platform.realtime)
        try {
          return await fn({
            db,
            config,
            logger: logger.child({ step: name }),
            env,
            platform,
            name,
            realtime,
          })
        } finally {
          await realtime.settle()
        }
      })
    return options ? step.do(name, options, body) : step.do(name, body)
  }

  function stepFn<T extends Checkpointable>(
    name: string,
    a: StepOptions | ((ctx: StepCtx) => Promise<T>),
    b?: (ctx: StepCtx) => Promise<T>
  ): Promise<T> {
    return typeof a === 'function'
      ? run(name, undefined, a)
      : run(name, a, b as (ctx: StepCtx) => Promise<T>)
  }

  return {
    config,
    env,
    platform,
    logger,
    step: stepFn,
    waitForEvent: (name, options) => step.waitForEvent(name, options),
  }
}
