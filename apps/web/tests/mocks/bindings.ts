/**
 * The test `Platform`: native in-memory implementations of every capability — a rate
 * limiter and operation locks over an in-memory key/value store, a recording jobs queue, an
 * in-memory object store, a recording realtime hub, a recording OpenAI-compatible model endpoint
 * (reached through `fetch`, see `RecordingAi`) with its converter for uploads, and a recording
 * run engine — plus vars from `process.env` (loaded from .env.test by dotenv-cli). Tests may read
 * `process.env`; `src/` may not.
 *
 * Also `createExecutionContext()` — `waitUntil` collects promises so `waitOnExecutionContext`
 * can drain them; this is how the per-request DB close (middleware/database.ts) is awaited.
 */
import { DOCUMENT_UPLOAD_TYPES } from '@rocketpod/shared/ai/embeddings'
import type { RealtimeEvent } from '@rocketpod/shared/realtime'
import type { ExecutionContext } from 'hono'
import { deterministicEmbedding } from '@/api/services/ai/deterministic-embedding'
import type { AppBindings } from '@/api/types'
import type {
  DocumentConverter,
  GetOptions,
  JobsQueue,
  Locks,
  Platform,
  PutOptions,
  RateLimitDecision,
  RateLimiter,
  RealtimeHub,
  RealtimeMember,
  RunEngine,
  StorageBody,
  StorageService,
  StoredObjectMeta,
  StoredRange,
} from '@/platform/types'
import { StorageRangeNotSatisfiableError } from '@/platform/types'

// ---- Key/value store ----------------------------------------------------------------------

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

/** Minimal key/value surface the limiter and locks below use — `MemoryKV` satisfies it. */
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

