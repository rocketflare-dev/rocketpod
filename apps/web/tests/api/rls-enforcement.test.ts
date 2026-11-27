/**
 * Row-level security on the separate app login (`APP_DATABASE_URL`, docs/TENANT-ISOLATION.md),
 * through the same connection the runtime opens (`openDatabase` → `runtimeDatabaseUrl`). What
 * `rls-coverage.test.ts` cannot show: that the policies BIND. Outside a tenant scope the login
 * works as the system role (every row, no DDL); inside `withTenantScope(…, 'enforce')` it works as
 * the tenant role, and a statement without the tenant setting sees nothing.
 *
 * Skipped where `.env.test`'s login is blanked (a remote gate branch: no login is created there).
 */
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Database, openDatabase, pgErrorCode, rows } from '@/db/client'
import { tenants, userSessions } from '@/db/schema'
import { APP_ROLE, SYSTEM_ROLE } from '@/db/schema/rls'
import { withTenantScope } from '@/db/tenant-scope'
import { createTestTenant } from '../helpers/auth'
import { setupTestDatabase, testDatabaseUrl } from '../helpers/db'

const APP_URL = process.env.APP_DATABASE_URL
const SKIPPED = APP_URL ? '' : ' [skipped: no APP_DATABASE_URL on this target]'

async function failure(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work
    return undefined
  } catch (err) {
    return pgErrorCode(err)
  }
}

describe.skipIf(!APP_URL)(`row-level security on the app login${SKIPPED}`, () => {
  const owner = setupTestDatabase()
  const handle = openDatabase({ DATABASE_URL: testDatabaseUrl(), APP_DATABASE_URL: APP_URL })
  const app: Database = handle.db
  let a: { id: string }
  let b: { id: string }

  beforeAll(async () => {
    a = await createTestTenant(owner)
    b = await createTestTenant(owner)
  })

  afterAll(async () => {
    await handle.close()
  })

  it('outside a scope works as the system role: every tenant, but no table of its own', async () => {
    const [who] = rows<{ user: string; session: string }>(
      await app.execute(sql`select current_user as user, session_user as session`)
    )
    expect(who?.user).toBe(SYSTEM_ROLE)
    expect(who?.session).toBe(new URL(APP_URL as string).username)
    const seen = await app.select({ id: tenants.id }).from(tenants)
    expect(seen.map(t => t.id)).toEqual(expect.arrayContaining([a.id, b.id]))
    // Not the owner: no DDL, on its own tables or anyone's.
    expect(await failure(app.execute(sql`create table public.rls_probe (id int)`))).toBe('42501')
    expect(await failure(app.execute(sql`alter table tenants disable row level security`))).toBe(
      '42501'
    )
  })

  it('inside an enforce scope sees its own tenant only, with no predicate written', async () => {
    const seen = await withTenantScope(app, a.id, 'enforce', async scoped => {
      const [who] = rows<{ user: string }>(await scoped.execute(sql`select current_user as user`))
      expect(who?.user).toBe(APP_ROLE)
      return scoped.select({ id: tenants.id }).from(tenants)
    })
    expect(seen.map(t => t.id)).toEqual([a.id])
    // The scope ends with its transaction: the pooled connection is the system role again.
    const [after] = rows<{ user: string }>(await app.execute(sql`select current_user as user`))
    expect(after?.user).toBe(SYSTEM_ROLE)
  })

  it('a write into another tenant is refused, and the revoked tables are unreadable', async () => {
    const code = await failure(
      withTenantScope(app, a.id, 'enforce', scoped =>
        scoped.update(tenants).set({ name: 'moved' }).where(eq(tenants.id, b.id)).returning()
      )
    )
    // USING filters B's row out of the UPDATE: zero rows, never B's row renamed.
    expect(code).toBeUndefined()
    const [stillB] = await owner
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, b.id))
    expect(stillB?.name).not.toBe('moved')
    expect(
      await failure(
        withTenantScope(app, a.id, 'enforce', scoped => scoped.select().from(userSessions).limit(1))
      )
    ).toBe('42501')
  })

  it('the tenant role with no tenant set reads no row: the policies fail closed', async () => {
    const seen = await app.transaction(async tx => {
      await tx.execute(sql`select set_config('role', ${APP_ROLE}, true)`)
      return rows<{ n: number }>(await tx.execute(sql`select count(*)::int as n from tenants`))
    })
    expect(seen[0]?.n).toBe(0)
  })

  it('the login itself, without its startup role, holds no privilege at all', async () => {
    const bare = openDatabase({ DATABASE_URL: APP_URL })
    try {
      expect(await failure(bare.db.select({ id: tenants.id }).from(tenants).limit(1))).toBe('42501')
    } finally {
      await bare.close()
    }
  })
})
