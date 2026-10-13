# Adapt — the rows that need a person

`scripts/rename.mjs` prints these as "Careful rows (a)–(f)" and fixes what is mechanical. Walk
them in order after the rename has run, then (g) — which the script does not print — when this app
has a plugin installed. Paths are repository-relative; `<slug>` / `<snake>` /
`<UPPER>` are the names the script printed on its first line (`my-app` / `my_app` / `MY_APP`).

---

## (a) API-key display handles — usually done by the script

**What to check.** Keys are `<snake>_<43 chars>`. Two constants decide how many characters of a
key are shown in lists: `API_KEY_PREFIX_LENGTH` in `apps/web/src/api/utils/core/hash.ts` (the
server's stored handle, prefix + 8) and `REDACTED_KEY_CHARS` in `apps/cli/src/config.ts` (the
CLI's masked form, prefix + 4). If either is not longer than `<snake>_`, every listed key shows
zero characters of its token; the CLI tests assume exactly prefix + 4.

**How to check.**
```
grep -n "API_KEY_PREFIX\b\|API_KEY_PREFIX_LENGTH" apps/web/src/api/utils/core/hash.ts
grep -n "REDACTED_KEY_CHARS" apps/cli/src/config.ts
```
Expect `API_KEY_PREFIX = '<snake>_'` (separator included, never the hyphenated `<slug>`),
`API_KEY_PREFIX_LENGTH = <len(snake_) + 8>` and `REDACTED_KEY_CHARS = <len(snake_) + 4>`, with
the `(<n>) + 8` / `+ 4` comments matching.

**What to change.** Nothing if the values match. If the script reported it could not read a
constant, set both by hand to the values it printed; if it warned about `API_KEY_PREFIX`, set it
to `'<snake>_'`. Existing keys keep working — only the handle
in lists changes.

## (b) The RLS role and the database — a decision, not a find/replace

**What to check.** `apps/web/migrations/*.sql` and `migrations/meta/*.json` now name the role
`<snake>_app` in every policy (`apps/web/src/db/schema/rls.ts` `APP_ROLE` matches). A database
that already ran the migrations under the OLD name keeps the old role and policies; the new
migration files will not re-apply to it. `EMBEDDING_DIM` (`packages/shared/src/ai/config.ts`,
1024) is a column type in the same migrations — a different embedding model with another width
must be chosen now, not after data exists (`docs/ADAPTING.md` §3).

**How to check.**
```
docker ps --format '{{.Names}}' | grep -- -postgres
docker volume ls --format '{{.Name}}' | grep -- -dev-data
grep -n "APP_ROLE" apps/web/src/db/schema/rls.ts
grep -c "<snake>_app" apps/web/migrations/0000_*.sql
```
Expect: no container or volume with the OLD kit name (only `<slug>-dev-postgres` /
`<slug>-dev-data` once you have run `pnpm dev:db:up`); `APP_ROLE = '<snake>_app'`; a non-zero count.

**What to change.** If the old container/volume exists, remove them — the renamed compose file
cannot: `docker rm -f <old>-dev-postgres && docker volume rm <old>-dev-data` (same for
`-test-postgres`). Then `pnpm dev:db:up && pnpm db:migrate` builds a fresh database under the new
names. Also `apps/web/.env` — the script renames its `DATABASE_URL` when the file exists;
confirm it reads `postgresql://<snake>:<snake>_pass@localhost:5432/<snake>_dev`. Decide the
embedding dimension now if your embeddings model cannot answer 1024 dimensions (the default,
OpenAI's `text-embedding-3-small`, is asked for 1024).

## (c) Docker names — done by the script, confirm once

**What to check.** `container_name` and the volume in `apps/web/docker-compose.dev.yml` and
`docker-compose.test.yml` are pinned names; two checkouts of the same kit on one machine collide
on them. The Postgres owner is `<snake>` (never `<slug>` — `db-roles.ts` refuses a hyphenated
identifier), the databases `<snake>_dev` / `<snake>_test`.

**How to check.**
```
grep -n "^name:\|container_name\|POSTGRES_\|-dev-data\|pg_isready" apps/web/docker-compose.dev.yml apps/web/docker-compose.test.yml
```
Expect `<slug>-dev-postgres`, `<slug>-test-postgres`, `<slug>-dev-data`, `name: <slug>-test` (the test
file's Compose project), `POSTGRES_USER: <snake>`,
`POSTGRES_DB: <snake>_dev` / `<snake>_test`, and `pg_isready -U <snake> -d <snake>_dev`.

**What to change.** Nothing, normally. If you want a different owner or password, change the
compose file, `apps/web/.env.example`, `.env` and `.env.test` together.

## (d) Environments — nothing account-scoped is named after the app

**What to check.** Staging and production are two deployments of one image, each with its own
environment (`DATABASE_URL`, `STORAGE_BUCKET`…). `JOBS_QUEUE_NAME_PREFIX` in
`apps/web/src/api/services/jobs.ts` must be `<slug>-jobs` — the consumer matches the queue by
that prefix, and each environment's queue lives in that environment's own database.

**How to check.**
```
grep -n "JOBS_QUEUE_NAME_PREFIX =" apps/web/src/api/services/jobs.ts
```

**What to change.** Nothing, normally; the rename wrote it.

## (e) Brand colour — the user's choice

**What to check.** With `--colour`, the script rewrote the light theme's primary
(`--color-primary`, `--surface-active`, `--focus-ring`, `--dc-primary-rgb`) in
`apps/web/src/ui/index.css` and `<meta name="theme-color">` in `apps/web/src/ui/index.html`.
Without it, the kit's blue is still there. Either way the rest of the palette is untouched: the
dark theme's `--color-primary`, both `--color-primary-content` values (text on the accent), the
`--tone-primary-*` tints, `--color-accent`, and the neutral ramp. The header comment block of
`index.css` ("REBRANDING — change these and nothing else") lists every knob.

**How to check.**
```
grep -n "color-primary\|surface-active\|focus-ring\|dc-primary-rgb\|tone-primary" apps/web/src/ui/index.css
pnpm web test:ui
```
Expect the new hex where the script said and the UI tests green. No test checks contrast, so
check WCAG AA by hand (text 4.5:1, controls and focus ring 3:1).

**What to change.** Ask the user for their palette. Change the values in `index.css` only (the
`/* blue-600 */`-style comments beside them are now stale — update or drop them). Re-run
`pnpm web test:ui` after every change and re-check the contrast ratios yourself.

## (f) Logo — report only

**What to check.** `apps/web/src/ui/components/shared/LogoMark.tsx` (inline SVG paths),
`apps/web/src/ui/public/logo.svg` and `apps/web/src/ui/public/favicon.svg` still carry the kit's
rocket. The script never touches them.

**How to check.**
```
ls -la apps/web/src/ui/public/ apps/web/src/ui/components/shared/LogoMark.tsx
```
Open http://localhost:3000 once the app runs: the mark in the header and the browser tab.

**What to change.** Replace the `<path>`s in `LogoMark.tsx` (keep the `viewBox` and the
`className` prop) and the two svgs with the user's mark. A monochrome mark can use
`fill="currentColor"` with `className="text-primary"` to follow the theme.

## (g) Installed plugins — translated on the way in, and again on the way forward

**What to check.** A plugin is a git repository copied into this app, and it is written in the
**kit's** vocabulary — `@rocketpod/shared`, `rocketpod_app`, the kit's own name in strings and
comments. `scripts/rename.mjs` walks every tracked file, so a plugin's three directories are
renamed exactly like core code; the dry-run table shows them as ordinary file rows under
`apps/web/src/plugins/<id>/`, not as a group of their own. What matters here is that it actually
reached them, because a missed import is a `typecheck` failure with a confusing message
(`Cannot find module '@rocketpod/shared/...'`) rather than an obvious rename bug.

The same is true **later**: `pnpm plugin add` and `pnpm plugin upgrade` run the identical
`applyReplacements()` translation on every file they copy in, reading the token map back out of
`.rocketflare.json`'s `app` block. So a plugin installed after the rename arrives already in this
app's names, and you never translate one by hand.

**How to check.**
```
pnpm plugin list
grep -rn "@rocketpod/\|rocketpod_" apps/web/src/plugins packages/shared/src/plugins apps/cli/src/plugins 2>/dev/null | head
pnpm plugin check
```
Expect: `No plugins installed.` (then there is nothing to do here), or one line per plugin and an
**empty** grep — every kit token translated — and `✔ n plugin(s) check out`.

**What to change.** Nothing, normally. A surviving `@rocketpod/…` import means the rename could
not see that file: fix it by hand, then `pnpm typecheck`. Never edit the five barrels
(`apps/web/src/plugins/{server,ui,schema}.ts`,
`packages/shared/src/plugins/index.ts`, `apps/cli/src/plugins/index.ts`) to make something pass — `pnpm plugin` writes those lines, and
`check` comparing them to the tree is what proves the install is real. If `check` reports a missing
migration for a plugin's tables, that is (b)'s fresh database, not a rename problem: `pnpm
db:generate --name plugin-<id>-<version>` then `pnpm db:migrate`.

---

When all six — seven with a plugin installed — are done: `pnpm gate`, commit, then update `docs/ADAPTING.md` §1 (or delete the table) so the next reader
knows the rename happened.
