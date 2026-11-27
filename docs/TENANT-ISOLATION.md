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
| 4. The storage fence: tenant keys | yes | a tenant's storage handle refuses any key or prefix outside `tenants/<tenantId>/`, before a network call | `tests/api/storage-fence.test.ts`, `tests/api/testkit.test.ts` |
| 5. The storage fence: tenant credentials (`STORAGE_TENANT_FENCE`) | opt-in | each tenant's object calls are signed by credentials the bucket admits for that tenant's prefix only | `tests/api/storage-fence.test.ts` (fake STS, the S3 gateway) |

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

## 4–5. The storage fence

Object storage has one key layout: `tenants/<tenantId>/<scope>/<uuid>-<name>`
(`buildStorageKey`); a plugin writes under `tenants/<tenantId>/<plugin id>/`. There are no
platform objects: every key belongs to a tenant, and `tenant.purge` deletes that prefix.

**Keys, always.** `Platform.storage` is a `TenantStorageFactory`: code gets storage only as
`platform.storage.forTenant(tenantId)` (`apps/web/src/platform/tenant-storage.ts`). The handle
refuses a key or listing prefix outside `tenants/<tenantId>/`, or one with a `..` segment, with
`StorageTenantMismatchError`; a tenant id that is not a UUID (missing, empty, a wildcard) throws
`StorageTenantRequiredError`. There is no tenant-less handle, so a call site that cannot name its
tenant cannot reach the store at all. The tenant comes from the auth context, a job's payload or
a run's row: routes (`files.ts`, `ai-documents.ts`), the `document.convert` handler that feeds
the converter, `tenant.purge`, and every plugin context's `storage()` (`plugins/api/storage.ts`:
the tenant contexts bind their own tenant; `JobCtx`, `CronCtx` and `PublicCtx` take it per call,
`storage(tenantId)`).

**Credentials, by `STORAGE_TENANT_FENCE`** (`apps/web/src/node/storage.ts`,
`createTenantStorage`):

| Mode | Signs a tenant's calls with | A refusal |
|---|---|---|
| `off` (default) | the process's credentials (`STORAGE_*` keys, or the SDK chain) | not possible |
| `shadow` | the tenant's own session first | served with the process's credentials, logged `storage.fence_denied` (`tenantId`, `op`, `key`) |
| `on` | the tenant's own session only | an error; a HEAD/GET answers not-found |

A tenant's session is `sts:AssumeRole` of `FILES_ROLE_ARN`, `RoleSessionName` `tenant-<id>`,
`DurationSeconds` 3600, and exactly one session tag, `tenant=<id>`. Its credentials are cached per
tenant until five minutes before they expire, concurrent first calls share one AssumeRole, an
`ExpiredToken` answer drops them and retries once, and at most 256 tenant clients are kept (least
recently used out; one idle for 50 minutes is closed). Under `on` a 403 on a HEAD/GET inside the
tenant's own prefix reads as not-found, because a role that may not list the bucket gets 403 for a
missing key. `shadow` is the rollout aid: a stream body can be sent only once, so a shadow
`putStream` writes with the process's credentials and then HEADs the object over the tenant's
session, logging a denial; an AssumeRole failure is logged `storage.fence_session_failed` and
served. `on` or `shadow` without `FILES_ROLE_ARN` is a config error.

A presigned upload `PUT` (`presignPut`, `STORAGE_DIRECT_UPLOADS=true`) is a call like any other:
the key passes the tenant check first, and under `on` the URL is signed with the tenant's session —
renewed first when it would expire before the URL's 10 minutes, and the answered `expiresAt` is the
earlier of the two — so the bucket refuses a write outside the prefix even from a browser holding
the URL. Under `shadow` it is signed with the process's credentials (the browser's request cannot
fall back).

The contract the infrastructure provides (`docs/DEPLOY.md` § The storage tenant fence): a files
role the app's identity may assume and tag, whose permissions interpolate the `tenant` tag into the
object ARN and the `s3:prefix` condition, and a bucket that, once fenced, admits object calls from
that role only.

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

The storage fence, independently:

1. Provide the files role (`docs/DEPLOY.md`), set `FILES_ROLE_ARN` and `STORAGE_TENANT_FENCE=shadow`.
   Undo: `off`.
2. Watch `storage.fence_denied` and `storage.fence_session_failed`: each names a call the fenced
   credentials would have refused. None for a representative period → `on`. Undo: `shadow`.
3. Deny object access to anyone but the files role in the bucket policy. Undo: lift the deny.

## What this does not protect against

- **A compromised process.** The login can become `rocketpod_system`, so code running inside web
  or worker can read every tenant. The layers defend against a forgotten predicate and a wrong id.
- **SQL injection.** An injected statement runs as the login and can `SET ROLE` or `set_config`
  itself. Parameterised queries (drizzle) are the defence.
- **Unscoped paths.** Outside `withTenantScope` the system role reads every tenant: a request route
  that forgets its predicate is caught by layer 1's guard, not by RLS.
- **The job and run engines' tables** sit outside RLS. Payloads carry ids; each handler names its
  tenant.
- **Presigned URLs** are issued for uploads only, with `STORAGE_DIRECT_UPLOADS` on: one key, one
  type and length, write-once, 10 minutes. A leaked URL is usable by anyone holding it until it
  expires or the object exists. Every read still passes through the server.
- **The storage fence's process.** The app's identity may assume the files role for ANY tenant;
  the fence defends against a call site that names the wrong tenant or a key that escapes its
  prefix, not against code that chooses to assume another tenant's session.
- **Role names are cluster-wide.** Two apps on one Postgres cluster need different role names
  (the rename gives each copy its own).

## Known gaps

- Only the MCP server's tool calls run in a tenant scope; routes, jobs and agent runs rely on the
  application predicates while working as the system role.
- No audit table for cross-tenant (system role) reads.
- The storage fence is AWS-shaped (STS session tags); another S3-compatible store has `off` only,
  where the key check still applies.
