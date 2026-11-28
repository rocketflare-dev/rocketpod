# Changelog

Releases of the kit. Each one links to its porting note in [`docs/upgrades/`](docs/upgrades/) —
the note is the instruction set `pnpm kit:upgrade` and the `/rp-upgrade` skill follow to bring a
copy of the kit forward without recreating anything its owner deleted.

If you are running a copy: `pnpm kit:upgrade` tells you which of these you are missing.

## 0.46.1 — 2026-11-28

Migrate accepts the tenant role itself (`<snake>_app`) as `APP_DATABASE_URL`'s login, for platforms that provision the login under that name, and `pnpm kit:release` no longer refuses a version file that already carries the release's version.
[Porting note](docs/upgrades/0.46.1.md).

## 0.46.0 — 2026-11-28

Rocketpod catches up with Rocketflare 0.46.0: uploads go through `/api/uploads` (reserve, `PUT`, confirm), straight to S3 on a presigned URL when `STORAGE_DIRECT_UPLOADS` is on, and plugins gain `uploadTargets`.
[Porting note](docs/upgrades/0.46.0.md).

## 0.45.1 — 2026-11-27

Rocketpod catches up with Rocketflare 0.45.0: run timelines show model calls, knowledge gains a Promote picker, contextual prefixes and CLI `docs`/`facts`, `plugin check` parses source, a guard and a UI lint steer agents, and Home and sign-in are redesigned.
[Porting note](docs/upgrades/0.45.1.md).

## 0.45.0 — 2026-11-27

Email goes through a new `mailer` platform member, and Amazon SES v2 joins Resend as a provider (`EMAIL_PROVIDER=log|resend|ses`), so a deployment on AWS sends with its ECS task role and no API key.
[Porting note](docs/upgrades/0.45.0.md).

## 0.44.1 — 2026-11-24

Rocketpod catches up with Rocketflare 0.44.1: an MCP server that is its own OAuth authorization server, one tool seam for chat, agents and MCP, `pnpm gate --changed`, TypeScript 7, and a `kit:upgrade` that 3-way merges.
[Porting note](docs/upgrades/0.44.1.md).

## 0.40.0 — 2026-11-20

Rocketpod catches up with Rocketflare 0.40.0: a durable agent runtime, a structured knowledge base with typed facts, two security rounds, a remote MCP server at `/mcp`, and upgrade tooling that resumes after rejects.
[Porting note](docs/upgrades/0.40.0.md).

## 0.32.2 — 2026-11-11

Rocketpod catches up with Rocketflare 0.32.2 and takes its version: identity seam, agents at volume, Node 26 and current dependencies, the security hardening round, public sites, platform knowledge and plugin events.
[Porting note](docs/upgrades/0.32.2.md).

## 0.2.0 — 2026-10-30

Every runtime capability is now a neutral `Platform`, a Node entry (`src/node/server.ts`) serves the app with one Postgres pool per process, and the Neon serverless driver is removed.
[Porting note](docs/upgrades/0.2.0.md).

## 0.1.0 — 2026-10-12

The first Rocketpod release: Rocketflare 0.19.0 forked and renamed, the baseline every later Rocketpod release chains back to.
[Porting note](docs/upgrades/0.1.0.md).
