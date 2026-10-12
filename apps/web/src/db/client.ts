/**
 * Drizzle over postgres.js — the one driver (Rocketpod M2; Rocketflare's Neon serverless driver is
 * gone, `docs/FORK.md`). Two ways to hold a connection:
 *
 * - **Per request** (`openDatabase` with no process pool installed): a client per request or
 *   invocation, closed with the handle (middleware/database.ts). The Worker path: Hyperdrive is
 *   the real pool, so `max: 1` and `prepare: false` (transaction-mode pooler).
 * - **Per process** (`installProcessPool`, the Node entry `src/node/server.ts`): ONE postgres.js
 *   pool shared by every request in the process. `openDatabase` then hands out a view of it whose
 *   `close()` is a no-op; the pool is ended once, on shutdown.
 *
 * Code outside this file sees `Database` and reads raw `execute()` results through `rows()` /
 * `affected()`, never the driver's own shape — so the driver stays swappable behind this file.
 *
 * **This file is the driver seam** (src/db/CLAUDE.md, "The driver seam"): every driver detail is
 * either normalised here — a raw result's shape (`rows()`, `affected()`), a raw array's value
 * (`ARRAY_PARSERS`), a driver error's code (`pgErrorCode()`) — or banned outside it by
 * `tests/config/driver-results.test.ts`, and `tests/driver/` proves the result in every gate.
 */
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>

export type DatabaseDriver = 'postgres'
export const DATABASE_DRIVERS = ['postgres'] as const

export interface DatabaseHandle {
  db: Database
  /** Ends the underlying client. Idempotent; a no-op on a view of the process pool. */
  close(): Promise<void>
}

export interface CreateDatabaseOptions {
  /** Connections per client. 1 in the Worker (Hyperdrive), 5 for scripts/tests, more for a pool. */
  max?: number
  /**
   * Named prepared statements. Off by default: Hyperdrive and other transaction-mode poolers do not
   * support them across queries. A process pool connected straight to Postgres may turn them on.
   */
  prepare?: boolean
}

/**
 * What `openDatabase` reads — structural, so `AppConfig` plus the bindings, a script's
 * `process.env` and a test's plain object all fit.
 */
export interface DatabaseEnv {
  /** Only `postgres` remains; missing or empty means `postgres`. */
  DATABASE_DRIVER?: string
  HYPERDRIVE?: { connectionString: string }
  PREVIEW_DATABASE_URL?: string
  DATABASE_URL?: string
}

/** The driver `env` selects. Throws on anything but `postgres`, rather than guessing. */
export function databaseDriver(env: Pick<DatabaseEnv, 'DATABASE_DRIVER'>): DatabaseDriver {
  const value = env.DATABASE_DRIVER?.trim()
  if (!value || value === 'postgres') return 'postgres'
  if (value === 'neon') {
    throw new Error(
      'DATABASE_DRIVER=neon was removed in Rocketpod: postgres.js reaches any Postgres (Neon included) over TCP — set DATABASE_DRIVER=postgres or unset it'
    )
  }
  throw new Error(`DATABASE_DRIVER must be postgres, got "${value}"`)
}

/**
 * The connection string: `PREVIEW_DATABASE_URL ?? HYPERDRIVE.connectionString ?? DATABASE_URL`.
 * Preview deployments bypass the shared Hyperdrive binding; `wrangler dev` supplies Hyperdrive's
 * `localConnectionString` when the toml has the block; the Node entry reads `DATABASE_URL`.
 */
export function resolveDatabaseUrl(env: DatabaseEnv): string {
  databaseDriver(env)
  const url = env.PREVIEW_DATABASE_URL || env.HYPERDRIVE?.connectionString || env.DATABASE_URL
  if (!url) {
    throw new Error(
      'No database connection available: set DATABASE_URL (or the HYPERDRIVE binding on the Worker)'
    )
  }
  return url
}

// ---- The process pool (Node) ----------------------------------------------------------------

interface ProcessPool {
  url: string
  handle: DatabaseHandle
}

let processPool: ProcessPool | undefined

/**
 * Install ONE pool for this process: from now on `openDatabase` for the same URL returns a view of
 * it whose `close()` does nothing. The returned handle's `close()` uninstalls the pool and ends it
 * — the Node entry calls it once, after draining, on shutdown. Installing twice is an error: two
 * pools in one process is exactly what this exists to prevent.
 */
