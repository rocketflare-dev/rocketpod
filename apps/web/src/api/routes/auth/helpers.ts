/**
 * Shared login-completion plumbing for every `/auth/*` flow: mint the session for the
 * user's default tenant, set the cookie, and validate redirect targets (same-origin paths only —
 * the open-redirect guard). Error redirects land on `/login?error=<code>`.
 */
import { redirectToSchema } from '@rocketpod/shared/auth'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { User } from '../../../db/schema'
import { SESSION_TTL_MS, setSessionCookie } from '../../auth/cookies'
import { createSession } from '../../auth/sessions'
import { defaultTenantFor } from '../../services/auth'
import type { AppContext } from '../../types'
import { clientIpOf } from '../../utils/routes/client-ip'

export type LoginErrorCode =
  | 'invalid_token'
  | 'expired'
  | 'not_invited'
  | 'blocked'
  | 'email_unverified'
  | 'oauth_failed'
  | 'oauth_state_mismatch'
  | 'provider_linked_elsewhere'
  | 'oidc_only'
  /** The issuer refused to mint tokens for this person (Labs Access: no grant for this app). */
  | 'no_access'

/** A relative same-origin path, else `fallback`. Never `/login` (redirect loop). */
export function safeRedirectPath(value: string | null | undefined, fallback = '/'): string {
  if (!value) return fallback
  const parsed = redirectToSchema.safeParse(value)
  if (!parsed.success) return fallback
  if (parsed.data === '/login' || parsed.data.startsWith('/login?')) return fallback
  return parsed.data
}

export function loginErrorRedirect(c: AppContext, code: LoginErrorCode): Response {
  return c.redirect(`/login?error=${code}`, 302)
}

export { clientIpOf }

/**
 * Session for the user's oldest membership (or none), cookie set. Returns the session id.
 * `ttlMs` gives the session a sliding window other than the kit's 30 days (the `labs` preset's 7);
 * the cookie then keeps the kit's 30-day life, so the ROW — renewed on use — decides when an idle
 * session ends.
 */
export async function completeLogin(
  c: AppContext,
  db: Database,
  _cfg: AppConfig,
  user: User,
  selectedTenantId?: string | null,
  options: { ttlMs?: number } = {}
): Promise<{ sessionId: string; tenantId: string | null; token: string }> {
  const tenantId = selectedTenantId ?? (await defaultTenantFor(db, user.id))
  const session = await createSession(db, {
    userId: user.id,
    selectedTenantId: tenantId,
    ip: clientIpOf(c),
    userAgent: c.req.header('user-agent') ?? null,
    ttlMs: options.ttlMs,
  })
  const cookieExpires =
    options.ttlMs === undefined ? session.expiresAt : new Date(Date.now() + SESSION_TTL_MS)
  setSessionCookie(c, session.token, cookieExpires)
  return { sessionId: session.id, tenantId, token: session.token }
}
