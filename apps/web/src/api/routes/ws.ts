/**
 * `GET /ws?tenantId=` — WebSocket upgrade (D8, D12). Mounted WITHOUT `authMiddleware` (a browser
 * cannot set headers on an upgrade) so the route resolves the cookie itself with the same helper
 * the middleware uses: cookie → session → `resolveCookieAuth` (blocked / suspended → 403), then a
 * `tenant_users` membership check for the REQUESTED tenant (`?tenantId`, else the session's) — a
 * client-sent tenant id is never trusted without a matching row. Only then is the upgrade handed
 * to the platform's realtime hub (`accept`, `src/node/realtime.ts`), which trusts the identity it
 * is given — it is reachable only from this route, inside the upgrade's request scope.
 *
 * A non-upgrade GET gets a JSON 426 envelope; CSRF needs no exemption (GET is a safe method).
 */
import { ERROR_CODES } from '@rocketpod/shared/errors'
import { and, eq } from 'drizzle-orm'
import { tenants, tenantUsers } from '../../db/schema'
import { resolveCookieAuth } from '../middleware/auth'
import {
  ApiError,
  ForbiddenError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../utils/core/errors'
import { createRouter } from '../utils/routes/router'

export const wsRouter = createRouter()

export const UPGRADE_REQUIRED_CODE = 'upgrade_required'

wsRouter.get('/', async c => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    throw new ApiError(426, 'Expected a WebSocket upgrade', UPGRADE_REQUIRED_CODE)
  }

  const auth = await resolveCookieAuth(c)
  if (!auth) throw new UnauthorizedError('Authentication required')

  const requested = c.req.query('tenantId') || auth.tenantId
  if (!requested) throw new ForbiddenError('No organisation selected', ERROR_CODES.noTenant)

  const db = c.get('db')
  const [membership] = await db
    .select({ tenantId: tenantUsers.tenantId, status: tenants.status })
    .from(tenantUsers)
    .innerJoin(tenants, eq(tenants.id, tenantUsers.tenantId))
    .where(and(eq(tenantUsers.userId, auth.user.id), eq(tenantUsers.tenantId, requested)))
    .limit(1)
  if (!membership) throw new ForbiddenError('Not a member of this organisation')
  if (membership.status === 'suspended') {
    throw new ForbiddenError('Organisation is suspended', ERROR_CODES.tenantSuspended)
  }

  const hub = c.get('platform').realtime
  if (!hub) {
    throw new ServiceUnavailableError('Realtime is not configured', 'realtime_not_configured')
  }
  return hub.accept(c.req.raw, {
    tenantId: membership.tenantId,
    userId: auth.user.id,
    sessionId: auth.session.id,
  })
})
