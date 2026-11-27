/**
 * Identity events act on the person the issuer names: a suspension ends the global-admin role the
 * issuer granted (and only that one), and the email fallback never reaches an account linked to a
 * different subject at the issuer.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { activityEvents, oauthProviders, tenants, tenantUsers, users } from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenant,
  createTestUser,
  sessionCookieHeader,
  uniqueId,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()
const ISSUER = 'https://idp.test/realms/acme'
const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`

const eventsEnv = () =>
  createTestEnv({
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: 'client',
    OIDC_CLIENT_SECRET: 'dummy-oidc-secret',
    OIDC_MANAGED_TENANCY: 'true',
    IDENTITY_WEBHOOK_SECRET: SECRET,
  } as never)

async function sign(id: string, ts: number, body: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(SECRET.slice('whsec_'.length), 'base64'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`))
  return `v1,${Buffer.from(mac).toString('base64')}`
}

interface TestEvent {
  id: string
  type: string
  occurredAt: string
  data: Record<string, unknown>
}

/** An event `minutesAgo` old (negative: in the future), with a fresh id. */
function makeEvent(type: string, data: Record<string, unknown>, minutesAgo = 0): TestEvent {
  const occurredAt = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  return { id: `evt_${uniqueId()}`, type, occurredAt, data }
}

async function postEvent(
  env: ReturnType<typeof eventsEnv>,
  type: string,
  data: Record<string, unknown>
) {
  return deliver(env, makeEvent(type, data))
}

/** Deliver `event` as the issuer would; delivering the same object twice is a replay. */
async function deliver(env: ReturnType<typeof eventsEnv>, event: TestEvent) {
  const { id } = event
  const body = JSON.stringify(event)
  const ts = Math.floor(Date.now() / 1000)
  return request(
    '/api/identity/events',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(ts),
        'webhook-signature': await sign(id, ts, body),
      },
      body,
    },
    { env }
  )
}

async function seatedPerson(opts: { sub?: string } = {}) {
  const user = await createTestUser(db)
  if (opts.sub) {
    await db
      .insert(oauthProviders)
      .values({ userId: user.id, provider: 'oidc', providerUserId: `${ISSUER}|${opts.sub}` })
  }
  const earlier = new Date(Date.now() - 10 * 60_000)
  const orgId = `org-${uniqueId().toLowerCase()}`
  const tenant = await createTestTenant(db, { externalOrgId: orgId, idpSyncedAt: earlier })
  await db.insert(tenantUsers).values({
    tenantId: tenant.id,
    userId: user.id,
    role: 'member',
    source: 'idp',
    idpSyncedAt: earlier,
  })
  const token = await createTestSession(db, user.id, tenant.id)
  return { user, tenant, token, orgId }
}

async function membership(tenantId: string, userId: string) {
  return db.query.tenantUsers.findFirst({
    where: and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)),
  })
}

describe('person.suspended and the global-admin role', () => {
  it('ends the role the issuer granted', async () => {
    const env = eventsEnv()
    const admin = await createTestGlobalAdmin(db)
    await db.update(users).set({ globalAdminSource: 'idp' }).where(eq(users.id, admin.id))

    const res = await postEvent(env, 'person.suspended', { personId: 'p', email: admin.email })
    expect(res.status).toBe(204)

    const row = await db.query.users.findFirst({ where: eq(users.id, admin.id) })
    expect(row).toMatchObject({ isGlobalAdmin: false, globalAdminSource: null })
    const later = await createTestSession(db, admin.id)
    const admins = await request(
      '/api/admin/users',
      { headers: sessionCookieHeader(later) },
      { env }
    )
    expect(admins.status).toBe(403)
  })

  it('leaves a manual grant in place', async () => {
    const env = eventsEnv()
    const admin = await createTestGlobalAdmin(db)
    await db.update(users).set({ globalAdminSource: 'manual' }).where(eq(users.id, admin.id))

    await postEvent(env, 'person.suspended', { personId: 'p', email: admin.email })

    const row = await db.query.users.findFirst({ where: eq(users.id, admin.id) })
    expect(row).toMatchObject({ isGlobalAdmin: true, globalAdminSource: 'manual' })
  })
})