export function installProcessPool(
  env: DatabaseEnv,
  options: CreateDatabaseOptions = {}
): DatabaseHandle {
  if (processPool) throw new Error('installProcessPool: a process pool is already installed')
  const url = resolveDatabaseUrl(env)
  const pooled = createDatabase(url, { max: options.max ?? 10, prepare: options.prepare })
  const installed: ProcessPool = { url, handle: pooled }
  processPool = installed
  let closed: Promise<void> | undefined
  return {
    db: pooled.db,
    close: () => {
      closed ??= (async () => {
        if (processPool === installed) processPool = undefined
        await pooled.close()
      })()
      return closed
    },
  }
}

/** Open a handle for one request/invocation — a view of the process pool when one is installed. */
export function openDatabase(
  env: DatabaseEnv,
  options: CreateDatabaseOptions = {}
): DatabaseHandle {
  const url = resolveDatabaseUrl(env)
  if (processPool && processPool.url === url) {
    return { db: processPool.handle.db, close: () => Promise.resolve() }
  }
  return createDatabase(url, options)
}

/**
 * A postgres.js handle. postgres.js connects lazily, so a handle that never runs a query costs
 * nothing and `close()` returns immediately.
 */
export function createDatabase(url: string, options: CreateDatabaseOptions = {}): DatabaseHandle {
  const client = postgres(url, {
    max: options.max ?? 1,
    // Hyperdrive and other transaction-mode poolers do not support named prepared
    // statements across queries; unnamed (per-query) is the safe default.
    prepare: options.prepare ?? false,
    // Skips the startup round-trip that lists custom types; the kit only uses builtins
    // (pgvector's `vector` is sent/received as text by drizzle).
    fetch_types: false,
    onnotice: () => {},
  })
  const db = drizzlePostgres(client, { schema }) as unknown as Database
  // After drizzle, which installs its own transparent parsers for the date types on the same map.
  Object.assign(client.options.parsers, ARRAY_PARSERS)
  let closed: Promise<void> | undefined
  return {
    db,
    close: () => {
      closed ??= client.end({ timeout: 5 }).catch(() => {})
      return closed
    },
  }
}

// ---- Raw arrays -----------------------------------------------------------------------------

/**
 * Raw Postgres arrays, parsed into JS arrays. postgres.js runs with `fetch_types: false` (no
 * startup round trip per client), which skips its array-type lookup, so without these a raw
 * `text[]` arrives as the literal `"{x,y}"`. Elements parse like the scalar would: integers and
 * floats to numbers, `int8` to a string (never rounded), booleans, JSON, `bytea` to a `Buffer`,
 * everything else as text. The date and interval arrays (1115, 1182, 1185, 1187) and `numeric[]`
 * (1231) are absent on purpose: drizzle keeps those as strings, and its column mappers expect that.
 */
type ElementParser = (value: string) => unknown

const asText: ElementParser = value => value
const asInt: ElementParser = value => Number.parseInt(value, 10)
const asFloat: ElementParser = value => Number.parseFloat(value)
const asBool: ElementParser = value => value === 't' || value === 'true'
const asJson: ElementParser = value => JSON.parse(value)
const asBytea: ElementParser = value =>
  value.startsWith('\\x') ? Buffer.from(value.slice(2), 'hex') : Buffer.from(value, 'binary')

const ARRAY_ELEMENTS: Record<number, ElementParser> = {
  199: asJson, // json[]
  1000: asBool, // bool[]
  1001: asBytea, // bytea[]
  1005: asInt, // int2[]
  1007: asInt, // int4[]
  1009: asText, // text[]
  1014: asText, // bpchar[]
  1015: asText, // varchar[]
  1016: asText, // int8[] (strings, like a scalar bigint)
  1021: asFloat, // float4[]
  1022: asFloat, // float8[]
  1028: asInt, // oid[]
  1040: asText, // macaddr[]
  1041: asText, // inet[]
  1183: asText, // time[]
  1270: asText, // timetz[]
  2951: asText, // uuid[]
  3807: asJson, // jsonb[]
}

const ARRAY_PARSERS: Record<number, (value: string) => unknown> = Object.fromEntries(
  Object.entries(ARRAY_ELEMENTS).map(([oid, element]) => [
    Number(oid),
    (value: string) => parseArrayLiteral(value, element),
  ])
)

