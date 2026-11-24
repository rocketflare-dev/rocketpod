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
- Rocketflare 0.41.1: `pnpm kit:upgrade` plans on a dirty tree (only `--apply` needs a clean one), `--apply --apply-deletes` `git rm`s what the kit deleted, `--apply` `git add`s exactly what it wrote (`.rocketflare.json` included; files with rejects stay unstaged), and a vendored plugin (`example-feature`) is ported as core.
- The rename records the package.json scripts it removed as `kitOnlyScripts` in `.rocketflare.json`; `/rp-agent-docs`'s `check.mjs` expects them missing in a copy, so a renamed copy no longer fails on `pnpm kit:release` or `pnpm web test:kit-only`.
- `pnpm db:generate` (`apps/web/scripts/db-generate.ts`) applies every migration to a scratch database on the local dev Postgres when drizzle-kit wrote one, names the statement Postgres refused, and drops it; `--check` runs the check alone.
- Tests: `source-files.ts` lists untracked sources too; `uniqueId()` is slug-safe (`[a-z0-9]+-[a-z0-9]+`); a test-database startup failure prints as itself (`tests/helpers/startup-error.ts`); `schema-invariants.test.ts` names a tenant FK's ON DELETE rule in words.

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
11. Add `"kitOnlyScripts": ["kit:release", "test:kit-only"]` at the top level of `.rocketflare.json` by hand (`kit:upgrade` never ports that file), and take `.claude/skills/rp-agent-docs/check.mjs`.
12. Set `"db:generate": "dotenv -e .env -- tsx scripts/db-generate.ts"` in `apps/web/package.json` and take `apps/web/scripts/db-generate.ts` and `apps/web/scripts/lib/migration-check.ts`.
13. Take `apps/web/tests/helpers/startup-error.ts` and wrap `prepareTestDatabase()` in `apps/web/tests/setup.ts` as `prepareTestDatabase().catch(plainStartupError)`; take the `uniqueId()` change in `apps/web/tests/helpers/auth.ts`, and change any test of yours that expected `_` in its value.
14. Give every foreign key of yours that carries `tenant_id` `onDelete: 'cascade'`, then `pnpm db:generate` and `pnpm db:migrate`; `schema-invariants.test.ts` names any you miss.
- Rocketflare 0.42.0: `pnpm plugin list --available` lists the ecosystem's published plugins live from `rocketflare-dev/rocketflare-plugins` (and the commercial repository when git can read it) at their newest tag; `/rp-plugin add` with no target shows it. Rocketpod has no catalogue of its own, so it points at https://rocketflare.dev/plugins and says the plugins are written for Rocketflare and translated on install.
- `pnpm design:docs` (`scripts/design-docs.mjs` + `scripts/lib/{contrast,brand,markdown-lite,svg-sanitize,design-docs-lib}.mjs`) renders `docs/design/*.md` into static pages in the app's tokens; `/rp-design` writes the design and `/rp-start` runs detach, setup, design and rename in order. `contrast.test.ts` reads its pairs from `scripts/lib/contrast.mjs`.
- `scripts/detach.sh` replaces the hand-written history reset (`/rp-setup`, `docs/ADAPTING.md` §0, `scripts/install.sh`) and records the kit commit in `.rocketflare.json`.
- `/rp-adapt` row (h) writes the app's own `LICENSE` and keeps the kit's MIT notice in `LICENSES/kit-MIT.txt`; the rename and `pnpm plugin add` never translate a licence file (`isLicenceFile`).
- `DEV_ACCOUNTS` (`ui/lib/dev-accounts.ts`) is the one list the seed creates and the quick-login buttons show; roles render through `roleLabel` / `ROLE_LABELS` (`@rocketpod/shared/tenants`); the seed labels its key and invite lines as local demo values.
- Plugins: `RequestCtx.apiKeyId`, a `guard` on a settings tab (`PluginSettingsTab`), `hooks.seed` (every `pnpm seed`) and `setFeature` on both seed hooks, and `pnpm seed --feature <key>[=on|off][@<slug>]`.
- The bootstrap's shell prerequisites (`scripts/lib/prereqs.sh`) name the WSL2 fixes: a root-only distro, Docker Desktop's WSL integration, Node through nvm/fnm, and a Windows `pnpm`/`node` on the PATH (`SETUP.md` "Windows (WSL2)").
15. Take `scripts/bootstrap.sh` and the new `scripts/lib/prereqs.sh` together, `extractSeedKey` in `scripts/lib/bootstrap-lib.mjs`, and the seed verify wording in `scripts/bootstrap.mjs`.
16. Add `apps/web/src/ui/lib/dev-accounts.ts`, move any accounts you added to `Login.tsx` or `apps/web/scripts/seed.ts` into `DEV_ACCOUNTS` with a `name` and a `role`, then take `Login.tsx`'s `isDevAccount` / `devAccountLabel` and the `SEED_USERS` / `SEED_OWNER` / `GLOBAL_ADMIN` derivation in `seed.ts`.
17. Take `ROLE_LABELS` / `roleLabel` in `packages/shared/src/tenants.ts` and every `roleLabel(...)` call in `apps/web/src/ui`; a UI test of yours matching `getByText('owner')` now matches `'Owner'`.
18. Take `apiKeyId` in `apps/web/src/plugins/api/{auth,http}.ts`, `apiKeyIdOf` in `apps/web/src/api/auth/api-key-session.ts` and the `apiKeyId` option in `apps/web/tests/kit/unit.ts`.
19. Take `PluginSettingsTab` in `apps/web/src/plugins/types.ts`, its exports from `apps/web/src/plugins/api/{index,ui-wiring}.ts`, and the tab filter in `SettingsLayout.tsx` and `useNavigationEntries.ts`.
20. Add `apps/web/scripts/lib/seed-features.ts`; take `hooks.seed` and `setFeature` in `apps/web/src/plugins/types.ts` and `apps/web/src/plugins/api/db.ts`, then `runPluginSeedHooks` / `applySeedFeatures` / `pluginSeedContext` in `apps/web/scripts/seed.ts`.
21. Take `scripts/plugin.mjs`, `scripts/lib/{plugin,git,rename}-lib.mjs` and their `.d.mts` from the release, and `apps/web/tests/config/plugin-catalogue.test.ts` (local fixture repositories, no network).
22. Search the ported files for your own domain followed by `/plugins` and change it back to `https://rocketflare.dev/plugins`: an upgrade run before `rename-lib.mjs` was ported translates that URL.
23. Add `scripts/design-docs.mjs`, `scripts/lib/{contrast,brand,markdown-lite,svg-sanitize,design-docs-lib}.mjs` with their `.d.mts`, `apps/web/tests/config/design-docs.test.ts`, and `"design:docs": "node scripts/design-docs.mjs"` in the root `package.json`.
24. Replace `apps/web/tests/ui/contrast.test.ts` with the kit's; move any pair you added into `contrastPairs()` in `scripts/lib/contrast.mjs`.
25. Copy `.claude/skills/rp-design/` (`SKILL.md`, `shape.md`, `brand.md`), `.claude/skills/rp-start/` and `scripts/detach.sh`; in an app already renamed, `/rp-start` only reports every step done.
26. `rp-adapt` is `neverPort`: copy checklist row (h) "Licence" and row (e)'s "From the design" paragraph from the kit's `.claude/skills/rp-adapt/checklist.md` by hand.
27. If your root `LICENSE` is still the kit's MIT notice, copy it to `LICENSES/kit-MIT.txt` first, then walk row (h) to write your own `LICENSE` and the `package.json` `license` fields.
28. Add `"LICENSES/**"` beside `"LICENSE"` in `neverPort` in `.rocketflare.json`.
29. Check that every installed plugin's `LICENSE` still names its licensor; one installed into a renamed app before this release had its licence translated, so restore it from the plugin's repository.
30. Port the text of `SETUP.md` "Windows (WSL2)" and §2.7, `docs/CONCEPTS.md` §7, §8 and §16, and the `rp-plugin`, `rp-setup` and `rp-how-do-i` skills, keeping your own wording.

