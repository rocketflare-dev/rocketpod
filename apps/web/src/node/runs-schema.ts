/**
 * OpenWorkflow's schema — the part of the runs engine that does NOT need the app, so
 * `scripts/migrate.ts` (the migrate one-shot) can install it without importing the agent runtime.
 * `runs.ts` is the engine on top. Never run at boot: a `web` or `worker` process assumes it exists.
 */
import { BackendPostgres } from 'openworkflow/postgres'
import postgres from 'postgres'
import { type DatabaseEnv, ownerDatabaseUrl } from '../db/client'
import { databaseConnection, sslOption, urlWithDatabaseSsl } from '../db/tls'
import { engineSchemaGrants } from './engine-grants'

export const RUNS_SCHEMA = 'openworkflow'
/** The one workflow the app registers: the agent run (`api/workflows/agent-run-body.ts`). */
export const AGENT_RUN_WORKFLOW_NAME = 'agent-run'

/** The migrate step: create or migrate the `openworkflow` schema. Idempotent. */
export async function installRunsSchema(
  env: DatabaseEnv,
  options: { schema?: string } = {}
): Promise<void> {
  // DDL, so the owner (`DATABASE_URL`), never the app login. OpenWorkflow's migrator takes a URL only, so `DATABASE_SSL` travels as the URL's `sslmode`
  // (postgres.js reads it exactly like the `ssl` option — `db/tls.ts`).
  const url = ownerDatabaseUrl(env)
  const schema = options.schema ?? RUNS_SCHEMA
  const backend = await BackendPostgres.connect(urlWithDatabaseSsl(url, env), {
    schema,
    runMigrations: true,
  })
  await backend.stop()
  // The runtime's app login (as the system role) reads and writes these rows; it never owns them.
  const sql = postgres(url, {
    max: 1,
    onnotice: () => {},
    ...sslOption(databaseConnection(url, env)),
  })
  try {
    await sql.unsafe(engineSchemaGrants(schema))
  } finally {
    await sql.end({ timeout: 5 })
  }
}
