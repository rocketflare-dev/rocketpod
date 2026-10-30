#!/usr/bin/env node
/**
 * The local dev Postgres, addressed by ONE value: `DATABASE_URL` in `apps/web/.env`.
 *
 * A fixed port 5432 and a fixed `container_name` in `docker-compose.dev.yml` would stop a second
 * checkout of the app on the same machine from starting its database at all — it would either
 * collide on the port or silently attach to the other checkout's container (compose derives
 * its project name from the directory, and every checkout's is `apps/web`). This script gives
 * each checkout its own project, container and port, and writes the port it chose into
 * `.env` so every other tool — `db:migrate`, `seed`, `drizzle-kit`, the Node server — follows
 * without being told.
 *
 *   node scripts/dev-db.mjs up     [--json]   start it (idempotent; prints the port)
 *   node scripts/dev-db.mjs down   [--json]   stop THIS checkout's database, never another's
 *   node scripts/dev-db.mjs status [--json]   what is running, where, on which port
 *   node scripts/dev-db.mjs env -- <cmd…>     run <cmd> with DATABASE_URL pointing at this
 *                                             database
 *
 * The port is sticky: a re-run keeps the one already in `.env` whenever it is still ours or
 * still free, so a working database never moves underneath a checkout.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkoutTag,
  chooseDevDbPort,
  DEV_DB_PORT_START,
  DEV_S3_PORT_START,
  databaseUrlPort,
  databaseUrlTarget,
  isLocalDatabaseUrl,
  readDevVars,
  TEST_S3_PORT,
  upsertDevVar,
  withDatabaseUrlPort,
} from '../../../scripts/lib/bootstrap-lib.mjs'

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPOSE_FILE = path.join(WEB_DIR, 'docker-compose.dev.yml')
const DEV_VARS = path.join(WEB_DIR, '.env')
const DEV_VARS_EXAMPLE = path.join(WEB_DIR, '.env.example')
const SERVICE = 'postgres-dev'
/** The S3 gateway beside it — uploads on the Node server. */
const S3_SERVICE = 's3-dev'

/** This checkout's compose project — unique per path, so two checkouts never share containers. */
const PROJECT = `rocketpod-dev-${checkoutTag(WEB_DIR)}`

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', cwd: WEB_DIR, ...opts })

/** The DATABASE_URL a fresh checkout starts from (.env, else the example). */
function currentUrl() {
  for (const file of [DEV_VARS, DEV_VARS_EXAMPLE]) {
    if (!existsSync(file)) continue
    const url = readDevVars(readFileSync(file, 'utf8')).DATABASE_URL
    if (url) return url
  }
  return 'postgresql://rocketpod:rocketpod_pass@localhost:5432/rocketpod_dev'
}

/** Every port published by a container of THIS checkout's compose project. */
function oursPorts() {
  const ps = sh('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'ps', '--format', 'json'])
  if (ps.status !== 0) return new Set()
  const ports = new Set()
  for (const line of ps.stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      for (const p of JSON.parse(line).Publishers ?? []) {
        if (p.PublishedPort) ports.add(Number(p.PublishedPort))
      }
    } catch {
      /* a docker version that prints something else: fall through to the free-port test */
    }
  }
  return ports
}

/**
 * `0.0.0.0`, not `127.0.0.1`: compose publishes on the wildcard address, and on macOS a
 * loopback bind SUCCEEDS while Docker holds the same port — which is exactly how a second
 * checkout would sail past the check and then fail inside `docker compose up`.
 */
const portIsFree = port =>
  new Promise(resolve => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '0.0.0.0')
  })

/**
 * The port this checkout should use, and the URL carrying it. Sticky: the port already in
 * `.env` wins whenever it is still ours or still free.
 */