describe('which person an event names', () => {
  it('a sub with no link does not reach an account linked to another subject by email', async () => {
    const env = eventsEnv()
    const { user, tenant, token } = await seatedPerson({ sub: `sub_a_${uniqueId()}` })
    const res = await postEvent(env, 'person.suspended', {
      personId: 'p',
      email: user.email.toUpperCase(),
      sub: `sub_b_${uniqueId()}`,
    })
    expect(res.status).toBe(204)
    const session = await request('/auth/session', { headers: sessionCookieHeader(token) }, { env })
    expect(session.status).toBe(200)
    expect(await membership(tenant.id, user.id)).toBeDefined()
  })

  it('a sub with no link still reaches, by email, an account the issuer has never seen', async () => {
    const env = eventsEnv()
    const { user, tenant, orgId } = await seatedPerson()
    const res = await postEvent(env, 'membership.removed', {
      personId: 'p',
      email: user.email,
      sub: `sub_new_${uniqueId()}`,
      orgId,
    })
    expect(res.status).toBe(204)
    expect(await membership(tenant.id, user.id)).toBeUndefined()
  })

  it('an event with no sub is matched by email, even on a linked account', async () => {
    const env = eventsEnv()
    const { user, tenant, orgId } = await seatedPerson({ sub: `sub_c_${uniqueId()}` })
    const res = await postEvent(env, 'membership.removed', {
      personId: 'p',
      email: user.email,
      orgId,
    })
    expect(res.status).toBe(204)
    expect(await membership(tenant.id, user.id)).toBeUndefined()
  })

  it('the linked sub wins over a different email', async () => {
    const env = eventsEnv()
    const sub = `sub_d_${uniqueId()}`
    const { user, tenant, orgId } = await seatedPerson({ sub })
    await postEvent(env, 'membership.removed', {
      personId: 'p',
      email: 'someone-else@example.test',
      sub,
      orgId,
    })
    expect(await membership(tenant.id, user.id)).toBeUndefined()
  })
})

