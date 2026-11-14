// @vitest-isolate
// Spies on the global fetch (a fake authorization server), so it needs its own registry.
/**
 * The remote MCP server (`routes/mcp.ts`, `auth/mcp.ts`): a fake authorization server publishes
 * RFC 8414 metadata and a JWKS, and signs real access tokens with a jose key pair, so every check
 * `jwtVerify` makes is exercised for real.
 */
import { eq } from 'drizzle-orm'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMcpKeys } from '@/api/auth/mcp'
import { tenants, tenantUsers } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestTenantWithUser,
  linkUserToTenant,
  sessionCookieHeader,
  uniqueId,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

const AS = 'https://access.example.test'
const RESOURCE = 'http://localhost:3001/mcp'
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

const mcpEnv = (overrides: Record<string, unknown> = {}) =>
  createTestEnv({ MCP_AUTHORIZATION_SERVER: AS, ...overrides })

function token(claims: JWTPayload & { email?: string }, opts: { aud?: string; iss?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'k1' })
    .setIssuer(opts.iss ?? AS)
    .setAudience(opts.aud ?? RESOURCE)
    .setSubject(`person-${uniqueId()}`)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
}

let rpcId = 0
function rpc(
  env: ReturnType<typeof createTestEnv>,
  bearer: string | undefined,
  method: string,
  params: object = {},
  headers: Record<string, string> = {}
) {
  return request(
    '/mcp',
    {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...headers,
      },
    },
    { env, json: { jsonrpc: '2.0', id: ++rpcId, method, params } }
  )
}

type ToolResult = { result: { content: { text: string }[]; isError?: boolean } }
const callTool = async (
  env: ReturnType<typeof createTestEnv>,
  bearer: string,
  name: string,
  args: object = {}
) => {
  const res = await rpc(env, bearer, 'tools/call', { name, arguments: args })
  expect(res.status).toBe(200)
  const body = await json<ToolResult>(res)
  return {
    isError: Boolean(body.result.isError),
    value: JSON.parse(body.result.content[0]?.text ?? 'null'),
  }
}

describe('/mcp', () => {
  it('is not there until an authorization server is configured', async () => {
    const env = createTestEnv()
    expect((await rpc(env, undefined, 'tools/list')).status).toBe(404)
    expect((await request('/.well-known/oauth-protected-resource/mcp', {}, { env })).status).toBe(
      404
    )
  })

  it('publishes its resource and authorization server', async () => {
    const res = await request('/.well-known/oauth-protected-resource/mcp', {}, { env: mcpEnv() })
    expect(await json(res)).toMatchObject({ resource: RESOURCE, authorization_servers: [AS] })
  })

  it('answers any origin, and lets the client read the challenge', async () => {
    const res = await request(
      '/mcp',
      {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:6274',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type, mcp-protocol-version',
        },
      },
      { env: mcpEnv() }
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const denied = await rpc(mcpEnv(), undefined, 'tools/list', {}, { origin: 'http://x.test' })
    expect(denied.headers.get('access-control-expose-headers')).toMatch(/www-authenticate/i)
  })

  it('401s without a token, pointing at the metadata', async () => {
    const res = await rpc(mcpEnv(), undefined, 'tools/list')
    expect(res.status).toBe(401)
    expect(await json(res)).toMatchObject({ statusCode: 401, code: 'unauthorized' })
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="http://localhost:3001/.well-known/oauth-protected-resource/mcp"'
    )
  })

  it('refuses a token for another resource, from another issuer or without an email', async () => {
    const { user } = await createTestTenantWithUser(db, 'member')
    for (const t of [
      await token({ email: user.email }, { aud: 'https://other.example.test/mcp' }),
      await token({ email: user.email }, { iss: 'https://evil.example.test' }),
      await token({}),
    ]) {
      const res = await rpc(mcpEnv(), t, 'tools/list')
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"')
    }
  })

  it("gives a person with one tenant the agents' tools in it", async () => {
    const { user } = await createTestTenantWithUser(db, 'member')
    const bearer = await token({ email: user.email })
    const list = await json<{
      result: { tools: { name: string; inputSchema: { required?: string[] } }[] }
    }>(await rpc(mcpEnv(), bearer, 'tools/list'))
    const names = list.result.tools.map(t => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['list_tenants', 'list_documents', 'get_document'])
    )
    expect(
      list.result.tools.find(t => t.name === 'list_documents')?.inputSchema.required ?? []
    ).not.toContain('tenant')
    const docs = await callTool(mcpEnv(), bearer, 'list_documents')
    expect(docs.isError).toBe(false)
  })

  it('makes a person with several tenants name one, and only one of theirs', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const second = await createTestTenant(db)
    await linkUserToTenant(db, user.id, second.id, 'admin')
    const stranger = await createTestTenant(db)
    const bearer = await token({ email: user.email })
    const env = mcpEnv()

    const tenantsListed = await callTool(env, bearer, 'list_tenants')
    expect(tenantsListed.value.map((t: { id: string }) => t.id).sort()).toEqual(
      [tenant.id, second.id].sort()
    )
    const unnamed = await callTool(env, bearer, 'list_documents')
    expect(unnamed).toMatchObject({ isError: true, value: { error: 'tenant_required' } })
    expect((await callTool(env, bearer, 'list_documents', { tenant: second.slug })).isError).toBe(
      false
    )
    const foreign = await callTool(env, bearer, 'list_documents', { tenant: stranger.slug })
    expect(foreign).toMatchObject({ isError: true, value: { error: 'tenant_required' } })
    // The header names the tenant for the whole connection.
    const viaHeader = await rpc(
      env,
      bearer,
      'tools/call',
      { name: 'list_documents', arguments: {} },
      { 'mcp-tenant': tenant.id }
    )
    expect((await json<ToolResult>(viaHeader)).result.isError).toBeFalsy()
  })

  it("reads only the named tenant's documents", async () => {
    const env = mcpEnv()
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const other = await createTestTenant(db)
    await linkUserToTenant(db, user.id, other.id, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, other.id))
    const title = `Other tenant's plan ${uniqueId()}`
    const ingested = await request(
      '/api/ai/documents/ingest',
      { method: 'POST', headers: cookie },
      { env, json: { title, text: 'Quarterly plan for the other tenant only.' } }
    )
    expect(ingested.status).toBe(201)
    const bearer = await token({ email: user.email })
    const inOther = await callTool(env, bearer, 'list_documents', { tenant: other.slug })
    expect(JSON.stringify(inOther.value)).toContain(title)
    const inFirst = await callTool(env, bearer, 'list_documents', { tenant: tenant.slug })
    expect(JSON.stringify(inFirst.value)).not.toContain(title)
  })

  it('refuses someone sign-up would refuse', async () => {
    const res = await rpc(
      mcpEnv(),
      await token({ email: `nobody-${uniqueId()}@example.test` }),
      'tools/list'
    )
    expect(res.status).toBe(401)
  })

  it('admits and reconciles a person from the orgs claim under IdP-managed tenancy', async () => {
    const env = mcpEnv({
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
    const listed = await callTool(env, await token({ email, orgs: [org] }), 'list_tenants')
    expect(listed.value).toEqual([expect.objectContaining({ name: 'Acme', role: 'member' })])
    const [row] = await db.select().from(tenants).where(eq(tenants.externalOrgId, org.id))
    expect(row).toBeDefined()
    const memberships = await db
      .select()
      .from(tenantUsers)
      .where(eq(tenantUsers.tenantId, row?.id ?? ''))
    expect(memberships).toHaveLength(1)
  })
})
