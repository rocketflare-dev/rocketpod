/**
 * Raw SQL for the Node scripts (migrate, db-roles, db:check, provision): postgres.js over TCP.
 * `DATABASE_DRIVER` is still read (and must be `postgres` or unset — `databaseDriver()` refuses
 * the removed `neon` with the fix), so a stale `.env` fails loudly rather than silently.
 *
 * Queries are text + `$n` parameters.
 */
import postgres from 'postgres'
import { type DatabaseDriver, databaseDriver } from '../../src/db/client'

export type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>

export interface ScriptSql {
  driver: DatabaseDriver
  query: Query
  /** `BEGIN` … `COMMIT` on one connection; `ROLLBACK` when `fn` throws. */
  transaction(fn: (query: Query) => Promise<void>): Promise<void>
  end(): Promise<void>
}

export interface ScriptSqlOptions {
  /** Seconds to wait for a connection (postgres.js `connect_timeout`). */
  connectTimeout?: number
}

type DriverEnv = { readonly [key: string]: string | undefined }

/** The driver the scripts use: `DATABASE_DRIVER` from the environment, missing → `postgres`. */
export function scriptDriver(env: DriverEnv = process.env): DatabaseDriver {
  return databaseDriver({ DATABASE_DRIVER: env.DATABASE_DRIVER })
}

export function openScriptSql(
  url: string,
  env: DriverEnv = process.env,
  options: ScriptSqlOptions = {}
): ScriptSql {
  scriptDriver(env)
  return postgresSql(url, options)
}

function postgresSql(url: string, options: ScriptSqlOptions): ScriptSql {
  const sql = postgres(url, {
    max: 1,
    onnotice: () => {},
    ...(options.connectTimeout ? { connect_timeout: options.connectTimeout } : {}),
  })
  const run =
    (target: postgres.Sql | postgres.TransactionSql): Query =>
    async (text, params = []) =>
      (await target.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as never
  return {
    driver: 'postgres',
    query: run(sql),
    transaction: async fn => {
      await sql.begin(async tx => {
        await fn(run(tx))
      })
    },
    end: () => sql.end({ timeout: 5 }).catch(() => {}),
  }
}

/**
 * Wait until `url` answers `SELECT 1`: up to `maxAttempts` tries, 1 s apart, each on a fresh
 * connection. A Neon branch made seconds ago may still be starting its compute, and a connection
 * that fails before Postgres answers (a WebSocket the network dropped — Node reports it as an
 * `ErrorEvent` with no message) is worth another try; the error after the last one is thrown.
 */
export async function waitForDatabase(
  url: string,
  env: DriverEnv = process.env,
  maxAttempts = 30,
  log: (s: string) => void = () => {}
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const sql = openScriptSql(url, env)
    try {
      await sql.query('SELECT 1')
      return
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`Database not ready after ${maxAttempts} attempts: ${describeError(error)}`)
      }
      if (attempt === 1) log('Waiting for database to be ready...')
      await new Promise(resolve => setTimeout(resolve, 1000))
    } finally {
      await sql.end()
    }
  }
}

/**
 * An error as one line. A refused TCP connect to `localhost` arrives as an `AggregateError` (one
 * attempt per resolved address) whose own message is empty — print the inner causes instead.
 */
function describeError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map(inner => String((inner as Error)?.message ?? inner)).join('; ')
  }
  return String(error)
}

/** Neon: DDL and role changes target the direct host, never the `-pooler` one. */
export function isNeonUrl(url: string): boolean {
  return url.includes('.neon.tech')
}

/** `ep-xyz-pooler.region.aws.neon.tech` → `ep-xyz.region.aws.neon.tech`. */
export function toDirectNeonHost(connectionString: string): string {
  return connectionString.replace(/-pooler(?=\.[^/]*)/, '')
}
