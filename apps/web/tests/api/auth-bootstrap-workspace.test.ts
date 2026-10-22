/**
 * The bootstrap admin's first workspace (multi mode): on an install with NO tenant yet — the first
 * deploy of an invite-only or approval app — the `BOOTSTRAP_ADMIN_EMAILS` admin's first login
 * creates one, named `APP_NAME`, as owner; once any tenant exists it never fires again. Before
 * this the only way to the first workspace was SQL.
 *
 * "No tenant yet" cannot be arranged in the shared test database — deleting every tenant races
 * the other test workers — so the empty install is a view of the real database whose one
 * "does any tenant exist?" read (`db.query.tenants.findFirst`) answers no. Every write is real.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { onNoTenant } from '@/api/services/auth'
import { loadConfig } from '@/config'
import type { Database } from '@/db/client'
import { tenants, tenantUsers } from '@/db/schema'
import { createTestTenantWithUser, createTestUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

/** `db`, as an install with no tenant: `query.tenants.findFirst` finds nothing. */
const emptyInstall = new Proxy(db, {
  get(target, prop, receiver) {
    if (prop !== 'query') return Reflect.get(target, prop, receiver)
    const query = target.query
    return new Proxy(query, {
      get: (q, table) =>
        table === 'tenants'
          ? { ...q.tenants, findFirst: async () => undefined }
          : Reflect.get(q, table),
    })
  },
}) as Database

const cfgFor = (email: string) =>
  loadConfig(
    createTestEnv({
      TENANCY_MODE: 'multi',
      SIGNUP_MODE: 'invite_only',
      BOOTSTRAP_ADMIN_EMAILS: email,
      APP_NAME: 'Acme',
    })
  )

describe('onNoTenant — the bootstrap admin on a fresh multi-tenant install', () => {
  it('creates the first workspace, named APP_NAME, with the admin as owner', async () => {
    const admin = await createTestUser(db, { isGlobalAdmin: true })
    const tenantId = await onNoTenant(emptyInstall, cfgFor(admin.email), admin, logger())
    expect(tenantId).not.toBeNull()
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId as string))
    expect(tenant?.name).toBe('Acme')
    const members = await db
      .select()
      .from(tenantUsers)
      .where(eq(tenantUsers.tenantId, tenantId as string))
    expect(members).toEqual([expect.objectContaining({ userId: admin.id, role: 'owner' })])
  })

  it('does nothing once any tenant exists, or for a global admin who is not a bootstrap one', async () => {
    // A real tenant exists: invite-only means no workspace, bootstrap admin or not.
    await createTestTenantWithUser(db, 'owner')
    const admin = await createTestUser(db, { isGlobalAdmin: true })
    expect(await onNoTenant(db, cfgFor(admin.email), admin, logger())).toBeNull()
    // An empty install, but this global admin is not on BOOTSTRAP_ADMIN_EMAILS.
    const other = await createTestUser(db, { isGlobalAdmin: true })
    expect(
      await onNoTenant(emptyInstall, cfgFor('someone-else@example.test'), other, logger())
    ).toBeNull()
  })
})
