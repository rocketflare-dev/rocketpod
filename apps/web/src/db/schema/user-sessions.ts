/**
 * `user_sessions` — DB-backed cookie sessions. The cookie carries a random token; only its
 * SHA-256 (`tokenHash`) is stored, so a database read never yields a usable credential.
 * `selectedTenantId` IS the current-tenant mechanism: the auth middleware resolves the
 * membership for it, falling back to the oldest membership when it is stale.
 *
 * Pre-tenant infrastructure: in `RLS_REVOKED_TABLES` (no policy, app role has no grants).
 */
import { relations } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenants } from './tenants'
import { users } from './users'

export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the cookie token (`hashToken` in api/utils/core/hash.ts). */
    tokenHash: text('token_hash').notNull().unique(),
    selectedTenantId: uuid('selected_tenant_id').references(() => tenants.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The sliding window this session renews to on use, in seconds. NULL = the kit's
     * `SESSION_TTL_MS` (30 days); a sign-in under `OIDC_PRESET=labs` stores 7 days.
     */
    ttlSeconds: integer('ttl_seconds'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    // "All sessions for this user" (logout everywhere) and expiry sweeps.
    index('user_sessions_user_idx').on(table.userId, table.expiresAt),
    index('user_sessions_expires_idx').on(table.expiresAt),
  ]
)

export const userSessionsRelations = relations(userSessions, ({ one }) => ({
  user: one(users, { fields: [userSessions.userId], references: [users.id] }),
  selectedTenant: one(tenants, {
    fields: [userSessions.selectedTenantId],
    references: [tenants.id],
  }),
}))

export type UserSession = typeof userSessions.$inferSelect
export type NewUserSession = typeof userSessions.$inferInsert