## Conflicts to expect

- `apps/web/src/api/routes/mcp.ts`, `apps/web/src/api/auth/mcp.ts`, `packages/shared/src/mcp.ts` → rewritten → take the kit's versions; an app change to the old tool list belongs in a tool now.
- `apps/web/src/api/index.ts` → `/mcp`, `/oauth`, `/.well-known` mounts, `/api/mcp*` in the mount table, `assertNoReservedPluginPaths` → take the kit's lines.
- `apps/web/src/api/middleware/auth.ts` → the API-key branch builds its context through `tenantAuthContext` → re-apply your change inside `tenantAuthContext`.
- `apps/web/src/platform/types.ts`, `apps/web/src/node/platform.ts` → a `publicFetch` member → add it to any `Platform` you build by hand (`null` fails the fetch closed).
- `apps/web/src/ui/pages/settings/tabs.ts`, `SettingsLayout.tsx`, `ui/lib/query-keys.ts`, `App.tsx`, `Profile.tsx` → the `mcp` tab, key family, `/consent` route and Connected apps → keep yours alongside.
- `apps/web/src/api/services/{members,idp-tenancy,admin}.ts` → a `revokeMcpGrantsOf` call in the removal and block transactions → keep yours and add the kit's.
- `apps/web/tests/helpers/source-files.ts` → `git ls-files --cached --others --exclude-standard` and an optional `root` → take the kit's, keep your filters.
- `apps/web/tests/helpers/auth.ts` → `uniqueId()` and `testTenantSlug` → keep your factories, take both.
- `apps/web/scripts/seed.ts` → the account constants, the labelled key and invite lines and the plugin hook loop → keep your seed blocks, take the constants, the lines and `runPluginSeedHooks`.
- `apps/web/src/ui/pages/Login.tsx` → `DEV_ACCOUNTS` moved out → keep your accounts in `apps/web/src/ui/lib/dev-accounts.ts`.
- `scripts/bootstrap.sh` → the OS, root, docker, node and pnpm checks moved to `scripts/lib/prereqs.sh` → keep a check you added, take the rest.
- `apps/web/tests/ui/contrast.test.ts` → its pairs moved into `scripts/lib/contrast.mjs` → take the kit's file, move your pairs into `contrastPairs()`.

