/**
 * The bootstrap admin's first workspace (multi mode): on an install with NO tenant yet — the first
 * deploy of an invite-only or approval app — the `BOOTSTRAP_ADMIN_EMAILS` admin's first login
 * creates one, named `APP_NAME`, as owner; once any tenant exists it never fires again. Before
 * this the only way to the first workspace was SQL.
 *
 * "No tenant yet" cannot be arranged in the shared test database, so each case runs inside a
 * transaction that deletes every tenant first and always rolls back.
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

class Rollback extends Error {}

/** Run `body` against a database with no tenants, then undo everything. */
async function onEmptyInstall(body: (tx: Database) => Promise<void>) {
  await db
    .transaction(async tx => {
      await tx.delete(tenants)
      await body(tx as unknown as Database)
      throw new Rollback()
    })
    .catch(err => {
      if (!(err instanceof Rollback)) throw err
    })
}

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
    await onEmptyInstall(async tx => {
      const admin = await createTestUser(tx, { isGlobalAdmin: true })
      const tenantId = await onNoTenant(tx, cfgFor(admin.email), admin, logger())
      expect(tenantId).not.toBeNull()
      const [tenant] = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId as string))
      expect(tenant?.name).toBe('Acme')
      const [member] = await tx
        .select()
        .from(tenantUsers)
        .where(eq(tenantUsers.tenantId, tenantId as string))
      expect(member).toMatchObject({ userId: admin.id, role: 'owner' })
    })
  })

  it('does nothing once any tenant exists, or for a global admin who is not a bootstrap one', async () => {
    // A tenant exists (the shared database always has some): invite-only means no workspace.
    await createTestTenantWithUser(db, 'owner')
    const admin = await createTestUser(db, { isGlobalAdmin: true })
    expect(await onNoTenant(db, cfgFor(admin.email), admin, logger())).toBeNull()
    // An empty install, but this global admin is not on BOOTSTRAP_ADMIN_EMAILS.
    await onEmptyInstall(async tx => {
      const other = await createTestUser(tx, { isGlobalAdmin: true })
      expect(await onNoTenant(tx, cfgFor('someone-else@example.test'), other, logger())).toBeNull()
    })
  })
})
