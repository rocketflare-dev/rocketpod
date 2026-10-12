/**
 * The test `Platform` (D15, M6b): native in-memory implementations of every capability — a rate
 * limiter and operation locks over an in-memory KV-style store, a recording jobs queue, an
 * in-memory object store, a recording realtime hub, a recording model runner (with `toMarkdown`
 * for D18 uploads) and a recording run engine — plus vars from `process.env` (loaded from
 * .env.test by dotenv-cli). Tests may read `process.env`; `src/` may not.
 *
 * Also `createExecutionContext()` — `waitUntil` collects promises so `waitOnExecutionContext`
 * can drain them; this is how the per-request DB close (middleware/database.ts) is awaited.
 */
import type { RealtimeEvent } from '@rocketpod/shared/realtime'
import type { ExecutionContext } from 'hono'
import { deterministicEmbedding } from '@/api/services/ai/deterministic-embedding'
import type { AppBindings } from '@/api/types'
import type {
  DocumentConverter,
  JobsQueue,
  Locks,
  Platform,
  PlatformAi,
  PutOptions,
  RateLimitDecision,
  RateLimiter,
  RealtimeHub,
  RunEngine,
  StorageBody,
  StorageService,
  StoredObjectMeta,
} from '@/platform/types'

// ---- KV -----------------------------------------------------------------------------------

interface KvEntry {
  value: string
  expiresAt?: number
  metadata?: unknown
}

/** An in-memory key/value store with TTLs — the backing of the test rate limiter and locks. */
export class MemoryKV {
  readonly store = new Map<string, KvEntry>()

  private live(key: string): KvEntry | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return entry
  }

  async get(key: string, type?: string | { type?: string }): Promise<unknown> {
    const entry = this.live(key)
    if (!entry) return null
    const t = typeof type === 'string' ? type : type?.type
    if (t === 'json') return JSON.parse(entry.value)
    if (t === 'arrayBuffer') return new TextEncoder().encode(entry.value).buffer
    return entry.value
  }

  async getWithMetadata(key: string, type?: string) {
    const entry = this.live(key)
    return {
      value: entry ? await this.get(key, type) : null,
      metadata: entry?.metadata ?? null,
      cacheStatus: null,
    }
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { expirationTtl?: number; expiration?: number; metadata?: unknown }
  ): Promise<void> {
    const text =
      typeof value === 'string'
        ? value
        : value instanceof ArrayBuffer
          ? new TextDecoder().decode(value)
          : ArrayBuffer.isView(value)
            ? new TextDecoder().decode(value)
            : await new Response(value).text()
    const expiresAt = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : options?.expiration
        ? options.expiration * 1000
        : undefined
    this.store.set(key, { value: text, expiresAt, metadata: options?.metadata })
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
    const prefix = options?.prefix ?? ''
    const keys = [...this.store.keys()]
      .filter(k => k.startsWith(prefix) && this.live(k))
      .sort()
      .slice(0, options?.limit ?? 1000)
      .map(name => ({
        name,
        expiration: this.store.get(name)?.expiresAt,
        metadata: this.store.get(name)?.metadata,
      }))
    return { keys, list_complete: true as const, cacheStatus: null }
  }
}

/** Minimal KV surface the limiter and locks below use — `MemoryKV` satisfies it. */
export interface RateLimitKv {
  get(key: string, type: 'json'): Promise<unknown>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * Pure sliding-window check: read the window, drop stale hits, decide, write back — the same
 * semantics `src/node/limits.ts` implements atomically in Postgres.
 */
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
  await kv.put(key, JSON.stringify(hits), { expirationTtl: options.windowSeconds })
  return { allowed: true, remaining: options.max - hits.length, retryAfterSeconds: 0 }
}

export function createMemoryRateLimiter(kv: RateLimitKv): RateLimiter {
  return { check: (key, options) => checkRateLimit(kv, key, options) }
}

/** `op_lock:<key>` holds `{ startedAt }` until released or expired. */
export function createMemoryLocks(kv: RateLimitKv): Locks {
  return {
    async acquire(key, ttlSeconds) {
      const lockKey = `op_lock:${key}`
      if ((await kv.get(lockKey, 'json')) !== null) return false
      await kv.put(lockKey, JSON.stringify({ startedAt: Date.now() }), {
        expirationTtl: ttlSeconds,
      })
      return true
    },
    async release(key) {
      await kv.delete(`op_lock:${key}`)
    },
  }
}

// ---- Queue ---------------------------------------------------------------------------------

export interface RecordedMessage<T = unknown> {
  body: T
  options?: unknown
}

