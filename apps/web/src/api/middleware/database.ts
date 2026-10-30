/**
 * Per-request database handle: `openDatabase(config)`, `c.set('db')`,
 * and the handle is closed in `executionCtx.waitUntil` AFTER the response. On Node the handle is a
 * view of the process pool and closing it is a no-op (`installProcessPool`); without one (tests,
 * scripts) it is a client of its own, so nothing is kept across requests. `finally`, not post-`next()`: a throwing handler
 * must not leak a socket.
 *
 * Test mechanism (no hooks in src/): tests call `app.request(path, init, env, ctx)` with a real
 * `ExecutionContext` mock (tests/mocks/bindings.ts) whose `waitUntil` collects promises, and
 * `tests/helpers/request.ts` awaits them — the production close path runs verbatim. If no
 * ExecutionContext is available (Hono's `executionCtx` getter throws) the close is awaited inline.
 *
 * Runs on static-asset paths too, deliberately unconditional: postgres.js connects on the first query,
 * so a request that never queries costs nothing and `close()` is a no-op.
 */
import { createMiddleware } from 'hono/factory'
import { openDatabase } from '../../db/client'
import type { WaitUntil } from '../../platform/types'
import type { AppContext, AppEnv } from '../types'

/** `ctx.waitUntil(p)` when we have an ExecutionContext, otherwise await it. */
export async function deferOrAwait(c: AppContext, work: () => Promise<unknown>): Promise<void> {
  let ctx: WaitUntil | undefined
  try {
    ctx = c.executionCtx
  } catch {
    ctx = undefined
  }
  if (ctx) ctx.waitUntil(work())
  else await work()
}

export const databaseMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const cfg = c.get('config')
  const handle = openDatabase(cfg)
  c.set('db', handle.db)
  c.set('dbClose', handle.close)
  try {
    await next()
  } finally {
    await deferOrAwait(c, handle.close)
  }
})
