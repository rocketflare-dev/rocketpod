/**
 * Pure helpers for `scripts/bootstrap.mjs` — no I/O, no process access, so
 * `apps/web/tests/config/bootstrap-lib.test.ts` can pin every text transformation the bootstrap
 * performs on files it does not own (`.env`) and every parser it applies to another tool's stdout
 * (`pnpm seed`). Types: `bootstrap-lib.d.mts`.
 *
 * The one import is `upgrade-lib.mjs`, which is pure in the same sense — it owns the reader and the
 * validator for `.rocketflare.json`'s `defaultPlugins`, and a second parser here is what let the
 * bootstrap and `kit:release` disagree about a malformed entry.
 */
import { defaultPluginEntries, defaultPluginEntryProblems } from './upgrade-lib.mjs'

/** The major version in an `.nvmrc` (`24`, `v24.1.0`, `lts/*` → NaN). */
export function parseNvmrc(text) {
  const match = /^\s*v?(\d+)/.exec(text)
  return match ? Number(match[1]) : Number.NaN
}

/** `versionAtLeast('v24.16.0', 24)` → true. Tolerates a leading `v` and trailing text. */
export function versionAtLeast(vString, major) {
  const match = /^\s*v?(\d+)/.exec(vString ?? '')
  return match ? Number(match[1]) >= major : false
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

/** `KEY=`, `KEY=""` and `KEY=''` are all "unset" (config.ts treats a blank secret as absent). */
function isEmptyValue(value) {
  const v = value.trim()
  return v === '' || v === '""' || v === "''"
}

/**
 * Bring a `.env` up to the example's shape without touching anything a person wrote.
 *
 * - `existingText === null` → start from the example.
 * - Every required key that is empty is filled with `generate()`; a non-empty value is never
 *   overwritten. A required key the file does not have at all is appended, filled.
 * - Comments, blank lines, order and keys the example does not know are preserved byte for byte.
 * - `missing` lists the OPTIONAL keys the example has and the file lacks (a warning, not a fix).
 */
export function fillDevVars(exampleText, existingText, generate, requiredKeys) {
  const source = existingText ?? exampleText
  const lines = source.split('\n')
  const filled = []
  const present = new Set()
  const out = lines.map(line => {
    const match = KEY_LINE.exec(line)
    if (!match) return line
    const [, key, value] = match
    present.add(key)
    if (requiredKeys.includes(key) && isEmptyValue(value)) {
      filled.push(key)
      return `${key}=${generate()}`
    }
    return line
  })
  const exampleKeys = exampleText
    .split('\n')
    .map(line => KEY_LINE.exec(line)?.[1])
    .filter(key => key !== undefined)
  const missing = []
  const appended = []
  for (const key of exampleKeys) {
    if (present.has(key)) continue
    if (requiredKeys.includes(key)) {
      appended.push(`${key}=${generate()}`)
      filled.push(key)
    } else {
      missing.push(key)
    }
  }
  for (const key of requiredKeys) {
    if (!present.has(key) && !exampleKeys.includes(key)) {
      appended.push(`${key}=${generate()}`)
      filled.push(key)
    }
  }
  let text = out.join('\n')
  if (appended.length > 0) {
    if (!text.endsWith('\n')) text += '\n'
    text += `${appended.join('\n')}\n`
  }
  return { text, filled, missing }
}

/** Values of the `KEY=value` lines in a dotenv text (quotes stripped), for verification. */
export function readDevVars(text) {
  const values = {}
  for (const line of text.split('\n')) {
    const match = KEY_LINE.exec(line)
    if (!match) continue
    const raw = match[2].trim()
    values[match[1]] = isEmptyValue(raw) ? '' : raw.replace(/^(["'])(.*)\1$/, '$2')
  }
  return values
}

/**
 * Where AI traces go (D32), as preflight reports it — read from `.env` values, never printing
 * one that is a secret (keys, `OTEL_EXPORTER_OTLP_HEADERS`). Mirrors `exporterSettings` in
 * `apps/web/src/api/observability/tracing.ts`: an explicit preset wins, else Langfuse when both
 * keys are set, else generic when an endpoint is. The local `ai_spans` store is always on.
 */
export function describeTracing(values) {
  const langfuseKeys = Boolean(values.LANGFUSE_PUBLIC_KEY && values.LANGFUSE_SECRET_KEY)
  const endpoint = values.OTEL_EXPORTER_OTLP_ENDPOINT || ''
  const preset = values.OBSERVABILITY_PRESET || (langfuseKeys ? 'langfuse' : 'generic')
  const local = 'local ai_spans on'
  if (preset === 'langfuse') {
    if (!langfuseKeys) return `${local}; export off (preset langfuse without both LANGFUSE_* keys)`
    const base = (values.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com').replace(/\/+$/, '')
    return `${local}; exporting to langfuse at ${endpoint || `${base}/api/public/otel`}`
  }
  if (!endpoint) return `${local}; export off (local only — no OTEL_EXPORTER_OTLP_ENDPOINT)`
  const protocol =
    values.OTEL_EXPORTER_OTLP_PROTOCOL || (preset === 'phoenix' ? 'http/protobuf' : 'http/json')
  const headers = values.OTEL_EXPORTER_OTLP_HEADERS ? ', headers set' : ''
  return `${local}; exporting to ${preset} at ${endpoint} (${protocol}${headers})`
}

/** The host of a provider URL, for a status line — never the URL's path or query. */
function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return 'an invalid URL'
  }
}

/**
 * Which AI providers `.env` configures (step 8 / `pnpm preflight`), as ONE line. Rocketpod has no
 * zero-key model runner: chat and agents need `ANTHROPIC_API_KEY` or `AI_API_KEY` (OpenAI, or any
 * OpenAI-compatible endpoint with `AI_BASE_URL` + `AI_MODEL`), and uploads and knowledge search
 * need `EMBEDDINGS_API_KEY` (`EMBEDDINGS_BASE_URL` + `EMBEDDINGS_MODEL` for a compatible one, 1024
 * dimensions). A tenant can still bring its own provider in Settings → AI. Values are never printed.
 */
export function describeAi(values) {
  const chat = values.ANTHROPIC_API_KEY
    ? 'anthropic'
    : values.AI_API_KEY
      ? values.AI_BASE_URL
        ? `openai-compatible at ${hostOf(values.AI_BASE_URL)}`
        : 'openai'
      : 'none'
  const embeddings = values.EMBEDDINGS_API_KEY
    ? values.EMBEDDINGS_BASE_URL
      ? `openai-compatible at ${hostOf(values.EMBEDDINGS_BASE_URL)}`
      : 'openai'
    : 'none'
  const missing = []
  if (chat === 'none') missing.push('chat/agents need ANTHROPIC_API_KEY or AI_API_KEY')
  if (embeddings === 'none') missing.push('uploads/knowledge need EMBEDDINGS_API_KEY')
  const line = `chat ${chat} · embeddings ${embeddings}`
  return missing.length > 0 ? `${line} (${missing.join('; ')} in apps/web/.env)` : line
}

/**
 * The plaintext API key `pnpm seed` prints exactly once — the first non-empty line after its
 * "API key (shown ONCE" banner. Position-based on purpose: an adapted kit renames the prefix.
 * The "already exists" variant prints no banner and yields `undefined`.
 */
export function extractSeedKey(stdout) {
  const lines = stdout.split('\n')
  const banner = lines.findIndex(line => line.includes('API key (shown ONCE'))
  if (banner === -1) return undefined
  const next = lines.slice(banner + 1).find(line => line.trim() !== '')
  return next?.trim() || undefined
}

/* --------------------------------------------------------------- dev database --
 * The local Postgres is addressed by ONE value, `DATABASE_URL` in `apps/web/.env`:
 * every script reads it through dotenv, and `scripts/dev-db.mjs` derives the compose
 * port and container name from it. A second checkout on the same machine therefore
 * gets its own port and its own container instead of colliding on 5432. */

/**
 * This checkout's local port BLOCK. The kit's own are below; `scripts/rename.mjs` gives every copy
 * a fresh, higher block of its own (`choosePortBlock` in `rename-lib.mjs`: 5600–6999, one block per
 * app), rewriting the test ports wherever they are written down (compose, `.env.test`, CI, docs)
 * and the two dev range starts here. So the kit, Rocketflare and any number of copies can each run
 * `pnpm test` and a dev database on one machine at the same time.
 */
/** Test Postgres (`docker-compose.test.yml`, `.env.test`, CI) — never hand it to a dev database. */
export const TEST_DB_PORT = 5533
/** First port the dev database tries (`scripts/dev-db.mjs`); 20 are scanned. */
export const DEV_DB_PORT_START = 5432
/** Test S3 gateway (`docker-compose.test.yml`, `.env.test`). */
export const TEST_S3_PORT = 7433
/** First port the dev S3 gateway tries; 20 are scanned. */
export const DEV_S3_PORT_START = 7070
/**
 * Test ports a dev database must never take, whoever owns them: Rocketflare's (5433) and the
 * Rocketpod kit's (5533). A dev database on one would block that kit's next `pnpm test`.
 */
export const KIT_TEST_DB_PORTS = [5433, 5533] // rename: keep

/**
 * The port to publish Postgres on: `preferred` when it is still available (a re-run must not
 * move a working database), else the first available port from `start`. `isAvailable(port)` is
 * injected — at runtime it means "free, or already published by THIS checkout's container".
 * Returns null when the whole range is taken.
 */
export function chooseDevDbPort({
  preferred,
  isAvailable,
  start = DEV_DB_PORT_START,
  count = 20,
  skip = [TEST_DB_PORT, ...KIT_TEST_DB_PORTS],
}) {
  const blocked = new Set(skip)
  if (preferred && !blocked.has(preferred) && isAvailable(preferred)) return preferred
  for (let port = start; port < start + count; port += 1) {
    if (blocked.has(port) || port === preferred) continue
    if (isAvailable(port)) return port
  }
  return null
}

/** The port in a `postgresql://…` URL, or null when it has none or the URL is unparseable. */
export function databaseUrlPort(url) {
  try {
    const port = new URL(url).port
    return port === '' ? null : Number(port)
  } catch {
    return null
  }
}

/** The same URL with `port` as its port. Returns the input unchanged when it cannot be parsed. */
export function withDatabaseUrlPort(url, port) {
  try {
    const parsed = new URL(url)
    parsed.port = String(port)
    return parsed.toString()
  } catch {
    return url
  }
}

/**
 * `text` with `key=value` set: the existing assignment is rewritten in place (comments and
 * every other line are preserved byte for byte), or appended when the key is absent.
 */
export function upsertDevVar(text, key, value) {
  const lines = (text ?? '').split('\n')
  let found = false
  const out = lines.map(line => {
    const match = KEY_LINE.exec(line)
    if (!match || match[1] !== key) return line
    found = true
    return `${key}=${value}`
  })
  if (found) return out.join('\n')
  let result = out.join('\n')
  if (result !== '' && !result.endsWith('\n')) result += '\n'
  return `${result}${key}=${value}\n`
}

/**
 * A short stable tag for a checkout's absolute path — the suffix that makes this checkout's
 * compose project (and, when the plain one is taken, its container) unique on the machine.
 * djb2: the values only have to differ, not resist anything.
 */
export function checkoutTag(absolutePath) {
  let hash = 5381
  for (const char of String(absolutePath)) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0
  return hash.toString(36).padStart(7, '0').slice(0, 7)
}

/**
 * What the bootstrap's `plugins` step has to do, given `.rocketflare.json`'s `defaultPlugins` and
 * the ids already installed (D31).
 *
 * Pure, because the interesting part is the arithmetic and not the copying: an entry whose id is
 * already a surface is SKIPPED rather than re-added (a second `pnpm plugin add` of an installed
 * plugin is exit 7), the rest become one `pnpm plugin add <repo>[@ref] [--subdir d] --apply` each,
 * and a malformed entry is a sentence rather than a crash — `defaultPlugins` is hand-edited, and a
 * typo in it must not be the thing that stops a first run.
 *
 * The entry shape is an object, not a bare URL, because the step has to answer "is this one
 * already here?" BEFORE fetching anything, and only the id can answer that.
 */
export function planDefaultPlugins(entries, installedIds = []) {
  const installed = new Set(installedIds)
  const install = []
  const skipped = []
  // Normalised and validated by the ONE reader of this list (`scripts/lib/upgrade-lib.mjs`), not
  // by a second parser here. The two used to disagree about a bare string — "not an object" in
  // this file, "an id with no repo" in that one — which is one question with two answers in the
  // file that decides what a fresh clone installs.
  const normalised = defaultPluginEntries({ defaultPlugins: entries })
  const problems = defaultPluginEntryProblems(normalised)
  for (const entry of normalised) {
    const { id, repo, ref, subdir } = entry
    if (!id || !repo) continue
    if (installed.has(id)) {
      skipped.push(id)
      continue
    }
    const spec = ref ? `${repo}@${ref}` : repo
    install.push({
      id,
      spec,
      // `--allow-dirty`: from the second plugin on, the previous one's `db:generate` has left
      // migration files in the tree, and the install must not refuse its own earlier step.
      args: [
        'plugin',
        'add',
        spec,
        ...(subdir ? ['--subdir', subdir] : []),
        '--apply',
        '--allow-dirty',
      ],
    })
  }
  return { install, skipped, problems }
}

/* ------------------------------------------------------------------ arguments --
 * `scripts/bootstrap.mjs`'s command line, parsed here so the flag rules are pinned by a test. */

/** A bad command line: the bootstrap prints the message and the usage text, then exits 2. */
export class BootstrapUsageError extends Error {}

/** `postgres://` or `postgresql://` with a host — the only shape `--db-url` accepts. */
export function isPostgresUrl(value) {
  try {
    const url = new URL(value)
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.hostname !== ''
  } catch {
    return false
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

/**
 * True when a `DATABASE_URL` points at this machine (loopback) — the shape the Docker dev database
 * has. Anything else (a Neon branch, a LAN host) is "off-box": no compose, no Docker checks.
 * An unparseable URL counts as local, so a typo never switches the Docker checks off.
 */
export function isLocalDatabaseUrl(url) {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname)
  } catch {
    return true
  }
}

/** `host[:port]/db` of a database URL — never the user or password — for a verify line. */
export function databaseUrlTarget(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return '(unparseable DATABASE_URL)'
  }
}

/**
 * The steps `ROCKETPOD_BOOTSTRAP_SKIP` may name — the names on the `✔ n/10` lines of steps 1–8.
 * Steps 9 and 10 (`cli`, `run`) are already optional through `--no-dev`.
 */
export const BOOTSTRAP_SKIPPABLE_STEPS = [
  'toolchain',
  'install',
  'secrets',
  'database',
  'migrate',
  'plugins',
  'seed',
  'ai',
]

/**
 * `ROCKETPOD_BOOTSTRAP_SKIP` (comma-separated step names) → the steps to leave out, in step
 * order. For a caller that has already done that work itself (a coding sandbox that ran its own
 * `pnpm install`, made the database and knows it is migrated). An unknown name is a usage error:
 * a typo must not quietly run the step it meant to skip.
 */
export function parseBootstrapSkip(value) {
  const names = (value ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
  const unknown = names.filter(name => !BOOTSTRAP_SKIPPABLE_STEPS.includes(name))
  if (unknown.length > 0) {
    throw new BootstrapUsageError(
      `ROCKETPOD_BOOTSTRAP_SKIP: unknown step ${unknown.join(', ')} ` +
        `(one of ${BOOTSTRAP_SKIPPABLE_STEPS.join(', ')})`
    )
  }
  return BOOTSTRAP_SKIPPABLE_STEPS.filter(name => names.includes(name))
}

/**
 * `argv` (without node and the script) → the bootstrap's options. Throws `BootstrapUsageError`
 * for anything it does not understand. `env` supplies `DEV_VERBOSE`, `ROCKETPOD_BOOTSTRAP_SKIP`
 * (→ `skip`; `--no-install` adds `install`) and `ROCKETPOD_ALLOW_ROOT=1` (→ `allowRoot`).
 */
export function parseBootstrapArgs(argv, env = {}) {
  const skip = new Set(parseBootstrapSkip(env.ROCKETPOD_BOOTSTRAP_SKIP))
  const opts = {
    yes: false,
    shareDbIgnored: false,
    dev: true,
    demo: true,
    plugins: true,
    open: true,
    as: 'owner@example.test',
    dbUrl: null,
    driver: null,
    check: false,
    verbose: env.DEV_VERBOSE === '1',
    help: false,
    skip: [],
    allowRoot: env.ROCKETPOD_ALLOW_ROOT === '1',
  }
  const takeValue = (flag, i, what) => {
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) throw new BootstrapUsageError(`${flag} needs ${what}`)
    return value
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--yes':
        opts.yes = true
        break
      // Rocketflare's Workers AI toggle; Rocketpod has no `[ai]` block to toggle. Accepted so a
      // caller written for the parent kit (Launch) still runs.
      case '--offline':
      case '--online':
        break
      case '--no-dev':
        opts.dev = false
        break
      case '--no-demo':
        opts.demo = false
        break
      case '--no-plugins':
        opts.plugins = false
        break
      case '--no-install':
        skip.add('install')
        break
      // Kept so an older command line (or doc) still runs. Sharing was only ever a workaround
      // for the fixed port; scripts/dev-db.mjs now gives each checkout its own database.
      case '--share-db':
        opts.shareDbIgnored = true
        break
      case '--no-open':
        opts.open = false
        break
      case '--check':
        opts.check = true
        break
      case '--verbose':
        opts.verbose = true
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      case '--as':
        opts.as = takeValue('--as', i, 'an email')
        i += 1
        break
      case '--db-url':
        opts.dbUrl = takeValue('--db-url', i, 'a postgres:// URL')
        i += 1
        break
      case '--driver':
        opts.driver = takeValue('--driver', i, 'postgres')
        i += 1
        break
      default:
        if (arg.startsWith('--driver=')) {
          opts.driver = arg.slice('--driver='.length)
          break
        }
        if (arg.startsWith('--as=')) {
          opts.as = arg.slice('--as='.length)
          break
        }
        if (arg.startsWith('--db-url=')) {
          opts.dbUrl = arg.slice('--db-url='.length)
          if (opts.dbUrl === '') throw new BootstrapUsageError('--db-url needs a postgres:// URL')
          break
        }
        throw new BootstrapUsageError(`unknown option ${arg}`)
    }
  }
  if (opts.driver === 'neon') {
    throw new BootstrapUsageError(
      '--driver neon was removed in Rocketpod: postgres.js reaches any Postgres, Neon included — use --driver postgres or leave it out'
    )
  }
  if (opts.driver !== null && !DATABASE_DRIVERS.includes(opts.driver)) {
    throw new BootstrapUsageError('--driver must be postgres')
  }
  if (opts.driver !== null && opts.check) {
    throw new BootstrapUsageError('--driver and --check exclude each other (preflight only reads)')
  }
  if (opts.dbUrl !== null) {
    // Never echo the value: it carries a password.
    if (!isPostgresUrl(opts.dbUrl)) {
      throw new BootstrapUsageError('--db-url must be a postgres:// or postgresql:// URL')
    }
    if (opts.check) {
      throw new BootstrapUsageError(
        '--db-url and --check exclude each other (preflight reads DATABASE_URL from .env)'
      )
    }
  }
  opts.skip = BOOTSTRAP_SKIPPABLE_STEPS.filter(name => skip.has(name))
  return opts
}

/** D35, narrowed in Rocketpod: the one value `DATABASE_DRIVER` takes (apps/web/src/db/client.ts). */
export const DATABASE_DRIVERS = ['postgres']

/** A Neon host (a hosted Postgres; DDL goes to its direct host, never `-pooler`). */
export function isNeonDatabaseUrl(url) {
  try {
    return new URL(url).hostname.endsWith('.neon.tech')
  } catch {
    return false
  }
}

/**
 * The LOCAL driver the bootstrap writes to `.env` (D35). Rocketpod has one — postgres.js
 * over TCP, whatever the database (the compose one, a `--db-url`, a Neon branch) — so this is
 * always `postgres`; a stale `neon` from a Rocketflare-era `.env` is rewritten.
 */
export function localDriverFor(_input = {}) {
  return 'postgres'
}

/**
 * How the Docker-dependent steps behave. Two inputs decide it: `--db-url` (bootstrap against a
 * database this checkout does not run — a Neon branch in a sandbox without Docker) and, for
 * `--check`, whether `.env`' DATABASE_URL is off-box.
 *
 * - `docker`: step 1 checks `docker info` / `docker compose`
 * - `database`: `'compose'` → step 4 runs `dev-db.mjs up`; `'external'` → it only polls `db:check`
 * - `target`: `host[:port]/db` of the external database (no credentials), else null
 * - `seedEnv`: extra environment for step 7 (`seed.ts` refuses a non-local database without it)
 */
export function bootstrapStepPlan({ dbUrl = null, check = false, devVarsDatabaseUrl } = {}) {
  if (dbUrl) {
    return {
      docker: false,
      database: 'external',
      target: databaseUrlTarget(dbUrl),
      seedEnv: { SEED_ALLOW_REMOTE: '1' },
    }
  }
  if (check && devVarsDatabaseUrl && !isLocalDatabaseUrl(devVarsDatabaseUrl)) {
    return {
      docker: false,
      database: 'external',
      target: databaseUrlTarget(devVarsDatabaseUrl),
      seedEnv: {},
    }
  }
  return { docker: true, database: 'compose', target: null, seedEnv: {} }
}
