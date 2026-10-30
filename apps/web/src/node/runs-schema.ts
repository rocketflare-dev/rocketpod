/**
 * OpenWorkflow's schema — the part of the runs engine that does NOT need the app, so
 * `scripts/migrate.ts` (the migrate one-shot) can install it without importing the agent runtime.
 * `runs.ts` is the engine on top. Never run at boot: a `web` or `worker` process assumes it exists.
 */
import { BackendPostgres } from 'openworkflow/postgres'
import { type DatabaseEnv, resolveDatabaseUrl } from '../db/client'

export const RUNS_SCHEMA = 'openworkflow'
/** The one workflow the app registers: the agent run (`api/workflows/agent-run-body.ts`). */
export const AGENT_RUN_WORKFLOW_NAME = 'agent-run'

/** The migrate step: create or migrate the `openworkflow` schema. Idempotent. */
export async function installRunsSchema(
  env: DatabaseEnv,
  options: { schema?: string } = {}
): Promise<void> {
  const backend = await BackendPostgres.connect(resolveDatabaseUrl(env), {
    schema: options.schema ?? RUNS_SCHEMA,
    runMigrations: true,
  })
  await backend.stop()
}
