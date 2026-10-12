/**
 * The Cloudflare `Platform` (M1): every neutral capability built from the Worker's bindings. A
 * missing binding is a null member, which the callers already treat as "not configured".
 *
 * This directory, `src/worker.ts` and the DO/Workflow classes are the only places a Cloudflare type
 * may appear (`tests/config/platform-seam.test.ts`).
 */
import type { JobsQueue, Platform, PlatformAi, RunEngine } from '../types'
import type { CloudflareBindings } from './bindings'
import { createKvLocks, createKvRateLimiter, type RateLimitKv } from './kv'
import { createDurableObjectHub } from './realtime'
import { createR2Storage } from './storage'

export type { CloudflareBindings } from './bindings'
export { checkRateLimit, createKvLocks, createKvRateLimiter, type RateLimitKv } from './kv'
export { createDurableObjectHub } from './realtime'
export { cloudflareStep } from './step'
export { createR2Storage } from './storage'

/** The conversion slice of the AI binding, or null when it has none (a stub, or no `[ai]`). */
function converterOf(ai: PlatformAi | null): Platform['converter'] {
  if (!ai || typeof ai.toMarkdown !== 'function') return null
  return document => (ai.toMarkdown as NonNullable<PlatformAi['toMarkdown']>).call(ai, document)
}

export function createCloudflarePlatform(env: Partial<CloudflareBindings>): Platform {
  const ai = (env.AI as PlatformAi | undefined) ?? null
  const kv = (env.RATE_LIMIT_KV as RateLimitKv | undefined) ?? null
  return {
    // `Queue` and `Workflow` satisfy the neutral producer and engine structurally.
    jobs: (env.JOBS_QUEUE as JobsQueue | undefined) ?? null,
    storage: env.FILES ? createR2Storage(env.FILES) : null,
    realtime: env.NOTIFICATIONS_HUB ? createDurableObjectHub(env.NOTIFICATIONS_HUB) : null,
    runs: (env.AGENT_RUN_WORKFLOW as unknown as RunEngine | undefined) ?? null,
    rateLimiter: kv ? createKvRateLimiter(kv) : null,
    locks: kv ? createKvLocks(kv) : null,
    ai,
    converter: converterOf(ai),
  }
}
