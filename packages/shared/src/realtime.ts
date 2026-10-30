/**
 * Realtime event contracts. "DB is the truth, WebSocket is a nudge": an event names WHAT
 * changed (its `type`, optionally an `entity.changed` payload `{ entity, id }`) and the client
 * re-queries — it never treats a payload as state. `REALTIME_INVALIDATIONS` maps each event type
 * to the TanStack query-key ROOTS the UI invalidates (the `queryKeys.<family>.all` prefixes in
 * `apps/web/src/ui/lib/query-keys.ts`); the server emits, the UI reacts, both through this file.
 */
import { z } from 'zod'
import { sharedPlugins } from './plugins/index'
import type { RealtimeTopicDefinition, SharedPlugin } from './plugins/types'

export type { RealtimeTopicDefinition } from './plugins/types'

export const realtimeEventTypeSchema = z.enum([
  'notification.created',
  'notification.read',
  'member.changed',
  'invitation.changed',
  'tenant.changed',
  /** This person's group membership changed — what they may READ has moved under them. */
  'access.changed',
  /** A feature flag moved for this tenant — what EXISTS for them has changed. */
  'features.changed',
  'entity.changed',
  'ping',
])
export type RealtimeEventType = z.infer<typeof realtimeEventTypeSchema>

/** Generic nudge: `entity` is a query-key root (`'members'`, `'activity'`…), `id` narrows it. */
export const entityChangedPayloadSchema = z.object({
  entity: z.string().min(1),
  id: z.string().optional(),
})
export type EntityChangedPayload = z.infer<typeof entityChangedPayloadSchema>

/** What travels over the socket, `JSON.stringify`-ed. `at` is an ISO timestamp set by the emitter. */
export const realtimeEventSchema = z.object({
  type: realtimeEventTypeSchema,
  tenantId: z.string(),
  at: z.string().datetime(),
  payload: z.unknown().optional(),
})
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>

/**
 * Event type → query-key roots to invalidate. Roots are the first element(s) of the families in
 * `queryKeys`; `entity.changed` is resolved from its payload at runtime and `ping` invalidates
 * nothing. A ui test asserts every root here is a real `queryKeys` family.
 */
const CORE_REALTIME_INVALIDATIONS: Record<RealtimeEventType, string[][]> = {
  'notification.created': [['notifications']],
  'notification.read': [['notifications']],
  'member.changed': [['members']],
  'invitation.changed': [['invitations'], ['pending-invitations']],
  'tenant.changed': [['tenant'], ['tenants'], ['auth']],
  // Sent to the affected people only (`nudgeUsers`): their ability to see content changed, so the
  // session (which carries their groups), both visibility-bearing resources and the groups view
  // are all stale at once.
  'access.changed': [['auth'], ['documents'], ['groups']],
  // Features ride the session, so the session is what has to be re-fetched; `features` covers the
  // read-only list the CLI and the debugging surface use.
  'features.changed': [['auth'], ['features']],
  'entity.changed': [],
  ping: [],
}

/**
 * The same map with every installed plugin's `realtimeRoots` added to `access.changed`.
 *
 * Only that event: a plugin whose rows carry `visibility` has to be re-fetched when somebody's
 * group membership moves under them, or they keep looking at content they can no longer open.
 * Everything else a plugin needs is an `entity.changed` nudge naming its own query-key root, which
 * needs no registration at all.
 */
export const REALTIME_INVALIDATIONS: Record<RealtimeEventType, string[][]> = {
  ...CORE_REALTIME_INVALIDATIONS,
  'access.changed': [
    ...CORE_REALTIME_INVALIDATIONS['access.changed'],
    ...sharedPlugins.flatMap(p => (p.realtimeRoots ?? []).map(root => [root])),
  ],
}

/** The query-key roots an event should invalidate, including the `entity.changed` payload root. */
export function invalidationsFor(event: RealtimeEvent): string[][] {
  if (event.type === 'entity.changed') {
    const parsed = entityChangedPayloadSchema.safeParse(event.payload)
    return parsed.success ? [[parsed.data.entity]] : []
  }
  return REALTIME_INVALIDATIONS[event.type]
}