describe("access-giving events create the org's tenant", () => {
  const newOrg = () => {
    const id = uniqueId()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
    return { orgId: `org-${id}`, orgSlug: `acme-${id}`, orgName: `Acme ${id}` }
  }
  const tenantOf = async (orgId: string) =>
    db.query.tenants.findFirst({ where: eq(tenants.externalOrgId, orgId) })
  const personOf = (user: { email: string }) => ({ personId: `p-${user.email}`, email: user.email })
  const membersOf = (tenantId: string) =>
    db.select().from(tenantUsers).where(eq(tenantUsers.tenantId, tenantId))

  it('grant.added makes the linked tenant with the members the app knows, then membership.added adds one', async () => {
    const env = eventsEnv()
    const org = newOrg()
    const [first, second] = [await createTestUser(db), await createTestUser(db)]
    const stranger = { personId: 'p-stranger', email: `stranger_${uniqueId()}@example.test` }

    const granted = await postEvent(env, 'grant.added', {
      ...org,
      members: [
        { ...personOf(first), role: 'admin' },
        { ...stranger, role: 'member' },
        // A role the map does not know is skipped, as at sign-in.
        { ...personOf(second), role: 'org_viewer' },
      ],
    })
    expect(granted.status).toBe(204)
    const tenant = await tenantOf(org.orgId)
    expect(tenant).toMatchObject({ name: org.orgName, slug: org.orgSlug, externalOrgId: org.orgId })
    const tenantId = tenant?.id as string
    // No owner: the identity provider's memberships only.
    expect(await membersOf(tenantId)).toEqual([
      expect.objectContaining({ userId: first.id, role: 'admin', source: 'idp' }),
    ])
    // A session the person already has sees it, with no new sign-in.
    const token = await createTestSession(db, first.id)
    const session = await json<{ tenants: Array<{ id: string }> }>(
      await request('/auth/session', { headers: sessionCookieHeader(token) }, { env })
    )
    expect(session.tenants.map(t => t.id)).toContain(tenantId)

    const joined = await postEvent(env, 'membership.added', {
      ...personOf(second),
      ...org,
      role: 'member',
    })
    expect(joined.status).toBe(204)
    expect(await membership(tenantId, second.id)).toMatchObject({ role: 'member', source: 'idp' })
  })

  it('membership.added alone makes the tenant for the person it names', async () => {
    const env = eventsEnv()
    const org = newOrg()
    const user = await createTestUser(db)
    const res = await postEvent(env, 'membership.added', {
      ...personOf(user),
      ...org,
      role: 'admin',
    })
    expect(res.status).toBe(204)
    const tenant = await tenantOf(org.orgId)
    expect(tenant).toMatchObject({ slug: org.orgSlug, name: org.orgName })
    expect(await membership(tenant?.id as string, user.id)).toMatchObject({
      role: 'admin',
      source: 'idp',
    })
  })

  it('an event naming nobody the app knows makes no tenant', async () => {
    const env = eventsEnv()
    const org = newOrg()
    const stranger = { personId: 'p-x', email: `nobody_${uniqueId()}@example.test`, role: 'member' }
    expect((await postEvent(env, 'grant.added', { ...org, members: [stranger] })).status).toBe(204)
    expect((await postEvent(env, 'membership.added', { ...stranger, ...org })).status).toBe(204)
    expect(await tenantOf(org.orgId)).toBeUndefined()
  })

  it('a late membership.added never lets a person removed after it back in', async () => {
    const env = eventsEnv()
    const { user, tenant, orgId } = await seatedPerson()
    const org = { orgId, orgSlug: tenant.slug, orgName: tenant.name }
    const added = makeEvent('membership.added', { ...personOf(user), ...org, role: 'member' }, 2)
    const removed = makeEvent('membership.removed', { ...personOf(user), orgId }, 1)

    expect((await deliver(env, removed)).status).toBe(204)
    expect((await deliver(env, added)).status).toBe(204)
    expect(await membership(tenant.id, user.id)).toBeUndefined()

    // Added again after the removal: back in. The removal is dated by the database's clock, which
    // may run ahead of this process's, so the later event is dated clearly later.
    const readded = makeEvent('membership.added', { ...personOf(user), ...org, role: 'member' }, -1)
    expect((await deliver(env, readded)).status).toBe(204)
    expect(await membership(tenant.id, user.id)).toMatchObject({ source: 'idp' })
  })

  it('a replayed event, or a second grant.added for the org, changes nothing', async () => {
    const env = eventsEnv()
    const org = newOrg()
    const user = await createTestUser(db)
    const grant = makeEvent('grant.added', {
      ...org,
      members: [{ ...personOf(user), role: 'admin' }],
    })
    expect((await deliver(env, grant)).status).toBe(204)
    const tenant = await tenantOf(org.orgId)
    const tenantId = tenant?.id as string
    const snapshot = async () => ({
      tenants: await db.select().from(tenants).where(eq(tenants.externalOrgId, org.orgId)),
      members: await membersOf(tenantId),
      activity: await db
        .select({ id: activityEvents.id })
        .from(activityEvents)
        .where(eq(activityEvents.tenantId, tenantId)),
    })
    const before = await snapshot()

    // The same delivery again (same webhook-id), then another grant naming the org differently.
    expect((await deliver(env, grant)).status).toBe(204)
    const again = makeEvent('grant.added', {
      ...org,
      orgName: 'Another name',
      orgSlug: `other-${org.orgSlug}`,
      members: [{ ...personOf(user), role: 'admin' }],
    })
    expect((await deliver(env, again)).status).toBe(204)
    const after = await snapshot()
    expect(after.tenants).toEqual([expect.objectContaining({ id: tenantId, name: org.orgName })])
    expect(after.members.map(m => [m.userId, m.role, m.source])).toEqual(
      before.members.map(m => [m.userId, m.role, m.source])
    )
    expect(after.activity).toHaveLength(before.activity.length)
  })
})