## Verify

1. `pnpm plugin check` prints no `agentTools` warning for a plugin you renamed.
2. With `mcp` in `FEATURES_ENABLED`, `curl -si -X POST http://localhost:3001/mcp` answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"`, and `curl -s http://localhost:3001/.well-known/oauth-authorization-server` contains `"client_id_metadata_document_supported": true`; without it, both answer 404.
3. With `MCP_AUTHORIZATION_SERVER` set, `curl -s http://localhost:3001/.well-known/oauth-protected-resource/mcp` lists that server first in `authorization_servers`.
4. `pnpm --filter @rocketpod/web exec vitest run --project config tests/config/node-egress.test.ts tests/config/mcp-cimd.test.ts` passes.
5. `pnpm gate` prints `✔ pnpm gate passed`.
6. `pnpm kit:upgrade` on a tree with an uncommitted edit exits 0 and prints `5/6 plan`.
7. With the dev database up, `pnpm db:generate --check` prints `✔ scratch check: all N migrations apply to an empty database`.
8. `pnpm plugin list --available` prints a `Plugins (github.com/rocketflare-dev/rocketflare-plugins at <tag>)` block, or exits 3 with one `error:` line offline.
9. `pnpm seed` prints the `/auth/dev-login` curl for the `DEV_ACCOUNTS` owner and an `api key:` line labelled a local demo key; Settings → People shows `Owner`, not `owner`.
10. `pnpm design:docs` exits 2 naming `/rp-design` on a tree with no `docs/design/*.md`, and `LICENSES/kit-MIT.txt` matches the kit's MIT notice.
