/**
 * `waitUntil` on Node (M2): post-response work — the request's DB-handle close, the tracer flush,
 * activity writes, realtime nudges — runs after the response is sent, and is TRACKED, so shutdown
 * can wait for it instead of cutting it off. The Worker's runtime keeps an isolate alive for the
 * same promises; this set is what stands in for that.
 *
 * A rejected promise is logged, never rethrown: post-response work has no caller left to tell.
 */
export interface DeferSet {
  /** Track `promise` until it settles. */
  add(promise: Promise<unknown>): void
  /** Promises still pending. */
  readonly size: number
  /**
   * Wait for every tracked promise — including ones added while draining — or until `timeoutMs`.
   * Resolves `true` when the set emptied, `false` on timeout.
   */
  drain(timeoutMs?: number): Promise<boolean>
}

export function createDeferSet(
  onError: (err: unknown) => void = err => console.error('deferred work failed', err)
): DeferSet {
  const pending = new Set<Promise<unknown>>()
  return {
    add(promise) {
      const tracked = promise.then(
        () => {},
        err => onError(err)
      )
      pending.add(tracked)
      void tracked.finally(() => pending.delete(tracked))
    },
    get size() {
      return pending.size
    },
    async drain(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs
      while (pending.size > 0) {
        const left = deadline - Date.now()
        if (left <= 0) return false
        let timer: ReturnType<typeof setTimeout> | undefined
        const timedOut = await Promise.race([
          Promise.allSettled([...pending]).then(() => false),
          new Promise<boolean>(resolve => {
            timer = setTimeout(() => resolve(true), left)
          }),
        ])
        clearTimeout(timer)
        if (timedOut) return pending.size === 0
      }
      return true
    },
  }
}
