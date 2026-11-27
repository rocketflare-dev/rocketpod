/**
 * `scripts/db-roles.ts` as a NON-superuser owner — the shape of Neon's `neondb_owner` (CREATEDB,
 * CREATEROLE, no SUPERUSER). Only a superuser may name SUPERUSER / BYPASSRLS / REPLICATION in an
 * ALTER ROLE, even to turn them off, so the role phase must skip those there and still leave the
 * app role unable to bypass RLS. Locally the test owner is a real superuser, which is why this
 * needs its own throwaway owner role to catch a regression.
 */
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP_ROLE, SYSTEM_ROLE } from '@/db/schema/rls'
import { applyDbRoles } from '../../scripts/db-roles'
import { testDatabaseUrl } from '../helpers/db'
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

  it('refuses the owner or a policy role as the app login, before connecting', async () => {
    for (const user of [ownerUser, APP_ROLE, SYSTEM_ROLE]) {
      await expect(
        applyDbRoles({
          databaseUrl: ownerAt(),
          appDatabaseUrl: at(user, 'x'),
          phase: 'role',
          quiet: true,
          maxAttempts: 1,
        })
      ).rejects.toThrow(/APP_DATABASE_URL must/)
    }
  })
})