/** Records `send`/`sendBatch` calls so tests can assert what routes enqueued (Phase 2). */
export class RecordingQueue<T = unknown> {
  readonly messages: RecordedMessage<T>[] = []
  async send(body: T, options?: unknown): Promise<void> {
    this.messages.push({ body, options })
  }
  async sendBatch(messages: Iterable<{ body: T; options?: unknown }>): Promise<void> {
    for (const m of messages) this.messages.push({ body: m.body, options: m.options })
  }
  clear(): void {
    this.messages.length = 0
  }
}

// ---- Storage --------------------------------------------------------------------------------

/** One stored object, as a test inspects it through `stubs(env).files.objects`. */
export interface StoredEntry {
  body: Uint8Array
  contentType: string
  metadata: Record<string, string>
  uploaded: Date
}

const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

async function toBytes(body: StorageBody): Promise<Uint8Array> {
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  return new Uint8Array(await body.arrayBuffer())
}

/**
 * An in-memory `StorageService` (D23). Paging honours `cursor` and `limit` the way an object store
 * does — the cursor is the LAST key of the page, and a cursor comes back only while another page
 * follows. Faithful here because a bulk delete pages through a prefix, and a fake that always
 * answered one page would make a broken paging loop look correct.
 */
export class MemoryStorage implements StorageService {
  readonly objects = new Map<string, StoredEntry>()

  private meta(key: string, e: StoredEntry): StoredObjectMeta {
    return {
      key,
      size: e.body.byteLength,
      contentType: e.contentType,
      etag: `"${e.body.byteLength}-${e.uploaded.getTime()}"`,
      uploaded: e.uploaded,
      metadata: { ...e.metadata },
    }
  }

  async put(key: string, body: StorageBody, options?: Partial<PutOptions>) {
    const entry: StoredEntry = {
      body: await toBytes(body),
      contentType: options?.contentType ?? DEFAULT_CONTENT_TYPE,
      metadata: options?.metadata ?? {},
      uploaded: new Date(),
    }
    this.objects.set(key, entry)
    return this.meta(key, entry)
  }

  async get(key: string) {
    const e = this.objects.get(key)
    if (!e) return null
    return {
      ...this.meta(key, e),
      body: new Response(e.body as unknown as BodyInit).body as ReadableStream<Uint8Array>,
    }
  }

  async head(key: string) {
    const e = this.objects.get(key)
    return e ? this.meta(key, e) : null
  }

  async delete(key: string) {
    this.objects.delete(key)
  }

  async deleteMany(keys: readonly string[]) {
    for (const k of keys) this.objects.delete(k)
  }

  async listPage(prefix: string, options?: { cursor?: string; limit?: number }) {
    const limit = options?.limit ?? 1000
    const matching = [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
    const after = options?.cursor
    const start = after ? matching.findIndex(([k]) => k > after) : 0
    const page = start < 0 ? [] : matching.slice(start, start + limit)
    const truncated = start >= 0 && start + page.length < matching.length
    return {
      objects: page.map(([k, e]) => this.meta(k, e)),
      cursor: truncated ? page[page.length - 1]?.[0] : undefined,
    }
  }

  async list(prefix: string) {
    const out: StoredObjectMeta[] = []
    let cursor: string | undefined
    do {
      const page = await this.listPage(prefix, { cursor })
      out.push(...page.objects)
      cursor = page.cursor
    } while (cursor)
    return out
  }
}

// ---- Realtime -------------------------------------------------------------------------------

export interface RecordedBroadcast {
  tenantId: string
  /** `[method, ...args]` — `broadcast`, `broadcastToUser` or `broadcastToUsers`, then its arguments. */
  args: unknown[]
}

/** One `/ws` upgrade the route handed to the hub. */
export interface RecordedAccept {
  request: Request
  member: { tenantId: string; userId: string; sessionId: string }
}

/**
 * A recording `RealtimeHub` (D8): every send records `{ tenantId, args: [method, ...args] }` in
 * `broadcasts`, so route tests can assert "a nudge was sent to tenant X" without sockets. `accept`
 * records the upgrade in `accepted` and answers 501 — the socket side is exercised against the
 * real hub (`node-realtime.test.ts`).
 */
export class RecordingRealtime implements RealtimeHub {
  readonly broadcasts: RecordedBroadcast[] = []
  readonly accepted: RecordedAccept[] = []

  private record(tenantId: string, args: unknown[]) {
    this.broadcasts.push({ tenantId, args })
    return Promise.resolve({ delivered: 0 })
  }

  toTenant(tenantId: string, event: RealtimeEvent) {
    return this.record(tenantId, ['broadcast', event])
  }

