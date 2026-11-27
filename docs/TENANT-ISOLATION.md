# Tenant isolation

What keeps one tenant's data away from another, layer by layer: what each layer guarantees, what
switches it on, how it is proven, and what it does not cover. `docs/RLS.md` is the row-level
security posture in detail; this page is the whole picture.

## The layers

| Layer | Always on? | Guarantees | Proof |
|---|---|---|---|
| 1. Application predicates | yes | every domain query names its tenant, taken from the auth context | `tests/config/unscoped-allowlist.test.ts`; each route test's tenant-isolation case |
| 2. Row-level security policies | exist always; bind only on a non-owner login | a statement admits only the rows of the tenant its transaction names | `tests/api/rls-coverage.test.ts` (every tenant table has a policy), `tests/api/rls-enforcement.test.ts` (it binds) |
| 3. A separate app login (`APP_DATABASE_URL`) | opt-in | the web and worker processes cannot run DDL, own nothing and cannot switch RLS off; the owner credential is needed only by migrate | `tests/api/rls-enforcement.test.ts`, `tests/api/db-roles.test.ts`, the migrate post-check |

## 1. Application predicates

Every query on a tenant table carries `eq(table.tenantId, tenantId)` with the tenant from the auth
context (`.claude/rules/database.md`). This never goes away; the layers below catch the query that
forgot it, they do not replace it.

## 2. Row-level security

Every table with a `tenant_id` has one policy, `<table>_tenant_isolation`
(`apps/web/src/db/schema/rls.ts`), naming two NOLOGIN roles:

- **`rocketpod_app`, the tenant role.** A row passes only when its tenant equals the
  transaction-local `app.tenant_id`. With no tenant set, nothing passes: the policy fails closed.
  The auth-infrastructure tables (`RLS_REVOKED_TABLES`: sessions, magic links, OAuth tokens…) are
  REVOKEd from it outright.
- **`rocketpod_system`, the cross-tenant role.** The predicate is `current_user =
  'rocketpod_system'`, so every row passes. It is what a request works as before a tenant is
  known (sign-in), in the admin console and in cron sweeps. It owns no table, so it cannot alter
  or drop one, nor turn RLS off.

The table OWNER bypasses both (no `FORCE ROW LEVEL SECURITY`), which is why the policies are inert
on a deployment whose server connects as the owner.

`withTenantScope(db, tenantId, 'enforce', fn)` (`apps/web/src/db/tenant-scope.ts`) runs `fn` in a
transaction that sets `app.tenant_id` and, on an app login, switches to the tenant role
(`SET LOCAL ROLE` through `set_config('role', …, true)`). Both settings end with the transaction, so
a pooled connection goes back to the system role for its next borrower. Today the MCP server's
tool calls run in such a scope; every other request path relies on layer 1 and works as the
system role (Known gaps).

## 3. The app login

Two credentials, for an infrastructure that provides an owner login for migrate only and a
separate login for the app:

| Variable | Role | Used by | Can |
|---|---|---|---|
| `DATABASE_URL` | the owner (an outside bootstrap creates it and the database) | the migrate one-shot; the server too while `APP_DATABASE_URL` is unset | everything; bypasses RLS |
| `APP_DATABASE_URL` | the app login, any user name but the owner's and the two roles' | every runtime connection of `web` and `worker`: the pool, pg-boss, OpenWorkflow, realtime | nothing of its own (NOINHERIT); works as `rocketpod_system`, or `rocketpod_app` in a scope |

The migrate one-shot (`scripts/db-roles.ts`, as the owner) creates the two roles and, when
`APP_DATABASE_URL` is set, the login: LOGIN with the URL's password (sent as a SCRAM verifier, so
the plaintext is in no statement), NOINHERIT, both roles granted, and CONNECT on the database (a
bootstrap may have revoked it from PUBLIC). It ends with a post-check that fails the migration if
any of the three is a superuser, has BYPASSRLS or owns a relation, if the system role can log in,
or if the login cannot connect. The job and run engines' installers grant `rocketpod_system` their
schemas (`apps/web/src/node/engine-grants.ts`): USAGE and DML only, since pg-boss and OpenWorkflow
do their DDL at install time, which is migrate's.

Every runtime connection dials `APP_DATABASE_URL` with `options=-c role=rocketpod_system`
(`runtimeDatabaseUrl`, `apps/web/src/db/client.ts`): the session starts as the system role, and a
`RESET ROLE` leaves a connection that can read nothing. `DATABASE_SSL` applies to it like any other
(`apps/web/src/db/tls.ts`), and `loadConfig` refuses it carrying `sslmode` while `DATABASE_SSL` is
set.

`TENANT_SCOPE_MODE=enforce` requires `APP_DATABASE_URL`: on the owner the policies are bypassed, so
`enforce` would look enforced and enforce nothing.

## Operating it

Rollout, each step with its undo:

1. Set `APP_DATABASE_URL` for the migrate one-shot only and deploy: migrate creates the login.
   Undo: unset it.
2. Give web and worker `APP_DATABASE_URL` too. They now connect as the login. Undo: take it away;
   they go back to `DATABASE_URL`.
3. Optionally `TENANT_SCOPE_MODE=enforce` (after the spike in `docs/RLS.md`). Undo: `off`.
4. Take `DATABASE_URL` away from web and worker, so the owner credential never runs at request
   time (the Helm chart's `migrate.ownerOnly`). Undo: give it back.

Watch `42501` (permission denied) in the logs after step 2: it names a privilege the runtime used
that the grants do not cover.

## What this does not protect against

- **A compromised process.** The login can become `rocketpod_system`, so code running inside web
  or worker can read every tenant. The layers defend against a forgotten predicate and a wrong id.
- **SQL injection.** An injected statement runs as the login and can `SET ROLE` or `set_config`
  itself. Parameterised queries (drizzle) are the defence.
- **Unscoped paths.** Outside `withTenantScope` the system role reads every tenant: a request route
  that forgets its predicate is caught by layer 1's guard, not by RLS.
- **The job and run engines' tables** sit outside RLS. Payloads carry ids; each handler names its
  tenant.
- **Role names are cluster-wide.** Two apps on one Postgres cluster need different role names
  (the rename gives each copy its own).

## Known gaps

- Only the MCP server's tool calls run in a tenant scope; routes, jobs and agent runs rely on the
  application predicates while working as the system role.
- No audit table for cross-tenant (system role) reads.
