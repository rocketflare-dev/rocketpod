/**
 * The server entry: the Hono app (`src/api/index.ts`) on `@hono/node-server`, with the
 * `Platform`, one Postgres pool per process and tracked post-response work. One image, three
 * modes (`SERVER_MODE`, or the first argument):
 *
 * - `web`: the API, `/ws` (`realtime.ts`: sockets + the LISTEN connection), the SPA's static
 *   files (`assets.ts`), `/healthz` (liveness) and `/readyz`
 *   (a `SELECT 1` on the pool; 503 while draining, so a load balancer stops sending traffic).
 * - `worker`: the jobs consumer and the cron schedules (`jobs.ts`, pg-boss) and the agent
 *   runs (`runs.ts`, OpenWorkflow).
 * - `all`: both in one process — local dev, and small installs.
 *
 * This file and `src/config.ts`'s `loadConfig` are where configuration comes from: `process.env`
 * is read HERE and nowhere else under `src/` (`tests/config/platform-seam.test.ts`), and nothing
 * outside `src/node/` imports this directory.
 *
 * Shutdown (SIGTERM/SIGINT): readiness flips to 503, the listener stops accepting, in-flight
 * requests finish, pg-boss and OpenWorkflow stop fetching and let in-flight work finish, the
 * deferred-work set drains, then the pool is closed.
 */
import type { IncomingMessage } from 'node:http'
import { STATUS_CODES } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
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
import { describeGuideLoad, loadGuideFromDisk } from './guide-content'
import { createNodeJobs, type NodeJobs } from './jobs'
import { createNodePlatform } from './platform'
import {
  createNodeRealtime,
  type NodeRealtime,
  UPGRADE_ACCEPTED_HEADER,
  type UpgradeSlot,
  upgradeScope,
} from './realtime'
import { createNodeRuns, type NodeRuns } from './runs'

export type ServerMode = 'web' | 'worker' | 'all'
export const SERVER_MODES: readonly ServerMode[] = ['web', 'worker', 'all']

export interface StartServerOptions {
  /** The raw environment — `process.env` from `main()`, a plain object in tests. */
  env: Record<string, string | undefined>
  mode?: ServerMode
  /** 0 picks a free port (tests). */
  port?: number
  hostname?: string
  /**
   * `worker` mode only: serve `/healthz` + `/readyz` — and nothing else — on this port, so a
   * container healthcheck or a Kubernetes probe can watch a worker. Unset: a worker binds no port.
   */
  probePort?: number
  /** The UI build (`vite build` → `dist/ui`). */
  uiDir?: string
  /** Replace the Node platform (tests). */
  platform?: Platform
  /**
   * Load the Guide into `guide_chunks` at boot (default: in `web`/`all` mode when the platform is
   * the Node one). Tests pass `false`: the table is global, and `tests/api/guide.test.ts` owns it.
   */
  loadGuide?: boolean
  log?: (message: string) => void
  /** How long shutdown waits for deferred work (and in-flight jobs) before giving up. */
  drainTimeoutMs?: number
  /** Replace the jobs runtime (tests). */
  jobs?: NodeJobs
  /** Replace the durable-runs runtime (tests). */
  runs?: NodeRuns
  /** Replace the realtime hub (tests). */
  realtime?: NodeRealtime
}

export interface RunningServer {
  mode: ServerMode
  /** The bound port (`web`/`all`, or a worker's `probePort`); 0 for a worker without one. */
  port: number
  config: AppConfig
  defer: DeferSet
  realtime: NodeRealtime
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
  const jobs =
    options.jobs ?? createNodeJobs({ config, log }, mode === 'web' ? 'producer' : 'worker')
  const runs = options.runs ?? createNodeRuns({ config, log })
  const realtime =
    options.realtime ?? createNodeRealtime({ config, log, sockets: mode !== 'worker' })
  const platform =
    options.platform ??
    createNodePlatform(config, { jobs: jobs.queue, runs: runs.engine, realtime: realtime.hub })
  const defer = createDeferSet(err => log(`deferred work failed: ${String(err)}`))
  const pool: DatabaseHandle = installProcessPool(config, {
    max: config.DATABASE_POOL_MAX,
    prepare: true,
  })
  let draining = false
  // The Guide's pages (and any committed vectors) into `guide_chunks` — idempotent and lock-guarded,
  // so every web process may do it; off the startup path (a slow database never delays the
  // listener), and tracked by the defer set so shutdown waits for it.
  if (mode !== 'worker' && (options.loadGuide ?? !options.platform)) {
    defer.add(
      loadGuideFromDisk(pool.db).then(
        result => log(describeGuideLoad(result)),
        err => log(`guide: load failed: ${String(err)}`)
      )
    )
  }

