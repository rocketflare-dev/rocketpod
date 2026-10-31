/**
 * The `labs` OIDC preset (`OIDC_PRESET=labs`, docs/CONCEPTS.md §2): Labs Access is the issuer, and
 * its id_token says which Labs orgs the person may use THIS app in, with what role. The OIDC
 * callback runs `reconcileLabsClaims` on EVERY sign-in, before `completeLogin` — it cannot live in
 * `admitUser`, because a user who already has a provider link never reaches it.
 *
 * What one reconcile does, idempotently:
 * - **Tenants.** Each org in `labs_orgs` is the tenant whose `external_org_id` is the org id —
 *   created on first sight (name from the claim, slug from the claim's slug made unique), renamed
 *   when the claim's name changes. A tenant the preset creates has NO owner: `owner` is an app-local
 *   decision the preset never writes, so the last-owner guard only ever sees owners a person made.
 * - **Memberships.** `tenant_users` with `source = 'labs'` and the role from `LABS_ROLE_MAP`. An
 *   existing `manual` admin/member row is adopted (becomes `labs`); an `owner` or `support` row is
 *   left exactly as it is. `labs` rows are read-only in the app (409 `labs_managed`).
 * - **Removal.** A `labs` row whose tenant is not among the claims' orgs is deleted, with the
 *   member's per-tenant settings, and every session pinned to that tenant is unpinned. `manual`
 *   rows are never touched.
 * - **Global admin.** `labs_platform_admin` sets `is_global_admin` with `global_admin_source =
 *   'labs'`; the claim going clears it, but only when Labs was what granted it.
 * - **Access requests.** A person the claims give a tenant has any pending access request closed —
 *   the "waiting for an administrator" state is never right for them.
 */
import { type LabsClaims, type LabsOrgRole, labsClaimsSchema } from '@rocketpod/shared/labs'
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { type Database, isUniqueViolation } from '../../db/client'
import {
  accessRequests,
  type Tenant,
  tenants,
  tenantUserSettings,
  tenantUsers,
  type User,
  userSessions,
  users,
} from '../../db/schema'
import type { Logger } from '../utils/core/logger'
import { createTenantForUser, uniqueSlug } from '../utils/db/tenant-helpers'
import { recordActivity } from './activity'

/**
 * Labs org role → the app's membership role. Edit it here to change it for this app (§8.1 says
 * the mapping is app-overridable). `owner` and `support` are never valid targets: the preset must
 * not hand out ownership, and `support` is the admin console's.
 */
export const LABS_ROLE_MAP: Record<LabsOrgRole, 'admin' | 'member'> = {
  nearform_admin: 'admin',
  nearform_staff: 'admin',
  client_admin: 'admin',
  client_member: 'member',
}

const CLAIM_NAMES = [
  'labs_v',
  'labs_person',
  'labs_staff',
  'labs_platform_admin',
  'labs_orgs',
] as const

export type LabsLogger = Pick<Logger, 'info' | 'warn'>

/**
 * The `labs_*` claims of a VERIFIED id_token payload, or null — logged — when they are missing or
 * malformed. Null means "ignore the claims": the sign-in proceeds as plain OIDC and nothing is
 * reconciled, so a broken token can never strip someone's memberships.
 */
export function readLabsClaims(
  payload: Record<string, unknown> | undefined,
  logger: LabsLogger
): LabsClaims | null {
  const picked = Object.fromEntries(
    CLAIM_NAMES.filter(name => payload && name in payload).map(name => [name, payload?.[name]])
  )
  const parsed = labsClaimsSchema.safeParse(picked)
  if (parsed.success) return parsed.data
  logger.warn(
    {
      present: Object.keys(picked),
      issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
    },
    'OIDC_PRESET=labs: id_token labs_* claims missing or malformed — ignored'
  )
  return null
}

/** The claims admit this person: an org grant, Nearform staff, or a platform admin. */
export function labsClaimsAdmit(claims: LabsClaims): boolean {
  return claims.labs_orgs.length > 0 || claims.labs_staff || claims.labs_platform_admin
}

export interface LabsReconcileResult {
  user: User
  /** The tenants the claims grant, in claim order (each now has a membership or an owner row). */
  tenantIds: string[]
  /** Tenants whose `labs` membership this reconcile removed. */
  removedTenantIds: string[]
}

/** Reconcile tenants, memberships and the global-admin flag from verified claims. */
export async function reconcileLabsClaims(
  db: Database,
  user: User,
  claims: LabsClaims,
  logger: LabsLogger,
  features: readonly string[] = []
): Promise<LabsReconcileResult> {
  const tenantIds: string[] = []
  const seen = new Set<string>()
  for (const org of claims.labs_orgs) {
    if (seen.has(org.id)) continue
    seen.add(org.id)
    const role = LABS_ROLE_MAP[org.role]
    const tenant = await ensureOrgTenant(db, user, org, role, features, logger)
    await upsertLabsMembership(db, tenant.id, user.id, role)
    tenantIds.push(tenant.id)
  }

  const removedTenantIds = await removeStaleLabsMemberships(db, user.id, tenantIds)
  const updated = await reconcileGlobalAdmin(db, user, claims.labs_platform_admin, logger)
  if (tenantIds.length > 0) await closePendingAccessRequests(db, user.email)
  return { user: updated, tenantIds, removedTenantIds }
}

