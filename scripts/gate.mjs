#!/usr/bin/env node
/**
 * `pnpm gate` — lint, typecheck, test, build: an app's checks, defined once. The pre-commit gate,
 * a copy's CI (in parallel parts, .github/workflows/ci.yml) and Launch's ship gate all run this.
 * Steps and flags: `lib/gate-lib.mjs`.
 *
 * `--changed` runs each step over what the branch changed (`lib/gate-changed.mjs` decides) — the
 * fast loop for local commits. A push still gets the full gate; CI never runs `--changed`.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEvalWarnings, renderEvalWarnings } from './lib/eval-warnings.mjs'
import { planChanged } from './lib/gate-changed.mjs'
import { changedFiles, resolveBase, workspacePackages } from './lib/gate-changed-git.mjs'
import {
  GATE_STEPS,
  GATE_USAGE,
  GATE_VERDICT_FILE,
  gateList,
  gateVerdict,
  parseGateArgs,
} from './lib/gate-lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = parseGateArgs(process.argv.slice(2))
if ('help' in args) {
  console.log(GATE_USAGE)
  process.exit(0)
}
if ('error' in args) {
  console.error(`pnpm gate: ${args.error}\n\n${GATE_USAGE}`)
  process.exit(2)
}

if (args.list) {
  const list = gateList()
  if (args.json) console.log(JSON.stringify(list, null, 2))
  else for (const s of list.steps) console.log(`${s.id.padEnd(10)} ${s.command}`)
  process.exit(0)
}

/** @type {Record<string, { display: string, runs: { cwd: string, command: string[], env?: Record<string, string> }[] }>} */
const steps = Object.fromEntries(
  GATE_STEPS.map(s => [s.id, { display: s.display, runs: [{ cwd: '.', command: s.command }] }])
)
let partial = false
if (args.changed !== null) {
  const base = resolveBase(ROOT, args.changed)
  if ('error' in base) {
    console.error(`pnpm gate --changed: ${base.error}`)
    process.exit(2)
  }
  const { changed, existing } = changedFiles(ROOT, base.base)
  const plan = planChanged({ changed, existing, packages: workspacePackages(ROOT) })
  console.log(
    `gate --changed: ${changed.length} path(s) since ${base.base.slice(0, 10)} (${base.label})`
  )
  if ('full' in plan) console.log(`· ${plan.full} — running the full gate`)
  else if (changed.length === 0) {
    console.log('✔ nothing changed — nothing to gate')
    process.exit(0)
  } else {
    Object.assign(steps, changedSteps(plan, base.base))
    partial = true
  }
}

/** The steps over a `--changed` plan; a step with no runs is reported as skipped. */
function changedSteps(plan, base) {
  return {
    lint: {
      display: `biome check on ${plan.lint.length} file(s)`,
      runs: plan.lint.length
        ? [
            {
              cwd: '.',
              command: [
                path.join(ROOT, 'node_modules/.bin/biome'),
                'check',
                '--error-on-warnings',
                '--no-errors-on-unmatched',
                '--files-ignore-unknown=true',
                ...plan.lint,
              ],
            },
          ]
        : [],
    },
    typecheck: {
      display: `typecheck in ${plan.typecheck.join(', ') || 'no package'}`,
      runs: plan.typecheck.map(dir => ({
        cwd: '.',
        command: ['pnpm', '--filter', `./${dir}`, 'typecheck'],
      })),
    },
    test: {
      display: 'pnpm test --changed (the tests the change reaches)',
      runs:
        plan.test.web || plan.test.packages.length
          ? [{ cwd: '.', command: [process.execPath, 'scripts/test.mjs', `--changed=${base}`] }]
          : [],
    },
    build: {
      display: `build in ${plan.build.join(', ') || 'no package'}`,
      runs: plan.build.map(dir => ({
        cwd: '.',
        command: ['pnpm', '--filter', `./${dir}`, 'build'],
      })),
    },
  }
}

const failed = []
const timings = []
const ran = []
const gateStarted = Date.now()
for (const id of args.steps) {
  const step = steps[id]
  if (!step) continue
  console.log(`\n━━ gate: ${id} ━━ ${step.display}`)
  if (step.runs.length === 0) {
    console.log('· nothing to do for this change')
    timings.push(`${id} skipped`)
    ran.push({ id, seconds: 0, ok: true, skipped: true })
    continue
  }
  const started = Date.now()
  let status = 0
  for (const run of step.runs) {
    const [bin, ...rest] = run.command
    status = spawnSync(bin, rest, { cwd: path.join(ROOT, run.cwd), stdio: 'inherit' }).status ?? 1
    if (status !== 0) break
  }
  const seconds = Math.round((Date.now() - started) / 1000)
  timings.push(`${id} ${seconds}s${status === 0 ? '' : ' ✖'}`)
  ran.push({ id, seconds, ok: status === 0 })
  if (status !== 0) {
    failed.push(id)
    if (!args.keepGoing) break
  }
}

console.log(`\ngate: ${timings.join(' · ')}`)
writeVerdict()
// The eval coverage contract's drift warnings (the `test` step wrote them): last, so they are seen.
const evalWarnings = renderEvalWarnings(readEvalWarnings(ROOT, gateStarted))
if (evalWarnings) console.warn(evalWarnings)
if (failed.length) {
  console.error(`✖ pnpm gate failed: ${failed.join(', ')}`)
  process.exit(1)
}

/** `.gate/last.json` — the verdict to read before a commit or a tag (`gateVerdict`). */
function writeVerdict() {
  const git = argv => {
    const r = spawnSync('git', argv, { cwd: ROOT, encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : null
  }
  const status = git(['status', '--porcelain', '--untracked-files=no'])
  const verdict = gateVerdict({
    requested: args.steps,
    ran,
    sha: git(['rev-parse', 'HEAD']),
    dirty: status === null ? null : status !== '',
    changed: partial,
    finishedAt: new Date().toISOString(),
  })
  try {
    const file = path.join(ROOT, GATE_VERDICT_FILE)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(verdict, null, 2)}\n`)
  } catch (err) {
    console.error(`gate: could not write ${GATE_VERDICT_FILE}: ${err.message}`)
  }
}
console.log(
  !partial
    ? '✔ pnpm gate passed'
    : '✔ pnpm gate --changed passed — run the full `pnpm gate` before you push'
)
