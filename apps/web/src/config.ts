/**
 * Application configuration: one zod schema over the env object, validated
 * lazily and memoised by env identity. Called from `fetch` (via `configMiddleware`), `queue` and
 * `scheduled` so all three entry points fail identically.
 *
 * Only vars/secrets live here; runtime capabilities are the `Platform` (`src/platform/types.ts`).
 * The Node entry hands in `process.env` (`src/node/server.ts`); nothing else in `src/` reads it.
 */
import { sharedPlugins } from '@rocketpod/shared/plugins'
import { z } from 'zod'
import { DATABASE_SSL_MODES, databaseSslConflict } from './db/tls'

/** `EMAIL_FROM` when unset — a placeholder no real provider accepts as a sender. */
export const DEFAULT_EMAIL_FROM = 'Rocketpod <noreply@example.com>'

/** dotenv passes `KEY=` lines from .env as empty strings; treat those as unset. */
const optionalString = z.preprocess(
  value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional()
)

const optionalSecret = (min: number) =>
  z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(min).optional()
  )

/** A blank-or-absent enum var, for the ones whose ABSENCE means something (auto-detect). */
const optionalEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(values as unknown as [T[number], ...T[number][]]).optional()
  )

/** `[vars]` arrive as strings; blank means "use the default", never 0. */
const optionalPositiveInt = (fallback: number) =>
  z.preprocess(
    value =>
      value === undefined || value === null || String(value).trim() === '' ? fallback : value,
    z.coerce.number().int().positive()
  )

/** A cap that is OFF unless set: blank or absent → undefined, never 0 (agent budgets). */
const optionalCap = (kind: 'int' | 'number') =>
  z.preprocess(
    value =>
      value === undefined || value === null || String(value).trim() === '' ? undefined : value,
    (kind === 'int' ? z.coerce.number().int() : z.coerce.number()).positive().optional()
  )

/** `[vars]` arrive as strings: `"false"` / `"0"` / `"no"` are false, blank is the default. */
const optionalBoolean = (fallback: boolean) =>
  z.preprocess(value => {
    if (value === undefined || value === null || String(value).trim() === '') return fallback
    if (typeof value === 'boolean') return value
    return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase())
  }, z.boolean())

/**
 * A comma-separated list of lowercase identifiers (feature keys). `csvList` below coerces to email
 * addresses, which is right for `BOOTSTRAP_ADMIN_EMAILS` and wrong for anything else.
 */
const csvKeys = z.preprocess(
  value =>
    typeof value === 'string'
      ? value
          .split(',')
          .map(s => s.trim().toLowerCase())
          .filter(Boolean)
      : (value ?? []),
  z.array(z.string())
)

const csvList = z.preprocess(
  value =>
    typeof value === 'string'
      ? value
          .split(',')
          .map(s => s.trim().toLowerCase())
          .filter(Boolean)
      : (value ?? []),
  z.array(z.string().email())
)

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const

