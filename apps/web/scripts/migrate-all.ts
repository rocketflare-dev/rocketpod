/**
 * The migrate one-shot: exactly what `pnpm db:migrate` runs, as one entry point —
 * `db-roles --phase=role` → `migrate.ts` (drizzle migrations, then the `pgboss` and
 * `openworkflow` schemas) → `db-roles --phase=grants`. `scripts/build-server.mjs` bundles it into
 * `dist/migrate.js`, so the image's compose `migrate` service and the Helm pre-install/pre-upgrade
 * Job run `node dist/migrate.js` with nothing but `DATABASE_URL` (and optionally
 * `APP_DATABASE_URL`) in the environment. `MIGRATIONS_DIR` overrides where the drizzle SQL lives
 * (default `./migrations`, relative to the working directory — `/app` in the image).
 */
import { applyDbRoles } from './db-roles'
import { runMigrations } from './migrate'

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }
  try {
    await applyDbRoles({ databaseUrl, phase: 'role' })
    await runMigrations(databaseUrl, { migrationsFolder: process.env.MIGRATIONS_DIR || undefined })
    await applyDbRoles({ databaseUrl, phase: 'grants' })
  } catch (error) {
    console.error('Migration failed:', error)
    process.exit(1)
  }
  console.log('migrate: done')
  // Exit explicitly, as migrate.ts does: a pool that never releases must not hold the Job open.
  process.exit(0)
}

main()
