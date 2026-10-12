/**
 * The Node `Platform`. Capabilities whose Node adapter has not landed yet are null — the same
 * configuration state the app already answers for (503 `storage_not_configured`, a no-op realtime
 * nudge, no rate limit, a run that cannot start). `docs/ROADMAP.md` fills them in: jobs (M3,
 * pg-boss — `jobs.ts`), runs (M4, OpenWorkflow), realtime (M5, `ws` + LISTEN/NOTIFY), storage,
 * rate limits, locks and the document converter (M6).
 */
import type { AppConfig } from '../config'
import { EMPTY_PLATFORM, type JobsQueue, type Platform } from '../platform/types'

export interface NodePlatformParts {
  /** The pg-boss producer (`createNodeJobs(...).queue`). */
  jobs?: JobsQueue | null
}

export function createNodePlatform(_config: AppConfig, parts: NodePlatformParts = {}): Platform {
  return { ...EMPTY_PLATFORM, jobs: parts.jobs ?? null }
}
