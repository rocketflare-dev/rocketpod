---
version: unreleased
previous: 0.2.0
date: null
breaking: true
migrations:
  - "tenants.external_org_id (text, unique, nullable)"
  - "tenants.idp_synced_at (timestamptz, nullable)"
  - "tenant_users.source (text manual|idp, NOT NULL default manual)"
  - "tenant_users.idp_synced_at (timestamptz, nullable)"
  - "users.global_admin_source (text manual|idp, nullable)"
  - "user_sessions.max_expires_at (timestamptz, nullable)"
  - "agent_runs.batch_id (uuid, nullable); indexes agent_runs (tenant_id, status), partial agent_runs (tenant_id, batch_id) and partial ai_usage (tenant_id, agent_run_id)"
  - "users.blocked_source (text, nullable)"
areas: [api, db, config, shared, ui, cli, plugins, skills, docs, ci, scripts]
touches_surfaces:
  - feature-guide
  - example-guide-pages
  - feature-agents
  - example-agent-summarize-text
  - example-agent-research-topic
  - example-agent-triage-research
  - feature-knowledge
requires_surfaces: []
manual: true
---

## What changed

IdP-managed tenancy: with `OIDC_MANAGED_TENANCY=true` the OIDC issuer decides which of its orgs a person may use the app in, and with what role. Every OIDC sign-in reconciles tenants, memberships and global admin from the verified id_token; between sign-ins the issuer's signed identity events (Standard Webhooks, `POST /api/identity/events`) change them; and an OIDC session ends a fixed time after sign-in. OIDC logout also sends `logout_uri` for Amazon Cognito, and a Cognito pre-token denial shows "You don't have access to this app".

