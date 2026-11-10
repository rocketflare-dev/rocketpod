---
version: unreleased
previous: 0.2.0
date: null
breaking: true
migrations:
  - "tenants.external_org_id (text, unique, nullable) and tenants.idp_synced_at (timestamptz)"
  - "tenant_users.source (text manual|idp, NOT NULL default manual) and tenant_users.idp_synced_at (timestamptz)"
  - "users.global_admin_source (text manual|idp) and users.blocked_source (text), both nullable"
  - "user_sessions.max_expires_at (timestamptz, nullable)"
  - "agent_runs.batch_id (uuid); indexes agent_runs (tenant_id, status), partial agent_runs (tenant_id, batch_id), partial ai_usage (tenant_id, agent_run_id)"
  - "team_invitations.last_sent_at (timestamptz, NOT NULL default now()) and the invitation_send_counters table (RLS-excluded)"
  - "documents and chunks accept tenant_id NULL (platform documents): platformReadable policy, a CHECK needing source + external_id, unique (source, external_id) among them"
  - "plugin_events table; agent_runs.trigger_event and agent_runs.trigger_event_id"
areas: [api, db, config, shared, ui, cli, plugins, skills, docs, ci, scripts]
touches_surfaces:
  - feature-chat
  - feature-guide
  - example-guide-pages
  - feature-agents
  - example-agent-summarize-text
  - example-agent-research-topic
  - example-agent-triage-research
  - feature-knowledge
requires_surfaces: []
manual: true
---

## What changed

Rocketpod catches up with Rocketflare 0.32.2 and takes its version: identity seam, agents at volume, Node 26 and current dependencies, the security hardening round, public sites, platform knowledge and plugin events.

- Versioning: Rocketpod's version now equals the Rocketflare release it has ported, so a plugin's `minKit` means the same in both kits. Per-release detail (what was ported, translated, skipped) is in `docs/FORK.md`; the line-by-line porting note this summary replaces is `git show 9293926:docs/upgrades/unreleased.md`.
- IdP-managed tenancy (`OIDC_MANAGED_TENANCY`): the issuer's id_token and signed identity events (`POST /api/identity/events`) decide tenants, roles and global admin; admins link tenants to issuer orgs and delete organisations ([CONCEPTS §1–2](../CONCEPTS.md)).
- Plugin identity seam: `identityFor().signIn`, `provisionFor()` with `deprovision`, `ServerPlugin.ssoPolicy`, `ServerPlugin.loginMethods`, rate-limited and body-capped public mounts.
- Agents at volume: active-run cap, daily spend gate, `POST /api/agents/runs/batch`, `ctx.scope`/`ctx.map`, one `ai_usage` row per call, budgets, tool-loop policies, concurrent tool calls, `pnpm web agent:replay`, CLI `agents list|run|runs list`.
- Plugin contexts gain `storage()`, `startAgentRun({ idempotencyKey })`, `emit()`, `can()`; text is stripped of NUL/control characters before Postgres sees it.
- Node 26 (no corepack), React 19, React Router 7, vitest 5, Vite 8, postgres.js 4, CASL 7, Anthropic SDK 1.x, AG-UI 1.0.4, pg-boss 12, OpenWorkflow 0.11; CI Actions pinned by SHA with timeouts and least privilege.
- Security: `openid-client` replaces arctic; API key scopes enforced; CLI login confirms in the browser; invitation and sign-in mail limits; owner-only owner invites; sockets close (4001) on removal, block, sign-out and lost admin, across every process; `/ws` Origin allowlist; trace content capture off by default.
- Public sites: `ServerPlugin.publicSites` serves whole hosts with a strict CSP; the Node server dispatches on Host, Helm adds an ingress rule per site host.
- Platform knowledge: tenant-less documents a plugin ingests from a job or cron, searched beside the tenant's own; `streamChat`, header items, navigation entries, UI extensions, `claudeHooks` and `hostFiles` for plugins.
- Plugin events: declared `<id>.<name>` events, one delivery job per subscriber, agents triggered by or bindable to an event.
- New skill `rp-agent-docs`; a WCAG contrast test over both themes; agent docs split into per-directory `CLAUDE.md` files.
- Not ported (no Rocketpod equivalent): inbound email, the `images` binding, `publicSites.cache` storage, the Workers AI GLM parser.

