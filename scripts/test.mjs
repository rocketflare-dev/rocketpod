#!/usr/bin/env node
/**
 * `pnpm test` — the one full test run, and the `test` step of `pnpm gate`. What it runs, and on
 * which target, is decided in `scripts/lib/test-plan.mjs`; this file prints the target, starts the
 * compose database when the target is local, and runs the steps in order, stopping at the first
 * that fails.
 *
 * `--only packages|api|rest [--shard i/N]` runs one part of the same plan (CI's parallel jobs);
 * no flags is the whole run.
 *
 * The inner loop is the narrow scripts (`pnpm web test:api`, `test:ui`, `test:config`,
 * `test:driver`, or a vitest file path): postgres, no compose management.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEvalWarnings, renderEvalWarnings } from './lib/eval-warnings.mjs'
import {
  COMPOSE_FILE,
  parseTestArgs,
  planTests,
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

const args = parseTestArgs(process.argv.slice(2))
if ('help' in args) {
  console.log(TEST_USAGE)
  process.exit(0)
}
if ('error' in args) {
  console.error(`pnpm test: ${args.error}\n\n${TEST_USAGE}`)
  process.exit(2)
}

const plan = planTests(
  process.env,
  { kitOnly: existsSync(path.join(ROOT, WEB_DIR, 'tests/kit-only')) },
  args
)
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
