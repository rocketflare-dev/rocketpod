// @vitest-isolate
// Installs the process-wide Postgres pool (`installProcessPool`), which a shared registry would
// leak into every later file in the fork.
/**
 * The Node entry (M2, `src/node/server.ts`) booted in-process on a free port against the test
 * database: the probes, the SPA's files and its fallback, the app behind them, and a graceful stop
 * that waits for post-response work.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseServerMode, type RunningServer, startServer } from '@/node/server'
import { testDatabaseUrl } from '../helpers/db'

let uiDir: string
let server: RunningServer
let base: string

function testEnv(): Record<string, string | undefined> {
  return { ...process.env, DATABASE_URL: testDatabaseUrl() }
}

beforeAll(async () => {
  uiDir = mkdtempSync(path.join(tmpdir(), 'rocketpod-ui-'))
  writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>shell</title>')
  mkdirSync(path.join(uiDir, 'assets'))
  writeFileSync(path.join(uiDir, 'assets', 'app-abc123.js'), 'console.log("app")')
  server = await startServer({ env: testEnv(), mode: 'web', port: 0, uiDir, log: () => {} })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(async () => {
  await server?.stop()
  rmSync(uiDir, { recursive: true, force: true })
})

describe('the Node entry, mode web', () => {
  it('/healthz is liveness: up, no database involved', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('/readyz pings the process pool', async () => {
    const res = await fetch(`${base}/readyz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ready' })
  })

  it('serves the app: /api/health and /api/ready through the request path', async () => {
    const health = await fetch(`${base}/api/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok' })
    const ready = await fetch(`${base}/api/ready`)
    expect(await ready.json()).toEqual({ status: 'ready' })
  })

  it('an unknown API path is a JSON 404, never the app shell', async () => {
    const res = await fetch(`${base}/api/nope`, { headers: { accept: 'text/html' } })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ statusCode: 404, code: 'not_found' })
  })

  it('serves a built file straight from disk', async () => {
    const res = await fetch(`${base}/assets/app-abc123.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
    expect(await res.text()).toBe('console.log("app")')
  })

  it('answers a client-side route with the shell (SPA fallback), uncached', async () => {
    for (const route of ['/', '/settings/members', '/t/acme/agents/42']) {
      const res = await fetch(`${base}${route}`)
      expect(res.status, route).toBe(200)
      expect(res.headers.get('content-type'), route).toMatch(/text\/html/)
      expect(await res.text(), route).toContain('<title>shell</title>')
    }
    const shell = await fetch(`${base}/settings`)
    expect(shell.headers.get('cache-control')).toBe('no-cache')
  })

  it('a non-GET to a non-API path is a 404, not the shell', async () => {
    const res = await fetch(`${base}/settings`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('the Node entry, shutdown', () => {
  it('stop() waits for deferred work, flips readiness, closes the listener and the pool', async () => {
    const own = await startServer({
      env: testEnv(),
      mode: 'all',
      port: 0,
      log: () => {},
      // The suite's server above holds the process pool; this one may not install a second.
    }).catch((error: unknown) => error)
    // One process, one pool: a second server in the same process is refused, by design.
    expect(String(own)).toMatch(/already installed/)

    let finished = false
    server.defer.add(
      new Promise<void>(resolve =>
        setTimeout(() => {
          finished = true
          resolve()
        }, 150)
      )
    )
    const port = server.port
    await server.stop()
    expect(finished).toBe(true)
    expect(server.defer.size).toBe(0)
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow()

    // The pool is gone with it, so a fresh server may install its own — worker mode, no port.
    const worker = await startServer({ env: testEnv(), mode: 'worker', log: () => {} })
    expect(worker.port).toBe(0)
    await worker.stop()

    // With a probe port (what `node dist/server.js worker` passes, M7): probes only, no app.
    const probed = await startServer({
      env: testEnv(),
      mode: 'worker',
      probePort: 0,
      hostname: '127.0.0.1',
      log: () => {},
    })
    expect(probed.port).toBeGreaterThan(0)
    expect((await fetch(`http://127.0.0.1:${probed.port}/healthz`)).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${probed.port}/readyz`)).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${probed.port}/api/health`)).status).toBe(404)
    await probed.stop()
  })

  it('parseServerMode: all by default, the three modes, anything else refused', () => {
    expect(parseServerMode(undefined)).toBe('all')
    expect(parseServerMode(' web ')).toBe('web')
    expect(parseServerMode('worker')).toBe('worker')
    expect(() => parseServerMode('cron')).toThrow(/web, worker, all/)
  })
})
