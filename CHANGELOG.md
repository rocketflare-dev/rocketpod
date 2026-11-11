# Changelog

Releases of the kit. Each one links to its porting note in [`docs/upgrades/`](docs/upgrades/) —
the note is the instruction set `pnpm kit:upgrade` and the `/rp-upgrade` skill follow to bring a
copy of the kit forward without recreating anything its owner deleted.

If you are running a copy: `pnpm kit:upgrade` tells you which of these you are missing.

## 0.32.2 — 2026-11-11

Rocketpod catches up with Rocketflare 0.32.2 and takes its version: identity seam, agents at volume, Node 26 and current dependencies, the security hardening round, public sites, platform knowledge and plugin events.
[Porting note](docs/upgrades/0.32.2.md).

## 0.2.0 — 2026-10-30

Every runtime capability is now a neutral `Platform`, a Node entry (`src/node/server.ts`) serves the app with one Postgres pool per process, and the Neon serverless driver is removed.
[Porting note](docs/upgrades/0.2.0.md).

## 0.1.0 — 2026-10-12

The first Rocketpod release: Rocketflare 0.19.0 forked and renamed, the baseline every later Rocketpod release chains back to.
[Porting note](docs/upgrades/0.1.0.md).
