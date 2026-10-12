#!/usr/bin/env node
/**
 * One-shot first run (`pnpm bootstrap`, or `bash scripts/bootstrap.sh` when Node/pnpm may be
 * missing): ten steps from a fresh clone to a running stack with the browser signed in — the
 * hand-run walkthrough in SETUP.md Part 1, as one idempotent command. Every step is re-runnable on
 * a half-done machine: it inspects before it acts and never overwrites a value a person wrote.
 *
 *   1 toolchain   2 install   3 secrets   4 database   5 migrate   6 plugins
 *   7 seed        8 ai          9 cli      10 run
 *
 * Output follows `apps/web/scripts/dev-server.mjs`: each child's output is buffered and shown only
 * when it fails (`--verbose` / `DEV_VERBOSE=1` streams everything), one `✔ n/10` line per step with
 * its verification, and the dev stack is started through `pnpm dev` so its preflight sweep and
 * ownership rules apply unchanged. Everything shells out to the root pnpm scripts — `migrate.ts`
 * and `seed.ts` need `tsx` and `node_modules`, which may not exist yet.
 *
 * `--check` (`pnpm preflight`) is the read-only half (plus an informational `· tracing` line, D32): steps 1, 3, 4 (one `db:check`, no compose
 * up), 8 and `dev-server.mjs --status`, every failure listed, exit 3 if any.
 *
 * `--db-url <url>` bootstraps against a database this checkout does not run (a Neon branch in a
 * sandbox with no Docker): no Docker checks, DATABASE_URL upserted in step 3, step 4 only polls
 * `db:check`, step 7 seeds with SEED_ALLOW_REMOTE=1. Still ten steps. `bootstrapStepPlan` decides.
 *
 * For a caller that has done part of the work itself (a coding sandbox: its own `pnpm install`, a
 * database it just made): `--no-install` leaves step 2 out, `ROCKETPOD_BOOTSTRAP_SKIP` names any
 * of steps 1–8 to leave out, and `ROCKETPOD_ALLOW_ROOT=1` lifts the root refusal (a container
 * whose commands all run as root). None of them is set by a person's normal run.
 *
 * Exit codes: 0 ok · 1 a step failed · 2 usage · 3 prerequisite missing · 4 a port or the Postgres
 * container is held by another checkout.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BootstrapUsageError,
  bootstrapStepPlan,
  databaseUrlPort,
  describeAi,
  describeTracing,
  extractSeedKey,
  fillDevVars,
  localDriverFor,
  parseBootstrapArgs,
  parseNvmrc,
  planDefaultPlugins,
  readDevVars,
  upsertDevVar,
  versionAtLeast,
} from './lib/bootstrap-lib.mjs'
import { devPorts } from './lib/dev-ports.mjs'
import { pluginSurfaces, readManifest } from './lib/manifest.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const WEB_DIR = path.join(REPO_ROOT, 'apps/web')
const DEV_VARS = path.join(WEB_DIR, '.env')
const DEV_VARS_EXAMPLE = path.join(WEB_DIR, '.env.example')
/** Keys `config.ts` validates with `optionalSecret(32)` — blank is "unset", short is a ConfigError. */
const REQUIRED_SECRETS = ['OAUTH_ENCRYPTION_KEY']
const SECRET_MIN_LENGTH = 32
/** :3001 / :3000 unless DEV_API_PORT / DEV_UI_PORT are set (shell or .env). */
const DEV_PORTS = devPorts()
const API_URL = `http://localhost:${DEV_PORTS.api}`
const UI_URL = `http://localhost:${DEV_PORTS.ui}`
const HEALTH_TIMEOUT_MS = 90_000
const DB_CHECK_ATTEMPTS = 30
/** `--db-url`: nothing is booting, so a short retry covers a Neon compute waking from idle. */
const EXTERNAL_DB_CHECK_ATTEMPTS = 5
const TOTAL_STEPS = 10
const TAIL_LINES = 30

const EXIT = { ok: 0, failed: 1, usage: 2, prerequisite: 3, held: 4 }

// ---- Arguments ---------------------------------------------------------------------------------

