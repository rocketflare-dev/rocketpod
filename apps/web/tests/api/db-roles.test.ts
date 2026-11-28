/**
 * `scripts/db-roles.ts` as a NON-superuser owner — the shape of Neon's `neondb_owner` (CREATEDB,
 * CREATEROLE, no SUPERUSER). Only a superuser may name SUPERUSER / BYPASSRLS / REPLICATION in an
 * ALTER ROLE, even to turn them off, so the role phase must skip those there and still leave the
 * app role unable to bypass RLS. Locally the test owner is a real superuser, which is why this
 * needs its own throwaway owner role to catch a regression.
 */
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, rows } from '@/db/client'
import { tenants } from '@/db/schema'
import { APP_ROLE, SYSTEM_ROLE } from '@/db/schema/rls'
import { withTenantScope } from '@/db/tenant-scope'
import { applyDbRoles } from '../../scripts/db-roles'
import { createTestTenant } from '../helpers/auth'
import { setupTestDatabase, testDatabaseUrl } from '../helpers/db'
import { isEphemeralTestRun } from '../helpers/db-safety'

/**
 * Skipped on a remote target (`pnpm test` on a Neon gate branch from a coding sandbox): this file drives
 * postgres.js over TCP, which the sandbox cannot open (443 only), and needs a SUPERUSER to make
 * and drop throwaway owner roles, which a branch's owner role is not. The local gate and CI run it.
 */
const EPHEMERAL = isEphemeralTestRun(process.env)
const SKIPPED = EPHEMERAL ? ' [skipped: ephemeral gate — no TCP, no superuser]' : ''

const ownerRole = `rf_neon_owner_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
const ownerPassword = 'neon_owner_test'

// postgres.js connects lazily, so constructing it costs nothing when the suites below are skipped.
const superuser = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {} })

function ownerUrl(): string {
  const url = new URL(testDatabaseUrl())
  url.username = ownerRole
  url.password = ownerPassword
  return url.toString()
}

describe.skipIf(EPHEMERAL)(`db-roles as a non-superuser owner (Neon)${SKIPPED}`, () => {
  beforeAll(async () => {
    await superuser.unsafe(
      `CREATE ROLE ${ownerRole} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER CREATEDB CREATEROLE`
    )
    // On Neon the owner created the app role, which gives it ADMIN OPTION (PG16+); here the
    // superuser created it in globalSetup, so hand that over explicitly.
    await superuser.unsafe(`GRANT ${APP_ROLE} TO ${ownerRole} WITH ADMIN OPTION`)
    await superuser.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${ownerRole} WITH GRANT OPTION`)
  })

  afterAll(async () => {
    await superuser.unsafe(`DROP OWNED BY ${ownerRole}`)
    await superuser.unsafe(`DROP ROLE IF EXISTS ${ownerRole}`)
    await superuser.end({ timeout: 5 })
  })

  it('runs the role phase and leaves the app role unable to bypass RLS', async () => {
    await expect(
      applyDbRoles({ databaseUrl: ownerUrl(), appDatabaseUrl: '', phase: 'role', quiet: true })
    ).resolves.toMatchObject({ revoked: [] })

    const [attrs] = await superuser<
      {
        rolsuper: boolean
        rolbypassrls: boolean
        rolcreatedb: boolean
        rolcreaterole: boolean
        rolreplication: boolean
      }[]
    >`
      SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
      FROM pg_roles WHERE rolname = ${APP_ROLE}`
    expect(attrs).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
    })
  })
})

/**
 * A LEAST-privilege migration owner: CREATEROLE but no CREATEDB (Launch's `migrator`). On
 * Postgres 16+ only a role that has CREATEDB may change CREATEDB at all — even to NOCREATEDB — so
 * an unconditional `ALTER ROLE … NOCREATEDB NOCREATEROLE` failed the role phase for this owner
 * ("permission denied to alter role"), on the first real app deploy.
 */
describe.skipIf(EPHEMERAL)(
  `db-roles as an owner without CREATEDB (a least-privilege migration role)${SKIPPED}`,
  () => {
    const leanRole = `rf_lean_owner_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
    const leanUrl = () => {
      const url = new URL(testDatabaseUrl())
      url.username = leanRole
      url.password = ownerPassword
      return url.toString()
    }
    const admin = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {} })

    beforeAll(async () => {
      await admin.unsafe(
        `CREATE ROLE ${leanRole} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER NOCREATEDB CREATEROLE`
      )
      await admin.unsafe(`GRANT ${APP_ROLE} TO ${leanRole} WITH ADMIN OPTION`)
      await admin.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${leanRole} WITH GRANT OPTION`)
    })

    afterAll(async () => {
      await admin.unsafe(`DROP OWNED BY ${leanRole}`)
      await admin.unsafe(`DROP ROLE IF EXISTS ${leanRole}`)
      await admin.end({ timeout: 5 })
    })

    it('runs the role phase without touching attributes that are already off', async () => {
      await expect(
        applyDbRoles({ databaseUrl: leanUrl(), appDatabaseUrl: '', phase: 'role', quiet: true })
      ).resolves.toMatchObject({ revoked: [] })
      const [attrs] = await admin<{ rolcreatedb: boolean; rolcreaterole: boolean }[]>`
      SELECT rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = ${APP_ROLE}`
      expect(attrs).toEqual({ rolcreatedb: false, rolcreaterole: false })
    })
  }
)

