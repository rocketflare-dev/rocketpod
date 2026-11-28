// @vitest-isolate
// Spies on the global fetch (a fake authorization server), so it needs its own registry.
/**
 * The MCP server's second credential (Rocketpod kit only, `auth/mcp.ts`): a token from an OUTSIDE
 * authorization server, `MCP_AUTHORIZATION_SERVER`. A fake server publishes RFC 8414 metadata and
 * a JWKS and signs real access tokens with a jose key pair, so every check `jwtVerify` makes runs
 * for real — and the token then meets the same caller as the app's own (the organisation's switch,
 * the grant, the call log), which is what these cases prove.
 */
import { and, eq } from 'drizzle-orm'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMcpKeys } from '@/api/auth/mcp'
import { mcpGrants, mcpToolCalls, tenants, tenantUsers } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
  uniqueId,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { connectMcp, enableMcp, mcpClient, mcpPost, mcpTestEnv, toolJson } from '../helpers/mcp'
import { request } from '../helpers/request'

const db = setupTestDatabase()

const AS = 'https://access.example.test'
const BASE = 'http://localhost:3001/mcp'
const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
const LEGACY = { 'MCP-Protocol-Version': '2025-11-25' }
let privateKey: CryptoKey
let jwk: Record<string, unknown>

beforeAll(async () => {
  const pair = await generateKeyPair('ES256')
  privateKey = pair.privateKey
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }
})

beforeEach(() => {
  resetMcpKeys()
  const real = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === `${AS}/.well-known/oauth-authorization-server`) {
      return Response.json({ issuer: AS, jwks_uri: `${AS}/jwks.json` })
    }
    if (url === `${AS}/jwks.json`) return Response.json({ keys: [jwk] })
    return real(input, init)
  })
})

afterEach(() => vi.restoreAllMocks())

const outsideEnv = (overrides: Record<string, unknown> = {}) =>
  mcpTestEnv({ MCP_AUTHORIZATION_SERVER: AS, ...overrides })
const env = outsideEnv()

function token(
  claims: JWTPayload & { email?: string },
  opts: { aud?: string; iss?: string; iat?: number; typ?: string | null } = {}
) {
  const typ = opts.typ === undefined ? 'at+jwt' : opts.typ
  return new SignJWT({ client_id: 'claude', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', ...(typ === null ? {} : { typ }) })
    .setIssuer(opts.iss ?? AS)
    .setAudience(opts.aud ?? BASE)
    .setSubject(`person-${uniqueId()}`)
    .setIssuedAt(opts.iat)
    .setExpirationTime('1h')
    .sign(privateKey)
}

const bearer = (t: string) => ({ ...LEGACY, Authorization: `Bearer ${t}` })

/** A tenant with MCP on, and a member of it. */
async function memberWithMcp() {
  const tenant = await createTestTenant(db)
  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenant.id, 'owner')
  await enableMcp(db, tenant.id, owner.id)
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenant.id, 'member')
  return { tenant, owner, user }
}

describe('discovery', () => {
  it('lists the outside server first and the app’s own second', async () => {
    const res = await request('/.well-known/oauth-protected-resource/mcp', {}, { env })
    expect(await res.json()).toMatchObject({
      resource: BASE,
      authorization_servers: [AS, 'http://localhost:3001'],
    })
  })

  it('is still dark where the deployment does not ship mcp', async () => {
    const dark = outsideEnv({ FEATURES_ENABLED: '' })
    const res = await mcpPost(dark, '/mcp', LIST, bearer(await token({ email: 'a@b.test' })))
    expect(res.status).toBe(404)
  })
})

describe('the token', () => {
  it('refuses another audience or issuer, no email and an unverified one with the challenge', async () => {
    const { user } = await memberWithMcp()
    for (const t of [
      await token({ email: user.email }, { aud: 'https://other.example.test/mcp' }),
      await token({ email: user.email }, { iss: 'https://evil.example.test' }),
      await token({}),
      await token({ email: user.email, email_verified: false }),
    ]) {
      const res = await mcpPost(env, '/mcp', LIST, bearer(t))
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"')
    }
  })

  it('accepts the plain JWT access tokens Cognito and Entra issue, typ JWT or none', async () => {
    const { user } = await memberWithMcp()
    for (const t of [
      await token({ email: user.email, token_use: 'access' }, { typ: 'JWT' }),
      await token({ email: user.email }, { typ: null }),
      await token({ email: user.email }, { typ: 'application/at+jwt' }),
    ]) {
      expect((await mcpPost(env, '/mcp', LIST, bearer(t))).status).toBe(200)
    }
  })

  it('refuses an ID token, or another declared token type, even with the right audience', async () => {
    const { user } = await memberWithMcp()
    for (const t of [
      await token({ email: user.email, token_use: 'id' }, { typ: 'JWT' }),
      await token({ email: user.email }, { typ: 'logout+jwt' }),
    ]) {
      const res = await mcpPost(env, '/mcp', LIST, bearer(t))
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"')
    }
  })

  it('refuses a person sign-up would refuse', async () => {
    const t = await token({ email: `nobody-${uniqueId()}@example.test` })
    expect((await mcpPost(env, '/mcp', LIST, bearer(t))).status).toBe(401)
  })
})