const USAGE = `Usage: pnpm bootstrap [options]        (or: bash scripts/bootstrap.sh [options])

Take a fresh clone to a running, signed-in dev stack in one command. Re-runnable.

  --yes         never prompt
  --offline, --online
                accepted and ignored (Rocketflare's Workers AI toggle; Rocketpod has none —
                set an AI provider key in apps/web/.env, see step 8)
  --no-dev      stop after step 8 and print the commands to run next
  --no-demo     seed without the demo data (plain \`pnpm seed\`)
  --no-plugins  skip the plugins step (do not install .rocketflare.json's defaultPlugins)
  --no-install  skip step 2 (\`pnpm install\`) when the caller has just installed; still checks
                that apps/web/node_modules/.bin/tsx is there
  --share-db    accepted and ignored: every checkout now gets its own database (pnpm dev:db:status)
  --no-open     do not open the browser once the server answers
  --as <email>  seeded account to sign in as (default owner@example.test)
  --db-url <url>
                use this Postgres (e.g. a Neon branch) instead of the Docker one: no Docker
                checks, DATABASE_URL written to apps/web/.env, step 4 only waits for it,
                the seed may write to it (SEED_ALLOW_REMOTE=1). Also --db-url=<url>;
                not with --check
  --driver postgres
                the LOCAL database driver, written to apps/web/.env (D35). postgres is the
                only one (Rocketpod removed neon); accepted for Launch's bootstrap command
  --check      read-only preflight (= pnpm preflight): toolchain, secrets, database, AI
                providers, dev status; exit 3 when anything is missing
  --verbose     stream every child's output (also DEV_VERBOSE=1)
  --help        this text

Environment (for a caller that has done part of the work itself — a coding sandbox; not --check):
  ROCKETPOD_BOOTSTRAP_SKIP=<steps>
                comma-separated steps to leave out: toolchain, install, secrets, database,
                migrate, plugins, seed, ai (an unknown name is exit 2)
  ROCKETPOD_ALLOW_ROOT=1
                run as root (a container whose commands all run as uid 0)

Exit codes: 0 ok · 1 a step failed · 2 usage · 3 prerequisite missing · 4 port/container held by
another checkout`

/** A step's failure: what to print (the child's tail + a fix hint) and how to exit. */
class StepError extends Error {
  constructor(message, { hint = '', output = '', exitCode = EXIT.failed } = {}) {
    super(message)
    this.hint = hint
    this.output = output
    this.exitCode = exitCode
  }
}

// ---- Output ------------------------------------------------------------------------------------

const tty = process.stdout.isTTY === true
const ESC = String.fromCharCode(27) // built, not a literal: biome rejects the control char
const paint = code => text => (tty ? `${ESC}[${code}m${text}${ESC}[0m` : text)
const green = paint('32')
const red = paint('31')
const dim = paint('2')
const bold = paint('1')

const say = text => process.stdout.write(`${text}\n`)
const tail = output =>
  output
    .split('\n')
    .filter(line => line.trim() !== '')
    .slice(-TAIL_LINES)

const stepLabel = (n, name) => `${String(n)}/${TOTAL_STEPS} ${name.padEnd(10)}`

function printOk(n, name, verify, notes = []) {
  say(`${green('✔')} ${stepLabel(n, name)} ${verify}`)
  for (const note of notes) say(`  ${dim(note)}`)
}

function printFail(n, name, err) {
  say(`${red('✖')} ${stepLabel(n, name)} ${err.message}`)
  for (const line of tail(err.output ?? '')) say(`  ${dim(line)}`)
  if (err.hint) say(`  ${bold('fix:')} ${err.hint}`)
}

// ---- Children ----------------------------------------------------------------------------------

let verbose = false

/**
 * Run a child, buffering its combined output; `verbose` streams it as well. Resolves with
 * `{ code, output }` and never rejects — a missing binary is `code: 127` with the error as output.
 */
function run(cmd, args, { cwd = REPO_ROOT, env = process.env, input } = {}) {
  return new Promise(resolve => {
    let output = ''
    let child
    try {
      child = spawn(cmd, args, { cwd, env, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: 127, output: String(error) })
      return
    }
    const consume = stream => {
      stream.setEncoding('utf8')
      stream.on('data', chunk => {
        output += chunk
        if (verbose) process.stdout.write(chunk)
      })
    }
    consume(child.stdout)
    consume(child.stderr)
    child.on('error', error => resolve({ code: 127, output: `${output}\n${error.message}` }))
    child.on('close', code => resolve({ code: code ?? 1, output }))
    if (input) child.stdin.end(input)
  })
}