  toUser(tenantId: string, userId: string, event: RealtimeEvent) {
    return this.record(tenantId, ['broadcastToUser', userId, event])
  }

  toUsers(tenantId: string, userIds: string[], event: RealtimeEvent) {
    return this.record(tenantId, ['broadcastToUsers', userIds, event])
  }

  async accept(request: Request, member: RecordedAccept['member']): Promise<Response> {
    this.accepted.push({ request, member })
    return new Response('realtime stub', { status: 501 })
  }

  clear(): void {
    this.broadcasts.length = 0
    this.accepted.length = 0
  }
}

// ---- Workers AI ------------------------------------------------------------------------------

export interface RecordedAiRun {
  model: string
  inputs: Record<string, unknown>
}

export interface RecordedConversion {
  name: string
  type: string
  size: number
}

/** A converter's answer (see `src/platform/types.ts` `MarkdownConversion`). */
export type FakeConversion =
  | {
      id: string
      name: string
      mimeType: string
      format: 'markdown' | 'text'
      tokens: number
      data: string
    }
  | { id: string; name: string; mimeType: string; format: 'error'; error: string }

/**
 * A recording model runner (Phase 3, D17): `run()` records the call and answers an embeddings-shaped
 * `{ shape, data }` of deterministic 1024-dim vectors (one per input text) so `resolveEmbeddings`'s
 * `workers_ai` branch is testable without the platform. Override `respond` to shape other models.
 * `toMarkdown()` (D18 uploads) records `{ name, type, size }` in `conversions` and answers markdown
 * made of the blob's bytes decoded as text — so a fixture "PDF" is just text typed
 * `application/pdf`; override `convert` for `format: 'error'` or a thrown outage.
 */
export class RecordingAi {
  readonly runs: RecordedAiRun[] = []
  readonly conversions: RecordedConversion[] = []
  convert: (doc: { name: string; blob: Blob }) => Promise<FakeConversion> = async doc => ({
    id: crypto.randomUUID(),
    name: doc.name,
    mimeType: doc.blob.type,
    format: 'markdown',
    tokens: Math.ceil(doc.blob.size / 4),
    data: `# ${doc.name}\n\n${await doc.blob.text()}`,
  })
  async toMarkdown(doc: { name: string; blob: Blob }): Promise<FakeConversion> {
    this.conversions.push({ name: doc.name, type: doc.blob.type, size: doc.blob.size })
    return this.convert(doc)
  }
  /**
   * Default answers: a chat call (`inputs.messages`) gets `{ response: 'ok', usage }` in the
   * non-streamed shape — override `respond` with an SSE `ReadableStream` to exercise streaming —
   * and an embeddings call (`inputs.text`) gets deterministic 1024-dim vectors.
   */
  respond: (model: string, inputs: Record<string, unknown>) => unknown = (_model, inputs) => {
    if (Array.isArray(inputs.messages)) {
      return { response: 'ok', usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }
    }
    const text = inputs.text
    const texts = Array.isArray(text) ? text : [String(text ?? '')]
    return {
      shape: [texts.length, 1024],
      data: texts.map(t => deterministicEmbedding(String(t))),
    }
  }
  async run(model: string, inputs: Record<string, unknown>): Promise<unknown> {
    this.runs.push({ model, inputs })
    return this.respond(model, inputs)
  }
  clear(): void {
    this.runs.length = 0
    this.conversions.length = 0
  }
}

// ---- Workflow --------------------------------------------------------------------------------

export interface RecordedWorkflowInstance {
  id: string
  params: unknown
}

/** What `instance.status()` answers — the vocabulary `reconcileRun` maps. */
export interface FakeInstanceStatus {
  status:
    | 'queued'
    | 'running'
    | 'paused'
    | 'errored'
    | 'terminated'
    | 'complete'
    | 'waiting'
    | 'waitingForPause'
    | 'unknown'
  error?: { name: string; message: string }
  output?: unknown
}

/** What `instance.sendEvent()` was called with — the resume nudge of a parked run (issue #17). */
export interface RecordedWorkflowEvent {
  instanceId: string
  type: string
  payload: unknown
}

/**
 * A recording `RunEngine` (Phase 3b, D7): `create()` records `{ id, params }` and answers an
 * instance whose `status()` is whatever `setStatus(id, …)` said (default `running`); a second
 * `create` with the same id throws like an engine does; `get()` throws `instance.not_found` for an
 * id never created unless a status was pre-seeded for it. Nothing runs — tests drive the run body
 * (`runAgentRun`) directly with a fake step (`tests/mocks/step.ts`).
 *
 * `sendEvent` RECORDS rather than no-ops, because the resume path is a behaviour worth asserting
 * ("the parked instance was woken, with this interrupt id"), and `notFoundOnSendEvent` makes it
 * throw the platform's own error so a test can drive the restart fallback — the branch that stops
 * an answered run hanging forever when its instance is gone (T4/T5).
 */
export class RecordingWorkflow {
  readonly created: RecordedWorkflowInstance[] = []
  readonly statuses = new Map<string, FakeInstanceStatus>()
  /** Instance ids a forced cancel terminated, in order. */
  readonly terminated: string[] = []
  /** Every `sendEvent` that was delivered, in order. */
  readonly events: RecordedWorkflowEvent[] = []
  /** Instance ids `status()` was asked about, in order — the spy for "reconcile ran exactly once". */
  readonly statusCalls: string[] = []
  /** Make `sendEvent` fail the way a retention-expired or dev-restarted instance does. */
  notFoundOnSendEvent = false
  defaultStatus: FakeInstanceStatus = { status: 'running' }

