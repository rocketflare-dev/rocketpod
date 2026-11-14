/**
 * The remote MCP server's credential (docs/CONCEPTS.md §19): an OAuth access token from
 * `MCP_AUTHORIZATION_SERVER`, resolved to the SAME `AuthContext` a browser session of that person
 * would have. The kit is only the resource server: the authorization server signs the person in,
 * asks their consent and binds the token to this deployment's resource (`mcpResource(cfg)`, RFC
 * 8707); this checks it.
 *
 * - **The token.** A JWT (`typ: at+jwt`, ES256 or RS256) signed by a key in the server's JWKS
 *   (`jwks_uri` from its RFC 8414 metadata, cached; `jose` re-reads it for a `kid` it hasn't
 *   seen), with `iss` = the server, `aud` = the resource and a verified `email`. Anything else is
 *   `null`, which the route answers 401 with the `WWW-Authenticate` that leads a client to sign in.
 * - **The person** is admitted exactly as the OIDC callback admits them (`admitUser`), so
 *   `SIGNUP_MODE`, blocking and `BOOTSTRAP_ADMIN_EMAILS` mean the same thing here. Under
 *   `OIDC_MANAGED_TENANCY` the token's orgs claim is reconciled like an id_token's
 *   (`reconcileIdpClaims`) — once per token, not per call: a token no newer than the person's last
 *   reconcile changes nothing.
 * - **The tenant.** One membership → that one. Several → the call must name one (`tenant` argument
 *   or `mcp-tenant` header, by id, slug or the issuer's org id); naming none leaves `tenantId`
 *   null, and every tool but `list_tenants` refuses. Never picked silently.
 */
import type { McpTenant } from '@rocketpod/shared/mcp'
import type { MembershipRole } from '@rocketpod/shared/tenants'
import { and, eq, isNotNull, max } from 'drizzle-orm'
import { createRemoteJWKSet, customFetch, type JWTPayload, jwtVerify } from 'jose'
import { type AppConfig, isIdpManaged, mcpResource } from '../../config'
import type { Database } from '../../db/client'
import { tenants, tenantUsers, type User } from '../../db/schema'
import { buildAbility, resolveFeatures } from '../../permissions'
import { admitUser } from '../services/auth'
import { listFeatureFlagRows, platformFeatures } from '../services/features'
import { listUserGroups } from '../services/groups'
import {
  type IdpLogger,
  idpClaimsAdmit,
  readIdpClaims,
  reconcileIdpClaims,
} from '../services/idp-tenancy'
import type { Realtime } from '../services/realtime'
import type { AuthContext } from '../types'
import { ForbiddenError } from '../utils/core/errors'
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

export interface McpTokenClaims extends JWTPayload {
  email: string
}

/** The token's claims when it is a valid token for this resource from the server, else null. */
export async function verifyMcpToken(
  cfg: AppConfig,
  token: string,
  logger: Pick<Logger, 'warn'>,
  doFetch: typeof fetch = fetch
): Promise<McpTokenClaims | null> {
  const issuer = cfg.MCP_AUTHORIZATION_SERVER
  if (!issuer) return null
  let jwks: Jwks
  try {
    jwks = await jwksFor(issuer, doFetch)
  } catch (err) {
    logger.warn({ err, issuer }, 'MCP: could not read the authorization server keys')
    return null
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ['ES256', 'RS256'],
      typ: 'at+jwt',
      issuer,
      audience: mcpResource(cfg),
    })
    const email = payload.email
    if (typeof email !== 'string' || !email.includes('@')) return null
    // An issuer that says outright the address is unverified is not trusted for it.
    if (payload.email_verified === false) return null
    return { ...payload, email: email.toLowerCase() }
  } catch {
    return null
  }
}

/** The person's tenants, by name. */
export async function mcpTenantsOf(
  db: Database,
  userId: string
): Promise<Array<McpTenant & { externalOrgId: string | null; status: string }>> {
  const rows = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      role: tenantUsers.role,
      externalOrgId: tenants.externalOrgId,
      status: tenants.status,
    })
    .from(tenantUsers)
    .innerJoin(tenants, eq(tenants.id, tenantUsers.tenantId))
    .where(eq(tenantUsers.userId, userId))
    .orderBy(tenants.name)
  return rows.map(r => ({ ...r, role: String(r.role) }))
}

/** The newest `idp_synced_at` on the person's issuer-managed memberships. */
async function lastReconciledAt(db: Database, userId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: max(tenantUsers.idpSyncedAt) })
    .from(tenantUsers)
    .where(and(eq(tenantUsers.userId, userId), isNotNull(tenantUsers.idpSyncedAt)))
  return row?.at ?? null
}

export type McpPerson = { ok: true; user: User } | { ok: false; reason: string }

/** Admit the token's person (and reconcile their tenancy), as an OIDC sign-in would. */
export async function admitMcpPerson(
  db: Database,
  cfg: AppConfig,
  claims: McpTokenClaims,
  logger: Parameters<typeof admitUser>[3] & IdpLogger,
  ctx: { jobs: Parameters<typeof admitUser>[4]; realtime?: Realtime }
): Promise<McpPerson> {
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

/** The tenant a call names (id, slug or the issuer's org id), among the person's own. */
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

/**
 * The `AuthContext` of the person in one tenant (or none), built the way the Bearer path builds a
 * key's: memberships, groups and feature flags re-read on every call.
 */
export async function mcpAuthContext(
  db: Database,
  cfg: AppConfig,
  user: User,
  tenant: { id: string; name: string; slug: string; role: string; status: string } | null,
  sessionId: string
): Promise<AuthContext> {
  if (user.blockedAt) throw new ForbiddenError('Account is blocked', 'blocked')
  if (tenant?.status === 'suspended') {
    throw new ForbiddenError('Organisation is suspended', 'tenant_suspended')
  }
  const [groups, flagRows] = tenant
    ? await Promise.all([
        listUserGroups(db, tenant.id, user.id),
        listFeatureFlagRows(db, tenant.id),
      ])
    : [[], []]
  const features = await resolveFeatures(cfg, flagRows, {
    tenantId: tenant?.id ?? null,
    userId: user.id,
  })
  const role = (tenant?.role ?? null) as MembershipRole | null
  return {
    user,
    tenantId: tenant?.id ?? null,
    tenantUser: role ? { role } : null,
    tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : null,
    session: { id: sessionId },
    ability: buildAbility({ role, isGlobalAdmin: user.isGlobalAdmin, features }),
    isGlobalAdmin: user.isGlobalAdmin,
    features,
    groups,
    accessRequestStatus: null,
  }
}