const has = bin => spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** `pnpm <script> …` at the root — the only way the bootstrap reaches migrate/seed/db:check. */
const pnpm = (args, opts) => run('pnpm', args, opts)

// ---- Steps -------------------------------------------------------------------------------------

/** `plan.docker` false (`--db-url`, or preflight against an off-box DATABASE_URL): no Docker. */
async function stepToolchain(plan) {
  const nvmrc = parseNvmrc(readFileSync(path.join(REPO_ROOT, '.nvmrc'), 'utf8'))
  if (!versionAtLeast(process.version, nvmrc)) {
    throw new StepError(`node ${process.version} < ${nvmrc}`, {
      hint: `bash scripts/bootstrap.sh installs Node ${nvmrc} via fnm/nvm, or: nvm install ${nvmrc}`,
      exitCode: EXIT.prerequisite,
    })
  }
  const pnpmVersion = await pnpm(['-v'])
  const pnpmV = pnpmVersion.output.trim().split('\n').pop() ?? ''
  if (pnpmVersion.code !== 0 || !pnpmV.startsWith('10.')) {
    throw new StepError(`pnpm 10.x not found (${pnpmV || 'missing'})`, {
      hint: 'corepack enable   (reads packageManager from package.json)',
      output: pnpmVersion.output,
      exitCode: EXIT.prerequisite,
    })
  }
  const tools = await dockerToolchain(plan)
  for (const bin of ['lsof', 'ps', 'git']) {
    if (!has(bin)) {
      throw new StepError(`${bin} not on PATH`, {
        hint: `install ${bin} (dev-server.mjs needs lsof/ps to own its ports)`,
        exitCode: EXIT.prerequisite,
      })
    }
  }
  return { verify: `node ${process.version} · pnpm ${pnpmV} · ${tools}` }
}

/** The Docker half of step 1; skipped when the database is not ours to run. */
async function dockerToolchain(plan) {
  if (!plan.docker) return `docker skipped (external database ${plan.target})`
  const docker = await run('docker', ['info', '--format', '{{.ServerVersion}}'])
  if (docker.code !== 0) {
    throw new StepError('docker daemon not reachable', {
      hint:
        process.platform === 'darwin'
          ? 'brew install colima docker && colima start   (or start Docker Desktop)'
          : 'install Docker Engine, add your user to the docker group, start the daemon',
      output: docker.output,
      exitCode: EXIT.prerequisite,
    })
  }
  const compose = await run('docker', ['compose', 'version', '--short'])
  if (compose.code !== 0) {
    throw new StepError('docker compose (v2 plugin) not found', {
      hint: 'install the docker-compose-plugin (Docker Desktop and colima ship it)',
      output: compose.output,
      exitCode: EXIT.prerequisite,
    })
  }
  return `docker ${docker.output.trim()} · compose ${compose.output.trim()}`
}

/** `skipped` (`--no-install`): the caller just installed; only the tsx binary is checked. */
async function stepInstall({ skipped = false } = {}) {
  const tsx = path.join(WEB_DIR, 'node_modules/.bin/tsx')
  if (skipped) {
    if (!existsSync(tsx)) {
      throw new StepError('apps/web/node_modules/.bin/tsx missing (install skipped)', {
        hint: 'pnpm install, or run the bootstrap without --no-install',
        exitCode: EXIT.prerequisite,
      })
    }
    return { verify: 'skipped (--no-install); apps/web/node_modules/.bin/tsx present' }
  }
  const result = await pnpm(['install', '--prefer-offline'])
  if (result.code !== 0) {
    throw new StepError('pnpm install failed', {
      hint: 'read the tail above; a registry outage is the usual cause — re-run',
      output: result.output,
    })
  }
  if (!existsSync(tsx)) {
    throw new StepError('apps/web/node_modules/.bin/tsx missing after install', {
      hint: 'pnpm install --force',
      output: result.output,
    })
  }
  return { verify: 'apps/web/node_modules/.bin/tsx present' }
}

/**
 * Verify-only when `write` is false (`--check`). `dbUrl` (`--db-url`) is written as DATABASE_URL —
 * an explicit flag, so it replaces whatever the file had; the value itself is never printed.
 */
