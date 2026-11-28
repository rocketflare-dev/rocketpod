/**
 * Create (or reconcile) the Postgres roles row-level security names, and the runtime's app login.
 * Role names from `src/db/schema/rls.ts`, REVOKE list from `RLS_REVOKED_TABLES`. Runs as the OWNER
 * (`DATABASE_URL`) over postgres.js (`scripts/lib/sql.ts`). docs/TENANT-ISOLATION.md is the model.
 *
 * - `rocketpod_app`: NOLOGIN. The tenant role the policies admit one tenant to; DML on `public`
 *   minus the REVOKEd infrastructure tables.
 * - `rocketpod_system`: NOLOGIN. The cross-tenant role an app login works as outside a tenant
 *   scope; DML on every `public` table. The job and run engines' installers grant it their
 *   schemas (`src/node/engine-grants.ts`).
 * - the APP LOGIN, only when `APP_DATABASE_URL` is set, in one of two shapes
 *   (docs/TENANT-ISOLATION.md § 3):
 *   - a SEPARATE login (the default; any plain identifier but the owner and the two roles above):
 *     created if missing, with LOGIN, the URL's password (sent as a SCRAM verifier, never the
 *     plaintext), NOINHERIT, and both roles granted. It holds no privilege of its own and reaches
 *     data only by working AS one of them (`SET ROLE`, which the runtime does at connect:
 *     `src/db/client.ts` `runtimeDatabaseUrl`).
 *   - `rocketpod_app` ITSELF, for a platform that provisions the login under the tenant role's
 *     name: the role becomes LOGIN NOINHERIT with the URL's password and is granted the system
 *     role. Its own privileges are the tenant role's, so a `RESET ROLE` leaves a connection that
 *     sees what the tenant role sees with no tenant set: nothing on a tenant table.
 *   Either way CONNECT on the database is granted to it, since an outside bootstrap may have
 *   revoked CONNECT from PUBLIC. The owner and the system role are never accepted as the login.
 *
 * None of them is a superuser, has BYPASSRLS or owns a relation; the post-check proves it on every
 * host. Only a superuser may even name SUPERUSER/BYPASSRLS/REPLICATION in an ALTER ROLE, so those
 * are set only when the owner is one; elsewhere they stay at CREATE ROLE's defaults (off).
 *
 * Runs TWICE around migrations because its halves want opposite sides of them:
 *   --phase=role   BEFORE migrate.ts  (`CREATE POLICY ... TO rocketpod_app` needs the role to exist)
 *   --phase=grants AFTER  migrate.ts  (REVOKE can only name tables that exist)
 * `all` (default) does both, correct once the tables exist (every environment from its second
 * run onward). Idempotent; one transaction; safe to re-run on every deploy.
 *
 * Unsetting APP_DATABASE_URL later does NOT revoke the login: rollback is pointing the runtime
 * back at the owner, not locking out a connection something may hold.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { APP_ROLE, RLS_REVOKED_TABLES, SYSTEM_ROLE } from '../src/db/schema/rls'
import { isNeonUrl, openScriptSql, type Query, toDirectNeonHost, waitForDatabase } from './lib/sql'

/** Conservative identifier sanity check before we hand a value to quote_ident. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/

export type DbRolesPhase = 'role' | 'grants' | 'all'

export interface ApplyDbRolesOptions {
  /** Owner connection used to apply the changes (default: DATABASE_URL). */
  databaseUrl?: string
  /**
   * The runtime's app login (default: APP_DATABASE_URL). Its user is created/reconciled as a
   * NOINHERIT login holding the app and system roles, or (named `APP_ROLE`) the app role itself
   * made a NOINHERIT login holding the system role; it may not be the owner or the system role.
   */
  appDatabaseUrl?: string
  phase?: DbRolesPhase
  quiet?: boolean
  /** Where `DATABASE_DRIVER` is read from (it must be `postgres` or unset). Default `process.env`. */
  env?: { readonly [key: string]: string | undefined }
  /**
   * `waitForDatabase`'s budget (1 s apart) before the first statement. This is often the FIRST
   * connection a run makes (tests/setup.ts runs it before the migrator), so a branch still
   * starting, or one dropped connection, must not fail the whole run.
   */
  maxAttempts?: number
}

