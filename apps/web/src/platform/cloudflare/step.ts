/**
 * The neutral `Step` over a Cloudflare `WorkflowStep`. The platform constrains a step's result to
 * `Rpc.Serializable` and its durations to a template-literal type; the neutral interface states the
 * same contract (`Checkpointable`, `Duration`) without the platform's types, so the casts here are
 * the whole of the difference.
 */
import type { WorkflowSleepDuration, WorkflowStep } from 'cloudflare:workers'
import type { Step, StepOptions } from '../types'

type CfStepConfig = Parameters<WorkflowStep['do']>[1]

export function cloudflareStep(step: WorkflowStep): Step {
  return {
    do<T>(name: string, a: StepOptions | (() => Promise<T>), b?: () => Promise<T>): Promise<T> {
      const run = step.do as unknown as (name: string, ...rest: unknown[]) => Promise<T>
      return typeof a === 'function'
        ? run.call(step, name, a)
        : run.call(step, name, a as unknown as CfStepConfig, b)
    },
    waitForEvent: (name, options) =>
      step.waitForEvent(name, {
        type: options.type,
        ...(options.timeout !== undefined && {
          timeout: options.timeout as WorkflowSleepDuration | number,
        }),
      }),
  } as Step
}
