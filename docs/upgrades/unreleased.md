---
version: unreleased
previous: 0.2.0
date: null
breaking: false
migrations:
  - "tenants.external_org_id (text, unique, nullable)"
  - "tenant_users.source (text manual|labs, NOT NULL default manual)"
  - "users.global_admin_source (text manual|labs, nullable)"
  - "user_sessions.ttl_seconds (integer, nullable)"
areas: [api, db, config, shared, ui, docs]
touches_surfaces: [feature-guide, example-guide-pages]
requires_surfaces: []
manual: true
---

## What changed

`OIDC_PRESET=labs` makes Labs Access the OIDC issuer: every sign-in reconciles tenants, memberships and global admin from the verified `labs_*` claims, and OIDC logout also sends `logout_uri` for Amazon Cognito.

- `config.ts`: `OIDC_PRESET` (unset | `labs`); `labs` needs `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `TENANCY_MODE=multi`; `isLabsPreset(cfg)`.
- `packages/shared/src/labs.ts`: `labsClaimsSchema`, the Labs Access claims contract (shape copied from labs-access `LabsClaimsSchema`).
- `services/labs-identity.ts`: `readLabsClaims`, `labsClaimsAdmit`, `reconcileLabsClaims`, `LABS_ROLE_MAP` (the app-overridable role map).
- `routes/auth/oauth.ts`: under the preset, claims admit a new person (not `SIGNUP_MODE`) and the reconcile runs before `completeLogin`; a 400 `UserLambdaValidationException` at the token exchange → `/login?error=no_access`.
- `services/auth.ts`: `AdmitInput.admittedBy: 'labs'` creates the user with no access request and no `onNoTenant`.
- `services/members.ts`: role change and removal of a `source='labs'` row → 409 `labs_managed` (`ERROR_CODES.labsManaged`); the list returns `source`.
- `auth/sessions.ts` + `routes/auth/helpers.ts`: a session may carry its own sliding window (`ttl_seconds`); preset sign-ins slide over 7 days (`LABS_SESSION_TTL_MS`), the cookie keeps 30.
- `services/admin.ts`: `setGlobalAdmin` records `global_admin_source = 'manual'`, so Labs never clears an admin-console grant.
- `auth/providers/oidc.ts`: the profile carries the verified payload (`idTokenClaims`); `oidcEndSessionUrl` adds `logout_uri` beside `post_logout_redirect_uri`.
- UI: `Login.tsx` copy for `no_access`; `People.tsx` shows a "Labs Access" badge and no controls on `labs` rows.
- Decision: a tenant the preset creates has no owner (`docs/CONCEPTS.md` §1).

## How to apply

1. Add four columns to the Drizzle schema in `apps/web/src/db/schema/`: `tenants.externalOrgId`
   (`text('external_org_id').unique()`), `tenantUsers.source` (`text('source', { enum:
   MEMBERSHIP_SOURCES }).notNull().default('manual')`, with `MEMBERSHIP_SOURCES = ['manual', 'labs']`
   exported from `tenant-users.ts`), `users.globalAdminSource` (`text('global_admin_source', { enum:
   GLOBAL_ADMIN_SOURCES })`, with `GLOBAL_ADMIN_SOURCES = ['manual', 'labs']` exported from
   `users.ts`) and `userSessions.ttlSeconds` (`integer('ttl_seconds')`). Then run `pnpm db:generate`
   and read the SQL: four `ADD COLUMN`s and one `UNIQUE` constraint, numbered after your own last
   migration. Never copy the kit's migration file. No RLS change: each table keeps its policy.
2. In `packages/shared/src/tenants.ts`, add `membershipSourceSchema = z.enum(['manual', 'labs'])` and
   `source: membershipSourceSchema.default('manual')` on `memberSchema` (the default keeps the CLI
   parsing a server that predates the column).
3. In `packages/shared/src/errors.ts`, add `labsManaged: 'labs_managed'` to `ERROR_CODES`.
4. Copy `packages/shared/src/labs.ts` from the kit, replacing the `@rocketpod/shared` scope in
   imports elsewhere with your own.
5. In `apps/web/src/config.ts`, add `OIDC_PRESET` after `OIDC_TRUST_EMAIL`, the two `superRefine`
   checks (issuer + client id; not `TENANCY_MODE=single`) and `isLabsPreset`. Add `OIDC_PRESET=` to
   `apps/web/.env.example`, `OIDC_PRESET: ""` to the Helm chart's `config` in `values.yaml`, and
   `OIDC_PRESET: ${OIDC_PRESET:-}` beside `OIDC_CLIENT_SECRET` in `docker-compose.yml` —
   `packaging.test.ts` fails otherwise.
6. In `apps/web/src/api/auth/cookies.ts`, add `LABS_SESSION_TTL_MS` (7 days). In
   `apps/web/src/api/auth/sessions.ts`: `CreateSessionInput.ttlMs` stored as `ttlSeconds`;
   `touchSession` sets `expiresAt` to `now() + make_interval(secs => coalesce(ttl_seconds, <30 days>))`;
   `resolveSession` selects `u.global_admin_source` and maps it onto the `User` it builds.
7. In `apps/web/src/api/routes/auth/helpers.ts`, add `'no_access'` to `LoginErrorCode` and the
   `options: { ttlMs?: number }` parameter to `completeLogin`, which passes `ttlMs` to
   `createSession` and then sets the cookie for `SESSION_TTL_MS` rather than the row's expiry.
8. In `apps/web/src/api/auth/providers/types.ts`, add `idTokenClaims?: Record<string, unknown>` to
   `OAuthProfile`. In `apps/web/src/api/auth/providers/oidc.ts`, return `idTokenClaims: claims` from
   `oidcProfile`, add `isAccessDeniedAtTokenExchange` (arctic `OAuth2RequestError` /
   `UnexpectedErrorResponseBodyError` matched against `UserLambdaValidationException|PreTokenGeneration failed`),
   and set `logout_uri` to the same `<APP_URL>/login?signedOut=1` in `oidcEndSessionUrl`. Skip the
   `logout_uri` line if your copy already has it.
9. In `apps/web/src/api/utils/db/tenant-helpers.ts`, give `CreateTenantForUserInput` optional
   `source` and `externalOrgId`, written to the founding `tenant_users` row and the `tenants` row.
10. Copy `apps/web/src/api/services/labs-identity.ts` from the kit. If your copy has system tenants
    or other tenant columns `createTenantForUser` must set, set them there.
11. In `apps/web/src/api/services/auth.ts`, add `admittedBy?: 'labs'` to `AdmitInput` and, in
    `admitUser`, after the bootstrap branch and before the invitation branch, create the user and
    return when `input.admittedBy === 'labs'`.
12. In `apps/web/src/api/routes/auth/oauth.ts`: in the token-exchange `catch`, redirect `no_access`
    when `def.id === 'oidc' && isAccessDeniedAtTokenExchange(err)`; after the provider link is
    resolved, compute `labs = def.id === 'oidc' && isLabsPreset(cfg) ? readLabsClaims(...) : null`,
    pass `admittedBy: 'labs'` to `admitUser` when `labsClaimsAdmit(labs)`, run
    `reconcileLabsClaims` (on failure log and redirect `oauth_failed`) after `upsertProviderLink`,
    and call `completeLogin` with `{ ttlMs: LABS_SESSION_TTL_MS }` for preset sign-ins.
13. In `apps/web/src/api/services/members.ts`, select `source` in `listMembers` and throw
    `ConflictError(..., ERROR_CODES.labsManaged)` for a `source === 'labs'` target in both
    `changeMemberRole` and `removeMember`, right after the `support` check. A copy that locks the
    target row first (`lockTarget`) puts the check after the lock.
14. In `apps/web/src/api/services/admin.ts`, make `setGlobalAdmin` a no-op when the flag does not
    change and otherwise write `globalAdminSource: isGlobalAdmin ? 'manual' : null`.
15. In the UI, add `no_access` to `LOGIN_ERROR_COPY` in `pages/Login.tsx`, and in
    `pages/settings/People.tsx` lock the role and hide Remove for `m.source === 'labs'`, showing a
    "Labs Access" badge beside the role.
16. Add the `auth.labs_session_days` fact in `services/guide-facts.ts` and port the Guide copy in
    `start/signing-in.md` and `admin/members-and-invitations.md`, if your copy still has them.
17. Port the tests: the `OIDC_PRESET=labs` block, the `tokenFailure` hook of the fake issuer and the
    `logout_uri` assertion in `tests/api/auth-oidc.test.ts`, and the `OIDC_PRESET` case in
    `tests/config/env-schema.test.ts`.
18. Port the docs: `docs/CONCEPTS.md` §1 (tenants from an external directory) and §2 (the `labs`
    preset, gaps), `SETUP.md` 2.3c, and the config line in `CLAUDE.md`.
19. To turn the preset on for a deployment, follow `SETUP.md` 2.3c: point `OIDC_ISSUER` at the
    Labs pool, fill in the client id and client secret from the Labs app client, set `OIDC_PRESET`
    to `labs`, and register the app's `/login?signedOut=1` page as the client's sign-out URL.

## Conflicts to expect

- `apps/web/src/api/auth/providers/oidc.ts` → `logout_uri` already added by hand in the app → keep one `searchParams.set('logout_uri', …)`.
- `apps/web/src/api/services/members.ts` → an app that rewrote the owner guard (row locks) → insert the `labs_managed` check after the target row is read, before any owner check.
- `apps/web/src/api/auth/sessions.ts` → an app that changed the `resolveSession` SQL (system-tenant filter) → keep the app's joins, add `u.global_admin_source` to the select list only.
- `apps/web/src/api/utils/db/tenant-helpers.ts` → an app with extra tenant columns → keep them, add `externalOrgId` and `source` beside them.
- `apps/web/migrations/` → the kit's `0006_labs-preset.sql` collides with the app's numbering → never copy it; `pnpm db:generate` writes the app's own.

## Verify

1. `pnpm gate` is green.
2. `pnpm web test:api -- tests/api/auth-oidc.test.ts` passes, including every `OIDC_PRESET=labs` case.
3. `pnpm db:migrate` on a dev database adds `tenants.external_org_id`, `tenant_users.source`, `users.global_admin_source` and `user_sessions.ttl_seconds`.
4. With `OIDC_PRESET=labs` and no `OIDC_ISSUER`, the server refuses to boot naming `OIDC_PRESET`.
5. `POST /auth/logout` with an issuer that advertises `end_session_endpoint` returns an `endSessionUrl` carrying both `post_logout_redirect_uri` and `logout_uri`.
6. A Labs Access sign-in for a person granted one org lands in that org's tenant, `/auth/session` shows `accessRequest: null`, and `PATCH /api/members/<their id>` answers 409 `labs_managed`.
