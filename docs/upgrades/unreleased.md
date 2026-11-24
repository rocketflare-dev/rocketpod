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
- An outside access token's `typ` header may now be `at+jwt`, `JWT` or absent, so Cognito and Entra access tokens are accepted; a `token_use` other than `access` (a Cognito ID token) is refused, and the audience check still keeps every ID token out (`SETUP.md` §2.3d names the claims each issuer needs).
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

- Rocketflare 0.43.0: `pnpm gate --changed[=<ref>]` runs each step over what the branch changed (lint on those files, typecheck/test/build in the packages they reach, only the web tests their imports reach; a config, lockfile, migration or harness change makes it the full gate), and writes `changed: true` in `.gate/last.json` (`full: false`).
- `pnpm test <suite…> [file…]` (`api|ui|config|driver|kit-only`, each its shared and isolated projects; `web` = the web plan without the other packages); the `apps/web` `test:*` scripts are aliases for it. `--only` / `--shard` stay for CI.
- Test projects: `api-fixtures` (files starting `// @vitest-fixture-agents` share a registry into which `tests/api-fixtures-setup.ts` pushes the test agents once per worker), `ui-isolated` and `config-isolated` (chosen by `uiNeedsIsolation`, no marker). The agent-runtime tests mock no barrel any more.
- `overrideResolveChatForTests`, `overrideResolveDecisionsForTests` and `overrideKnowledgeEntityTypesForTests` replace `vi.mock` of those modules; `withServerPlugins(fixtures)` (`tests/helpers/server-plugins.ts`) splices fixture server plugins for one file. Spies and `vi.stubGlobal` need no isolate marker.
- TypeScript 7.0.2 compiles; code that parses TypeScript (the source-scanning guards, `surface.mjs`, `plugin-api-doc.mjs`) imports `typescript6`. `paths` are `./`-relative (no `baseUrl`). Vitest 5.1, Vite 8.3.
- The kit's tooling tests (`scripts/**`) moved to `tests/kit-only/`; `kit-makeup.test.ts` holds the kit's exact job and entity types; `build:ui` runs `scripts/check-ui-bundle.mjs`; up to 10 test workers.
- Rocketflare 0.44.0: `pnpm kit:upgrade` hands the run to the TARGET release's `scripts/upgrade.mjs` (extracted with `scripts/lib/` into `.upgrade/tool/<v>/`) when it differs from the copy's, so upgrader fixes inside the range apply to the jump that crosses them.
- A file whose patch no longer applies is merged 3-way (`git merge-file`, base = the old kit file, theirs = the new one, both translated); a clean merge is applied and staged, a conflict is a `*.rej` or, with the new `--3way`, conflict markers; `--continue` refuses while a marker remains; a `manual` file the kit changed gets the merge under `.upgrade/work/<v>/merged/`.
- `scripts/lib/rename-lib.{mjs,d.mts}` is always ported verbatim (`ALWAYS_PORTED_TOOLING`), whatever a copy's `neverPort` says, and the kit's `neverPort` no longer lists it.
- `pnpm test` reads the test Postgres and S3 gateway ports from `apps/web/docker-compose.test.yml` (`testPorts`) and refuses a `.env.test` whose `DATABASE_URL` or `STORAGE_ENDPOINT` connects elsewhere (`testPortMismatches`).
- `pnpm plugin add|upgrade|remove` match a core-edit line as code (`findEditLine`), so a line Biome wrapped is not written again and is reverted whole.
- `UiPlugin.homeCards` (`{ id, Component, guard?, order? }[]`) is Home's "what needs doing" section above the quick links, rendered by `ui/components/PluginHomeCards.tsx`; the core quick links moved to the leaf `ui/pages/home-links.ts`.
- `RequestCtx.embeddable(contentType)` opts one plugin response into same-origin framing for an `EMBEDDABLE_MIME_TYPES` type only; `makeRequestCtx` records it on `framed`.
- `ServerPlugin.uploadLimits` (`{ '/api/<id>/upload': bytes }`) gives an exact path a non-JSON body cap up to `MAX_PLUGIN_UPLOAD_LIMIT_BYTES` (50 MiB, clamped), checked first in `apiBodyLimit`; the Helm values comment and `docs/DEPLOY.md` say to raise ingress-nginx's `proxy-body-size` to match.
- Rocketflare 0.44.1: `kit-manifest.test.ts` expects `kit-only` in the test plan only while `apps/web/tests/kit-only/` exists, and `scripts/release.mjs` prints `git add <note> && git commit -am …`.

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

31. Run `pnpm install` (TypeScript 7, `typescript6`, Vitest 5.1, Vite 8.3); remove `baseUrl` from your tsconfigs and make each `paths` entry `./`-relative; change any `import ts from 'typescript'` of yours to `'typescript6'`.
32. Take `apps/web/vitest.config.ts`, `tests/helpers/isolation.ts`, `tests/api-fixtures-setup.ts`, `tests/api-setup.ts`, `tests/config/{setup,shared-setup}.ts`, `tests/helpers/server-plugins.ts`, `scripts/test.mjs`, `scripts/gate.mjs` and `scripts/lib/{test-plan,gate-lib,gate-changed,gate-changed-git}.mjs` with their `.d.mts`.
33. In a test of yours that mocks `@/api/services/ai/resolve`, call `overrideResolveChatForTests` / `overrideResolveDecisionsForTests` at the top of the file instead; in one that mocks both plugin barrels for the test agents, replace the marker with `// @vitest-fixture-agents`, delete the two `vi.mock`s and restore any `AGENTS` swap in `afterEach`/`afterAll`; drop `// @vitest-isolate` from a file that only spies or stubs globals.
34. Change `test:api`, `test:ui`, `test:config`, `test:driver` in `apps/web/package.json` to `node ../../scripts/test.mjs <suite>`.