  async create(options: { id?: string; params?: unknown } = {}) {
    const id = options.id ?? crypto.randomUUID()
    if (this.created.some(c => c.id === id)) {
      throw new Error(`instance.already_exists: an instance with id ${id} already exists`)
    }
    this.created.push({ id, params: options.params })
    return this.instance(id)
  }

  async get(id: string) {
    if (!this.created.some(c => c.id === id) && !this.statuses.has(id)) {
      throw new Error(`instance.not_found: no instance with id ${id}`)
    }
    return this.instance(id)
  }

  /** Make `status()` for `id` answer this (also makes `get(id)` resolve). */
  setStatus(id: string, status: FakeInstanceStatus): void {
    this.statuses.set(id, status)
  }

  private instance(id: string) {
    return {
      id,
      status: async (): Promise<FakeInstanceStatus> => {
        this.statusCalls.push(id)
        return this.statuses.get(id) ?? this.defaultStatus
      },
      pause: async () => {},
      resume: async () => {},
      terminate: async () => {
        this.terminated.push(id)
        this.statuses.set(id, { status: 'terminated' })
      },
      restart: async () => {},
      sendEvent: async (event: { type: string; payload?: unknown }) => {
        if (this.notFoundOnSendEvent) {
          throw new Error(`instance.not_found: no instance with id ${id}`)
        }
        this.events.push({ instanceId: id, type: event.type, payload: event.payload ?? null })
      },
    }
  }

  clear(): void {
    this.created.length = 0
    this.terminated.length = 0
    this.events.length = 0
    this.statusCalls.length = 0
    this.notFoundOnSendEvent = false
    this.statuses.clear()
  }
}

// ---- Env -----------------------------------------------------------------------------------

/** The fakes behind one test env — reach them through `stubs(env)`. */
interface TestStubs {
  kv: MemoryKV
  queue: RecordingQueue
  files: MemoryStorage
  hub: RecordingRealtime
  ai: RecordingAi | undefined
  workflow: RecordingWorkflow | undefined
}

const STUBS = new WeakMap<object, TestStubs>()

/**
 * A test env is BOTH things at once: the runtime env the app receives — pass it straight to
 * `app.request`, `queue()` and `dispatchScheduled()`, which read the prebuilt `PLATFORM` from it —
 * and that same `Platform`, as getters, so a service that takes a `Platform` takes `env` too.
 * Override a member (`createTestEnv({ storage: null })`) to model a missing capability. Reach the
 * fakes' inspection surface (recorded messages, stored objects, the KV store) through `stubs(env)`.
 */
export type TestEnv = AppBindings &
  Platform & {
    DATABASE_URL: string
    [secret: string]: unknown
  }

const SECRET_KEYS = [
  'DATABASE_URL',
  'PREVIEW_DATABASE_URL',
  'OAUTH_ENCRYPTION_KEY',
  'RESEND_API_KEY',
  'BOOTSTRAP_ADMIN_EMAILS',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
  'EMBEDDINGS_API_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_TRACING_ENVIRONMENT',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OBSERVABILITY_PRESET',
  'OBSERVABILITY_CAPTURE_CONTENT',
  'OBSERVABILITY_TRACE_URL',
  'AGENT_MAX_OUTPUT_TOKENS',
  'AGENT_MAX_TURNS',
] as const

/** The SPA's assets, which a test never serves: every path is a 404. */
function assetsStub(): NonNullable<AppBindings['ASSETS']> {
  return { fetch: async () => new Response('Not Found (ASSETS stub)', { status: 404 }) }
}

const PLATFORM_KEYS = [
  'jobs',
  'storage',
  'realtime',
  'runs',
  'rateLimiter',
  'locks',
  'ai',
  'converter',
] as const satisfies readonly (keyof Platform)[]

/** The converter slice of a model runner that can convert, or null. */
function converterOf(ai: PlatformAi | null): DocumentConverter | null {
  if (!ai || typeof ai.toMarkdown !== 'function') return null
  return document => (ai.toMarkdown as NonNullable<PlatformAi['toMarkdown']>).call(ai, document)
}

/**
 * A fresh env per call (no state is shared between calls). Vars come from process.env with
 * .env.test-compatible defaults; pass `overrides` to change any of them, or to replace or null a
 * `Platform` member.
 */
export function createTestEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  const databaseUrl =
    process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5433/rocketpod_test'
  const kv = new MemoryKV()
  const fakes: TestStubs = {
    kv,
    queue: new RecordingQueue(),
    files: new MemoryStorage(),
    hub: new RecordingRealtime(),
    ai: new RecordingAi(),
    workflow: new RecordingWorkflow(),
  }
  const ai = fakes.ai as unknown as PlatformAi
  const base: Platform = {
    jobs: fakes.queue as unknown as JobsQueue,
    storage: fakes.files,
    realtime: fakes.hub,
    runs: fakes.workflow as unknown as RunEngine,
    rateLimiter: createMemoryRateLimiter(kv),
    locks: createMemoryLocks(kv),
    ai,
    converter: converterOf(ai),
  }
  const members: Record<string, unknown> = { ...base }
  for (const key of PLATFORM_KEYS) if (key in overrides) members[key] = overrides[key]
  // A converter follows its model runner unless the test set one explicitly.
  if ('ai' in overrides && !('converter' in overrides)) {
    members.converter = converterOf((overrides.ai ?? null) as PlatformAi | null)
  }
  if ('ai' in overrides) fakes.ai = (overrides.ai ?? undefined) as RecordingAi | undefined
  if ('runs' in overrides) {
    fakes.workflow = (overrides.runs ?? undefined) as RecordingWorkflow | undefined
  }

