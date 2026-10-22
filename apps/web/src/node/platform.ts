/**
 * The Node `Platform`: jobs (M3, pg-boss — `jobs.ts`), runs (M4, OpenWorkflow — `runs.ts`),
 * realtime (M5, `ws` + LISTEN/NOTIFY — `realtime.ts`), and from M6 object storage (S3 —
 * `storage.ts`, null unless `STORAGE_DRIVER=s3` is fully configured), the rate limiter and
 * operation locks (Postgres — `limits.ts`), the document converter (`converter.ts`) and the Guide's
 * static content (`guide-content.ts`). A null
 * member is the configuration state the app already answers for (503 `storage_not_configured`,
 * a no-op realtime nudge, a run that cannot start). Models are reached through the provider keys
 * (`ANTHROPIC_API_KEY`, `AI_*`, `EMBEDDINGS_*`), not a platform member.
 */
import type { AppConfig } from '../config'
import {
  type DocumentConverter,
  EMPTY_PLATFORM,
  type GuideContentSource,
  type JobsQueue,
  type Locks,
  type Platform,
  type RateLimiter,
  type RealtimeHub,
  type RunEngine,
  type StorageService,
} from '../platform/types'
import { createNodeConverter } from './converter'
import { createNodeGuideSource } from './guide-content'
import { createPostgresLocks, createPostgresRateLimiter } from './limits'
import { createS3Storage, storageConfigOf } from './storage'

export interface NodePlatformParts {
  /** The pg-boss producer (`createNodeJobs(...).queue`). */
  jobs?: JobsQueue | null
  /** The OpenWorkflow engine (`createNodeRuns(...).engine`). */
  runs?: RunEngine | null
  /** The NOTIFY-backed hub (`createNodeRealtime(...).hub`). */
  realtime?: RealtimeHub | null
  /** Overrides for tests; by default built from the config. */
  storage?: StorageService | null
  rateLimiter?: RateLimiter | null
  locks?: Locks | null
  converter?: DocumentConverter | null
  /** The Guide's pages and images (`guide-content.ts`); by default `content/guide`. */
  guide?: GuideContentSource | null
}

export function createNodePlatform(config: AppConfig, parts: NodePlatformParts = {}): Platform {
  const s3 = storageConfigOf(config)
  return {
    ...EMPTY_PLATFORM,
    jobs: parts.jobs ?? null,
    runs: parts.runs ?? null,
    realtime: parts.realtime ?? null,
    storage: parts.storage !== undefined ? parts.storage : s3 ? createS3Storage(s3) : null,
    rateLimiter:
      parts.rateLimiter !== undefined ? parts.rateLimiter : createPostgresRateLimiter(config),
    locks: parts.locks !== undefined ? parts.locks : createPostgresLocks(config),
    converter: parts.converter !== undefined ? parts.converter : createNodeConverter(),
    guide: parts.guide !== undefined ? parts.guide : createNodeGuideSource(),
  }
}