35. Delete `scripts/lib/rename-lib.mjs` and `scripts/lib/rename-lib.d.mts` from `neverPort` in `.rocketflare.json` if your copy lists them, then copy both files from the release: `git --git-dir .upgrade/kit.git show <version>:scripts/lib/rename-lib.mjs > scripts/lib/rename-lib.mjs` (and the same for `rename-lib.d.mts`).
36. Take the kit's `scripts/upgrade.mjs`, `scripts/lib/upgrade-lib.{mjs,d.mts}`, `scripts/lib/plugin-lib.{mjs,d.mts}`, `scripts/lib/test-plan.{mjs,d.mts}`, `scripts/test.mjs` and `scripts/release.mjs`, resolving any reject in the kit's favour, since they are kit tooling.
37. If your copy moved its test ports, check that `apps/web/docker-compose.test.yml`'s `ports:` and `apps/web/.env.test`'s `DATABASE_URL`, `APP_DATABASE_URL` and `STORAGE_ENDPOINT` name the same ports: `pnpm test` now refuses a mismatch.
38. If an earlier `pnpm plugin upgrade` left a core-edit line twice (a wrapped copy beside the one-line original in `apps/web/vite.config.ts`), delete the wrapped copy by hand once.
39. Add `apps/web/src/ui/pages/home-links.ts` with `QuickLink` and `CORE_QUICK_LINKS`, keeping your own Home links in that list, delete both from `apps/web/src/ui/pages/Home.tsx`, and point the imports in `ui/hooks/useNavigationEntries.ts`, `plugins/types.ts` and `plugins/api/ui-wiring.ts` at `ui/pages/home-links`.
40. Add `apps/web/src/ui/components/PluginHomeCards.tsx`, `PluginHomeCard` and `UiPlugin.homeCards` in `apps/web/src/plugins/types.ts`, export `PluginHomeCard` from `plugins/api/index.ts` and `plugins/api/ui-wiring.ts`, and render `<PluginHomeCards plugins={uiPlugins} />` above the quick links in `Home.tsx`.
41. Add `embeddable(contentType)` to `RequestCtx` and `requestCtx` in `apps/web/src/plugins/api/http.ts`, and to `makeRequestCtx` in `apps/web/tests/kit/unit.ts` with the `framed` getter.
42. Add `MAX_PLUGIN_UPLOAD_LIMIT_BYTES`, `UploadLimit`, `pluginUploadLimits` and `apiBodyLimit`'s third parameter to `apps/web/src/api/middleware/body-limit.ts`, `ServerPlugin.uploadLimits` to `apps/web/src/plugins/types.ts`, and pass `pluginUploadLimits(serverPlugins)` as `apiBodyLimit`'s third argument in `apps/web/src/api/index.ts`.
43. If an installed plugin declares `uploadLimits`, raise `nginx.ingress.kubernetes.io/proxy-body-size` on your ingress to its largest cap plus 64 KB.
44. Copy `uploadLimitIssues` into `apps/web/tests/helpers/plugins.ts` and the new cases in `tests/config/{plugins,public-mounts,plugin-ui-kit-graph}.test.ts`, `tests/api/plugin-request-ctx.test.ts` and `tests/ui/plugin-home-cards.test.tsx`.

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
- `apps/web/vitest.config.ts` → three new projects and the file split → take the kit's, re-add an alias or a project of yours.
- A test of yours moved by the release (`tests/api/*` → `tests/config/` for the database-free ones) → keep your edits in the new path.
- `apps/web/src/ui/pages/Home.tsx` → the quick links moved to `home-links.ts` and the cards section came in → keep your own sections, and your links in `home-links.ts`.
- `apps/web/src/plugins/types.ts` → `uploadLimits`, `homeCards` and `PluginHomeCard` → keep both sides.
- `scripts/lib/rename-lib.mjs` → arrives verbatim for the first time since your copy was made → take the kit's; the rename never translated it.

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
11. `pnpm gate --changed` ends `✔ pnpm gate --changed passed — run the full pnpm gate before you push`, and `pnpm test api apps/web/tests/api/health.test.ts` runs one file.
12. `pnpm test config apps/web/tests/config/plugin-ui-kit-graph.test.ts apps/web/tests/config/public-mounts.test.ts apps/web/tests/config/plugins.test.ts` passes, and `pnpm test ui apps/web/tests/ui/plugin-home-cards.test.tsx` passes.
13. `node -e "import('./scripts/lib/rename-lib.mjs').then(m => console.log(typeof m.isLicenceFile))"` prints `function`.
