---
version: unreleased
previous: 0.1.0
date: null
breaking: true
migrations: []
areas: [api, config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Every runtime capability is now a neutral `Platform` (`src/platform/types.ts`) read through `c.get('platform')`, with Cloudflare's adapters confined to `src/platform/cloudflare/` and a guard test keeping them there.

- `src/platform/types.ts`: neutral `JobsQueue`/`JobBatch`, `StorageService`, `RealtimeHub`, `RunEngine` + `Step`, `RateLimiter`, `Locks`, `PlatformAi`, `DocumentConverter`, `Defer`, and the `Platform` bundle.
- `src/platform/cloudflare/`: R2 storage, KV rate limiter and locks, the Durable Object hub, the Workflow step adapter and `createCloudflarePlatform(env)`; `createR2Storage` and `checkRateLimit` moved here.
- `platformMiddleware` sets `c.get('platform')` after config; routes, job handlers (`ctx.platform`), cron tasks (`ctx.platform`) and services read it instead of `c.env.FILES|JOBS_QUEUE|NOTIFICATIONS_HUB|AGENT_RUN_WORKFLOW|RATE_LIMIT_KV|AI`.
- `AppBindings` is neutral (vars by name, `PLATFORM?`, `HYPERDRIVE?`, `ASSETS?`); `CloudflareBindings` is the Worker's type.
- The agent run's body moved to `api/workflows/agent-run-body.ts` (`runAgentRun`) over the neutral `Step`; `AgentRunWorkflow` is a shim.
- `Realtime` is `{ defer, hub }` (was `{ defer, env }`); `operationLock` takes `Locks`; `AiEnv` is `{ ai?, converter? }`; agent and tool contexts' `env` is the `Platform`.
- Plugin API: `PluginContext.platform` added; `ToolCtx`/`AgentCtx` carry `platform` instead of `env`; `durableObject` removed from `RequestCtx`, `BackgroundMethods` and `@/plugins/api`; `workflowCtx(step, env, config, logger, platform)` takes the neutral `Step`.
- `GET /ws` answers 503 `realtime_not_configured` when the platform has no hub (it threw a 500 before).
- `tests/config/platform-seam.test.ts` fails on any Cloudflare type, binding name or `cloudflare:` import outside the adapters, `src/worker.ts` and the two Worker classes.

## How to apply

1. Copy `apps/web/src/platform/` and `apps/web/src/api/middleware/platform.ts`, and register `platformMiddleware` after `configMiddleware` in `apps/web/src/api/index.ts`.
2. In every route and service of your own, replace a `c.env.<BINDING>` read with the matching `c.get('platform')` member (`jobs`, `storage`, `realtime`, `runs`, `locks`, `rateLimiter`, `ai`, `converter`).
3. In every job handler and cron task of your own, read capabilities from `ctx.platform` instead of `ctx.env.<BINDING>`.
4. In every plugin tool or agent of your own, replace `ctx.env` with `ctx.platform`, and replace a `durableObject(...)` call with a capability on `ctx.platform`.
5. Copy `apps/web/tests/config/platform-seam.test.ts` and add any Worker class of your own to its `ALLOWED` list.

## Conflicts to expect

- `apps/web/src/api/types.ts` → `AppBindings` is no longer `Cloudflare.Env` → keep the neutral shape and read bindings through the platform.
- `apps/web/tests/mocks/bindings.ts` → `TestEnv` gained the `Platform` view → keep yours alongside.

## Verify

1. `pnpm typecheck` passes.
2. `pnpm web test:config` passes, including `tests/config/platform-seam.test.ts`.
3. `pnpm test` passes.
4. `node scripts/plugin-api-doc.mjs --check` passes.