/**
 * A Postgres array literal (`{a,"b c",NULL,{1,2}}`) → nested JS arrays. Quoted elements may hold
 * backslash escapes; an unquoted `NULL` is `null`; a leading dimension decoration
 * (`[0:1]={…}`) is skipped.
 */
export function parseArrayLiteral(literal: string, element: ElementParser = asText): unknown[] {
  let i = 0
  if (literal[0] === '[') {
    const eq = literal.indexOf('=')
    if (eq !== -1) i = eq + 1
  }
  const parse = (): unknown[] => {
    const out: unknown[] = []
    i += 1 // `{`
    while (i < literal.length) {
      const ch = literal[i]
      if (ch === '}') {
        i += 1
        return out
      }
      if (ch === ',') {
        i += 1
        continue
      }
      if (ch === '{') {
        out.push(parse())
        continue
      }
      if (ch === '"') {
        let value = ''
        i += 1
        while (i < literal.length && literal[i] !== '"') {
          if (literal[i] === '\\') i += 1
          value += literal[i]
          i += 1
        }
        i += 1 // closing quote
        out.push(element(value))
        continue
      }
      let end = i
      while (end < literal.length && literal[end] !== ',' && literal[end] !== '}') end += 1
      const raw = literal.slice(i, end)
      out.push(raw === 'NULL' ? null : element(raw))
      i = end
    }
    return out
  }
  return parse()
}

// ---- Reading raw results -------------------------------------------------------------------

type QueryResultLike = { rows?: unknown; rowCount?: unknown; count?: unknown }

/**
 * The rows of a raw `db.execute(sql…)`: postgres.js returns the array itself; a `{ rows }`
 * object (another driver's shape) is accepted too. The only way code outside this file reads one
 * (the config guard `driver-results.test.ts` enforces it).
 */
export function rows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const candidate = (result as QueryResultLike | null)?.rows
  if (Array.isArray(candidate)) return candidate as T[]
  throw new TypeError('rows(): not a query result')
}

/**
 * The number of rows an `insert` / `update` / `delete` without `.returning()` touched: postgres.js
 * reports `.count` (a `.rowCount` is accepted too).
 */
export function affected(result: unknown): number {
  const r = (result ?? {}) as QueryResultLike
  const value = typeof r.rowCount === 'number' ? r.rowCount : r.count
  return typeof value === 'number' ? value : 0
}

// ---- Reading driver errors -----------------------------------------------------------------

/**
 * The Postgres SQLSTATE (`23505`, `40001`…) of a driver error, wherever it hangs: postgres.js puts
 * `code` on its own error and drizzle wraps that, so the `cause` chain is walked. The only way code outside this file reads one (the config guard
 * `driver-results.test.ts` enforces it).
 */
export function pgErrorCode(err: unknown): string | undefined {
  let current = err
  for (let depth = 0; current && depth < 5; depth++) {
    const code = typeof current === 'object' ? (current as { code?: unknown }).code : undefined
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** A unique / primary-key violation (`23505`). */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505'
}

// ---- Node-side (scripts/tests) -------------------------------------------------------------

/** Every handle from `getScriptDatabase`, so `closeAllDatabases()` ends all of them. */
const scriptHandles = new Map<string, DatabaseHandle>()

/**
 * A pooled handle for scripts and tests (max 5), memoised per driver and URL. `env` carries the
 * driver vars — a script passes `process.env`, where `.dev.vars` / `.env.test` put them; this file
 * never reads `process` itself. Not for the Worker — the request path must go through
 * `openDatabase` so the client is ended per request.
 */
export function getScriptDatabase(
  url: string,
  env: { readonly [key: string]: string | undefined } = {},
  max = 5
): Database {
  const scoped: DatabaseEnv = { DATABASE_DRIVER: env.DATABASE_DRIVER, DATABASE_URL: url }
  const key = `${databaseDriver(scoped)} ${url}`
  let handle = scriptHandles.get(key)
  if (!handle) {
    handle = createDatabase(resolveDatabaseUrl(scoped), { max })
    scriptHandles.set(key, handle)
  }
  return handle.db
}

/** Test teardown: end every script handle. Safe to call repeatedly. */
export async function closeAllDatabases(): Promise<void> {
  const handles = [...scriptHandles.values()]
  scriptHandles.clear()
  await Promise.all(handles.map(h => h.close()))
}
