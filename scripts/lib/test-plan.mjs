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
 *
 * The inner loop is `pnpm test <suite…> [file…]` (`planSuites`): a suite is its shared and isolated
 * projects together (`SUITES`). `pnpm test web` is the whole plan without the other packages, and
 * `--changed=<ref>` (what `pnpm gate --changed` runs) the tests a change reaches
 * (`planSelectedTests`, over `lib/gate-changed.mjs`'s selection).
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

/** A suite of `pnpm test <suite…>`: the vitest projects that run it, shared and isolated together. */
export const SUITES = {
  api: ['api', 'api-isolated', 'api-fixtures'],
  ui: ['ui', 'ui-isolated'],
  config: ['config', 'config-isolated'],
  driver: ['driver'],
  'kit-only': ['kit-only'],
}

/** The parts `--only` selects, in plan order. */
export const TEST_PARTS = Object.freeze(['packages', 'api', 'rest'])

export const TEST_USAGE = `usage: pnpm test [web] [--only <part>] [--shard <i>/<n>]
       pnpm test <suite…> [file|filter|vitest flag…]
       pnpm test --changed=<ref>

  pnpm test                       the whole plan: every package, then the web suite
  pnpm test web                   the whole web plan, no other package
  pnpm test --only packages       every package but apps/web (no database)
  pnpm test --only api            web: the api project (shared registry)
  pnpm test --only rest           web: every other project (api-isolated, api-fixtures, driver, ui…)
  pnpm test --only rest --shard 2/3   the second third of those files (vitest --shard)
  pnpm test api tests/api/x.test.ts   one suite (its shared and isolated projects), narrowed
  pnpm test --changed=origin/main     the tests the branch's change reaches

parts: ${TEST_PARTS.join(', ')} · suites: ${Object.keys(SUITES).join(', ')}`

/**
 * `--only`/`--shard` select a part of the full plan; `--changed=<ref>` the tests a change reaches;
 * anything else is positional — `web`, a suite name, then files, name filters or vitest flags,
 * which only a suite run (`planSuites`) accepts.
 * @param {string[]} argv
 * @returns {{ only: string | null, shard: { index: number, count: number } | null, changed: string | null, positional: string[] } | { error: string } | { help: true }}
 */
export function parseTestArgs(argv) {
  let only = null
  let shard = null
  let changed = null
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg.startsWith('--changed=')) {
      changed = arg.slice('--changed='.length)
      if (!changed) return { error: '--changed needs a ref: --changed=<ref>' }
      continue
    }
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
    } else positional.push(arg)
  }
  // Only the rest run is sharded: `api` shares one module registry across its files, and the
  // packages are separate vitest runs a shard index cannot span.
  if (shard && only !== 'rest') return { error: '--shard applies only to --only rest' }
  const suiteRun = positional.length > 0 && !(positional.length === 1 && positional[0] === 'web')
  if (suiteRun && !(positional[0] in SUITES) && positional[0].startsWith('-')) {
    return { error: `unknown argument '${positional[0]}'` }
  }
  if ((only || shard) && suiteRun) {
    return { error: '--only and --shard select a part of the full plan, not of a suite run' }
  }
  if (changed && (only || shard || positional.length)) {
    return { error: '--changed runs on its own' }
  }
  return { only, shard, changed, positional }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ kitOnly: boolean, webOnly?: boolean }} tree what the checkout carries
 *   (`apps/web/tests/kit-only/` exists); `webOnly` (`pnpm test web`) skips the other packages
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
  const isolated = [
    'api-isolated',
    'api-fixtures',
    'driver',
    'ui',
    'ui-isolated',
    'config',
    'config-isolated',
    ...(tree.kitOnly ? ['kit-only'] : []),
  ]

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
    {
      part: 'api',
      label: 'web: api (shared registry)',
      cwd: WEB_DIR,
      command: vitest(['api']),
      env: webEnv,
    },
    {
      part: 'rest',
      label: `web: ${isolated.join(', ')}${shard ? ` (shard ${shard.index}/${shard.count})` : ''}`,
      cwd: WEB_DIR,
      command: vitest(isolated, shard ? ['--shard', `${shard.index}/${shard.count}`] : []),
      env: webEnv,
    },
  ]
    .filter(step => !tree.webOnly || step.part !== 'packages')
    .filter(step => !select.only || step.part === select.only)
  // The packages need no database, so a packages-only run starts none.
  const compose = target === 'local' && steps.some(step => step.part !== 'packages')
  return { target, compose, banner, steps, notes: [] }
}