function stepSecrets({ write, dbUrl = null, driver = null }) {
  const example = readFileSync(DEV_VARS_EXAMPLE, 'utf8')
  const existing = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, 'utf8') : null
  const notes = []
  let text = existing
  if (write) {
    const result = fillDevVars(
      example,
      existing,
      () => randomBytes(32).toString('hex'),
      REQUIRED_SECRETS
    )
    text = result.text
    if (dbUrl) {
      const before = text
      text = upsertDevVar(text, 'DATABASE_URL', dbUrl)
      if (text !== before) notes.push('DATABASE_URL set from --db-url')
    }
    // D35: the local driver. Written only when it changes, so a re-run never churns the file.
    const current = readDevVars(text)
    const local = localDriverFor({ flag: driver, dbUrl, existing: current.DATABASE_DRIVER })
    if (current.DATABASE_DRIVER !== local) {
      text = upsertDevVar(text, 'DATABASE_DRIVER', local)
      notes.push(`DATABASE_DRIVER=${local} (local driver)`)
    }
    if (existing === null || text !== existing) writeFileSync(DEV_VARS, text)
    if (existing === null) notes.push('created apps/web/.env from .env.example')
    if (result.filled.length > 0) notes.push(`generated ${result.filled.join(', ')}`)
    for (const key of result.missing) {
      notes.push(`warning: ${key} is in .env.example but not in your .env`)
    }
  } else if (text === null) {
    throw new StepError('apps/web/.env is missing', {
      hint: 'pnpm bootstrap (creates it from .env.example and generates the keys)',
      exitCode: EXIT.prerequisite,
    })
  }
  const values = readDevVars(text)
  const short = REQUIRED_SECRETS.filter(key => (values[key] ?? '').length < SECRET_MIN_LENGTH)
  if (short.length > 0) {
    throw new StepError(`${short.join(', ')} must be at least ${SECRET_MIN_LENGTH} characters`, {
      hint: `openssl rand -hex 32 → ${short[0]} in apps/web/.env`,
      exitCode: EXIT.prerequisite,
    })
  }
  return {
    verify: `${REQUIRED_SECRETS.join(', ')} set (≥ ${SECRET_MIN_LENGTH} chars) in apps/web/.env`,
    notes,
  }
}

const dbCheck = () => pnpm(['web', 'db:check'])
const dbVerifyLine = output =>
  output
    .split('\n')
    .filter(line => /^Connected to |^pgvector extension/.test(line))
    .join(' · ')

/** `--check`: one `db:check` against whatever DATABASE_URL says, no compose. */
async function stepDatabaseCheck(plan) {
  const result = await dbCheck()
  if (result.code !== 0) {
    if (plan.database === 'external') {
      throw new StepError(`external Postgres ${plan.target} not reachable`, {
        hint: 'check DATABASE_URL in apps/web/.env (host, password, sslmode) and the network',
        output: result.output,
        exitCode: EXIT.prerequisite,
      })
    }
    const url = existsSync(DEV_VARS)
      ? readDevVars(readFileSync(DEV_VARS, 'utf8')).DATABASE_URL
      : undefined
    const where = url ? `:${databaseUrlPort(url) ?? '?'}` : 'the configured port'
    throw new StepError(`Postgres on ${where} not reachable`, {
      hint: 'pnpm dev:db:up   (or pnpm bootstrap, which waits for it); pnpm dev:db:status lists them',
      output: result.output,
      exitCode: EXIT.prerequisite,
    })
  }
  const line = dbVerifyLine(result.output)
  return { verify: plan.database === 'external' ? `external ${plan.target} · ${line}` : line }
}

/**
 * `--db-url`: the database is somebody else's to run (a Neon branch, a shared server), so there is
 * no compose and no port to own — only wait for it to answer. Step 3 already wrote DATABASE_URL.
 */
async function stepExternalDatabase(plan) {
  let last = { code: 1, output: '' }
  for (let attempt = 1; attempt <= EXTERNAL_DB_CHECK_ATTEMPTS; attempt += 1) {
    last = await dbCheck()
    if (last.code === 0) break
    await sleep(2000)
  }
  if (last.code !== 0) {
    throw new StepError(`external Postgres ${plan.target} did not answer`, {
      hint: 'check the --db-url value (host, password, ?sslmode=require for Neon) and the network',
      output: last.output,
    })
  }
  return { verify: `external ${plan.target} · ${dbVerifyLine(last.output)}` }
}

