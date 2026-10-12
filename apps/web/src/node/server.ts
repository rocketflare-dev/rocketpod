/**
 * The Node entry (M2, `docs/ROADMAP.md`): the same Hono app the Worker serves, on
 * `@hono/node-server`, with a Node `Platform`, one Postgres pool per process and real
 * post-response work. One image, three modes (`SERVER_MODE`, or the first argument):
 *
 * - `web`: the API, the SPA's static files (`assets.ts`), `/healthz` (liveness) and `/readyz`
 *   (a `SELECT 1` on the pool; 503 while draining, so a load balancer stops sending traffic).
 * - `worker`: the background loop (`worker-loop.ts`; pg-boss from M3).
 * - `all`: both in one process — local dev, and small installs.
 *
 * This file and `src/config.ts`'s `loadConfig` are where configuration comes from: `process.env`
 * is read HERE and nowhere else under `src/` (`tests/config/platform-seam.test.ts`). The Worker
 * entry (`src/worker.ts`) never imports this directory.
 *
 * Shutdown (SIGTERM/SIGINT): readiness flips to 503, the listener stops accepting, in-flight
 * requests finish, the worker loop stops, the deferred-work set drains, then the pool is closed.
 */
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { app } from '../api/index'
import type { AppBindings } from '../api/types'
import { type AppConfig, loadConfig } from '../config'
import { type DatabaseHandle, installProcessPool } from '../db/client'
import type { Platform } from '../platform/types'
import { createNodeAssets } from './assets'
import { createDeferSet, type DeferSet } from './defer'
import { createNodePlatform } from './platform'
import { startWorkerLoop, type WorkerLoop } from './worker-loop'

export type ServerMode = 'web' | 'worker' | 'all'
export const SERVER_MODES: readonly ServerMode[] = ['web', 'worker', 'all']

export interface StartServerOptions {
  /** The raw environment — `process.env` from `main()`, a plain object in tests. */
  env: Record<string, string | undefined>
  mode?: ServerMode
  /** 0 picks a free port (tests). */
  port?: number
  hostname?: string
  /** The UI build (`vite build` → `dist/ui`). */
  uiDir?: string
  /** Replace the Node platform (tests). */
  platform?: Platform
  log?: (message: string) => void
  /** How long shutdown waits for deferred work before giving up. */
  drainTimeoutMs?: number
}

export interface RunningServer {
  mode: ServerMode
  /** The bound port (`web`/`all`); 0 in `worker` mode. */
  port: number
  config: AppConfig
  defer: DeferSet
  /** Idempotent graceful stop (what SIGTERM runs). */
  stop(): Promise<void>
}

export function parseServerMode(value: string | undefined): ServerMode {
  const mode = (value ?? '').trim() || 'all'
  if ((SERVER_MODES as readonly string[]).includes(mode)) return mode as ServerMode
  throw new Error(`SERVER_MODE must be one of ${SERVER_MODES.join(', ')}, got "${mode}"`)
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const log = options.log ?? (message => console.log(message))
  const mode = options.mode ?? 'all'
  const config = loadConfig(options.env)
  const platform = options.platform ?? createNodePlatform(config)
  const defer = createDeferSet(err => log(`deferred work failed: ${String(err)}`))
  const pool: DatabaseHandle = installProcessPool(config, {
    max: config.DATABASE_POOL_MAX,
    prepare: true,
  })
  let draining = false

  // ONE env object for the life of the process: `loadConfig` memoises per env object, so every
  // request reuses the parse. Per-request facts ride on the execution context instead.
  const assets = options.uiDir ? createNodeAssets(options.uiDir) : undefined
  const env: AppBindings = { ...options.env, PLATFORM: platform, ASSETS: assets?.binding }

  let server: ReturnType<typeof serve> | undefined
  let port = 0
  if (mode !== 'worker') {
    const outer = new Hono<{ Bindings: { incoming?: { socket?: { remoteAddress?: string } } } }>()
    outer.get('/healthz', c => c.json({ status: 'ok' }))
    outer.get('/readyz', async c => {
      if (draining) return c.json({ status: 'draining' }, 503)
      try {
        await pool.db.execute(sql`SELECT 1`)
        return c.json({ status: 'ready' })
      } catch {
        return c.json({ status: 'database_unavailable' }, 503)
      }
    })
    if (assets) outer.use('*', assets.files)
    outer.all('*', c =>
      app.fetch(c.req.raw, env, {
        waitUntil: (promise: Promise<unknown>) => defer.add(promise),
        passThroughOnException: () => {},
        props: { clientAddress: c.env.incoming?.socket?.remoteAddress ?? '' },
      })
    )
    server = await new Promise<ReturnType<typeof serve>>(resolve => {
      const s = serve(
        { fetch: outer.fetch, port: options.port ?? 3001, hostname: options.hostname },
        () => resolve(s)
      )
    })
    port = (server.address() as AddressInfo).port
    log(`web: listening on :${port} (${config.APP_ENV})`)
  }

  const worker: WorkerLoop | undefined = mode === 'web' ? undefined : startWorkerLoop({ log })

  let stopped: Promise<void> | undefined
  const stop = () => {
    stopped ??= (async () => {
      draining = true
      log('shutdown: draining')
      if (server) {
        const s = server
        await new Promise<void>(resolve => s.close(() => resolve()))
      }
      await worker?.stop()
      const drained = await defer.drain(options.drainTimeoutMs ?? 10_000)
      if (!drained) log(`shutdown: ${defer.size} deferred task(s) still running — giving up`)
      await pool.close()
      log('shutdown: done')
    })()
    return stopped
  }

  return { mode, port, config, defer, stop }
}

/** `node dist/server.js [web|worker|all]` / `tsx src/node/server.ts`. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const env = process.env
  const mode = parseServerMode(argv[0] ?? env.SERVER_MODE)
  const running = await startServer({
    env,
    mode,
    port: env.PORT ? Number(env.PORT) : 3001,
    hostname: env.HOST || '0.0.0.0',
    uiDir: env.UI_DIST_DIR || 'dist/ui',
  })
  let signalled = false
  const onSignal = (signal: string) => {
    if (signalled) {
      console.log(`${signal} again — exiting now`)
      process.exit(1)
    }
    signalled = true
    console.log(`${signal} received`)
    void running.stop().then(
      () => process.exit(0),
      err => {
        console.error('shutdown failed', err)
        process.exit(1)
      }
    )
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGINT', () => onSignal('SIGINT'))
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