  const vars: Record<string, unknown> = {
    ASSETS: assetsStub(),
    APP_ENV: process.env.APP_ENV ?? 'development',
    APP_URL: process.env.APP_URL ?? 'http://localhost:3001',
    APP_NAME: process.env.APP_NAME ?? 'Rocketpod Test',
    RELEASE_VERSION: process.env.RELEASE_VERSION ?? 'test',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
    EMAIL_FROM: process.env.EMAIL_FROM ?? 'Rocketpod Test <noreply@example.com>',
    TENANCY_MODE: process.env.TENANCY_MODE ?? 'multi',
    SIGNUP_MODE: process.env.SIGNUP_MODE ?? 'invite_only',
    TENANT_SCOPE_MODE: process.env.TENANT_SCOPE_MODE ?? 'off',
    DATABASE_DRIVER: process.env.DATABASE_DRIVER || 'postgres',
  }
  for (const key of SECRET_KEYS) {
    const value = process.env[key]
    if (value !== undefined && value !== '') vars[key] = value
  }
  vars.DATABASE_URL = databaseUrl

  const env: Record<string, unknown> = { ...vars }
  for (const [key, value] of Object.entries(overrides)) {
    if (!(PLATFORM_KEYS as readonly string[]).includes(key)) env[key] = value
  }
  const platform = Object.freeze(members) as unknown as Platform
  env.PLATFORM = platform
  for (const key of PLATFORM_KEYS) {
    Object.defineProperty(env, key, { value: platform[key], enumerable: true })
  }
  STUBS.set(env, fakes)
  return env as TestEnv
}

/** Typed access to the in-memory fakes behind a `createTestEnv()` env. */
export function stubs(env: TestEnv): TestStubs {
  const fakes = STUBS.get(env)
  if (!fakes) throw new Error('stubs(env): not an env from createTestEnv()')
  return fakes
}

// ---- ExecutionContext ----------------------------------------------------------------------

export interface TestExecutionContext extends ExecutionContext {
  readonly pending: Promise<unknown>[]
}

export function createExecutionContext(): TestExecutionContext {
  const pending: Promise<unknown>[] = []
  return {
    pending,
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise)
    },
    passThroughOnException() {},
    props: {},
  }
}

/** Await everything passed to `waitUntil`, including promises enqueued while draining. */
export async function waitOnExecutionContext(ctx: TestExecutionContext): Promise<void> {
  let settled = 0
  while (settled < ctx.pending.length) {
    const batch = ctx.pending.slice(settled)
    settled = ctx.pending.length
    await Promise.allSettled(batch)
  }
}
