---
version: unreleased
previous: 0.2.0
date: null
breaking: false
migrations:
  - "tenants.external_org_id (text, unique, nullable)"
  - "tenants.idp_synced_at (timestamptz, nullable)"
  - "tenant_users.source (text manual|idp, NOT NULL default manual)"
  - "tenant_users.idp_synced_at (timestamptz, nullable)"
  - "users.global_admin_source (text manual|idp, nullable)"
  - "user_sessions.max_expires_at (timestamptz, nullable)"
areas: [api, db, config, shared, ui, docs]
touches_surfaces: [feature-guide, example-guide-pages]
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
- Admin: a global admin links a tenant to an issuer org, or unlinks it
  (`PUT /api/admin/tenants/:id/external-org`, `setTenantExternalOrg`, 409 `external_org_taken`,
  activity `tenant.idp_linked` / `tenant.idp_unlinked`), since a tenant made in the app is never
  matched by slug; and deletes an organisation (`DELETE /api/admin/tenants/:id`, the owner's
  `deleteTenant` with its slug confirmation), the only way to remove an ownerless one. The admin
  tenant DTOs carry `externalOrgId`, the detail `idpManaged`; `TenantDetail.tsx` gains the
  Identity provider org panel and a danger zone.

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
    link any tenant made for it by hand (Admin → the organisation → Identity provider org).
20. Admin linking and deletion: add `externalOrgId` to `adminTenantListItemSchema`, `idpManaged`
    to `adminTenantDetailSchema` and `setTenantExternalOrgRequestSchema` in
    `packages/shared/src/admin.ts`, and `externalOrgTaken: 'external_org_taken'` to `ERROR_CODES`.
    Copy `setTenantExternalOrg` (and `externalOrgTaken`) into `services/admin.ts`, pass `cfg` to
    `getAdminTenant`, and add the `PUT …/external-org` and `DELETE /tenants/:id` routes to
    `routes/admin.ts`. Copy `useSetTenantExternalOrg` and `useAdminDeleteTenant` into
    `useAdminTenants.ts` and the two panels into `pages/admin/TenantDetail.tsx`. Add
    `externalOrgId: null` to any admin tenant fixture in `tests/ui/`.

## Conflicts to expect

- `apps/web/src/api/auth/providers/oidc.ts` → `logout_uri` already added by hand in the app → keep one `searchParams.set('logout_uri', …)`.
- `apps/web/src/api/services/members.ts` → an app that rewrote the owner guard (row locks) → insert the `idp_managed` check after the target row is read, before any owner check.
- `apps/web/src/api/auth/sessions.ts` → an app that changed the `resolveSession` SQL (system-tenant filter) → keep the app's joins, add `u.global_admin_source` to the select list only.
- `apps/web/src/api/utils/db/tenant-helpers.ts` → an app with extra tenant columns → keep them, add `externalOrgId`, `idpSyncedAt` and `source` beside them.
- `apps/web/migrations/` → the kit's `0006_idp-managed-tenancy.sql` collides with the app's numbering → never copy it; `pnpm db:generate` writes the app's own.

## Verify

1. `pnpm gate` is green.
2. `pnpm web test:api -- tests/api/auth-oidc.test.ts` passes, including every `OIDC_MANAGED_TENANCY` case.
3. `pnpm db:migrate` on a dev database adds the six columns above.
4. With `OIDC_MANAGED_TENANCY=true` and no `OIDC_ISSUER`, the server refuses to boot naming `OIDC_MANAGED_TENANCY`.
5. `POST /auth/logout` with an issuer that advertises `end_session_endpoint` returns an `endSessionUrl` carrying both `post_logout_redirect_uri` and `logout_uri`.
6. A managed sign-in for a person with one org lands in that org's tenant, `/auth/session` shows `accessRequest: null`, `PATCH /api/members/<their id>` answers 409 `idp_managed`, and their `user_sessions` row has `max_expires_at` seven days out.
7. With `IDENTITY_WEBHOOK_SECRET` set, an unsigned `POST /api/identity/events` answers 401, and a signed `membership.removed` for that person and org answers 204 and removes the membership.
8. A global admin links a hand-made tenant to an org id; the next sign-in with that org lands in it, not in a `-2` copy. `DELETE /api/admin/tenants/<id>` with the slug answers 204.
