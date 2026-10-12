/**
 * Realtime nudges (D7, D8): the ONLY module that sends to the platform's realtime hub. Routes and
 * services call `nudge*()` with the request's `Realtime` (`{ defer, hub }` from `withAuth`), which
 * builds the event and hands the send to `defer` — never awaited on the response path, never
 * allowed to fail the request. "DB is the truth, WebSocket is a nudge."
 *
 * `Broadcaster` (`src/platform/types.ts`) is the seam; the Worker's implementation is the
 * per-tenant Durable Object (`src/platform/cloudflare/realtime.ts`).
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

export function nudgeUsers(
  rt: Realtime | undefined,
  userIds: string[],
  event: RealtimeEvent
): void {
  const hub = rt?.hub
  if (!rt || !hub || userIds.length === 0) return
  rt.defer(() => hub.toUsers(event.tenantId, userIds, event))
}
