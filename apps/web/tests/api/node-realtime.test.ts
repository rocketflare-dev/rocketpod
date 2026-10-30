// @vitest-isolate
// Boots the Node entry (`installProcessPool` is process-wide), LISTENs on the test database, and mocks the shared plugin barrel (test topic kinds).
/**
 * Realtime on Node (`src/node/realtime.ts`): `/ws` upgraded in-process after the route's own
 * auth and membership check, events fanned out through Postgres `LISTEN/NOTIFY` — so a second
 * hub (another pod) reaches this server's sockets — with the `/ws` wire protocol, per-user and
 * per-tenant targeting, the NOTIFY size limit, a listener that comes back after its connection is
 * killed, 1001 on shutdown, and TOPICS — subscribed by name, granted by the registry and the
 * member's role (the barrel is mocked to add `test-topics`' kinds: core ships none).
 */
import { randomUUID } from 'node:crypto'
import { platformTopic, tenantTopic } from '@rocketpod/shared/realtime'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { realtimeEvent } from '@/api/services/realtime'
import { loadConfig } from '@/config'
import { rows } from '@/db/client'
import { createNodeRealtime, GOING_AWAY, type NodeRealtime } from '@/node/realtime'
import { type RunningServer, startServer } from '@/node/server'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenant,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase, testDatabaseUrl } from '../helpers/db'

vi.mock('@rocketpod/shared/plugins', async importOriginal =>
  (await import('../helpers/test-topics-shared')).withTestTopics(await importOriginal())
)

const db = setupTestDatabase()
const appName = `rp-realtime-test-${randomUUID().slice(0, 8)}`
const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: testDatabaseUrl() }
const logs: string[] = []

let server: RunningServer
let otherPod: NodeRealtime
let wsBase: string

beforeAll(async () => {
  const config = loadConfig(env)
  const realtime = createNodeRealtime({
    config,
    log: m => logs.push(m),
    sockets: true,
    reconnectMs: 50,
    heartbeatMs: 150,
    applicationName: appName,
  })
  // `loadGuide: false`: the boot load writes the GLOBAL `guide_chunks`, which `guide.test.ts` owns.
  server = await startServer({
    env,
    mode: 'web',
    port: 0,
    realtime,
    loadGuide: false,
    log: () => {},
  })
  await realtime.ready()
  wsBase = `ws://127.0.0.1:${server.port}/ws`
  // "Another pod": publishes through NOTIFY only, like a worker process.
  otherPod = createNodeRealtime({ config, log: m => logs.push(m), sockets: false })
})

afterAll(async () => {
  await otherPod?.stop()
  await server?.stop()
})

/** A connected socket plus a queue of the JSON messages it received. */
interface Client {
  ws: WebSocket
  messages: unknown[]
  next(timeoutMs?: number): Promise<unknown>
}

function connect(
  cookie: Record<string, string>,
  tenantId?: string,
  options: { autoPong?: boolean } = {}
): Promise<Client> {
  const url = tenantId ? `${wsBase}?tenantId=${tenantId}` : wsBase
  const ws = new WebSocket(url, { headers: cookie, ...options })
  const messages: unknown[] = []
  const waiters: ((m: unknown) => void)[] = []
  ws.on('message', data => {
    const parsed = JSON.parse(data.toString())
    const waiter = waiters.shift()
    if (waiter) waiter(parsed)
    else messages.push(parsed)
  })
  const client: Client = {
    ws,
    messages,
    next(timeoutMs = 3000) {
      if (messages.length > 0) return Promise.resolve(messages.shift())
      return new Promise((resolve, reject) => {
        const waiter = (m: unknown) => {
          clearTimeout(timer)
          resolve(m)
        }
        // A timed-out waiter leaves the queue, so the next message is not swallowed.
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1)
          reject(new Error('no message'))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
  }
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(client))
    ws.once('error', reject)
  })
}

/** The HTTP status a refused upgrade answered. */
function refusedStatus(cookie: Record<string, string>, tenantId?: string): Promise<number> {
  const url = tenantId ? `${wsBase}?tenantId=${tenantId}` : wsBase
  const ws = new WebSocket(url, { headers: cookie })
  return new Promise((resolve, reject) => {
    ws.on('error', () => {})
    ws.once('unexpected-response', (req, res) => {
      resolve(res.statusCode ?? 0)
      res.resume()
      req.destroy()
    })
    ws.once('open', () => reject(new Error('upgrade was accepted')))
  })
}

async function member(role: 'owner' | 'admin' | 'member' = 'member') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  const token = await createTestSession(db, user.id, tenant.id)
  return { user, tenant, cookie: sessionCookieHeader(token) }
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 20))
  }
}