async function stepDatabase(opts, plan) {
  if (plan.database === 'external') return stepExternalDatabase(plan)
  // scripts/dev-db.mjs owns the port, the container name and the compose project: it keeps the
  // port already in .env when that is still ours or still free, and otherwise picks the
  // next free one and writes it back. A second checkout therefore starts its OWN database
  // instead of colliding on 5432 or silently attaching to the first checkout's container.
  const up = await run('node', [path.join(WEB_DIR, 'scripts/dev-db.mjs'), 'up', '--json'], {
    cwd: WEB_DIR,
  })
  if (up.code !== 0) {
    throw new StepError('could not start the dev Postgres container', {
      hint: 'pnpm dev:db:status shows every dev database on this machine and who owns it',
      output: up.output,
      exitCode: EXIT.held,
    })
  }
  const notes = []
  if (opts.shareDbIgnored) {
    notes.push('--share-db is no longer needed: this checkout has its own database (ignored)')
  }
  let chosen = null
  try {
    chosen = JSON.parse(up.output.trim().split('\n').at(-1))
  } catch {
    /* older docker printing something unexpected: the db:check below is the real gate */
  }
  if (chosen?.moved) {
    notes.push(
      `port ${chosen.port}: the previous one was taken by another checkout or another program`
    )
  }
  if (chosen?.wroteDevVars) notes.push('apps/web/.env updated to match (DATABASE_URL, driver)')
  const orphan = await legacyVolume()
  if (orphan) {
    notes.push(
      `an older single-checkout volume is still on this machine: ${orphan}\n` +
        `  it holds the database this checkout used BEFORE per-checkout projects; nothing reads it now.\n` +
        `  remove it when you are sure: docker volume rm ${orphan}`
    )
  }
  // `--wait` honours the compose healthcheck, but first boot restarts postgres once after
  // pg_isready first succeeds — the poll is what migrate.ts's waitForDatabase would do.
  let last = { code: 1, output: '' }
  for (let attempt = 1; attempt <= DB_CHECK_ATTEMPTS; attempt += 1) {
    last = await dbCheck()
    if (last.code === 0) break
    await sleep(1000)
  }
  if (last.code !== 0) {
    throw new StepError(`Postgres did not answer within ${DB_CHECK_ATTEMPTS} s`, {
      hint: 'pnpm dev:db:status, then docker compose logs for the container it names',
      output: last.output,
    })
  }
  return { verify: dbVerifyLine(last.output), notes }
}

/**
 * The volume from before per-checkout compose projects (`web_<slug>-dev-data`), when it still
 * exists: this checkout no longer reads it, so say so once rather than leaving stray disk.
 */
async function legacyVolume() {
  const ls = await run('docker', ['volume', 'ls', '--format', '{{.Name}}'])
  if (ls.code !== 0) return null
  return ls.output.split('\n').find(name => name.trim() === 'web_rocketpod-dev-data') ?? null
}

async function stepMigrate() {
  const result = await pnpm(['db:migrate'])
  if (result.code !== 0 || !result.output.includes('Migrations applied')) {
    throw new StepError('pnpm db:migrate did not report "Migrations applied"', {
      hint: 'pnpm web db:check, then pnpm db:migrate by hand and read its output',
      output: result.output,
    })
  }
  return { verify: 'Migrations applied (role → migrations → grants)' }
}

/**
 * Install `.rocketflare.json`'s `defaultPlugins` (D31) — what makes a fresh clone of a kit whose
 * features live in plugins come up with those features already there.
 *
 * It runs BEFORE the seed on purpose: a plugin contributes a `hooks.seedDemo`, so installing one
 * after `pnpm seed` would leave the demo workspace missing exactly the rows the plugin exists to
 * show. And it runs the migration itself rather than printing it, because the bootstrap promises a
 * working app: a barrel line with no table is a checkout that does not typecheck.
 *
 * Idempotent: an id already recorded as a surface is skipped, never re-added (a second
 * `pnpm plugin add` of an installed plugin is exit 7).
 */
