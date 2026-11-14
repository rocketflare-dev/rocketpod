---
version: unreleased
previous: 0.32.2
date: null
breaking: false
migrations: []
areas: [api, config, shared, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

A remote MCP server at `/mcp` offers the agents' tools to MCP clients, authorised by an outside OAuth server's access tokens (`MCP_AUTHORIZATION_SERVER`), off until that is set.

- `/mcp` (stateless Streamable HTTP) and RFC 9728 metadata at `/.well-known/oauth-protected-resource[/mcp]`; docs/CONCEPTS.md §19.
- The token's person passes the SSO policy and `admitUser`, and under `OIDC_MANAGED_TENANCY` its orgs claim is reconciled like an id_token's.
- The tools are `buildAgentTools` for the call's tenant and grant (approval-gated tools left out), plus `list_tenants`; a person with several tenants names one per call (`tenant` argument or `mcp-tenant` header).
- CORS answers any origin without credentials on `/mcp` and the metadata.
- New dependency `@modelcontextprotocol/sdk`.

## How to apply

1. Add `@modelcontextprotocol/sdk` (`^1.32.2`) to `apps/web/package.json` and run `pnpm install`.
2. Copy `packages/shared/src/mcp.ts`, `apps/web/src/api/auth/mcp.ts`, `apps/web/src/api/routes/mcp.ts` and `apps/web/tests/api/mcp.test.ts` from the release.
3. In `apps/web/src/config.ts`, add `MCP_AUTHORIZATION_SERVER` (optional URL, blank = unset) to the schema, and the `hasMcp` and `mcpResource` helpers beside `hasOidc`.
4. Add `MCP_AUTHORIZATION_SERVER=` to `apps/web/.env.example` and `MCP_AUTHORIZATION_SERVER: ""` to the chart's `config` in `deploy/helm/<app>/values.yaml`.
5. In `apps/web/src/api/index.ts`, import `mcpRouter` from `./routes/mcp`, add `app.use('/mcp', jsonBodyLimit)` after the `/auth/*` body limit, and `app.route('/', mcpRouter)` right after `app.route('/ws', wsRouter)`, before the mount table.
6. In `apps/web/src/api/middleware/cors.ts`, add the `mcpCors` handler and the `isMcpPath` branch to `corsMiddleware` from the release.
7. In `apps/web/src/api/utils/routes/api-prefixes.ts`, add `/mcp` and `/.well-known/oauth-protected-resource` to `CORE_API_PREFIXES` and de-duplicate `API_PREFIXES` with a `Set`.
8. If your app adds kit-wide agent tools in `buildAgentTools`, check each one is safe to offer to an MCP client: `/mcp` offers every tool that has a handler and no approval gate.
9. Add docs/CONCEPTS.md §19 from the release.

## Conflicts to expect

- `apps/web/src/api/index.ts` → two lines near the `/ws` mount and the body limits → keep yours and add the two.
- `apps/web/src/api/utils/routes/api-prefixes.ts` → `CORE_API_PREFIXES` grew → if you installed the analytics plugin, its `/mcp` is now shadowed by core's; keep both entries.

## Verify

1. `pnpm gate` passes.
2. `MCP_AUTHORIZATION_SERVER` unset: `curl -s -o /dev/null -w '%{http_code}' localhost:3001/mcp` prints `404`.
3. `MCP_AUTHORIZATION_SERVER` set: `curl -s localhost:3001/.well-known/oauth-protected-resource/mcp` names `<APP_URL>/mcp` and the server, and `curl -si -X POST localhost:3001/mcp` answers 401 with a `WWW-Authenticate` header.