describe('GET /ws on Node', () => {
  it('refuses an upgrade without a session (401) and for a tenant the user is not in (403)', async () => {
    expect(await refusedStatus({})).toBe(401)
    const { cookie } = await member()
    const other = await createTestTenant(db)
    expect(await refusedStatus(cookie, other.id)).toBe(403)
  })

  it('upgrades a member and answers the client keepalive with a pong', async () => {
    const { cookie, tenant } = await member()
    const client = await connect(cookie)
    await until(() => server.realtime.connectionCount(tenant.id) === 1)
    client.ws.send(JSON.stringify({ type: 'ping' }))
    expect(await client.next()).toEqual({ type: 'pong' })
    client.ws.close()
    await until(() => server.realtime.connectionCount(tenant.id) === 0)
  })
})

describe('heartbeat', () => {
  it('keeps a socket that answers protocol pings, drops one that does not', async () => {
    const { cookie, tenant } = await member()
    const live = await connect(cookie)
    const dead = await connect(cookie, undefined, { autoPong: false })
    const closed = new Promise<void>(resolve => dead.ws.once('close', () => resolve()))
    await closed
    await until(() => server.realtime.connectionCount(tenant.id) === 1)
    expect(live.ws.readyState).toBe(WebSocket.OPEN)
    live.ws.close()
  })
})

describe('fan-out through LISTEN/NOTIFY', () => {
  it('a nudge published by another pod reaches a socket held by this server', async () => {
    const { cookie, tenant } = await member()
    const client = await connect(cookie)
    const event = realtimeEvent('member.changed', tenant.id, { reason: 'test' })
    await otherPod.hub.toTenant(tenant.id, event)
    expect(await client.next()).toEqual(event)
    client.ws.close()
  })

  it('toUser reaches that user only; another tenant never hears anything', async () => {
    const a = await member('owner')
    const second = await createTestUser(db)
    await linkUserToTenant(db, second.id, a.tenant.id, 'member')
    const secondCookie = sessionCookieHeader(await createTestSession(db, second.id, a.tenant.id))
    const stranger = await member()

    const first = await connect(a.cookie)
    const other = await connect(secondCookie)
    const outsider = await connect(stranger.cookie)

    const personal = realtimeEvent('notification.created', a.tenant.id)
    await otherPod.hub.toUser(a.tenant.id, a.user.id, personal)
    expect(await first.next()).toEqual(personal)

    // A tenant-wide marker after it: the other member's FIRST message is the marker.
    const marker = realtimeEvent('member.changed', a.tenant.id)
    await otherPod.hub.toTenant(a.tenant.id, marker)
    expect(await other.next()).toEqual(marker)
    expect(await first.next()).toEqual(marker)

    const strangerMarker = realtimeEvent('member.changed', stranger.tenant.id)
    await otherPod.hub.toTenant(stranger.tenant.id, strangerMarker)
    expect(await outsider.next()).toEqual(strangerMarker)

    for (const c of [first, other, outsider]) c.ws.close()
  })

  it('toUsers de-duplicates and targets the listed users', async () => {
    const { cookie, tenant, user } = await member('owner')
    const client = await connect(cookie)
    const event = realtimeEvent('notification.created', tenant.id)
    await server.realtime.hub.toUsers(tenant.id, [user.id, user.id], event)
    expect(await client.next()).toEqual(event)
    const marker = realtimeEvent('member.changed', tenant.id)
    await server.realtime.hub.toTenant(tenant.id, marker)
    expect(await client.next()).toEqual(marker)
    client.ws.close()
  })

  it('drops (and logs) an event too large for NOTIFY instead of failing the caller', async () => {
    const { cookie, tenant } = await member()
    const client = await connect(cookie)
    const big = realtimeEvent('entity.changed', tenant.id, { blob: 'x'.repeat(9000) })
    await expect(otherPod.hub.toTenant(tenant.id, big)).resolves.toEqual({ delivered: 0 })
    expect(logs.some(m => m.includes('NOTIFY carries at most'))).toBe(true)
    const marker = realtimeEvent('member.changed', tenant.id)
    await otherPod.hub.toTenant(tenant.id, marker)
    expect(await client.next()).toEqual(marker)
    client.ws.close()
  })

  it('the listener comes back after its connection is terminated', async () => {
    const { cookie, tenant } = await member()
    const client = await connect(cookie)
    const killed = await db.execute(
      sql`SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity
          WHERE application_name = ${`${appName}-listen`}`
    )
    expect(rows(killed)).toHaveLength(1)
    await until(() => logs.some(m => m.includes('listener connection lost')))
    // Publish until one gets through: the re-LISTEN lands within a few backoff steps.
    const event = realtimeEvent('member.changed', tenant.id)
    let received: unknown
    for (let i = 0; i < 50 && received === undefined; i++) {
      await otherPod.hub.toTenant(tenant.id, event)
      received = await client.next(100).catch(() => undefined)
    }
    expect(received).toEqual(event)
    client.ws.close()
  }, 15_000)
})

