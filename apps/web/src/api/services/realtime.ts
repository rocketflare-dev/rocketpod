/**
 * Realtime nudges (D7, D8): the ONLY module that sends to the platform's realtime hub. Routes and
 * services call `nudge*()` with the request's `Realtime` (`{ defer, hub }` from `withAuth`), which
 * builds the event and hands the send to `defer` — never awaited on the response path, never
 * allowed to fail the request. "DB is the truth, WebSocket is a nudge."
 *
 * `Broadcaster` (`src/platform/types.ts`) is the seam; the implementation publishes through
 * Postgres NOTIFY to every pod's local sockets (`src/node/realtime.ts`).
 *
 * Revocation goes the same way: `close{User,Session,Tenant}Sockets` end the sockets a removed
 * member, a signed-out session or a suspended tenant still holds (close code 4001), after the
 * change has committed.
 */
import type { RealtimeEvent, RealtimeEventType } from '@rocketpod/shared/realtime'
import type { Broadcaster, Defer } from '../../platform/types'

export type { Broadcaster, BroadcastResult } from '../../platform/types'

/** Everything a service needs to nudge: how to defer, and the hub (null = no realtime). */
export interface Realtime {
  defer: Defer
  hub: Broadcaster | null
}

export function realtimeEvent(
  type: RealtimeEventType,
  tenantId: string,
  payload?: unknown
): RealtimeEvent {
  return { type, tenantId, at: new Date().toISOString(), ...(payload !== undefined && { payload }) }
}

/** Tenant-wide nudge (member / invitation / tenant changes). No-op without a hub. */
export function nudge(rt: Realtime | undefined, event: RealtimeEvent): void {
  const hub = rt?.hub
  if (!rt || !hub) return
  rt.defer(() => hub.toTenant(event.tenantId, event))
}

/** One user's sockets in the tenant (their notifications). */
export function nudgeUser(rt: Realtime | undefined, userId: string, event: RealtimeEvent): void {
  const hub = rt?.hub
  if (!rt || !hub) return
  rt.defer(() => hub.toUser(event.tenantId, userId, event))
}

/** Where a close cannot wait for the request's `defer`: run it and let the caller await `flush`. */
export function collectingRealtime(hub: Broadcaster | null): Realtime & { flush(): Promise<void> } {
  const pending: Promise<unknown>[] = []
  return {
    hub,
    defer: work => {
      pending.push(work())
    },
    flush: async () => {
      await Promise.allSettled(pending)
    },
  }
}

/**
 * Close a person's sockets in the listed tenants (close code 4001). Call after the change has
 * committed: the database has already refused them, and a socket is the only thing still open.
 */
export function closeUserSockets(
  rt: Realtime | undefined,
  tenantIds: string | readonly string[],
  userId: string
): void {
  const hub = rt?.hub
  if (!rt || !hub) return
  for (const tenantId of typeof tenantIds === 'string' ? [tenantIds] : tenantIds) {
    rt.defer(() => hub.closeSockets({ tenantId, userId }))
  }
}

/** Close the sockets of one session, which may have connected to any of the person's tenants. */
export function closeSessionSockets(
  rt: Realtime | undefined,
  tenantIds: readonly string[],
  sessionId: string
): void {
  const hub = rt?.hub
  if (!rt || !hub) return
  for (const tenantId of tenantIds) {
    rt.defer(() => hub.closeSockets({ tenantId, sessionId }))
  }
}

/** Close every socket in a tenant (it was suspended). */
export function closeTenantSockets(rt: Realtime | undefined, tenantId: string): void {
  const hub = rt?.hub
  if (!rt || !hub) return
  rt.defer(() => hub.closeSockets({ tenantId }))
}

export function nudgeUsers(
  rt: Realtime | undefined,
  userIds: string[],
  event: RealtimeEvent
): void {
  const hub = rt?.hub
  if (!rt || !hub || userIds.length === 0) return
  rt.defer(() => hub.toUsers(event.tenantId, userIds, event))
}

/**
 * Every socket SUBSCRIBED to `topic` (`@rocketpod/shared/realtime` § Topics) — one row's viewers,
 * not the whole tenant. Build the topic with `tenantTopic(prefix, tenantId, id)`, which refuses an
 * unregistered kind. No-op without a hub.
 */
export function nudgeTopic(rt: Realtime | undefined, topic: string, event: RealtimeEvent): void {
  const hub = rt?.hub
  if (!rt || !hub) return
  rt.defer(() => hub.toTopic(topic, event))
}
