/**
 * Realtime on Node (M5, `docs/ROADMAP.md`): the `/ws` hub without the `NotificationsHub` Durable
 * Object. Two halves, joined by Postgres `LISTEN/NOTIFY` so any process can nudge a socket held by
 * any other:
 *
 * - **Publisher** (every mode): `toTenant`/`toUser`/`toUsers` → `pg_notify('rp_realtime', json)`
 *   on a small postgres.js client of its own. Jobs, runs and cron in a `worker` process publish the
 *   same way, so a nudge from a background step reaches a socket on whichever `web` pod holds it.
 *   A payload must fit NOTIFY's 8000-byte limit: a bigger one is logged and dropped — events are
 *   nudges ("DB is the truth, WebSocket is a nudge"); anything large belongs in a row the client
 *   refetches.
 * - **Sockets + listener** (`web`/`all`): the sockets this process accepted, by tenant, each tagged
 *   with its user; ONE dedicated connection (`DATABASE_LISTEN_URL`, else the database URL) LISTENs
 *   and delivers every notification to the matching local sockets. A lost listener reconnects with
 *   backoff; notifications sent while it was down are lost (best effort, as on the DO).
 *
 * The wire protocol is the DO's: events are sent as `JSON.stringify(event)`; a client's
 * `{"type":"ping"}` (every 30 s, `src/ui/lib/websocketClient.ts`) is answered `{"type":"pong"}`.
 * The server also pings at the protocol level every `heartbeatMs` and drops a socket that missed
 * the previous one. Shutdown closes every socket with 1001 ("going away"), which the client treats
 * as a deploy and reconnects at once.
 *
 * **Topics** (`@rocketpod/shared/realtime` § Topics): a client may also send
 * `{"type":"subscribe","topic":…}` / `unsubscribe` (`realtimeClientMessageSchema`). The hub keeps
 * a topic on the connection only when `canSubscribeTopic(member, topic)` allows — the member's
 * `canRead` and `globalAdmin` were decided by `/ws` — and silently refuses anything else, at most
 * `MAX_TOPICS_PER_SOCKET` per socket. `toTopic` publishes `{ t, k, e }`; delivery is to the
 * subscribed sockets of the tenant the topic names (any tenant for a platform topic).
 *
 * `accept()` is the RealtimeHub seam: `routes/ws.ts` authenticates and checks membership, then
 * hands over the identity. Node's HTTP upgrade happens outside the fetch handler, so the server
 * runs the app inside `upgradeScope` (an AsyncLocalStorage slot); `accept()` records the member in
 * the slot and answers a marker response, and the server completes the handshake
 * (`handleUpgrade`) only when the route accepted (`server.ts`).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  canSubscribeTopic,
  parseRealtimeTopic,
  type RealtimeEvent,
  realtimeClientMessageSchema,
} from '@rocketpod/shared/realtime'
import postgres from 'postgres'
import { type WebSocket, WebSocketServer } from 'ws'
import type { AppConfig } from '../config'
import { resolveDatabaseUrl } from '../db/client'
import type { BroadcastResult, RealtimeHub, RealtimeMember } from '../platform/types'

export const REALTIME_CHANNEL = 'rp_realtime'
/** NOTIFY's payload limit is 8000 bytes; stay strictly under it. */
export const MAX_NOTIFY_BYTES = 7999
const PING = JSON.stringify({ type: 'ping' })
const PONG = JSON.stringify({ type: 'pong' })
/** "Going away": the UI reconnects at once instead of backing off. */
export const GOING_AWAY = 1001

/** Who a socket is: `routes/ws.ts` decided it (topic grants included); the hub only reads it. */
export type HubMember = RealtimeMember

/** Topics one socket may hold at once — a page subscribes to a handful, never hundreds. */
export const MAX_TOPICS_PER_SOCKET = 64

/**
 * What travels through NOTIFY: the tenant, an optional user filter, and the event itself — or, for
 * a TOPIC send, the topic `k`: delivered to the sockets subscribed to it, within tenant `t` for a
 * tenant topic (the tenant the topic names) and on any tenant for a platform one (`t` = `*`).
 */
interface Envelope {
  t: string
  u?: string[]
  k?: string
  e: RealtimeEvent
}

/** Any tenant: a platform topic's envelope. */
const ANY_TENANT = '*'

/** The per-upgrade slot `accept()` fills while the app handles an upgrade request. */
export interface UpgradeSlot {
  member: HubMember | null
}

export const upgradeScope = new AsyncLocalStorage<UpgradeSlot>()

/** The marker `accept()` answers; the server swaps it for the 101. */
export const UPGRADE_ACCEPTED_HEADER = 'x-rocketpod-upgrade'