/**
 * `pnpm test <suite…> [file…]`, the inner loop: the named suites' projects in one vitest run,
 * narrowed to the files, filters or vitest flags given. No suite runs every web project. No other
 * package and no compose management (the database is expected up: `pnpm test:db:up`, or any
 * earlier `pnpm test`): that is the full run's job.
 * @param {Record<string, string | undefined>} env
 * @param {{ suites: string[], files: string[], kitOnly: boolean }} input
 */
export function planSuites(env, { suites, files, kitOnly }) {
  const resolved = resolveTarget(env)
  if ('error' in resolved) return resolved
  const { target } = resolved
  const unknown = suites.filter(s => !(s in SUITES))
  if (unknown.length) {
    return {
      error: `unknown suite ${unknown.join(', ')}: one of ${Object.keys(SUITES).join(', ')}`,
    }
  }
  if (suites.includes('kit-only') && !kitOnly) {
    return { error: 'kit-only runs in the kit repository only: a copy has no tests/kit-only/' }
  }
  const named = suites.length
    ? suites
    : Object.keys(SUITES).filter(s => s !== 'kit-only' || kitOnly)
  const projects = named.flatMap(s => SUITES[s])
  return {
    target,
    compose: false,
    banner: `test target: ${target}, ${named.join(' + ')}${files.length ? `, ${files.length} filter(s)` : ''}`,
    steps: [
      {
        part: 'suites',
        label: `web: ${projects.join(', ')}`,
        cwd: WEB_DIR,
        command: vitest(projects, files),
        env: suiteEnv(target),
      },
    ],
    notes: [],
  }
}

/** The projects that open the test database (`tests/setup.ts` is their global setup). */
const DATABASE_PROJECTS = ['api', 'api-isolated', 'api-fixtures', 'driver']

/**
 * `pnpm test --changed=<ref>`: the same shape as `planTests`, over the files `selectTests` chose
 * (scripts/lib/gate-changed.mjs). The database starts only when a chosen file needs it.
 * @param {Record<string, string | undefined>} env
 * @param {{ projects: Record<string, string[]>, packages: string[] }} selection web files are
 *   paths relative to apps/web; packages are repo-relative dirs
 */
export function planSelectedTests(env, selection) {
  const resolved = resolveTarget(env)
  if ('error' in resolved) return resolved
  const { target } = resolved
  const webEnv = suiteEnv(target)
  const files = p => selection.projects[p] ?? []
  const steps = selection.packages.map(dir => ({
    part: 'packages',
    label: `${dir} (reached by the change)`,
    cwd: '.',
    command: ['pnpm', '--filter', `./${dir}`, 'test'],
    env: {},
  }))
  if (files('api').length) {
    steps.push({
      part: 'api',
      label: `web: api, ${files('api').length} file(s)`,
      cwd: WEB_DIR,
      command: vitest(['api'], files('api')),
      env: webEnv,
    })
  }
  const others = Object.keys(selection.projects).filter(p => p !== 'api' && files(p).length)
  if (others.length) {
    const chosen = others.flatMap(files)
    steps.push({
      part: 'rest',
      label: `web: ${others.join(', ')}, ${chosen.length} file(s)`,
      cwd: WEB_DIR,
      command: vitest(others, chosen),
      env: webEnv,
    })
  }
  const total = Object.values(selection.projects).reduce((n, f) => n + f.length, 0)
  return {
    target,
    compose: target === 'local' && DATABASE_PROJECTS.some(p => files(p).length > 0),
    banner: `test target: ${target}, --changed: ${total} web test file(s) and ${selection.packages.length} other package(s)`,
    steps,
    notes: [],
  }
}
