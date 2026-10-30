# Contributing

Welcome — thanks for your interest in Rocketpod.

Rocketpod (a container-native fork of Rocketflare, `docs/FORK.md`) is maintained by
[Clifton Cunningham](https://github.com/cliftonc) and community contributors. All contributions are reviewed and approved by the maintainer.

Ways to contribute:

- [Submitting a bug report](#bug-report)
- [Submitting a feature request](#feature-request)
- [Providing feedback](#feedback)
- [Contribution guidelines](#contribution-guidelines)

## <a name="bug-report"></a> Submitting a bug report

Open an [issue](https://github.com/rocketflare-dev/rocketpod/issues/new) with a title starting
"Bug: ". Include the command you ran, the output, and whether a fresh clone following `SETUP.md`
Part 1 reproduces it. Security issues go through [`SECURITY.md`](SECURITY.md), not a public issue.

## <a name="feature-request"></a> Submitting a feature request

Open an [issue](https://github.com/rocketflare-dev/rocketpod/issues/new) with a title starting
"Feature Request: ". Say which subsystem it belongs to (`docs/CONCEPTS.md` has one section per
subsystem, each ending in **Known gaps** — check there first; many good ideas are already listed as
deliberate omissions with a reason).

## <a name="feedback"></a> Providing feedback

- Start a thread in [Discussions](https://github.com/rocketflare-dev/rocketpod/discussions).
- Mention the maintainer on [BlueSky — @cliftonc.nl](https://bsky.app/profile/cliftonc.nl).

## <a name="contribution-guidelines"></a> Contribution guidelines

- [Setup](#setup)
- [Repository structure](#repository-structure)
- [What a change must include](#what-a-change-must-include)
- [Running tests](#running-tests)
- [Commit message guidelines](#commit-message-guidelines)
- [PR guidelines](#pr-guidelines)
- [Cutting a release](#cutting-a-release)
- [Architecture guidelines](#architecture-guidelines)

### <a name="setup"></a> Setup

Node 24 (`.nvmrc`), pnpm 10 (`corepack enable` reads `packageManager`), Docker; macOS or Linux
(Windows: WSL2). Then:

```bash
git clone https://github.com/rocketflare-dev/rocketpod.git && cd rocketpod
bash scripts/bootstrap.sh        # toolchain → install → .env → Postgres + S3 → migrate → plugins → seed --demo → … → pnpm dev, signed in
pnpm test                        # the full suite; starts a throwaway Postgres on :5533 and an S3 gateway on :7433
```

The bootstrap is [`SETUP.md`](SETUP.md) Part 1 as one re-runnable command — every step prints a
`✔ n/10` verification line; the numbered steps there are what it runs, for doing it by hand or
debugging one step (`pnpm preflight` is the read-only check). No external credentials are needed:
magic links are logged; chat, agents and embeddings answer 503 until an AI provider key is in
`apps/web/.env` (`SETUP.md` 2.5). The gate needs no key — tests use an in-process fake. If you are
working somewhere Docker cannot run, `pnpm web test:config` and `pnpm --filter @rocketpod/cli test`
need no database; the `api`, `api-isolated` and `driver` projects do.

### <a name="repository-structure"></a> Repository structure

A pnpm workspace; `CLAUDE.md` is the map and every significant directory has its own `CLAUDE.md`.

- 📂 `apps/web/` — `@rocketpod/web`: the Node server (Hono API; `src/node/` holds the entry and the
  pg-boss, OpenWorkflow, realtime, S3 and limits adapters) and the React UI, plus `migrations/`,
  `scripts/`, `tests/`
- 📂 `apps/cli/` — `@rocketpod/cli`: the `rocketpod` command-line client
- 📂 `apps/evals/` — `@rocketpod/evals`: developer-run eval suites (`pnpm eval`, never the gate)
- 📂 `packages/shared/` — `@rocketpod/shared`: the zod contracts the API validates with and the UI
  and CLI parse with (private, consumed as TypeScript source)
- 📂 `docs/` — `CONCEPTS.md` (how each subsystem works, the decision record, and its known gaps),
  `ADAPTING.md`, `DEPLOY.md`, `RLS.md`, `FORK.md`, `upgrades/` (one porting note per release)
- 📂 `deploy/` — the Helm chart and the compose overrides; the root `Dockerfile` and
  `docker-compose.yml` build and run the image
- 📂 `scripts/` — first-run tooling: `bootstrap.sh` / `bootstrap.mjs`, `install.sh`, `rename.mjs`,
  `lib/`; the gate and test runner: `gate.mjs`, `test.mjs`; plugins: `plugin.mjs`; and the
  upgrade path: `upgrade.mjs`, `release.mjs`, `release-check.mjs`
- 📂 `.claude/rules/` — layer conventions (api, database, ui, cli, testing, code-quality,
  runtime), loaded by path when you or a coding agent touch that layer; `.claude/skills/` — the
  `/rp-*` slash commands (`/rp-setup`, `/rp-preflight`, `/rp-adapt`, `/rp-deploy`, `/rp-upgrade`…)

### <a name="what-a-change-must-include"></a> What a change must include

The repo's **non-negotiables** are listed in `CLAUDE.md`; the ones contributors hit most:

- **The gate is green**: `pnpm gate` before every commit (it starts the test database and S3
  gateway itself).
- **A behaviour change adds an entry to `docs/upgrades/unreleased.md`.** People are running copies
  of this kit that were detached and renamed; they absorb your change by running `/rp-upgrade`,
  which is guided by those notes. A change with no note never reaches them. `docs/upgrades/README.md`
  has the shape, and CI fails a pull request that touches `apps/**` or `packages/**` without one.
- **Never rewrite released history.** Every copy pins a kit commit in its `.rocketflare.json`; a
  force-push over a released tag orphans each one of them, permanently. Releases are cut with
  `pnpm kit:release <version>` and the tag gate refuses one without its porting note.
- **Contracts first**: a new or changed API surface starts as a zod schema in
  `packages/shared/src/`, then the route validates with it, then the UI/CLI parse with it.
- **Tenant isolation**: every domain query filters by the tenant from the auth context; every tenant
  table calls `tenantIsolation()`; a plugin with a query surface of its own (the analytics plugin's
  cubes) proves it scopes in its own test.
- **Routes enqueue, never run** long work; concurrency is a database claim row, never a `Map`.
- **Config, compose and chart agree**: a new var or secret in `src/config.ts` goes into
  `apps/web/.env.example`, `deploy/compose.env.example` if compose needs it, and the chart's
  `config` / `secrets` — `tests/config/packaging.test.ts` fails otherwise.
- **Docs in sync**: a behaviour change updates `docs/CONCEPTS.md` (and its "Known gaps"), `SETUP.md`,
  `docs/DEPLOY.md` or the relevant `.claude/rules/*.md` in the same PR. The table in
  `.claude/rules/code-quality.md` says which.
- **No secrets** in a committed values file, a test, a fixture comment or a response body; `gitleaks` runs in CI over
  the full history.

### <a name="running-tests"></a> Running tests

Tests run under Node against the real Hono app and a **real Postgres** on port 5533
(started by `pnpm test`), never a mock database; storage tests use a real S3 gateway.
`apps/web/vitest.config.ts` defines these projects:

| Project | Needs a database | Covers |
|---|---|---|
| `api` | yes | routes, services, queue consumers, the agent-run body, cron tasks |
| `api-isolated` | yes | files marked `// @vitest-isolate` (they mock modules or globals) and the Node adapters — server, pg-boss, OpenWorkflow, realtime, S3, limits |
| `driver` | yes | the driver seam's conformance suite |
| `ui` | no (jsdom) | components, hooks, providers, streaming and websocket clients |
| `config` | no | packaging parity, the platform-seam guard, env schema, permissions matrix, pure helpers |
| `kit-only` | no | the kit's own release, rename and manifest machinery (deleted in a copy) |

```bash
pnpm test                       # every package
pnpm web test:api               # or test:ui, test:config
pnpm --filter @rocketpod/cli test
pnpm test:coverage
```

Conventions (`.claude/rules/testing.md`): tests never truncate tables — create unique data and let
it stay; a file that uses `vi.mock` / `vi.stubGlobal` / `vi.spyOn(globalThis…)` starts with exactly
`// @vitest-isolate`; every API test file has a tenant-isolation assertion, a 401, a wrong-role 403
and one error-envelope check. A new job type, cube, fact table, agent or realtime event has a named
test shape in that file — follow it.

### <a name="commit-message-guidelines"></a> Commit message guidelines

```
<subject>
<BLANK LINE>
<body>
```

Subject in the imperative, under 72 characters, no trailing period; the body says *why* and what a
reader should know (the doc that changed, the test that pins it). Example:

```
Queue the access-request decision email

The route answered only after Resend returned; a provider outage failed
the approval. Enqueue email.send instead — the consumer retries with backoff.
```

> [!WARNING]
> Sign your commits before opening a PR — see GitHub's guide to
> [commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification).

### <a name="pr-guidelines"></a> PR guidelines

1. Title: `[<area>] <subject>` — area is `web`, `cli`, `shared`, `docs`, `ci`, or a subsystem such as
   `auth`, `analytics`, `ai`.
2. The description says what changed, why, and how you verified it (the gate, plus any manual check
   from `SETUP.md`).
3. Tests for the feature or the bug, in the project and shape above.
4. Docs updated in the same PR (see "Docs in sync").
5. One concern per PR; a rename or refactor travels separately from a behaviour change.

### <a name="cutting-a-release"></a> Cutting a release

Maintainers only.

1. `pnpm kit:release X.Y.Z`, then `node scripts/release-check.mjs --tag X.Y.Z` and the gate.
2. `git commit -am "Release X.Y.Z" && git tag -m "Release X.Y.Z" X.Y.Z && git push origin main X.Y.Z`.
   The tag has to be annotated because tags are signed. `image.yml` builds and pushes
   `ghcr.io/rocketflare-dev/rocketpod:X.Y.Z`, and `notify-plugins.yml` sends the plugin repositories a `rocketpod-released` dispatch.
3. The CLI is meant to publish to npm as `rocketpod` / `@rocketpod/cli`; there is no publish
   workflow yet (`docs/ROADMAP.md` → Next), so that step is manual or skipped.

### <a name="architecture-guidelines"></a> Architecture guidelines

- **One image, three modes.** Everything ships as one container image running `web`, `worker` or
  `all`; `process.env` is read only in `src/node/` (which hands it to `loadConfig` in
  `src/config.ts`), and runtime capabilities are reached through the `Platform` seam (`src/platform/types.ts`), never imported from an adapter.
- **Postgres is the truth.** Realtime events are nudges that make the UI re-query; job and run state
  lives in rows; vectors live in pgvector under the tenant predicate.
- **Drizzle only, parameters only.** SQL goes through Drizzle or the `sql` tag with bound parameters;
  never string concatenation. One driver (postgres.js) behind `openDatabase`; code outside
  `db/client.ts` never names it, and reads raw results through `rows()` / `affected()`.
- **Optional capabilities degrade loudly or silently by design.** A missing platform member either
  no-ops (rate limit, tracing, realtime) or throws/503s (jobs, storage, runs) — the service header
  says which; a new capability must choose.
- **Frozen names.** Cube members, job `type` strings and realtime event types are contracts stored or
  consumed elsewhere — add, never rename.
- **Agent-readable by default.** If you change a convention, change the `.claude/rules/*.md` or
  directory `CLAUDE.md` that states it; a future contributor's coding agent reads those first.

## Getting help

- 📖 `docs/CONCEPTS.md`, `SETUP.md`, `docs/DEPLOY.md`
- 🐛 [Existing issues](https://github.com/rocketflare-dev/rocketpod/issues)
- 💬 [Discussions](https://github.com/rocketflare-dev/rocketpod/discussions)

Thank you for contributing to Rocketpod! 🚀