const coreConfigSchema = z.object({
  // ---- Plain vars (non-secret) -----------------------------------------------------------
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  /** Public origin; derives OAuth redirect URIs, magic-link URLs, CSRF/CORS allow-lists. */
  APP_URL: z.string().url(),
  APP_NAME: z.string().min(1).default('Rocketpod'),
  /** Set at deploy time to the release tag. */
  RELEASE_VERSION: z.string().min(1).default('dev'),
  /**
   * The deployed build — what an agent run records as `agent_runs.worker_version_id` on each
   * attempt (`services/agents/versions.ts`). Helm sets it from the image tag, Compose passes it
   * through; unset = null, and nothing else reads it.
   */
  APP_VERSION_ID: optionalString,
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** The sender on every email. SES sends only as an identity it has verified, so `ses` needs it set. */
  EMAIL_FROM: z.string().min(1).default(DEFAULT_EMAIL_FROM),
  /**
   * Who delivers email: `resend` (`RESEND_API_KEY`), `ses` (Amazon SES v2 on the AWS SDK's default
   * credentials — an ECS task role, no key in config) or `log` (nothing sent; the message and,
   * outside production, its link are logged). Unset = `resend` when `RESEND_API_KEY` is set, else
   * `log`. `resend` without the key, or `ses` with no `EMAIL_FROM`, fails here.
   */
  EMAIL_PROVIDER: optionalEnum(['log', 'resend', 'ses'] as const),
  /** SES's region. Unset = the AWS SDK's own (`AWS_REGION`, which ECS sets to the task's region). */
  SES_REGION: optionalString,
  /** An SES configuration set named on every message (where bounces and complaints are reported). */
  SES_CONFIGURATION_SET: optionalString,
  /** The schema is identical in both modes; `single` disables the multi-org surface. */
  TENANCY_MODE: z.enum(['multi', 'single']).default('multi'),
  /** Who may create an account. */
  SIGNUP_MODE: z.enum(['open', 'invite_only', 'approval']).default('invite_only'),
  /**
   * `enforce` wraps tenant-scoped work (`withTenantScope`) in a transaction that switches to the
   * tenant role and sets `app.tenant_id`, so row-level security binds. Needs `APP_DATABASE_URL`:
   * on the owner connection the policies are bypassed, so `enforce` there would enforce nothing.
   */
  TENANT_SCOPE_MODE: z.enum(['off', 'enforce']).default('off'),
  /**
   * `postgres` (postgres.js — any Postgres, Neon included, over TCP) is the only driver. Missing
   * means `postgres`. Any other value (`neon`) fails here, naming the fix, rather than on the first
   * query.
   */
  DATABASE_DRIVER: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .enum(['postgres'], {
        error: 'must be postgres (DATABASE_DRIVER=neon was removed — unset it or set postgres)',
      })
      .default('postgres')
  ),
  /**
   * Node entry: connections in the ONE postgres.js pool each process holds
   * (`installProcessPool`).
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  /**
   * TLS for EVERY Postgres connection (the pool, LISTEN, pg-boss, OpenWorkflow, migrate):
   * `off` | `require` (TLS, certificate not verified) | `verify-full` (verified against the system
   * trust store + `NODE_EXTRA_CA_CERTS`, hostname checked). Unset = the URL's `sslmode` decides.
   * Set, it refuses a database URL that carries TLS parameters of its own (`src/db/tls.ts`).
   */
  DATABASE_SSL: optionalEnum(DATABASE_SSL_MODES),
  /**
   * Node entry: how many reverse proxies in front of the server append to `X-Forwarded-For`.
   * 0 (the default) ignores the header and uses the socket's address; behind one ingress, 1.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  /**
   * Node worker: consumers of the jobs queue per `worker` process, each fetching batches of
   * up to 10.
   */
  JOBS_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  /** Node worker: how often an idle consumer polls the jobs queue, in seconds (≥ 0.5). */
  JOBS_POLL_INTERVAL_SECONDS: z.coerce.number().min(0.5).max(60).default(2),
  /**
   * Node worker: agent runs one `worker` process executes at once (OpenWorkflow's worker
   * concurrency). A parked run holds no slot.
   */
  RUNS_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  /**
   * Node storage: `s3` stores uploads in an S3-compatible bucket (AWS S3, MinIO, Ceph/RGW, GCS
   * interop). Unset = no object storage (uploads answer 503).
   */
  STORAGE_DRIVER: optionalEnum(['s3'] as const),
  /** The S3 endpoint (`http://localhost:9000` for MinIO). Unset = AWS's default for the region. */
  STORAGE_ENDPOINT: optionalString,
  /** `us-east-1` unless the store wants another. */
  STORAGE_REGION: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(1).default('us-east-1')
  ),
  STORAGE_BUCKET: optionalString,
  /** Path-style addressing (`http://host/bucket/key`) — true for MinIO and most self-hosted stores. */
  STORAGE_FORCE_PATH_STYLE: optionalBoolean(false),
  /**
   * The storage tenant fence (docs/TENANT-ISOLATION.md): `off` signs every tenant's objects with
   * the process's credentials; `on` with an STS session of `FILES_ROLE_ARN` per tenant (session tag
   * `tenant=<id>`), whose policy admits `tenants/<id>/` only; `shadow` tries that session, serves a
   * denial with the process's credentials and logs `storage.fence_denied` (the rollout aid).
   */
  STORAGE_TENANT_FENCE: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(['off', 'shadow', 'on']).default('off')
  ),
  /** The role a tenant's storage session assumes (`STORAGE_TENANT_FENCE=on|shadow`). */
  FILES_ROLE_ARN: optionalString,
  /**
   * Platform chat over any OpenAI-compatible endpoint, the tier after `ANTHROPIC_API_KEY`:
   * `AI_API_KEY` + `AI_BASE_URL` (OpenRouter, vLLM, Ollama…) + `AI_MODEL`. Without a base URL the
   * key is OpenAI's own (`AI_MODEL` defaults to its chat default).
   */
  AI_BASE_URL: optionalString,
  AI_MODEL: optionalString,
  /**
   * Platform embeddings endpoint for `EMBEDDINGS_API_KEY`: unset = OpenAI. The model must
   * answer 1024 dimensions (`dimensions: 1024` is sent); `EMBEDDINGS_MODEL` defaults to OpenAI's.
   */
  EMBEDDINGS_BASE_URL: optionalString,
  EMBEDDINGS_MODEL: optionalString,
  /**
   * Where the langfuse preset sends spans when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset —
   * `<base>/api/public/otel`.
   */
  LANGFUSE_BASE_URL: z.string().url().default('https://cloud.langfuse.com'),
  /** `deployment.environment.name` on every exported span; defaults to `APP_ENV`. */
  LANGFUSE_TRACING_ENVIRONMENT: optionalString,
  /**
   * The OTLP/HTTP base URL spans are POSTed to (`/v1/traces` is appended). Unset + Langfuse
   * keys → Langfuse Cloud; unset otherwise → no export (the local `ai_spans` store still records).
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional()
  ),
  /** `http/json` (default) or `http/protobuf` (the phoenix preset's default — Phoenix takes nothing else). */
  OTEL_EXPORTER_OTLP_PROTOCOL: optionalEnum(['http/json', 'http/protobuf']),
  /**
   * Which backend's auth and headers to fill in. Unset → `langfuse` when both Langfuse keys
   * are set (existing deployments migrate with no new secret), else `generic`.
   */
  OBSERVABILITY_PRESET: optionalEnum(['langfuse', 'phoenix', 'generic']),
  /** Off by default. `true` records prompts, completions and tool I/O in the export AND `ai_spans`. */
  OBSERVABILITY_CAPTURE_CONTENT: optionalBoolean(false),
  /** Link-out template, `{traceId}` substituted — e.g. `https://cloud.langfuse.com/project/<id>/traces/{traceId}`. */
  OBSERVABILITY_TRACE_URL: optionalString,
  /** Days of `ai_spans` the nightly prune keeps. */
  OBSERVABILITY_SPAN_RETENTION_DAYS: optionalPositiveInt(14),
  /**
   * Days of `plugin_events` the nightly prune keeps. Short on purpose: a payload may hold
   * personal data (a form's fields), and a delivery's retries end within the hour.
   */
  EVENTS_RETENTION_DAYS: optionalPositiveInt(7),
  /**
   * Days a SETTLED agent run keeps its tool-loop journal (`agent_run_turns` — every model turn and
   * tool result), which is what a strict replay answers from. Runs, events and decisions are kept.
   */
  AGENT_TRANSCRIPT_RETENTION_DAYS: optionalPositiveInt(30),
  /** Per-call `max_tokens` when a tenant config sets none; and the tool-loop turn cap. */
  AGENT_MAX_OUTPUT_TOKENS: optionalPositiveInt(16384),
  AGENT_MAX_TURNS: optionalPositiveInt(30),
  /**
   * Runs one tenant may have queued, running or parked at once, across every agent. The 51st
   * enqueue is a 429 `agent_runs_limit`. A soft cap — counted, then inserted — so a burst of
   * simultaneous requests can overshoot it by a few; it exists to stop a runaway loop or a
   * mistaken batch, not to meter.
   */
  AGENT_MAX_ACTIVE_RUNS_PER_TENANT: optionalPositiveInt(50),
  /** Organisations one person may own (403 `tenant_limit_reached` above it); global admins exempt. */
  MAX_OWNED_TENANTS_PER_USER: optionalPositiveInt(10),
  /** Invitation emails one person may queue per UTC day, across every tenant (429 above it). */
  INVITATION_EMAILS_PER_USER_PER_DAY: optionalPositiveInt(500),
  /** Invitation emails one tenant may queue per UTC day, whoever sends them (429 above it). */
  INVITATION_EMAILS_PER_TENANT_PER_DAY: optionalPositiveInt(1000),
  /**
   * The MCP server (`/mcp`, when the deployment ships the `mcp` feature). A connection lapses
   * after `MCP_GRANT_IDLE_DAYS` without a call or `MCP_GRANT_MAX_DAYS` after it was made, whichever
   * comes first; the call log keeps `MCP_CALL_RETENTION_DAYS`. Tool calls are capped per minute
   * per connection, per person in an organisation (across all their connections) and per
   * organisation — over a cap the call answers a tool error the client's model can read, never a
   * 429 that some clients treat as a dead server. The person's cap is twice one connection's, so
   * someone running two clients at once is not slowed, and a fifth of the organisation's, so no
   * single member can spend its whole minute.
   */
  MCP_GRANT_IDLE_DAYS: optionalPositiveInt(30),
  MCP_GRANT_MAX_DAYS: optionalPositiveInt(90),
  MCP_CALL_RETENTION_DAYS: optionalPositiveInt(90),
  MCP_CALLS_PER_GRANT_PER_MINUTE: optionalPositiveInt(60),
  MCP_CALLS_PER_USER_PER_MINUTE: optionalPositiveInt(120),
  MCP_CALLS_PER_TENANT_PER_MINUTE: optionalPositiveInt(600),
  /**
   * What one run may spend — tokens (input, output and prompt-cache reads and writes, every call
   * and decision) and USD. Unset = no cap. An agent's `meta.budget` overrides either. Checked before
   * every metered call; a run over it fails with event code `agent_budget_exceeded`, and so does a
   * chat call on a model with no known price while a cost cap applies.
   */
  AGENT_RUN_MAX_TOKENS: optionalCap('int'),
  AGENT_RUN_MAX_COST_USD: optionalCap('number'),
  /**
   * What one tenant's agent runs may spend per UTC day, in USD. Unset = no cap. Checked at
   * enqueue (429 `ai_budget_exceeded`) and before every metered call of a run already going.
   */
  AGENT_TENANT_DAILY_COST_USD: optionalCap('number'),
  /**
   * What one tenant's KNOWLEDGE work — document and query embeddings, reranking and (phase 2)
   * fact extraction — may spend per UTC day, in USD. Unset = no cap. Only extraction pauses at it
   * (`knowledgeExtractionAllowed`); indexing and search never do, because search must keep working.
   */
  KNOWLEDGE_TENANT_DAILY_COST_USD: optionalCap('number'),
  /**
   * How many fused candidates go to the reranker (5–100; unset = 20). The reranker's latency grows
   * with it — on Rocketflare's fixture corpus, qwen3-reranker-8b took a median 810 ms for 50 chunks and 465 ms
   * for 20, at the same recall — and a corpus whose answers sit deeper in the fused order may want
   * more; set it from `RERANK_CANDIDATES=… pnpm eval retrieval --rerank …` (docs/EVALS.md).
   */
  RERANK_CANDIDATES: z.preprocess(
    value =>
      value === undefined || value === null || String(value).trim() === '' ? undefined : value,
    z.coerce.number().int().min(5).max(100).optional()
  ),
  /**
   * Drop a reranked search hit whose reranker score (0–1, every reranker on that scale) is below
   * this. Unset = off: the reranker reorders and nothing is dropped. No effect without a reranker.
   */
  RERANK_MIN_SCORE: z.preprocess(
    value =>
      value === undefined || value === null || String(value).trim() === '' ? undefined : value,
    z.coerce.number().min(0).max(1).optional()
  ),
  /**
   * Give the chat box the knowledge tools (`search_knowledge`, `get_document`,
   * `list_documents`), so it answers from the workspace's own material. It costs more tokens per
   * turn. `false` is the operator's way back to a tool-free chat.
   */
  CHAT_KNOWLEDGE_TOOLS: optionalBoolean(true),
  /**
   * How long a run parked on a human question waits before it expires. Consumed
   * VERBATIM as the `timeout` of `step.waitForEvent`, so it must be a duration string the run
   * engine accepts ("168 hours", "30 minutes", "7 days") — not a number of seconds.
   *
   * A parked run is a row in the `openworkflow` schema and holds no `RUNS_CONCURRENCY` slot, so
   * parking is free however long it lasts. When the timeout passes first, the wait throws
   * `workflow.wait_for_event_timeout` and the run settles `cancelled`, its question `expired`.
   */
  AGENT_INTERRUPT_TIMEOUT: z.string().min(1).default('168 hours'),
  /**
   * Characters of stored history a chat turn may replay. The real constraint is the model's
   * context window and the tenant picks the model, so this is the knob rather than a message count
   * — 24 000 chars is roughly 6 000 tokens, which leaves room on a small (24k-token) model.
   * Raise it for a long-context provider. Anything older is trimmed and folded into the thread's
   * rolling summary by the `chat.compact` job.
   */
  CHAT_HISTORY_MAX_CHARS: optionalPositiveInt(24_000),
  /**
   * Feature flags, layer 1: the feature keys this deployment ships AT ALL. Only consulted for a
   * flag whose registry entry sets `environmentGated` — everything else is decided by the rollout
   * state in the database, so an ordinary flag needs no deploy.
   *
   * Blank means none, which is the FAIL-CLOSED direction and the point: this gate's failure mode is
   * an unreleased surface appearing in production, so an environment that forgets the var stays
   * dark — on every developer's laptop too, unless `.env` lists the key.
   */
  FEATURES_ENABLED: csvKeys,
  /**
   * Generic OpenID Connect sign-in (`providers/oidc.ts`). Unset → no `oidc` provider, the login
   * page is exactly what it was. Set it to the issuer's `issuer` value VERBATIM (trailing slash
   * included when the issuer has one) — discovery must echo it back or sign-in is refused.
   */
  OIDC_ISSUER: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional()
  ),
  OIDC_CLIENT_ID: optionalString,
  /** Button text on the login page ("Sign in with …" is the UI's, not this). */
  OIDC_LABEL: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(1).default('Single sign-on')
  ),
  /** Space-separated; `openid` is always sent whether listed or not. */
  OIDC_SCOPES: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(1).default('openid email profile')
  ),
  /**
   * `true` → the login page redirects straight to the OIDC issuer and hides the other methods, and
   * `/auth/google|microsoft` refuse to start. Hides, not disables: the magic-link endpoint stays
   * live for invitations. Requires `OIDC_ISSUER` + `OIDC_CLIENT_ID` (a config error otherwise).
   */
  AUTH_OIDC_ONLY: optionalBoolean(false),
  /**
   * Secure default `false`: an OIDC issuer that omits `email_verified` is not trusted for its
   * email (the sign-in is refused as `email_unverified`). `true` treats a MISSING flag as verified
   * — only for an issuer that controls the `email` claim (single-tenant Entra). An explicit
   * `email_verified: false` is refused either way.
   */
  OIDC_TRUST_EMAIL: optionalBoolean(false),
  /**
   * `true` → the OIDC issuer manages tenancy (IdP-managed tenancy, `api/services/idp-tenancy.ts`,
   * docs/CONCEPTS.md §2): every OIDC sign-in reconciles tenants, memberships and the global-admin
   * flag from the verified id_token, admission comes from those claims rather than `SIGNUP_MODE`,
   * an OIDC session ends `OIDC_SESSION_MAX_AGE_DAYS` after sign-in however active it is, and the
   * issuer's identity events are applied between sign-ins (`IDENTITY_WEBHOOK_SECRET`). Requires
   * `OIDC_ISSUER` + `OIDC_CLIENT_ID` and `TENANCY_MODE=multi`.
   */
  OIDC_MANAGED_TENANCY: optionalBoolean(false),
  /** The id_token claim holding the person's orgs: `[{ id, name, slug?, role }]`. */
  OIDC_ORGS_CLAIM: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(1).default('orgs')
  ),
  /**
   * Issuer role → app role, as `issuerRole:appRole` pairs separated by commas; the app role is
   * `admin` or `member`. An org whose role is not listed is skipped (and logged). Default: the
   * issuer's `admin` and `member` mean the same here.
   */
  OIDC_ROLE_MAP: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .default('admin:admin,member:member')
      .transform((text, ctx) => {
        const map: Record<string, 'admin' | 'member'> = {}
        for (const pair of text
          .split(',')
          .map(p => p.trim())
          .filter(Boolean)) {
          const [from, to, ...rest] = pair.split(':').map(p => p.trim())
          if (!from || (to !== 'admin' && to !== 'member') || rest.length > 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `"${pair}" is not issuerRole:admin or issuerRole:member`,
            })
            return z.NEVER
          }
          map[from] = to
        }
        return map
      })
  ),
  /**
   * A boolean id_token claim that admits the person even with no orgs (staff who may use every
   * app, say). Unset → only a person with an org, or a global admin, is admitted by the claims.
   */
  OIDC_ADMIT_CLAIM: optionalString,
  /**
   * A boolean id_token claim that makes the person a global admin while it is true. Unset → the
   * claims never grant global admin.
   */
  OIDC_GLOBAL_ADMIN_CLAIM: optionalString,
  /**
   * Under `OIDC_MANAGED_TENANCY`, an OIDC session ends this many days after sign-in, however active
   * the person is, so everyone is reconciled from fresh claims at least this often. Keep it no
   * longer than the issuer keeps undelivered identity events. At most 30, the cookie's own life: the
   * cookie is set once, at sign-in.
   */
  OIDC_SESSION_MAX_AGE_DAYS: z.preprocess(
    value => (value === undefined || value === null || String(value).trim() === '' ? 7 : value),
    z.coerce.number().int().positive().max(30)
  ),
  /**
   * A second credential for the MCP server (`api/routes/mcp.ts`, docs/CONCEPTS.md §19): an OUTSIDE
   * OAuth authorization server (Cognito, Entra, Okta…) whose JWT access tokens `/mcp` accepts
   * beside the app's own, its RFC 8414 `issuer` VERBATIM. The token must be bound to the URL it is
   * used on (`aud` = `${APP_URL}/mcp`, which covers `/mcp/t/<slug>` too, or that exact URL). Unset
   * → only the app's own authorization server issues tokens. Either way `/mcp` exists only where
   * `FEATURES_ENABLED` ships `mcp`, and each organisation turns it on at Settings → MCP.
   */
  MCP_AUTHORIZATION_SERVER: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional()
  ),

  // ---- Secrets (.env locally, the deployment's secret store deployed) — all optional here;
  //      features gate on presence (zero-creds first run) or demand them at use time. -------
  /**
   * The owner connection string: migrations, the scripts and the tests — and the Node server's
   * own connections too while `APP_DATABASE_URL` is unset.
   */
  DATABASE_URL: optionalString,
  /**
   * A separate, NON-owner login for the web and worker processes (docs/TENANT-ISOLATION.md). Set,
   * every runtime connection (the pool, pg-boss, OpenWorkflow, realtime) uses it as the system
   * role, and the migrate one-shot (`DATABASE_URL`, the owner) creates the login, sets its
   * password and grants it what the runtime needs. Its user is any role name but the owner's,
   * `rocketpod_app` or `rocketpod_system` (`scripts/db-roles.ts`).
   */
  APP_DATABASE_URL: optionalString,
  /** Per-PR database branch; when set it wins over DATABASE_URL (see db/client.ts). */
  PREVIEW_DATABASE_URL: optionalString,
  /**
   * Node realtime: the connection the `/ws` hub LISTENs on. Unset = the database URL. LISTEN
   * needs a session: behind PgBouncer in transaction mode, point this straight at Postgres (or at a
   * session-mode pool).
   */
  DATABASE_LISTEN_URL: optionalString,
  /**
   * Static credentials for the `STORAGE_DRIVER=s3` bucket — both or neither. Neither = the AWS
   * SDK's default credential chain (an ECS task role, an instance profile, `AWS_*` env).
   */
  STORAGE_ACCESS_KEY_ID: optionalString,
  STORAGE_SECRET_ACCESS_KEY: optionalString,
  /** AES-GCM key for OAuth tokens at rest. */
  OAUTH_ENCRYPTION_KEY: optionalSecret(32),
  /**
   * The issuer's identity-event signing secret (Standard Webhooks, `whsec_…`). Set under
   * `OIDC_MANAGED_TENANCY` → `POST /api/identity/events` accepts events signed with it; unset → that
   * route answers 404.
   */
  IDENTITY_WEBHOOK_SECRET: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .regex(/^whsec_[A-Za-z0-9+/]{32,}={0,2}$/, 'a Standard Webhooks secret: whsec_ and base64')
      .optional()
  ),
  RESEND_API_KEY: optionalString,
  /** Comma-separated emails promoted to global admin on first VERIFIED login. */
  BOOTSTRAP_ADMIN_EMAILS: csvList,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  MICROSOFT_CLIENT_ID: optionalString,
  MICROSOFT_CLIENT_SECRET: optionalString,
  /** Optional: a PUBLIC client (PKCE only) has none. Sent as HTTP Basic (`client_secret_basic`). */
  OIDC_CLIENT_SECRET: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  /** The key for the OpenAI-compatible platform chat tier (`AI_BASE_URL`, `AI_MODEL`). */
  AI_API_KEY: optionalString,
  EMBEDDINGS_API_KEY: optionalString,
  /** Platform TypeSafe (Jev) key for `ctx.decide`; tenants may set their own in Settings → AI. */
  TYPESAFE_API_KEY: optionalString,
  LANGFUSE_PUBLIC_KEY: optionalString,
  LANGFUSE_SECRET_KEY: optionalString,
  /** Extra OTLP request headers, `k=v,k=v` (values URL-encoded, per the OTel spec). A secret. */
  OTEL_EXPORTER_OTLP_HEADERS: optionalString,
})

