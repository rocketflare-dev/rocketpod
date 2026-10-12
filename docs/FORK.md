# Fork point

Rocketpod is a hard fork of [Rocketflare](https://github.com/rocketflare-dev/rocketflare), taken so
the kit can run with no Cloudflare dependency: Node 24 in a container (Docker Compose or Kubernetes),
Postgres + pgvector for everything stateful, and S3-compatible object storage for files.

| | |
|---|---|
| Forked from | `rocketflare-dev/rocketflare` `main` |
| Rocketflare version | 0.19.0 |
| Rocketflare commit | `46706df95c20c9f8ee90217ef60bf4f162e012bd` |
| Date | 2026-10-12 |

**Relationship.** Concept parity, not code parity: tenancy, auth, CASL, contracts first, jobs,
durable agent runs, realtime, knowledge, tracing, evals, plugins and the CLI mean the same thing in
both kits. Rocketflare releases are **ported by hand**: read Rocketflare's
`docs/upgrades/<version>.md` for each release after 0.19.0 and apply what still holds without
Cloudflare. Record each one in the table below so the next port knows its baseline.

**Rocketpod is itself a kit.** Copies of Rocketpod upgrade from Rocketpod releases through
`pnpm kit:upgrade` and `/rf-upgrade`, exactly as Rocketflare copies do. `.rocketflare.json` and
`rocketflare-plugin.json` keep their names on purpose: they are the plugin ecosystem's fixed
filenames, so a plugin that uses only the neutral plugin context installs in either kit.

The design is in [`DESIGN-SELFHOSTED.md`](DESIGN-SELFHOSTED.md); the milestones are in
[`ROADMAP.md`](ROADMAP.md).

## Rocketflare releases ported

| Rocketflare | Ported in Rocketpod | Notes |
|---|---|---|
| 0.19.0 | 0.1.0 (fork point) | — |
