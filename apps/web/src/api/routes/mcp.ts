/**
 * The remote MCP server (docs/CONCEPTS.md §19): `POST /mcp`, Streamable HTTP, STATELESS — one
 * `Server` per request, JSON responses, no sessions or SSE stream, so any replica answers any call.
 * And its RFC 9728 protected-resource metadata, which is how an MCP client finds the
 * authorization server. All of it answers 404 until `MCP_AUTHORIZATION_SERVER` is set.
 *
 * Credential: `Authorization: Bearer <access token>` from that server (`auth/mcp.ts`), never the
 * session cookie or an API key. A request without a valid one is a 401 whose `WWW-Authenticate`
 * names the metadata. The person is resolved to the same `AuthContext` a browser session would
 * give them, then:
 *
 * - **The tools are the agents' tools.** `buildAgentTools` — the knowledge tools and every installed
 *   plugin's `agentTools` — built from this call's own access scope and CASL grant, exactly as chat
 *   builds them, so an MCP client reads what its person may read and nothing more. A tool gated on
 *   approval (`requiresApproval`, `requiresApprovalWhen`) is left out: here there is no run to
 *   pause and nobody to ask. Plus `list_tenants`, which needs no tenant.
 * - **One tenant per call.** Every tool takes an optional `tenant` (required when the person has
 *   several); the `mcp-tenant` header is the same thing for a whole connection. Listing with
 *   several tenants and none named shows the union of their tools.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { ERROR_CODES } from '@rocketpod/shared/errors'
import {
  MCP_TENANT_ARGUMENT,
  MCP_TENANT_HEADER,
  PROTECTED_RESOURCE_PATHS,
  type ProtectedResourceMetadata,
} from '@rocketpod/shared/mcp'
import { type AppConfig, hasMcp, mcpResource } from '../../config'
import type { Database } from '../../db/client'
import type { User } from '../../db/schema'
import {
  admitMcpPerson,
  mcpAuthContext,
  mcpTenantsOf,
  pickTenant,
  verifyMcpToken,
} from '../auth/mcp'
import { ssoAllows } from '../auth/sso-policy'
import { accessScopeOf } from '../services/access'
import { buildAgentTools } from '../services/agents/tools'
import { type Tool, toolInputSchema } from '../services/ai/agent-loop'
import type { AppContext } from '../types'
import { NotFoundError, UnauthorizedError } from '../utils/core/errors'
import { makeDefer } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { ssoDecisionFor } from './auth/sso'

/** One `get_document` window over MCP: more than chat's, since a client pages it itself. */
export const MCP_GET_DOCUMENT_MAX_CHARS = 20_000

export const mcpRouter = createRouter()

const metadataUrl = (cfg: AppConfig) =>
  `${new URL(cfg.APP_URL).origin}${PROTECTED_RESOURCE_PATHS[1]}`

function requireMcp(c: AppContext): AppConfig {
  const cfg = c.get('config')
  if (!hasMcp(cfg)) throw new NotFoundError('Not found')
  return cfg
}

/** 401 that tells an MCP client where to sign in (RFC 6750 §3, RFC 9728 §5.1). */
function challenge(c: AppContext, cfg: AppConfig, error?: string): never {
  const parts = [`resource_metadata="${metadataUrl(cfg)}"`]
  if (error) parts.push(`error="invalid_token"`, `error_description="${error}"`)
  c.header('WWW-Authenticate', `Bearer ${parts.join(', ')}`)
  throw new UnauthorizedError(error ?? 'An access token is required', ERROR_CODES.unauthorized)
}

for (const path of PROTECTED_RESOURCE_PATHS) {
  mcpRouter.get(path, c => {
    const cfg = requireMcp(c)
    c.header('Cache-Control', 'public, max-age=300')
    const body: ProtectedResourceMetadata = {
      resource: mcpResource(cfg),
      // biome-ignore lint/style/noNonNullAssertion: requireMcp proved it is set
      authorization_servers: [cfg.MCP_AUTHORIZATION_SERVER!],
      bearer_methods_supported: ['header'],
      resource_name: cfg.APP_NAME,
    }
    return c.json(body)
  })
}

const tenantProperty = (required: boolean) => ({
  type: 'string',
  description: required
    ? 'Which of your tenants to act in: its id or slug (list_tenants lists them). Required: you belong to several.'
    : 'Which of your tenants to act in: its id or slug (list_tenants lists them).',
})

/** A tool's JSON Schema with the `tenant` argument added. */
function withTenant(tool: Tool, required: boolean) {
  const schema = toolInputSchema(tool.schema) as {
    properties?: Record<string, unknown>
    required?: string[]
  }
  return {
    ...schema,
    type: 'object' as const,
    properties: { ...schema.properties, [MCP_TENANT_ARGUMENT]: tenantProperty(required) },
    ...(required || schema.required
      ? { required: [...(schema.required ?? []), ...(required ? [MCP_TENANT_ARGUMENT] : [])] }
      : {}),
  }
}