## How to apply

1. Install Node 26 (`nvm install 26`) and pnpm without corepack (`npm i -g pnpm@10`), since Node 26 ships no corepack; an image that pins its own base must do the same.
2. Run `pnpm install`, then `pnpm db:generate` after porting the schema in `apps/web/src/db/schema/` (the frontmatter's migration list), then `pnpm db:migrate`; never copy the kit's migration files.
3. After migrating, delete `support` rows left by an earlier global-admin demotion: `DELETE FROM tenant_users tu USING users u WHERE tu.user_id = u.id AND tu.role = 'support' AND NOT u.is_global_admin`.
4. Add the new keys to `.env` and Helm `config`, each optional: `AGENT_MAX_ACTIVE_RUNS_PER_TENANT` (default 50), `AGENT_RUN_MAX_TOKENS`, `AGENT_RUN_MAX_COST_USD`, `AGENT_TENANT_DAILY_COST_USD`, `MAX_OWNED_TENANTS_PER_USER`, `INVITATION_EMAILS_PER_USER_PER_DAY`, `INVITATION_EMAILS_PER_TENANT_PER_DAY`, `EVENTS_RETENTION_DAYS`, and the `OIDC_MANAGED_TENANCY` family with the secret `IDENTITY_WEBHOOK_SECRET` (`SETUP.md` 2.3c).
5. Decide trace content capture: `OBSERVABILITY_CAPTURE_CONTENT` is now off unless set to `true`.
6. If a cost cap is set, price every model the platform key serves in `packages/shared/src/ai/pricing.ts`; an unpriced model is refused (`unpriced_model`) while a cap applies.
7. Replace each API key that has only the `read` scope but sends writes with a `write` key; `read` now allows only GET, HEAD and OPTIONS.
8. Move any headless caller of `GET /auth/cli` to `POST /auth/cli/confirm`; the GET no longer creates a key.
9. Update calls in your own code: `enqueueRun(db, cfg, platform, …)`; `actor` on `createInvitation`, `bulkInvite` and `resendInvitation`; `proof` on `admitUser`; `closeSockets` on any custom `Broadcaster`; and delete every `recordUsage` or usage-writing `onUsage` in your own agents, because the runtime now writes one row per call.
10. For a plugin that declares `publicSites`, list its hosts in Helm `publicSites.hosts` with `publicSites.hostsVar` (`docs/DEPLOY.md` § Public site hosts).
11. For a change not covered by steps 1–10, follow the Rocketflare porting note named in that release's `docs/FORK.md` row, as translated in the row.

## Conflicts to expect

- `Dockerfile` → `corepack enable` removed, Node 26 base → keep your base, install pnpm with npm.
- Every `package.json` and `pnpm-lock.yaml` → versions, `engines`, `packageManager` → take the kit's ranges, then `pnpm install`.
- `apps/web/src/api/services/agents/runtime.ts` → the context literal is `withFanout({ … })` and the client is metered → keep your own fields inside the literal.
- `apps/web/src/api/routes/auth/oauth.ts` and `auth/providers/` → rewritten on `openid-client` → re-apply local changes to the new `openid.ts` client.
- `apps/web/src/api/index.ts` → the public-sites middleware after `databaseMiddleware`, a new catch-all → keep your own mounts and order.
- `apps/web/src/ui/index.css` → theme tokens moved to `src/shared/theme-tokens.css` → move your palette with them; the contrast test judges it.

## Verify

1. `node -v` prints `v26.` and `pnpm gate` passes.
2. `docker build -t rocketpod:local .` succeeds and `docker compose up -d` answers `/healthz` with `{"status":"ok"}`.
3. `pnpm audit` reports no known vulnerabilities.
4. `psql "$DATABASE_URL" -c '\d plugin_events'` shows the table, and `\d agent_runs` lists `batch_id`, `trigger_event` and `trigger_event_id`.
5. `pnpm web test:api -- tests/api/security` passes, including the socket revocation case (close code 4001).