/**
 * `[vars]` and secrets contributed by installed plugins, validated with everything else so a
 * plugin with a missing var fails at `loadConfig` rather than at its first request.
 *
 * `AppConfig` stays the CORE type on purpose, and the cast is what holds that line: `extend()` over
 * a `ZodRawShape` collapses the inferred shape to an index signature, which would turn every core
 * key into `any`. A plugin reads its own keys through its own narrowing helper — one plugin's vars
 * can never widen, or weaken, the type core is checked against.
 */
const pluginConfigShape: z.ZodRawShape = Object.assign(
  {},
  ...sharedPlugins.map(p => p.config ?? {})
)
const configSchema = coreConfigSchema.extend(pluginConfigShape).superRefine((cfg, ctx) => {
  // Asking for a provider by name and then not configuring it would quietly log every email.
  if (cfg.EMAIL_PROVIDER === 'resend' && !cfg.RESEND_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EMAIL_PROVIDER'],
      message: 'EMAIL_PROVIDER=resend needs RESEND_API_KEY',
    })
  }
  if (cfg.EMAIL_PROVIDER === 'ses' && cfg.EMAIL_FROM === DEFAULT_EMAIL_FROM) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EMAIL_FROM'],
      message: 'EMAIL_PROVIDER=ses needs EMAIL_FROM — an address or domain SES has verified',
    })
  }
  // One storage key without the other is a typo, never a choice: refuse it rather than fall back
  // to the SDK's default chain with a half-set pair.
  if (Boolean(cfg.STORAGE_ACCESS_KEY_ID) !== Boolean(cfg.STORAGE_SECRET_ACCESS_KEY)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [cfg.STORAGE_ACCESS_KEY_ID ? 'STORAGE_SECRET_ACCESS_KEY' : 'STORAGE_ACCESS_KEY_ID'],
      message:
        'STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY are set together or not at all ' +
        "(neither = the AWS SDK's default credential chain, e.g. an ECS task role)",
    })
  }
  // DATABASE_SSL and a URL's own `sslmode` would give different connections different TLS
  // (the two drivers rank them oppositely): one place decides, so a URL carrying one is refused.
  for (const key of [
    'DATABASE_URL',
    'APP_DATABASE_URL',
    'PREVIEW_DATABASE_URL',
    'DATABASE_LISTEN_URL',
  ] as const) {
    const url = cfg[key] as string | undefined
    const ssl = { DATABASE_SSL: cfg.DATABASE_SSL as string | undefined }
    const conflict = url ? databaseSslConflict(url, ssl, key) : undefined
    if (conflict) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: conflict })
  }
  // A fence with no role to assume would have to fall back to the process's credentials: refuse it.
  if (cfg.STORAGE_TENANT_FENCE !== 'off' && !cfg.FILES_ROLE_ARN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['FILES_ROLE_ARN'],
      message: `STORAGE_TENANT_FENCE=${cfg.STORAGE_TENANT_FENCE} needs FILES_ROLE_ARN — the role each tenant's storage session assumes`,
    })
  }
  // The owner bypasses every policy: `enforce` on it would look enforced and enforce nothing.
  if (cfg.TENANT_SCOPE_MODE === 'enforce' && !cfg.APP_DATABASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TENANT_SCOPE_MODE'],
      message:
        'TENANT_SCOPE_MODE=enforce needs APP_DATABASE_URL — the owner connection bypasses row-level security',
    })
  }
  // An OIDC-only login page with no issuer would offer no way in at all.
  if (cfg.AUTH_OIDC_ONLY && !(cfg.OIDC_ISSUER && cfg.OIDC_CLIENT_ID)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AUTH_OIDC_ONLY'],
      message: 'AUTH_OIDC_ONLY=true needs OIDC_ISSUER and OIDC_CLIENT_ID',
    })
  }
  // Managed tenancy reads the issuer's id_token — without an issuer it reads nothing.
  if (cfg.OIDC_MANAGED_TENANCY && !(cfg.OIDC_ISSUER && cfg.OIDC_CLIENT_ID)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OIDC_MANAGED_TENANCY'],
      message: 'OIDC_MANAGED_TENANCY=true needs OIDC_ISSUER and OIDC_CLIENT_ID',
    })
  }
  // One tenant per issuer org: single-tenant mode has exactly one, so the two cannot both hold.
  if (cfg.OIDC_MANAGED_TENANCY && cfg.TENANCY_MODE === 'single') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OIDC_MANAGED_TENANCY'],
      message:
        'OIDC_MANAGED_TENANCY=true needs TENANCY_MODE=multi (it creates one tenant per issuer org); ' +
        'single-tenant mode signs OIDC users into its one tenant without it — unset it',
    })
  }
}) as unknown as typeof coreConfigSchema