async function stepPlugins({ plugins }) {
  if (!plugins) return { verify: 'skipped (--no-plugins)' }
  const { manifest } = readManifest(REPO_ROOT)
  const declared = manifest?.defaultPlugins ?? []
  const plan = planDefaultPlugins(
    declared,
    pluginSurfaces(manifest).map(surface => surface.id)
  )
  if (plan.problems.length > 0) {
    throw new StepError(`.rocketflare.json defaultPlugins: ${plan.problems[0]}`, {
      hint: 'each entry is { "id": "…", "repo": "…", "ref"?: "…", "subdir"?: "…" }',
      output: plan.problems.join('\n'),
    })
  }
  if (plan.install.length === 0) {
    const verify =
      declared.length === 0
        ? 'no defaultPlugins declared — nothing to install'
        : `already installed: ${plan.skipped.join(', ')}`
    return { verify }
  }
  const installed = []
  for (const entry of plan.install) {
    const result = await pnpm(entry.args)
    if (result.code !== 0) {
      throw new StepError(`pnpm plugin add ${entry.spec} exited ${result.code}`, {
        hint: `pnpm plugin add ${entry.spec} (no --apply) and read the plan`,
        output: result.output,
      })
    }
    if (!verbose) process.stdout.write(result.output)
    installed.push(entry.id)
    // One migration per plugin, named after it, so the journal says which release brought which
    // tables — and so a failure names the plugin rather than "the schema".
    const generated = await pnpm(['db:generate', '--name', `plugin-${entry.id}`])
    if (generated.code !== 0) {
      throw new StepError(`pnpm db:generate for ${entry.id} exited ${generated.code}`, {
        hint: `pnpm db:generate --name plugin-${entry.id} by hand and read the SQL`,
        output: generated.output,
      })
    }
  }
  const migrated = await pnpm(['db:migrate'])
  if (migrated.code !== 0 || !migrated.output.includes('Migrations applied')) {
    throw new StepError(
      'pnpm db:migrate after the plugin schema did not report "Migrations applied"',
      {
        hint: 'pnpm db:migrate by hand and read its output',
        output: migrated.output,
      }
    )
  }
  const skipped = plan.skipped.length > 0 ? ` (already there: ${plan.skipped.join(', ')})` : ''
  return { verify: `installed ${installed.join(', ')}; tables generated and migrated${skipped}` }
}

/** Returns the one-time API key, kept in memory only, or undefined when the seed had one. */
async function stepSeed({ demo }, plan) {
  // `plan.seedEnv` is `SEED_ALLOW_REMOTE=1` under --db-url: seed.ts refuses a non-local host
  // otherwise, and the flag is the person saying this database is theirs to seed.
  const result = await pnpm(demo ? ['seed', '--demo'] : ['seed'], {
    env: { ...process.env, ...plan.seedEnv },
  })
  if (result.code !== 0) {
    throw new StepError('pnpm seed failed', {
      hint: 'pnpm seed by hand and read the error above',
      output: result.output,
    })
  }
  // The seed's stdout goes through unchanged: the one-time API key print is intentional.
  if (!verbose) process.stdout.write(result.output)
  const key = extractSeedKey(result.output)
  return {
    verify: key
      ? 'demo tenant + users; API key minted (shown once above)'
      : 'demo tenant + users; API key already existed',
    key,
  }
}

/**
 * Which AI providers `.env` configures — informational, never a failure: the stack runs without
 * one, and chat, agents, uploads and knowledge search answer 503 until a key is set (or a tenant
 * brings its own provider in Settings → AI). Values are never printed.
 */
function stepAi() {
  const values = existsSync(DEV_VARS) ? readDevVars(readFileSync(DEV_VARS, 'utf8')) : {}
  return { verify: describeAi(values) }
}

/** Step 9, run after the server answers: the CLI against the seed key, env of the child only. */
async function stepCli(key) {
  const result = await pnpm(['--silent', 'cli', 'whoami'], {
    env: { ...process.env, ROCKETPOD_API_KEY: key, ROCKETPOD_URL: API_URL },
  })
  if (result.code !== 0) {
    throw new StepError(`pnpm cli whoami exited ${result.code}`, {
      hint: `pnpm cli login --server ${API_URL}`,
      output: result.output,
    })
  }
  return { verify: 'pnpm cli whoami with the seed key', output: result.output }
}

