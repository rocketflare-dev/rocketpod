#!/usr/bin/env node
/**
 * `pnpm test` — the one full test run, and the `test` step of `pnpm gate`. What it runs, and on
 * which target, is decided in `scripts/lib/test-plan.mjs`; this file prints the target, starts the
 * compose database when the target is local, and runs the steps in order, stopping at the first
 * that fails.
 *
 * `--only packages|api|rest [--shard i/N]` runs one part of the same plan (CI's parallel jobs);
 * no flags is the whole run, and `pnpm test web` the whole web plan without the other packages.
 *
 * `pnpm test <suite…> [file…]` is the inner loop: `api`, `ui`, `config`, `driver` (and `kit-only`
 * in the kit), each its shared and isolated vitest projects together, narrowed to any file paths,
 * filters or vitest flags given. A path alone runs it in whichever project holds it. The
 * `apps/web` `test:*` scripts are one-line aliases for these, so no `package.json` names a vitest
 * project. The database is expected up (`pnpm test:db:up`, or any earlier `pnpm test`).
 *
 * `--changed=<base>` (what `pnpm gate --changed` runs) narrows the run to the tests the change
 * reaches: vitest's import graph, plus every test that reads the repository through the
 * filesystem (`lib/gate-changed.mjs`).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEvalWarnings, renderEvalWarnings } from './lib/eval-warnings.mjs'
import { planChanged, readsFiles, selectTests } from './lib/gate-changed.mjs'
import { changedFiles, workspacePackages } from './lib/gate-changed-git.mjs'
import {
  COMPOSE_FILE,
  parseTestArgs,
  planSelectedTests,
  planSuites,
  planTests,
  SUITES,
  TARGET_HINT,
  TEST_USAGE,
  WEB_DIR,
} from './lib/test-plan.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(command, { cwd = ROOT, env = {}, quiet = false } = {}) {
  const [bin, ...args] = command
  const result = spawnSync(bin, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: quiet ? 'ignore' : 'inherit',
  })
  return result.status ?? 1
}

function fail(message) {
  console.error(`\n✖ pnpm test: ${message}`)
  process.exit(1)
}

// vitest under an older Node dies on startup with `code.charCodeAt is not a function` — Vite's
// source-map handler failing on the real error — which says nothing about the cause.
const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 26) {
  fail(
    `Node ${process.versions.node} is on PATH; the kit needs Node 26 (\`nvm use\` reads .nvmrc).`
  )
}

/** `vitest list --filesOnly --json` in apps/web, as repo-relative `{ file, project }`. */
function vitestList(extra) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rp-gate-list-'))
  const out = path.join(dir, 'list.json')
  const args = ['exec', 'dotenv', '-e', '.env.test', '--', 'vitest', 'list', '--filesOnly']
  return new Promise(resolve => {
    const child = spawn('pnpm', [...args, `--json=${out}`, ...extra], {
      cwd: path.join(ROOT, WEB_DIR),
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', d => {
      stderr += d
    })
    child.on('close', code => {
      const list = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
      rmSync(dir, { recursive: true, force: true })
      if (code !== 0 || !list) fail(`vitest list failed:\n${stderr.slice(-2000)}`)
      resolve(list.map(t => ({ file: path.relative(ROOT, t.file), project: t.projectName })))
    })
  })
}

/** Test helpers that read the filesystem: a test importing one reads the repository too. */
function fsHelpers() {
  const out = []
  for (const sub of ['tests/helpers', 'tests/kit']) {
    const dir = path.join(ROOT, WEB_DIR, sub)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!/\.tsx?$/.test(f)) continue
      if (readsFiles(readFileSync(path.join(dir, f), 'utf8'))) {
        out.push(`${sub.split('/')[1]}/${f.replace(/\.tsx?$/, '')}`)
      }
    }
  }
  return out
}

