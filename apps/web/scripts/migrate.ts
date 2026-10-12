/**
 * Apply drizzle migrations (03 §4, D17). Node-only script — run via `pnpm db:migrate` (loads
 * .dev.vars) or `pnpm db:migrate:ci` (DATABASE_URL from the environment); tests import
 * `runMigrations` directly so they exercise the same path.
 *
 * Ported from the Workers reference app's `scripts/migrate.ts`: Neon `-pooler` host rewritten to
 * the direct host (DDL must never go through a transaction pooler — session state such as a stuck
 * `default_transaction_read_only` on a pooled backend once blocked a production deploy), one
 * connection, wait-for-database retry. postgres.js over TCP (`scripts/lib/sql.ts`).
 */
import { fileURLToPath } from 'node:url'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { installJobsSchema } from '../src/node/jobs-schema'
import { installRunsSchema } from '../src/node/runs-schema'
import { isNeonUrl, scriptDriver, toDirectNeonHost, waitForDatabase } from './lib/sql'

export { isNeonUrl, toDirectNeonHost }

export interface RunMigrationsOptions {
  /** Defaults to `./migrations` relative to cwd (drizzle.config.ts `out`). */
  migrationsFolder?: string
  /** Suppress progress output (tests). */
  quiet?: boolean
  /** Retry budget for `waitForDatabase` (1s apart). */
  maxAttempts?: number
  /** Where `DATABASE_DRIVER` is read from (it must be `postgres` or unset). Default `process.env`. */
  env?: { readonly [key: string]: string | undefined }
  /** Also install pg-boss's `pgboss` schema and the queues (M3, `src/node/jobs-schema.ts`). Default true. */
  jobs?: boolean
  /** Also install OpenWorkflow's `openworkflow` schema (M4, `src/node/runs-schema.ts`). Default true. */
  runs?: boolean
}

/**
 * Run all pending migrations against `databaseUrl`. Works with an EMPTY `migrations/` folder
 * (drizzle needs `meta/_journal.json` with `entries: []`, which is committed).
 */
export async function runMigrations(
  databaseUrl: string,
  options: RunMigrationsOptions = {}
): Promise<void> {
  const log = options.quiet ? () => {} : (s: string) => console.log(s)
  const migrationsFolder = options.migrationsFolder ?? './migrations'
  const env = options.env ?? process.env

  let url = databaseUrl
  if (isNeonUrl(url)) {
    const direct = toDirectNeonHost(url)
    log(direct === url ? 'Neon database' : 'Neon database (pooler bypassed — DDL runs direct)')
    url = direct
  }

  await waitForDatabase(url, env, options.maxAttempts ?? 30, log)

  // pgvector (D17) is required by the Phase 3 `documents`/`chunks` tables and must exist
  // before the first migration that references the `vector` type. Idempotent, and valid on
  // any hosted Postgres that offers it and the pgvector/pgvector:pg17 compose image.
  // It lives here rather than in a hand-written 0000 SQL file so the migrations folder stays
  // 100% drizzle-kit generated and works when it is still empty.
  const createVector = 'CREATE EXTENSION IF NOT EXISTS vector'

  scriptDriver(env)
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await sql.unsafe(createVector)
    await migratePostgres(drizzlePostgres(sql), { migrationsFolder })
    log('Migrations applied')
  } finally {
    await sql.end({ timeout: 5 })
  }
  // The jobs transport's own schema (pg-boss, M3): created/migrated here, by the migrate one-shot,
  // never by a `web` process at boot.
  if (options.jobs !== false) {
    await installJobsSchema({ DATABASE_URL: url })
    log('Jobs schema (pgboss) and queues applied')
  }
  // The durable-runs engine's own schema (OpenWorkflow, M4): the same rule.
  if (options.runs !== false) {
    await installRunsSchema({ DATABASE_URL: url })
    log('Runs schema (openworkflow) applied')
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }
  try {
    console.log(`Running database migrations (${scriptDriver()} driver)...`)
    await runMigrations(databaseUrl)
  } catch (error) {
    console.error('Migration failed:', error)
    process.exit(1)
  }
  // Exit explicitly, as db:check does: an egress interceptor that never ends a closed database
  // connection's stream keeps Node alive after the client has ended.
  process.exit(0)
}

// Only run as a CLI — tests/helpers/db.ts imports runMigrations directly.
const invokedPath = process.argv[1]
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main()
}