describe('the shared caller', () => {
  it('serves a one-organisation member as a logged, listed connection of its own', async () => {
    const { tenant, user } = await memberWithMcp()
    const client = await mcpClient(env, await token({ email: user.email }))
    const result = await client.callTool({ name: 'list_documents', arguments: {} })
    await client.close()
    expect(result.isError).not.toBe(true)
    const [grant] = await db
      .select()
      .from(mcpGrants)
      .where(and(eq(mcpGrants.tenantId, tenant.id), eq(mcpGrants.userId, user.id)))
    expect(grant).toMatchObject({ clientId: `${AS}#claude`, resource: BASE })
    expect(grant?.activatedAt).not.toBeNull()
    const calls = await db
      .select()
      .from(mcpToolCalls)
      .where(eq(mcpToolCalls.grantId, grant?.id ?? ''))
    expect(calls.map(c => c.outcome)).toEqual(['ok'])
  })

  it('answers 403 mcp_disabled where the organisation has not turned MCP on', async () => {
    const tenant = await createTestTenant(db)
    const user = await createTestUser(db)
    await linkUserToTenant(db, user.id, tenant.id, 'owner')
    const res = await mcpPost(env, '/mcp', LIST, bearer(await token({ email: user.email })))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'mcp_disabled' })
  })

  it('makes a person of several organisations name one, and only one of theirs', async () => {
    const { tenant, user } = await memberWithMcp()
    const second = await memberWithMcp()
    await linkUserToTenant(db, user.id, second.tenant.id, 'member')
    const stranger = await memberWithMcp()
    const t = await token({ email: user.email })

    const unnamed = await mcpPost(env, '/mcp', LIST, bearer(t))
    expect(unnamed.status).toBe(403)
    expect(await unnamed.json()).toMatchObject({ code: 'mcp_tenant_required' })

    const foreign = await mcpPost(env, '/mcp', LIST, {
      ...bearer(t),
      'mcp-tenant': stranger.tenant.slug,
    })
    expect(foreign.status).toBe(403)
    expect(await foreign.json()).toMatchObject({ code: 'mcp_not_allowed' })

    const byHeader = await mcpPost(env, '/mcp', LIST, { ...bearer(t), 'mcp-tenant': tenant.id })
    expect(byHeader.status).toBe(200)
    // The organisation's own URL, with a token bound to the base resource.
    const byUrl = await mcpPost(env, `/mcp/t/${second.tenant.slug}`, LIST, bearer(t))
    expect(byUrl.status).toBe(200)
  })

  it("reads only the named organisation's documents", async () => {
    const { tenant, user } = await memberWithMcp()
    const other = await memberWithMcp()
    await linkUserToTenant(db, user.id, other.tenant.id, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, other.tenant.id))
    const title = `Other organisation's plan ${uniqueId()}`
    const ingested = await request(
      '/api/ai/documents/ingest',
      { method: 'POST', headers: cookie },
      { env, json: { title, text: 'Quarterly plan for the other organisation only.' } }
    )
    expect(ingested.status).toBe(201)
    const t = await token({ email: user.email })
    const listIn = async (slug: string) => {
      const client = await mcpClient(env, t, { headers: { 'mcp-tenant': slug } })
      const result = await client.callTool({ name: 'list_documents', arguments: {} })
      await client.close()
      return JSON.stringify(toolJson(result))
    }
    expect(await listIn(other.tenant.slug)).toContain(title)
    expect(await listIn(tenant.slug)).not.toContain(title)
  })

  it('keeps a revoked connection refused for the token in hand, and lets a newer token in', async () => {
    const { tenant, user } = await memberWithMcp()
    const before = Math.floor(Date.now() / 1000) - 60
    const old = await token({ email: user.email }, { iat: before })
    expect((await mcpPost(env, '/mcp', LIST, bearer(old))).status).toBe(200)
    await db
      .update(mcpGrants)
      .set({ revokedAt: new Date() })
      .where(and(eq(mcpGrants.tenantId, tenant.id), eq(mcpGrants.userId, user.id)))
    expect((await mcpPost(env, '/mcp', LIST, bearer(old))).status).toBe(401)
    const fresh = await token({ email: user.email }, { iat: Math.floor(Date.now() / 1000) + 5 })
    expect((await mcpPost(env, '/mcp', LIST, bearer(fresh))).status).toBe(200)
    const grants = await db
      .select()
      .from(mcpGrants)
      .where(and(eq(mcpGrants.tenantId, tenant.id), eq(mcpGrants.userId, user.id)))
    expect(grants).toHaveLength(2)
  })

  it('leaves the app’s own tokens working beside it', async () => {
    const { tenant, user } = await memberWithMcp()
    const conn = await connectMcp(db, env, { tenantId: tenant.id, userId: user.id })
    const client = await mcpClient(env, conn.accessToken)
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    await client.close()
  })
})

describe('IdP-managed tenancy', () => {
  it('admits and reconciles the person from the token’s orgs claim', async () => {
    const idp = outsideEnv({
      OIDC_ISSUER: 'https://idp.test',
      OIDC_CLIENT_ID: 'c',
      OIDC_CLIENT_SECRET: 's',
      OIDC_MANAGED_TENANCY: 'true',
    })
    const org = {
      id: `org-${uniqueId()}`,
      slug: `acme-${uniqueId().toLowerCase()}`,
      name: 'Acme',
      role: 'member',
    }
    const email = `new-${uniqueId().toLowerCase()}@acme.test`
    const res = await mcpPost(idp, '/mcp', LIST, bearer(await token({ email, orgs: [org] })))
    // The new organisation has not turned MCP on — but the person and the membership exist.
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'mcp_disabled' })
    const [row] = await db.select().from(tenants).where(eq(tenants.externalOrgId, org.id))
    expect(row).toBeDefined()
    const memberships = await db
      .select()
      .from(tenantUsers)
      .where(eq(tenantUsers.tenantId, row?.id ?? ''))
    expect(memberships).toHaveLength(1)
  })
})