/** The tenant mirroring `org`: found by `external_org_id`, renamed to the claim, or created. */
async function ensureOrgTenant(
  db: Database,
  user: User,
  org: LabsClaims['labs_orgs'][number],
  role: 'admin' | 'member',
  features: readonly string[],
  logger: LabsLogger
): Promise<Tenant> {
  const existing = await findOrgTenant(db, org.id)
  if (existing) {
    if (existing.name === org.name) return existing
    const [renamed] = await db
      .update(tenants)
      .set({ name: org.name, updatedAt: new Date() })
      .where(eq(tenants.id, existing.id))
      .returning()
    return renamed ?? existing
  }
  try {
    // The founding row is the person's LABS membership — never `owner` (see the header).
    const created = await createTenantForUser(db, {
      name: org.name,
      slug: await uniqueSlug(db, org.slug),
      userId: user.id,
      role,
      source: 'labs',
      externalOrgId: org.id,
      features,
    })
    logger.info(
      { tenantId: created.id, externalOrgId: org.id },
      'OIDC_PRESET=labs: created the tenant for a Labs org'
    )
    return created
  } catch (err) {
    // Two first sign-ins to the same org at once: the loser finds the winner's tenant.
    if (!isUniqueViolation(err)) throw err
    const raced = await findOrgTenant(db, org.id)
    if (!raced) throw err
    return raced
  }
}

async function findOrgTenant(db: Database, externalOrgId: string): Promise<Tenant | undefined> {
  return db.query.tenants.findFirst({ where: eq(tenants.externalOrgId, externalOrgId) })
}

/** Insert or update the `labs` row; an `owner` or `support` row is the app's and stays as is. */
async function upsertLabsMembership(
  db: Database,
  tenantId: string,
  userId: string,
  role: 'admin' | 'member'
): Promise<void> {
  const current = await db.query.tenantUsers.findFirst({
    where: and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)),
  })
  if (!current) {
    await db
      .insert(tenantUsers)
      .values({ tenantId, userId, role, source: 'labs' })
      .onConflictDoNothing()
    await recordActivity(db, {
      tenantId,
      userId,
      type: 'member.joined',
      subjectType: 'TenantMember',
      subjectId: userId,
      metadata: { via: 'labs', role },
    })
    return
  }
  if (current.role === 'owner' || current.role === 'support') return
  if (current.role === role && current.source === 'labs') return
  await db
    .update(tenantUsers)
    .set({ role, source: 'labs' })
    .where(and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)))
  if (current.role !== role) {
    await recordActivity(db, {
      tenantId,
      userId,
      type: 'member.role_changed',
      subjectType: 'TenantMember',
      subjectId: userId,
      metadata: { from: current.role, to: role, via: 'labs' },
    })
  }
}

/** Delete `labs` rows for tenants outside `keepTenantIds`; unpin sessions pinned to them. */
async function removeStaleLabsMemberships(
  db: Database,
  userId: string,
  keepTenantIds: string[]
): Promise<string[]> {
  const stale = await db
    .select({ tenantId: tenantUsers.tenantId })
    .from(tenantUsers)
    .where(
      and(
        eq(tenantUsers.userId, userId),
        eq(tenantUsers.source, 'labs'),
        keepTenantIds.length > 0 ? notInArray(tenantUsers.tenantId, keepTenantIds) : undefined
      )
    )
  const tenantIds = stale.map(r => r.tenantId)
  if (tenantIds.length === 0) return []
  await db.transaction(async tx => {
    await tx
      .delete(tenantUsers)
      .where(
        and(
          eq(tenantUsers.userId, userId),
          eq(tenantUsers.source, 'labs'),
          inArray(tenantUsers.tenantId, tenantIds)
        )
      )
    await tx
      .delete(tenantUserSettings)
      .where(
        and(eq(tenantUserSettings.userId, userId), inArray(tenantUserSettings.tenantId, tenantIds))
      )
    // A session pinned to a tenant the person just lost falls back to another membership.
    await tx
      .update(userSessions)
      .set({ selectedTenantId: null })
      .where(
        and(eq(userSessions.userId, userId), inArray(userSessions.selectedTenantId, tenantIds))
      )
  })
  for (const tenantId of tenantIds) {
    await recordActivity(db, {
      tenantId,
      userId,
      type: 'member.removed',
      subjectType: 'TenantMember',
      subjectId: userId,
      metadata: { via: 'labs' },
    })
  }
  return tenantIds
}

/** Grant from the claim; revoke only what the claim granted. */
async function reconcileGlobalAdmin(
  db: Database,
  user: User,
  platformAdmin: boolean,
  logger: LabsLogger
): Promise<User> {
  let patch: Partial<Pick<User, 'isGlobalAdmin' | 'globalAdminSource'>> | null = null
  if (platformAdmin && !user.isGlobalAdmin) {
    patch = { isGlobalAdmin: true, globalAdminSource: 'labs' }
    logger.warn({ userId: user.id }, 'OIDC_PRESET=labs: labs_platform_admin → GLOBAL ADMIN')
  } else if (!platformAdmin && user.isGlobalAdmin && user.globalAdminSource === 'labs') {
    patch = { isGlobalAdmin: false, globalAdminSource: null }
    logger.warn(
      { userId: user.id },
      'OIDC_PRESET=labs: labs_platform_admin gone → not global admin'
    )
  }
  if (!patch) return user
  const [updated] = await db.update(users).set(patch).where(eq(users.id, user.id)).returning()
  return updated ?? { ...user, ...patch }
}

/** A person the claims seat in a tenant is not waiting for anyone. */
async function closePendingAccessRequests(db: Database, email: string): Promise<void> {
  await db
    .update(accessRequests)
    .set({ status: 'approved', decidedAt: new Date() })
    .where(
      and(
        sql`lower(${accessRequests.email}) = ${email.toLowerCase()}`,
        eq(accessRequests.status, 'pending')
      )
    )
}
