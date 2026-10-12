/**
 * The Node `Platform` (M2). Every capability whose Node adapter has not landed yet is null — the
 * same configuration state the app already answers for (503 `storage_not_configured`, a no-op
 * realtime nudge, no rate limit, a run that cannot start). `docs/ROADMAP.md` fills them in:
 * jobs and cron (M3, pg-boss), runs (M4, OpenWorkflow), realtime (M5, `ws` + LISTEN/NOTIFY),
 * storage, rate limits, locks and the document converter (M6).
 */
import type { AppConfig } from '../config'
import { EMPTY_PLATFORM, type Platform } from '../platform/types'

export function createNodePlatform(_config: AppConfig): Platform {
  return { ...EMPTY_PLATFORM }
}
