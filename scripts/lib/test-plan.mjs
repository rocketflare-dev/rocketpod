/**
 * What `pnpm test` runs, as data (docs/CONCEPTS.md §4, "The gate"). `scripts/test.mjs` executes
 * the plan; this file decides it, so the decision is unit-tested without spawning anything
 * (`apps/web/tests/config/gate.test.ts`).
 *
 * The TARGET is decided from the environment, never by probing a database:
 *
 * - **local** (the default): the compose Postgres on :5533, started by the runner if it is not
 *   up. Every package's tests, then the web suite — the `driver` conformance project included.
 * - **remote**: `TEST_DATABASE_BRANCH` is set — a throwaway database branch somebody else
 *   created (a coding sandbox's gate branch), reached over TCP with the URL in `DATABASE_URL`; no
 *   Docker. tests/helpers/db-safety.ts still refuses unless the branch name and the endpoint id
 *   match.
 *
 * One driver: postgres.js, so there is no second conformance pass to run.
 *
 * The SELECTION (`pnpm test --only <part> [--shard i/N]`, `parseTestArgs`) runs one part of the
 * same plan, so CI's parallel jobs (.github/workflows/ci.yml) run exactly the steps a laptop runs,
 * split three ways: `packages` (every other package), `api` (the shared-registry web run) and
 * `rest` (the other web projects), the last sliceable with vitest's own `--shard`. No flags is the
 * whole plan, unchanged.
 */

export const COMPOSE_FILE = 'apps/web/docker-compose.test.yml'
export const WEB_DIR = 'apps/web'

/** The hint a refusal ends with: the two ways to give `pnpm test` a database. */
export const TARGET_HINT =
  'Run it locally with Docker (the runner starts the test Postgres itself), or against a ' +
  'throwaway database branch by setting DATABASE_URL, TEST_DATABASE_BRANCH=gate-<short>-<attempt> ' +
  'and TEST_DATABASE_ENDPOINT=<the endpoint id in the URL> (docs/CONCEPTS.md §4).'

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ target: 'local' | 'remote' } | { error: string }}
 */
export function resolveTarget(env) {
  if (env.GATE_SUITE_DRIVER) {
    return {
      error: `GATE_SUITE_DRIVER is gone: Rocketpod runs one driver (postgres). Unset it.`,
    }
  }
  if (env.TEST_DATABASE_BRANCH) return { target: 'remote' }
  if (env.TEST_DATABASE_EPHEMERAL === '1') {
    return {
      error: `TEST_DATABASE_EPHEMERAL=1 without TEST_DATABASE_BRANCH names no gate branch. ${TARGET_HINT}`,
    }
  }
  return { target: 'local' }
}

/** The environment a web vitest run needs on one target. */
function suiteEnv(target) {
  if (target === 'remote') {
    // `.env.test`'s local URLs must not win: dotenv never overwrites a variable that is already
    // set, so the branch's DATABASE_URL stands, and the app-role URL is blanked (unset, the app
    // role is created NOLOGIN and the policies stay inert — tests/setup.ts).
    return {
      NODE_ENV: 'test',
      DATABASE_DRIVER: 'postgres',
      TEST_DATABASE_EPHEMERAL: '1',
      APP_DATABASE_URL: '',
    }
  }
  return { NODE_ENV: 'test', DATABASE_DRIVER: 'postgres' }
}

function vitest(projects, extra = []) {
  return [
    'pnpm',
    'exec',
    'dotenv',
    '-e',
    '.env.test',
    '--',
    'vitest',
    'run',
    ...projects.flatMap(p => ['--project', p]),
    ...extra,
  ]
}

/** The parts `--only` selects, in plan order. */
export const TEST_PARTS = Object.freeze(['packages', 'api', 'rest'])

export const TEST_USAGE = `usage: pnpm test [--only <part>] [--shard <i>/<n>]

  pnpm test                       the whole plan: every package, then the web suite
  pnpm test --only packages       every package but apps/web (no database)
  pnpm test --only api            web: the api project (--no-isolate)
  pnpm test --only rest           web: every other project (api-isolated, driver, ui, config…)
  pnpm test --only rest --shard 2/3   the second third of those files (vitest --shard)

parts: ${TEST_PARTS.join(', ')}`

/**
 * @param {string[]} argv
 * @returns {{ only: string | null, shard: { index: number, count: number } | null } | { error: string } | { help: true }}
 */
export function parseTestArgs(argv) {
  let only = null
  let shard = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--only' || arg.startsWith('--only=')) {
      const value = arg === '--only' ? argv[++i] : arg.slice('--only='.length)
      if (!value || !TEST_PARTS.includes(value)) {
        return { error: `--only needs a part (${TEST_PARTS.join(', ')}), got '${value ?? ''}'` }
      }
      if (only) return { error: '--only takes one part' }
      only = value
    } else if (arg === '--shard' || arg.startsWith('--shard=')) {
      const value = arg === '--shard' ? argv[++i] : arg.slice('--shard='.length)
      const match = /^(\d+)\/(\d+)$/.exec(value ?? '')
      const index = match ? Number(match[1]) : 0
      const count = match ? Number(match[2]) : 0
      if (!match || count < 1 || index < 1 || index > count) {
        return { error: `--shard needs <i>/<n> with 1 ≤ i ≤ n, got '${value ?? ''}'` }
      }
      shard = { index, count }
    } else return { error: `unknown argument '${arg}'` }
  }
  // Only the rest run is sharded: `api` shares one module registry across its files, and the
  // packages are separate vitest runs a shard index cannot span.
  if (shard && only !== 'rest') return { error: '--shard applies only to --only rest' }
  return { only, shard }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ kitOnly: boolean }} tree what the checkout carries (`apps/web/tests/kit-only/` exists)
 * @param {{ only?: string | null, shard?: { index: number, count: number } | null }} [select]
 *   one part of the plan (`parseTestArgs`); omitted, the whole plan
 */
export function planTests(env, tree, select = {}) {
  const resolved = resolveTarget(env)
  if ('error' in resolved) return resolved
  const { target } = resolved
  const webEnv = suiteEnv(target)
  // The kit's OWN tests exist only in the kit: the rename deletes the directory, so a copy's plan
  // never names the project and there is nothing to unwire.
  const isolated = ['api-isolated', 'driver', 'ui', 'config', ...(tree.kitOnly ? ['kit-only'] : [])]

  const banner =
    target === 'remote'
      ? `test target: remote database branch ${env.TEST_DATABASE_BRANCH} (no Docker)`
      : 'test target: local compose Postgres'

  const shard = select.shard ?? null
  const steps = [
    {
      part: 'packages',
      label: 'the other packages',
      cwd: '.',
      command: ['pnpm', '-r', '--filter', `!./${WEB_DIR}`, 'test'],
      env: {},
    },
    // Two invocations because vitest 3 resolves `isolate` per run, not per project.
    {
      part: 'api',
      label: 'web: api (shared registry)',
      cwd: WEB_DIR,
      command: vitest(['api'], ['--no-isolate']),
      env: webEnv,
    },
    {
      part: 'rest',
      label: `web: ${isolated.join(', ')}${shard ? ` (shard ${shard.index}/${shard.count})` : ''}`,
      cwd: WEB_DIR,
      command: vitest(isolated, shard ? ['--shard', `${shard.index}/${shard.count}`] : []),
      env: webEnv,
    },
  ].filter(step => !select.only || step.part === select.only)
  // The packages need no database, so a packages-only run starts none.
  const compose = target === 'local' && steps.some(step => step.part !== 'packages')
  return { target, compose, banner, steps, notes: [] }
}
