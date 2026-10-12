/**
 * Rate limits and operation locks over the `RATE_LIMIT_KV` namespace (D14). KV's read-modify-write
 * is not atomic and KV is eventually consistent, so the limit is approximate — right for login
 * throttling, not for billing — and a lock is advisory with a TTL safety net.
 */
import type { Locks, RateLimitDecision, RateLimiter } from '../types'

/** Minimal KV surface — `KVNamespace` in production, `MemoryKV` in tests. */
export interface RateLimitKv {
  get(key: string, type: 'json'): Promise<unknown>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/** Pure check: read the window, drop stale hits, decide, write back. */
export async function checkRateLimit(
  kv: RateLimitKv,
  key: string,
  options: { max: number; windowSeconds: number }
): Promise<RateLimitDecision> {
  const now = Date.now()
  const windowMs = options.windowSeconds * 1000
  const raw = (await kv.get(key, 'json')) as number[] | null
  const hits = (raw ?? []).filter(t => typeof t === 'number' && now - t < windowMs)
  if (hits.length >= options.max) {
    const oldest = Math.min(...hits)
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    }
  }
  hits.push(now)
  // KV enforces a 60s minimum TTL; the window filter above is what actually bounds the count.
  await kv.put(key, JSON.stringify(hits), { expirationTtl: Math.max(60, options.windowSeconds) })
  return { allowed: true, remaining: options.max - hits.length, retryAfterSeconds: 0 }
}

export function createKvRateLimiter(kv: RateLimitKv): RateLimiter {
  return { check: (key, options) => checkRateLimit(kv, key, options) }
}

/** `op_lock:<key>` holds `{ startedAt }` until released or expired. */
export function createKvLocks(kv: RateLimitKv): Locks {
  return {
    async acquire(key, ttlSeconds) {
      const lockKey = `op_lock:${key}`
      if ((await kv.get(lockKey, 'json')) !== null) return false
      await kv.put(lockKey, JSON.stringify({ startedAt: Date.now() }), {
        expirationTtl: Math.max(60, ttlSeconds),
      })
      return true
    },
    async release(key) {
      await kv.delete(`op_lock:${key}`)
    },
  }
}