export interface ApplyDbRolesResult {
  /** The app login reconciled this run (its user name); null when APP_DATABASE_URL is unset. */
  login: string | null
  /** Tables REVOKEd from the app role in this run (grants phase only). */
  revoked: string[]
}

function parseCredentials(connectionString: string, label: string) {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error(`${label} is not a valid URL`)
  }
  const username = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  if (!username) throw new Error(`${label} must include a username`)
  return { username, password }
}

/**
 * A SCRAM-SHA-256 verifier for `password` (RFC 5802, the form `pg_authid` stores), so the
 * plaintext never appears in a statement a server log could record. Postgres stores a value of
 * this shape as is.
 */
export function scramVerifier(password: string, salt = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

/** Neon: role DDL must target the direct host, same rule as migrate.ts. */
function directHost(url: string): string {
  return isNeonUrl(url) ? toDirectNeonHost(url) : url
}

/**
 * The app login named by `APP_DATABASE_URL`, checked: never the owner or the system role.
 * `isAppRole`: the login IS the tenant role (a platform provisioned it under that name).
 */
function appLoginOf(
  appDatabaseUrl: string,
  owner: string
): { name: string; password: string; isAppRole: boolean } {
  const app = parseCredentials(appDatabaseUrl, 'APP_DATABASE_URL')
  if (!IDENTIFIER_RE.test(app.username)) {
    throw new Error(`APP_DATABASE_URL username '${app.username}' is not a plain SQL identifier`)
  }
  if (app.username === owner) {
    throw new Error(
      `APP_DATABASE_URL must be a separate login, not the owner '${owner}' (which bypasses RLS)`
    )
  }
  if (app.username === SYSTEM_ROLE) {
    throw new Error(
      `APP_DATABASE_URL must not connect as '${SYSTEM_ROLE}' (it sees every tenant; it is granted TO the login)`
    )
  }
  if (!app.password) {
    throw new Error(`APP_DATABASE_URL must include a password for '${app.username}'`)
  }
  return { name: app.username, password: app.password, isAppRole: app.username === APP_ROLE }
}

export async function applyDbRoles(options: ApplyDbRolesOptions = {}): Promise<ApplyDbRolesResult> {
  const phase = options.phase ?? 'all'
  const wantsRole = phase !== 'grants'
  const wantsGrants = phase !== 'role'
  const log = options.quiet ? () => {} : (s: string) => console.log(s)

  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL environment variable is required')
  const appDatabaseUrl = options.appDatabaseUrl ?? process.env.APP_DATABASE_URL

  const owner = parseCredentials(databaseUrl, 'DATABASE_URL').username
  if (!IDENTIFIER_RE.test(owner)) {
    throw new Error(`DATABASE_URL username '${owner}' is not a plain SQL identifier`)
  }
  const login = appDatabaseUrl ? appLoginOf(appDatabaseUrl, owner) : null

  log(
    `Applying database roles [${phase}] (roles '${APP_ROLE}', '${SYSTEM_ROLE}', owner '${owner}', ` +
      `app login ${login ? `'${login.name}'` : 'not configured: APP_DATABASE_URL unset'})`
  )

  const url = directHost(databaseUrl)
  const env = options.env ?? process.env
  await waitForDatabase(url, env, options.maxAttempts ?? 15, log)
  const sql = openScriptSql(url, env)
  try {
    // Identifiers and literals cannot be bound as parameters in DDL; let Postgres quote them.
    const [quoted] = await sql.query<{
      role_ident: string
      role_lit: string
      system_ident: string
      system_lit: string
      owner_ident: string
      login_ident: string
      login_lit: string
      verifier_lit: string
    }>(
      `SELECT quote_ident($1::text)   AS role_ident,
              quote_literal($1::text) AS role_lit,
              quote_ident($2::text)   AS system_ident,
              quote_literal($2::text) AS system_lit,
              quote_ident($3::text)   AS owner_ident,
              quote_ident($4::text)   AS login_ident,
              quote_literal($4::text) AS login_lit,
              quote_literal($5::text) AS verifier_lit`,
      [APP_ROLE, SYSTEM_ROLE, owner, login?.name ?? '', login ? scramVerifier(login.password) : '']
    )
    if (!quoted) throw new Error('Failed to quote role identifiers')
    const { role_ident: role, system_ident: system, owner_ident: ownerIdent } = quoted

    const statements: [label: string, sql: string][] = []

    if (wantsRole) {
      statements.push(
        createNologin(role, quoted.role_lit, 'app role'),
        ...hygiene(role, quoted.role_lit, 'app role'),
        createNologin(system, quoted.system_lit, 'system role'),
        ...hygiene(system, quoted.system_lit, 'system role'),
        ['statement_timeout', `ALTER ROLE ${role} SET statement_timeout = '30s'`],
        [
          'idle_in_transaction_session_timeout',
          `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '15s'`,
        ],
        ['lock_timeout', `ALTER ROLE ${role} SET lock_timeout = '5s'`],
        ['schema usage', `GRANT USAGE ON SCHEMA public TO ${role}, ${system}`],
        [
          'default table privileges',
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdent} IN SCHEMA public
             GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}, ${system}`,
        ],
        [
          'default sequence privileges',
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdent} IN SCHEMA public
             GRANT USAGE, SELECT ON SEQUENCES TO ${role}, ${system}`,
        ]
      )
      if (login) {
        const { login_ident: loginIdent, login_lit: loginLit } = quoted
        // The tenant role as the login: created NOLOGIN above (or by the platform), so it only
        // gains LOGIN, NOINHERIT and the system role; it cannot be granted to itself.
        if (!login.isAppRole) {
          statements.push(
            [
              'create app login',
              `DO $do$ BEGIN
               IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${loginLit}) THEN
                 CREATE ROLE ${loginIdent} LOGIN NOINHERIT;
               END IF;
             EXCEPTION WHEN duplicate_object THEN NULL;
             END $do$`,
            ],
            ...hygiene(loginIdent, loginLit, 'app login')
          )
        }
        statements.push(
          // NOINHERIT: the login holds no privilege of its own (or, as the tenant role, only the
          // tenant role's); it works AS a granted role, never with the system role's privileges.
          [
            'app login credential',
            `ALTER ROLE ${loginIdent} LOGIN NOINHERIT PASSWORD ${quoted.verifier_lit}`,
          ],
          [
            'app login roles',
            `GRANT ${login.isAppRole ? system : `${role}, ${system}`} TO ${loginIdent}`,
          ],
          [
            // A bootstrap that REVOKEd CONNECT from PUBLIC leaves a new login unable to connect.
            // Granting needs the database's ownership (or a grant option); without either, the
            // post-check says whether the login can connect anyway.
            'app login connect',
            `DO $do$ BEGIN
               EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), ${loginLit});
             EXCEPTION WHEN insufficient_privilege THEN NULL;
             END $do$`,
          ]
        )
      }
    }

    let revoked: string[] = []
    if (wantsGrants) {
      const revokeTargets = await sql.query<{ ident: string; name: string }>(
        `SELECT quote_ident(table_name::text) AS ident, table_name::text AS name
         FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name::text = ANY($1::text[])
         ORDER BY table_name`,
        [[...RLS_REVOKED_TABLES]]
      )
      const [counted] = await sql.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
      )
      const publicTables = counted?.count ?? 0

      statements.push(
        [
          'table grants',
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}, ${system}`,
        ],
        [
          'sequence grants',
          `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}, ${system}`,
        ]
      )

      // AFTER the blanket grant, same transaction: the grant re-adds DML on every table, so
      // the revoke has to be the last word. Only from the tenant role: the system role keeps
      // them, because the pre-tenant auth paths run as it on an app login.
      if (revokeTargets.length > 0) {
        revoked = revokeTargets.map(r => r.name)
        statements.push([
          'revoke infrastructure tables',
          `REVOKE ALL ON ${revokeTargets.map(r => r.ident).join(', ')} FROM ${role}`,
        ])
      } else if (phase === 'grants' && publicTables > 0) {
        // Tables exist but none of the infrastructure tables do: wrong database, or migrations
        // did not run. The REVOKE silently did nothing (exactly what this phase exists to
        // prevent), so say so rather than reporting success.
        throw new Error(
          `None of the REVOKEd infrastructure tables (${RLS_REVOKED_TABLES.join(', ')}) exist ` +
            `although 'public' has ${publicTables} table(s). Run --phase=grants AFTER migrations.`
        )
      } else if (phase === 'grants') {
        log('   (no tables in public yet: nothing to REVOKE; expected before Phase 1 migrations)')
      }
    }

    await sql.transaction(async query => {
      for (const [label, statement] of statements) {
        await query(statement)
        log(`   • ${label}`)
      }
    })

    await postCheck(sql.query, { wantsRole, login: login?.name ?? null })

    log(
      `Roles '${APP_ROLE}', '${SYSTEM_ROLE}' ready [${phase}] (nosuperuser, nobypassrls` +
        `${
          login?.isAppRole
            ? `; '${APP_ROLE}' is the app login, NOINHERIT, holding '${SYSTEM_ROLE}'`
            : login
              ? `; app login '${login.name}' holds both, NOINHERIT`
              : '; no app login'
        })`
    )
    return { login: login?.name ?? null, revoked }
  } finally {
    await sql.end()
  }
}

/** Create a NOLOGIN role unless it exists. */
function createNologin(ident: string, lit: string, label: string): [string, string] {
  return [
    `create ${label}`,
    `DO $do$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit}) THEN
         CREATE ROLE ${ident} NOLOGIN;
       END IF;
     EXCEPTION WHEN duplicate_object THEN NULL;
     END $do$`,
  ]
}

/** The attributes every managed role is held to (no CREATEDB/CREATEROLE, no superuser bits). */
function hygiene(ident: string, lit: string, label: string): [string, string][] {
  return [
    [
      // Only switch OFF what is on. On Postgres 16+ only a role that HAS CREATEDB may change
      // CREATEDB at all (even to NOCREATEDB), so an owner without it (a least-privilege
      // migration role, e.g. Launch's `migrator`) failed here on a role CREATE ROLE had just
      // made without either attribute. The post-check still proves the result.
      `${label} attributes`,
      `DO $do$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit} AND rolcreatedb) THEN
           ALTER ROLE ${ident} NOCREATEDB;
         END IF;
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit} AND rolcreaterole) THEN
           ALTER ROLE ${ident} NOCREATEROLE;
         END IF;
       END $do$`,
    ],
    [
      // Only a superuser may name SUPERUSER / BYPASSRLS / REPLICATION, even to turn them off;
      // Neon's owner is not one, and would fail with "permission denied to alter role". A
      // non-superuser cannot have granted them either, and CREATE ROLE defaults them off; the
      // post-check still proves rolsuper/rolbypassrls are false either way.
      `${label} superuser-only attributes`,
      `DO $do$ BEGIN
         IF current_setting('is_superuser') = 'on' THEN
           ALTER ROLE ${ident} NOSUPERUSER NOBYPASSRLS NOREPLICATION;
         END IF;
       END $do$`,
    ],
  ]
}

/**
 * What must hold after every run, on every host: no managed role bypasses RLS or owns a relation,
 * the system role cannot log in, and the app login can log in and connect but inherits nothing.
 */
async function postCheck(
  query: Query,
  options: { wantsRole: boolean; login: string | null }
): Promise<void> {
  const names = [APP_ROLE, SYSTEM_ROLE, ...(options.login ? [options.login] : [])]
  const roles = await query<{
    rolname: string
    rolsuper: boolean
    rolbypassrls: boolean
    rolcreatedb: boolean
    rolcreaterole: boolean
    rolcanlogin: boolean
    rolinherit: boolean
    owns: number
    can_connect: boolean
    inherits_system: boolean
  }>(
    `SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
            r.rolcanlogin, r.rolinherit,
            (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owns,
            has_database_privilege(r.oid, current_database(), 'CONNECT') AS can_connect,
            pg_has_role(r.oid, $2::text, 'USAGE') AS inherits_system
     FROM pg_roles r WHERE r.rolname = ANY($1::text[])`,
    [names, SYSTEM_ROLE]
  )
  const byName = new Map(roles.map(r => [r.rolname, r]))
  for (const name of names) {
    const r = byName.get(name)
    if (!r) throw new Error(`Role '${name}' does not exist: run --phase=role first`)
    if (r.rolsuper || r.rolbypassrls) {
      throw new Error(
        `Role '${name}' would bypass RLS (rolsuper=${r.rolsuper}, rolbypassrls=${r.rolbypassrls})`
      )
    }
    if (r.owns > 0) throw new Error(`Role '${name}' owns ${r.owns} relation(s); it must own none`)
    if (options.wantsRole && (r.rolcreatedb || r.rolcreaterole)) {
      throw new Error(
        `Role '${name}' kept CREATEDB/CREATEROLE (rolcreatedb=${r.rolcreatedb}, rolcreaterole=${r.rolcreaterole})`
      )
    }
  }
  if (byName.get(SYSTEM_ROLE)?.rolcanlogin) {
    throw new Error(`Role '${SYSTEM_ROLE}' can log in; it is reached only through SET ROLE`)
  }
  if (options.login) {
    const l = byName.get(options.login)
    if (!l?.rolcanlogin || l.rolinherit) {
      throw new Error(
        `App login '${options.login}' must be LOGIN NOINHERIT (rolcanlogin=${l?.rolcanlogin}, rolinherit=${l?.rolinherit})`
      )
    }
    // A grant made while the login inherited (or by hand, WITH INHERIT TRUE) would hand it the
    // system role's privileges outright: the infrastructure tables, every tenant after RESET ROLE.
    if (l.inherits_system) {
      throw new Error(
        `App login '${options.login}' inherits '${SYSTEM_ROLE}'s privileges; it must hold it with SET only ` +
          `(REVOKE ${SYSTEM_ROLE} FROM ${options.login}, then re-run migrate)`
      )
    }
    if (!l.can_connect) {
      throw new Error(
        `App login '${options.login}' has no CONNECT on this database and the owner could not grant it: ` +
          'run GRANT CONNECT ON DATABASE <db> TO <login> as the database owner'
      )
    }
  }
}

/** `--phase=role|grants|all` (default `all`). */
function parsePhaseArg(argv: string[]): DbRolesPhase {
  const arg = argv.find(value => value.startsWith('--phase'))
  if (!arg) return 'all'
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : ''
  if (value === 'role' || value === 'grants' || value === 'all') return value
  throw new Error(`Unknown --phase '${value}' (expected role, grants or all)`)
}

async function main() {
  try {
    await applyDbRoles({ phase: parsePhaseArg(process.argv.slice(2)) })
  } catch (error) {
    console.error('Database role setup failed:', error)
    process.exit(1)
  }
  // Exit explicitly (see migrate.ts): a closed database WebSocket may never release the process.
  process.exit(0)
}

// Only run as a CLI: tests/setup.ts imports applyDbRoles directly.
const invokedPath = process.argv[1]
// `.ts` only: bundled into `dist/migrate.js` every module shares the bundle's
// `import.meta.url`, which would otherwise start this CLI too.
if (invokedPath?.endsWith('.ts') && fileURLToPath(import.meta.url) === invokedPath) {
  main()
}
