/**
 * The MCP server's SECOND credential (docs/CONCEPTS.md §19, Rocketpod only): a JWT access token
 * from an outside OAuth authorization server, `MCP_AUTHORIZATION_SERVER` (Cognito, Entra, Okta…).
 * The app's own authorization server (`services/mcp/authorization.ts`) is the first; both end in
 * the SAME caller (`services/mcp/caller.ts` `callerForGrant`), so membership, the block, the
 * tenant's status, the organisation's switch and connect policy, exposure, the three call limits
 * and the call log mean exactly the same thing whichever server signed the person in.
 *
 * What is particular to the outside server, and lives here:
 *
 * - **The token.** A JWT (`typ: at+jwt`, ES256 or RS256) signed by a key in the server's JWKS
 *   (`jwks_uri` from its RFC 8414 metadata, cached; `jose` re-reads it for a `kid` it hasn't seen),
 *   with `iss` = the server, `aud` = `<APP_URL>/mcp` (which covers every `/mcp/t/<slug>`) or the
 *   exact URL it is used on, and a verified `email`. Anything else is `null` → the 401 challenge.
 * - **The person** is admitted exactly as an OIDC sign-in admits them (`admitUser`), so
 *   `SIGNUP_MODE`, blocking and `BOOTSTRAP_ADMIN_EMAILS` hold here too, and under
 *   `OIDC_MANAGED_TENANCY` the token's orgs claim is reconciled like an id_token's — once per
 *   token, not per call. The SSO policy is checked by the route (`routes/mcp.ts`).
 * - **The organisation** is the URL's (`/mcp/t/<slug>`), else the `mcp-tenant` header (id, slug or
 *   the issuer's org id), else the person's only one. Several and none named is a 403
 *   `mcp_tenant_required` — never picked silently.
 * - **The connection** is an `mcp_grants` row per (person, organisation, issuer client, URL),
 *   made on first use (`outsideMcpGrant` in `services/mcp/tokens.ts`), so it is listed, counted,
 *   limited and revocable like any other.
 */
import { MCP_SCOPES, type McpScope } from '@rocketpod/shared/mcp'
import { and, eq, isNotNull, max } from 'drizzle-orm'
import { createRemoteJWKSet, customFetch, type JWTPayload, jwtVerify } from 'jose'
import { type AppConfig, isIdpManaged } from '../../config'
import type { Database } from '../../db/client'
import { tenants, tenantUsers, type User } from '../../db/schema'
import { admitUser } from '../services/auth'
import { platformFeatures } from '../services/features'
import {
  type IdpLogger,
  idpClaimsAdmit,
  readIdpClaims,
  reconcileIdpClaims,
} from '../services/idp-tenancy'
import { mcpResourceUrl } from '../services/mcp/tokens'
import type { Realtime } from '../services/realtime'
import type { Logger } from '../utils/core/logger'

const METADATA_TTL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5000

type Jwks = ReturnType<typeof createRemoteJWKSet>
const jwksByIssuer = new Map<string, { jwks: Jwks; at: number }>()

/** The server's key set, from its metadata's `jwks_uri` (re-read hourly, so a move is followed). */
async function jwksFor(issuer: string, doFetch: typeof fetch): Promise<Jwks> {
  const cached = jwksByIssuer.get(issuer)
  if (cached && Date.now() - cached.at < METADATA_TTL_MS) return cached.jwks
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`
  const res = await doFetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  const meta = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown }
  if (meta.issuer !== issuer || typeof meta.jwks_uri !== 'string') {
    throw new Error(`${url} names another issuer or no jwks_uri`)
  }
  const jwks = createRemoteJWKSet(new URL(meta.jwks_uri), {
    timeoutDuration: FETCH_TIMEOUT_MS,
    [customFetch]: doFetch,
  })
  jwksByIssuer.set(issuer, { jwks, at: Date.now() })
  return jwks
}

/** Tests: forget every cached key set. */
export function resetMcpKeys(): void {
  jwksByIssuer.clear()
}

export interface OutsideMcpToken extends JWTPayload {
  email: string
  /** When the server issued it — a grant revoked after this refuses it. */
  issuedAt: Date
  /** `<issuer>#<the token's client>` — the grant's `clientId`. */
  clientId: string
  /** The MCP scopes it carries; both when it names none (exposure still decides). */
  scopes: McpScope[]
}

/** The scopes a token's `scope` claim grants: the MCP ones it names, else both. */
export function outsideTokenScopes(scope: unknown): McpScope[] {
  const named =
    typeof scope === 'string'
      ? scope
          .split(/\s+/)
          .filter((s): s is McpScope => (MCP_SCOPES as readonly string[]).includes(s))
      : []
  return named.length > 0 ? [...new Set(named)] : [...MCP_SCOPES]
}

