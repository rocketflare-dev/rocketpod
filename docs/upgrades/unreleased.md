---
version: unreleased
previous: 0.46.0
date: null
breaking: false
migrations: []
areas: [tooling, db, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Migrate accepts the tenant role itself (`<snake>_app`) as `APP_DATABASE_URL`'s login, for platforms that provision the login under that name, and `pnpm kit:release` releases a version a version file already carries instead of refusing it.

- `scripts/release.mjs`: a version file already at the release version is stamped as it is; a file with no version field is still an error (`tests/kit-only/release-stamp.test.ts`).
- `apps/web/scripts/db-roles.ts`: an `APP_DATABASE_URL` user equal to `APP_ROLE` makes that role LOGIN NOINHERIT with the URL's password, grants it `SYSTEM_ROLE` and CONNECT, and changes nothing else about it; the owner, `SYSTEM_ROLE` and a non-identifier are still refused; the separate login is unchanged (`docs/TENANT-ISOLATION.md` § 3).
- `apps/web/scripts/db-roles.ts` post-check: the app login, either shape, must not inherit `SYSTEM_ROLE`'s privileges (a grant `WITH INHERIT TRUE` fails migrate).
- `apps/web/src/db/client.ts` `runtimeDatabaseUrl`: for a login that IS `APP_ROLE`, adds `-c statement_timeout=0 -c idle_in_transaction_session_timeout=0 -c lock_timeout=0` before the URL's own `options`, so the tenant role's per-role timeouts do not govern system-role sessions.
- `apps/web/tests/api/db-roles.test.ts`: the tenant role as the login (log in, RLS binds, system-role path, rerun and password change, refusals).

## How to apply

1. Take the `scripts/release.mjs` hunk as it is.
2. Take the `apps/web/scripts/db-roles.ts` hunks as they are: `appLoginOf` refuses only the owner, `SYSTEM_ROLE` and a non-identifier and returns `isAppRole`; the role phase skips creating the login and grants only `SYSTEM_ROLE` when `isAppRole`; `postCheck` adds `inherits_system`.
3. Take the `runtimeDatabaseUrl` hunk in `apps/web/src/db/client.ts` as it is (it imports `APP_ROLE` from `./schema/rls`).
4. Take the new `describe` blocks and the reworked refusal test in `apps/web/tests/api/db-roles.test.ts`.
5. Take the `docs/TENANT-ISOLATION.md` § 3, `docs/DEPLOY.md` § Two database logins, `docs/RLS.md`, `docs/CONCEPTS.md` and `apps/web/src/db/CLAUDE.md` hunks, keeping the copy's role names.
6. Nothing to do in a deployment that uses a separate login: migrate behaves as before.

## Conflicts to expect

- `apps/web/scripts/db-roles.ts` → a copy that edited `appLoginOf` or the login statements → keep the copy's edits and re-apply the `isAppRole` branches.

## Verify

1. `pnpm test kit-only apps/web/tests/kit-only/release-stamp.test.ts` passes.
2. `pnpm test api apps/web/tests/api/db-roles.test.ts apps/web/tests/api/rls-enforcement.test.ts` passes.