export type AppConfig = z.infer<typeof coreConfigSchema>
export type AppEnvName = AppConfig['APP_ENV']
export type OAuthProviderName = 'google' | 'microsoft' | 'oidc'

/** Thrown by `loadConfig`; the message lists every missing/invalid key. */
export class ConfigError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    const details = issues.map(issue => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n')
    super(`Invalid environment configuration:\n${details}`)
    this.name = 'ConfigError'
  }
}

/**
 * Memo keyed on the env OBJECT, not its contents: in production `env` is one object for the
 * life of the process, so this parses once; under `tsx watch` a .env edit restarts it with a new
 * object and re-validates. Failures are not cached so every caller sees the same error.
 */
const cache = new WeakMap<object, AppConfig>()

export function loadConfig(env: unknown): AppConfig {
  const key = typeof env === 'object' && env !== null ? env : undefined
  if (key) {
    const hit = cache.get(key)
    if (hit) return hit
  }
  const result = configSchema.safeParse(env ?? {})
  if (!result.success) throw new ConfigError(result.error.issues)
  if (key) cache.set(key, result.data)
  return result.data
}

// ---- Derived helpers ---------------------------------------------------------------------

export const isProduction = (cfg: AppConfig): boolean => cfg.APP_ENV === 'production'
export const isDevelopment = (cfg: AppConfig): boolean => cfg.APP_ENV === 'development'