// ---- Topics -------------------------------------------------------------------------------------

/**
 * A TOPIC is a channel a socket subscribes to by NAME — one row's live progress — instead of the
 * tenant-wide fan-out every other nudge rides. The socket sends `{ type: 'subscribe', topic }`
 * (again after every reconnect, `websocketClient.subscribe`) and the hub delivers
 * `toTopic(topic, event)` to the sockets subscribed to it. Who may subscribe is decided by the hub,
 * from the identity `/ws` authenticated: `canSubscribeTopic`.
 *
 * The KINDS of topic are a registry: core's (`CORE_REALTIME_TOPICS`, none today) plus every
 * installed plugin's `SharedPlugin.realtimeTopics`. A topic whose prefix is not registered — an
 * uninstalled plugin's, a typo — parses as nothing and is refused. Topics are nudges like
 * everything else here: the event says what moved, the client re-queries.
 *
 * - `tenant` (default): `<prefix>:<tenantId>:<id>` — the socket's own tenant only, and its role
 *   must `read` the entry's subject.
 * - `platform`: `<prefix>:<id>` — state no tenant owns; a global admin who may `read` the subject.
 */
const TOPIC_PREFIX_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/
const TOPIC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Longer than any topic the grammar above can build; a frame naming more is not one. */
export const REALTIME_TOPIC_MAX_LENGTH = 256
/** The namespace core keeps for itself; no topic kind may live in it. */
const RESERVED_NAMESPACE = 'kit'

/** Core's own topic kinds. Empty: no core page needs more than the tenant-wide nudge yet. */
export const CORE_REALTIME_TOPICS: readonly RealtimeTopicDefinition[] = []

/** The registry: prefix → its definition. Built by `buildRealtimeTopicRegistry`. */
export type RealtimeTopicRegistry = ReadonlyMap<string, RealtimeTopicDefinition>

/**
 * Core's topics plus each plugin's, refusing — at module evaluation, so a bad declaration fails
 * every test rather than one subscription — a prefix that is malformed, a plugin prefix outside
 * its own id's namespace (`<id>` or `<id>.<name>`), anything in the reserved `kit` namespace, a
 * kind with no subject, and a prefix declared twice.
 */
export function buildRealtimeTopicRegistry(
  plugins: readonly Pick<SharedPlugin, 'id' | 'realtimeTopics'>[],
  core: readonly RealtimeTopicDefinition[] = CORE_REALTIME_TOPICS
): RealtimeTopicRegistry {
  const registry = new Map<string, RealtimeTopicDefinition>()
  const add = (owner: string | null, def: RealtimeTopicDefinition) => {
    const where = owner ? `plugin ${owner}` : 'core'
    if (!TOPIC_PREFIX_RE.test(def.prefix)) {
      throw new Error(`realtime topics: ${where} declares a malformed prefix ${def.prefix}`)
    }
    if (def.prefix.split('.')[0] === RESERVED_NAMESPACE) {
      throw new Error(`realtime topics: ${where} uses the reserved kit namespace (${def.prefix})`)
    }
    if (owner && def.prefix !== owner && !def.prefix.startsWith(`${owner}.`)) {
      throw new Error(
        `realtime topics: plugin ${owner} declares ${def.prefix}, outside its namespace (${owner}.*)`
      )
    }
    if (!def.subject) throw new Error(`realtime topics: ${def.prefix} names no subject`)
    if (registry.has(def.prefix)) {
      throw new Error(`realtime topics: ${def.prefix} is declared twice (${where})`)
    }
    registry.set(def.prefix, def)
  }
  for (const def of core) add(null, def)
  for (const plugin of plugins) for (const def of plugin.realtimeTopics ?? []) add(plugin.id, def)
  return registry
}

/** Every topic kind this deployment knows: core + the installed plugins. */
export const REALTIME_TOPICS: RealtimeTopicRegistry = buildRealtimeTopicRegistry(sharedPlugins)

