/**
 * The Node platform's `RateLimiter` and `Locks` (M6), over `rate_limits` / `operation_locks`
 * (`src/db/schema/platform-limits.ts`). They keep the Worker's KV semantics
 * (`src/platform/cloudflare/kv.ts`) exactly where a caller can see them, and tighten them where KV
 * could not:
 *
 * - **Rate limit**: a sliding window over a log of hit times. A refused request records nothing,
 *   and `retryAfterSeconds` is when the oldest hit in the window leaves it (at least 1) — what
 *   `checkRateLimit` answers. Unlike KV, the check holds the row lock, so N concurrent requests
 *   from one key admit exactly `max`. Time is the DATABASE's, so replicas with skewed clocks agree.
 * - **Locks**: `acquire` is one statement that inserts the lock, or takes over one whose TTL has
 *   passed (the crash safety net), and answers whether it won; `release` deletes it. KV's
 *   get-then-put could let two callers in; this cannot.
 *
 * Both open the database per call through `openDatabase`, which on the Node entry is a view of the
 * process pool, so a check costs one pooled round trip (the rate limit: one short transaction).
 */
import { sql } from 'drizzle-orm'
import type { AppConfig } from '../config'
import { openDatabase, rows } from '../db/client'
import type { Locks, RateLimitDecision, RateLimiter } from '../platform/types'

/** The rate limiter over `rate_limits`. */
export function createPostgresRateLimiter(config: AppConfig): RateLimiter {
  return {
    async check(key, options): Promise<RateLimitDecision> {
      const windowMs = options.windowSeconds * 1000
      const { db, close } = openDatabase(config)
      try {
        return await db.transaction(async tx => {
          await tx.execute(sql`
            INSERT INTO rate_limits (key, hits, expires_at) VALUES (${key}, '{}', now())
            ON CONFLICT (key) DO NOTHING`)
          const [row] = rows<{ hits: Array<string | number> | null; now_ms: string | number }>(
            await tx.execute(sql`
              SELECT hits, (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
              FROM rate_limits WHERE key = ${key} FOR UPDATE`)
          )
          const now = Number(row?.now_ms ?? Date.now())
          const hits = (row?.hits ?? []).map(Number).filter(t => now - t < windowMs)
          if (hits.length >= options.max) {
            const oldest = Math.min(...hits)
            return {
              allowed: false,
              remaining: 0,
              retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
            }
          }
          hits.push(now)
          await tx.execute(sql`
            UPDATE rate_limits
            SET hits = ${`{${hits.join(',')}}`}::bigint[],
                expires_at = to_timestamp(${(now + windowMs) / 1000})
            WHERE key = ${key}`)
          return { allowed: true, remaining: options.max - hits.length, retryAfterSeconds: 0 }
        })
      } finally {
        await close()
      }
    },
  }
}

/** Advisory locks over `operation_locks`. */
export function createPostgresLocks(config: AppConfig): Locks {
  return {
    async acquire(key, ttlSeconds) {
      const { db, close } = openDatabase(config)
      try {
        const won = rows(
          await db.execute(sql`
            INSERT INTO operation_locks (key, acquired_at, expires_at)
            VALUES (${key}, now(), now() + make_interval(secs => ${Math.max(1, ttlSeconds)}))
            ON CONFLICT (key) DO UPDATE
              SET acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
              WHERE operation_locks.expires_at <= now()
            RETURNING key`)
        )
        return won.length > 0
      } finally {
        await close()
      }
    },
    async release(key) {
      const { db, close } = openDatabase(config)
      try {
        await db.execute(sql`DELETE FROM operation_locks WHERE key = ${key}`)
      } finally {
        await close()
      }
    },
  }
}
