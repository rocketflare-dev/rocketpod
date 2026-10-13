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
 * One driver: postgres.js (Rocketpod removed Rocketflare's Neon driver, so there is no second
 * conformance pass to run).
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

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ kitOnly: boolean }} tree what the checkout carries (`apps/web/tests/kit-only/` exists)
 */
export function planTests(env, tree) {
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

  const steps = [
    {
      label: 'the other packages',
      cwd: '.',
      command: ['pnpm', '-r', '--filter', `!./${WEB_DIR}`, 'test'],
      env: {},
    },
    // Two invocations because vitest 3 resolves `isolate` per run, not per project.
    {
      label: 'web: api (shared registry)',
      cwd: WEB_DIR,
      command: vitest(['api'], ['--no-isolate']),
      env: webEnv,
    },
    {
      label: `web: ${isolated.join(', ')}`,
      cwd: WEB_DIR,
      command: vitest(isolated),
      env: webEnv,
    },
  ]
  return { target, compose: target === 'local', banner, steps, notes: [] }
}
