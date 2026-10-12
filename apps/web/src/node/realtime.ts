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
 * `accept()` is the RealtimeHub seam: `routes/ws.ts` authenticates and checks membership, then
 * hands over the identity. Node's HTTP upgrade happens outside the fetch handler, so the server
 * runs the app inside `upgradeScope` (an AsyncLocalStorage slot); `accept()` records the member in
 * the slot and answers a marker response, and the server completes the handshake
 * (`handleUpgrade`) only when the route accepted (`server.ts`).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { RealtimeEvent } from '@rocketpod/shared/realtime'
import postgres from 'postgres'
import { type WebSocket, WebSocketServer } from 'ws'
import type { AppConfig } from '../config'
import { resolveDatabaseUrl } from '../db/client'
import type { BroadcastResult, RealtimeHub } from '../platform/types'

export const REALTIME_CHANNEL = 'rp_realtime'
/** NOTIFY's payload limit is 8000 bytes; stay strictly under it. */
export const MAX_NOTIFY_BYTES = 7999
const PING = JSON.stringify({ type: 'ping' })
const PONG = JSON.stringify({ type: 'pong' })
/** "Going away": the UI reconnects at once instead of backing off. */
export const GOING_AWAY = 1001

export interface HubMember {
  tenantId: string
  userId: string
  sessionId: string
}

/** What travels through NOTIFY: the tenant, an optional user filter, and the event itself. */
interface Envelope {
  t: string
  u?: string[]
  e: RealtimeEvent
}

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

  function deliver(envelope: Envelope): void {
    const conns = byTenant.get(envelope.t)
    if (!conns) return
    const users = envelope.u ? new Set(envelope.u) : null
    const payload = JSON.stringify(envelope.e)
    for (const conn of conns) {
      if (users && !users.has(conn.member.userId)) continue
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
  }

  function register(ws: WebSocket, member: HubMember): void {
    const conn: Connection = { ws, member, alive: true }
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
      try {
        if ((JSON.parse(text) as { type?: unknown }).type === 'ping') ws.send(PONG)
      } catch {
        // ignore malformed frames
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