function jsonResponse(status: number, error: string, code: string): Response {
  return new Response(JSON.stringify({ error, statusCode: status, code }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface Connection {
  ws: WebSocket
  member: HubMember
  alive: boolean
  /** The topics this socket subscribed to (and was allowed to). */
  topics: Set<string>
}

export interface NodeRealtimeOptions {
  config: AppConfig
  log: (message: string) => void
  /** `true` in `web`/`all`: hold sockets and LISTEN. `false` in `worker`: publish only. */
  sockets: boolean
  heartbeatMs?: number
  /** First reconnect delay for a lost listener; doubles up to 30 s. */
  reconnectMs?: number
  /** `application_name` of the two connections (the listener gets `-listen`). */
  applicationName?: string
}

export interface NodeRealtime {
  hub: RealtimeHub
  /** Complete an upgrade the app accepted (`server.ts`). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, member: HubMember): void
  /** Sockets held by this process (tests, logs). */
  connectionCount(tenantId?: string): number
  /** Resolves once the listener is LISTENing (immediately when this process holds no sockets). */
  ready(): Promise<void>
  /** Close every socket with 1001, stop listening, end both connections. Idempotent. */
  stop(): Promise<void>
}

export function createNodeRealtime(options: NodeRealtimeOptions): NodeRealtime {
  const { config, log } = options
  const url = resolveDatabaseUrl(config)
  const appName = options.applicationName ?? 'rocketpod-realtime'
  const publisher = postgres(url, {
    max: 2,
    onnotice: () => {},
    fetch_types: false,
    connection: { application_name: appName },
  })
  const byTenant = new Map<string, Set<Connection>>()
  let stopped = false

  // ---- publish --------------------------------------------------------------------------------

  async function publish(envelope: Envelope): Promise<BroadcastResult> {
    const payload = JSON.stringify(envelope)
    if (Buffer.byteLength(payload) > MAX_NOTIFY_BYTES) {
      log(
        `realtime: dropped a ${envelope.e.type} event of ${Buffer.byteLength(payload)} bytes — ` +
          `NOTIFY carries at most ${MAX_NOTIFY_BYTES}; put large payloads in a row`
      )
      return { delivered: 0 }
    }
    await publisher`select pg_notify(${REALTIME_CHANNEL}, ${payload})`
    // Delivery happens on whichever processes hold the sockets; this one cannot count them.
    return { delivered: 0 }
  }

  // ---- local sockets ----------------------------------------------------------------------------

  function send(conn: Connection, payload: string): void {
    try {
      conn.ws.send(payload)
    } catch {
      try {
        conn.ws.close(1011, 'send failed')
      } catch {
        // already closed
      }
    }
  }

  function deliver(envelope: Envelope): void {
    const payload = JSON.stringify(envelope.e)
    if (envelope.k !== undefined) {
      const topic = envelope.k
      const pools = envelope.t === ANY_TENANT ? [...byTenant.values()] : [byTenant.get(envelope.t)]
      for (const conns of pools) {
        for (const conn of conns ?? []) if (conn.topics.has(topic)) send(conn, payload)
      }
      return
    }
    const conns = byTenant.get(envelope.t)
    if (!conns) return
    const users = envelope.u ? new Set(envelope.u) : null
    for (const conn of conns) {
      if (users && !users.has(conn.member.userId)) continue
      send(conn, payload)
    }
  }

  function register(ws: WebSocket, member: HubMember): void {
    const conn: Connection = { ws, member, alive: true, topics: new Set() }
    let conns = byTenant.get(member.tenantId)
    if (!conns) {
      conns = new Set()
      byTenant.set(member.tenantId, conns)
    }
    conns.add(conn)
    ws.on('pong', () => {
      conn.alive = true
    })
    ws.on('message', (data, isBinary) => {
      conn.alive = true
      if (isBinary) return
      const text = data.toString()
      if (text === PING) {
        ws.send(PONG)
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return // ignore malformed frames
      }
      const message = realtimeClientMessageSchema.safeParse(parsed)
      if (!message.success) return
      const frame = message.data
      if (frame.type === 'ping') ws.send(PONG)
      else if (frame.type === 'unsubscribe') conn.topics.delete(frame.topic)
      // A refused subscription is silently not added: the socket learns nothing about the topic.
      else if (conn.topics.size < MAX_TOPICS_PER_SOCKET && canSubscribeTopic(member, frame.topic)) {
        conn.topics.add(frame.topic)
      }
    })
    const drop = () => {
      conns.delete(conn)
      if (conns.size === 0 && byTenant.get(member.tenantId) === conns) {
        byTenant.delete(member.tenantId)
      }
    }
    ws.on('close', drop)
    ws.on('error', () => {
      try {
        ws.close(1011, 'websocket error')
      } catch {
        // already closed
      }
    })
  }

  const wss = options.sockets ? new WebSocketServer({ noServer: true }) : null
  const heartbeat =
    wss &&
    setInterval(() => {
      for (const conns of byTenant.values()) {
        for (const conn of conns) {
          if (!conn.alive) {
            conn.ws.terminate()
            continue
          }
          conn.alive = false
          try {
            conn.ws.ping()
          } catch {
            // a closing socket; the close handler removes it
          }
        }
      }
    }, options.heartbeatMs ?? 30_000)
  heartbeat?.unref()

  // ---- listener ---------------------------------------------------------------------------------

  let listener: ReturnType<typeof postgres> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let delay = options.reconnectMs ?? 1000
  let readyResolve: (() => void) | null = null
  let readyPromise: Promise<void> = Promise.resolve()

  function onNotification(payload: string): void {
    let envelope: Envelope
    try {
      envelope = JSON.parse(payload) as Envelope
    } catch {
      return
    }
    if (typeof envelope?.t !== 'string' || !envelope.e) return
    deliver(envelope)
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return
    const wait = delay
    delay = Math.min(delay * 2, 30_000)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connectListener()
    }, wait)
    reconnectTimer.unref()
  }

  async function connectListener(): Promise<void> {
    if (stopped) return
    const previous = listener
    listener = null
    if (previous) void previous.end({ timeout: 0 }).catch(() => {})
    const client = postgres(config.DATABASE_LISTEN_URL || url, {
      max: 1,
      idle_timeout: 0,
      connection: { application_name: `${appName}-listen` },
      max_lifetime: null,
      fetch_types: false,
      onnotice: () => {},
      onnotify: (channel: string, payload: string) => {
        if (channel === REALTIME_CHANNEL) onNotification(payload)
      },
      onclose: () => {
        if (stopped || listener !== client) return
        log('realtime: listener connection lost — reconnecting')
        listener = null
        void client.end({ timeout: 0 }).catch(() => {})
        scheduleReconnect()
      },
    } as postgres.Options<Record<string, never>>)
    listener = client
    try {
      await client.unsafe(`LISTEN "${REALTIME_CHANNEL}"`)
      delay = options.reconnectMs ?? 1000
      readyResolve?.()
      readyResolve = null
    } catch (err) {
      if (stopped) return
      log(`realtime: LISTEN failed (${String(err)}) — retrying`)
      if (listener === client) listener = null
      void client.end({ timeout: 0 }).catch(() => {})
      scheduleReconnect()
    }
  }

  if (options.sockets) {
    readyPromise = new Promise<void>(resolve => {
      readyResolve = resolve
    })
    void connectListener()
  }

  // ---- the seam --------------------------------------------------------------------------------

  const hub: RealtimeHub = {
    toTenant: (tenantId, event) => publish({ t: tenantId, e: event }),
    toUser: (tenantId, userId, event) => publish({ t: tenantId, u: [userId], e: event }),
    toUsers: (tenantId, userIds, event) =>
      publish({ t: tenantId, u: [...new Set(userIds)], e: event }),
    async toTopic(topic, event) {
      const parsed = parseRealtimeTopic(topic)
      if (!parsed) {
        log(`realtime: dropped a ${event.type} event for an unregistered topic ${topic}`)
        return { delivered: 0 }
      }
      // A tenant topic is delivered inside the tenant it NAMES, whatever the event claims.
      return publish({ t: parsed.tenantId ?? ANY_TENANT, k: topic, e: event })
    },
    async accept(_request, member) {
      const slot = upgradeScope.getStore()
      if (!wss || !slot) {
        return jsonResponse(
          503,
          'Realtime is not served by this process',
          'realtime_not_configured'
        )
      }
      slot.member = member
      return new Response(null, { status: 200, headers: { [UPGRADE_ACCEPTED_HEADER]: '1' } })
    },
  }

  let stopping: Promise<void> | undefined

  return {
    hub,
    handleUpgrade(req, socket, head, member) {
      if (!wss || stopped) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, ws => register(ws, member))
    },
    connectionCount(tenantId) {
      if (tenantId) return byTenant.get(tenantId)?.size ?? 0
      let n = 0
      for (const conns of byTenant.values()) n += conns.size
      return n
    },
    ready: () => readyPromise,
    stop() {
      stopping ??= (async () => {
        stopped = true
        if (heartbeat) clearInterval(heartbeat)
        if (reconnectTimer) clearTimeout(reconnectTimer)
        for (const conns of byTenant.values()) {
          for (const conn of conns) {
            try {
              conn.ws.close(GOING_AWAY, 'server restarting')
            } catch {
              // already closed
            }
          }
        }
        byTenant.clear()
        wss?.close()
        const closing = listener
        listener = null
        await Promise.all([
          closing?.end({ timeout: 1 }).catch(() => {}),
          publisher.end({ timeout: 1 }).catch(() => {}),
        ])
      })()
      return stopping
    },
  }
}