async function resolvePort() {
  const url = currentUrl()
  const preferred = databaseUrlPort(url)
  // An off-box DATABASE_URL (`pnpm bootstrap --db-url`, a Neon branch) is not ours to re-port:
  // hand it through unchanged, and `up` has nothing to start.
  if (!isLocalDatabaseUrl(url)) return { port: preferred, url, moved: false, external: true }
  const ours = oursPorts()
  const free = new Map()
  for (let p = DEV_DB_PORT_START; p < DEV_DB_PORT_START + 20; p += 1) {
    free.set(p, await portIsFree(p))
  }
  const isAvailable = port => ours.has(port) || free.get(port) === true
  const port = chooseDevDbPort({ preferred, isAvailable })
  if (port === null) {
    console.error(
      `dev-db: no free port in ${DEV_DB_PORT_START}–${DEV_DB_PORT_START + 19} for the dev database`
    )
    process.exit(1)
  }
  return {
    port,
    url: withDatabaseUrlPort(url, port),
    moved: preferred !== null && port !== preferred,
  }
}

/** Persist values in `.env` so every other tool reads them through dotenv. */
function writeDevVars(values) {
  if (!existsSync(DEV_VARS)) return false
  const text = readFileSync(DEV_VARS, 'utf8')
  let next = text
  for (const [key, value] of Object.entries(values)) next = upsertDevVar(next, key, value)
  if (next === text) return false
  writeFileSync(DEV_VARS, next)
  return true
}

const composeEnv = (port, url, s3Port = DEV_S3_PORT_START) => ({
  ...process.env,
  COMPOSE_PROJECT_NAME: PROJECT,
  DEV_DB_PORT: String(port),
  DEV_DB_CONTAINER: `rocketpod-dev-postgres-${checkoutTag(WEB_DIR)}`,
  DEV_S3_PORT: String(s3Port),
  DEV_S3_CONTAINER: `rocketpod-dev-s3-${checkoutTag(WEB_DIR)}`,
  DATABASE_URL: url,
})

/** The STORAGE_* values a fresh checkout starts from (.env, else the example). */
function currentStorage() {
  for (const file of [DEV_VARS, DEV_VARS_EXAMPLE]) {
    if (!existsSync(file)) continue
    const vars = readDevVars(readFileSync(file, 'utf8'))
    if (vars.STORAGE_ENDPOINT || vars.STORAGE_DRIVER) return vars
  }
  return {}
}

/** A STORAGE_ENDPOINT on this machine (or none at all) is ours to start and re-port. */
function isLocalEndpoint(endpoint) {
  if (!endpoint) return true
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)
  } catch {
    return false
  }
}

/**
 * The S3 gateway's port — sticky like the database's: the one in STORAGE_ENDPOINT wins while it
 * is still ours or still free. `null` when storage is not ours to start (an off-box endpoint).
 */
async function resolveS3Port() {
  const vars = currentStorage()
  if (vars.STORAGE_DRIVER === '' || !isLocalEndpoint(vars.STORAGE_ENDPOINT)) return null
  let preferred = null
  try {
    preferred = vars.STORAGE_ENDPOINT ? Number(new URL(vars.STORAGE_ENDPOINT).port) || null : null
  } catch {
    preferred = null
  }
  const ours = oursPorts()
  const free = new Map()
  for (let p = DEV_S3_PORT_START; p < DEV_S3_PORT_START + 20; p += 1) {
    free.set(p, await portIsFree(p))
  }
  const isAvailable = port => ours.has(port) || free.get(port) === true
  return chooseDevDbPort({
    preferred,
    isAvailable,
    start: DEV_S3_PORT_START,
    count: 20,
    skip: [TEST_S3_PORT],
  })
}

