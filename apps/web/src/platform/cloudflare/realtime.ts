/**
 * `RealtimeHub` over the `NOTIFICATIONS_HUB` Durable Object namespace (D8): `idFromName(tenantId)`
 * → the tenant's hub → typed RPC for sends, and the `/ws` upgrade forwarded with the identity in
 * `X-*` headers, which the DO trusts because it is reachable solely through the binding.
 */
import type { NotificationsHub } from '../../api/durable-objects/notifications-hub'
import type { RealtimeHub } from '../types'
import { HUB_HEADERS } from './hub-headers'

export function createDurableObjectHub(
  namespace: DurableObjectNamespace<NotificationsHub>
): RealtimeHub {
  const stub = (tenantId: string) => namespace.get(namespace.idFromName(tenantId))
  return {
    toTenant: (tenantId, event) => stub(tenantId).broadcast(event),
    toUser: (tenantId, userId, event) => stub(tenantId).broadcastToUser(userId, event),
    toUsers: (tenantId, userIds, event) => stub(tenantId).broadcastToUsers(userIds, event),
    accept: (request, member) =>
      stub(member.tenantId).fetch(
        new Request(request.url, {
          headers: {
            Upgrade: 'websocket',
            [HUB_HEADERS.tenantId]: member.tenantId,
            [HUB_HEADERS.userId]: member.userId,
            [HUB_HEADERS.sessionId]: member.sessionId,
          },
        })
      ),
  }
}