/** `{APP_URL}/auth/{provider}/callback` — never configured per provider. */
export function oauthRedirectUri(cfg: AppConfig, provider: OAuthProviderName): string {
  return new URL(`/auth/${provider}/callback`, cfg.APP_URL).toString()
}

export type EmailProvider = 'log' | 'resend' | 'ses'

/** `EMAIL_PROVIDER`, or by default Resend with a key and the log without (zero-creds first run). */
export const emailProvider = (cfg: AppConfig): EmailProvider =>
  cfg.EMAIL_PROVIDER ?? (cfg.RESEND_API_KEY ? 'resend' : 'log')

/** Whether email is delivered at all; `log` only logs it (magic links in the server log). */
export const hasEmail = (cfg: AppConfig): boolean => emailProvider(cfg) !== 'log'

/** Providers whose client id AND secret are both present — the login page shows only these. */
export function configuredOAuthProviders(cfg: AppConfig): OAuthProviderName[] {
  const providers: OAuthProviderName[] = []
  if (cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET) providers.push('google')
  if (cfg.MICROSOFT_CLIENT_ID && cfg.MICROSOFT_CLIENT_SECRET) providers.push('microsoft')
  if (hasOidc(cfg)) providers.push('oidc')
  return providers
}

/** `/mcp` also accepts access tokens from an outside authorization server. */
export const hasOutsideMcpIssuer = (cfg: AppConfig): boolean =>
  Boolean(cfg.MCP_AUTHORIZATION_SERVER)

/** An OIDC issuer is configured — issuer + client id (the secret is optional: public clients). */
export const hasOidc = (cfg: AppConfig): boolean => Boolean(cfg.OIDC_ISSUER && cfg.OIDC_CLIENT_ID)

/** IdP-managed tenancy in force (loadConfig has already refused it without an issuer). */
export const isIdpManaged = (cfg: AppConfig): boolean => cfg.OIDC_MANAGED_TENANCY && hasOidc(cfg)

/** `AUTH_OIDC_ONLY` in force (loadConfig has already refused it without an issuer). */
export const isOidcOnly = (cfg: AppConfig): boolean => cfg.AUTH_OIDC_ONLY && hasOidc(cfg)