/**
 * The app login (`APP_DATABASE_URL`) on a database whose bootstrap REVOKEd CONNECT from PUBLIC, the
 * shape an outside bootstrap may leave. Without the role phase's own `GRANT CONNECT` the login
 * could not open a connection at all; without NOINHERIT it would hold the system role's
 * privileges itself, so a `RESET ROLE` would still read every tenant.
 */
describe.skipIf(EPHEMERAL)(`db-roles: the app login${SKIPPED}`, () => {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
  const scratchDb = `rf_connect_${suffix}`
  const login = `rf_login_${suffix}`
  const admin = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {} })
  const at = (user: string, password: string) => {
    const url = new URL(testDatabaseUrl())
    url.username = user
    url.password = password
    url.pathname = `/${scratchDb}`
    return url.toString()
  }
  const owner = new URL(testDatabaseUrl())
  const ownerUser = decodeURIComponent(owner.username)
  const ownerAt = () => at(ownerUser, decodeURIComponent(owner.password))

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${scratchDb}`)
    await admin.unsafe(`REVOKE CONNECT ON DATABASE ${scratchDb} FROM PUBLIC`)
  })

  afterAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchDb} WITH (FORCE)`)
    await admin.unsafe(`DROP ROLE IF EXISTS ${login}`)
    await admin.end({ timeout: 5 })
  })

  it('creates a NOINHERIT login that can connect and holds both roles with SET only', async () => {
    await expect(
      applyDbRoles({
        databaseUrl: ownerAt(),
        appDatabaseUrl: at(login, 'login_pw'),
        phase: 'all',
        quiet: true,
      })
    ).resolves.toMatchObject({ login })

    const asLogin = postgres(at(login, 'login_pw'), { max: 1, onnotice: () => {} })
    try {
      const [roles] = await asLogin<{ user: string; set: boolean; app: boolean; uses: boolean }[]>`
        select current_user as user,
               pg_has_role(current_user, ${SYSTEM_ROLE}, 'SET') as set,
               pg_has_role(current_user, ${APP_ROLE}, 'SET') as app,
               pg_has_role(current_user, ${SYSTEM_ROLE}, 'USAGE') as uses`
      expect(roles).toEqual({ user: login, set: true, app: true, uses: false })
    } finally {
      await asLogin.end({ timeout: 5 })
    }
  })

  it('refuses the owner, the system role or a non-identifier as the app login, before connecting', async () => {
    for (const [user, refusal] of [
      [ownerUser, /must be a separate login, not the owner/],
      [SYSTEM_ROLE, /must not connect as/],
      ['app-login', /not a plain SQL identifier/],
    ] as const) {
      await expect(
        applyDbRoles({
          databaseUrl: ownerAt(),
          appDatabaseUrl: at(user, 'x'),
          phase: 'role',
          quiet: true,
          maxAttempts: 1,
        })
      ).rejects.toThrow(refusal)
    }
  })

  it('fails the post-check when the login inherits the system role', async () => {
    // A grant made by hand WITH INHERIT keeps its option through migrate's own plain GRANT.
    await admin.unsafe(`GRANT ${SYSTEM_ROLE} TO ${login} WITH INHERIT TRUE`)
    try {
      await expect(
        applyDbRoles({
          databaseUrl: ownerAt(),
          appDatabaseUrl: at(login, 'login_pw'),
          phase: 'role',
          quiet: true,
        })
      ).rejects.toThrow(/inherits/)
    } finally {
      await admin.unsafe(`REVOKE ${SYSTEM_ROLE} FROM ${login}`)
    }
  })
})

/**
 * The login named as the tenant role itself: a platform that provisions the app's login under
 * `<snake>_app` and keeps its password in a secret. Migrate makes that role a NOINHERIT LOGIN
 * holding the system role, and nothing else changes: it is still the tenant role the policies
 * name, owns nothing and bypasses nothing. Roles are cluster-wide, so the role's login state is
 * put back afterwards for every other run sharing this server.
 */
