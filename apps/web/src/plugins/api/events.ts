/**
 * Realtime nudges, notifications and activity (D8, D31).
 *
 * **"DB is the truth, WebSocket is a nudge."** Everything here sends an id and a family root, never
 * a payload: the client re-queries. A nudge carrying the row would broadcast one member's data to
 * every socket in the tenant, because the hub fans out per TENANT while row visibility is per row.
 *
 * The one convention worth learning before writing a nudge: **the `entity` string of an
 * `entity.changed` nudge IS a TanStack query-key family root.** Declare it once — the server's
 * nudge and the UI's `queryKeys` root are the same constant — and `invalidationsFor()` wires the
 * socket up with no hook-side code at all. A plugin's roots start with `<id>:`, so one plugin's
 * invalidation can never reach another's cache.
 */

import { recordActivity } from '../../api/services/activity'
import { notify, notifyMany } from '../../api/services/notifications'
import type { Realtime } from '../../api/services/realtime'
import {
  nudge,
  nudgeTopic,
  nudgeUser,
  nudgeUsers,
  realtimeEvent,
} from '../../api/services/realtime'

export type { ActivityInput } from '../../api/services/activity'
export type { NotifyInput } from '../../api/services/notifications'
export type { Realtime } from '../../api/services/realtime'

/**
 * Nudge every socket in one tenant that a family of rows moved.
 *
 * `entity` is the query-key family root, `id` the row if there is one. Prefer `ctx.nudge(...)` on a
 * context, which fills the tenant in; this is the form a plugin's own service function takes when
 * it is called from several contexts.
 */
export function nudgeEntity(
  realtime: Realtime | undefined,
  tenantId: string,
  entity: string,
  id?: string
): void {
  nudge(realtime, realtimeEvent('entity.changed', tenantId, { entity, ...(id && { id }) }))
}

/**
 * Nudge the sockets SUBSCRIBED to one topic that a family of rows moved — the viewers of one row,
 * not the whole tenant. `topic` is `tenantTopic('<id>.<kind>', tenantId, rowId)` from
 * `@rocketpod/shared/realtime`, over a kind the plugin declared in `SharedPlugin.realtimeTopics`
 * (an undeclared one throws there). The UI side is `useRealtimeTopic(topic)`.
 */
export function nudgeEntityTopic(
  realtime: Realtime | undefined,
  tenantId: string,
  topic: string,
  entity: string,
  id?: string
): void {
  nudgeTopic(
    realtime,
    topic,
    realtimeEvent('entity.changed', tenantId, { entity, ...(id && { id }) })
  )
}

/**
 * Write a notification (and nudge the recipient's bell). Post-commit, like every nudge: a
 * notification about a row nobody can read yet is worse than a late one.
 */
/**
 * Append to the tenant's audit log. Fire it through `ctx.defer(...)` from a route — it is a side
 * effect that must never fail the response — and `await` it everywhere else.
 */
export {
  notify,
  notifyMany,
  nudge,
  nudgeTopic,
  nudgeUser,
  nudgeUsers,
  realtimeEvent,
  recordActivity,
}
