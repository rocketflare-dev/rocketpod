/**
 * Hand-written types for `gate-lib.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there; `apps/web/tests/kit-only/gate.test.ts` is what typechecks against this.
 */

export const GATE_LIST_SCHEMA_VERSION: 1

export interface GateStepDefinition {
  readonly id: string
  readonly command: readonly string[]
  readonly display: string
  readonly database: boolean
}
export const GATE_STEPS: readonly GateStepDefinition[]
export const GATE_USAGE: string

export function gateList(): {
  schema: 1
  steps: Array<{ id: string; command: string; database: boolean }>
}

export function parseGateArgs(
  argv: string[]
):
  | {
      list: boolean
      json: boolean
      keepGoing: boolean
      /** null: the full gate; '': `--changed` against the default base; else the named ref. */
      changed: string | null
      steps: string[]
    }
  | { error: string }
  | { help: true }

export const GATE_VERDICT_FILE: string

export interface GateStepResult {
  id: string
  seconds: number
  ok: boolean
  /** `--changed`: the change reached nothing this step checks. */
  skipped?: boolean
}
export interface GateVerdict {
  passed: boolean
  full: boolean
  /** A `pnpm gate --changed` run: never `full`. */
  changed: boolean
  failed: string[]
  steps: GateStepResult[]
  sha: string | null
  dirty: boolean | null
  finishedAt: string
}
export function gateVerdict(input: {
  requested: string[]
  ran: GateStepResult[]
  sha: string | null
  dirty: boolean | null
  changed?: boolean
  finishedAt: string
}): GateVerdict
