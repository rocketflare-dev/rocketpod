# CONCEPTS — what is built, and why

> **Rocketpod (D41).** A Node 26 server in containers: Postgres (+ pgvector) for everything stateful,
> an S3-compatible store for files, a model provider key for AI. Jobs and cron run on pg-boss,
> durable agent runs on OpenWorkflow, realtime on `ws` + LISTEN/NOTIFY — all in Postgres. Why it
> runs this way: `docs/DESIGN-SELFHOSTED.md`.

One section per subsystem: what it does, the invariant it protects, the decision behind it
(D-numbers), and its **Known gaps**. Check here before assuming a capability exists; update it when
you change one. **Keep it short** — a section states the rule and points at where the detail lives.
Conventions and mechanics belong in `.claude/rules/*.md` and the per-directory `CLAUDE.md` files;
setup in `SETUP.md`; the runtime in `.claude/rules/runtime.md`; RLS in `docs/RLS.md`.

| § | Section | § | Section |
|---|---|---|---|
| 1 | [Tenancy](#1-tenancy) | 9 | [AI layer](#9-ai-layer) |
| 2 | [Auth](#2-auth) | 10 | [Deployment](#10-deployment) |
| 3 | [API shell](#3-api-shell) | 11 | [CLI](#11-cli) |
| 4 | [Database](#4-database) | 12 | [Shared package](#12-shared-package) |
| 5 | [Background work and realtime](#5-background-work-and-realtime) | 13 | [Upgrading a copy](#13-upgrading-a-copy) |
| 6 | [Email and storage](#6-email-and-storage) | 14 | [Definition of done](#14-definition-of-done-for-the-kit) |
| 7 | [UI shell](#7-ui-shell) | 15 | [Feature flags](#15-feature-flags) |
| 8 | [Analytics](#8-analytics) | 16 | [Plugins](#16-plugins) |
|  |  | 17 | [Connectors](#17-connectors) |
|  |  | 18 | [The Guide](#18-the-guide) |

**Layout (D26).** A pnpm workspace: `apps/web` (the Node server — Hono API + React UI, §§1–10),
`apps/cli` (§11), `packages/shared` (zod contracts, §12), and `apps/evals` (developer-run eval
suites on vitest 4, §9 — never part of the gate).

---

## 1. Tenancy

**Every row of domain data belongs to a tenant, and the schema is the same for one tenant or many.**

- **`TENANCY_MODE = multi | single` (D25)** is configuration, not a fork. `multi`: users join many
  tenants via `tenant_users`, the session carries the current one. `single`: one tenant, every
  admitted user auto-joins as `member`; multi-only surface is 404 `tenancy_mode_single`
  (`requireMultiTenant`) and hidden via `useTenancyMode()`. Switching to `multi` needs no migration.
  The auto-join (`onNoTenant`) runs for a NEW person `SIGNUP_MODE` admits, for dev login and for a
  `BOOTSTRAP_ADMIN_EMAILS` admin (who creates the tenant on an empty database); a returning person
  with no membership gets a tenant-less session instead. Enterprise identity in single mode: the
  one tenant IS the deployment, so the identity seam takes only its id (another is a tenant that
  does not exist), a plugin's `deprovision` BLOCKS the leaver (§16), `OIDC_MANAGED_TENANCY` refuses
  to load (it creates one tenant per issuer org), and the admin console's issuer-org link and
  organisation delete answer 404 `tenancy_mode_single`.
- **`SIGNUP_MODE = open | invite_only | approval` (D9)**, default `invite_only`. Uninvited logins
  land on `/pending`; `approval` also files an `access_requests` row at *verify* time and
  queues an email to every active global admin for a NEW row (never for a re-login);
  `open` gives a personal tenant through `onNoTenant`. Whatever the mode, the `BOOTSTRAP_ADMIN_EMAILS`
  admin's first login on an install with NO tenant yet creates the first one (named `APP_NAME`, as
  owner) — the only other way to it was SQL — and never again once any tenant exists. Invitations are handled first on every login
  path, and every fallback gates on "has no memberships", not "is new". `POST /api/tenants` refuses
  a person with no membership whose access request is pending or rejected (403
  `pending_approval`; a global admin is not held by one), and one person's owned organisations stop
  at `MAX_OWNED_TENANTS_PER_USER` (default 10, global admins exempt, 403 `tenant_limit_reached`),
  counted under a lock on the user row so simultaneous creations cannot pass it.
- **Roles (D10).** `owner | admin | member` plus `support` (minted from `/admin`, visible to the
  customer); `users.isGlobalAdmin` is a platform flag. Default for a new subject: owner/admin/support
  `manage`, member `read` with route-scoped writes. "Own row" is always a route predicate — **CASL
  conditions are used nowhere**. Deleting a tenant and changing `owner` need an explicit
  `role === 'owner'` check. The matrix lives in `apps/web/src/permissions/` (+ its `CLAUDE.md`).
- **Admin area.** `/admin` + `/api/admin/*` behind `globalAdminMiddleware` is the only cross-tenant
  surface. A global admin with no membership can still reach it, so there is always someone to
  approve the first request. Entering a tenant creates a real `support` membership; it lasts only
  as long as the role: when `is_global_admin` clears, by demotion, a claim going or a suspension,
  every `support` row of that person goes in the same transaction, their sessions pinned to those
  tenants are unpinned, and their sockets there are closed.
- **Invitations carry authority, so they have the same limits as a role change.** Only an
  owner-level actor (`isOwnerLevel`) may issue or resend an `owner` invitation, on the single and
  bulk routes alike (403 before any row). A member removed from a tenant takes their pending
  invitations with them, in the removal's transaction, on the members route and on every path that
  ends an `idp` or a `support` membership for good; a global admin's stay, because their authority
  is the platform flag (so leaving support revokes nothing). Accepting over an `idp` row leaves the
  row as it is (the invitation is still marked accepted). Mail is bounded by Postgres: a resend
  inside `INVITATION_RESEND_COOLDOWN_SECONDS` (five minutes) answers 429 and keeps the link
  already sent, and `invitation_send_counters` caps the mail per UTC day per person across every
  tenant (`INVITATION_EMAILS_PER_USER_PER_DAY`, 500) and per tenant
  (`INVITATION_EMAILS_PER_TENANT_PER_DAY`, 1000), an upsert per scope with a conditional update so
  simultaneous sends cannot pass it. A bulk invite stops at the limit and reports the rest as
  `failed` / `send_limit`; one that queued nothing is the 429 itself. A 429 carries `Retry-After`.
- **Deleting a tenant has two halves.** The `tenantRef()` FK cascade removes everything in
  Postgres; the **`tenant.purge`** job (§5) removes the tenant's storage prefix and runs each
  plugin's `onTenantDeleted`. The jobs queue is checked *before* the `DELETE`.
- **Groups and visibility (D29).** Tenants declare group types → groups → members;
  `AuthContext.groups` is resolved with the membership (a Bearer key uses its **creator's** groups, looked up on
  every request). A restrictable resource has an explicit `visibility` column (`tenant | groups`)
  plus a junction table. **The column decides and the rows only grant**, so an empty grant list
  means "owner and admins only". It never falls back to "public". The predicate is SQL in
  `services/access.ts` (`accessScopeOf` → `visibleDocuments` / plugin predicates), **ANDed with the
  tenant predicate, never substituted for it**. Admin-level roles bypass it. On kit resources groups grant READ only; a plugin may define its own
  grants over its own resources (`edit`, `publish`) and enforces them itself.
  Deleting a group that still grants something is 409 `group_in_use` (`?force=1` narrows).
  `access.changed` nudges the affected users.
- **Tenants managed by the OIDC issuer (IdP-managed tenancy, `OIDC_MANAGED_TENANCY`, §2).**
  `tenants.external_org_id` (unique, NULL for every tenant the app made) ties a tenant to an org at
  the issuer, and `tenant_users.source` (`manual | idp`) says who manages a membership. The
  sign-in reconcile creates a tenant per org in the claims, keeps its name in step, and adds or
  removes the person's `idp` rows; identity events change them between sign-ins.
  **A tenant made in the app is linked by slug — decided:** on an org's first sign-in, an
  unlinked tenant whose slug is the claim's `slug` becomes that org's tenant, so a tenant made by
  hand (or before managed tenancy) is not duplicated. The issuer's slug is trusted to name it; a
  tenant already linked to another org is never taken. When the slugs differ, a global admin links
  it (Admin → the organisation → Identity provider org; `PUT /api/admin/tenants/:id/external-org`,
  409 `external_org_taken` when another tenant holds the org), and can delete a duplicate the
  org's first sign-in made (`DELETE /api/admin/tenants/:id`, the owner's delete with its slug
  confirmation), which frees the org for the link. Under managed tenancy the issuer decides which
  organisations exist, so `POST /api/tenants` and a slug change on `PATCH /api/tenant` answer 409
  `idp_managed`, whoever asks; the slug-link path above is only reachable from a tenant that
  already had the slug, made by hand or before managed tenancy.
  `idp_synced_at` on both tables records when the issuer last spoke about the row, so a stale event
  is skipped. **A tenant created this way has no owner — decided:** managed tenancy never writes
  `owner` (or `support`), so the last-owner guard only ever counts owners a person chose, and
  losing an org at the issuer can never delete a tenant's last owner. Ownerless is a state the kit
  already allows: owner-only actions stay open to global admins (`isOwnerLevel`), and an owner can
  be made later from a MANUAL membership. An `idp` row is read-only in the app — role change and
  removal answer 409 `idp_managed` (People shows a "Managed" badge instead of controls); manual
  rows in the same tenant work as ever.
- **Isolation = predicates + inert RLS (D1)** — §4, `docs/RLS.md`.

**Known gaps:** no IdP group sync (SCIM/SAML claims); no group hierarchy or per-group roles;
conversations, runs, prompts and non-Knowledge files have no visibility; agent-written documents
are always `tenant`; no audit log beyond `activity_events`; no personal API keys (tenant keys only).

## 2. Auth

- **Sessions are rows**: `user_sessions`, 30-day sliding TTL (`SESSION_TTL_MS`), never past the
  row's own `max_expires_at` when it has one (any sign-in under IdP-managed tenancy: sign-in +
  `OIDC_SESSION_MAX_AGE_DAYS`, at most 30 days, the cookie ending with it), cookie `__Host-session` (`HttpOnly`,
  `SameSite=Lax`, `Secure` outside development). `authMiddleware` resolves session → user →
  membership → groups → features in one query. The second strategy is a Bearer tenant API key
  (hashed, expiry, soft revoke), with scopes `authMiddleware` enforces on every request: `read`
  allows GET/HEAD/OPTIONS, `write` or `*` allows everything; anything else is 403
  `insufficient_scope`. The CASL check on the creator's role still applies on top.
- **Magic link** is the zero-credential path: a 256-bit, 15-minute, single-use, SHA-256-hashed
  token. With no `RESEND_API_KEY` the URL is logged, except when `APP_ENV=production`, where it is
  never written to the logs. Past five sign-in mails to one address in 15 minutes the route still
  answers 202 but mints nothing and sends nothing (`platform.rateLimiter`, keyed by a hash of the address). Opening the
  link consumes nothing: `GET /verify` redirects to `/magic-link/confirm`, and only its "Sign in"
  button (`POST /verify`, same-origin only) spends the token, so mail security scanners that fetch
  every link on delivery (Defender Safe Links, Mimecast) cannot. Dev-login exists and 404s in production.
- **OAuth is a registry** (D11): one generic `/auth/:provider` router over `ProviderDefinition`s
  (Google, Microsoft), each an `openid-client` code + PKCE flow (`providers/openid.ts`, HTTP Basic
  client auth). Microsoft discovers the `common` authority, so an `id_token` naming the person's own
  tenant is accepted and one naming another is refused; for Google and Microsoft an `id_token`'s
  claims are checked but not its signature (identity comes from userinfo / Graph). A token
  response must be `application/json`; an error body of any other type is `oauth_failed`.
  Redirect URIs come from `APP_URL`, accounts link by verified email (Microsoft: the user
  principal name, whose domain the directory must have verified, not `mail`), and tokens are AES-GCM
  encrypted under `OAUTH_ENCRYPTION_KEY`. The return path is `?returnUrl=`
  (`?redirectTo=` still accepted); the flow cookie carries state, PKCE verifier and a nonce.
- **Any OIDC issuer** (`providers/oidc.ts`): set `OIDC_ISSUER` + `OIDC_CLIENT_ID` (+ optional
  `OIDC_CLIENT_SECRET`) and an `oidc` provider appears, labelled `OIDC_LABEL`. Endpoints come from
  discovery (cached per isolate, refused unless its `issuer` matches exactly); code + PKCE S256 +
  `nonce`; the `id_token` is verified with jose against the issuer's JWKS (`iss`, `aud`, `exp`,
  `nonce`; an unknown `kid` refetches the set — rotation). The identity key is `${iss}|${sub}` in
  `oauth_providers.provider_user_id`, so no migration; a changed issuer falls back to
  verified-email linking. The issuer must assert `email_verified: true`: a missing flag is
  unverified (refused as `email_unverified` — no email linking, no admission) unless
  `OIDC_TRUST_EMAIL=true` opts in an issuer that controls the claim (single-tenant Entra); an
  explicit `false` is always refused. `AUTH_OIDC_ONLY=true` leaves the login page one "Continue with <label>" button (never an
  automatic redirect: a live issuer session must not become a silent login) and refuses
  `/auth/google|microsoft`. It also turns the magic-link routes off on the server: `POST /auth/magic-link/request`
  mints nothing (same 202), `POST /verify` answers `/login?error=oidc_only`, and `/auth/methods` says
  `magicLink: false`. Invitation emails carry an accept URL, not a magic link, so nothing else changes. With an `end_session_endpoint`, `POST /auth/logout` answers
  `200 { endSessionUrl }` (RP-initiated logout back to `/login?signedOut=1`, sent as both
  `post_logout_redirect_uri` and `logout_uri` — Amazon Cognito returns only on the latter); otherwise
  204. A token exchange the issuer refuses with HTTP 400 `UserLambdaValidationException` (a Cognito
  Pre Token Lambda denying the person) lands on `/login?error=no_access` — "You don't have access to
  this app" — not the generic error. Setup: `SETUP.md` → "Sign in with any OIDC issuer".
- **IdP-managed tenancy (`OIDC_MANAGED_TENANCY=true`)**: the issuer, not the app, says which of
  its orgs the person may use the app in. Its id_token carries them under `OIDC_ORGS_CLAIM`
  (default `orgs`): `[{ id, name, slug?, role }]`. The callback reads them from the payload
  `oidc.ts` already verified (zod, `@rocketpod/shared/idp`; missing or malformed → ignored and
  logged, the sign-in is plain OIDC) and runs `reconcileIdpClaims` (`services/idp-tenancy.ts`) on
  **every** sign-in, before `completeLogin` — linked users never reach `admitUser`, so it cannot
  live there. Roles map through `OIDC_ROLE_MAP` (`issuerRole:admin|member` pairs; an unmapped role
  skips the org); an existing manual admin/member row is adopted as `idp`, an `owner` or `support`
  row is left alone. An org gone from the claims deletes its `idp` row (with the member's tenant
  settings) and unpins sessions pinned to it. Admission comes from the claims, not `SIGNUP_MODE`:
  a person with an org, `OIDC_ADMIT_CLAIM` true or `OIDC_GLOBAL_ADMIN_CLAIM` true is created if
  new and never given an access request (any pending one is closed once they hold a tenant). The
  global-admin claim sets `is_global_admin` with `global_admin_source = 'idp'`; the claim going
  clears it only when that source is `idp` (the admin console writes `manual`). A person admitted
  with no org gets the normal no-tenant pages. Every session, a magic link's or a dev login's as
  much as an OIDC one, ends `OIDC_SESSION_MAX_AGE_DAYS` (default 7, at most 30) after sign-in
  however active it is, so everyone is reconciled from fresh claims at least that often. Writes
  never overwrite a newer change: a sign-in stamps what it writes with the token's `iat`, never
  over a row an event stamped later, and updates a membership only as it read it (an owner
  promotion in between wins; a row removed in between is inserted again, since the claims grant
  it); a removal deletes a row only if nothing has stamped it since the event. A first sign-in
  whose new tenant's slug clashes picks again, up to five times. Tenancy is §1.
- **Identity events (`POST /api/identity/events`)**: between sign-ins the issuer posts signed
  events (Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature`, verified
  against `IDENTITY_WEBHOOK_SECRET` over the raw body, five minutes' tolerance, two signatures
  during a rotation — `auth/standard-webhooks.ts`). `person.suspended`, `membership.removed`,
  `membership.role_changed`, `grant.revoked` (org-wide, or one person) and `org.suspended` remove
  or change `idp` memberships; `person.suspended` also ends the person's sessions and the global-admin
  role the issuer granted (a `manual` grant stays); `org.renamed`
  renames the tenant. Each does what the next sign-in's reconcile would, so nothing outlasts a
  sign-in that says otherwise (a suspended org's members are back when the issuer lets them sign
  in). The person is found by the OIDC link (`<issuer>|<sub>`), else by email: an event carrying a
  `sub` with no link can still reach an account by email, but never one linked to another subject at
  this issuer, while an event with no `sub` has only the email (a person before their first
  sign-in); the org by
  `external_org_id`. Applied before answering, idempotently and in any order: an event older than
  the row's `idp_synced_at` is stale and skipped, and a role change never creates a membership.
  204 for applied, stale, unknown person or org, and unknown type; 400 for a malformed known type;
  401 for a bad signature; 404 when not configured.
- **Plugin sign-in (the identity seam, §16)**: a plugin that proves a person itself — a SAML
  assertion, a per-tenant OIDC connection — finishes with `identityFor(c, id).signIn({ subject,
  email, emailVerified, name, tenantId?, role? })` (`plugins/api/identity.ts`), never by writing
  a session. The kit links the identity in `oauth_providers` under provider `plugin:<id>` (the
  plugin namespaces `subject`, e.g. `<connection>|<nameId>`), else finds the person by email, else
  `admitUser`s them — by `SIGNUP_MODE`, or as an IdP admission (`admittedBy: 'idp'`) when
  `tenantId` + `role` are asserted, which also upserts an `idp` membership through the same
  primitive the OIDC reconcile uses. Then `completeLogin` pins that tenant and sets the cookie.
  `emailVerified: false`, a blocked person, a stale tenant and a subject linked elsewhere are the
  usual `/login?error=` redirects. `ServerPlugin.loginMethods(cfg)` adds buttons to the login page
  (`GET /auth/methods` → `pluginMethods`, `<plugin id>:<method id>`), each a full-page navigation
  to a `startPath` under the plugin's own `/api/hooks/<id>/`, optionally behind an email field
  (`askEmail` → `?email=`, home-realm discovery). A method may carry `errors`, copy for its own
  `?error=<plugin id>.<name>` codes: its routes redirect a failed navigation to `/login` with one
  (and `?email=`, which refills that method's field), and the page shows the server-sent copy,
  never URL text; a code outside its namespace drops the method. They show under `AUTH_OIDC_ONLY` too: they are
  SSO, and `oidcOnly` turns the kit's non-SSO methods off. A plugin link is not listed on the profile's
  sign-in methods and cannot be unlinked there (`DELETE /auth/providers/:provider` knows only the
  kit's providers).
- **SSO required per email domain (`ServerPlugin.ssoPolicy`, `api/auth/sso-policy.ts`)**: once an
  organisation turns SSO on, its people may sign in ONLY through it. Core cannot know which
  domains are theirs — the connections and their DNS-verified domains live in a plugin — so it
  ASKS every installed plugin, in parallel, once per sign-in ATTEMPT (never per request: a minted
  session is trusted until it ends): `{ required: true, methodId }` names one of that plugin's own
  `loginMethods`, or `null`. Enforced server-side at: the magic-link request (no token is minted;
  a token-free "use single sign-on" email links to the login page instead — still 202 with the
  same body, so nothing leaks to the requester, and the real person learns where to go rather than
  waiting for a link that never comes), magic-link verify (a link minted before the policy
  existed is spent and refused), the Google / Microsoft / OIDC callback (the asserted email AND a
  linked account's own, checked before anyone is admitted or linked), dev login (403
  `sso_required` + `details.method`, so development shows what production does) and every
  plugin's `identityFor().signIn` — which passes only for a plugin that CLAIMED the address and,
  when its policy names a `connectionId`, only through that connection, so a second tenant's
  connection cannot sidestep the first's. Where the sign-in involves two addresses (asserted and
  account), each must be claimed by the connection signing in. `/auth/cli` and invitation acceptance
  need a session, so they inherit it; an invitee's magic-link request gets the SSO email with the
  invite as `returnUrl`. Refusals land on `/login?error=sso_required&method=<plugin id>:<method id>`
  and the login page offers that method directly (email prefilled from the SSO email's link),
  using the label `/auth/methods` gives — never text from the URL. **Decided:** a policy that
  THROWS (or answers garbage) **fails closed** for that email, logged at `error` — failing open
  would hand the magic-link door to anyone who can make the lookup fail; the claim is attributed to
  the throwing plugin, so its own sign-in still works. **Break-glass:** `BOOTSTRAP_ADMIN_EMAILS`
  are exempt (logged at `warn` when a claim is bypassed) — they live in deployment config only an
  operator can change, so a broken connection can never lock out the console that would fix it;
  `is_global_admin` alone is not exempt (it is a database flag). A `methodId` the plugin does not
  offer keeps the requirement and drops the hint.
- **Hardening (D12)**: random tokens hashed with SHA-256, a required encryption key, CSRF by origin
  allow-list (Bearer is exempt), and a sliding-window rate limit on login routes (the platform's
  `rateLimiter`: the `rate_limits` table — `src/node/limits.ts`, exact under concurrency, keyed by
  the client IP from `TRUSTED_PROXY_HOPS`). Return paths pass one rule, `isSameOriginPath` in
  `@rocketpod/shared/paths`: no control character or backslash anywhere, then same-origin
  (`redirectToSchema`, `safeRedirectPath`, `safeReturnUrl`). The OAuth flow cookie is `__Host-`.
  In production a sign-in link is never logged, and `/api/invite/:token` is logged as
  `/api/invite/[redacted]`.
- **CLI handoff (D26)**: `GET /auth/cli?redirect_uri=http://127.0.0.1:<port>/callback` allows only
  loopback targets and creates nothing: a signed-in person goes to `/cli/confirm`, and only its
  button (`POST /auth/cli/confirm`) mints the revocable tenant key `cli:<hostname>` and answers the
  loopback URL to navigate to. The CLI sends a random per-login `state`, the server passes it back,
  and the CLI ignores a callback without it. Details: `apps/web/src/api/routes/CLAUDE.md`.

**Known gaps:** no provider token refresh; no session management UI
beyond "log out everywhere"; CLI keys differ from other keys only by name. OIDC: one issuer per
deployment; the `groups` claim is read into the profile but **not stored or mapped** to kit groups
or roles; no `id_token_hint` on logout (id_tokens are not kept, so the issuer may ask to confirm);
no back-channel or front-channel logout; `OIDC_TRUST_EMAIL=true` trusts every email the issuer
sends (no per-domain rule) — set it only for an issuer that controls the `email` claim; the client secret
is sent as `client_secret_basic` only (no `private_key_jwt`). IdP-managed tenancy: without
`IDENTITY_WEBHOOK_SECRET` claims are as fresh as the last sign-in, so a removal waits for the next
sign-in or the session's end; an identity event the issuer gives up on is healed only then too;
events are applied in the request, not queued; a removal is not remembered once applied (the row
goes), so a sign-in whose id_token was issued in the second or two before a removal event, or
before a concurrent sign-in that cleared global admin, can restore what that removed until the next
sign-in or the session's end; one orgs claim, one role map and no per-org role
overrides; the app writes nothing back to the issuer; the slug is taken from the claim once and
never follows a later rename; `person.suspended` revokes no API keys: a key acts as its creator,
so the keys in the tenants they lost stop working, and those in their manual tenants do not.
Plugin sign-in: the kit trusts the plugin's word on `subject`, `email`, `emailVerified` and the
tenant entirely (proving them is the plugin's job); one plugin may not name another's id, but
nothing enforces that the id passed to `identityFor` is the caller's own; in multi mode
`deprovision` is per tenant by design and never blocks — a person a tenant's IdP deactivates keeps
their other tenants, the sessions selected to them and their keys there, and a session with NO
pinned tenant is not ended (it re-resolves to another membership, or to none); in single mode it
blocks (§16), but `removeMembership` alone leaves a signed-in person with no tenant, who can file
an access request; an IdP block is lifted only by `setMembership`, so a plugin that reactivates
without one leaves the person blocked; a link keeps working after the proof behind it is gone
(a domain removed from a connection, an address later added to `BOOTSTRAP_ADMIN_EMAILS`): the
plugin re-checks its domains before `signIn`; and a plugin link is invisible on the profile
page. SSO required: sessions that already exist when a domain turns it on are not ended
(they run to their TTL), API keys are untouched, a throwing policy locks that email's non-SSO
sign-in until it recovers (only the bootstrap admins are exempt), linking a provider to a
signed-in account is not checked, and the host trusts the plugin's word that it owns the domain.

## 3. API shell

- **One app, one Node entry (D5, D41)**: `api/index.ts` exports `app` (tests call
  `app.request(req, env, ctx)`); **`src/node/server.ts`** serves it on `@hono/node-server` in one
  of three modes (`SERVER_MODE` / first argument): `web` = API + the SPA's static files +
  `/healthz` liveness + `/readyz` pool ping (503 while draining); `worker` = jobs, cron and agent
  runs (§5), plus only the two probes; `all` = both, for dev and small installs. It reads
  `process.env` once into `loadConfig`, holds ONE Postgres pool per process (§4), hands the app a
  `waitUntil` backed by a tracked defer set, and on SIGTERM flips readiness, stops the listener,
  stops the workers, drains the defer set and closes the pool. `pnpm build` bundles it into
  `dist/server.js` and the migrate one-shot into `dist/migrate.js` (`scripts/build-server.mjs`,
  esbuild, no `node_modules` at runtime); `pnpm dev` runs it under `tsx watch` beside Vite.
- **Config (D3/D4)**: `loadConfig(env)` validates the runtime env with zod once per env object.
  Routes read `c.get('config')`. `APP_ENV` replaces `NODE_ENV`; `process` (and Node's server
  modules, and `@hono/node-server`) appear only in `src/config.ts` and under `src/node/`, and
  nothing else imports that directory (`tests/config/platform-seam.test.ts`).
- **Client IP**: one rule, `clientIpOf(c)` (`api/utils/routes/client-ip.ts`), for rate-limit keys
  and the auth audit: the socket's peer (passed on `executionCtx.props`, never on the per-process
  env); `X-Forwarded-For` is ignored unless `TRUSTED_PROXY_HOPS = N`, then the Nth entry from the
  right. Behind an ingress or load balancer, set it to the number of proxies you run.
- **The platform seam (D41)**: every runtime capability — jobs, storage, realtime, durable runs,
  rate limits and locks, document conversion — is a neutral interface in
  `src/platform/types.ts`, bundled as one `Platform`. Routes read `c.get('platform')`; queue
  handlers, cron tasks and the agent-run body (`api/workflows/agent-run-body.ts`, over a neutral
  `Step`) are handed the same object; plugins get it as `ctx.platform`. The implementation is
  `src/node/platform.ts`: jobs (pg-boss), runs (OpenWorkflow), realtime (`ws` + LISTEN/NOTIFY),
  storage (S3, when `STORAGE_*` is fully configured — else null and 503
  `storage_not_configured`), the rate limiter and operation locks (Postgres tables) and the
  document converter (`unpdf`/`mammoth`). Tests' `createTestEnv()` carries in-memory
  implementations (`tests/mocks/bindings.ts`). `tests/config/platform-seam.test.ts` also fails on
  any Cloudflare dependency, import or type, so the tree stays free of edge-runtime APIs.
- **Middleware order is deliberate** (error envelope → logger → config → platform → security headers → body
  limit → CORS → CSRF → DB → tracing → mounts). Auth is per mount. The static-file catch-all 404s
  every API prefix as JSON, so a missing route never returns `index.html`. Order and exceptions:
  `.claude/rules/api.md`.
- **Contracts (D13)**: zod schemas from `@rocketpod/shared` are used by the server, UI and CLI.
  There is no `hono/client` RPC. Errors are `{ error, statusCode, code?, details? }` everywhere,
  and success bodies are bare.
- **Routes are thin** and never run long work (§5).
- **Local dev ports**: Vite :3000 proxies to the Node server :3001 (`PORT`), both `strictPort`,
  unless `DEV_UI_PORT` / `DEV_API_PORT` are set (shell, then `.env`; `scripts/lib/dev-ports.mjs`
  is the one reader). Outside production CORS/CSRF also allow the loopback twin of `APP_URL` and
  of the request's own loopback origin. `SETUP.md` 1.6.

**Known gaps:** uploads answer 503 until `STORAGE_*` is configured; `pnpm dev:api` alone reads
`DEV_API_PORT` from the shell only, not `.env`; no OpenAPI (`@hono/zod-openapi` is the path); no
per-PR previews; no public tunnel for OAuth callbacks in dev (use your own, e.g. `cloudflared` or
`ngrok`, and set `APP_URL`); source maps are not shipped in the image.

## 4. Database

- **One driver, postgres.js (D35)**. postgres.js reaches any Postgres, Neon included, over TCP.
  `DATABASE_DRIVER` remains, accepting only `postgres` (missing means it), and
  `neon` fails config validation naming the fix. `openDatabase(env)` (`db/client.ts`) is the one
  resolver — URL `PREVIEW_DATABASE_URL ?? DATABASE_URL`. The Node entry installs ONE pool per
  process (`installProcessPool`, `DATABASE_POOL_MAX`, default 10, named prepared statements on)
  and every `openDatabase` for that URL is a view of it whose `close()` is a no-op; the pool is
  ended once on shutdown (tests and scripts open their own clients). The connection is pooled, so
  no session state, LISTEN or advisory lock on the request path.
- **Three pools per process.** pg-boss (`pgboss` schema, 2 connections producing, 4 working) and
  OpenWorkflow (`openworkflow` schema, `RUNS_CONCURRENCY + 4`) each keep their own small pool, and
  a `web`/`all` process holds one more dedicated connection for realtime `LISTEN` (§5). Size
  Postgres `max_connections` for (`DATABASE_POOL_MAX` + 6 + `RUNS_CONCURRENCY` + 4 + 1) × replicas.
- **The driver seam: code never sees the driver** (`src/db/CLAUDE.md`). `db/client.ts` is the only
  place it is named; everything else is normalised there or banned. Normalised: a raw
  `db.execute()` is `unknown` (`Database` is drizzle's `PgDatabase` base) and is read with
  `rows()` / `affected()`; raw arrays parse to arrays (`ARRAY_PARSERS` + `parseArrayLiteral`,
  because postgres.js runs with `fetch_types: false`); a SQLSTATE is read with `pgErrorCode()` /
  `isUniqueViolation()`. Raw timestamps are Postgres's text. Banned by
  `tests/config/driver-results.test.ts` (an AST scan over `src/`, installed plugins included,
  `src/node/` exempt): a cast, index or `.rows`/`.count` read on a raw result, a driver import, a
  SQLSTATE compared by hand, session state (a statement `SET`, `set_config(…, false)`, a session
  advisory lock, a temp table) outside a transaction callback — it would leak to the next request
  on that pooled connection — and `LISTEN` on the request path.
- **Proved every gate.** The `driver` vitest project is the conformance suite for the seam, through
  a per-request client and through a view of the process pool
  (`tests/config/driver-conformance.test.ts` fails a skip or a branch on the driver). Time limits
  scale by one latency factor per target (`vitest.config.ts`: 1 local, 12 on a remote gate
  branch); no test carries a budget of its own.
- **The gate** (`pnpm gate`, `scripts/lib/gate-lib.mjs`): lint → typecheck → test → build,
  stopping at the first failure (`--keep-going` runs all; `pnpm gate <step…>` and `--skip` are for
  iterating locally — no workflow passes `--skip`). It is the pre-commit gate and Launch's ship
  gate; a copy's CI (`ci.yml`) runs the SAME commands in parallel parts — `static` (gitleaks, then
  `pnpm gate lint typecheck build`), `pnpm test --only packages`, `--only api` and four
  `--only rest --shard i/4` jobs — behind ONE aggregate `Gate` job that `needs:` them all and is the
  required check. `pnpm gate --list --json` is the contract a step-by-step runner reads:
  `{ schema: 1, steps: [{ id, command, database }] }` in run order, validated by
  `packages/shared/src/gate.ts`; `schema` rises only when an existing field changes meaning, so a
  reader tolerates a new step or field. There is no generated-files step: the
  `docs/plugin-api.md` diff is the kit's own check (`kit.yml`), since a copy publishes no plugin
  API; `pnpm plugin check` runs at the end of `plugin add|upgrade --apply` (exit 8 when the written
  tree fails it) and in `plugin-ci.yml`.
- **Verified once (opt-in, for an app Launch ships).** After a green sandbox gate Launch's GitHub
  App posts a `launch/gate` check run keyed by the tree (`external_id: tree:<sha>`). With the
  repository variable `LAUNCH_GATE_APP_ID` set to that App's id, the first step of every `ci.yml`
  job (`scripts/gate-verified.mjs`, rules in `scripts/lib/gate-verified-lib.mjs`) looks for one from
  THAT app, `success`, for the tree CI is about to test — on a pull request the merge commit's tree,
  found on the PR head (so it holds only while the branch contains main's tip); on a push to main
  the pushed commit's tree, found on the commit or its PRs' heads. Found, `static` runs gitleaks and
  `pnpm gate build` only and the test jobs stop after the lookup; anything else — unset, another app, another tree, an API error — runs the
  full gate. Unset, no lookup runs at all. Trust is the app id: anyone with `checks: write` can name
  a check `launch/gate`, only Launch's App can post one under its id.
- **`pnpm test` picks its target from the environment** (`scripts/lib/test-plan.mjs`), never by
  probing, and prints it first. **Local** (the default): it starts the compose test Postgres itself
  (`docker compose … up -d --wait`; Docker down is a failure that names both fixes, never a skip),
  then every package and the web suite. `--only packages|api|rest` runs one part of that plan (a
  packages-only run starts no database) and `--shard i/N` slices `rest` with vitest's own `--shard`
  — CI's parallel jobs; `gate.test.ts` proves the parts are the whole plan and the shards the
  unsharded run. The narrow scripts (`pnpm web test:api|ui|config|driver`)
  are the inner loop: no compose management. `GATE_SUITE_DRIVER` is refused (one driver).
- **Remote target — an ephemeral test database** (`pnpm test` with `TEST_DATABASE_BRANCH` set): the
  whole gate's tests where there is no Docker — a coding sandbox, whose orchestrator creates a
  throwaway database branch per gate attempt and passes its owner connection string, reached by
  postgres.js over TCP. The runner sets `TEST_DATABASE_EPHEMERAL=1` and an empty
  `APP_DATABASE_URL` (the app role stays NOLOGIN) and runs every web project.
  `TEST_DATABASE_EPHEMERAL=1` without a branch is refused. `safetyCheck()`
  (`tests/helpers/db-safety.ts`) still refuses any non-local `DATABASE_URL` unless ALL hold: that
  profile, a `*.neon.tech` host, `TEST_DATABASE_BRANCH` matching `^gate-[a-z0-9]+-\d+$`, and
  `TEST_DATABASE_ENDPOINT` equal to the `ep-…` id in the URL. The branch name is not in a Neon
  connection string, so the name alone is only a claim; the endpoint id is, and binds the claim to
  that URL. The profile runs 2 forks (`TEST_MAX_WORKERS` overrides), a 60 s test and 120 s hook
  limit (`TEST_LATENCY_FACTOR` raises the factor on any target and never lowers it,
  `tests/helpers/latency.ts`), and skips `db-roles.test.ts` (a superuser to make owner roles).
  Global setup is unchanged: role → migrate → grants → truncate → seed; its FIRST connection
  (`db-roles`) waits for the database (`waitForDatabase`, `scripts/lib/sql.ts`) exactly as the
  migrator does. `migrate.ts`, `db-roles.ts` and `seed.ts` `process.exit` when done, as `db:check`
  does.
- **Conventions**: one file per table, `tenantRef()` + `timestamps()` (`timestamptz`), append-only
  enums, `vector(1024)` (a new dimension means a new table). `migrate.ts` creates the `vector`
  extension first. Detail: `.claude/rules/database.md`.
- **Local port is chosen** (`scripts/dev-db.mjs`): each checkout gets its own compose project and
  port, written back to `DATABASE_URL`, so two copies never share a database.
- **Or an existing database** (`pnpm bootstrap --db-url <url>`): for a machine with no Docker.
  The URL goes into `DATABASE_URL` and nothing is started (`--driver postgres` is accepted, `neon`
  refused). An off-box `DATABASE_URL` (not loopback) is left alone by `dev-db.mjs` and skips
  preflight's Docker checks. The seed runs there with `SEED_ALLOW_REMOTE=1`. A sandbox that already
  installed, made the database and knows it is migrated says so instead of paying for it again:
  `--no-install`, `ROCKETPOD_BOOTSTRAP_SKIP=<steps>` (any of steps 1–8 by name) and
  `ROCKETPOD_ALLOW_ROOT=1` (its commands run as root; the container is the boundary) — `SETUP.md`
  Part 1.
- **Migrations**: `db:generate` → read the SQL → `db:migrate` (role → migrations → grants).
  Migrations are forward-only.
- **Cross-tenant allow-list**: `tests/config/unscoped-allowlist.test.ts` fails a function that
  queries a `tenant_id` table without naming a tenant. Each exception carries a reason. It does
  not prove `admin.ts` is the only cross-tenant surface.
- **RLS** ships inert: every tenant table has `tenantIsolation()` (enforced by `rls-coverage`),
  and `TENANT_SCOPE_MODE=enforce` waits on the spike in `docs/RLS.md`.

**Known gaps:** the RLS spike has not been run; no read replicas; three pools per process (above); the process pool turns named
prepared statements on, so a PgBouncer in TRANSACTION mode in front of the Node server needs
1.21+ (`max_prepared_statements`) — there is no switch to turn them off yet; the TEST database's port
is fixed per app, not per checkout: the kit's is 5533 (Rocketflare's 5433), and the rename gives
every copy its own port block (`choosePortBlock`, rename row (g)), so the kits and any number of
apps run `pnpm test` side by side — but two clones of the SAME app still share one test port. `--db-url` with a loopback URL (a native Postgres) still looks like this
checkout's Docker database to preflight and `dev:db:*`, and a re-run of the bootstrap without the
flag checks for Docker again. The remote target's safety check still names Neon (`*.neon.tech`,
the `ep-…` endpoint) — the one hosted branch provider the gate-branch binding knows.

## 5. Background work and realtime

**A route never runs long work (D7).** Anything under 30 s total goes to the jobs queue
(`platform.jobs`), multi-step work goes to an agent run (`platform.runs`), and cron only
dispatches. All three run in a `worker` (or `all`) process; a `web` process only produces.

- **Jobs**: one queue, envelope `{ id, type, payload, enqueuedAt }`, variants are DATA
  (`CORE_JOB_VARIANTS` + plugin `jobs`). A mapped handler table proves completeness, so there is no
  switch. `type` is the version seam (`x.v2`). An invalid envelope is acked; a handler error retries
  with backoff. A handler sees its delivery count as `ctx.attempts` (1 on the first), and
  `isFinalJobAttempt(attempts)` (`@rocketpod/shared/jobs`, beside `JOBS_RETRY_LIMIT`) says it is the
  last one before the dead-letter queue — where a handler holding a claim row settles it instead of
  leaving it claimed. `sendBatch` answers the inserted jobs' ids. A missing queue is a 503
  `jobs_not_configured`. Consumers await everything and never use `waitUntil`. Queued today: `tenant.purge`, invitation and access-decision emails,
  `document.index`/`document.convert`, `chat.compact`. The magic link stays inline.
  Detail: `.claude/rules/api.md`.
- **Transport: pg-boss** in the `pgboss` schema (`src/node/jobs.ts`, `jobs-schema.ts`; `pnpm
  db:migrate` installs the schema and queues, never the server). The consumer wraps each batch of
  up to 10 as a `JobBatch` for the unchanged `processJobsBatch`; an unsettled message counts as
  acked and a throwing batch retries whole. Retries ride the queue's policy: three after the first
  delivery, 30 s doubling to 15 min (a handler's `retry({ delaySeconds })` is a floor, jittered),
  then the `rocketpod-jobs-dlq` dead-letter queue (kept 14 days). A job lost with its worker comes
  back after 15 min (`expireInSeconds`) and counts as an attempt. `JOBS_CONCURRENCY` (2) × 10 per
  worker, `JOBS_POLL_INTERVAL_SECONDS` (2).
- **Agent runs: OpenWorkflow (D41)** in the `openworkflow` schema (`src/node/runs.ts`; installed by
  `pnpm db:migrate`, never at boot) runs the run body (`runAgentRun`,
  `api/workflows/agent-run-body.ts`, §9) over the neutral `Step`. `RUNS_CONCURRENCY` (4) runs at
  once per worker; a parked run holds no slot; a dead worker's runs are replayed by another once
  their 30 s lease lapses (the in-flight step runs again — `runOnce` effects stay single). The body
  re-executes from the top and completed steps are memoised; retries happen in-process inside one
  step; a park is a thrown engine error the body rethrows (`Step.isControlFlow`). **Signals are not
  buffered**, so `waitForEvent` records an `arrived()` check before parking and `sendEvent`
  re-sends for up to 5 s while the run is alive (`docs/DESIGN-SELFHOSTED.md` §3.3). The kit's run
  id is OpenWorkflow's `idempotencyKey`; `agent_runs.instanceId` holds the engine's id.
  **Concurrency is a DB claim row, never a `Map`**: the exclusive index is per (tenant, agent,
  `concurrency_key`) — `''` for an exclusive agent, a caller's key to narrow it (one run per
  `document:<id>`, say), NULL for a run that holds no slot; `ACTIVE_RUN_STATUSES` (exclusive index,
  includes parked runs) ⊃ `CLAIMABLE_RUN_STATUSES` (the claim). Keep those two lists separate. A
  lost instance is settled on read, and there is no sweeper cron.
- **Cron**: `scheduled.ts` looks up the task by expression. `0 4 * * *` prunes; plugins add their
  own tasks to the registry. Every `SCHEDULED_TASKS` expression is a pg-boss schedule (UTC) synced
  at worker start (stale ones dropped); pg-boss claims each cron pass in the database and files each
  occurrence under a singleton key, so N worker replicas run an occurrence once. A failed cron task
  is not retried.
- **Realtime (D8)**: **"DB is the truth, WebSocket is a nudge"**: events carry ids, and the UI
  invalidates the query-key roots from `REALTIME_INVALIDATIONS`. The `entity` of `entity.changed`
  IS the query-key root. All nudges go through `services/realtime.ts` inside `defer`, after commit.
  `GET /ws` refuses an `Origin` outside the same allowlist as CORS and CSRF (a client with no
  `Origin` is not a browser and is unaffected). Removing a member, signing out, blocking a person,
  suspending a tenant, losing global admin and the identity provider's removals close the affected
  sockets (`close{User,Session,Tenant}Sockets` → `Broadcaster.closeSockets`, close code 4001).
- **Realtime transport: `ws` + LISTEN/NOTIFY** (`src/node/realtime.ts`). Every process PUBLISHES
  through `pg_notify('rp_realtime', {t, u?, e})` (jobs, runs and cron included), and every
  `web`/`all` process holds its own sockets (by tenant, tagged by user) and LISTENs on ONE
  dedicated connection — `DATABASE_LISTEN_URL`, else the database URL — delivering each
  notification to its matching local sockets, so a nudge reaches a socket on any pod. LISTEN needs
  a session: behind PgBouncer in transaction mode, `DATABASE_LISTEN_URL` must go straight to
  Postgres (or a session-mode pool). The upgrade runs the app inside an `AsyncLocalStorage` slot:
  `routes/ws.ts` stays the only auth and membership check, `hub.accept()` records the member, and
  `server.ts` completes the handshake only then (a refusal is written back as plain HTTP). Wire:
  events as JSON, `{"type":"ping"}` → `{"type":"pong"}`, a protocol ping every 30 s that drops a
  socket which missed the last one, and close code 1001 on shutdown. A NOTIFY payload over 7999
  bytes is logged and dropped — large data belongs in a row the client refetches. A lost listener
  reconnects with backoff; notifications sent meanwhile are lost (best effort).
- **Topics**: a channel a socket subscribes to by NAME — one row's live progress — instead of the
  tenant-wide fan-out. The kinds are a REGISTRY (`@rocketpod/shared/realtime` § Topics):
  `CORE_REALTIME_TOPICS` (empty — no kit page needs more than the tenant-wide nudge yet) plus each
  installed plugin's `SharedPlugin.realtimeTopics`, `{ prefix, subject, scope? }`, where the prefix
  is the plugin id or `<id>.<name>` (never `kit`) and `buildRealtimeTopicRegistry` refuses
  anything else at module evaluation. A `tenant` topic is `<prefix>:<tenantId>:<id>`
  (`tenantTopic`); a `platform` one `<prefix>:<id>` (`platformTopic`), for state no tenant owns.
  The client sends `{"type":"subscribe","topic":…}` / `unsubscribe` (`realtimeClientMessageSchema`;
  `websocketClient.subscribe(topic)` is reference-counted and resent on every open, so a reconnect
  resubscribes; `useRealtimeTopic(topic)` ties it to a page). `/ws` hands the hub `globalAdmin` and
  `canRead` — the registered subjects the MEMBERSHIP's role may `read` — and the hub keeps a topic
  only when `canSubscribeTopic` allows: a registered kind, `read` on its subject, and the socket's
  own tenant (a platform topic: a global admin). Anything else is silently refused, at most 64 per
  socket. `Broadcaster.toTopic(topic, event)` (`nudgeTopic`; a plugin's `ctx.nudgeTopic`) publishes
  `{t, k, e}`, delivered to the subscribed sockets of the tenant the topic NAMES (any tenant for a
  platform topic); an unregistered topic is logged and dropped. Events still go through
  `REALTIME_INVALIDATIONS`, so no component reads the socket.

**Known gaps:** `/api/admin` paths do not nudge; `notification.read` is never emitted;
`activity.record` has no producer; nothing consumes or redrives the dead-letter queue (`boss.redrive`
by hand); no pg-boss or OpenWorkflow dashboard is wired (OpenWorkflow's has no auth); OpenWorkflow
caps a run at 1000 step attempts; a plugin cannot register a durable workflow of its own;
`sendEvent` keeps re-sending for the full 5 s in the rare case the run skipped its wait;
`BroadcastResult.delivered` is always 0 (a publish cannot count remote sockets); a socket's topic
grants are fixed when it connects (a role change takes effect on the next connect); a subscribe is
not acknowledged, so a refused one looks like silence; topics are not persisted — a change made
while a subscriber was reconnecting reaches it only through its next refetch; a global admin with
no tenant membership has no socket, so no platform topic either; core publishes on no topic yet;
realtime has no
connection cap per tenant or user and no metrics; the missed-occurrence catch-up of a cron after
downtime is pg-boss's default, untested.

## 6. Email and storage

- **Email**: Resend over `fetch`, `sendEmail(...)`, neutral templates. With no key, messages are
  logged (`[email:dev]`, without the link when `APP_ENV=production`), never errors. The magic link is sent inline; other email is `email.send`
  jobs.
- **Storage (D23)**: the `StorageService` seam (`c.get('platform').storage`, any S3-compatible
  store). Keys are `tenants/<tenantId>/<scope>/<uuid>-<name>`. Bytes
  stream through the server (no presigned URLs). `get(key, { range })` reads `{ start, end? }`
  (end inclusive) or `{ suffix }` and answers `range: { start, end, total }` — what a `206`'s
  `Content-Range` needs, `size` staying the whole object's; past the end is
  `StorageRangeNotSatisfiableError` (a `416`). `putStream(key, stream)` stores a body of unknown
  length as a multipart upload, never whole in memory. `purgePrefix(storage, prefix)`
  (`services/storage.ts`) deletes one tenant DIRECTORY a page at a time — the tenant purge is it
  over `tenants/<id>/`; a prefix that is not a whole directory under `tenants/` is refused. The `files` table is the immutable index and the only thing the browser can name. Writes
  go object first, then row, and a failed insert deletes the object.
- **`/api/files`**: upload with per-scope type/size checks (413/415); tenant-scoped read (another
  tenant's file is 404) with ETag/304 and ONE HTTP `Range` (`parseByteRange`,
  `utils/routes/byte-range.ts`: `bytes=a-b` / `a-` / `-n` → 206 + `Content-Range`; malformed or
  several ranges are ignored → 200; past the end → 416 `range_not_satisfiable` with
  `Content-Range: bytes */<size>`; `If-Range` naming another ETag → the whole file;
  `Accept-Ranges: bytes` on every answer) — so a stored video seeks and a download resumes;
  **only allowlisted types render inline, everything else is
  an attachment**. Uploaders can delete their own files, admins any. A document-owned file is 409
  `owned_by_document`.
- **Framing is opt-in per response**: only a route that proved the type (`isEmbeddableMimeType`, PDF)
  sets `embeddable`, which relaxes `DENY` to `SAMEORIGIN` for that one response. It is set before
  the 304 early return. Never use a path allowlist for this.
- No storage (`STORAGE_*` not fully configured, so `platform.storage` is null) is 503
  `storage_not_configured`. `tenant.purge` pages through the
  tenant prefix and is idempotent.
- **The S3 adapter (D41)**: `STORAGE_DRIVER=s3` + `STORAGE_ENDPOINT` / `STORAGE_REGION` /
  `STORAGE_BUCKET` / `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` /
  `STORAGE_FORCE_PATH_STYLE` (`src/node/storage.ts`, `@aws-sdk/client-s3`): AWS S3, MinIO,
  Ceph, GCS interop — one adapter, the endpoint decides. It answers the quoted
  ETag, a listing with no content type or metadata, `deleteMany` in calls of ≤ 1000, a streamed
  body, a `Range` header parsed back from `Content-Range` (a malformed range is a `RangeError`
  before the request — S3 ignores one and answers the whole object — and a store that ignored a
  well-formed one is an error, never a silently wrong body), and `putStream` through
  `@aws-sdk/lib-storage`'s `Upload` (pinned with `client-s3`; 5 MiB parts, two in flight,
  aborted on a stream error). S3 lower-cases metadata keys, so the originals
  ride in `x-amz-meta-rp-keys` and come back case-preserved. Locally and in tests the store is the
  **Versity S3 Gateway** (Apache-2.0) in the compose files — MinIO's images are no longer published
  for anonymous pulls; `pnpm dev:db:up` starts it and writes the `STORAGE_*` lines into `.env`.

**Known gaps:** `avatarUrl` is global but the object is tenant-scoped (initials fallback elsewhere);
re-uploads leave the old object; no listing endpoint, quotas or presigned URLs; unbranded templates.
No Azure Blob adapter (not S3-compatible); metadata values travel as HTTP headers, so
non-ASCII values are not supported (the kit writes only ids and scopes); `put` reports the request
time as `uploaded` (S3's PutObject does not answer the stored one; `head`/`get` do), and so does
`putStream`. A range read is one range — no multi-range (`multipart/byteranges`). `putStream`
cannot resume: a failed upload is aborted and the caller sends the stream again. Nothing in core
calls `putStream` yet (uploads are multipart forms under `MAX_UPLOAD_BYTES`).

## 7. UI shell

- **Design tokens (D20)**: two DaisyUI themes in `shared/theme-tokens.css` (read by `ui/index.css`
  and by public-site stylesheets), where the brand hexes are the only
  hex values; `contrast.test.ts` gates them. Tailwind scanning is `source(none)` + explicit
  `@source` lines. A plugin's pages get the `../plugins/**/ui/**` line, and precompiled dependency
  CSS gets none.
- **Providers**: ErrorBoundary → QueryClient → Auth → Ability → WebSocket → Router. A global 401
  clears the cache and redirects to `/login?returnUrl=`.
- **Guards**: one `RequireGuard` primitive; nav items use the same guard as their page.
  `/login?as=` dev sign-in only works when the server reports `devLogin` and the email is a seeded
  account.
- **Data**: `api-client.ts` parses with shared schemas, there is one hook file per resource, and
  keys come from `queryKeys`. zustand holds only websocket state. Detail: `.claude/rules/ui.md`,
  `apps/web/src/ui/CLAUDE.md`.

**Known gaps:** no route preloading; no "system" theme or cross-tab sync; the dev quick-login list
is hard-coded.

## 8. Analytics

**The `analytics` PLUGIN (D31) — opt-in, and not installable yet (see gaps).** `plugins/analytics`
in `rocketflare-dev/rocketflare-plugins`. Once installed, its docs are its own `CLAUDE.md`
files. drizzle-cube cubes scope every `sql()` by tenant, dashboards are jsonb `DashboardConfig`s
restrictable to groups, fact tables rebuild on the `:15` cron, and its cube-isolation test is
mandatory. The kit core knows nothing about drizzle-cube, and other plugins extend it through
`analyticsExtensions({...})`. `bootstrap --no-plugins` gives a kit without it.

The kit still owns `activity_events`, the API-prefix list and Vite proxy its prefixes must be
added to, and the visibility registry it registers into.

**Known gaps (kit side):** `activity_events` has no retention; the published analytics release
still declares Cloudflare bindings, so `defaultPlugins` is empty and a fresh Rocketpod has no
dashboards until a container-ready release exists; fact refresh/check need a running server and CLI.

## 9. AI layer

Server: `api/services/{ai,agents}/**` (read their `CLAUDE.md`), `services/prompts.ts`,
`api/workflows/agent-run-body.ts`. Contracts: `packages/shared/src/ai/*`. Rules: `.claude/rules/api.md`
§ AI services.

- **One resolver (D17)**: `resolveChat` / `resolveEmbeddings` are the only readers of `ai_configs`
  / `agent_models` / `platform_agent_models` and the only place credentials are decrypted. Chat
  order: per-agent assignment → tenant default → platform `ANTHROPIC_API_KEY` → platform
  `AI_API_KEY` (OpenAI-compatible at `AI_BASE_URL` with `AI_MODEL` — OpenRouter, vLLM, Ollama — or
  OpenAI itself without a base URL) → 503 `ai_not_configured`. On the platform tier a prompt key
  runs its **platform default** model when there is one the tier can serve (same provider, and the
  same base URL for an `*_compatible` one; `source: 'platform_default'`, "platform pick" in
  Settings → Agent models), else the tier's own model. The platform default is a
  `platform_agent_models` row (prompt key → provider, base URL, model id; platform state, no tenant
  column — the kit ships no writer, so it is SQL or an app's own admin tooling), else the COMMITTED
  `PROMPT_DEFAULT_MODELS` entry in `@rocketpod/shared/ai/default-models` (empty in the kit — an app
  fills it from its own evals, each entry with its evidence); a row always wins. It sits BELOW the
  tenant's own config on purpose: it carries no credential, so it can only choose a model for the
  platform's own key, and a tenant that brought its own key and default model keeps both —
  overriding them would change what the tenant pays its provider for without the tenant deciding it
  (an admin who wants that pins the tenant's `agent_models` instead). Embeddings order: tenant → `EMBEDDINGS_API_KEY` (OpenAI, or
  OpenAI-compatible at `EMBEDDINGS_BASE_URL` with `EMBEDDINGS_MODEL`; `dimensions: 1024` is always
  sent, so the model must honour it) → 503. **There is no zero-key mode** (D41): no key means chat,
  agents and indexing answer 503; the gate needs none (tests point both at an in-process fake
  OpenAI-compatible endpoint). Credentials never leave the server (`hasCredential`), and a stored
  key stays with the provider and normalised base URL it was entered for: changing either needs the
  key again; every error is normalised to `AiError` with secrets redacted. Every `ai_configs` WRITE goes through
  `services/ai/configs.ts` (validate, encrypt, upsert, default swap, delete), so a second screen
  that manages a tenant's providers cannot drift from Settings → AI.
- **Providers**: `anthropic`, `anthropic_compatible`, `openai`, `openai_compatible`. There is no
  Vercel AI SDK and no Bedrock (a SigV4 adapter behind `ChatClient` is the extension). History rows
  written by the retired `workers_ai` provider still parse (`RECORDED_AI_PROVIDERS`) and show as
  unpriced. Defaults: `claude-haiku-5-5`, `gpt-6-luna`.
- **The request body is per MODEL, not per provider** (`shared/src/ai/models.ts`). Claude 4.5 and
  earlier take a thinking budget. 4.6+ take `adaptive`. "Off" is `disabled`, Sonnet 5.5's
  `between_tools`, or no field on models that always think (Opus 5.5, Fable). The Claude API takes
  no `temperature` (API version `2026-10-21`); an `anthropic_compatible` vendor still gets it. Opus/Sonnet 5.5 and Fable 5.1 refuse a forced tool, so a forced tool becomes a
  prompt instruction. First-party `openai` speaks the **Responses API** (`store: false`), because
  Chat Completions cannot call tools on GPT-6 Astra/6.1 Sol, nor on Luna while it reasons.
  Thinking off there means the lowest `reasoning.effort` the model takes. `openai_compatible` stays
  on Chat Completions; for Gemini (its endpoint or a `gemini-*` id) the adapter strips the tool-schema
  keywords the endpoint 400s on (`maxItems` — `unsupportedSchemaKeywords`) and restates the bound in
  the field's description, while our own parse still enforces it. Reasoning (Claude thinking blocks, OpenAI reasoning items) rides a tool loop
  as opaque `reasoning` blocks, returned unmodified to the provider that produced it. It is kept
  in checkpoints and never in chat history. Each adapter recovers ONCE from a refusal the traits
  misjudged (thinking, sampling, forced tool, effort, a replayed block's signature) and remembers
  it. So an unknown id costs one call, and it is read as the newest generation.
- **Images in a user turn**: `ContentBlock` has an `image` block (base64, PNG/JPEG/GIF/WebP —
  `IMAGE_MEDIA_TYPES`), sent as an Anthropic `image` block, an OpenAI-compatible `image_url` data
  URL (in a user message after the turn's tool results — a `tool` message is text-only) or a
  Responses `input_image`, and kept in tool-loop checkpoints. A tool result stays text, so a caller
  that wants the model to SEE a file a tool opened lifts it into the next user turn.
- **Agent loop** (`services/ai/agent-loop.ts`): `runStreamingChat`, `runToolLoop`, `callStructuredTool`, prompt
  caching helpers. `callStructuredTool`'s optional `tool.jsonSchema` is what the model is shown
  when it differs from the `schema` that validates: a caller that salvages the valid parts of an
  answer validates leniently and still asks for the strict shape. Prompts are code (`PROMPT_REGISTRY`) with per-tenant override rows.
- **AG-UI is the wire protocol (D28)**: `@ag-ui/core` is pinned exactly and imported only by
  `shared/src/ai/agui.ts`. The kit emits 15 events plus a `kit.` CUSTOM namespace (apps use their
  own prefix). It supports SSE (`data:` only, no `event:` line) or protobuf.
  `POST /api/agui/run` is the `RunAgentInput` endpoint. The server owns the transcript, the client
  supplies only the new message, and client `tools[]` are refused.
- **Chat**: owned by `userId`; `chat-turn.ts` is the one implementation behind `/api/chat` and
  `/api/agui`. Everything that can fail as JSON runs before the stream opens, and stream writes use
  `streamDatabase(c)`. A cancelled run emits no terminal event. Chat can call the three knowledge
  tools (`CHAT_KNOWLEDGE_TOOLS`), capped at 6 turns. **Long threads are compacted**: a
  character-budget window (`CHAT_HISTORY_MAX_CHARS`), with the dropped prefix folded into
  `conversations.summary` by the `chat.compact` job (compare-and-set) — its work is
  `compactConversation` (`services/ai/chat-compaction.ts`), callable on any thread. Document cards come from
  `kit.document` events produced by a pure mapper, so nothing about a card is stored. The admin
  inspector (`/stats`) is derived per request.
- **Agents (D7)**: `POST /api/agents/runs` enqueues (row → Workflow instance → 202); the exclusive
  index dedupes, per (tenant, agent, `agent_runs.concurrency_key`) — the SLOT a run holds: `''`
  for an exclusive agent (one per tenant), a caller's `enqueueRun({ concurrencyKey })` to narrow it
  to one active run per key, NULL for an agent declaring `exclusive: false`, whose rows sit outside
  the index so any number may be active at once. A caller who finds the slot held gets that run
  back (202, `deduplicated`) only if they may see it; otherwise a bare 409 `agent_run_active`, under
  `?strict=1` too. `enqueueRun({ idempotencyKey })` goes further —
  at most one run EVER per (tenant, agent, key): the run id is derived from the three
  (`idempotentRunId`, a SHA-256-shaped v8 UUID), so the primary key is the gate and a repeat
  answers the first run, settled or not; a failed `create()` deletes the row rather than failing
  it, so the retry can start it. A plugin starts a run from a job, cron or public handler with
  `ctx.startAgentRun` (§16), the same `enqueueRun`. A plugin agent reaches `ctx.interrupt`, the
  resolved `chatModel` and `storage()` through `AgentCtx` (`@/plugins/api`). The Workflow runs `claim → execute#N → (resume#N | expire#N) → finish`, and
  **every step name carries its round**, because a repeated name replays the recorded result.
  A retry resumes: `ctx.checkpoint` keeps the tool-loop transcript and `ctx.once(key, fn)` gives
  once-per-run effects (a DB unique index; at-least-once with a recorded result).
- **Human-in-the-loop (#17)**: `ctx.interrupt({ key, spec })` parks the run on
  `step.waitForEvent`. The key must be stable across attempts. Answering is a compare-and-set on the
  row, *then* a nudge to the instance (`not_found` → restart as `<runId>-rN`). There are four
  closed interrupt kinds (approval/choice/input/form). Model-called tools are gated on the tool
  (`requiresApproval`) before any handler runs, and an approval runs only the call the person was
  shown: that tool, those arguments (or their edit), once. Chat cannot park a turn, so
  `runStreamingChat` neither offers nor runs a tool that declares a gate. Artifacts are an upserted
  table, and steering notes are event rows delivered once.
- **Decisions (D37)**: `ctx.decide(key, { state, questions })` asks typed questions — `noul`
  (yes/no), `choice`, `score`, in TypeSafe's own vocabulary — and gets back an answer, a
  distribution and a `confidence` per question; `ctx.decide.sift` asks the same yes/no of every item
  in ONE request, `ctx.decide.pick` chooses one item or none. **A question decides what a thing IS;
  the agent's code decides what follows**, so a threshold is a number in code, not a prompt. Engine
  order (`resolveDecisions`, the one resolver): tenant `ai_configs(scope='decisions')` (provider
  `typesafe` — Jev, Settings → AI like any provider, with the same Test button) → platform
  `TYPESAFE_API_KEY` → the chat model on prompt key `agent-decide`, which reports its own
  probabilities and is recorded `method: 'llm_self_report'` (uncalibrated, labelled as such in the
  UI) → 503. Every call is one `agent_run_decisions` row, once per `(run, key)` like `ctx.once`: a
  re-entered `run()` replays the recorded answer, and the same key with different questions fails
  the run (`questions_hash` — the policy fingerprint, over the questions and not the state). Each
  call also writes `ai_usage` (`agent:<key>:decide`), a `decide <key>` span, and a thin `decision`
  event projected as `kit.agent.decision`; `GET /runs/:id` returns `decisions[]`. `triage-research`
  is the worked example (screen → triage → answer / not covered / escalate to `research-topic`), and
  evals score decisions per question with `DecisionJudge` (`expected.decisions`, accuracy + Brier)
  without a model call. Why: AgentRun-style decomposition — cheap, recorded, separately testable
  judgments instead of a model turn per decision.
- **Replay (D38)**: `pnpm web agent:replay <agent> --tenant <slug>` runs the agent's CURRENT code
  over its settled runs and reports what would change — the change you are about to make, checked
  against a thousand past cases in minutes, not against production. The replay context answers from
  the record: `decide` from `agent_run_decisions` (same questions about the same state → `served`;
  reworded → `drift`; same questions about a different state, because upstream code changed what the
  decision is about → `stale`), `once` from `agent_run_effects`, `interrupt` from
  `agent_run_interrupts`; anything the record cannot answer is a MISS (`strict`, the default — no
  model call at all) or asked for real (`--live`, which also re-runs a `ctx.once(key, fn, { replay:
  'rerun' })` — a pure model call whose prompt may have changed). `--live` reads the tenant's
  knowledge base, prompts and model choice as they are TODAY, through the server's own resolver —
  the tenant's configs first, then the platform keys in `.env` — and warns before starting when
  knowledge search would be unavailable (no embeddings provider resolves). Chunks do not record
  their model, so run it with the server's `EMBEDDINGS_*`. Each run replays in a READ ONLY
  transaction on an empty platform (no jobs, storage, realtime or run engine) and `ctx.db` refuses
  writes before they are sent (listed, not fatal). Per run: a verdict (`match` / `differs` /
  `incomplete`), the output diff by JSON path, and each decision's status; exit 1 unless every run
  matches. `--candidate <file>` replays another definition with the same key — how a compiled
  variant is proven against the full agent's history. Local script only: no route, no UI. Why: D37
  made the judgments recorded; replay makes the CODE around them testable.
- **Volume (D39)**: exclusivity is the `concurrency_key` slot above, so a non-exclusive agent
  (`triage-research`) runs any number at once — how many EXECUTE at once is the workers'
  `RUNS_CONCURRENCY`. Two tenant-wide gates sit on every enqueue:
  `AGENT_MAX_ACTIVE_RUNS_PER_TENANT` (default 50, 429 `agent_runs_limit` — a soft cap, counted then
  inserted) and `AGENT_TENANT_DAILY_COST_USD` (429 `ai_budget_exceeded`).
  `POST /api/agents/runs/batch` takes up to 100 inputs of one non-exclusive agent (400
  `agent_exclusive` otherwise), validates each and inserts them under one `batch_id`, then starts
  each on the run engine with its own `create()` — OpenWorkflow has no batch call, and `create` is
  idempotent on the run id — so only the rows that really cannot start are failed
  (`GET /runs?batchId=`, `rocketpod agents run <key> --batch x.jsonl`). Inside a run,
  `ctx.scope(prefix)` namespaces every keyed primitive (`once`, `decide`, `interrupt`, `artifact`,
  `step` → `prefix/key`; no checkpoint) and `ctx.map(key, items, fn, { concurrency, keyOf })` runs
  each item as a `once` in its own scope, at most `min(concurrency ?? 4, 6)` at a time: a retry
  replays the items that finished, the first error stops scheduling, and asks from several items
  become ONE park. No parent/child runs. Every call through `ctx.chat.client` and `ctx.decide` is
  metered — one `ai_usage` row carrying `agent_run_id`, awaited as the call returns, so a run
  cancelled or failed mid-loop has a row for every turn it paid for — and an agent writes no ledger
  rows (`ctx.recordUsage` for a client of its own); `GET /runs/:id` returns `usage`. The meter
  checks the run's budget before each call (`meta.budget` over `AGENT_RUN_MAX_TOKENS` /
  `AGENT_RUN_MAX_COST_USD`, plus the tenant's daily cap; tokens include prompt-cache reads and
  writes), starting from every earlier attempt's
  rows; over → `failed`, event code `agent_budget_exceeded`, never retried. Why: "thousands of
  cases a day" needs many runs, cheap fan-out inside one, and a ledger that can say what each run
  cost.
- **Policy (D39, issue #1)**: `meta.policy { maxTurns, maxToolCalls, maxConcurrentToolCalls,
  maxDurationSeconds, repeatedFailureLimit, onExhaustion }`, passed to `runToolLoop` as `policy`, is
  how far one run's loop may go; `AGENT_MAX_TURNS` stays the ceiling. A turn's tool calls execute
  concurrently up to `maxConcurrentToolCalls` (default 4; 1 is sequential) even with no policy, and
  their `tool_result` events are emitted in the model's request order; the remaining limits are
  opt-in. Every limit counts across attempts — turns and
  ACTIVE time ride the checkpoint (time parked on a person is not counted), tool calls and the
  failure streak are read back out of the transcript — and every call in the turn that crosses a
  budget still gets a result, because the next request must not carry an unanswered `tool_use`.
  Running out is behaviour the loop owns: `'final-answer'` (the default) makes ONE forced call to
  the loop's single terminal tool over the transcript (`salvaged: true`; what `research-topic`
  used to do by hand), and a salvage that fails fails the run; `'fail'` throws
  `ToolLoopExhaustedError` → `failed`, event code `agent_policy_exhausted`, never retried.
  **`authorizeTool(call)`** on the same loop is the deny-by-rule half of #3
  (`requiresApproval` is the ask-a-person half, #17): a refused call is never gated, never run, and
  the model is told why.
- **Reading runs**: `agent_run_events` is the durable log, and AG-UI is a pure read-time
  projection (`/agui`), also streamed live by tailing `seq` (`/agui/stream`, #7). A read-stream
  failure emits no `RUN_ERROR` (clients reconnect); `id:` goes on the last frame of a row's group,
  and reconciliation runs once before the first frame. Payloads never go over the tenant-wide realtime channel,
  because run visibility is per run.
- **Knowledge (D18)**: `documents` + `chunks` (pgvector HNSW). Text is ingested inline or by job;
  uploads go to storage, then the platform `converter` (`src/node/converter.ts`: `unpdf` for PDF,
  `mammoth` for .docx → markdown, HTML stripped to text, XML/text decoded), then the same indexer.
  The converter declares its `contentTypes`, and an upload it cannot convert is 415
  `unsupported_media_type` before anything is stored. Every text write strips NUL and the other C0
  controls except tab / LF / CR (`stripControlChars`, `api/utils/core/text.ts`) — some PDFs
  convert with NULs, which Postgres refuses (22021); the span store does the same over `ai_spans`
  (jsonb refuses `\u0000`, 22P05). Search is hybrid dense + lexical
  (the lexical half matches ANY query word, ranked by `ts_rank_cd` — `anyTermTsquery` — so a
  sentence's filler words cannot veto it — over `chunks.search_vector`, a STORED generated
  `to_tsvector(SEARCH_TEXT_CONFIG, text)` behind a GIN index) with RRF, scoped by `AccessScope`
  (§1). `searchChunks` takes an optional `documents` corpus (a predicate over `documents`) that is
  ANDed with the reader's visibility, so it narrows a search and can never widen it.
  `document-content.ts` is the one text reader behind both
  the viewer and `get_document`. Agent tools resolve the requester's access at execute time.
  **External ids (D34)**: `documents.external_id` is unique per `(tenant_id, source)` (partial
  index); an ingest carrying one is an upsert — one `ON CONFLICT` statement, grants
  replaced, chunks rebuilt (the old chunks go in the upsert's transaction, so a pending or failed
  re-index never serves the replaced text), a replaced original removed from storage — so a
  connector's re-sync never
  duplicates. Plugins reach it through `ingestDocument` (§16).
- **Usage**: one `ai_usage` row per call, costed at write time from the one price table
  (`shared/ai/pricing`, longest prefix wins; an unknown model gets `null` and is counted as
  unpriced). The two `*_compatible` providers are priced only for VENDOR-QUALIFIED ids — Fireworks'
  `accounts/fireworks/models/<name>` on both, Google's `gemini-*` on `openai_compatible` — so a
  self-hosted model stays unpriced. While a cost cap applies to a run the deployment pays for (the
  platform key), a chat call on an unpriced model is refused before it is made (run event
  `agent_budget_exceeded`, `BudgetLimit` `unpriced_model`), because its cost could never reach the
  cap. A tenant's own key is its own spend, so it is not refused.
- **Tracing (D32, supersedes D16's Langfuse ingestion client)**: `api/observability/`. Every AI call
  site talks to the `Tracer` seam; the recorder batches ended spans and flushes (in `waitUntil`, or
  awaited at the end of a stream, step or job) to two sinks: our own **OTLP/HTTP exporter**
  (`otlp-fetch.ts` — JSON by default, hand-encoded protobuf for backends that take nothing else,
  e.g. Phoenix; no dependency, no Node API) and the **local `ai_spans` table**, written whether or
  not a backend is configured (the request path opens its own short-lived client per non-empty
  flush). Attribute names — OTel GenAI semconv, OpenInference, Langfuse aliases — live in ONE module,
  `genai-attributes.ts`. Handles nest, and the active span rides `AsyncLocalStorage`, so a tool
  span (recorded by the kit's single tool runner — every tool, kit or plugin, chat or run),
  retrieval and embeddings nest without signature changes. **Workflow continuity**: a run's trace
  id is its uuid's hex and its root span id is derived from it, so each `execute#N` (a separate
  invocation) is a child of a root the `finish` step records once the run has settled. Covered:
  chat turns, agent runs, tools, retrieval, embeddings, the `chat.compact` / `document.index` /
  `document.convert` jobs. `OBSERVABILITY_PRESET` (`langfuse|phoenix|generic`) fills endpoint and
  auth — existing `LANGFUSE_*` keys migrate with no new secret; content capture is off by default,
  and `OBSERVABILITY_CAPTURE_CONTENT=true` records prompts, completions and tool I/O in both sinks; `pruneAiSpans` on the nightly cron keeps
  `OBSERVABILITY_SPAN_RETENTION_DAYS` (14). Read back through `GET /api/traces[/:id]` (`read
  Trace`, admin+ — spans hold other people's prompts) and `rocketpod traces list|show`; the
  `rp-traces` skill teaches an agent to debug from the span tree. Switch recipes: `docs/DEPLOY.md`
  § Tracing.

  **D32 decisions** (design grilling, 2026-09-25): our own OTLP exporter behind the existing seam —
  not a vendor-native tracer, not the Langfuse SDK · the backend is platform-wide only ·
  content capture is on by default, with a flag to disable · agent context comes from the CLI
  reading our own Postgres, not a backend REST adapter.
- **Evals (D33)**: `apps/evals`, its own workspace package because vitest-evals needs vitest 4 and
  the kit's suites are on vitest 5. `pnpm eval [suite] [--model x] [--judge-model y] [--compare]`
  runs `suites/**/*.eval.ts` against the TEST database with real models (the platform
  `ANTHROPIC_API_KEY` from `.env`; no key → every suite skips and says why). **Targets are
  in-process and go through the product's own code**: the chat target drives the real
  `POST /api/chat/conversations/:id/messages` route (so `prepareChatTurn` decides prompt, history and
  tools, as in production); the agent target runs `enqueueRun` → `claimStep` → `executeRun` →
  `finishStep` inline. Each case gets a tenant of its own with its `context` documents ingested, so
  retrieval can only find what the case put there. Everything a target does runs in
  `withEvalScope` (`observability/context.ts`), which marks its traces `rocketpod.eval=true`.
  **The harness input IS the `EvalCase`** (`shared/ai/evals.ts`: input, messages, context,
  expected `{ output, rubric, tools, toolsMatch, contains }`, tags, source), so judges read each
  case's own expectations; `describeCases` attaches to a case only the judges it declares something
  for, because vitest-evals averages a `null` score as 0, and its `gates` are judges a case must
  score exactly 1 on whatever its mean. Deterministic judges (`Contains`,
  `Matches`, `Schema`, `Trajectory` with agentevals' strict/unordered/subset/superset, `Budget`)
  come first; LLM judges (`Rubric`, `Faithfulness` against what retrieval actually returned,
  `Reference` = vitest-evals' `FactualityJudge`) run through ONE judge harness that calls the kit's
  resolver on the `evals-judge` prompt key — so `agent_models` can pin it, `--judge-model` overrides
  it, and every call is an `ai_usage` row under `evals.judge`. `--provider` / `--judge-provider
  fireworks|gemini` put the target or judge on a real encrypted tenant `ai_configs` row
  (Fireworks through the kit's own `fireworks` preset, Gemini as `openai_compatible`), so vendor
  comparisons also exercise the tenant-config tier. A run is a vitest JSON report in
  `.evals/runs/<ts>-<sha>.json` (git-ignored), stamped with the sha, models and prompt versions
  (`promptVersion(key, template)` = `<key>@<sha256 12 hex>`, `services/ai/prompt-version.ts`);
  baselines are committed per suite (`baselines/<suite>.json`, `pnpm eval:baseline`) and
  `--compare` exits 1 on a per-case, per-judge drop past `--threshold` (0.1). `pnpm eval:view`
  prints the score diff between two runs, then serves the vitest-evals report UI (runs, cases,
  transcripts, judge rationales). The optional `evals.yml` workflow runs it on manual dispatch or a
  `run-evals` label, outside the gate. How-to: `docs/EVALS.md`; the `rp-evals` skill drives it.
- **The eval coverage contract (D33)**: `@rocketpod/shared/ai/eval-coverage` maps every registry
  prompt and every agent (core, plus each plugin's own `SharedPlugin.evalCoverage`, core winning on
  a shared key) to `{ suite, datasets, baseline, minCases }` or `{ exempt: reason }`.
  `tests/config/eval-coverage.test.ts` FAILS the gate on a missing entry, an entry for nothing, a
  missing suite/dataset/baseline file or a thin dataset, and only WARNS on a stale baseline (its
  `promptVersions` differ from the template's `promptVersion`) or a provisional one (flagged, or
  carrying no versions). The warnings go to `apps/evals/.evals/gate-warnings.txt` and `pnpm test` /
  `pnpm gate` print them last; re-baselining is a person's call, never the gate's.
- **Feedback and promotion (D33)**: thumbs on assistant messages and run output
  (`POST /api/feedback`, `create Feedback` for every member, on an answer they can READ — another
  member's thread is a 404, admins included). One row per `(tenant, target, user)` in
  `ai_feedback`; voting again replaces, the same thumb twice withdraws. Each vote is also a
  zero-length `feedback` span under the answer's trace root (`rocketpod.feedback.rating`), shown by
  `rocketpod traces show`. AG-UI capabilities now declare `feedback: true` for chat and runs.
  Admins (`read Feedback`) list the queue (`rocketpod feedback list --rating down`) and
  `GET /api/evals/export?messageId|runId` drafts an `EvalCase` — question, history, the passages
  retrieved, the tools called, the OBSERVED answer as `expected.output`, the feedback — which
  `rocketpod evals promote <id> --dataset <name>` appends to a dataset after warning that it is
  tenant data (it will not write without `--yes` or a confirmed prompt).

  **D33 decisions** (design grilling, 2026-09-25, issue #21): vitest-evals as the runner, in its
  own vitest-4 package rather than a workspace-wide vitest upgrade or a home-grown runner · targets
  in-process, through the real route and runtime · no in-app eval UI (JSON runs + the report UI) ·
  datasets are code; promotion from real traffic and thumbs · the judge goes through the resolver,
  with a `--judge-model` override · in core, not a plugin · the `rp-evals` skill is a first-class
  deliverable. The prompt key is `evals-judge` (keys are kebab-case); the ledger feature is
  `evals.judge`.
- **Rejected**: per-instance agent state outside Postgres — it would sit outside RLS, the tenant FK
  cascade and cross-tenant indexes, and the inbox needs Postgres anyway. One `step.do` per model
  turn was also rejected: steps are unlimited in wall-clock time, and splitting would force every side
  effect outside a step to replay.

**Known gaps:** model traits are parsed from the id and hand-kept (`MODEL_TRAITS_CHECKED`), not read
from the Models API; no `effort` setting (thinking is on/off — on means the model's default); Haiku
5.5's > 100k-token price tier is not modelled (`pricing.ts` uses the ≤ 100k rate); OpenAI tools are
sent non-strict; an assistant message's `phase` is not replayed to the Responses API;
no Excel or OpenDocument conversion (refused at upload); no document summary or thumbnail (the card is an excerpt);
`charOffset` does not map to PDF pages; no image input in chat or uploads (the `image` block is for callers that build their own turns), and the tracer records image bytes like any other content (redact them yourself, or leave `OBSERVABILITY_CAPTURE_CONTENT` off); no images inside rendered
Markdown (a model's or document's image is shown as a link, `MarkdownImageLink`); no frontend tools
in chat and no human approval in chat (a tool with an approval gate is available to agent runs
only), no `STATE_DELTA`; protobuf has no
stream cursor; a cancelled chat stream closes silently rather than with AG-UI 1.0's `RUN_FINISHED`
`cancelled` outcome (the client that cancelled cannot read it); no token-level streaming for runs; char-based history budget
not derived from the model; sliding window defeats prompt caching on long threads; `enqueueRun`
does not pre-resolve the client; no
rerank; HITL asks cannot be amended, have no
reminders, and parks are bounded by `AGENT_INTERRUPT_TIMEOUT`; runs nobody opens
stay active-looking; no prompt versioning. Volume (D39): the active-run cap is counted, not locked,
so a burst can overshoot it; a budget is checked BEFORE a call, so a run overshoots by its last
call and, under `ctx.map`, by the calls in flight; **chat has no spend cap**: the run budgets and the
daily cap meter agent rows only, so a chat turn on a platform key is bounded by nothing but its turn
and output-token limits; the daily cap is a UTC day and TypeSafe is unpriced, so decisions count
toward tokens alone; `map`
runs inside one step on one DB client (six in flight is the ceiling, and a tool loop inside a scope
restarts on a retry — there is no per-scope checkpoint); a budget error raised inside a tool
handler is reported to the model as a tool error rather than stopping the run; a batch starts its
runs one `create()` at a time (no batch call on OpenWorkflow); no batch UI, no per-batch cancel,
and a batch's runs are not grouped on the runs page. Policy (D39): when a handler raises an
interrupt under concurrent execution, in-flight sibling results are discarded and run again on
resume (sequential execution never ran them at all); a salvage that succeeds and
then loses its step is paid for again; `maxDurationSeconds` does not count time between the last
checkpoint and a crash; a policy reaches a loop only when the agent passes it (`runToolLoop` has
no registry to read); `authorizeTool` is per loop, not a run- or tenant-wide rule. Decisions
(D37): no zod-schema → questions compiler, the `llm_self_report` fallback is uncalibrated with no vote/logprob
mode, TypeSafe calls are unpriced (no published rates), no per-agent decisions provider
(`agent_models` is chat-only), and a `sift` over 100 items is the caller's to batch. Replay (D38):
a tool loop's model turns are not recorded, so a `runToolLoop` agent (`research-topic`) replays
only `--live`; steering notes are all handed over at the first call; a run that predates a `once`
key misses it; no route or UI (a local script over a database URL), and `--live` holds one
read-only transaction per run. The demo seed's
vectors are deterministic, so dense search over seeded docs is noise. Tracing: no per-tenant
backends (BYO keys via `sealSecret`), no native `tracing.enterSpan`, no metrics export, no
Langfuse/Phoenix MCP; inline ingest from `POST /api/ai/documents/ingest` is untraced (no active
span); the backend receives a run's root only at `finish`, so an in-flight run has no root there;
exported content is capped at 32 000 chars per value. Evals: no in-app eval UI or dataset editor;
the report UI has no side-by-side view (the diff is `eval:view`'s terminal table); no HTTP targets
against a deployed instance, no red-teaming, no push to Langfuse datasets; a run that parks on a
person scores as a miss (an eval cannot answer it); run faithfulness sees each passage's
600-character event preview; without `EMBEDDINGS_API_KEY` retrieval in evals leans on the lexical
half of hybrid search; `--provider` knows three vendors (anthropic, fireworks, gemini) and the
latter two are unpriced; a thumbs vote is a
zero-length span, not an OTLP span event, and is not traced when the answer's root was pruned.
Coverage: `chat-compaction` has no suite (exempt); `agents-triage-research` is a provisional
placeholder baseline, so a fresh kit warns about it (and `agent-decide`) until it is run; the drift check compares the DEFAULT template, not a tenant's override; a plugin cannot
ship a suite (it cannot write under `apps/evals`), so its entries are exemptions until the host
writes one; `--compare` against a provisional baseline with no cases compares nothing.

## 10. Deployment

**One image, three modes, configured by environment (D41).** Runbook: `docs/DEPLOY.md`; the
`rp-deploy` skill drives it.

- **The image** (root `Dockerfile`): `pnpm build` in a build stage, then `node:26-alpine` with the
  two bundles (`dist/server.js`, `dist/migrate.js`), `dist/ui` and `migrations/` — no
  `node_modules`. Non-root, `ENTRYPOINT ["node","dist/server.js"]`, `CMD ["web"]`, a `/healthz`
  `HEALTHCHECK`. `node dist/migrate.js` is the one-shot (role → drizzle migrations → pgboss and
  openworkflow schemas → grants), the same sequence as `pnpm db:migrate`.
- **Compose** (root `docker-compose.yml`): pgvector Postgres, the S3 gateway, `migrate`, `web` and
  `worker`; `deploy/compose.single.yml` runs one `all` process instead. Values come from a root
  `.env` (template `deploy/compose.env.example`).
- **Helm** (`deploy/helm/rocketpod`): `web` and `worker` Deployments, the migrate Job as a
  `pre-install,pre-upgrade` hook, Service, Ingress (WebSocket upgrade), ConfigMap + Secret
  (`existingSecret` supported), PodDisruptionBudget. Postgres and S3 are external.
- **Scaling**: `web` replicas are stateless (realtime fans out over NOTIFY, §5); `worker` replicas
  are safe (pg-boss and OpenWorkflow claim work in the database; cron runs once).
- **Parity is a test**: `tests/config/packaging.test.ts` holds the Dockerfile to what the build
  produces, compose and the chart to valid modes and real config keys, and the chart's
  ConfigMap/Secret keys to exactly the vars and secrets `src/config.ts` declares.
- **Releases**: the release is the tag, which must equal the root `package.json` version
  (`release-check.mjs`); `image.yml` builds the image on every PR and push to main (no push, its
  layers cached to the GitHub Actions cache), and on a tag builds it WHILE its `ci` job waits for
  CI on the tagged commit; only once CI passed does `publish` push
  `ghcr.io/rocketflare-dev/rocketpod` from that warm cache. It also lints, renders and validates
  the chart. `ci.yml` runs the gate in parallel parts behind one aggregate `Gate` check — the
  secrets scan and `pnpm gate lint typecheck build`, then `pnpm test --only …` jobs (§4). The kit's renamed-copy and
  default-plugins gates, its porting-note and plugin-API checks live in `kit.yml` (`kitOnly`). An
  app releases by bumping the root version, adding its own `CHANGELOG.md` section and tagging;
  `pnpm kit:release` and porting notes are the kit repository's only (§13).

**Known gaps:** no live `helm install` has been verified; no image signing or SBOM; no
autoscaling defaults; the `web` preStop `sleep` needs Kubernetes ≥ 1.30; Launch cannot ship this
kit — its contract is Cloudflare-shaped (`launch.kit.json` `$runtime`).

---

## 11. CLI

A thin client over `/api/*` using a tenant API key. It parses with shared schemas and never keeps
a second copy of the contract (D26). `api.ts` is the only `fetch` site. Config lives in
`~/.rocketpod/config.json` (0600); `ROCKETPOD_API_KEY`/`ROCKETPOD_URL` override it for CI.
`--json` is available on every read. `traces list|show` reads the local AI trace store (D32);
`feedback list` is the thumbs queue and `evals promote <id> --dataset <name>` appends a draft eval
case to `apps/evals/datasets/` (D33, both admin+). `agents list`, `agents run <key> --input x.json |
--batch x.jsonl` (chunks of 100, failed lines reported, exit 1) and `agents runs list [--batch id]`
start and follow runs (D39). Exit codes: 0 ok · 1 error · 2 not logged in ·
3 forbidden.
No command prints a full key. Human output shows server text as inert text: `renderTable` cells,
free-text lines and the logger drop terminal control characters, and colour is applied after that
(a column's `style`); `--json` is unchanged. Plugins register top-level commands named after their id.
Detail: `.claude/rules/cli.md`.

**Known gaps:** no device-code flow; one profile at a time; `logout` does not revoke the key; no
shell completion; not yet published to npm (`rocketpod` / `@rocketpod/cli` are the intended names;
no publish workflow exists).

## 12. Shared package

`packages/shared` is private and has no build step: `@rocketpod/shared/<module>` resolves to
`src/<module>.ts` (so a plugin entry is `…/plugins/<id>/index`). Contracts come first (D13): a new
API surface starts here. Allowed imports: `zod`, siblings, type-only `@casl/ability`, and
`@ag-ui/core` only in `ai/agui.ts` (`shared-imports.test.ts`). It never imports `apps/*`, and
`src/plugins/**` never imports one of the five composers at runtime (that would create a module
cycle). Detail: `packages/shared/CLAUDE.md`.

**Known gaps:** no own test suite; no OpenAPI; no contract versioning between web and CLI.

## 13. Upgrading a copy

**A renamed copy with deleted examples still absorbs later kit releases (D27).** A copy upgrades
from Rocketpod releases (`kit.repo` is `rocketflare-dev/rocketpod`). `.rocketflare.json` and `rocketflare-plugin.json`
keep their names on purpose — they are the plugin ecosystem's fixed filenames (`KIT.ecosystem`).

- **`.rocketflare.json`**: kit `{id, repo, version, commit}`, the app's names (`app === null` means
  "this is the kit", asked only through `readManifest()`), `history[]`, `retiredSurfaces`
  (the kit's own, never deleted there; the rename drops it from a copy), and the **surface manifest**. Surfaces are `example`, `optional-feature` and
  `plugin`, each with an anchor file whose existence is its presence (delete the anchor to opt
  out). An example surface's `paths` are complete — its agent, output views, tests, eval suites,
  datasets and baselines — and a surface can `require` another (`triage-research` runs
  `research-topic`'s body), so removing one is deleting its `paths` and its registry lines; the
  kit's own `tests/kit-only/example-surfaces.test.ts` fails a test outside a surface that names its
  agent key or imports one of its files. Every other path is `neverPort`, `kitOnly`, `manual` or
  `core`; the kit's own `tests/kit-only/kit-manifest.test.ts` requires 100% coverage — an app's new
  paths never appear in a kit diff, so a copy owes the manifest nothing for them.
- **Kit-only files** (`kitOnly`): what is true of the kit repository and of nothing made from it.
  Its tests (`apps/web/tests/kit-only/**`, vitest project `kit-only`) — porting notes and the root
  version being the kit's, the release/rename machinery, the maintainer hook, plugin CI, the
  manifest's kit-state claims and coverage, the example surfaces' removability — which the kit's
  gate runs (`pnpm test` names the project only while its directory exists); its workflows
  (`kit.yml`, `plugin-ci.yml`, `notify-plugins.yml`); its maintainer scripts (`release.mjs`,
  `changelog-nudge.mjs` and `lib/nudge-lib.mjs`, `default-plugins.mjs`, `install.sh`); and its
  project files (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, the maintainers' ledger `docs/FORK.md`,
  the kit roadmap `docs/ROADMAP.md`, the pending porting notes `docs/upgrades/unreleased.md`).
  `scripts/rename.mjs` deletes them when a
  copy is born, and with them every package.json script (`kit:release`) and `.claude/settings.json`
  hook that names one (`stripKitOnlyWiring`, `stripKitOnlyHooks`); it also writes the app its own
  `SECURITY.md` and drops `retiredSurfaces`. `classifyPath` never ports one (the TARGET kit's list
  too, and `KIT_ONLY_PATHS` is the floor for a pre-0.15.8 manifest); `tests/config/kit-manifest.test.ts`
  fails a copy that carries one or a script or hook that calls one, and `kit.yml`'s renamed-copy
  gate asserts none survive and passes at an app version (`1.2.3`).
- **The Launch kit contract** (`launch.kit.json`, D36): what the kit calls things and how Launch
  drives an app made from it — the scaffold (`rename.mjs`, `kitOnly`, `postInit`, the app manifest
  `.rocketflare.json` whose `kit.id` Launch reads), the vars and secrets Launch provides, the database roles and migrate command, the health routes, the gate (`Gate`,
  `pnpm gate --list --json`, `LAUNCH_GATE_APP_ID`, `TEST_DATABASE_*`), the session commands (the bootstrap with `--db-url`, the dev server, its ports and
  sandbox switches), the upgrade command and skill, and `plugins.defaults` — a MIRROR of
  `defaultPlugins` above, which stays the source the bootstrap and `kit.yml` read (a kit-only test
  holds them equal). Its shape is Launch's zod schema (`@launch/shared/kit-manifest`), mirrored in
  plain JS by `scripts/lib/kit-manifest.mjs`. **A copy keeps it**: Launch reads the app's own for
  its sessions, gate and releases, so the rename rewrites it through the token map EXCEPT its `kit`
  block (`renameKitManifest`), and `kit:upgrade` treats it as `manual`. `scripts/kit-check.mjs`
  (`--exec` also runs the gate list) is the static conformance check Launch applies before a kit
  can be picked — shared byte for byte with Launch's meta-kit `rocketflare-dev/launch-kit`.
  **Rocketpod does not conform**: Launch's schema-1 contract needs a Worker toml pair and a deployer
  workflow, so `worker` and `release` are kept only to stay schema-valid (`$runtime` says so),
  `kit.yml` does not run the check, and its tests run on the fixture kit
  (`tests/config/fixtures/kit-fixture.mjs`). The kit's own values are judged by `tests/kit-only/`
  (`launch-kit-manifest.test.ts` checks them against the bootstrap, the dev server and the RLS
  role).
- **A copy's version is its own**: the rename restarts the root `package.json` version at `0.1.0`
  and empties `CHANGELOG.md` (`restartAppVersion`, only while the root version is still the kit's),
  so an app's releases never read as kit releases. Which kit it came from lives in one place,
  `.rocketflare.json` `kit.version`; the upgrade never ports the root version or `CHANGELOG.md`
  (`manual` / `neverPort`), so the two numbers never meet again.
- **Porting notes** (kit repository only): one `docs/upgrades/X.Y.Z.md` per release (frontmatter +
  four headings), with `unreleased.md` accumulating. `kit.yml` fails a PR touching
  `apps/**`/`packages/**` without an entry. `pnpm kit:release` writes everything. An app writes
  none: `kit:upgrade` reads the notes from the kit's mirror, not from the copy's `docs/upgrades/`,
  and the copy releases by bumping its root version, tagging, and adding its own `CHANGELOG.md`
  section.
- **`scripts/upgrade.mjs`**: a blobless mirror in `.upgrade/`. It classifies paths, drops absent
  surfaces and plugin-owned files, translates through the same `applyReplacements()` as the rename,
  then patches with `--reject` as a fallback. It **never** applies kit migrations (snapshots are
  cumulative), applies deletions unasked, or ports the root
  version. The version stamp is written last, only on a clean apply. Every release path is checked
  before anything is written, a plan run included: one that is not a plain path inside the
  repository (`scripts/lib/repo-paths.mjs`), is under `.git/`, or reaches an added file through a
  symlink stops the run.
- **A copy hears about releases on its own**: a Claude Code `SessionStart` hook
  (`scripts/kit-update-check.mjs`, in `.claude/settings.json`) compares `kit.version` with the
  newest tag at `kit.repo` (`git ls-remote`, cached a day in the git-ignored
  `.claude/kit-update-check.json`; a failed check an hour) and hands Claude one message to relay
  once per session, with the CHANGELOG summaries and a pointer to `/rp-upgrade`. Copies only, a
  fresh `startup` only, never in CI, `ROCKETPOD_UPDATE_CHECK=0` to silence; any failure is
  silence.
- **The kit reminds its own maintainers too** (kit repository only — the script and its hook entry
  are `kitOnly`, so a copy never runs them): a `PreToolUse` hook on `git commit` —
  `changelog-nudge.mjs` (source changed, no `unreleased.md` entry). It answers with
  `hookSpecificOutput.additionalContext`, because a `PreToolUse` hook's plain stdout reaches only
  the debug log.
- **Released history is never rewritten** — every copy pins a commit.

**Known gaps:** a copy pinned before 0.10.1 has no update hook until it upgrades (and
`.claude/settings.json` is `manual`, so that upgrade must add the hook entry by hand); summaries
only for a GitHub-hosted kit; `.env.example`, the chart's `Chart.yaml`/`values.yaml` are diffed, not merged; the reject rate is not
predicted; pre-manifest copies need `--adopt`; no partial upgrades; nothing checks the adopter ran
migrations; lockstep plugin releases bump every plugin in a monorepo; a copy on 0.15.7 or older deletes
its kit-only tests by hand once (its upgrader predates `kitOnly`); a copy renamed before the
maintainer scripts became `kitOnly` keeps them, `CONTRIBUTING.md`/`CODE_OF_CONDUCT.md` and the
changelog-nudge hook until it deletes them by hand (`kit:upgrade` stops porting a `kitOnly` file but
never deletes one — that release's note lists them); the rename script itself and `rp-adapt` stay
in a copy (`neverPort`), idle once it is renamed; `demo-seed` is not cleanly
removable — its deterministic embedder is also the test AI stub's (`tests/mocks/bindings.ts`), a
coupling `example-surfaces.test.ts` records rather than hides; `kit:upgrade` shows
`launch.kit.json` as a `manual` diff translated through the token map, so a hunk touching its `kit`
block reads as renamed (keep the kit's id and name); a copy that predates the contract gets
`kit.id` only by following that release's porting note; `plugins.add` cannot express an entry
without a `subdir` (`--subdir` refuses an empty value), which no default plugin has today.

## 14. Definition of done for the kit

Kit repository only — the bar the kit itself is held to before a release. A fresh agent can clone and run `bash scripts/bootstrap.sh` with zero credentials and land signed in
on a populated demo workspace. From there it must be able to:

- rename the copy (`/rp-adapt`)
- log in by magic link and through the CLI
- invite a member, switch tenants, approve an access request, including under `single` mode
- see live refresh from a second browser and queued email
- upload an avatar
- stream a chat with persisted usage
- run, watch live, cancel and HITL-answer agents across a dev restart, with the approved document
  indexed exactly once
- ingest, upload a PDF and search it
- restrict content by group and watch it disappear and reappear live
- install a plugin and remove it cleanly (`plugin add` / `plugin remove`)
- port a later kit release skipping deleted examples
- toggle the `example-feature` plugin's flag
- render and deploy the image with Compose or Helm (`/rp-deploy`)

The full gate stays green at every step. `SETUP.md` is the walkthrough.

## 15. Feature flags

**A feature flag is configuration, not a permission (D30).** Every gate reads the `features`
**array** (`hasFeature`, `requireFeature`, `{ feature }` nav guards), never CASL. A global admin's
`manage all` would satisfy `access Feature:x` and expose unreleased surfaces.

- **Two layers**: `FEATURES_ENABLED` is the fail-closed release gate, consulted only for
  `environmentGated` flags, plus whatever an installed plugin's own config switches on
  (`ServerPlugin.deploymentFeatures`; `deploymentFeatures(cfg)` is the union, so `resolveFeatures`
  is async). Then the admin rollout: tenant override → `on`/`off` → `rollout`
  percentage → registry default.
- **Keys are code** (`FEATURES` + metadata). No migration is needed to add one; orphaned rows are
  inert. The kit ships **no** flag — `example-feature`'s belongs to its plugin — so
  `featureNameSchema` is a refined string.
- **`featureBucket` is a wire format**: FNV-1a over `"<key>:<unit>"` mod 100, with golden vectors
  in `features.test.ts`. It is monotonic (the percentage is never hashed) and independent across
  flags.
- Resolved inside the session query, with no extra round trip. Gate every door: API mounts (404
  `feature_disabled`, not 403), plugin registries, **hooks that create rows**, and nav/routes.
- Admin UI at `/admin/feature-flags`; a tenant override nudges that tenant.
  `GET /api/features` / `rocketpod features list` show effective state.

**Known gaps:** gated code still ships in the bundle (the server is the protection); no per-user
forcing or scheduling; platform flips reach open tabs only on their next session fetch; no cache on
the Bearer path; flags cannot gate pre-tenant surfaces.

## 16. Plugins

**A plugin is a git repository COPIED into an app, never an npm package (D31)**, translated through
`applyReplacements()` like kit code. Only first-party plugins for now: installing one is as trusting
as merging a PR. A plugin repo mirrors the host tree and ships **no migration and no
`package.json`**. Plugins share Rocketflare's ecosystem files (`rocketflare-plugin.json`), so one
that uses only the injected context installs in either kit; one that declares Cloudflare
`bindings` or `workerExports` is refused at `add` and fails `check` as `<id>:cloudflare-only`.
Working guide: `apps/web/src/plugins/CLAUDE.md`, `/rp-plugin`,
`docs/plugin-api.md`.

- **Outbound**: four published entries (server, UI, shared, CLI). Nothing reaches past them, in
  either direction between core and plugins.
- **Inbound**: a plugin imports the host only through **declared entries** and receives everything
  else as **injected context** (`RequestCtx`, `JobCtx`, `CronCtx`, `ToolCtx`, `AgentCtx`,
  `WorkflowCtx`, `HookCtx`, `SeedCtx`, `DetachedCtx` — thin adapters over kit internals). Two things
  cannot be injected and are entries instead: `@/db/schema/kit` (module-scope table helpers,
  imported by relative path) and the split UI kit (`ui-wiring` for the eager entry, `ui` for lazy
  pages). Tests use `@testkit/{integration,unit}`, whose builders refuse a database handle not
  created by `setupTestDatabase`. `tests/helpers/plugins.ts` enforces all of this, and every
  diagnostic names the replacement import.
- **Five barrels**, one line per plugin each, written by `pnpm plugin add|remove`: shared, server,
  schema, ui, cli. Each exports an `as const`
  tuple plus a widened list, so an empty kit still typechecks. **Opening a closed set** always
  follows one pattern: `X = [...CORE_X, ...plugins]`. `ServerPlugin<S>` checks handlers, agents and
  prompts exhaustively against the plugin's own keys. `SharedPlugin.realtimeTopics` opens the
  realtime TOPIC registry the same way (§5): a plugin declares `{ prefix: '<id>.<kind>', subject }`,
  publishes with `ctx.nudgeTopic(tenantTopic(…), entity, id)` (`JobCtx.nudgeTopic` in a handler)
  and its page subscribes with `useRealtimeTopic` from `@/plugins/api/ui`.
- **Core edits**: a line a plugin needs in a core file outside the barrels (a Vite dev proxy
  prefix, a resolve alias) is a `coreEdits` entry in its manifest (`{ file, after, lines[] }`) —
  a plain path inside the repository. `add` inserts it after the anchor, `remove` reverts it byte
  for byte, `upgrade` applies the new
  release's list. Never a hand edit. A cron needs no edit at all: pg-boss schedules every
  expression `scheduledTasks` names.
- **Namespacing**: the id is `^[a-z][a-z0-9-]*$` (never a reserved barrel or host directory name —
  `api` included) and namespaces jobs (`<id>.x`), query keys
  (`<id>:`), `/api/<id>`, CLI commands and CUSTOM events. Never `kit.`. Table prefixes are a human
  convention; **two plugins declaring the same table is a `plugin check` failure**.
- **Record**: a `kind: 'plugin'` surface (`source: {repo, subdir, version, commit}`). In the kit or
  with `--local` it goes in the git-ignored `.rocketflare.local.json`. A kit diff never touches
  plugin-owned files. A vendored plugin (`example-feature`) upgrades with the kit.
- **Compatibility is OBSERVED (decision 5c)**: the kit emits a `## Surface ledger` in
  `docs/plugin-api.md` (generated, diff-checked). A plugin's `uses` is **derived** from its imports
  by `pnpm plugin export`, and compatibility is the set difference `uses \ ledger`, checked before
  any file is copied. The one surviving number is a top-level `minKit` floor, compared with the
  HOST's kit version (`hostKitVersion` in `scripts/lib/manifest.mjs`): `.rocketflare.json`
  `kit.version` in a copy, whose root `package.json` is the app's own, and the root `package.json`
  version only in the kit itself. `requires.kit` /
  `requires.pluginApi` are refused by name. CI proves both ends: `kit.yml` runs the gate with
  `defaultPlugins` installed (in the kit's own repository only), and plugin repos call
  `plugin-ci.yml` (floor + newest kit), which installs a plugin's `requires.plugins` from the
  same checkout first and takes the highest `minKit` across the set as the floor.
- **Lifecycle** (`scripts/plugin.mjs`): `add` (plan, then `--apply`), `upgrade`, `remove`
  (`--archive`), `list`, `check`, `export`. Every plan step is **declarative, agent (with its
  assertion) or human** — a printed instruction is not a mechanism. The host generates the
  migration (`db:generate --name plugin-<id>-<version>`). A plugin's crons join the scheduled
  registry (pg-boss schedules, §5); its `vars` are environment keys, added to `.env.example` and
  the chart's ConfigMap by hand.
- **`plugin check` is an exhaustive oracle**: manifest fields, `minKit`, ledger diff, barrel lines,
  `*.rej`, migration tag, host dependencies (present, at a range inside the declared one —
  `add` writes the declared range, never pnpm's `^<resolved>`; `upgrade` installs what a release
  adds or re-ranges and removes what it drops only when a plugin brought it in — the surface's
  `addedDependencies` record, never range equality — no other plugin declares it and the host
  holds exactly the old range — a range a peer plugin cannot use is refused), Cloudflare-only
  declarations, a tenant-isolation test for tenant tables, table collisions, declared skills. Each finding names file, line and exact edit.
  Structural checks read comment-free code. It runs where a finding can still be acted on: at the
  end of `plugin add|upgrade --apply` (exit 8 when the tree it wrote fails), in the plugin's own CI
  (`plugin-ci.yml`) and in `kit.yml` — not in an app's `pnpm gate`, because an undeclared import
  compiles and passes the tests and only breaks at the next upgrade, where the check stops it first.
- **Eval coverage (D33)**: `SharedPlugin.evalCoverage` (`{ prompts?, agents? }`) declares the
  eval coverage of the plugin's OWN prompt and agent keys — a suite under `apps/evals`, or
  `{ exempt: reason }` (the usual case: a plugin cannot write there). The gate's
  `eval-coverage.test.ts` fails a registered plugin key with no entry and an entry for a key the
  plugin does not declare; a host that writes a suite for a plugin's prompt overrides the entry in
  the core map (§9).
- **Agent tools**: `agentTools(ctx)` may be async and may return `[]`. That is how a tool reaches
  only the tenants that turned it on: the plugin reads its own settings row for `ctx.scope.tenantId`,
  or its flag through `ToolCtx.features()` (`example-feature` does, and its welcome note follows the
  same flag — a dark feature then costs no prompt tokens). A builder that throws is logged and skipped. `buildAgentTools` is therefore async.
  `ToolCtx.can(action, subject)` is the requester's CASL grant, read at build time from their
  current membership (false for a run with no requester): gate a tool that writes on your own
  subject's `manage`, not on `scope.bypass`, which is row visibility and true for `support` too.
- **Credentials**: a plugin stores a tenant's key with `sealSecret` / `openSecret` from
  `@/plugins/api`. That is the kit's AES-GCM under `OAUTH_ENCRYPTION_KEY`, with a 503 when the key
  is unset. Store the sealed value in a `*_enc` column and answer `hasCredential`.
- **Public mounts (D34)**: `publicMounts` are routes a third party calls with no session — an
  admin-consent callback, a webhook. Only under `/api/hooks/<id>` (one enumerable prefix per
  plugin), mounted before the authed table with no `authMiddleware` and no
  gate; `tests/config/plugins.test.ts` refuses one anywhere else and any authed mount there. The
  handler gets `publicCtx(c)` — no tenant, no auth fields, `enqueue`, `features(tenantId)` — and
  proves the caller before naming a tenant. `signState` / `verifyState` are the proof for a
  round-trip the plugin started: HMAC-SHA256 under a key HKDF-derived from
  `OAUTH_ENCRYPTION_KEY`, a `purpose` that is part of the signed body, an absolute expiry
  (default 10 min), `null` for every failure. Signed, not encrypted. The host guards every
  public mount before its router runs (`api/middleware/public-mounts.ts`): a per-IP sliding
  window over `platform.rateLimiter` (the `rate_limits` table) in a bucket named after the prefix
  — default 120 / 60 s, `rateLimit: false` to opt out (a webhook sender with fixed IPs that
  batches), a no-op on a platform without a limiter like every kit limit — and the body cap, chosen at middleware step 5 before any parsing: 1 MB unless the
  mount declares `bodyLimitBytes` (≤ 10 MB; the config test refuses more), which then replaces
  it beneath that prefix for every content type, so a ~200 KB SAML form POST or a SCIM bulk body
  is neither refused nor unbounded. Both are the optional third tuple element,
  `[prefix, router, { rateLimit?, bodyLimitBytes? }]`; a path is throttled by the longest public
  prefix it falls under only.
- **Public sites**: `ServerPlugin.publicSites` serves whole hosts from a plugin's router, for
  anonymous readers. `hosts(config)` lists the hosts it answers (lowercase, no port); `null` means
  the plugin's config is bad and it is **dormant**, so every host other than `APP_URL`'s and
  loopback gets a plain, uncached 503. `api/middleware/public-sites.ts` runs after
  `databaseMiddleware` and before every mount, and reads the host from the request URL, which
  `@hono/node-server` builds from the `Host` the ingress passes (no forwarded header is trusted).
  There is no host routing in front of the app: the Node server receives every host the proxy
  sends, and the ingress, DNS and the plugin's hosts var are the deployment's (`docs/DEPLOY.md`
  § Public site hosts; the Helm chart's `publicSites.hosts`). On a matching host the plugin's
  router answers everything, so `/api/*`, `/auth/*` and `/ws` are never reached there. GET and
  HEAD are allowed, plus POST on a path declared in `forms`; anything else is 405. Page requests
  are never rate limited; a form POST bypasses the cache and has its own body limit (default
  64 KiB, at most `MAX_PUBLIC_MOUNT_BODY_BYTES`) and rate-limit bucket. Two plugins claiming one
  host, or a claim on `APP_URL`'s host, fail the gate (`publicSiteIssues`); at runtime the claim is
  ignored and logged. A site host always gets the strict public CSP from
  `api/middleware/security-headers.ts`: no script, frame, connection or form target unless
  `csp(host, config, pathname)` declares one (`pathname` lets one path carry less than the rest of
  the host; a `connectSrc` or `formAction` path such as `/submit` is pinned to the request's
  origin), and a page may add its own through `PUBLIC_SITE_PAGE_CSP_HEADER` (JSON
  `PublicSiteCsp`, stripped before the browser sees it); `style-src <request origin>/site-assets/`
  (the same source joins `script-src` once a site declares any script, so a page cannot load the
  admin bundle from `/assets/*`; `publicSiteIssues` refuses a declared script source reaching that
  path, including `'self'`, and at runtime it is dropped) and `frame-ancestors 'none'`. Inline
  script stays banned: a declared source containing `'unsafe-inline'`, `'unsafe-eval'`, `*`,
  `data:` or `;` fails `publicSiteIssues` and is dropped at runtime. The server serves only
  `/assets/*` and `/site-assets/*` before the app (`node/assets.ts`), so a root file on a site host
  is the plugin's, and the SPA catch-all serves `index.html` for a browser navigation only — a
  missing file is a 404. HSTS carries `includeSubDomains` on `APP_URL`'s host only.
  `ServerPlugin.uploadPaths` (under `/api/<id>/`) skip the 1 MB body cap, and each such route mounts
  its own limit. **Known gap:** `publicSites.cache` (generation, TTL, variants) is accepted and
  inert — Rocketflare stores pages in the Workers Cache API and a Node process has no `caches`
  global, so every page request reaches the router; put a CDN in front of the site hosts.
- **The `publicSites` manifest field**: `"publicSites": { "hostsVar": "SITES_HOSTS" }` in
  `rocketflare-plugin.json` names a declared, non-secret var holding the plugin's hosts.
  `plugin check` refuses a hosts var that is not one; `plugin add` prints the human step of
  routing those hosts to the app (ingress hosts, DNS, TLS) and `remove` its inverse. Rocketflare's
  toml half (`run_worker_first`, `not_found_handling`, one route per host, the `images` binding)
  has no Rocketpod equivalent: every request already reaches the server.
- **`appOwned` paths** (`"appOwned": ["apps/web/src/plugins/<id>/app"]`, inside `paths`): the
  developer's. `plugin upgrade` never touches them, and `plugin remove` lists a file changed or
  added since the pinned commit (a symlink compared by its target) and needs `--force-app-owned` to
  delete it. `plugin upgrade` also rewrites the anchor `plugin.json` from the release it installs,
  and refuses a release whose manifest fails `plugin check`'s manifest rules before writing
  anything.
- **`workspace` route tier**: a `UiPlugin` route with `tier: 'workspace'` renders inside `Layout`,
  in the shell's route table, for a page that needs the whole space under the app header (an
  editor canvas). It requires sign-in and a tenant, and its `guard` is honoured, as on `shell`. On a
  workspace route from `lg` up the sidebar collapses to its icon rail whatever the reader saved,
  the saved preference is untouched and returns on leaving, and the collapse toggle is hidden;
  below `lg` the drawer is unchanged. `<main>` has no padding and the page fills the viewport under
  the 56 px header (`h-full` in a plugin page), scrolling only its own panes. The other tiers are
  `shell` (the default), `noTenant` and `public`. `Breadcrumbs` (from `@/plugins/api/ui`) is the
  trail on its own, for a surface with no page title.
- **`resolveOwnerTenant(db, config, ownerSlug?)`** from `@/plugins/api` finds the tenant that owns a
  public surface: `getSingleTenant` under `single`, by slug under `multi`. It returns null for a
  missing slug under `multi`, an unknown slug, and any tenant whose `status` is not `active`. This
  and the plugin's config parser are the only places a plugin should branch on `TENANCY_MODE`.
  **Known gap:** under `multi` it matches a slug, and a slug can be renamed or reused, so a tenant
  that renames or is deleted frees a public host for whoever registers that slug next. Bind by id
  before tenants can own public sites themselves.
- **`chatModelAvailable(ctx, tenantId, promptKey)`** from `@/plugins/api` answers whether
  `resolveChat` would find a model (a tenant row or the `.env` platform keys) without building a
  client, so a plugin can say "no model" before it starts a run.
- **Identity (the identity seam)**: a public handler that has proved a person signs them in with
  `identityFor(c, id).signIn(...)` — the kit links, admits, applies an `idp` membership and mints
  the session (§2) and the plugin returns the redirect it answers; it never touches
  `user_sessions`, cookies or `tenant_users`. **Linking by email is opt-in — decided:** a sign-in
  (or `upsertUser`) whose email belongs to an account with no link from this plugin is refused
  (`account_exists`) unless it passes `linkByEmail: true`, which a plugin sets only when it has
  proved its IdP owns the email's domain (a DNS-verified domain on the connection) — a per-tenant
  IdP can assert any address, so linking by email alone would let one customer's IdP sign in as
  anyone. **A subject with no link also needs it to CREATE an account**, with the same
  `account_exists` either way: otherwise the IdP could reserve an address before its owner arrives
  and keep a working link to the account they sign in to. A `BOOTSTRAP_ADMIN_EMAILS` address is
  never created or linked through the seam (admission's `proof: 'plugin'` never earns the platform
  role either); the operator signs in with a kit method. A suspended tenant is refused on every
  tenant-taking method: 403 `tenant_suspended`, and `signIn` naming it answers `no_access`. `provisionFor(ctx, id)` is the cookie-free half, from
  any `PluginContext` (SCIM, a directory sync): `findUser`, `upsertUser` (creates with a link and
  no session; a block stays; an unverified email never links to an existing account),
  `setMembership` / `removeMembership` (`source = 'idp'` only, so read-only in the app — 409
  `idp_managed` — and never an owner, support or manual row), `deprovision` and `listMembers`.
  **`removeMembership` is the membership only** (the IdP stopped granting the tenant: its sessions
  are UNPINNED and fall back to another membership); **`deprovision` is a leaver** (SCIM
  `active: false`): the same removal plus DELETING the sessions pinned to that tenant, answering
  `{ removed, sessionsEnded, retained }` — `retained` is a manual/owner/support row it left, with
  its sessions — and `blocked`. **Decided: never global in multi mode** — no `blocked_at`, no
  other tenant's sessions or memberships, because a tenant's IdP speaks for that tenant only; the
  person's API keys in that tenant stop authenticating because `validateApiKey` joins the
  creator's membership there (401). **Decided: in single mode `deprovision` BLOCKS** — the one
  tenant is the deployment, so the multi-mode reason (the person's other tenants) does not exist,
  and without a block a magic link, Google, another plugin's sign-in, dev login's `onNoTenant` or
  the session left with no pinned tenant would let the leaver straight back in. It sets
  `users.blocked_at` with `blocked_source = 'plugin:<id>'` and deletes EVERY session (keys answer
  403 `blocked`), answering `blocked: true` — only for a person the IdP speaks for (it just
  removed their `idp` row, or they carry this plugin's link), never with a `retained` row, and
  never a global or bootstrap admin (logged: no IdP locks the operator out). The block has a
  source so reactivation cannot undo an operator: the SAME plugin's `setMembership` (SCIM
  `active: true`, a role again) lifts a `plugin:<id>` block and nothing else; the admin console's
  Block writes `manual` (and takes over an IdP block), Unblock clears either, NULL means manual;
  `upsertUser` and `signIn` never lift one. A tombstone `onNoTenant` checks was rejected: it would
  close one door of six, where `blocked_at` is already checked by every sign-in, the session
  middleware and API keys. In single mode every tenant-taking method also accepts only THE tenant
  (`getSingleTenant`), `tests/api/tenancy-single-identity.test.ts` proves the mode end to end.
  `tests/driver/identity.test.ts` runs sign-in, provisioning and the single-mode block through the
  request path's `openDatabase`. Every tenant-taking method 404s a missing tenant; the CALLER must have proved its right
  to that tenant, the `PublicCtx` contract. `loginMethods(cfg)` contributes login-page buttons whose `startPath`
  must sit under `/api/hooks/<id>/`, and whose `errors` copy is keyed `<id>.<name>` —
  `plugins.test.ts` fails a stray one, and `GET /auth/methods` drops it with a log. `example-feature`'s dev-only `/api/hooks/example-feature/sso/*` is the
  worked example.
- **SSO required (`ssoPolicy`)**: `(db, email, { config }) => Promise<{ required: true; methodId;
  label?; connectionId? } | null>` — "my connection claims this email's domain; send them to my login method
  `methodId`". The host asks every plugin once per sign-in attempt and enforces the answer on all
  of its own methods and on every OTHER plugin's `signIn` (§2); `evaluateSsoPolicy` is pure over
  the plugin list and `plugins.test.ts` drives it with fixtures (claim, other plugin, throw,
  malformed answer, undeclared method, break-glass). Keep it to one indexed lookup on the domain,
  answer `null` for a domain no connection claims, and let a real failure throw (the host fails
  closed). The host does not verify the domain, end existing sessions or check `provisionFor`.
  `example-feature/api/sso-policy.ts` claims `@sso-required.example.test`, development only.
- **A callback completing a signed flow**: `verifyState` proves who minted the state and when, not
  that they still may. `memberCan(ctx, { tenantId, userId }, action, subject)` from `@/plugins/api`
  re-reads the membership, role, account block and tenant status now; a public callback calls it
  right after `verifyState`, with the action and subject the start route guarded.
- **Background feature checks (D34)**: `JobCtx`, `CronCtx` and `PublicCtx` carry `storage()`
  (`platform.storage`, the same service `RequestCtx.storage()` returns, 503
  `storage_not_configured` without one; keys under `tenants/<id>/<plugin id>/…` are purged with the
  tenant) and `features(tenantId)` — the same resolution as `auth.features`, with no user, so a cron that fans
  out across tenants can skip the ones whose flag is off. `AgentCtx` and `ToolCtx` carry the same
  `storage()` (one `filesStorage(platform)` behind every context's), keyed under the run's tenant.
- **Starting agent runs from the background**: the same three contexts carry
  `startAgentRun({ agentKey, tenantId, input, idempotencyKey?, concurrencyKey?, triggeredBy? })`
  → `{ runId, status, deduplicated }` — `POST /api/agents/runs` without a request, through the
  same `enqueueRun` (validation, exclusive slot, active-run cap, daily budget, the run-engine
  start; each refusal a throw, so a job retries). A job passes an `idempotencyKey` naming the WORK
  (`receipt:<documentId>`), so a redelivery answers the first run instead of starting a second
  (§9). `triggeredBy` is the requester whose access the run's tools read; omitted, a system run.
  It is part of `feature-agents` and reaches the runtime by a function-scope import (the agent
  registry reads the plugin barrel). `@testkit/unit`'s `makeJobCtx` / `makeCronCtx` record every
  call in `startedRuns` and take a `startAgentRun` replacement.
- **Knowledge ingest (D34)**: `ingestDocument` / `ingestDocumentFile` / `deleteIngestedDocument`
  over the kit's ingest paths (§9). With an `externalId`, the same `(tenant, source, externalId)`
  UPDATES the row — text, owner, visibility, grants, chunks, the stored original — so a sync can
  replay safely. Group ids are checked against the tenant first. This file belongs to the
  `feature-knowledge` surface; a plugin that ingests requires it.
- **Skills**: a plugin ships agent skills at `skills/<dir>/` in its own tree and declares them in
  `"skills"`; `add` copies each to `.claude/skills/<dir>/` (the one place outside its roots a
  plugin may write) and records it on the surface, `upgrade` REPLACES it (never patches — an agent's
  instructions are the plugin's outright), `remove` deletes it. `<dir>` is `<id>` or `<id>-*` and
  its SKILL.md `name:` equals it, so a plugin skill can never shadow a kit `rp-*` one; an existing
  directory is a refusal. `plugin check` fails a declared skill that is missing, misnamed or
  undescribed, and a directory in the plugin's namespace it does not declare. `.claude/` in a
  plugin repository stays that repository's own tooling. `example-feature` ships one.
- **Hooks** (`onTenantCreated`, `onTenantDeleted`, `seedDemo`) run post-commit, are idempotent,
  and are try/caught. State a plugin keeps outside Postgres (its own storage prefix, an external
  system) is purged in `onTenantDeleted`, addressed by names **derived** from the tenant id.
- **Traps measured, now rules**: registries a plugin composes into are FUNCTIONS, not consts
  (module-evaluation order); a value a plugin needs moves to a leaf module; browser-read registries
  are separate files from composing ones; plugins declare `relations()` for their own tables only
  (drizzle type intersection); annotate `const ctx: RequestCtx` so `never` narrows.
- **`example-feature`** is the vendored reference that exercises every slot. It exists to be
  deleted.

**D31 decisions**:

| # | Choice |
|---|---|
| 1 | First-party only; the install plan waits for a human |
| 2 | The kit is bare; `defaultPlugins` + a bootstrap step install an app's own set on its fresh clones (empty in the kit) |
| 3 | `example-feature` is the reference plugin |
| 4 | A plugin is recorded as a `kind: 'plugin'` surface; `readManifest()` is the one kit-vs-app predicate |
| 5 | Compatibility is proved in CI from both ends (`kit.yml` with `defaultPlugins` installed; `plugin-ci.yml`; `kit:release` refusal) |
| 5b | *(reversed)* a `PLUGIN_API` integer beside `requires.kit` |
| 5c | Compatibility is observed: derived `uses` against the emitted ledger, plus a `minKit` floor |
| 6 | Cubes/fact tables/dashboards are plugin-owned registries via `extensions`, narrowed by the owner |
| 7 | Analytics extracted with no compatibility path (tables become `analytics_*`) |
| 8 | Pages are `lazy()`, proved by a source-level test |
| 9 | Four published entries; deep imports fail in either direction |
| 10 | Phase A shipped as four PRs, one release |
| 11 | Uninstall drops tables by default, `--archive` on request |
| 12 | A plugin declares no platform bindings: one that does is refused as `<id>:cloudflare-only` |
| 13 | Every manifest has a required `repo` |
| 14 | The inbound surface is injected context (the `*Ctx` family), not imported symbols |
| 15 | What cannot be injected is a declared entry (`@/db/schema/kit`, split UI kit, `@testkit/*`) |
| 16 | A printed instruction is not a mechanism — hence the barrels |
| 17 | A plugin exports no runtime classes: `workerExports` is refused as `<id>:cloudflare-only` |
| 18 | Out-of-Postgres tenant state is purged via `onTenantDeleted` over derived names |
| 19 | Test builders refuse a fake database |
| 20 | Every plan step is declarative, agent or human (`kind` in `--json`) |
| 21 | `plugin check` is an exhaustive, untiered oracle that reads comment-free code |
| 22 | Table prefixes are convention; collisions are the check |
| 23 | A plugin ships agent skills: `skills/<dir>/` → `.claude/skills/<dir>/`, namespaced by id, replaced on upgrade |
| 24 | (Rocketflare's inbound-email slot — not ported, see the known gaps) |
| 25 | A background context starts an agent run through the route's own `enqueueRun`; idempotency is a derived run id, not a new column |
| 26 | Plugin identity is `identityFor(c, id)` / `provisionFor(ctx, id)`, links under `plugin:<id>`, memberships through the core `idp` primitives; login buttons are declared, never rendered by the plugin |

**Known gaps:** no sandbox, review or signing; no rename migrations (expand/contract only); no
cross-plugin FK tooling or `many()` onto core tables; `grants` is additive by convention only;
a plugin cannot register a durable workflow or a Node service of its own (only jobs, crons,
routes, agents and tools); `defaultPlugins` is empty until the analytics plugin has a release
without Cloudflare bindings; no inbound email — Rocketflare's `emailHandlers` slot rides
Cloudflare Email Routing, which has no Rocketpod equivalent (a plugin can take a provider's inbound
webhook on a `publicRoute` instead); `startAgentRun`'s `idempotencyKey` is forever per (tenant,
agent, key) — there is no expiry, so a plugin that wants to re-run the same work later must vary
the key; `RequestCtx` has no `startAgentRun` (a route calls `POST /api/agents/runs`, or enqueues a
job that does);
the ledger judges only ledgered entries, ignores namespace imports, truncates types over 300
chars, and `uses` is only as fresh as the last export; table collisions are caught by `check`, not
refused at `add`; the isolation check proves a test exists, not that it is right; no database-free
test of data-touching handlers; no purge-intent ledger;
`plugin-ci.yml` input changes reach callers only via `main`, and nothing tests versions between
floor and ceiling. `addedDependencies` starts after 0.17.1: a plugin installed by 0.17.1 or earlier has its
older packages kept, never removed, when a release drops them, and a package a plugin added that
the kit later starts declaring too is still the plugin's to remove. Public mounts (D34) have no `@testkit` builder
(test them through `request()`), and their rate limit is the kit's Postgres window, keyed
on the client IP (`TRUSTED_PROXY_HOPS` decides which address that is) — a sender behind a shared egress shares one bucket; `verifyState` has no replay ledger — a token is reusable until it
expires, so a plugin whose callback must run once records that itself; an ingested document's
upsert reads the previous row before writing, so two racing re-ingests of a FILE may leave one
replaced original behind in storage; a plugin skill edited in place is overwritten by the next
`plugin upgrade` (copy it to a skill of your own first), and `check` validates a skill's name and
description, not what it says — a stale command in a SKILL.md is caught only by reading it.

---

## 17. Connectors

An **organisation connection** to Microsoft 365 or Google Workspace (D34): an org admin grants an
operator-registered app access to the whole directory, calendars and — later — mail and files, and
Rocketpod syncs them into the tenant. It is **not login** (§2): a different app, a different
grant (admin consent / domain-wide delegation, app-only tokens), a different subject (the
organisation, not the signer). The design, operator and customer-admin setup, phases and the MCP
assessment are in `docs/CONNECTORS.md`.

It ships as plugins, not core: the `connectors` base plugin (installations, connections, sync
cursors, the settings tab, the sync job and cron) and one provider plugin each (`m365` first,
`google-workspace` next), registered through `extensions.connectorProviders`. The kit's part is
four generic seams on the plugin surface (§16): public mounts at `/api/hooks/<id>`, `signState` /
`verifyState`, `ingestDocument` with an `externalId` upsert (§9), and `features(tenantId)` off the
request.

| # | Choice |
|---|---|
| 1 | Login and connection stay separate apps, even in production |
| 2 | One operator-registered app per deployment by default; a per-customer BYO app is the escape hatch |
| 3 | The data model covers all three usage models from day one: installation → connection with `ownerType` `tenant` or `user` |
| 4 | Org-wide app-only ships first; per-user delegated is phase 4 |
| 5 | Directory + calendar by delta polling first — no restricted scopes, so no Google CASA gate |
| 6 | Webhooks only ever trigger a delta fetch; polling stays the backstop |
| 7 | Every synced row carries its owner; tenant isolation alone is not enough inside one organisation |
| 8 | Vendor MCP servers are not a data plane (delegated only, no delta or webhooks) — at most a later chat-tool adapter |

**Known gaps:** no webhooks yet (phase 2); no mail or file ingestion (phase 3); no per-user
delegated connections or refresh-token rotation (phase 4); Google Workspace provider not built;
M365 uses a client secret, not a certificate assertion; no Exchange RBAC-for-Applications scoping
script; synced private rows are still readable by tenant admins (D29 owner-and-admins); the kit has
no MCP client; directory sync does not provision kit users or groups (it only matches by email).

TypeSafe (Jev) is NOT a connector in this sense: it answers questions rather than syncing an
organisation's data, so it is an AI provider in the `decisions` scope (§9, D37).

## 18. The Guide

Server: `api/routes/guide.ts`, `api/services/guide-{content,facts,kb,tools,citations}.ts`,
`src/node/guide-content.ts`, `db/schema/guide-chunks.ts`. UI: `ui/pages/guide/**`,
`ui/components/guide/**`, `components/shared/GuideLink.tsx`. Contracts: `@rocketpod/shared/guide`,
`@rocketpod/shared/guide-screens`. Content: `apps/web/content/guide/`. Writing and keeping pages
true: the `rp-doc-sync` skill.

The in-app user guide: markdown pages read at `/guide` (contents rail, page, a resizable "Ask the
Guide" pane) and from a header `?` slide-over (or the `?` key) that shares one conversation.

- **Pages are files with frontmatter** (`title`, `part`, `section`, `order`, `audience`, `summary`,
  `sources`, `verified`) under `content/guide/<part>/`. The TOC is DERIVED — sorted by
  `GUIDE_PARTS`, then `GUIDE_SECTIONS`, then `order`; there is no hand-kept index. The parts and
  sections are the app's to rewrite. The kit ships four starter pages (signing in, members and
  invitations, API keys and the CLI, AI settings) as the `example-guide-pages` surface. Content
  reaches the server through a `Platform` member (`guide`: `markdownFiles`, `screenshotManifest`,
  `image`), cached in production and re-read in development; the image copies `content/guide`
  beside `dist/`.
- **Every member of a tenant reads it** (session or API key), and the AUDIENCE is derived
  server-side from role (`guideAudienceFor` = `isAdminLevel`): an `admin` page is invisible to a
  member — absent from the TOC, the same 404 as a missing page, and a SQL predicate in retrieval.
  A member page may not link to an admin page (the staleness test fails it).
- **Facts, not typed numbers.** A page writes `{{fact:key}}`; `guide-facts.ts` resolves it at
  render AND index time from the real constant (`@rocketpod/shared`, light server modules), or from
  a PINNED literal for what the server must not import (the CLI's ports, config path, exit codes,
  bin name; two server TTLs) that `tests/config/guide-facts.test.ts` holds to the real constant.
  `apps/cli/src/auth-constants.ts` exists so that test can read the login constants without loading
  the CLI's HTTP client. An unknown key fails the staleness test.
- **Retrieval is over `guide_chunks`, a global table** (no `tenant_id`; `RLS_EXCLUDED_TABLES` — no
  tenant data). Every `web`/`all` boot chunks the pages NOW (split at H2, the reader's own heading
  ids, `Title › Section` lead) and rewrites the table under a transaction advisory lock only when a
  chunk differs. Vectors are optional: the committed `embeddings.jsonl.gz` (`pnpm web
  guide:index`, which needs a platform `EMBEDDINGS_API_KEY` and costs a little) is a CACHE of
  vectors keyed by chunk text — a chunk borrows one only when the fixture embedded that exact text
  with its majority model. So no fixture, or a stale one, degrades to keyword search for the
  chunks it does not cover and never breaks the Guide; the kit ships none. Search is the kit's
  hybrid shape: the lexical half (any term, `ts_rank_cd` over the stored `search_vector`) always
  runs, the dense half only when vectors exist AND the PLATFORM embedder (`resolvePlatformEmbeddings`,
  never a tenant's) is the model that built them, fused by RRF; the answer reports `hybrid` or
  `lexical` and the UI says so.
- **Ask the Guide** (`POST /api/guide/ask`, AG-UI) runs on the tenant's chat provider (prompt key
  `guide-chat`, so `agent_models` can pin it), with ONE tool, `search_guide`, which only this route
  builds — the chat, agents and knowledge tools never see a Guide row
  (`tests/config/guide-isolation.test.ts` is the source scan, `tests/api/guide.test.ts` the
  behaviour). The model ends with a `CITATIONS:` block; the route resolves it against the asker's
  own TOC and emits `CUSTOM kit.guide.answer`. Stateless: the client sends prior turns, nothing is
  stored but the `ai_usage` row and the trace. A screen hint (fixed vocabulary from
  `screenForRoute`, a character-limited label, never a URL segment) tells the model where the
  reader is; its `page` is named only when it is a screen-map target the asker can read.
- **Screen → page map**: `GUIDE_SCREEN_PAGES` / `GUIDE_ADMIN_SCREEN_PAGES` / `GUIDE_TOPIC_PAGES` are
  the one place a screen's help topic is defined; `GuideLink` takes its target from there, and the
  staleness test holds every target to a real page (a member screen to a member page).
- **Staying true**: `pnpm web docs:stale` lists pages whose `sources` changed after `verified`
  (structural errors exit 1; staleness never does). A Claude Code `Stop` hook runs it on the
  working tree (`--changed --quiet --hook`): silent when nothing is stale, a `systemMessage` when
  something is, and it never blocks or fails a session. `pnpm web guide:shots` regenerates the
  screenshots in `screenshots.yaml` from a local dev server (dev login as the seed's owner, frozen
  animation, fixed theme and viewport, rewritten only past a pixel-diff threshold, `--stale`);
  Playwright is not a kit dependency — the script tells you how to install it.
- **Evals**: `apps/evals/suites/guide/ask.eval.ts` over the committed pages (`guide-chat` dataset;
  its baseline is provisional until someone runs it with a key).

**Known gaps:** a plugin cannot contribute pages (they live only in `content/guide/`, and a
plugin's tree is not shipped beside the bundle); no global-search hit kind for Guide sections; no
re-ranker; no screenshot ships in the kit (the manifest is empty); one fixed set of parts per app,
no per-tenant pages or overrides; no i18n; `screenForRoute` knows only the kit's routes and the
Settings `?tab=`; the image `COPY` needs `content/guide/` to exist (it always holds
`screenshots.yaml`); Ask the Guide keeps no history across tabs or reloads.
