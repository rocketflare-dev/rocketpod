#!/usr/bin/env node
/**
 * `pnpm gate` — lint, typecheck, test, build: an app's checks, defined once. The pre-commit gate,
 * a copy's one CI job, and Launch's ship gate all run this. Steps and flags: `lib/gate-lib.mjs`.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

const failed = []
const timings = []
const ran = []
for (const id of args.steps) {
  const step = GATE_STEPS.find(s => s.id === id)
  if (!step) continue
  console.log(`\n━━ gate: ${id} ━━ ${step.display}`)
  const started = Date.now()
  const [bin, ...rest] = step.command
  const { status } = spawnSync(bin, rest, { cwd: ROOT, stdio: 'inherit' })
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
if (failed.length) {
  console.error(`✖ pnpm gate failed: ${failed.join(', ')}`)
  process.exit(1)
}
console.log('✔ pnpm gate passed')

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
