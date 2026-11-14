/**
 * The remote MCP server's wire contract (`apps/web/src/api/routes/mcp.ts`, docs/CONCEPTS.md §19).
 */
import { z } from 'zod'

/** Where the MCP server answers; the resource is `<APP_URL origin>` + this. */
export const MCP_PATH = '/mcp'

/** RFC 9728 protected-resource metadata, served at both well-known paths. */
export const PROTECTED_RESOURCE_PATHS = [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
] as const

/**
 * Which of the caller's tenants a call acts in, when they have several: a header on the request,
 * or the `tenant` argument every tool takes (the argument wins). Either holds the tenant's id, its
 * slug, or the id the issuer knows its org by.
 */
export const MCP_TENANT_HEADER = 'mcp-tenant'
export const MCP_TENANT_ARGUMENT = 'tenant'

export const protectedResourceMetadataSchema = z.object({
  resource: z.string().url(),
  authorization_servers: z.array(z.string().url()).min(1),
  bearer_methods_supported: z.array(z.literal('header')),
  resource_name: z.string(),
})
export type ProtectedResourceMetadata = z.infer<typeof protectedResourceMetadataSchema>

/** What the `list_tenants` tool answers: the tenants a call may name. */
export const mcpTenantSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  role: z.string(),
})
export type McpTenant = z.infer<typeof mcpTenantSchema>