/**
 * The token's claims when it is a valid token from the outside server for `resource` (the URL
 * the request arrived on), else null.
 */
export async function verifyOutsideMcpToken(
  cfg: AppConfig,
  token: string,
  resource: string,
  logger: Pick<Logger, 'warn'>,
  doFetch: typeof fetch = fetch
): Promise<OutsideMcpToken | null> {
  const issuer = cfg.MCP_AUTHORIZATION_SERVER
  if (!issuer) return null
  let jwks: Jwks
  try {
    jwks = await jwksFor(issuer, doFetch)
  } catch (err) {
    logger.warn({ err, issuer }, 'MCP: could not read the outside authorization server keys')
    return null
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ['ES256', 'RS256'],
      typ: 'at+jwt',
      issuer,
      audience: [...new Set([mcpResourceUrl(cfg), resource])],
    })
    const email = payload.email
    if (typeof email !== 'string' || !email.includes('@')) return null
    // An issuer that says outright the address is unverified is not trusted for it.
    if (payload.email_verified === false) return null
    const client =
      typeof payload.client_id === 'string'
        ? payload.client_id
        : typeof payload.azp === 'string'
          ? payload.azp
          : 'token'
    return {
      ...payload,
      email: email.toLowerCase(),
      issuedAt: new Date((payload.iat ?? Math.floor(Date.now() / 1000)) * 1000),
      clientId: `${issuer}#${client}`,
      scopes: outsideTokenScopes(payload.scope),
    }
  } catch {
    return null
  }
}

/** The person's organisations, as the tenant choice needs them. */
export async function mcpTenantsOf(
  db: Database,
  userId: string
): Promise<Array<{ id: string; slug: string; externalOrgId: string | null }>> {
  return db
    .select({ id: tenants.id, slug: tenants.slug, externalOrgId: tenants.externalOrgId })
    .from(tenantUsers)
    .innerJoin(tenants, eq(tenants.id, tenantUsers.tenantId))
    .where(eq(tenantUsers.userId, userId))
    .orderBy(tenants.slug)
}

/** The organisation a request names (id, slug or the issuer's org id), among the person's own. */
export function pickTenant<T extends { id: string; slug: string; externalOrgId: string | null }>(
  mine: readonly T[],
  named: string | undefined
): { tenant: T | null; ambiguous: boolean; unknown: boolean } {
  if (named) {
    const tenant = mine.find(t => t.id === named || t.slug === named || t.externalOrgId === named)
    return { tenant: tenant ?? null, ambiguous: false, unknown: !tenant }
  }
  if (mine.length === 1) return { tenant: mine[0] ?? null, ambiguous: false, unknown: false }
  return { tenant: null, ambiguous: mine.length > 1, unknown: false }
}

/** The newest `idp_synced_at` on the person's issuer-managed memberships. */
async function lastReconciledAt(db: Database, userId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: max(tenantUsers.idpSyncedAt) })
    .from(tenantUsers)
    .where(and(eq(tenantUsers.userId, userId), isNotNull(tenantUsers.idpSyncedAt)))
  return row?.at ?? null
}

export type OutsideMcpPerson = { ok: true; user: User } | { ok: false; reason: string }

/** Admit the token's person (and reconcile their tenancy), as an OIDC sign-in would. */
export async function admitOutsideMcpPerson(
  db: Database,
  cfg: AppConfig,
  claims: OutsideMcpToken,
  logger: Parameters<typeof admitUser>[3] & IdpLogger,
  ctx: { jobs: Parameters<typeof admitUser>[4]; realtime?: Realtime }
): Promise<OutsideMcpPerson> {
  const idp = isIdpManaged(cfg) ? readIdpClaims(cfg, claims, logger) : null
  const admitted = await admitUser(
    db,
    cfg,
    {
      email: claims.email,
      name: typeof claims.name === 'string' ? claims.name : null,
      verified: true,
      admittedBy: idp && idpClaimsAdmit(idp) ? 'idp' : undefined,
      proof: 'kit',
    },
    logger,
    ctx.jobs
  )
  if (!admitted.ok) return { ok: false, reason: admitted.reason }
  let user = admitted.user
  if (idp) {
    const last = await lastReconciledAt(db, user.id)
    if (!last || last < idp.issuedAt) {
      const reconciled = await reconcileIdpClaims(
        db,
        user,
        idp,
        logger,
        await platformFeatures(db, cfg),
        ctx.realtime
      )
      user = reconciled.user
    }
  }
  return { ok: true, user }
}
