/**
 * `rate_limits` and `operation_locks` — the Node platform's rate limiter and operation locks
 * (M6, `src/node/limits.ts`), which the Worker keeps in its `RATE_LIMIT_KV` namespace instead.
 *
 * `rate_limits` holds one row per limited key (`rl:<route>:<ip>`): the sliding window's hit times
 * in epoch milliseconds, the same log KV kept as a JSON array. A check takes the row lock, so
 * concurrent requests from one key are counted exactly (KV's read-modify-write was approximate).
 * `expires_at` is when the newest hit leaves the window; the nightly prune drops rows past it.
 *
 * `operation_locks` holds one row per held lock (`tenant:delete:<id>`): acquiring is one
 * `INSERT … ON CONFLICT DO UPDATE … WHERE expires_at <= now()`, so an expired lock is reclaimed
 * and a live one refused, atomically. `release` deletes the row.
 *
 * Pre-tenant infrastructure keyed by IP and operation, never by tenant: both are in
 * `RLS_REVOKED_TABLES` (the app role gets no grant; the platform writes them over the owner
 * connection).
 */
import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    /** Hit times (epoch ms) still inside the window, oldest first. */
    hits: bigint('hits', { mode: 'number' }).array().notNull().default([]),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  table => [index('rate_limits_expires_idx').on(table.expiresAt)]
)

export const operationLocks = pgTable(
  'operation_locks',
  {
    key: text('key').primaryKey(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    /** The TTL safety net: a crashed holder's lock is reclaimable from here on. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  table => [index('operation_locks_expires_idx').on(table.expiresAt)]
)

export type RateLimitRow = typeof rateLimits.$inferSelect
export type OperationLockRow = typeof operationLocks.$inferSelect
