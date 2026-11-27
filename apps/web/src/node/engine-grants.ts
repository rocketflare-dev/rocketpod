/**
 * What the runtime needs on a job or run engine's schema (`pgboss`, `openworkflow`) when it
 * connects with a separate app login (`APP_DATABASE_URL`, docs/TENANT-ISOLATION.md): the login
 * works as `rocketpod_system`, so that role gets USAGE on the schema and DML on what is in it —
 * never CREATE, never ownership. Both engines do their DDL only at install time
 * (`installJobsSchema`, `installRunsSchema`, run by the migrate one-shot as the owner); at runtime
 * they read and write rows, take advisory locks and NOTIFY, which this covers.
 *
 * The installer that creates a schema grants it, in the same step, so a schema is never usable
 * by the owner alone: the migrate one-shot's and a test's own schema alike. No system role (the
 * owner ran `migrate.ts` without `db-roles.ts`) is a no-op, not an error.
 */
import { SYSTEM_ROLE } from '../db/schema/rls'

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/

/** One `DO` block granting `schema` to the system role, when that role exists. */
export function engineSchemaGrants(schema: string): string {
  if (!SCHEMA_RE.test(schema)) throw new Error(`engineSchemaGrants: bad schema name '${schema}'`)
  const grants = [
    `GRANT USAGE ON SCHEMA ${schema} TO ${SYSTEM_ROLE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${SYSTEM_ROLE}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${SYSTEM_ROLE}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${SYSTEM_ROLE}`,
  ]
  return `DO $do$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SYSTEM_ROLE}') THEN
      ${grants.map(g => `EXECUTE '${g}';`).join('\n      ')}
    END IF;
  END $do$`
}