describe('topics', () => {
  /** A ping round trip proves every frame sent before it was processed. */
  async function settle(c: Client) {
    c.ws.send(JSON.stringify({ type: 'ping' }))
    expect(await c.next()).toEqual({ type: 'pong' })
  }
  const subscribe = (c: Client, topic: string) =>
    c.ws.send(JSON.stringify({ type: 'subscribe', topic }))

  /**
   * Assert every client hears its tenant's marker NEXT — i.e. nothing published before it reached
   * them. ONE marker for all of them: it goes to every socket in the tenant, so a second marker
   * would find the first still queued on the others.
   */
  async function hearsOnlyMarker(clients: Client[], tenantId: string) {
    const marker = realtimeEvent('member.changed', tenantId, { marker: randomUUID() })
    await otherPod.hub.toTenant(tenantId, marker)
    for (const c of clients) expect(await c.next()).toEqual(marker)
  }

  it('delivers to a subscriber who may read the subject, and not to one who may not', async () => {
    const owner = await member('owner')
    const plain = await createTestUser(db)
    await linkUserToTenant(db, plain.id, owner.tenant.id, 'member')
    const plainCookie = sessionCookieHeader(await createTestSession(db, plain.id, owner.tenant.id))
    const topic = tenantTopic('test-topics.trace', owner.tenant.id, randomUUID())

    const allowed = await connect(owner.cookie)
    const refused = await connect(plainCookie)
    const idle = await connect(owner.cookie)
    subscribe(allowed, topic)
    subscribe(refused, topic) // a member cannot `read Trace`
    for (const c of [allowed, refused]) await settle(c)

    const event = realtimeEvent('entity.changed', owner.tenant.id, { entity: 'traces' })
    await otherPod.hub.toTopic(topic, event)
    expect(await allowed.next()).toEqual(event)
    // The refused member and the owner who never subscribed hear nothing on it.
    await hearsOnlyMarker([allowed, refused, idle], owner.tenant.id)

    // The same member MAY subscribe to a kind whose subject every member reads.
    const docs = tenantTopic('test-topics.doc', owner.tenant.id, randomUUID())
    subscribe(refused, docs)
    await settle(refused)
    const docEvent = realtimeEvent('entity.changed', owner.tenant.id, { entity: 'documents' })
    await otherPod.hub.toTopic(docs, docEvent)
    expect(await refused.next()).toEqual(docEvent)

    // Unsubscribed, the owner hears nothing more on it.
    allowed.ws.send(JSON.stringify({ type: 'unsubscribe', topic }))
    await settle(allowed)
    await otherPod.hub.toTopic(topic, event)
    await hearsOnlyMarker([allowed, refused, idle], owner.tenant.id)

    for (const c of [allowed, refused, idle]) c.ws.close()
  })

  it('refuses a topic naming another tenant, and one no installed plugin declares', async () => {
    const mine = await member('owner')
    const theirs = await member('owner')
    const theirTopic = tenantTopic('test-topics.doc', theirs.tenant.id, randomUUID())
    // Well-formed, but its kind is not in the registry: an uninstalled plugin's topic.
    const unknown = `orders.order:${mine.tenant.id}:${randomUUID()}`

    const spy = await connect(mine.cookie)
    subscribe(spy, theirTopic)
    subscribe(spy, unknown)
    await settle(spy)

    await otherPod.hub.toTopic(theirTopic, realtimeEvent('entity.changed', theirs.tenant.id))
    await otherPod.hub.toTopic(unknown, realtimeEvent('entity.changed', mine.tenant.id))
    await hearsOnlyMarker([spy], mine.tenant.id)
    expect(logs.some(l => l.includes('unregistered topic'))).toBe(true)
    spy.ws.close()
  })

  it('delivers a platform topic to a subscribed global admin on any tenant, and to nobody else', async () => {
    const admin = await createTestGlobalAdmin(db)
    const tenant = await createTestTenant(db)
    await linkUserToTenant(db, admin.id, tenant.id, 'member')
    const adminCookie = sessionCookieHeader(await createTestSession(db, admin.id, tenant.id))
    const owner = await member('owner')
    const topic = platformTopic('test-topics.platform', randomUUID())

    const staff = await connect(adminCookie)
    const notStaff = await connect(owner.cookie)
    subscribe(staff, topic)
    subscribe(notStaff, topic)
    for (const c of [staff, notStaff]) await settle(c)

    // Published for a tenant neither socket is in.
    const event = realtimeEvent('entity.changed', randomUUID(), { entity: 'admin' })
    await otherPod.hub.toTopic(topic, event)
    expect(await staff.next()).toEqual(event)
    await hearsOnlyMarker([notStaff], owner.tenant.id)
    for (const c of [staff, notStaff]) c.ws.close()
  })
})

describe('shutdown', () => {
  it('closes every socket with 1001 (going away), so the client reconnects at once', async () => {
    const { cookie } = await member()
    const client = await connect(cookie)
    const closed = new Promise<number>(resolve => client.ws.once('close', code => resolve(code)))
    await server.stop()
    expect(await closed).toBe(GOING_AWAY)
  })
})
