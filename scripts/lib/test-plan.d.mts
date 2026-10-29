/**
 * Hand-written types for `test-plan.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there; `apps/web/tests/config/gate.test.ts` is what typechecks against this.
 */

export type TestTarget = 'local' | 'remote'
type Env = Record<string, string | undefined>

export const COMPOSE_FILE: string
export const WEB_DIR: string
export const TARGET_HINT: string

export function resolveTarget(env: Env): { target: TestTarget } | { error: string }

export type TestPart = 'packages' | 'api' | 'rest'
export const TEST_PARTS: readonly TestPart[]
export const TEST_USAGE: string

export interface TestShard {
  index: number
  count: number
}

export interface TestSelection {
  only?: TestPart | null
  shard?: TestShard | null
}

export function parseTestArgs(
  argv: string[]
): { only: TestPart | null; shard: TestShard | null } | { error: string } | { help: true }

export interface TestStep {
  /** Which `--only` part the step belongs to. */
  part: TestPart
  label: string
  /** Relative to the repository root. */
  cwd: string
  command: string[]
  env: Record<string, string>
}

export interface TestPlan {
  target: TestTarget
  /** Start the compose database before the steps. */
  compose: boolean
  banner: string
  steps: TestStep[]
  notes: string[]
}

export function planTests(
  env: Env,
  tree: { kitOnly: boolean },
  select?: TestSelection
): TestPlan | { error: string }