/** Records `send`/`sendBatch` calls so tests can assert what routes enqueued. */
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
 * An in-memory `StorageService`. Paging honours `cursor` and `limit` the way an object store
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

  async putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    options?: Partial<PutOptions>
  ): Promise<StoredObjectMeta> {
    return this.put(key, await new Response(body).arrayBuffer(), options)
  }

  /** S3's range semantics: clamp `end`, a long suffix reads everything, past the end is a 416. */
  async get(key: string, options?: GetOptions) {
    const e = this.objects.get(key)
    if (!e) return null
    let bytes = e.body
    let range: StoredRange | undefined
    if (options?.range) {
      const total = e.body.byteLength
      const r = options.range
      const start = 'suffix' in r ? Math.max(0, total - r.suffix) : r.start
      const end = 'suffix' in r ? total - 1 : Math.min(r.end ?? total - 1, total - 1)
      const empty = 'suffix' in r ? r.suffix === 0 : false
      if (total === 0 || empty || start >= total) {
        throw new StorageRangeNotSatisfiableError(key, total)
      }
      range = { start, end, total }
      bytes = e.body.subarray(start, end + 1)
    }
    return {
      ...this.meta(key, e),
      body: new Response(bytes as unknown as BodyInit).body as ReadableStream<Uint8Array>,
      ...(range ? { range } : {}),
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
  /** `[method, ...args]` — `broadcast`, `broadcastToUser`, `broadcastToUsers` or `broadcastToTopic`, then its arguments. */
  args: unknown[]
}

/** One `/ws` upgrade the route handed to the hub. */
export interface RecordedAccept {
  request: Request
  member: RealtimeMember
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

  /** Recorded under the event's tenant, like the others: `['broadcastToTopic', topic, event]`. */
  toTopic(topic: string, event: RealtimeEvent) {
    return this.record(event.tenantId, ['broadcastToTopic', topic, event])
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

// ---- Model endpoint ------------------------------------------------------------------------

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

/** Where every test env's platform AI vars point; `fetch` to it never leaves the process. */
export const FAKE_MODELS_BASE_URL = 'http://fake-models.test/v1'
export const FAKE_CHAT_MODEL = 'fake-chat'
export const FAKE_EMBEDDINGS_MODEL = 'fake-embeddings'

/** Each fake answers for its own bearer token, so envs in one process never see each other's calls. */
const FAKE_MODELS = new Map<string, RecordingAi>()

/**
 * A recording OpenAI-compatible model endpoint — what the platform `AI_*` and
 * `EMBEDDINGS_*` vars of every test env point at. The real `openai_compatible` adapters call it
 * through `fetch`, which this module routes in-process for `FAKE_MODELS_BASE_URL`, so the code under
 * test is the production client and nothing touches the network.
 *
 * - `runs` records `{ model, inputs }` per call: an embeddings call's inputs are `{ text }` (the
 *   request's `input`), a chat call's are the request body (`messages`, `tools`, `stream`…).
 * - `respond(model, inputs)` shapes the answer: `{ data: number[][] }` for embeddings (default:
 *   deterministic 1024-dim vectors), `{ response, usage, tool_calls? }` for chat (default `'ok'`),
 *   or a `ReadableStream` of OpenAI SSE bytes to drive streaming. A throw with a `status` becomes
 *   that HTTP status, so a test can stage an outage the adapter must classify.
 * - `toMarkdown()` (uploads) records `{ name, type, size }` in `conversions` and answers markdown
 *   made of the blob's bytes decoded as text — so a fixture "PDF" is just text typed
 *   `application/pdf`; override `convert` for `format: 'error'` or a thrown outage. The test env's
 *   converter declares every `convert` type in `DOCUMENT_UPLOAD_TYPES`.
 */
export class RecordingAi {
  readonly token = `fake-models-${crypto.randomUUID()}`
  readonly runs: RecordedAiRun[] = []
  readonly conversions: RecordedConversion[] = []
  constructor() {
    FAKE_MODELS.set(this.token, this)
  }
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
  respond: (model: string, inputs: Record<string, unknown>) => unknown = (_model, inputs) => {
    if (Array.isArray(inputs.messages)) {
      return { response: 'ok', usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }
    }
    const text = inputs.text
    const texts = Array.isArray(text) ? text : [String(text ?? '')]
    return { data: texts.map(t => deterministicEmbedding(String(t))) }
  }
  /** The platform vars that point a test env at this endpoint. */
  vars(): Record<string, string> {
    return {
      AI_BASE_URL: FAKE_MODELS_BASE_URL,
      AI_API_KEY: this.token,
      AI_MODEL: FAKE_CHAT_MODEL,
      EMBEDDINGS_BASE_URL: FAKE_MODELS_BASE_URL,
      EMBEDDINGS_API_KEY: this.token,
      EMBEDDINGS_MODEL: FAKE_EMBEDDINGS_MODEL,
    }
  }
  async handle(path: string, body: Record<string, unknown>): Promise<Response> {
    const model = String(body.model ?? '')
    const embeddings = path.endsWith('/embeddings')
    const inputs = embeddings ? { text: body.input } : body
    this.runs.push({ model, inputs })
    let out: unknown
    try {
      out = await this.respond(model, inputs)
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500
      const message = err instanceof Error ? err.message : String(err)
      return Response.json({ error: { message } }, { status })
    }
    if (out instanceof ReadableStream) {
      return new Response(out, { headers: { 'content-type': 'text/event-stream' } })
    }
    if (embeddings) {
      const data = (out as { data?: number[][] }).data ?? []
      return Response.json({ data: data.map((embedding, index) => ({ index, embedding })) })
    }
    const answer = out as {
      response?: string
      usage?: Record<string, number>
      tool_calls?: unknown[]
    }
    const message = {
      role: 'assistant',
      content: answer.response ?? '',
      tool_calls: answer.tool_calls,
    }
    const finish = answer.tool_calls?.length ? 'tool_calls' : 'stop'
    if (!body.stream) {
      return Response.json({
        model,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: answer.usage,
      })
    }
    const frames = [
      { choices: [{ index: 0, delta: { role: 'assistant', content: message.content } }] },
      ...(answer.tool_calls?.length
        ? [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: answer.tool_calls.map((call, index) => ({
                      index,
                      ...(call as object),
                    })),
                  },
                },
              ],
            },
          ]
        : []),
      { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: answer.usage },
    ]
    const sse = `${frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
  }
  clear(): void {
    this.runs.length = 0
    this.conversions.length = 0
  }
}

/** Route `fetch` to `FAKE_MODELS_BASE_URL` in-process; everything else goes to the real `fetch`. */
function installFakeModelsFetch(): void {
  const marker = Symbol.for('rocketpod.fakeModelsFetch')
  const g = globalThis as typeof globalThis & { [k: symbol]: boolean }
  if (g[marker]) return
  g[marker] = true
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (!request.url.startsWith(FAKE_MODELS_BASE_URL)) return realFetch(input, init)
    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const fake = FAKE_MODELS.get(token)
    if (!fake) return Response.json({ error: { message: 'unknown fake token' } }, { status: 401 })
    const path = new URL(request.url).pathname
    return fake.handle(path, (await request.json()) as Record<string, unknown>)
  }) as typeof fetch
}
installFakeModelsFetch()

/** Every `convert`-kind upload type — what the test converter declares. */
const TEST_CONVERTER_TYPES: ReadonlySet<string> = new Set(
  Object.entries(DOCUMENT_UPLOAD_TYPES)
    .filter(([, t]) => t.kind === 'convert')
    .map(([type]) => type)
)

// ---- Run engine -----------------------------------------------------------------------------

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

/** What `instance.sendEvent()` was called with — the resume nudge of a parked run. */
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
 * fakes' inspection surface (recorded messages, stored objects, the key/value store) through
 * `stubs(env)`.
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
  'AI_API_KEY',
  'AI_BASE_URL',
  'AI_MODEL',
  'EMBEDDINGS_API_KEY',
  'EMBEDDINGS_BASE_URL',
  'EMBEDDINGS_MODEL',
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
  'converter',
  'guide',
] as const satisfies readonly (keyof Platform)[]

/** The converter backed by a fake model endpoint's `toMarkdown`, or null. */
function converterOf(ai: RecordingAi | null | undefined): DocumentConverter | null {
  if (!ai) return null
  return {
    contentTypes: TEST_CONVERTER_TYPES,
    convert: document => ai.toMarkdown(document) as ReturnType<DocumentConverter['convert']>,
  }
}

/**
 * A fresh env per call (no state is shared between calls). Vars come from process.env with
 * .env.test-compatible defaults; pass `overrides` to change any of them, or to replace or null a
 * `Platform` member.
 */
export function createTestEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  const databaseUrl =
    process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5533/rocketpod_test'
  const kv = new MemoryKV()
  const fakes: TestStubs = {
    kv,
    queue: new RecordingQueue(),
    files: new MemoryStorage(),
    hub: new RecordingRealtime(),
    ai: new RecordingAi(),
    workflow: new RecordingWorkflow(),
  }
  if ('ai' in overrides) fakes.ai = (overrides.ai ?? undefined) as RecordingAi | undefined
  const ai = fakes.ai
  const base: Platform = {
    jobs: fakes.queue as unknown as JobsQueue,
    storage: fakes.files,
    realtime: fakes.hub,
    runs: fakes.workflow as unknown as RunEngine,
    rateLimiter: createMemoryRateLimiter(kv),
    locks: createMemoryLocks(kv),
    converter: converterOf(ai),
    // No Guide by default: a test that reads it hands in a source (`tests/api/guide.test.ts`).
    guide: null,
  }
  const members: Record<string, unknown> = { ...base }
  for (const key of PLATFORM_KEYS) if (key in overrides) members[key] = overrides[key]
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
  // The platform model keys point at this env's fake endpoint (overrides below still win); with
  // `ai: null` they are left to process.env, so an eval run can reach a real provider.
  if (ai) Object.assign(vars, ai.vars())
  vars.DATABASE_URL = databaseUrl

  const env: Record<string, unknown> = { ...vars }
  for (const [key, value] of Object.entries(overrides)) {
    if (key !== 'ai' && !(PLATFORM_KEYS as readonly string[]).includes(key)) env[key] = value
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
