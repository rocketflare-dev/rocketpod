---
version: unreleased
previous: 0.40.0
date: null
breaking: true
migrations: ["MCP server and its authorization server: mcp_settings, mcp_grants, mcp_tokens, mcp_tool_calls, oauth_clients, oauth_requests (0017_kit-mcp-server)"]
areas: [api, config, db, shared, ui, docs, deploy]
touches_surfaces: [example-feature, feature-chat, feature-agents]
requires_surfaces: []
manual: true
---

## What changed

The MCP server is rebuilt on Rocketflare 0.41.0: the app is its own OAuth 2.1 authorization server, each organisation turns MCP on and picks what it exposes, and one tool list serves chat, agents and MCP.

- `/mcp` and `/mcp/t/<slug>` (`routes/mcp.ts`, `services/mcp/`) serve stateless Streamable HTTP through `@modelcontextprotocol/server`, which replaces `@modelcontextprotocol/sdk`; it is dark unless `FEATURES_ENABLED` lists `mcp`, then off per organisation until Settings → MCP turns it on (`docs/CONCEPTS.md` §19).
- The app's own authorization server (`routes/oauth.ts`, `services/mcp/authorization.ts`): RFC 9728/8414 discovery, Client ID Metadata Document clients, PKCE S256, the `/consent` page, rotating refresh tokens with a retry grace, revoke. Tokens are `mcpat_`/`mcprt_`, SHA-256 at rest.
- `MCP_AUTHORIZATION_SERVER` stays, as a SECOND issuer: its JWTs are verified as before (`auth/mcp.ts`), the person admitted through the SSO policy and `admitUser`, then mapped to an `mcp_grants` row and run through the same caller as the app's own tokens (`callerForGrant`). The organisation comes from `/mcp/t/<slug>`, the `mcp-tenant` header or the only membership; several and none named is 403 `mcp_tenant_required`. Protected-resource metadata lists that server first.
- **Breaking for `MCP_AUTHORIZATION_SERVER` users:** `/mcp` now also needs `mcp` in `FEATURES_ENABLED` and the organisation's switch; the per-call `tenant` argument and the `list_tenants` tool are gone; a tool is listed only under the organisation's exposure (`read_only` by default).
- Tables `mcp_settings`, `mcp_grants`, `mcp_tokens`, `mcp_tool_calls` (tenant) and `oauth_clients`, `oauth_requests` (in `RLS_REVOKED_TABLES`), in one migration; `pruneMcp` joins the `0 4 * * *` cron.
- New optional vars: `MCP_GRANT_IDLE_DAYS`, `MCP_GRANT_MAX_DAYS`, `MCP_CALL_RETENTION_DAYS`, `MCP_CALLS_PER_GRANT_PER_MINUTE`, `MCP_CALLS_PER_USER_PER_MINUTE`, `MCP_CALLS_PER_TENANT_PER_MINUTE` (in `.env.example` and the chart's `config`).
- Calls are capped per connection, person and organisation through `platform.rateLimiter`; a limiter that cannot be read fails the call as a logged `tool_failed`.
- `Platform.publicFetch` (`src/node/egress.ts`): the client metadata document fetch refuses to connect to a loopback, private, link-local or reserved address, judged on the resolved address at connect time. Null (an empty platform) fails such fetches closed.
- The tool seam: `toolsFor(surface, ctx)`, `Tool.surfaces`, `Tool.mcp`, `ToolCtx.requester`, `MCP_TOOL_NAME_PATTERN`; `ServerPlugin.tools` replaces `agentTools` (still read, with a `plugin check` warning); `@/plugins/api` exports the HTTP error classes; `@testkit/integration` exports `callMcpTool`, `connectMcp`, `enableMcp`, `mcpClient`, `mcpTestEnv`, `toolJson`.
- Settings → MCP (switch, who may connect, exposure, tools, connected clients) and Profile → Connected apps.
- Removing a member or blocking a person revokes their MCP connections in the same transaction (`revokeMcpGrantsOf`).
- Fix: deleting a document repairs the facts it superseded or conflicted with (`deleteDocumentsWithFacts`, `services/knowledge/remove.ts`); extraction drops a value, wording or date over 2,000 characters before parsing it.
- Docs: `.claude/rules/tools.md`, the `/rp-mcp` skill, `services/mcp/CLAUDE.md`, `SETUP.md` §2.3d/§2.10, `docs/DEPLOY.md` "The MCP server", the dev-login and tunnel warnings in `SETUP.md` §1.6/§1.10.

## How to apply

1. Run `pnpm install` (the MCP SDK package changed), then `pnpm db:migrate` to apply `0017_kit-mcp-server`.
2. In every server plugin of your own that declares `agentTools:`, rename the key to `tools:`; `pnpm plugin check` warns until you do.
3. In app code that hands `buildAgentTools(ctx)` to chat or an agent run, call `toolsFor('chat', ctx)` or `toolsFor('agents', ctx)` from `apps/web/src/api/services/agents/tools` instead; keep your own tools inside `buildAgentTools`.
4. In app code that deletes a `documents` row, call `deleteDocumentsWithFacts(db, tenantId, ...conditions)` from `apps/web/src/api/services/knowledge/remove.ts` instead of a bare delete.
5. In an app path of your own that deletes a `tenant_users` row or sets `users.blocked_at`, call `revokeMcpGrantsOf(tx, { userId, tenantId?, reason })` from `apps/web/src/api/services/mcp/connections.ts` in the same transaction.
6. If your app serves anything at `/consent`, `/oauth` or `/.well-known/openid-configuration`, move it: core owns those paths now.
7. To ship MCP, add `mcp` to `FEATURES_ENABLED` (`apps/web/.env`, the compose `.env` or the chart's `config`), then turn it on per organisation at Settings → MCP (`SETUP.md` §2.10).
8. If you set `MCP_AUTHORIZATION_SERVER`: do step 7 for each organisation people connect to, and tell anyone in several organisations to connect to `/mcp/t/<slug>` or send `mcp-tenant` — a tool no longer takes a `tenant` argument and `list_tenants` is gone (`SETUP.md` §2.3d).
9. If the web pods' egress is restricted, allow outbound https to the internet: the authorization server fetches each client's metadata document (`docs/DEPLOY.md` "The MCP server").
10. Rename any tool of yours whose name has a `.`, is over 64 characters or repeats a core tool's name, and give a plugin tool an "over MCP" case with `callMcpTool` (copy `example-feature`'s).

## Conflicts to expect

- `apps/web/src/api/routes/mcp.ts`, `apps/web/src/api/auth/mcp.ts`, `packages/shared/src/mcp.ts` → rewritten → take the kit's versions; an app change to the old tool list belongs in a tool now.
- `apps/web/src/api/index.ts` → `/mcp`, `/oauth`, `/.well-known` mounts, `/api/mcp*` in the mount table, `assertNoReservedPluginPaths` → take the kit's lines.
- `apps/web/src/api/middleware/auth.ts` → the API-key branch builds its context through `tenantAuthContext` → re-apply your change inside `tenantAuthContext`.
- `apps/web/src/platform/types.ts`, `apps/web/src/node/platform.ts` → a `publicFetch` member → add it to any `Platform` you build by hand (`null` fails the fetch closed).
- `apps/web/src/ui/pages/settings/tabs.ts`, `SettingsLayout.tsx`, `ui/lib/query-keys.ts`, `App.tsx`, `Profile.tsx` → the `mcp` tab, key family, `/consent` route and Connected apps → keep yours alongside.
- `apps/web/src/api/services/{members,idp-tenancy,admin}.ts` → a `revokeMcpGrantsOf` call in the removal and block transactions → keep yours and add the kit's.

## Verify

1. `pnpm plugin check` prints no `agentTools` warning for a plugin you renamed.
2. With `mcp` in `FEATURES_ENABLED`, `curl -si -X POST http://localhost:3001/mcp` answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"`, and `curl -s http://localhost:3001/.well-known/oauth-authorization-server` contains `"client_id_metadata_document_supported": true`; without it, both answer 404.
3. With `MCP_AUTHORIZATION_SERVER` set, `curl -s http://localhost:3001/.well-known/oauth-protected-resource/mcp` lists that server first in `authorization_servers`.
4. `pnpm --filter @rocketpod/web exec vitest run --project config tests/config/node-egress.test.ts tests/config/mcp-cimd.test.ts` passes.
5. `pnpm gate` prints `✔ pnpm gate passed`.
