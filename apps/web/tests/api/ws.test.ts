/**
 * `GET /ws` upgrade auth: 426 without `Upgrade: websocket`, 401 without a cookie, 403 for
 * a tenant the user is not a member of, and the happy path hands the upgrade to the realtime hub
 * with the member's identity (the recording hub answers 501, which passes straight through).
 */
import { describe, expect, it } from 'vitest'
import { UPGRADE_REQUIRED_CODE } from '@/api/routes/ws'
import {
  createTestSession,
  createTestTenant,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()
const UPGRADE = { Upgrade: 'websocket', Connection: 'Upgrade' }

/** What the route handed to the realtime hub. */
function spyHub(env: ReturnType<typeof createTestEnv>) {
  return stubs(env).hub.accepted
}

async function memberWithCookie() {
  const { user, tenant } = await createTestTenantWithUser(db, 'member')
  const token = await createTestSession(db, user.id, tenant.id)
  return { user, tenant, cookie: sessionCookieHeader(token) }
}

describe('GET /ws', () => {
  it('426 envelope when the request is not a WebSocket upgrade', async () => {
    const { cookie } = await memberWithCookie()
    const res = await request('/ws', { headers: cookie })
    expect(res.status).toBe(426)
    expect(await json(res)).toMatchObject({ statusCode: 426, code: UPGRADE_REQUIRED_CODE })
  })

  it('401 envelope without a session cookie', async () => {
    const res = await request('/ws', { headers: UPGRADE })
    expect(res.status).toBe(401)
    expect(await json(res)).toMatchObject({ statusCode: 401, code: 'unauthorized' })
  })

  it('403 for a tenant the user does not belong to', async () => {
    const { cookie } = await memberWithCookie()
    const other = await createTestTenant(db)
    const env = createTestEnv()
    const forwarded = spyHub(env)
    const res = await request(
      `/ws?tenantId=${other.id}`,
      { headers: { ...cookie, ...UPGRADE } },
      { env }
    )
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ statusCode: 403, code: 'forbidden' })
    expect(forwarded).toHaveLength(0)
  })

  it('hands the upgrade to the hub with the member identity', async () => {
    const { user, tenant, cookie } = await memberWithCookie()
    const env = createTestEnv()
    const forwarded = spyHub(env)
    const res = await request(
      `/ws?tenantId=${tenant.id}`,
      { headers: { ...cookie, ...UPGRADE } },
      { env }
    )
    // The recording hub answers 501 — reaching it IS the assertion; the real hub upgrades.
    expect(res.status).toBe(501)
    expect(forwarded).toHaveLength(1)
    const [{ member, request: req }] = forwarded
    expect(member.tenantId).toBe(tenant.id)
    expect(member.userId).toBe(user.id)
    expect(member.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(req.headers.get('Upgrade')).toBe('websocket')
  })

  it('falls back to the session tenant when ?tenantId is omitted', async () => {
    const { tenant, cookie } = await memberWithCookie()
    const env = createTestEnv()
    const forwarded = spyHub(env)
    const res = await request('/ws', { headers: { ...cookie, ...UPGRADE } }, { env })
    expect(res.status).toBe(501)
    expect(forwarded[0]?.member.tenantId).toBe(tenant.id)
  })
})
