/**
 * Cloudflare Worker entry (D5): `export default { fetch, queue, scheduled }` plus the in-script
 * Durable Object class (`NotificationsHub`, D8) and the Workflow class (`AgentRunWorkflow`, D7).
 * The classes are exported HERE — never from api/index.ts, which must stay importable from Node
 * tests.
 *
 * M1: the app below this line is platform-neutral. The Worker's bindings become a `Platform`
 * (`src/platform/cloudflare/`) — per request through `platformMiddleware`, and here for the queue
 * and cron handlers — and this file, the adapters and the two classes are the only places a
 * Cloudflare type may appear (`tests/config/platform-seam.test.ts`).
 *
 * The third export line is the plugin seam (D31): Cloudflare resolves a binding's `class_name`
 * against the named exports of THIS module and nowhere else, so a plugin that ships a DO or a
 * Workflow needs a line here. That line is permanent and names no plugin —
 * `plugins/worker-exports.ts` is the sixth barrel, one `export *` per installed plugin, written by
 * `pnpm plugin add` and deleted by `pnpm plugin remove`. Nothing about installing a plugin edits
 * this file.
 */
import { app } from './api/index'
import { queue } from './api/queue'
import { scheduled } from './api/scheduled'
import type { AppBindings } from './api/types'
import type { CloudflareBindings } from './platform/cloudflare'

export { NotificationsHub } from './api/durable-objects/notifications-hub'
export { AgentRunWorkflow } from './api/workflows/agent-run'
export * from './plugins/worker-exports'

/** The Worker's env, as the neutral app sees it: vars by name, bindings adapted downstream. */
const appEnv = (env: CloudflareBindings) => env as unknown as AppBindings

export default {
  fetch: (request, env, ctx) => app.fetch(request, appEnv(env), ctx),
  queue: (batch, env) => queue(batch, appEnv(env)),
  scheduled: (event, env, ctx) => scheduled(event, appEnv(env), ctx),
} satisfies ExportedHandler<CloudflareBindings>