/** Poll `/api/health` until it answers or the budget is spent (a dead child exits the process). */
async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_URL}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch {
      // ECONNREFUSED while the server boots is the normal state; keep polling.
    }
    await sleep(1000)
  }
  return false
}

function openBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    spawn(opener, [url], { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref()
  } catch {
    // No opener: the URL is printed anyway.
  }
}

// ---- Orchestration -----------------------------------------------------------------------------

/** Run one numbered step; print its line; a StepError ends the run with its exit code. */
async function step(n, name, fn) {
  try {
    const result = await fn()
    printOk(n, name, result.verify, result.notes)
    return result
  } catch (error) {
    const err = error instanceof StepError ? error : new StepError(String(error?.stack ?? error))
    printFail(n, name, err)
    process.exit(err.exitCode)
  }
}

async function check() {
  const failures = []
  const tryStep = async (n, name, fn) => {
    try {
      const result = await fn()
      printOk(n, name, result.verify, result.notes)
    } catch (error) {
      const err = error instanceof StepError ? error : new StepError(String(error))
      printFail(n, name, err)
      failures.push(name)
    }
  }
  // An off-box DATABASE_URL (a Neon branch set up by `--db-url`) means no Docker to check.
  const plan = bootstrapStepPlan({
    check: true,
    devVarsDatabaseUrl: existsSync(DEV_VARS)
      ? readDevVars(readFileSync(DEV_VARS, 'utf8')).DATABASE_URL
      : undefined,
  })
  await tryStep(1, 'toolchain', () => stepToolchain(plan))
  await tryStep(3, 'secrets', () => stepSecrets({ write: false }))
  await tryStep(4, 'database', () => stepDatabaseCheck(plan))
  await tryStep(8, 'ai', async () => stepAi())
  // Informational, never a failure (D32): where AI traces go. Secret values are never printed.
  if (existsSync(DEV_VARS)) {
    say(
      `${dim('·')} ${'tracing'.padEnd(15)} ${describeTracing(readDevVars(readFileSync(DEV_VARS, 'utf8')))}`
    )
  }
  const status = await run('node', [path.join(WEB_DIR, 'scripts/dev-server.mjs'), '--status'])
  say(dim('— pnpm dev:status —'))
  process.stdout.write(status.output)
  if (failures.length > 0) {
    say(`${red('✖')} preflight: ${failures.join(', ')} — fix the above and run pnpm bootstrap`)
    process.exit(EXIT.prerequisite)
  }
  say(`${green('✔')} preflight ok — pnpm bootstrap (or pnpm dev) is ready to run`)
}