/** The plan for `--changed=<base>`, or null when the change makes it the full run. */
async function changedPlan(base) {
  const { changed, existing } = changedFiles(ROOT, base)
  const decided = planChanged({ changed, existing, packages: workspacePackages(ROOT) })
  if ('full' in decided) {
    console.log(`· ${decided.full} — running every test`)
    return null
  }
  let projects = {}
  if (decided.test.web) {
    const [all, related] = await Promise.all([vitestList([]), vitestList([`--changed=${base}`])])
    const sources = Object.fromEntries(
      [...new Set(all.map(t => t.file))].map(f => [f, readFileSync(path.join(ROOT, f), 'utf8')])
    )
    const chosen = selectTests({ all, related, sources, changed, fsHelpers: fsHelpers() })
    // vitest runs in apps/web: hand it absolute paths, which match exactly one file each.
    projects = Object.fromEntries(
      Object.entries(chosen).map(([p, files]) => [p, files.map(f => path.join(ROOT, f))])
    )
  }
  return planSelectedTests(process.env, { projects, packages: decided.test.packages })
}

const args = parseTestArgs(process.argv.slice(2))
if ('help' in args) {
  console.log(TEST_USAGE)
  process.exit(0)
}
if ('error' in args) {
  console.error(`pnpm test: ${args.error}\n\n${TEST_USAGE}`)
  process.exit(2)
}

const kitOnly = existsSync(path.join(ROOT, WEB_DIR, 'tests/kit-only'))
// Paths arrive relative to the caller (`pnpm web test:api tests/api/x.test.ts` runs in apps/web,
// `pnpm test api apps/web/tests/api/x.test.ts` at the root); vitest runs in apps/web, so an
// existing path is handed over absolute. Anything else is a name filter or a vitest flag, passed
// as given.
const callerDir = process.env.INIT_CWD ?? process.cwd()
const webOnly = args.positional.length === 1 && args.positional[0] === 'web'
const suites = args.positional.filter(a => a in SUITES)
const files = args.positional
  .filter(a => !(a in SUITES) && a !== 'web')
  .map(a => (existsSync(path.resolve(callerDir, a)) ? path.resolve(callerDir, a) : a))
const plan =
  (args.changed && (await changedPlan(args.changed))) ||
  (args.positional.length && !webOnly
    ? planSuites(process.env, { suites, files, kitOnly })
    : planTests(process.env, { kitOnly, webOnly }, args))
if ('error' in plan) fail(plan.error)

// A part's banner names what it runs; a packages-only run touches no database.
const target = plan.compose || plan.target === 'remote' ? plan.banner : 'test target: no database'
console.log(args.only ? `${target} — only ${plan.steps.map(s => s.label).join(', ')}` : plan.banner)

if (plan.compose) {
  if (run(['docker', 'info'], { quiet: true }) !== 0) {
    fail(`Docker is not running, and a local target needs it. ${TARGET_HINT}`)
  }
  // `--wait` blocks until the health check passes; a no-op when it is already up. Never torn
  // down: the next run reuses it, and `pnpm test:db:down` is there for whoever wants it gone.
  const up = run(['docker', 'compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait'], {
    quiet: false,
  })
  if (up !== 0) {
    fail(
      'the test database did not start (docker compose up failed above). Another checkout holding ' +
        ':5533 is the usual cause: `pnpm dev:db:status` lists them.'
    )
  }
}

const started = Date.now()
for (const step of plan.steps) {
  console.log(`\n▶ ${step.label}`)
  const status = run(step.command, { cwd: path.join(ROOT, step.cwd), env: step.env })
  if (status !== 0) fail(`${step.label} failed`)
}
for (const note of plan.notes) console.log(`\n· ${note}`)
const evalWarnings = renderEvalWarnings(readEvalWarnings(ROOT, started))
if (evalWarnings) console.warn(`\n${evalWarnings}`)
console.log(`\n✔ pnpm test: ${plan.steps.length} step(s) passed (${plan.target})`)
