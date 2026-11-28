# Adapt — the rows that need a person

`scripts/rename.mjs` prints these as "Careful rows" (a)–(j), plus (k) when `.rocketflare.json` has
no kit commit, and fixes what is mechanical; the letters here are the letters it prints. Walk them
in order after the rename has run, then (l) — which the script does not print — when this app has
a plugin installed. Paths are repository-relative; `<slug>` / `<snake>` /
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

**What to check.** `--colour` takes a `#hex`, an `oklch()` or a hue in degrees. What it does
depends on the palette in `apps/web/src/shared/theme-tokens.css` and the two `[data-theme]`
blocks of `apps/web/src/ui/index.css`:
- **an `oklch()` palette on one hue** — every one of those literals turned to the colour's hue,
  keeping each lightness and chroma (which is what keeps contrast); the flare and the state
  colours keep their own hue. It takes only the HUE: an exact primary is a brand.css job.
- **a hex palette** (the kit's blue on zinc today) — the light theme's `--color-primary` hex
  replaced wherever it appears (`--color-primary`, `--surface-active`, `--focus-ring`, the rail's
  active tones); a bare hue is refused. The dark primary, both `--color-primary-content` values,
  the `--tone-primary-*` tints, `--selection-surface`, `--color-accent` and the series are left
  for you (the report lists them).

Either way `<meta name="theme-color">` in `apps/web/src/ui/index.html` becomes the new light
primary. The header comment block of `index.css` ("REBRANDING — change these and nothing else")
lists every knob.

**How to check.**
```
grep -n "color-primary\|surface-active\|focus-ring\|rail-active\|tone-primary" apps/web/src/shared/theme-tokens.css apps/web/src/ui/index.css
pnpm web test:ui
```
Expect the new colour where the script said, and `tests/ui/contrast.test.ts` green (WCAG AA: text
4.5:1, controls, focus ring and chart series 3:1).

**From the design.** If `docs/design/brand.css` exists (the `rp-design` style step, signed off),
apply it instead of asking: `pnpm design:docs --apply-brand` writes each property into whichever of
`theme-tokens.css` and `index.css` defines it (a `--brand-hue` turns an `oklch()` palette first),
plus `<meta name="theme-color">`. A brand.css that names a new font also needs its
`@fontsource-variable/*` package added to `apps/web/package.json` and imported in
`apps/web/src/ui/main.tsx`. Then run `pnpm web test:ui`. Show the user `git diff --stat` and the
swatches from `docs/design/06-brand.md`. Skip `--colour` on the rename in that case, because the
brand already sets the colour.

**What to change.** Ask the user for their colour. Write it in `docs/design/brand.css` (a hue as
`@theme { --brand-hue: <n>; }` on an `oklch()` palette, else `--color-primary` and its tones) and
run `pnpm design:docs --apply-brand`. Re-run `pnpm web test:ui` after every change; a failing
contrast test names the token and the ratio.

## (f) Logo and the sign-in panel — report only

**What to check.** `apps/web/src/ui/components/shared/LogoMark.tsx` (inline SVG paths),
`apps/web/src/ui/public/logo.svg` and `apps/web/src/ui/public/favicon.svg` still carry the kit's
rocket. The script never touches them.

Beside them, the sign-in page's right-hand panel:
- **the image:** `apps/web/src/ui/components/LoginArt.tsx`, the kit's rocket as tonal linework.
  It takes its colours from the rail and flare tokens (`.login-art*` in `index.css`), so it
  already wears the new palette, but it is still the kit's picture;
- **the tagline:** `LOGIN_PANEL.tagline` in `apps/web/src/ui/lib/login-panel.ts`. The rename set it
  from `docs/design/design.json` `app.tagline` when the design has one (the report says which);
  otherwise it is still the kit's line.

**How to check.**
```
ls -la apps/web/src/ui/public/ apps/web/src/ui/components/shared/LogoMark.tsx
grep -n "art:\|tagline:" apps/web/src/ui/lib/login-panel.ts
```
Open the app (`pnpm dev` prints its URL) once it runs: the mark in the header and the browser tab,
then sign out to see the sign-in panel (it shows from `lg` up).

**What to change.** Replace the `<path>`s in `LogoMark.tsx` (keep the `viewBox` and the
`className` prop) and the two svgs with the user's mark. A monochrome mark can use
`fill="currentColor"` with `className="text-primary"` to follow the theme. For the panel, do what
`docs/design/06-brand.md` recorded, or ask: keep the rocket in their colours, replace the SVG in
`LoginArt.tsx` with imagery they own (colours from `currentColor` and the `.login-art*` classes,
so it follows the theme), or set `art: 'type'` in `login-panel.ts` for the name and tagline alone.
Write the tagline in their words if the rename did not.

## (g) Local ports — done by the script

**What to check.** The report names this app's port block (between 5600 and 6999): the dev UI and
API (`pnpm dev`'s Vite and Node server, the kit's :3000/:3001), test Postgres, test S3, and where
the dev Postgres and dev S3 ranges start. The block is chosen from the slug and checked free on this
machine, so the app, the kit and Rocketflare can each run `pnpm dev`, `pnpm test` and a dev
database at the same time. The CONTAINER still listens on :3001 — compose, the Dockerfile and the
chart are not touched.

**How to check.**
```
grep -n "PORT" scripts/lib/bootstrap-lib.mjs | head -8
grep -n "DEFAULT_.*_PORT =" scripts/lib/dev-ports.mjs
grep -n "ports:" -A2 apps/web/docker-compose.test.yml
```

**What to change.** Nothing, normally. If the report warned that every block was taken, free a
port and re-run the rename, or set `TEST_DB_PORT` / `TEST_S3_PORT` and their mentions by hand.

## (h) Helm chart — done by the script

**What to check.** `deploy/helm/<slug>/` exists and `deploy/helm/rocketpod/` does not; the chart's
`name` and every path to it already say the slug.

**How to check.**
```
ls deploy/helm/   # then `pnpm gate`: packaging.test.ts reads the chart from its new path
```

## (i) Image and chart links — the owner's registry and repository

**What to check.** The rename turned `ghcr.io/rocketflare-dev/rocketpod` into
`ghcr.io/rocketflare-dev/<slug>` in the chart values, the compose example and the docs: a
placeholder, because only the owner knows where the image is published. `image.yml` publishes
`ghcr.io/<their GitHub org>/<slug>`. The chart's `home` and `sources` still point at the kit's
repository (`rocketflare-dev/rocketpod` is upstream, so the rename keeps it).

**How to check.**
```
grep -rn "ghcr.io/" deploy docs/DEPLOY.md | head
grep -n "home:\|sources:" -A1 deploy/helm/*/Chart.yaml
```

**What to change.** Ask for the GitHub org (or registry) and the app's repository URL, then set the
image owner in those files and the chart's `home`/`sources`. Nothing else depends on it.

## (j) Licence — whose app this is

**What to check.** The root `LICENSE` is still the kit's MIT notice, and every `package.json` says
`"license": "MIT"`. Left alone, the app's own code reads as MIT-licensed, with copyright in the kit
author's name. `LICENSES/kit-MIT.txt` holds the kit's notice, which the MIT licence requires the
app to keep.

**How to check.**
```
head -3 LICENSE; grep -n '"license"' package.json apps/*/package.json packages/*/package.json
cat docs/design/design.json 2>/dev/null | grep -A2 '"owner"'
```

**What to change.** Take the owner and licence from `design.json` `owner`, or ask: "Who owns this
app, by legal name, and may anyone else use its code?" Recommend all rights reserved.
- **All rights reserved:** write `LICENSE` as
  `Copyright (c) <year> <legal name>. All rights reserved.`, then a blank line, then
  `This app includes the Rocketpod starter kit, used under the MIT licence. Its notice is in
  LICENSES/kit-MIT.txt.`. Set every `package.json` `"license"` to `"UNLICENSED"` (npm's word for
  "not licensed to others").
- **An open licence:** write that licence's text with their name, add the same sentence about the
  kit, and set `"license"` to its SPDX id.

Never edit or delete `LICENSES/kit-MIT.txt`. `LICENSE` and `LICENSES/**` are on `neverPort`, so a
later `kit:upgrade` leaves both alone.

## (k) Kit commit — printed only when it is missing

**What to check.** The script prints this row only when `.rocketflare.json` `kit.commit` is null:
`pnpm kit:upgrade` then cannot tell which kit release this copy started from. `scripts/detach.sh`
(the installer, `/rp-start`, `/rp-setup`) records it, so a detached copy never sees this row.

**How to check.** `grep -n '"commit"' .rocketflare.json | head -1`

**What to change.** Set it to the kit commit the copy was cloned at (`git rev-parse HEAD` in the
kit's clone, before detaching; the first commit's message says `Kit commit: <sha>` after a detach).

## (l) Installed plugins — not printed by the script; translated on the way in, and again on the way forward

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

When all of them are done: `pnpm gate`, commit, then update `docs/ADAPTING.md` §1 (or delete the table) so the next reader
knows the rename happened.
