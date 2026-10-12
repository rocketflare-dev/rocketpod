/**
 * Hono typing (04 §2, D13): the env is the neutral `AppBindings` below (vars + an optional
 * prebuilt `Platform`), variables are declared once here, and every `Hono` instance is
 * `Hono<AppEnv>` via `utils/routes/router.ts`. No `declare module 'hono'` augmentation.
 */
import type { GroupRef } from '@rocketpod/shared/groups'
import type { AppAbility } from '@rocketpod/shared/permissions'
import type { MembershipRole } from '@rocketpod/shared/tenants'
import type { Context } from 'hono'
import type { PinoLogger } from 'hono-pino'
import type { AppConfig } from '../config'
import type { Database } from '../db/client'
import type { User } from '../db/schema'
import type { Platform } from '../platform/types'
import type { Tracer } from './observability/tracer'

/**
 * What `authMiddleware` sets (D10, D25). Read ONLY through `withAuthAndDb` in routes and the
 * helpers in `middleware/permissions.ts`. `tenantId`/`tenantUser` are null for a user with no
 * membership (pending approval) — routes that need a tenant get 403 `no_tenant` before they run.
 */
export interface AuthContext {
  user: User
  /** The active tenant — the ONLY tenant id a query may filter by. */
  tenantId: string | null
  tenantUser: { role: MembershipRole } | null
  /** Resolved tenant summary for `tenantId`; null when there is no membership. */
  tenant: { id: string; name: string; slug: string } | null
  /**
   * The DB session row behind the cookie. Bearer (API-key) auth has no session row, so `id` is
   * `api-key:<keyId>` — `isApiKeySession(auth)` tells the two apart (select-tenant is cookie-only).
   */
  session: { id: string }
  /** Latest access request for the user's email — drives 403 `pending_approval` vs `no_tenant`. */
  accessRequestStatus: 'pending' | 'approved' | 'rejected' | null
  /** `buildAbility({ role, isGlobalAdmin, features })` for this request. */
  ability: AppAbility
  isGlobalAdmin: boolean
  /** Feature flags on for the active tenant → `can('access', 'Feature:<f>')`. */
  features: string[]
  /**
   * The groups this person belongs to IN THE ACTIVE TENANT (D29) — empty without a membership.
   * Read it through `accessScopeOf(auth)` (`services/access.ts`) rather than directly: visibility
   * is a SQL predicate, never a CASL condition.
   */
  groups: GroupRef[]
}

/**
 * The runtime env as the app sees it (M1): vars and secrets by name, read through `loadConfig`
 * (D3) and never directly by a route; the database connection when it comes from the runtime; the
 * SPA's assets; and, when the entry point built one, the `Platform` itself. Every runtime
 * capability (jobs, storage, realtime, runs, rate limits, AI) is read through `c.get('platform')`,
 * never from here — the Cloudflare binding types stay inside `src/platform/cloudflare/`.
 */
export interface AppBindings {
  readonly [name: string]: unknown
  /** A prebuilt platform (a non-Worker entry, a test); the Worker's is adapted from its bindings. */
  PLATFORM?: Platform
  /** Postgres through a pooler binding (D35 `postgres` driver); else `DATABASE_URL`. */
  HYPERDRIVE?: { connectionString: string }
  /** The SPA's static assets, when the runtime serves them. */
  ASSETS?: { fetch(request: Request): Promise<Response> }
}

export interface AppVariables {
  /** Validated config — routes read this, never `c.env` (D3). */
  config: AppConfig
  /** The runtime's capabilities (M1, `src/platform/types.ts`); set by `platformMiddleware`. */
  platform: Platform
  /** Per-request drizzle handle (owner connection). */
  db: Database
  /** Ends the request's DB client; the database middleware schedules it in `waitUntil`. */
  dbClose?: () => Promise<void>
  logger: PinoLogger
  requestId: string
  /** Per-request tracer (D16): Langfuse batcher when keys are set, else no-op. Set by `tracerMiddleware`. */
  tracer: Tracer
  /** Set by `authMiddleware`; absent on public routes. */
  auth?: AuthContext
  /**
   * Opt-in from ONE route: this response may be framed by a same-origin page
   * (`middleware/security-headers.ts` then relaxes `X-Frame-Options`/`frame-ancestors` for it
   * alone). Only a route that has PROVED the content type may set it — `routes/files.ts` checks
   * `isEmbeddableMimeType(row.contentType)` — because framing is the app shell's one clickjacking
   * defence and a path allowlist would relax it for the `text/html` we deliberately download.
   */
  embeddable?: boolean
}

export type AppEnv = { Bindings: AppBindings; Variables: AppVariables }
export type AppContext = Context<AppEnv>