const offered = (tools: Tool[]) =>
  tools.filter(t => t.handler && !t.requiresApproval && !t.requiresApprovalWhen)

const text = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
})

mcpRouter.all('/mcp', async c => {
  const cfg = requireMcp(c)
  const db = c.get('db') as Database
  const logger = c.get('logger')
  const platform = c.get('platform')

  const header = c.req.header('authorization')
  const token = header ? /^Bearer\s+(\S+)$/i.exec(header)?.[1] : undefined
  if (!token) challenge(c, cfg)
  const claims = await verifyMcpToken(cfg, token, logger)
  if (!claims) challenge(c, cfg, 'The access token is invalid or expired')
  // A sign-in path like any other: an organisation that requires its own single sign-on for this
  // address is not bypassed by the authorization server's word.
  const sso = await ssoDecisionFor(db, cfg, [claims.email], logger)
  if (!ssoAllows(sso, 'core')) challenge(c, cfg, 'This account must sign in with single sign-on')
  const person = await admitMcpPerson(db, cfg, claims, logger, {
    jobs: platform.jobs,
    realtime: { defer: makeDefer(c), hub: platform.realtime },
  })
  if (!person.ok) challenge(c, cfg, `This account may not use the app (${person.reason})`)
  const user: User = person.user
  const mine = await mcpTenantsOf(db, user.id)
  const sessionId = `mcp:${String(claims.connection_id ?? claims.jti ?? 'token')}`

  if (c.req.method !== 'POST') {
    // Stateless: no standalone SSE stream (GET) and no session to end (DELETE).
    c.header('Allow', 'POST')
    return c.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null },
      405
    )
  }

  /** The tools as this person sees them in one tenant. */
  const toolsIn = async (tenant: (typeof mine)[number]) => {
    const auth = await mcpAuthContext(db, cfg, user, tenant, sessionId)
    return offered(
      await buildAgentTools({
        db,
        cfg,
        env: platform,
        scope: accessScopeOf(auth),
        can: (action, subject) => auth.ability.can(action, subject),
        maxDocumentChars: MCP_GET_DOCUMENT_MAX_CHARS,
      })
    )
  }
  const headerTenant = c.req.header(MCP_TENANT_HEADER)?.trim() || undefined
  const several = mine.length > 1

  const listTenants = {
    name: 'list_tenants',
    description:
      'The tenants (organisations) you belong to in this app, with your role in each. Pass one as `tenant` to the other tools.',
    inputSchema: { type: 'object' as const, properties: {} },
    annotations: { readOnlyHint: true },
  }

  const server = new Server(
    { name: cfg.APP_NAME, version: cfg.RELEASE_VERSION },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tenant } = pickTenant(mine, headerTenant)
    const sources = tenant ? [tenant] : mine
    const byName = new Map<string, Tool>()
    for (const t of sources) for (const tool of await toolsIn(t)) byName.set(tool.name, tool)
    const required = !tenant && several
    return {
      tools: [
        listTenants,
        ...[...byName.values()].map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: withTenant(tool, required),
        })),
      ],
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const { name } = req.params
    const { [MCP_TENANT_ARGUMENT]: named, ...args } = (req.params.arguments ?? {}) as Record<
      string,
      unknown
    >
    if (name === listTenants.name) {
      return text(
        mine.map(({ id, slug, name: tenantName, role }) => ({ id, slug, name: tenantName, role }))
      )
    }
    const pick = pickTenant(mine, typeof named === 'string' && named ? named : headerTenant)
    if (!pick.tenant) {
      const hint = pick.unknown
        ? 'That is not one of your tenants.'
        : pick.ambiguous
          ? `You belong to several tenants: pass \`${MCP_TENANT_ARGUMENT}\`.`
          : 'You belong to no tenant in this app yet.'
      return text({ error: 'tenant_required', hint, tenants: mine.map(t => t.slug) }, true)
    }
    const tool = (await toolsIn(pick.tenant)).find(t => t.name === name)
    if (!tool?.handler) return text({ error: 'unknown_tool', hint: 'Call tools/list.' }, true)
    const input = tool.schema.safeParse(args)
    if (!input.success) {
      return text(
        { error: 'invalid_arguments', issues: input.error.issues.map(i => i.message) },
        true
      )
    }
    try {
      return text(await tool.handler(input.data))
    } catch (err) {
      logger.warn({ err, tool: name }, 'MCP tool failed')
      return text({ error: 'tool_failed', hint: 'The tool failed; try again later.' }, true)
    }
  })

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(c.req.raw)
  } finally {
    await server.close()
  }
})
