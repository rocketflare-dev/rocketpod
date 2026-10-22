/**
 * The platform seam (M1, `docs/DESIGN-SELFHOSTED.md` §4): every capability the app takes from its
 * runtime, as a neutral interface. Routes, services, queue handlers, cron tasks and the agent-run
 * body depend on THESE — never on a Cloudflare binding type. The entry point builds one `Platform`
 * (`src/node/platform.ts` and its siblings — the Node adapters in `src/node/`) and the app
 * reads it with `c.get('platform')`; background contexts are handed the same object.
 *
 * Every member is nullable: a missing capability is a configuration state the callers already
 * handle (503 `storage_not_configured`, a no-op nudge, no rate limit), not a crash.
 * `tests/config/platform-seam.test.ts` keeps Cloudflare types out of the tree.
 */
import type { JobEnvelope } from '@rocketpod/shared/jobs'
import type { RealtimeEvent } from '@rocketpod/shared/realtime'

// ---- Jobs -----------------------------------------------------------------------------------

export interface JobSendOptions {
  /** Deliver no earlier than this many seconds from now (0–43200). */
  delaySeconds?: number
}

/** One message of a batch send. */
export interface JobSendRequest {
  body: JobEnvelope
  delaySeconds?: number
}

/**
 * The producer. Return types are `unknown` so any transport (and a recording fake) satisfies it
 * structurally, whatever `send` resolves to.
 */
export interface JobsQueue {
  send(body: JobEnvelope, options?: JobSendOptions): Promise<unknown>
  sendBatch(messages: Iterable<JobSendRequest>, options?: JobSendOptions): Promise<unknown>
}

/** One delivered message, as the consumer sees it: at-least-once, acked or retried explicitly. */
export interface JobMessage<Body = unknown> {
  readonly id: string
  readonly body: Body
  /** 1 on the first delivery. */
  readonly attempts: number
  ack(): void
  retry(options?: { delaySeconds?: number }): void
}

/** A batch the consumer processes; `queue` is the queue's name in this environment. */
export interface JobBatch<Body = unknown> {
  readonly queue: string
  readonly messages: readonly JobMessage<Body>[]
  ackAll(): void
}

// ---- Storage --------------------------------------------------------------------------------

/** Bodies `put` accepts. Prefer a `Blob`/`ArrayBuffer`: a store may need a known length. */
export type StorageBody = ArrayBuffer | ArrayBufferView | Blob | string

export interface PutOptions {
  contentType: string
  /** Free-form key/value pairs stored with the object. */
  metadata?: Record<string, string>
}

export interface StoredObjectMeta {
  key: string
  size: number
  contentType: string
  /** Quoted, HTTP-ready — usable as an `ETag` header verbatim. */
  etag: string
  uploaded: Date
  metadata: Record<string, string>
}

/**
 * A byte range to read, as HTTP names it: `{ start, end }` is `bytes=start-end` (end INCLUSIVE),
 * `{ start }` is `bytes=start-` (to the end), `{ suffix: n }` is `bytes=-n` (the last n bytes).
 * An `end` past the object is clamped to its last byte and a suffix longer than the object reads
 * all of it — the store's answer is the truth, reported back as `StoredObject.range`.
 */
export type StorageRange = { start: number; end?: number } | { suffix: number }

export interface GetOptions {
  range?: StorageRange
}

/** The bytes a ranged `get` returned: `start`–`end` INCLUSIVE, of an object `total` bytes long. */
export interface StoredRange {
  start: number
  end: number
  total: number
}

export interface StoredObject extends StoredObjectMeta {
  /** The whole object, or only the range asked for. `size` is always the WHOLE object's. */
  body: ReadableStream<Uint8Array>
  /** Present exactly when the `get` asked for a range — `Content-Range` in object form. */
  range?: StoredRange
}

/**
 * A range that starts past the end of the object (or a `suffix` of 0, or any range of an empty
 * object) — HTTP's 416. `total` is the object's size, for the `Content-Range: bytes *\/total` a
 * route answers with, when the store reported it.
 */
export class StorageRangeNotSatisfiableError extends Error {
  readonly total: number | undefined
  constructor(key: string, total?: number) {
    super(`storage: range not satisfiable for ${key}`)
    this.name = 'StorageRangeNotSatisfiableError'
    this.total = total
  }
}

/** One page of a listing: the objects, and the cursor to resume from when there are more. */
export interface StorageListPage {
  objects: StoredObjectMeta[]
  /** `undefined` when this page is the last one. */
  cursor?: string
}