async function bootstrap(opts) {
  say(bold(`Rocketpod bootstrap — ${REPO_ROOT}`))
  const plan = bootstrapStepPlan({ dbUrl: opts.dbUrl })
  const skip = new Set(opts.skip)
  // A step named in ROCKETPOD_BOOTSTRAP_SKIP prints its line and does nothing. `install` is the
  // exception: skipped, it still checks the tsx binary every later step relies on.
  const maybe = (n, name, fn) =>
    skip.has(name)
      ? step(n, name, () => ({ verify: 'skipped (ROCKETPOD_BOOTSTRAP_SKIP)' }))
      : step(n, name, fn)
  await maybe(1, 'toolchain', () => stepToolchain(plan))
  await step(2, 'install', () => stepInstall({ skipped: skip.has('install') }))
  await maybe(3, 'secrets', () =>
    stepSecrets({ write: true, dbUrl: opts.dbUrl, driver: opts.driver })
  )
  await maybe(4, 'database', () => stepDatabase(opts, plan))
  await maybe(5, 'migrate', stepMigrate)
  await maybe(6, 'plugins', () => stepPlugins(opts))
  const seeded = await maybe(7, 'seed', () => stepSeed({ demo: opts.demo }, plan))
  await maybe(8, 'ai', async () => stepAi())

  const loginUrl = `${UI_URL}/login?as=${encodeURIComponent(opts.as)}`
  if (!opts.dev) {
    const why = seeded.key ? '--no-dev' : 'no new seed key'
    printOk(9, 'cli', `skipped (${why}) — after \`pnpm dev\`: pnpm cli login --server ${API_URL}`)
    printOk(10, 'run', 'skipped (--no-dev). Next:')
    say('  pnpm dev')
    say(`  ${loginUrl}`)
    say(`  pnpm cli login --server ${API_URL}`)
    return
  }
  if (seeded.key) say(`${dim('·')} ${stepLabel(9, 'cli')} deferred until the server answers`)
  else if (skip.has('seed'))
    printOk(9, 'cli', 'skipped (seed skipped) — run `pnpm cli login` once the server is up')
  else printOk(9, 'cli', 'skipped — key already exists; run `pnpm cli login` once the server is up')

  // dev-server's preflight, piped, so a foreign port holder is a clear exit 4 rather than a
  // child dying on the terminal; `pnpm dev` runs the same sweep again (idempotent) in a moment.
  const preflight = await run('node', [path.join(WEB_DIR, 'scripts/dev-server.mjs'), '--preflight'])
  if (preflight.code !== 0) {
    printFail(
      10,
      'run',
      new StepError('a dev port is held by another checkout or app', {
        hint: 'stop it (pnpm dev:stop there, or kill <pid>) and re-run',
        output: preflight.output,
        exitCode: EXIT.held,
      })
    )
    process.exit(EXIT.held)
  }

  say(`${dim('·')} ${stepLabel(10, 'run')} starting pnpm dev (Ctrl-C stops everything)`)
  const startedAt = Date.now()
  const child = spawn('pnpm', ['dev'], { cwd: REPO_ROOT, env: process.env, stdio: 'inherit' })
  const forward = signal => () => {
    child.kill(signal)
  }
  process.on('SIGINT', forward('SIGINT'))
  process.on('SIGTERM', forward('SIGTERM'))
  // The stack's exit code is ours — except after a health timeout, where dev-server's clean
  // shutdown (exit 0) must not turn a failed step 9 into a success.
  let runFailed = false
  child.on('close', code => process.exit(runFailed ? EXIT.failed : (code ?? 0)))

  if (!(await waitForHealth())) {
    runFailed = true
    printFail(
      10,
      'run',
      new StepError(`${API_URL}/api/health did not answer within ${HEALTH_TIMEOUT_MS / 1000} s`, {
        hint: 'read the [api] lines above; pnpm dev:status shows what is running',
      })
    )
    child.kill('SIGTERM')
    return
  }
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1)
  printOk(10, 'run', `${API_URL}/api/health ok in ${secs}s`)

  if (seeded.key) {
    try {
      const cli = await stepCli(seeded.key)
      printOk(9, 'cli', cli.verify)
      for (const line of cli.output.trimEnd().split('\n')) say(`  ${line}`)
    } catch (error) {
      const err = error instanceof StepError ? error : new StepError(String(error))
      printFail(9, 'cli', err) // the server is up; a CLI hiccup does not stop the stack
    }
  }

  say(`${green('✔')} ready  ${bold(loginUrl)}`)
  if (opts.open) openBrowser(loginUrl)
  else say(dim('  (--no-open: open the URL above)'))
}

// ---- Main --------------------------------------------------------------------------------------

let opts
try {
  opts = parseBootstrapArgs(process.argv.slice(2), process.env)
} catch (error) {
  if (!(error instanceof BootstrapUsageError)) throw error
  process.stderr.write(`bootstrap: ${error.message}\n\n${USAGE}\n`)
  process.exit(EXIT.usage)
}
if (opts.help) {
  say(USAGE)
  process.exit(EXIT.ok)
}
verbose = opts.verbose
if (process.platform !== 'darwin' && process.platform !== 'linux') {
  process.stderr.write('bootstrap: macOS or Linux only (Windows: WSL2)\n')
  process.exit(EXIT.prerequisite)
}
// A container whose commands all run as root (a coding sandbox) says so explicitly; the container
// is its isolation boundary. Everyone else is refused, because root-owned node_modules and
// .env break the next run as the person's own user.
if (!opts.allowRoot && typeof os.userInfo === 'function' && os.userInfo().uid === 0) {
  process.stderr.write(
    'bootstrap: refusing to run as root — run as your own user (a container: ROCKETPOD_ALLOW_ROOT=1)\n'
  )
  process.exit(EXIT.prerequisite)
}
if (opts.check) await check()
else await bootstrap(opts)