  // ONE env object for the life of the process: `loadConfig` memoises per env object, so every
  // request reuses the parse. Per-request facts ride on the execution context instead.
  const assets = options.uiDir ? createNodeAssets(options.uiDir) : undefined
  const env: AppBindings = { ...options.env, PLATFORM: platform, ASSETS: assets?.binding }

  let server: ReturnType<typeof serve> | undefined
  let port = 0
  const serveApp = mode !== 'worker'
  if (serveApp || options.probePort !== undefined) {
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
    if (serveApp) {
      if (assets) outer.use('*', assets.files)
      outer.all('*', c =>
        app.fetch(c.req.raw, env, {
          waitUntil: (promise: Promise<unknown>) => defer.add(promise),
          passThroughOnException: () => {},
          props: { clientAddress: c.env.incoming?.socket?.remoteAddress ?? '' },
        })
      )
    }
    const listenPort = serveApp ? (options.port ?? 3001) : options.probePort
    server = await new Promise<ReturnType<typeof serve>>(resolve => {
      const s = serve({ fetch: outer.fetch, port: listenPort, hostname: options.hostname }, () =>
        resolve(s)
      )
    })
    port = (server.address() as AddressInfo).port
  }
  if (server && !serveApp) log(`worker: probes on :${port}`)
  if (server && serveApp) {
    // `/ws`: Node delivers an upgrade outside the fetch handler, so the app runs here inside
    // an `upgradeScope` slot — the route authenticates and `realtime.hub.accept()` fills the slot —
    // and the handshake completes only if it did. Anything else is written back as plain HTTP.
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', () => socket.destroy())
      if (draining) {
        writeHttpResponse(socket, new Response(null, { status: 503 }))
        return
      }
      const slot: UpgradeSlot = { member: null }
      const request = toRequest(req)
      void upgradeScope
        .run(slot, async () =>
          app.fetch(request, env, {
            waitUntil: (promise: Promise<unknown>) => defer.add(promise),
            passThroughOnException: () => {},
            props: { clientAddress: req.socket.remoteAddress ?? '' },
          })
        )
        .then(
          async res => {
            if (slot.member && res.ok && res.headers.get(UPGRADE_ACCEPTED_HEADER)) {
              realtime.handleUpgrade(req, socket, head, slot.member)
            } else {
              await writeHttpResponse(socket, res)
            }
          },
          err => {
            log(`ws: upgrade failed: ${String(err)}`)
            void writeHttpResponse(socket, new Response(null, { status: 500 }))
          }
        )
    })
    log(`web: listening on :${port} (${config.APP_ENV})`)
  }

  if (mode !== 'web') {
    await jobs.startWorker(env)
    await runs.startWorker(env, platform)
  }

  let stopped: Promise<void> | undefined
  const stop = () => {
    stopped ??= (async () => {
      draining = true
      log('shutdown: draining')
      // Sockets first: they hold the HTTP server open, and 1001 sends clients to another pod.
      await realtime.stop()
      if (server) {
        const s = server
        await new Promise<void>(resolve => s.close(() => resolve()))
      }
      await Promise.all([
        jobs.stop(options.drainTimeoutMs ?? 30_000),
        runs.stop(options.drainTimeoutMs ?? 30_000),
      ])
      const drained = await defer.drain(options.drainTimeoutMs ?? 10_000)
      if (!drained) log(`shutdown: ${defer.size} deferred task(s) still running — giving up`)
      await pool.close()
      log('shutdown: done')
    })()
    return stopped
  }

  return { mode, port, config, defer, realtime, stop }
}

/** The upgrade request as a fetch `Request` (GET, no body) for the app. */
function toRequest(req: IncomingMessage): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v)
  }
  const host = req.headers.host ?? 'localhost'
  return new Request(`http://${host}${req.url ?? '/'}`, { method: 'GET', headers })
}

/** Answer an upgrade the app refused (401/403/426…) as plain HTTP/1.1, then close the socket. */
async function writeHttpResponse(socket: Duplex, res: Response): Promise<void> {
  const body = Buffer.from(await res.arrayBuffer())
  const lines = [`HTTP/1.1 ${res.status} ${STATUS_CODES[res.status] ?? ''}`]
  res.headers.forEach((value, name) => {
    if (name !== 'content-length' && name !== 'transfer-encoding') lines.push(`${name}: ${value}`)
  })
  lines.push(`content-length: ${body.length}`, 'connection: close', '', '')
  socket.end(Buffer.concat([Buffer.from(lines.join('\r\n')), body]))
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
    // A worker answers its probes on the same port the web process serves on.
    probePort: env.PORT ? Number(env.PORT) : 3001,
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