export interface StorageService {
  put(key: string, body: StorageBody, options: PutOptions): Promise<StoredObjectMeta>
  /**
   * A body of UNKNOWN length, uploaded in parts as it arrives (S3 multipart) — never held whole in
   * memory. Answers the same metadata `put` does; `size` is the number of bytes the stream gave.
   * A stream that errors aborts the upload: no object, and no orphaned parts.
   */
  putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: PutOptions
  ): Promise<StoredObjectMeta>
  /**
   * `null` when the key does not exist. The body is a one-shot stream. With `range`, only those
   * bytes, and `range` on the answer says which; a range past the end throws
   * `StorageRangeNotSatisfiableError`.
   */
  get(key: string, options?: GetOptions): Promise<StoredObject | null>
  head(key: string): Promise<StoredObjectMeta | null>
  /** Idempotent — deleting a missing key is not an error. */
  delete(key: string): Promise<void>
  /** Delete a batch in ONE call (at most 1 000 keys). */
  deleteMany(keys: readonly string[]): Promise<void>
  /**
   * ONE page of a prefix. The paged form is the primitive and `list` is the convenience over it:
   * a bulk delete must never hold every key of a large tenant in memory at once.
   */
  listPage(prefix: string, options?: { cursor?: string; limit?: number }): Promise<StorageListPage>
  /** Every object under a prefix, accumulated. Fine for a bounded prefix; `listPage` otherwise. */
  list(prefix: string): Promise<StoredObjectMeta[]>
}

// ---- Realtime -------------------------------------------------------------------------------

/** How many sockets one send reached. */
export interface BroadcastResult {
  delivered: number
}

/** Per-tenant fan-out to connected sockets. Best effort: the database is the truth. */
export interface Broadcaster {
  toTenant(tenantId: string, event: RealtimeEvent): Promise<BroadcastResult>
  toUser(tenantId: string, userId: string, event: RealtimeEvent): Promise<BroadcastResult>
  toUsers(tenantId: string, userIds: string[], event: RealtimeEvent): Promise<BroadcastResult>
  /**
   * Every socket SUBSCRIBED to `topic` (`@rocketpod/shared/realtime` § Topics) — the hub let it
   * subscribe only if `canSubscribeTopic` said so. A tenant topic reaches only sockets of the
   * tenant it names; a platform topic any subscribed socket.
   */
  toTopic(topic: string, event: RealtimeEvent): Promise<BroadcastResult>
}

/** The identity `/ws` hands the hub — the only caller of `accept`. */
export interface RealtimeMember {
  tenantId: string
  userId: string
  sessionId: string
  /** Gates `platform` topics only (`canSubscribeTopic`); nothing tenant-scoped reads it. */
  globalAdmin?: boolean
  /** The topic subjects this member's role may `read` in `tenantId` (`realtimeTopicSubjects`). */
  canRead?: readonly string[]
}

/** The socket side of realtime: accept an authenticated `/ws` upgrade for one tenant member. */
export interface RealtimeHub extends Broadcaster {
  /**
   * Hand the upgrade request over. The caller has ALREADY authenticated the user and checked the
   * membership; the hub trusts `tenantId`/`userId` and answers the 101 (or an error response).
   */
  accept(request: Request, member: RealtimeMember): Promise<Response>
}

// ---- Durable runs ---------------------------------------------------------------------------

/** A duration: milliseconds, or a `'<n> <unit>'` string (`'10 seconds'`, `'168 hours'`). */
export type Duration = number | `${number} ${DurationUnit}`
export type DurationUnit =
  | 'second'
  | 'seconds'
  | 'minute'
  | 'minutes'
  | 'hour'
  | 'hours'
  | 'day'
  | 'days'
  | 'week'
  | 'weeks'
  | 'month'
  | 'months'
  | 'year'
  | 'years'

/** A step's checkpointed result has to survive a JSON round trip. */
export type Checkpointable =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly Checkpointable[]
  | { readonly [key: string]: Checkpointable }

export interface StepOptions {
  retries?: {
    limit: number
    delay: Duration
    backoff?: 'constant' | 'linear' | 'exponential'
  }
  timeout?: Duration
}

/**
 * What a durable run's body is handed. A step NAME is its identity: a completed step replays its
 * recorded result instead of running again, so a name must be unique within one run.
 */
export interface Step {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>
  do<T>(name: string, options: StepOptions, fn: () => Promise<T>): Promise<T>
  /** Park until an event of `type` arrives; rejects when `timeout` passes first. */
  waitForEvent(name: string, options: WaitForEventOptions): Promise<unknown>
  /**
   * True for an error the ENGINE threw to steer the run — a park, a lease lost to another worker —
   * which a body's `try/catch` must rethrow untouched (`if (step.isControlFlow?.(err)) throw err`).
   * OpenWorkflow (Node) parks a run by throwing out of `waitForEvent`; Cloudflare never does, so
   * its adapter leaves this undefined.
   */
  isControlFlow?(err: unknown): boolean
}

