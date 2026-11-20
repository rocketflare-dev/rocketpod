---
version: unreleased
previous: 0.32.2
date: null
breaking: false
migrations:
  - "agent_runs gains input_from_requester, a boolean NOT NULL DEFAULT false"
  - "new table tenant_creation_counters (user_id, day, created), no foreign key to tenants"
areas: [api, config, shared, docs, db, ui]
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

## Rocketflare 0.33.0 and 0.34.0

Ported from Rocketflare's notes of the same versions, translated onto the Node platform. Plugin
tools get `ToolCtx.requesterUrls`; the UI offers "Create organisation" only when the server would
allow it; suspended organisations run no agents; invitation and ownership rules hold on every
path; API keys stay in their organisation; AI config saves lock their row; `ctx.decide`'s fallback
is metered; sign-in mail counts per mailbox; upload prefixes stay capped; Microsoft proves
addresses.

### What changed

- `GET /auth/session` answers `canCreateTenant` (`tenantCreationRefusal(cfg, auth)` in `services/tenants.ts`, the one rule `POST /api/tenants` also enforces); `OrgSwitcher` and `/select-tenant` hide "Create organisation" when it is false.
- `ToolCtx.requesterUrls` (`services/agents/tools/requester-urls.ts`): the URLs a person typed — chat turns, or an agent run's input submitted through `POST /api/agents/runs` / `/runs/batch` (`agent_runs.input_from_requester`, set only by those routes through `enqueueRun({ inputFromRequester })`). `@testkit/unit` `makeToolCtx({ requesterUrls })`.
- Suspension: `enqueueRun` / `enqueueRunBatch` refuse a non-active tenant with 403 `tenant_suspended`; `executeRun` settles such a run `cancelled` before any model call; `isCancelRequested` reads the tenant's status; `setTenantSuspended` cancels `queued` and `awaiting_input` runs and runs every plugin's new `hooks.onTenantStatusChanged(db, tenantId, status, env)`.
- Invitations: accept re-checks the issuer (410 `invitation_revoked`); a role change revokes the target's pending invitations the new role could not issue.
- `MAX_OWNED_TENANTS_PER_USER` holds on promotion to owner and on owner-invite accept (`assertMayOwnAnother`), and bounds creations per person per UTC day (`tenant_creation_counters`, pruned nightly by `runPruneExpired`).
- API keys: `withAccountAuth(c)` — `POST /api/tenants`, `GET /api/invitations/pending`, `POST /api/access-requests` answer 403 `insufficient_scope` to a key; `GET /api/tenants` lists the key's organisation alone.
- AI config saves: `upsertAiConfig` (`services/ai/configs.ts`) reads the row it overwrites `FOR UPDATE` inside its transaction.
- `ctx.decide`'s chat fallback runs through the run meter (`meterChatClient(client, meter, { feature, billedToPlatform })`; `resolveDecisions`' `wrapChat(client, { provider, billedToPlatform })`).
- Sign-in mail: the per-recipient window on `platform.rateLimiter` is keyed on `canonicalMailbox(email)` (`utils/core/mailbox.ts`).
- Body limits: beneath an upload prefix a JSON body keeps 1 MB and any other body is capped at `MAX_UPLOAD_PATH_BODY_BYTES` (10 MB + 64 KB). `@hono/node-server` sets no limit of its own, so these are the only caps.
- Microsoft: `emailVerified` from Graph `/organization` verified domains; the OAuth callback refuses an unverified address only where it would match or admit an account.

### How to apply

1. Follow Rocketflare's `docs/upgrades/0.33.0.md` and `0.34.0.md` "How to apply", with these Rocketpod paths and differences:
   - `upsertAiConfig` lives in `apps/web/src/api/services/ai/configs.ts`, not the route: move the `FOR UPDATE` read (`lockConfig`) and the insert-or-update there.
   - `setTenantSuspended(db, { tenantId, suspended, admin, env, platform, logger, realtime })` takes `platform` (`c.get('platform')`) for `requestCancel`'s forced cancel.
   - `recipientMailAllowed` takes `platform.rateLimiter`; hash `canonicalMailbox(email)` there.
   - Tests use `tests/helpers/test-agents{,-shared}.ts` (`TEST_SUMMARIZE`, `TEST_RESEARCH`, `withTestAgents`, `testAgentsServerBarrel`) where Rocketflare's use `fixture-agents.ts`, `runAgentRun` with `createFakeStep` where they drive `AgentRunWorkflow`, and `scriptPlatformChat` on the `AI_*` fake endpoint where they stub Workers AI.
2. Run `pnpm db:generate` and `pnpm db:migrate`.
3. Regenerate `docs/plugin-api.md` with `node scripts/plugin-api-doc.mjs`.

### Conflicts to expect

- `apps/web/src/api/services/admin.ts` → `setTenantSuspended` takes one input object → update your own callers.
- `apps/web/src/api/services/ai/resolve.ts` → `wrapChat`'s second argument is `{ provider, billedToPlatform }`.
- `apps/web/src/api/routes/auth/oauth.ts` → the `emailVerified === false` refusal moved below the provider-link lookup.
- `apps/web/src/ui/pages/SelectTenant.tsx` → the create control is wrapped in `canCreateTenant`.

### Verify

1. `tests/api/security/{requester-urls,tenant-creation,agent-run-tenant-suspension,invitation-authority,api-key-account-scope,ai-config-concurrent-saves,agent-run-budget-accounting,sign-in-mail-per-recipient,upload-path-body-limit,microsoft-sign-in-email}.test.ts` pass.
2. `tests/api/plugin-tenant-status-hook.test.ts` and `tests/api/plugin-events.test.ts` pass.