/** The CASL subjects any registered topic needs — what `/ws` asks the member's ability about. */
export function realtimeTopicSubjects(registry: RealtimeTopicRegistry = REALTIME_TOPICS): string[] {
  return [...new Set([...registry.values()].map(def => def.subject))]
}

export interface ParsedRealtimeTopic {
  definition: RealtimeTopicDefinition
  /** The tenant a `tenant` topic belongs to; absent on a `platform` one. */
  tenantId?: string
  id: string
}

/** A topic string → its registered kind and parts, or null for anything the registry does not know. */
export function parseRealtimeTopic(
  topic: string,
  registry: RealtimeTopicRegistry = REALTIME_TOPICS
): ParsedRealtimeTopic | null {
  if (topic.length > REALTIME_TOPIC_MAX_LENGTH) return null
  const parts = topic.split(':')
  const definition = registry.get(parts[0] ?? '')
  if (!definition) return null
  if (definition.scope === 'platform') {
    const [, id] = parts
    if (parts.length !== 2 || !id || !TOPIC_ID_RE.test(id)) return null
    return { definition, id }
  }
  const [, tenantId, id] = parts
  if (parts.length !== 3 || !tenantId || !UUID_RE.test(tenantId)) return null
  if (!id || !TOPIC_ID_RE.test(id)) return null
  return { definition, tenantId, id }
}

/**
 * The topic of one row of a registered TENANT kind. A typo, or an uninstalled plugin's prefix,
 * throws here at the publisher rather than publishing to nobody.
 */
export function tenantTopic(
  prefix: string,
  tenantId: string,
  id: string,
  registry: RealtimeTopicRegistry = REALTIME_TOPICS
): string {
  const topic = `${prefix}:${tenantId}:${id}`
  const parsed = parseRealtimeTopic(topic, registry)
  if (!parsed || parsed.definition.scope === 'platform') {
    throw new Error(`realtime topics: ${topic} is not a registered tenant topic`)
  }
  return topic
}

/** The topic of one row of a registered PLATFORM kind (state no tenant owns). */
export function platformTopic(
  prefix: string,
  id: string,
  registry: RealtimeTopicRegistry = REALTIME_TOPICS
): string {
  const topic = `${prefix}:${id}`
  if (parseRealtimeTopic(topic, registry)?.definition.scope !== 'platform') {
    throw new Error(`realtime topics: ${topic} is not a registered platform topic`)
  }
  return topic
}

/**
 * What a socket may SEND: the keepalive, and (un)subscribing a topic. The topic is only a bounded
 * string here: whether it is one this member may hear is `canSubscribeTopic`'s answer, and
 * unsubscribing anything is harmless.
 */
export const realtimeClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('subscribe'), topic: z.string().max(REALTIME_TOPIC_MAX_LENGTH) }),
  z.object({ type: z.literal('unsubscribe'), topic: z.string().max(REALTIME_TOPIC_MAX_LENGTH) }),
])
export type RealtimeClientMessage = z.infer<typeof realtimeClientMessageSchema>

/** What the hub knows about a socket — decided by `/ws`, which authenticated it. */
export interface TopicSubscriber {
  /** The tenant the socket connected for (a verified membership). */
  tenantId: string
  globalAdmin?: boolean
  /** The topic subjects this member's role may `read` in that tenant (`/ws` asks the ability). */
  canRead?: readonly string[]
}

/**
 * May this socket hear `topic`? A tenant topic: it names the socket's OWN tenant and the member
 * may `read` the kind's subject. A platform topic: a global admin who may `read` it. Anything the
 * registry does not know — an uninstalled plugin's prefix included — is refused. An id the tenant
 * does not hold is harmless: nothing is ever published on it.
 */
export function canSubscribeTopic(
  member: TopicSubscriber,
  topic: string,
  registry: RealtimeTopicRegistry = REALTIME_TOPICS
): boolean {
  const parsed = parseRealtimeTopic(topic, registry)
  if (!parsed) return false
  if (member.canRead?.includes(parsed.definition.subject) !== true) return false
  if (parsed.definition.scope === 'platform') return member.globalAdmin === true
  return parsed.tenantId === member.tenantId
}