export interface WaitForEventOptions {
  type: string
  timeout?: Duration
  /**
   * For an engine that does NOT buffer events (OpenWorkflow drops a signal nobody is waiting on):
   * asked once, checkpointed, before parking. `true` means the event's effect has already landed —
   * the wait returns without parking. An engine that buffers (Cloudflare) ignores it.
   */
  arrived?: () => Promise<boolean>
}

export interface RunStatus {
  status: string
  error?: { name: string; message: string }
}

/** A handle on one durable run instance. */
export interface RunInstance {
  readonly id: string
  status(): Promise<RunStatus>
  /** Kills the instance mid-step — the escape hatch behind a forced cancel. */
  terminate(): Promise<void>
  /** Wakes an instance parked on `step.waitForEvent`. */
  sendEvent(event: { type: string; payload?: unknown }): Promise<void>
}

/** Starts and addresses durable runs of one workflow (the agent run). */
export interface RunEngine<Params = unknown> {
  create(options: { id: string; params: Params }): Promise<{ id: string }>
  get(id: string): Promise<RunInstance>
}

// ---- Rate limits and locks ------------------------------------------------------------------

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

/** A sliding-window counter per key. */
export interface RateLimiter {
  check(key: string, options: { max: number; windowSeconds: number }): Promise<RateLimitDecision>
}

/**
 * Advisory mutual exclusion by key. `acquire` answers false when somebody else holds it; the TTL
 * is the crash safety net, `release` the normal path.
 */
export interface Locks {
  acquire(key: string, ttlSeconds: number): Promise<boolean>
  release(key: string): Promise<void>
}

// ---- AI -------------------------------------------------------------------------------------

/** One file handed to a converter. */
export interface MarkdownDocumentInput {
  name: string
  blob: Blob
}

/** What a converter answers for one file. */
export type MarkdownConversion =
  | { name: string; mimeType: string; format: 'markdown' | 'text'; tokens: number; data: string }
  | { name: string; mimeType: string; format: 'error'; error: string }

/**
 * PDF/Office → text, for `document.convert`. `contentTypes` is the contract the upload route
 * checks BEFORE storing anything: a `convert`-kind upload whose type is not in it is refused (415)
 * rather than accepted and failed later by the job.
 */
export interface DocumentConverter {
  readonly contentTypes: ReadonlySet<string>
  convert(document: MarkdownDocumentInput): Promise<MarkdownConversion>
}

// ---- The Guide's content --------------------------------------------------------------------

/** One file of the Guide's content: its POSIX path relative to the content dir, and its text. */
export interface GuideFile {
  path: string
  raw: string
}

/**
 * The Guide's static content (`apps/web/content/guide/`, shipped in the image beside the bundle).
 * Read-only. The parsing is `services/guide-content.ts` (pure); this member only reads bytes, so
 * routes never touch the filesystem.
 */
export interface GuideContentSource {
  /** Every `.md` file under the content dir (pages and notes — the caller filters). */
  markdownFiles(): Promise<GuideFile[]>
  /** `screenshots.yaml`, or null when there is none. */
  screenshotManifest(): Promise<string | null>
  /** One image under `images/` by bare filename, or null when there is no such image. */
  image(file: string): Promise<{ bytes: Uint8Array; contentType: string } | null>
}

// ---- Request lifetime -----------------------------------------------------------------------

/** Work that may outlive the response (`waitUntil`). Never awaited on the response path. */
export type Defer = (fn: () => Promise<unknown>) => void

/** The request's lifetime hook, when the runtime has one. */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void
}

// ---- The bundle -----------------------------------------------------------------------------

export interface Platform {
  /** The background-job producer (pg-boss). */
  readonly jobs: JobsQueue | null
  /** Object storage for uploads (S3-compatible). */
  readonly storage: StorageService | null
  /** Socket fan-out and the `/ws` upgrade (LISTEN/NOTIFY). */
  readonly realtime: RealtimeHub | null
  /** Durable agent runs (OpenWorkflow). */
  readonly runs: RunEngine | null
  /** Per-IP throttling; absent = no limit. */
  readonly rateLimiter: RateLimiter | null
  /** Per-operation mutex; absent = the operation simply runs. */
  readonly locks: Locks | null
  /** Document → markdown; absent = only text-like uploads are indexable. */
  readonly converter: DocumentConverter | null
  /** The Guide's static content; absent = the Guide is empty. */
  readonly guide: GuideContentSource | null
}

/** A platform with nothing in it — the state a bare test or a script starts from. */
export const EMPTY_PLATFORM: Platform = Object.freeze({
  jobs: null,
  storage: null,
  realtime: null,
  runs: null,
  rateLimiter: null,
  locks: null,
  converter: null,
  guide: null,
})
