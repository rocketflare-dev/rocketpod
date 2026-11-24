/**
 * Hand-written types for `test-plan.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there; `apps/web/tests/kit-only/gate.test.ts` is what typechecks against this.
 */

export type TestTarget = 'local' | 'remote'
type Env = Record<string, string | undefined>

export const COMPOSE_FILE: string
export const WEB_DIR: string
export const TARGET_HINT: string

export function resolveTarget(env: Env): { target: TestTarget } | { error: string }

export const SUITES: Record<'api' | 'ui' | 'config' | 'driver' | 'kit-only', string[]>

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
):
  | { only: TestPart | null; shard: TestShard | null; changed: string | null; positional: string[] }
  | { error: string }
  | { help: true }

export interface TestStep {
  /** Which `--only` part the step belongs to (`suites` for a `pnpm test <suite…>` run). */
  part: TestPart | 'suites'
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
  tree: { kitOnly: boolean; webOnly?: boolean },
  select?: TestSelection
): TestPlan | { error: string }

export function planSuites(
  env: Env,
  input: { suites: string[]; files: string[]; kitOnly: boolean }
): TestPlan | { error: string }

export function planSelectedTests(
  env: Env,
  selection: { projects: Record<string, string[]>; packages: string[] }
): TestPlan | { error: string }

/** The host ports the kit's `docker-compose.test.yml` publishes. */
export const DEFAULT_TEST_PORTS: Readonly<{ postgres: number; s3: number }>
/** The host ports `docker-compose.test.yml` publishes (the kit's when it does not say). */
export function testPorts(composeText: string): { postgres: number; s3: number }
/** The ports `.env.test`'s `DATABASE_URL` and `STORAGE_ENDPOINT` connect to, or null. */
export function envTestPorts(envTestText: string): { postgres: number | null; s3: number | null }
/** One line per port `.env.test` and the compose file disagree on. */
export function testPortMismatches(
  published: { postgres: number; s3: number },
  wanted: { postgres: number | null; s3: number | null }
): string[]