- `config.ts`: `OIDC_MANAGED_TENANCY`, `OIDC_ORGS_CLAIM` (default `orgs`), `OIDC_ROLE_MAP` (`issuerRole:admin|member` pairs, parsed to a record), `OIDC_ADMIT_CLAIM`, `OIDC_GLOBAL_ADMIN_CLAIM`, `OIDC_SESSION_MAX_AGE_DAYS` (default 7, at most 30) and the secret `IDENTITY_WEBHOOK_SECRET` (`whsec_…`); managed tenancy needs `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `TENANCY_MODE=multi`; `isIdpManaged(cfg)`.
- `packages/shared/src/idp.ts`: the orgs-claim schema and the identity-event schemas.
- `services/idp-tenancy.ts`: `readIdpClaims`, `idpClaimsAdmit`, `reconcileIdpClaims`, `applyIdentityEvent`.
- `auth/standard-webhooks.ts`: `verifyStandardWebhook`, `webhookHeaders`.
- `routes/identity-events.ts`, mounted at `/api/identity` without `authMiddleware`.
- `routes/auth/oauth.ts`: under managed tenancy, claims admit a new person (not `SIGNUP_MODE`), the reconcile runs before `completeLogin`; a 400 `UserLambdaValidationException` at the token exchange → `/login?error=no_access`.
- `services/auth.ts`: `AdmitInput.admittedBy: 'idp'` creates the user with no access request and no `onNoTenant`.
- `services/members.ts`: role change and removal of a `source='idp'` row → 409 `idp_managed` (`ERROR_CODES.idpManaged`); the list returns `source`.
- `auth/sessions.ts` + `routes/auth/helpers.ts`: a session may carry `max_expires_at`, which the 30-day slide never passes; under managed tenancy every sign-in (OIDC, magic link, dev login) sets it to sign-in + `OIDC_SESSION_MAX_AGE_DAYS`, and the cookie ends with it.
- `services/admin.ts`: `setGlobalAdmin` records `global_admin_source = 'manual'`, so a sign-in never clears an admin-console grant.
- `auth/providers/oidc.ts`: the profile carries the verified payload (`idTokenClaims`); `oidcEndSessionUrl` adds `logout_uri` beside `post_logout_redirect_uri`.
- UI: `Login.tsx` copy for `no_access`; `People.tsx` shows a "Managed" badge and no controls on `idp` rows.
- Decision: a tenant managed tenancy creates has no owner (`docs/CONCEPTS.md` §1).
- `services/idp-tenancy.ts`: on an org's first sign-in, an unlinked tenant whose slug is the
  claim's `slug` is linked to the org rather than a second tenant created (`linkTenantBySlug`); a
  tenant linked to another org is never taken.
- Admin: a global admin links a tenant to an issuer org, or unlinks it
  (`PUT /api/admin/tenants/:id/external-org`, `setTenantExternalOrg`, 409 `external_org_taken`,
  activity `tenant.idp_linked` / `tenant.idp_unlinked`), since a tenant made in the app is never
  matched by slug; and deletes an organisation (`DELETE /api/admin/tenants/:id`, the owner's
  `deleteTenant` with its slug confirmation), the only way to remove an ownerless one. The admin
  tenant DTOs carry `externalOrgId`, the detail `idpManaged`; `TenantDetail.tsx` gains the
  Identity provider org panel and a danger zone.

Agents run at volume: a per-tenant cap on active runs, batch runs, per-call metering with budgets, tool-loop policies and replay.

- Agents at volume (Rocketflare 0.21.0): `enqueueRun(db, cfg, platform, input)` enforces
  `AGENT_MAX_ACTIVE_RUNS_PER_TENANT` (default 50, 429 `agent_runs_limit`) and
  `AGENT_TENANT_DAILY_COST_USD` (429 `ai_budget_exceeded`); an exclusive agent's active run is found
  before the cap, so asking again is never a 429. `triage-research` is now `exclusive: false`.
- `POST /api/agents/runs/batch` (`enqueueRunBatch`, `createAgentRunBatch{Request,Response}Schema`,
  `AGENT_RUN_BATCH_MAX` = 100): one non-exclusive, startable agent (400 `agent_exclusive`
  otherwise), per-input errors, one insert under a `batch_id`, then one `platform.runs.create()`
  per row (OpenWorkflow has no batch call); `GET /api/agents/runs?batchId=`.
- `ctx.scope(prefix)` and `ctx.map(key, items, fn, { concurrency, keyOf })`
  (`services/agents/fanout.ts`).
- The ledger is one `ai_usage` row PER CALL carrying `agent_run_id`, written by the run's meter
  (`services/agents/budget.ts`) for every call through `ctx.chat.client` and `ctx.decide`; the
  example and test agents no longer call `recordUsage`; `ctx.recordUsage(call)` is for a client an
  agent builds itself; `GET /api/agents/runs/:id` returns `usage`. `recordUsage` returns the cost
  it froze.
- Budgets: `meta.budget { maxTokens, maxCostUsd }` over `AGENT_RUN_MAX_TOKENS` /
  `AGENT_RUN_MAX_COST_USD`; over → `failed`, event code `agent_budget_exceeded`, not retried.
- Policies: `meta.policy { maxTurns, maxToolCalls, maxDurationSeconds, repeatedFailureLimit,
  onExhaustion }` passed to `runToolLoop` as `policy`; `'final-answer'` forces one call to the
  terminal tool, `'fail'` throws `ToolLoopExhaustedError` (event code `agent_policy_exhausted`).
  `research-topic`'s hand-written salvage is now its policy; `GET /api/agents` items carry
  `policy`, shown on the Agents page. `runToolLoop`'s `authorizeTool(call)` refuses a tool call by
  rule.
- Replay: `services/agents/replay.ts` (`replayRun`, `listReplayableRuns`, `liveReplayWarnings`,
  `diffJson`), `apps/web/scripts/agent-replay.ts` + the `agent:replay` script (`--candidate`,
  `--live`; an empty platform, the `.env` keys), `ctx.once(key, fn, { replay })`,
  `decideWithShapes` / `toDecision` exported from `decisions.ts`, the skill `rp-agent-replay`.
- The plugin `AgentCtx` gains `interrupt(ask)` and `chatModel { provider, model }`;
  `AgentInterruptAsk` / `AgentInterruptAnswer` are exported from `@/plugins/api`.
  `PROMPT_REGISTRY` is typed so a plugin's prompt key indexes it.
- CLI: `rocketpod agents list`, `agents run <key> --input x.json | --batch x.jsonl`,
  `agents runs list [--batch id]`.

Plugins start agent runs from jobs and crons (`ctx.startAgentRun`, with an idempotency key),
agents and tools get `storage()`, converted text with NUL bytes now indexes, and unlabelled plugin
nav groups share one block.

- `ctx.startAgentRun({ agentKey, tenantId, input, idempotencyKey?, concurrencyKey?, triggeredBy? })`
  → `{ runId, status, deduplicated }` on `JobCtx`, `CronCtx` and `PublicCtx` (`BackgroundMethods`,
  `apps/web/src/plugins/api/agent-runs.ts`), through the route's own `enqueueRun`.
- `enqueueRun({ idempotencyKey })`: the run id is derived from (tenant, agent, key) by
  `idempotentRunId`, so a repeat answers the first run, settled or not; no migration.
- `@testkit/unit`: `makeJobCtx` and `makeCronCtx` return `Fake{Job,Cron}Ctx` with `startedRuns`
  and accept a `startAgentRun` replacement.
- `AgentCtx` and `ToolCtx` gain `storage()` (`filesStorage(platform)`).
- `stripControlChars` / `stripControlCharsDeep` (`apps/web/src/api/utils/core/text.ts`) clean
  `documents.content`, `chunks.text` and every `ai_spans` string before the write.
- `composeNav` folds an unlabelled plugin nav group into the unlabelled group right before it.

Every dependency is current and the runtime is Node 26, in the image too: React 19, React Router 7,
vitest 5, Vite 8, postgres.js 4, CASL 7, the Anthropic SDK 1.x (API version `2026-10-21`), AG-UI
1.0.3; workflows pin every Action by SHA, with timeouts and least-privilege permissions.

- **Node 26**: `.nvmrc`, `engines.node` `>=26`, `@types/node` 26, the server bundle's esbuild
  target `node26`, and the `Dockerfile`'s `NODE_VERSION` (both stages). Node 26 ships no corepack,
  so the build stage installs the `packageManager` pnpm with `npm install -g`, and the docs, skills
  and bootstrap hints say `npm i -g pnpm@10`. `packageManager` is `pnpm@10.34.9`.
- **Versions only**: every dependency at the newest release its range allows (`pnpm update -r`,
  24 h publish delay), `jsdom` 30, `@testing-library/jest-dom` 7, `chalk` 6, `esbuild` 0.28 (web and
  cli), `@hono/zod-validator` 0.9, Biome 2.6 (`biome.json` migrated: `"preset": "recommended"`;
  `noComponentHookFactories` off for tests, suppressed on `schemaForm`'s `Component`), and the
  runtime's own: `pg-boss` 12.38.1, `openworkflow` 0.11.0, `ws` 8.22.2, `@aws-sdk/*` 3.1164.0,
  `unpdf` 2.1.0 (ESM only; `extractText` unchanged), `pixelmatch` 8. `apps/web` drops `dotenv`
  (nothing imports it, and 18's bin displaces `dotenv-cli`'s).
- `apps/cli/src/auth.ts`: the callback server's 404 sends `Connection: close` — a kept-alive socket
  outlived `close()` and the next server on that port got `ECONNRESET` (deterministic on Node 26).
- vitest 5 (`apps/web`, `apps/cli`; `apps/evals` stays on 4 for `vitest-evals`): `maxWorkers`
  replaces `poolOptions.forks`, `coverage.all` is gone, the configs use `import.meta.dirname` and
  extensioned imports. Behaviour your tests may meet: `clearMocks` defaults to `true`, an unawaited
  `.resolves`/`.rejects` fails, `-t` matches the `>`-joined full name.
- AG-UI `1.0.3` exact (`@ag-ui/core`, `encoder`, `proto`); `TOOL_CALL_RESULT.content` is read as
  `string | object` in the evals transcript.
- postgres.js 4: same API on a new pool and protocol; a `Date` sent to a `timestamp`/`date` column
  without a fixed type goes as UTC (every table here is `withTimezone: true`). OpenWorkflow 0.11
  still declares a `postgres@^3` peer; the pool Rocketpod hands it is v4 and its suites pass on it.
- CASL 7; `@casl/react` removed. `IfCan`, `IfCannot` and `usePermissions` are the UI's only gates;
  `AbilityContext` and `Can` are no longer exported.
- `@anthropic-ai/sdk` 1.x sends API version `2026-10-21` and the key as `Authorization: Bearer` to
  both `anthropic` and `anthropic_compatible` (one client constructor). The `anthropic` adapter never
  sends `temperature`; a compatible vendor still gets it where its model takes one. A proxy that
  reads `X-Api-Key` must change.
- `withRollingCacheBreakpoints` skips a `system`-role message.
- Vite 8 + `@vitejs/plugin-react` 6: Rolldown builds and Oxc minifies (`build.minify: 'esbuild'`
  dropped), `HttpProxy.ProxyServer`. `MagicLinkSentCard` moves to `ui/components/`, so
  `/magic-link/sent` splits into its own chunk.
- React 19 and React Router 7: the app imports `react-router`; `react-router-dom` 7 stays installed
  for plugins. No `future` prop on the routers; the vitest `ui` project resolves with Vite's
  `defaultClientConditions` (`tests/ui/router-instance.test.tsx`). React 19's ref types widen the
  Guide's `RefObject` props to `RefObject<T | null>`.
- CI hardening: every Action pinned as `owner/repo@<sha> # vX.Y.Z` (the Docker and Helm actions
  too), `persist-credentials: false` on every checkout, `timeout-minutes` on every job,
  `permissions: contents: read` at the top of `evals.yml`, `kit.yml` and `notify-plugins.yml`,
  gitleaks checked by SHA-256, `evals.yml`'s suite filter quoted, and `image.yml`'s `publish` job
  rebuilds without `cache-from: type=gha` (a cache any run can write never reaches a pushed image).


Plugins get an identity seam: `identityFor(c, id).signIn` signs a person a plugin proved in, `provisionFor(ctx, id)` provisions and deprovisions `idp` memberships, a plugin can add login-page methods and require SSO for its domains, and plugin public mounts are rate-limited and size-capped by the host.

- `@/plugins/api` gains `plugins/api/identity.ts`: `identityFor(c, id).signIn({ subject, email, emailVerified, name, tenantId?, role?, linkByEmail?, redirectTo? })` links the identity under provider `plugin:<id>` (`ProviderKey`, `linkPluginIdentity` in `auth/oauth-providers.ts`), admits, upserts an `idp` membership and mints the session; an existing account is linked by email only with `linkByEmail: true`, else `/login?error=account_exists` (`ERROR_CODES.accountExists`).
- `provisionFor(ctx, id)`: `findUser`, `upsertUser`, `setMembership`, `removeMembership`, `deprovision({ tenantId, userId })` → `{ removed, sessionsEnded, retained }` (the `idp` row plus the sessions pinned to that tenant, `deleteUserSessionsInTenant`), `listMembers`. `services/idp-tenancy.ts` exports `upsertIdpMembership`, `removeIdpMembership`, `deprovisionIdpMember`, `blockDeprovisioned`, `liftIdpBlock`.
- `TENANCY_MODE=single`: the seam takes only the one tenant's id; `deprovision` also blocks the person (`users.blocked_source = 'plugin:<id>'`, every session ended) and only the same plugin's `setMembership` lifts it; admin blocks write `manual` (`setUserBlocked`), shown as "blocked by identity provider" on `UserDetail.tsx`; `PUT /api/admin/tenants/:id/external-org` answers 404 `tenancy_mode_single`.
- `ServerPlugin.loginMethods(cfg)` (`api/auth/plugin-login-methods.ts`) → `GET /auth/methods` `pluginMethods` (`pluginLoginMethodSchema` in `@rocketpod/shared/auth`); `Login.tsx` renders each (an email field when `askEmail`; a method's `errors` is copy for its own `?error=<id>.<name>` codes; `?email=` refills it); a `startPath` outside `/api/hooks/<id>/` is dropped.
- `ServerPlugin.ssoPolicy(db, email, { config })` (`api/auth/sso-policy.ts`, `routes/auth/sso.ts`): a claimed address is refused magic link (a token-free "use single sign-on" email instead, still 202 — `requestSignInEmail`, `ssoRequiredEmail`), magic-link verify, Google, Microsoft, OIDC, dev login (403 `sso_required` + `details.method`) and other plugins' `signIn`, landing on `/login?error=sso_required&method=`. A throwing policy fails closed; `BOOTSTRAP_ADMIN_EMAILS` are exempt.
- Public mounts (`/api/hooks/<id>`) take an optional third tuple element `{ rateLimit?: { max, windowSeconds } | false; bodyLimitBytes? }` (`PluginPublicMountOptions`): `mountPublicRoutes` (`api/middleware/public-mounts.ts`) puts a per-IP limiter over `platform.rateLimiter` in front of each (bucket `hooks:<prefix>`, default 120 / 60 s), and `apiBodyLimit(publicBodyLimitOverrides(…))` at step 5 lets a mount replace the 1 MB cap (≤ `MAX_PUBLIC_MOUNT_BODY_BYTES`, 10 MB).
- `example-feature`: a development-only example SSO (`api/sso.ts`, `api/sso-policy.ts` claiming `@sso-required.example.test`, a login method) with its tests; scheduled tests let a plugin append tasks to a core cron.
- The Standard Webhooks verifier refuses a secret or signature that is not valid base64 (`atob`) instead of reading it leniently. A porting note over 150 lines now prints a warning from `release-check --unreleased` and `kit:release` (`noteLengthWarning`) rather than being a target only.

A new `/rp-agent-docs` skill audits and fixes the docs an agent loads, the WCAG contrast gate the UI docs promised now exists (two theme tokens that failed it were adjusted), and the oversized agent docs are split into per-directory `CLAUDE.md` files.

- `.claude/skills/rp-agent-docs/` — `SKILL.md` and `check.mjs` (zero-dependency mechanical check; exit 1 on a `✖`).
- `apps/web/tests/ui/contrast.test.ts` asserts the floors `src/ui/index.css` states over both themes; light `--tone-primary-surface` `#dbeafe` → `#eff6ff`, dark `--text-muted` `#a1a1aa` → `#acacb4`.
- `pnpm plugin add` refuses the id `api` (`pluginIdProblem`): it would install into `apps/web/src/plugins/api/`.
- `.claude/rules/api.md` (56 KB, past the 40,000-char load cap) and `apps/web/src/ui/CLAUDE.md` (42 KB) are split: new nested `CLAUDE.md` in `api/services/`, `api/queues/`, `ui/lib/`, `ui/pages/{agents,documents,chat,settings,guide}/`; `apps/web/src/plugins/CLAUDE.md` owns every plugin rule, with install/check detail and the public-mount and identity semantics in `.claude/skills/rp-plugin/reference.md`.
- `.claude/skills/rp-how-do-i/example-orders.md` carries an `agent-docs-check: hypothetical` marker; the Vite config's comments describe `coreEdits`.

The kit's `defaultPlugins` stays empty and is now described as an app's own list: a fresh clone installs no plugin, and the docs no longer say the kit installs analytics.

- `.claude/skills/rp-setup/SKILL.md`, `scripts/bootstrap.mjs`, `.rocketflare.json` `$defaultPlugins` and `docs/CONCEPTS.md` §8/§16 describe `defaultPlugins` as empty in the kit (analytics has no Rocketpod-compatible release yet) and the CI gate as `kit.yml`'s.

## How to apply

1. Add six columns to the Drizzle schema in `apps/web/src/db/schema/`:
   - `tenants.externalOrgId` (`text('external_org_id').unique()`) and `tenants.idpSyncedAt`
     (`timestamp('idp_synced_at', { withTimezone: true })`);
   - `tenantUsers.source` (`text('source', { enum: MEMBERSHIP_SOURCES }).notNull().default('manual')`,
     with `MEMBERSHIP_SOURCES = ['manual', 'idp']` exported from `tenant-users.ts`) and
     `tenantUsers.idpSyncedAt` (`timestamp('idp_synced_at', { withTimezone: true })`);
   - `users.globalAdminSource` (`text('global_admin_source', { enum: GLOBAL_ADMIN_SOURCES })`, with
     `GLOBAL_ADMIN_SOURCES = ['manual', 'idp']` exported from `users.ts`);
   - `userSessions.maxExpiresAt` (`timestamp('max_expires_at', { withTimezone: true })`).

   Then run `pnpm db:generate` and read the SQL: six `ADD COLUMN`s and one `UNIQUE` constraint,
   numbered after your own last migration. Never copy the kit's migration file. No RLS change: each
   table keeps its policy.
2. In `packages/shared/src/tenants.ts`, add `membershipSourceSchema = z.enum(['manual', 'idp'])` and
   `source: membershipSourceSchema.default('manual')` on `memberSchema` (the default keeps the CLI
   parsing a server that predates the column).
3. In `packages/shared/src/errors.ts`, add `idpManaged: 'idp_managed'` to `ERROR_CODES`.
4. Copy `packages/shared/src/idp.ts` from the kit, replacing the `@rocketpod/shared` scope in
   imports elsewhere with your own.
5. In `apps/web/src/config.ts`, add the six `OIDC_*` keys after `OIDC_TRUST_EMAIL`,
   `IDENTITY_WEBHOOK_SECRET` after `OAUTH_ENCRYPTION_KEY`, the two `superRefine` checks (issuer +
   client id; not `TENANCY_MODE=single`) and `isIdpManaged`. Add the keys to
   `apps/web/.env.example`, the Helm chart's `values.yaml` (the `OIDC_*` keys under `config`, the
   secret under `secrets`) and `docker-compose.yml` — `packaging.test.ts` fails otherwise.
6. In `apps/web/src/api/auth/cookies.ts`, add `IDP_SESSION_MAX_AGE_DEFAULT_DAYS = 7`. In
   `apps/web/src/api/auth/sessions.ts`: `CreateSessionInput.maxAgeMs` stored as `maxExpiresAt`, the
   first `expiresAt` the earlier of 30 days and that; `touchSession` sets `expiresAt` to
   `least(<now + 30 days>, coalesce(max_expires_at, 'infinity'))`; `resolveSession` selects
   `u.global_admin_source` and maps it onto the `User` it builds.
7. In `apps/web/src/api/routes/auth/helpers.ts`, add `'no_access'` to `LoginErrorCode`, and have
   `completeLogin` pass `maxAgeMs: isIdpManaged(cfg) ? cfg.OIDC_SESSION_MAX_AGE_DAYS * DAY_MS :
   undefined` to `createSession`, so every sign-in is capped.
8. In `apps/web/src/api/auth/providers/types.ts`, add `idTokenClaims?: Record<string, unknown>` to
   `OAuthProfile`. In `apps/web/src/api/auth/providers/oidc.ts`, return `idTokenClaims: claims` from
   `oidcProfile`, add `isAccessDeniedAtTokenExchange` (arctic `OAuth2RequestError` /
   `UnexpectedErrorResponseBodyError` matched against `UserLambdaValidationException|PreTokenGeneration failed`),
   and set `logout_uri` to the same `<APP_URL>/login?signedOut=1` in `oidcEndSessionUrl`. Skip the
   `logout_uri` line if your copy already has it.
9. In `apps/web/src/api/utils/db/tenant-helpers.ts`, give `CreateTenantForUserInput` optional
   `source`, `externalOrgId` and `idpSyncedAt`, written to the founding `tenant_users` row and the
   `tenants` row.
10. Copy `apps/web/src/api/services/idp-tenancy.ts`, `apps/web/src/api/auth/standard-webhooks.ts`
    and `apps/web/src/api/routes/identity-events.ts` from the kit, and mount the router in
    `apps/web/src/api/index.ts` beside `/auth`: `app.route('/api/identity', identityEventsRouter)`.
    If your copy has system tenants or other tenant columns `createTenantForUser` must set, set them
    there.
11. In `apps/web/src/api/services/auth.ts`, add `admittedBy?: 'idp'` to `AdmitInput` and, in
    `admitUser`, after the bootstrap branch and before the invitation branch, create the user and
    return when `input.admittedBy === 'idp'`.
12. In `apps/web/src/api/routes/auth/oauth.ts`: in the token-exchange `catch`, redirect `no_access`
    when `def.id === 'oidc' && isAccessDeniedAtTokenExchange(err)`; after the provider link is
    resolved, compute `managed = def.id === 'oidc' && isIdpManaged(cfg)` and
    `claims = managed ? readIdpClaims(cfg, profile.idTokenClaims, logger) : null`, pass
    `admittedBy: 'idp'` to `admitUser` when `idpClaimsAdmit(claims)`, run `reconcileIdpClaims` (on
    failure log and redirect `oauth_failed`) after `upsertProviderLink`, then `completeLogin` as
    before.
13. In `apps/web/src/api/services/members.ts`, select `source` in `listMembers` and throw
    `ConflictError(..., ERROR_CODES.idpManaged)` for a `source === 'idp'` target in both
    `changeMemberRole` and `removeMember`, right after the `support` check. A copy that locks the
    target row first (`lockTarget`) puts the check after the lock.
14. In `apps/web/src/api/services/admin.ts`, make `setGlobalAdmin` a no-op when the flag does not
    change and otherwise write `globalAdminSource: isGlobalAdmin ? 'manual' : null`.
15. In the UI, add `no_access` to `LOGIN_ERROR_COPY` in `pages/Login.tsx`, and in
    `pages/settings/People.tsx` lock the role and hide Remove for `m.source === 'idp'`, showing a
    "Managed" badge beside the role.
16. Add the `auth.idp_session_days` fact in `services/guide-facts.ts` and port the Guide copy in
    `start/signing-in.md` and `admin/members-and-invitations.md`, if your copy still has them.
17. Port the tests: the `OIDC_MANAGED_TENANCY` block (sign-in and identity events), the
    `tokenFailure` hook of the fake issuer and the `logout_uri` assertion in
    `tests/api/auth-oidc.test.ts`, and the managed-tenancy, role-map and webhook-secret cases in
    `tests/config/env-schema.test.ts`.
18. Port the docs: `docs/CONCEPTS.md` §1 (tenants managed by the OIDC issuer) and §2 (IdP-managed
    tenancy, identity events, gaps), `SETUP.md` 2.3c, the config line in `CLAUDE.md` and the
    `identity-events.ts` line in `apps/web/src/api/routes/CLAUDE.md`.
19. To turn it on for a deployment, follow `SETUP.md` 2.3c. Before an org's people first sign in,
    link any tenant made for it by hand whose slug differs from the org's (Admin → the
    organisation → Identity provider org). One with the org's slug is linked at the first sign-in.
20. Admin linking and deletion: add `externalOrgId` to `adminTenantListItemSchema`, `idpManaged`
    to `adminTenantDetailSchema` and `setTenantExternalOrgRequestSchema` in
    `packages/shared/src/admin.ts`, and `externalOrgTaken: 'external_org_taken'` to `ERROR_CODES`.
    Copy `setTenantExternalOrg` (and `externalOrgTaken`) into `services/admin.ts`, pass `cfg` to
    `getAdminTenant`, and add the `PUT …/external-org` and `DELETE /tenants/:id` routes to
    `routes/admin.ts`. Copy `useSetTenantExternalOrg` and `useAdminDeleteTenant` into
    `useAdminTenants.ts` and the two panels into `pages/admin/TenantDetail.tsx`. Add
    `externalOrgId: null` to any admin tenant fixture in `tests/ui/`.
21. Agents at volume: add `batchId` (`uuid('batch_id')`) and the indexes
    `agent_runs_tenant_status_idx` (`tenant_id, status`) and `agent_runs_tenant_batch_idx`
    (`tenant_id, batch_id` WHERE `batch_id IS NOT NULL`) to `apps/web/src/db/schema/agent-runs.ts`,
    and the partial index `ai_usage_tenant_run_idx` (`tenant_id, agent_run_id` WHERE
    `agent_run_id IS NOT NULL`) to `apps/web/src/db/schema/ai-usage.ts`; run
    `pnpm db:generate --name agent-volume` and `pnpm db:migrate`. `concurrency_key` and its backfill
    shipped earlier — nothing to backfill here.
22. Copy from the kit: `apps/web/src/api/services/agents/{replay,budget,fanout}.ts`,
    `apps/web/scripts/agent-replay.ts`, `apps/cli/src/commands/agents.ts`,
    `.claude/skills/rp-agent-replay/`, and the tests `apps/web/tests/api/{agent-replay,agent-volume,agent-runs-non-exclusive}.test.ts`,
    `apps/web/tests/config/{agent-replay-script,agent-policy}.test.ts`, `apps/cli/tests/agents.test.ts`.
    Add `agent-volume.test.ts`, the script, its test and `.claude/skills/rp-agent-replay/**` to the
    `feature-agents` surface's `paths` in `.rocketflare.json`, and `agent-replay.test.ts` (it records
    a `triage-research` run) to `example-agent-triage-research`'s. The volume and non-exclusive
    tests drive the test-only agents, and the CLI test installs keys of its own.
23. Port the diffs to `services/agents/{runs,runtime,registry,decisions}.ts`,
    `services/agents/examples/*.ts`, `services/ai/{agent-loop,usage}.ts`, `services/prompts.ts`,
    `routes/agents.ts`, `plugins/api/{ai,index}.ts`, `packages/shared/src/ai/{agents,pricing}.ts`,
    `packages/shared/src/errors.ts`, `apps/web/src/config.ts`, `ui/pages/agents/AgentsPage.tsx`,
    `apps/cli/src/cli.ts` and `tests/mocks/bindings.ts` (`RecordingWorkflow.failCreate`).
24. Add `"agent:replay": "dotenv -e .env -- tsx scripts/agent-replay.ts"` to `apps/web/package.json`.
25. Add `AGENT_MAX_ACTIVE_RUNS_PER_TENANT=50` and the blank `AGENT_RUN_MAX_TOKENS=`,
    `AGENT_RUN_MAX_COST_USD=` and `AGENT_TENANT_DAILY_COST_USD=` to `apps/web/.env.example`, and
    the four keys (empty) under `config` in `deploy/helm/rocketpod/values.yaml` —
    `packaging.test.ts` fails otherwise.
26. Change every `enqueueRun(db, platform, …)` in your own code to `enqueueRun(db, cfg, platform, …)`.
27. In each of your own agents: delete every `recordUsage(...)` and every `onUsage` that writes usage
    (the runtime writes one row per call; a second write double-counts); add `{ replay: 'rerun' }`
    to every `ctx.once` whose `fn` is only a model call; set `exclusive: false` where two runs in
    one organisation never share state; add `budget` to an agent that runs at volume; replace a
    hand-written turn cap and salvage with `meta.policy` passed as `policy: meta.policy`.
28. Tell anyone reading `ai_usage` that an agent run is now several rows (one per call), grouped
    by `agent_run_id`.
29. Run `node scripts/plugin-api-doc.mjs` to regenerate `docs/plugin-api.md`.
30. Concurrent tool calls: add `maxConcurrentToolCalls` (positive int, optional) to
    `agentPolicySchema` in `packages/shared/src/ai/agents.ts`, and replace the sequential loop in
    `runToolLoop`'s `executeToolUses` (`services/ai/agent-loop.ts`) with the kit's bounded worker
    pool (`executeSingleToolUse` + in-order `tool_result` emission). Default 4; `1` is the old
    sequential behaviour. Copy `tests/config/agent-concurrent-tools.test.ts`.
31. Plugin background storage: add `apps/web/src/plugins/api/storage.ts` (`filesStorage(platform)`
    over `platform.storage`, 503 `storage_not_configured` without one), use it for
    `RequestCtx.storage()` in `http.ts`, add `storage(): StorageService` to `BackgroundMethods` in
    `jobs.ts` (its `platform` parameter widens to `Pick<Platform, 'jobs' | 'realtime' | 'storage'>`),
    and re-export `StorageService`, `StoredObject` and `StoredObjectMeta` from `@/plugins/api`.
    Regenerate `docs/plugin-api.md`.
32. Copy `apps/web/src/api/utils/core/text.ts` and `tests/config/strip-control-chars.test.ts`, and
    strip in `services/ai/ingest.ts` (converted text, decoded upload text, `ingestText`'s text,
    each `chunks.text`) and `observability/span-store.ts` (`toSpanRow`'s strings and attributes).
33. Port `idempotencyKey` into `services/agents/runs.ts` (`idempotentRunId`, `ensureInstance`, the
    delete-on-create-failure branch). The engine's `create` is already idempotent on the run id, so
    there is no "already exists" handling to port.
34. Copy `apps/web/src/plugins/api/agent-runs.ts`; add `startAgentRun` to `BackgroundMethods` and
    `backgroundMethods()` (which now takes the context's `logger` and the whole `Platform`), and
    re-export `StartAgentRun`, `StartAgentRunInput` and `StartedAgentRun` from `@/plugins/api`.
    Add `storage()` to `ToolCtx` and `AgentCtx` in `plugins/api/ai.ts`.
35. Add `agent-runs.ts` and `tests/api/plugin-agent-runs.test.ts` to `feature-agents`' `paths`,
    and `jobs.ts#BackgroundMethods.startAgentRun`, `index.ts#StartAgentRun` and
    `tests/kit/unit.ts#recordingAgentRuns` to its `registries`.
36. Port the background builders in `apps/web/tests/kit/unit.ts` (`BackgroundCtxOptions`,
    `RecordedAgentRun`, `RecordsAgentRuns`, `recordingAgentRuns`, `Fake{Job,Cron}Ctx`), and make
    `RecordingWorkflow.create` in `tests/mocks/bindings.ts` idempotent on the id, as the engine is
    (it used to throw "already exists", which the concurrent-redelivery test trips over).
37. Port `composeNav`'s fold in `ui/components/SideNav.tsx` and its case in `tests/ui/sidenav.test.tsx`.
38. Add `'BackgroundMethods'`, `'StartAgentRunInput'` and `'StartedAgentRun'` to `EXPANDED` in
    `scripts/plugin-api-doc.mjs`, then run `node scripts/plugin-api-doc.mjs`.
39. In your own plugins, replace a job's workaround for starting a run (an HTTP call, a direct
    `agent_runs` insert) with `ctx.startAgentRun({ …, idempotencyKey: '<what>:<id>' })`, and a
    hand-built `platform.storage` read in an agent or tool with `ctx.storage()`.

40. Write `26` to `.nvmrc`, set the root `engines.node` to `">=26"` and `packageManager` to
    `"pnpm@10.34.9"`, `nvm install`, then `pnpm update -r --config.minimum-release-age=1440`. In
    the `Dockerfile` set `ARG NODE_VERSION=26` and replace `RUN corepack enable` with
    `RUN npm install -g "$(node -p "require('./package.json').packageManager")"` after the manifests
    are copied; in `apps/web/scripts/build-server.mjs` set `target: 'node26'`.
41. Run Rocketflare 0.25.0's step 10 with `@rocketpod` for the scope (shared, web, cli, evals; leave
    `apps/evals` on vitest 4), then `pnpm --filter @rocketpod/web remove @casl/react dotenv` (keep
    `dotenv` on `^17` if your own code imports it) and `pnpm install`.
42. Take the runtime's own current releases: `pnpm --filter @rocketpod/web add --save-exact
    pg-boss@12.38.1 openworkflow@0.11.0 ws@8.22.2 @aws-sdk/client-s3@3.1164.0
    @aws-sdk/lib-storage@3.1164.0 unpdf@2.1.0` and `-D esbuild@^0.28.2 pixelmatch@^8.0.0`.
43. In `apps/cli/src/auth.ts` `handleCallback`, add `Connection: 'close'` to the 404's headers.
44. `apps/web/vitest.config.ts`: `maxWorkers: MAX_WORKERS` for `poolOptions`, no `coverage.all`,
    `import.meta.dirname` for `__dirname`, `.ts` on the two `./tests/helpers/` imports, and the `ui`
    project's `resolve: { alias, conditions: [...defaultClientConditions] }`; `import.meta.dirname`
    in `vite.config.ts` and `apps/evals/vitest*.config.ts` too, and in `vite.config.ts` drop
    `minify: 'esbuild'` and type `onProxyError`'s parameter `HttpProxy.ProxyServer`.
45. `pnpm exec biome migrate --write`, then add the `noComponentHookFactories: "off"` override for
    `apps/*/tests/**` and `apps/web/src/plugins/*/tests/**`; hoist or `biome-ignore` what `src/`
    still reports.
46. In `services/ai/client.ts`, send `temperature` only for `anthropic_compatible` and build both
    providers' SDK client as `new Anthropic({ apiKey, baseURL: baseUrl || undefined, fetch,
    maxRetries: 2 })`; in `agent-loop.ts` `withRollingCacheBreakpoints`, skip `system` messages.
    Remove any `temperature`/`top_p`/`top_k` your own code sends to Claude.
47. Delete `createContextualCan`, `Can` and the `AbilityContext` export from
    `ui/components/permissions/`; replace your own `<Can>` with `<IfCan>`/`<IfCannot>` or
    `usePermissions().can(...)`.
48. Import `'react-router'` instead of `'react-router-dom'` everywhere under `apps/web` except an
    installed plugin's tree; drop the routers' `future` prop and the future-flag filter in
    `tests/ui/setup.ts`; copy `tests/ui/router-instance.test.tsx` and
    `tests/ui/permission-gates.test.tsx`; move `MagicLinkSentCard` to `ui/components/`.
49. `pnpm typecheck` and fix React 19's types: `useRef<T>(null)` is `RefObject<T | null>`, so widen
    the props that receive one.
50. In `.github/workflows/`, pin every Action by SHA (the SHAs in Rocketflare 0.25.0's step 2, and
    for `image.yml` `docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1`,
    `docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302 # v6.2.0`,
    `docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0`,
    `docker/login-action@8aa5831fb8d48d8f76594c7ddde61ae58019f550 # v4.8.0`,
    `azure/setup-helm@2f5e7bc67f1f9972ab16657bb795f36d8f04de0e # v5.1.0`); add
    `persist-credentials: false` under every checkout, `timeout-minutes` on every job, the top-level
    `permissions: contents: read`, the gitleaks SHA-256 check (Rocketflare 0.25.0's step 8), quote
    `${SUITE:+"$SUITE"}` in `evals.yml`, and drop `cache-from: type=gha` from `image.yml`'s
    `publish` step.

51. Add `blockedSource` (`text('blocked_source').$type<BlockedSource>()`, `BlockedSource` is
    `'manual'` or `` `plugin:${string}` ``) to `apps/web/src/db/schema/users.ts`, run
    `pnpm db:generate --name idp-blocked-source` and `pnpm db:migrate` (one `ADD COLUMN`).
52. Copy from the kit: `apps/web/src/plugins/api/identity.ts`, `apps/web/src/api/auth/{plugin-login-methods,sso-policy}.ts`,
    `apps/web/src/api/routes/auth/sso.ts`, `apps/web/src/api/middleware/public-mounts.ts`, and the
    tests `tests/api/{auth-sso-required,tenancy-single-identity}.test.ts`,
    `tests/config/public-mounts.test.ts`, `tests/driver/identity.test.ts`. A context you build
    for `provisionFor` by hand needs `platform` (`resolvePlatform(env)`); `identityFor` falls
    back to `resolvePlatform(c.env)` when the platform middleware did not run, and passes
    `platform.jobs` to `admitUser`.
53. Port the diffs to `auth/{oauth-providers,sessions}.ts` (`ProviderKey`, `linkPluginIdentity`,
    `deleteUserSessionsInTenant`, `blocked_source` in `resolveSession`), `routes/auth/{dev-login,helpers,magic-link,oauth,session}.ts`
    (`ssoDecisionFor` + `ssoAllows` before admitting; `ssoRequiredRedirect`; `pluginMethods`),
    `services/{admin,email,idp-tenancy}.ts`, `routes/admin.ts` (`requireMultiTenant` on the
    external-org route), `plugins/{types,server}.ts` (`loginMethods?`, `ssoPolicy?`,
    `PluginPublicMountOptions`), `plugins/api/{index,http}.ts`, `packages/shared/src/{auth,admin,errors}.ts`,
    `ui/pages/{Login,admin/TenantDetail,admin/UserDetail}.tsx` and `tests/ui/login.test.tsx`.
54. In `apps/web/src/api/middleware/body-limit.ts` add `MAX_PUBLIC_MOUNT_BODY_BYTES`,
    `isUnderPrefix`, `BodyLimitOverride` and `apiBodyLimit`; in `apps/web/src/api/index.ts`
    replace the step-5 `isUploadPath` ternary with
    `app.use('/api/*', apiBodyLimit(publicBodyLimitOverrides(publicMounts)))` and the public-mount
    loop with `mountPublicRoutes(app, publicMounts)`. A test-local app that exercises a limit
    needs `platformMiddleware` and an env whose `PLATFORM.rateLimiter` is set.
55. Port the test edits: the `login methods`, `sso policy` and public-mount-guard blocks of
    `tests/config/plugins.test.ts` and its helpers in `tests/helpers/plugins.ts`, the
    `/auth/methods` assertions that ignore `pluginMethods` (`tests/api/auth-session.test.ts`,
    `auth-oidc.test.ts`), `tenancy-single.test.ts`, and the `.slice(0, 2)` on the nightly cron's
    task list in `tests/api/scheduled.test.ts`.
56. If your copy still carries `example-feature`, copy its `api/sso.ts`, `api/sso-policy.ts`, the
    `loginMethods` and `ssoPolicy` entries in `index.ts`, the `EXAMPLE_SSO_*` constants in
    `shared.ts`, the `/sso` line in `api/public.ts`, its new `plugin.json` `uses`, its three test
    files and skill section 5.
57. Port `NOTE_LINES_GUIDE` / `noteLengthWarning` into `scripts/lib/upgrade-lib.{mjs,d.mts}`,
    `scripts/release-check.mjs` and `scripts/release.mjs`, with its case in
    `tests/kit-only/upgrade-notes.test.ts`.
58. Port the docs: `docs/CONCEPTS.md` §1, §2 and §16 (the identity seam, SSO required, public
    mount guards and their gaps), `SETUP.md` (an SSO / SCIM plugin under `TENANCY_MODE=single`),
    `.claude/rules/api.md` (steps 5 and 10, the two identity bullets),
    `apps/web/src/plugins/CLAUDE.md`, `apps/web/src/api/middleware/CLAUDE.md`, and the Guide's
    `start/signing-in.md`; then run `node scripts/plugin-api-doc.mjs`.
59. Copy `.claude/skills/rp-agent-docs/` (both files), and add it to root `CLAUDE.md`'s skills
    list and "you may run yourself" list and to `README.md`'s skills row.
60. Add `<!-- agent-docs-check: hypothetical -->` under the title of
    `.claude/skills/rp-how-do-i/example-orders.md` if your copy still has it.
61. Copy `apps/web/tests/ui/contrast.test.ts`; if you kept the kit's palette, set the light
    theme's `--tone-primary-surface` to `#eff6ff` and the dark theme's `--text-muted` to `#acacb4`
    in `apps/web/src/ui/index.css`, else run `pnpm web test:ui` and fix the pairs it names.
62. In `scripts/lib/plugin-lib.mjs` `pluginIdProblem`, after the barrel-filename check, return a
    problem for `id === 'api'`.
63. Take the kit's `.claude/rules/{api,ui}.md`, every `CLAUDE.md` under `apps/web/src/` and
    `.claude/skills/rp-plugin/{SKILL,reference}.md` for any you have not edited; for one you
    have, keep yours and run `/rp-agent-docs` on it.
64. Nothing to remove: an app's own `defaultPlugins` is its choice. Take the kit's wording for
    `.claude/skills/rp-setup/SKILL.md` steps 0 and 6 and its "after setup" table, and
    `docs/CONCEPTS.md` §8, for any you have not edited.

## Conflicts to expect

- `apps/web/src/api/auth/providers/oidc.ts` → `logout_uri` already added by hand in the app → keep one `searchParams.set('logout_uri', …)`.
- `apps/web/src/api/services/members.ts` → an app that rewrote the owner guard (row locks) → insert the `idp_managed` check after the target row is read, before any owner check.
- `apps/web/src/api/auth/sessions.ts` → an app that changed the `resolveSession` SQL (system-tenant filter) → keep the app's joins, add `u.global_admin_source` to the select list only.
- `apps/web/src/api/utils/db/tenant-helpers.ts` → an app with extra tenant columns → keep them, add `externalOrgId`, `idpSyncedAt` and `source` beside them.
- `apps/web/migrations/` → the kit's `0006_idp-managed-tenancy.sql` collides with the app's numbering → never copy it; `pnpm db:generate` writes the app's own.
- `apps/web/src/api/services/agents/runtime.ts` → the `AgentContext` literal is `withFanout({ … })` with `recordUsage`, the client is wrapped by `meterChatClient` → keep your own fields inside the literal.
- `apps/web/src/api/services/agents/examples/*.ts` → `recordUsage` calls deleted, `research-topic`'s salvage became `meta.policy` → delete yours the same way; never keep both.
- `apps/web/tests/helpers/test-agents.ts` → the test agents' usage writes deleted → a test counting `ai_usage` rows now sees one per call.
- `apps/web/src/ui/components/SideNav.tsx` → `composeNav` merges unlabelled groups → keep any nav ordering of your own beside the new branch.
- `apps/web/tests/kit/unit.ts` → the background builders return `Fake*Ctx` and take `BackgroundCtxOptions` → keep any builder options you added.
- `apps/web/src/api/services/ai/agent-loop.ts` → an app that edited `executeToolUses` (extra approval rules) → move the per-call rules into `executeSingleToolUse`; the pool owns ordering.

- `Dockerfile` → `corepack enable` gone, `NODE_VERSION` 26 → an image that pins its own base keeps it, but needs a pnpm installed without corepack on Node 26.
- Every `package.json` and `pnpm-lock.yaml` → versions, `engines`, `packageManager` → apply steps 40–42 instead of the hunks.
- `.github/workflows/**` → pins, timeouts, permissions → apply step 50 by hand.
- `apps/web/vitest.config.ts`, `vite.config.ts`, `biome.json` → apply steps 44–45 by hand if you edited them.
- `apps/web/src/ui/components/permissions/{AbilityContext.tsx,index.ts}` → `Can` and the context export removed → step 47.
- `apps/web/src/api/routes/auth/magic-link.ts` → the `admitUser` call takes `platform.jobs` → keep it; add the SSO check before it and move `requested` above it.
- `apps/web/src/plugins/api/identity.ts` → `admitUser` and `provisionFor` need the platform → read it as `c.get('platform') ?? resolvePlatform(c.env)`.
- `apps/web/tests/config/public-mounts.test.ts` → the kit's env carries `RATE_LIMIT_KV` and `cf-connecting-ip` → a `PLATFORM` with `createMemoryRateLimiter(kv)` and `x-forwarded-for`.
- `apps/web/src/ui/index.css` → two token values changed → keep your own palette's values and let the contrast test judge them.

## Verify

1. `pnpm gate` is green.
2. `pnpm web test:api -- tests/api/auth-oidc.test.ts` passes, including every `OIDC_MANAGED_TENANCY` case.
3. `pnpm db:migrate` on a dev database adds the six columns above.
4. With `OIDC_MANAGED_TENANCY=true` and no `OIDC_ISSUER`, the server refuses to boot naming `OIDC_MANAGED_TENANCY`.
5. `POST /auth/logout` with an issuer that advertises `end_session_endpoint` returns an `endSessionUrl` carrying both `post_logout_redirect_uri` and `logout_uri`.
6. A managed sign-in for a person with one org lands in that org's tenant, `/auth/session` shows `accessRequest: null`, `PATCH /api/members/<their id>` answers 409 `idp_managed`, and their `user_sessions` row has `max_expires_at` seven days out.
7. With `IDENTITY_WEBHOOK_SECRET` set, an unsigned `POST /api/identity/events` answers 401, and a signed `membership.removed` for that person and org answers 204 and removes the membership.
8. A tenant made by hand with an org's slug is that org's tenant after its first sign-in (no `-2`). A global admin links a hand-made tenant to an org id; the next sign-in with that org lands in it, not in a `-2` copy. `DELETE /api/admin/tenants/<id>` with the slug answers 204.
9. `psql "$DATABASE_URL" -c '\d agent_runs'` lists `batch_id uuid` and the two new indexes.
10. `pnpm web agent:replay triage-research --tenant <slug>` prints one line per settled run and a summary line.
11. `pnpm cli agents list` marks `triage-research` as batchable, and `pnpm cli agents run triage-research --batch questions.jsonl` prints one run per line.
12. `pnpm web test:config -- tests/config/agent-concurrent-tools.test.ts` passes.
13. A plugin job handler's `ctx.storage().put('tenants/<id>/<plugin>/x', …)` writes to the configured object store; with no `STORAGE_*` it throws 503 `storage_not_configured`.
14. `pnpm web test:api -- plugin-agent-runs document-convert-job traces` passes, including "a redelivered job answers the first run — even after it settled — and starts nothing".
15. `pnpm web test:ui -- sidenav` includes "folds unlabelled groups into the unlabelled group above them".
16. `node -v` prints `v26.`, `pnpm -v` prints `10.34.9`, and `pnpm --filter @rocketpod/web list zod postgres @anthropic-ai/sdk vitest vite jsdom react react-router --depth 0` shows `zod@4.`, `postgres@4.`, `@anthropic-ai/sdk@1.`, `vitest@5.`, `vite@8.`, `jsdom@30.`, `react@19.`, `react-router@7.`.
17. `grep -rnE 'uses: [^@]+@v[0-9]' .github/workflows` prints nothing, and each workflow has one `persist-credentials: false` per checkout.
18. `rg -n "@casl/react|<Can[ >]|from 'zod-to-json-schema'|future=\{\{" apps packages` prints nothing.
19. `docker build -t rocketpod:local .` succeeds and `docker compose up -d` answers `/healthz` with `{"status":"ok"}` (`docker run --rm --entrypoint node rocketpod:local -v` prints `v26.`).
20. `psql "$DATABASE_URL" -c '\d users'` lists `blocked_source text`.
21. In development `GET /auth/methods` lists `example-feature:demo-sso` under `pluginMethods`; with `APP_ENV=staging` it does not.
22. In development `POST /auth/dev-login` with `{"email":"a@sso-required.example.test"}` answers 403 `sso_required` with `details.method: "example-feature:demo-sso"`.
23. `pnpm web test:config -- tests/config/public-mounts.test.ts` passes, and the 121st request in a minute from one IP to `/api/hooks/<id>/…` answers 429 `rate_limited`.
24. `pnpm web test:driver -- identity` and `pnpm web test:api -- auth-sso-required tenancy-single-identity` pass.
25. `node .claude/skills/rp-agent-docs/check.mjs` ends `agent docs ok` (or lists `✖` findings and exits 1).
26. `pnpm web test:ui` passes, including `tests/ui/contrast.test.ts`.
27. On a fresh clone, `pnpm bootstrap` prints `no defaultPlugins declared — nothing to install` at `6/10 plugins`.
