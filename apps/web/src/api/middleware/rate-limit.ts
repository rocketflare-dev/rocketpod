/**
 * Sliding-window rate limiting + per-tenant operation lock, over the platform's
 * `rateLimiter` and `locks` (`src/platform/types.ts`; on Node the `rate_limits` / `operation_locks`
 * tables, `src/node/limits.ts`). Keyed by client IP (`clientIpOf`,
 * `utils/routes/client-ip.ts`) and route name; a no-op when the platform has no rate limiter.
 * Applied PER MOUNT in `index.ts` / `routes/auth/index.ts`, never inside a handler.
 */
import { createMiddleware } from 'hono/factory'
import type { Locks, RateLimitDecision } from '../../platform/types'
import type { AppEnv } from '../types'
import { ConflictError, RateLimitedError } from '../utils/core/errors'
import { clientIpOf } from '../utils/routes/client-ip'

export type { RateLimitDecision }

export interface RateLimitOptions {
  /** Distinguishes routes sharing one IP; part of the key. */
  name: string
  max: number
  windowSeconds: number
}

export function rateLimit(options: RateLimitOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const limiter = c.get('platform').rateLimiter
    if (!limiter) return next()
    const ip = clientIpOf(c) ?? 'unknown'
    const decision = await limiter.check(`rl:${options.name}:${ip}`, options)
    if (!decision.allowed) {
      c.header('Retry-After', String(decision.retryAfterSeconds))
      throw new RateLimitedError(
        'Too many requests, please try again later',
        decision.retryAfterSeconds
      )
    }
    await next()
  })
}

/** 10 requests / minute / IP — magic-link request, dev-login, OAuth start, invite accept. */
export const authRateLimit = rateLimit({ name: 'auth', max: 10, windowSeconds: 60 })

/**
 * Per-tenant mutex: `operationLock(locks, 'tenant:delete:<id>', fn)`. A second caller while `fn`
 * runs gets 409 `operation_in_progress`; the TTL is the crash safety net. With no locks (a bare
 * env, as in a unit test) `fn` simply runs.
 */
export async function operationLock<T>(
  locks: Locks | null | undefined,
  key: string,
  fn: () => Promise<T>,
  ttlSeconds = 600
): Promise<T> {
  if (!locks) return fn()
  if (!(await locks.acquire(key, ttlSeconds))) {
    throw new ConflictError('Operation already in progress', 'operation_in_progress')
  }
  try {
    return await fn()
  } finally {
    await locks.release(key).catch(() => {})
  }
}