describe.skipIf(EPHEMERAL)(`db-roles: the tenant role as the app login${SKIPPED}`, () => {
  const admin = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {} })
  const owner = setupTestDatabase()
  const asAppRole = (password: string) => {
    const url = new URL(testDatabaseUrl())
    url.username = APP_ROLE
    url.password = password
    return url.toString()
  }
  const firstPassword = `app_${crypto.randomUUID().slice(0, 8)}`
  let before: { rolcanlogin: boolean; rolinherit: boolean; rolpassword: string | null } | undefined
  let a: { id: string }
  let b: { id: string }

  const migrate = (password: string) =>
    applyDbRoles({
      databaseUrl: testDatabaseUrl(),
      appDatabaseUrl: asAppRole(password),
      phase: 'all',
      quiet: true,
    })

  beforeAll(async () => {
    ;[before] = await admin<
      { rolcanlogin: boolean; rolinherit: boolean; rolpassword: string | null }[]
    >`
      SELECT rolcanlogin, rolinherit, rolpassword FROM pg_authid WHERE rolname = ${APP_ROLE}`
    a = await createTestTenant(owner)
    b = await createTestTenant(owner)
    await expect(migrate(firstPassword)).resolves.toMatchObject({ login: APP_ROLE })
  })

  afterAll(async () => {
    await admin.unsafe(`REVOKE ${SYSTEM_ROLE} FROM ${APP_ROLE}`)
    if (before) {
      const password = before.rolpassword === null ? 'NULL' : `'${before.rolpassword}'`
      await admin.unsafe(
        `ALTER ROLE ${APP_ROLE} ${before.rolcanlogin ? 'LOGIN' : 'NOLOGIN'} ` +
          `${before.rolinherit ? 'INHERIT' : 'NOINHERIT'} PASSWORD ${password}`
      )
    }
    await admin.end({ timeout: 5 })
  })

  it('logs in as the tenant role, which stays NOBYPASSRLS, owns nothing and holds the system role with SET only', async () => {
    const direct = postgres(asAppRole(firstPassword), { max: 1, onnotice: () => {} })
    try {
      const [who] = await direct<
        { user: string; bypass: boolean; owns: number; set: boolean; uses: boolean }[]
      >`
        select current_user as user,
               (select rolbypassrls from pg_roles where rolname = current_user) as bypass,
               (select count(*)::int from pg_class where relowner = (select oid from pg_roles where rolname = current_user)) as owns,
               pg_has_role(current_user, ${SYSTEM_ROLE}, 'SET') as set,
               pg_has_role(current_user, ${SYSTEM_ROLE}, 'USAGE') as uses`
      expect(who).toEqual({ user: APP_ROLE, bypass: false, owns: 0, set: true, uses: false })
      // Not the owner: RLS binds and DDL is refused.
      const refused = await direct`create table public.app_role_probe (id int)`.catch(e => e.code)
      expect(refused).toBe('42501')
    } finally {
      await direct.end({ timeout: 5 })
    }
  })

  it('the runtime connection works as the system role outside a scope, the tenant role inside', async () => {
    const handle = openDatabase({
      DATABASE_URL: testDatabaseUrl(),
      APP_DATABASE_URL: asAppRole(firstPassword),
    })
    try {
      const [who] = rows<{ user: string; session: string; timeout: string; locks: string }>(
        await handle.db.execute(
          sql`select current_user as user, session_user as session,
                     current_setting('statement_timeout') as timeout,
                     current_setting('lock_timeout') as locks`
        )
      )
      // The tenant role's own timeouts would otherwise govern every system-role session.
      expect(who).toEqual({ user: SYSTEM_ROLE, session: APP_ROLE, timeout: '0', locks: '0' })
      const all = await handle.db.select({ id: tenants.id }).from(tenants)
      expect(all.map(t => t.id)).toEqual(expect.arrayContaining([a.id, b.id]))

      const scoped = await withTenantScope(handle.db, a.id, 'enforce', async db => {
        const [inside] = rows<{ user: string }>(await db.execute(sql`select current_user as user`))
        expect(inside?.user).toBe(APP_ROLE)
        return db.select({ id: tenants.id }).from(tenants)
      })
      expect(scoped.map(t => t.id)).toEqual([a.id])
    } finally {
      await handle.close()
    }
  })

  it('without the startup role it is only the tenant role: no tenant row, no infrastructure table', async () => {
    const bare = postgres(asAppRole(firstPassword), { max: 1, onnotice: () => {} })
    try {
      const [count] = await bare<{ n: number }[]>`select count(*)::int as n from tenants`
      expect(count?.n).toBe(0)
      const refused = await bare`select 1 from user_sessions limit 1`.catch(e => e.code)
      expect(refused).toBe('42501')
    } finally {
      await bare.end({ timeout: 5 })
    }
  })

  it('re-runs cleanly and picks up a changed password', async () => {
    await expect(migrate(firstPassword)).resolves.toMatchObject({ login: APP_ROLE })
    const rotated = `app_${crypto.randomUUID().slice(0, 8)}`
    await expect(migrate(rotated)).resolves.toMatchObject({ login: APP_ROLE })

    const stale = postgres(asAppRole(firstPassword), { max: 1, onnotice: () => {} })
    await expect(stale`select 1`).rejects.toMatchObject({ code: '28P01' })
    await stale.end({ timeout: 5 })
    const fresh = postgres(asAppRole(rotated), { max: 1, onnotice: () => {} })
    try {
      const [who] = await fresh<{ user: string }[]>`select current_user as user`
      expect(who?.user).toBe(APP_ROLE)
    } finally {
      await fresh.end({ timeout: 5 })
    }
  })
})
