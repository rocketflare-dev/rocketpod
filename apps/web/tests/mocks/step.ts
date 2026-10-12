/**
 * A fake run-engine `Step` (D15) for driving a durable run body under test: it runs each callback
 * inline and records what was asked for — no retries, no timeouts, no checkpoints. A callback that
 * throws propagates to the caller exactly as the engine would after its retries.
 *
 * `waitForEvent` is a RECORDER rather than a throw, because the suspend/resume loop (issue #17) is
 * the interesting thing about the agent run. The one property no fake can check is the step NAME —
 * the engine treats it as the step's identity and replays a repeated name's earlier result — so
 * `names` is exposed in call order for the test that asserts they are distinct per round.
 */
import type { Step, StepOptions, WaitForEventOptions } from '@/platform/types'

export interface RecordedStep {
  name: string
  config?: StepOptions
}

/** One `step.waitForEvent(name, { type, timeout })` the body asked for. */
export interface RecordedWait {
  name: string
  type: string
  timeout?: string | number
}

export interface FakeStepOptions {
  /**
   * Payloads handed to successive `waitForEvent` calls, in order. When the queue is empty and no
   * {@link FakeStepOptions.onWait} supplies one, the wait REJECTS the way the engine's own timeout
   * does — which is how a test drives the expiry path.
   */
  events?: unknown[]
  /**
   * Called before each wait resolves — the test's stand-in for the resolve route, whose job in the
   * real system is to flip `awaiting_input → running` BEFORE it wakes the instance (decision 2).
   * Return a value to use it as the event payload; return nothing to fall through to the queue.
   */
  onWait?: (wait: RecordedWait) => unknown | Promise<unknown>
}

/** What a run engine raises when `waitForEvent` reaches its timeout with nothing delivered. */
export class FakeStepTimeoutError extends Error {
  constructor(name: string) {
    super(`workflow.wait_for_event_timeout: no event delivered to "${name}"`)
    this.name = 'FakeStepTimeoutError'
  }
}

export function createFakeStep(options: FakeStepOptions = {}) {
  const calls: RecordedStep[] = []
  const waits: RecordedWait[] = []
  /** Every recorded step name — `do` and `waitForEvent` alike — in the order they were asked for. */
  const names: string[] = []
  const queue: unknown[] = [...(options.events ?? [])]
  const step: Step = {
    async do<T>(
      name: string,
      configOrFn: StepOptions | (() => Promise<T>),
      maybeFn?: () => Promise<T>
    ): Promise<T> {
      const fn = typeof configOrFn === 'function' ? configOrFn : (maybeFn as () => Promise<T>)
      calls.push(typeof configOrFn === 'function' ? { name } : { name, config: configOrFn })
      names.push(name)
      return fn()
    },
    async waitForEvent(name: string, waitOptions: WaitForEventOptions): Promise<unknown> {
      const wait: RecordedWait = { name, type: waitOptions.type, timeout: waitOptions.timeout }
      waits.push(wait)
      names.push(name)
      const supplied = await options.onWait?.(wait)
      if (supplied !== undefined) return supplied
      if (queue.length > 0) return queue.shift()
      throw new FakeStepTimeoutError(name)
    },
  } as Step
  return {
    step,
    calls,
    waits,
    names,
    /** Queue one more payload for a later wait. */
    queueEvent(payload: unknown) {
      queue.push(payload)
    },
  }
}
