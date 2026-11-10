// @vitest-isolate
// Boots the Node entry (`installProcessPool` is process-wide) and LISTENs on the test database.
/**
 * A socket the hub admitted is closed when the membership or session that admitted it goes away:
 * removal from the tenant, sign-out, a block, a suspension, and the identity provider's own
 * removals. Drives the real routes over HTTP and the real Node hub over real sockets; the close
 * travels through `LISTEN/NOTIFY`, so the identity-provider case publishes it from "another pod".
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { applyIdentityEvent } from '@/api/services/idp-tenancy'
import type { Realtime } from '@/api/services/realtime'
import { loadConfig } from '@/config'
import { createNodeRealtime, type NodeRealtime, SOCKET_REVOKED_CODE } from '@/node/realtime'
import { type RunningServer, startServer } from '@/node/server'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
  uniqueId,
} from '../../helpers/auth'
import { setupTestDatabase, testDatabaseUrl } from '../../helpers/db'

const db = setupTestDatabase()
const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: testDatabaseUrl() }

let server: RunningServer
let otherPod: NodeRealtime
let base: string

beforeAll(async () => {
  const config = loadConfig(env)
  const realtime = createNodeRealtime({
    config,
    log: () => {},
    sockets: true,
    reconnectMs: 50,
    applicationName: `rp-revocation-test-${randomUUID().slice(0, 8)}`,
  })
  server = await startServer({
    env,
    mode: 'web',
    port: 0,
    realtime,
    loadGuide: false,
    log: () => {},
  })
  await realtime.ready()
  base = `http://127.0.0.1:${server.port}`
  otherPod = createNodeRealtime({ config, log: () => {}, sockets: false })
})

afterAll(async () => {
  await otherPod?.stop()
  await server?.stop()
})

/** An open socket and the close code it ends with (null while open). */
interface Socket {
  ws: WebSocket
  closed: () => number | null
  closing: Promise<number>
}

function connect(cookie: Record<string, string>, tenantId: string): Promise<Socket> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?tenantId=${tenantId}`, {
    headers: cookie,
  })
  let code: number | null = null
  const closing = new Promise<number>(resolve =>
    ws.once('close', c => {
      code = c
      resolve(c)
    })
  )
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, closed: () => code, closing }))
    ws.once('error', reject)
  })
}

function call(
  method: string,
  path: string,
  cookie: Record<string, string>,
  body?: unknown
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...cookie,
      Origin: base,
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

/** Long enough for a NOTIFY to round-trip when nothing should arrive. */
const settle = () => new Promise(r => setTimeout(r, 300))

async function setup() {
  const { user: owner, tenant } = await createTestTenantWithUser(db, 'owner')
  const member = await createTestUser(db)
  await linkUserToTenant(db, member.id, tenant.id, 'member')
  const ownerCookie = sessionCookieHeader(await createTestSession(db, owner.id, tenant.id))
  const memberCookie = sessionCookieHeader(await createTestSession(db, member.id, tenant.id))
  const socket = await connect(memberCookie, tenant.id)
  return { tenant, owner, member, ownerCookie, memberCookie, socket }
}

describe('sockets are closed on revocation', () => {
  it('stays open while the member stays a member', async () => {
    const { ownerCookie, socket } = await setup()
    const res = await call('PATCH', '/api/tenant', ownerCookie, { name: `Renamed ${Date.now()}` })
    expect(res.status).toBe(200)
    await settle()
    expect(socket.closed()).toBeNull()
    socket.ws.close()
  })

  it('member removal closes that member socket', async () => {
    const { member, ownerCookie, socket } = await setup()
    const removed = await call('DELETE', `/api/members/${member.id}`, ownerCookie)
    expect(removed.status).toBeLessThan(300)
    expect(await socket.closing).toBe(SOCKET_REVOKED_CODE)
  })

  it('sign-out closes that session socket, not another session of the same person', async () => {
    const { memberCookie, tenant, member, socket } = await setup()
    const otherCookie = sessionCookieHeader(await createTestSession(db, member.id, tenant.id))
    const other = await connect(otherCookie, tenant.id)
    const out = await call('POST', '/auth/logout', memberCookie)
    expect(out.status).toBe(204)
    expect(await socket.closing).toBe(SOCKET_REVOKED_CODE)
    await settle()
    expect(other.closed()).toBeNull()
    other.ws.close()
  })

  it('blocking a person closes their sockets in every tenant', async () => {
    const { member, socket } = await setup()
    const { tenant: second } = await createTestTenantWithUser(db, 'owner')
    await linkUserToTenant(db, member.id, second.id, 'member')
    const secondCookie = sessionCookieHeader(await createTestSession(db, member.id, second.id))
    const socket2 = await connect(secondCookie, second.id)
    const admin = await createTestGlobalAdmin(db)
    const adminCookie = sessionCookieHeader(await createTestSession(db, admin.id))
    const res = await call('POST', `/api/admin/users/${member.id}/block`, adminCookie, {
      blocked: true,
    })
    expect(res.status).toBe(200)
    expect(await socket.closing).toBe(SOCKET_REVOKED_CODE)
    expect(await socket2.closing).toBe(SOCKET_REVOKED_CODE)
  })

  it('suspending a tenant closes every socket in it', async () => {
    const { tenant, ownerCookie, socket } = await setup()
    const ownerSocket = await connect(ownerCookie, tenant.id)
    const admin = await createTestGlobalAdmin(db)
    const adminCookie = sessionCookieHeader(await createTestSession(db, admin.id))
    const res = await call('POST', `/api/admin/tenants/${tenant.id}/suspend`, adminCookie, {
      suspended: true,
    })
    expect(res.status).toBe(200)
    expect(await socket.closing).toBe(SOCKET_REVOKED_CODE)
    expect(await ownerSocket.closing).toBe(SOCKET_REVOKED_CODE)
  })

  it('an identity-provider person suspension closes that person sockets, from any process', async () => {
    const { member, socket } = await setup()
    const cfg = loadConfig({
      ...env,
      OIDC_MANAGED_TENANCY: 'true',
      OIDC_ISSUER: 'https://issuer.example/realms/test',
      OIDC_CLIENT_ID: 'test-client',
    })
    const realtime: Realtime = { defer: work => void work(), hub: otherPod.hub }
    await applyIdentityEvent(
      db,
      cfg,
      {
        id: uniqueId(),
        type: 'person.suspended',
        occurredAt: new Date().toISOString(),
        data: { email: member.email },
      } as never,
      realtime
    )
    expect(await socket.closing).toBe(SOCKET_REVOKED_CODE)
  })
})