async function up(json) {
  const { port, url, moved, external } = await resolvePort()
  if (external) {
    const target = databaseUrlTarget(url)
    if (json) console.log(JSON.stringify({ external: true, target }))
    else console.log(`DATABASE_URL points at ${target} (not this machine) — nothing to start`)
    return
  }
  const s3Port = await resolveS3Port()
  const env = composeEnv(port, url, s3Port ?? S3_PORT_START)
  const services = s3Port === null ? [SERVICE] : [SERVICE, S3_SERVICE]
  const result = spawnSync(
    'docker',
    ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'up', '-d', '--wait', ...services],
    { cwd: WEB_DIR, env, stdio: json ? 'pipe' : 'inherit' }
  )
  if (result.status !== 0) {
    if (json) process.stderr.write(result.stderr ?? '')
    process.exit(result.status ?? 1)
  }
  const storage =
    s3Port === null
      ? {}
      : {
          STORAGE_DRIVER: 's3',
          STORAGE_ENDPOINT: `http://localhost:${s3Port}`,
          STORAGE_BUCKET: 'rocketpod-dev',
          STORAGE_ACCESS_KEY_ID: 'rocketpod-dev',
          STORAGE_SECRET_ACCESS_KEY: 'rocketpod-dev-secret',
          STORAGE_FORCE_PATH_STYLE: 'true',
        }
  const wrote = writeDevVars({ DATABASE_URL: url, ...storage })
  if (json) {
    console.log(JSON.stringify({ port, url, s3Port, project: PROJECT, moved, wroteDevVars: wrote }))
  } else {
    console.log(`dev database ready on :${port}  (project ${PROJECT})`)
    if (s3Port !== null) console.log(`dev object storage (S3) ready on :${s3Port}`)
    if (moved)
      console.log(`  :${port} chosen because the previous port was taken by something else`)
    if (wrote) console.log('  apps/web/.env updated to match')
  }
}

async function down(json) {
  const { port, url } = await resolvePort()
  const result = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'down'], {
    cwd: WEB_DIR,
    env: composeEnv(port, url),
    stdio: json ? 'pipe' : 'inherit',
  })
  if (json) console.log(JSON.stringify({ project: PROJECT, code: result.status ?? 0 }))
  process.exit(result.status ?? 0)
}

/** Every dev database of this app on the machine, whichever checkout started it. */
function allDevDatabases() {
  const ps = sh('docker', [
    'ps',
    '--filter',
    `label=com.docker.compose.service=${SERVICE}`,
    '--format',
    '{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project.working_dir"}}',
  ])
  if (ps.status !== 0 || !ps.stdout) return [] // no docker (an external-database checkout)
  return ps.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name, ports, dir] = line.split('\t')
      return { name, ports, dir, ours: dir === WEB_DIR }
    })
}

async function status(json) {
  const { port, url, external } = await resolvePort()
  const rows = allDevDatabases()
  if (json) {
    // An external URL carries a real password: report where it points, never the URL itself.
    const where = external ? { external: true, target: databaseUrlTarget(url) } : { port, url }
    console.log(JSON.stringify({ project: PROJECT, ...where, containers: rows }))
    return
  }
  console.log(`this checkout: ${WEB_DIR}`)
  if (external)
    console.log(`  external database ${databaseUrlTarget(url)} (pnpm bootstrap --db-url)`)
  else console.log(`  project ${PROJECT} · port ${port}`)
  if (rows.length === 0) {
    console.log('  no dev Postgres container is running')
    return
  }
  console.log('running dev databases on this machine:')
  for (const row of rows) {
    console.log(`  ${row.ours ? '*' : ' '} ${row.name}  ${row.ports}  ${row.dir}`)
  }
}

/** `env -- <cmd…>`: run a child against this checkout's database. */
async function env(argv) {
  const rest = argv.slice(argv.indexOf('--') + 1)
  if (argv.indexOf('--') === -1 || rest.length === 0) {
    console.error('usage: node scripts/dev-db.mjs env -- <command> [args…]')
    process.exit(2)
  }
  const { port, url } = await resolvePort()
  const child = spawn(rest[0], rest.slice(1), {
    cwd: process.cwd(),
    env: composeEnv(port, url),
    stdio: 'inherit',
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
}

const argv = process.argv.slice(2)
const command = argv[0] ?? 'up'
const json = argv.includes('--json')
if (command === 'up') await up(json)
else if (command === 'down') await down(json)
else if (command === 'status') await status(json)
else if (command === 'env') await env(argv)
else {
  console.error(`dev-db: unknown command "${command}" (up | down | status | env -- <cmd>)`)
  process.exit(2)
}
