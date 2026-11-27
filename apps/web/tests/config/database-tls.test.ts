// @vitest-isolate
// Opens real clients (postgres.js, pg-boss's node-postgres, OpenWorkflow) against in-process TCP
// servers, and installs the process pool, so it runs in a fork of its own.
/**
 * `DATABASE_SSL` (`src/db/tls.ts`): what each mode hands a driver, the rule against a URL that
 * carries its own TLS parameters, the `NODE_EXTRA_CA_CERTS` startup check — and, for EVERY factory
 * that opens a Postgres connection, that the mode actually reaches the wire. A stand-in server reads
 * the first message a client sends: an SSLRequest means the client asked for TLS (the server answers
 * `N`, "no TLS here", which a `require`/`verify-full` client must treat as fatal); a StartupMessage
 * means it did not. The test database has no TLS, so this is the cheapest honest observation.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig } from '@/config'
import { closeAllDatabases, getScriptDatabase, installProcessPool, openDatabase } from '@/db/client'
import { databaseConnection, databaseSslMode, urlWithDatabaseSsl } from '@/db/tls'
import { assertDatabaseTrust } from '@/node/database-tls'
import { createBoss, installJobsSchema } from '@/node/jobs-schema'
import { createNodeRealtime } from '@/node/realtime'
import { createNodeRuns } from '@/node/runs'
import { installRunsSchema } from '@/node/runs-schema'
import { openScriptSql } from '../../scripts/lib/sql'

const base = { APP_ENV: 'development', APP_URL: 'http://localhost:3001' }
const SSL_REQUEST_CODE = 80877103

/** A backend ErrorResponse: severity FATAL, SQLSTATE 28000 (invalid authorization). */
const FATAL = (() => {
  const fields = Buffer.from('SFATAL\0C28000\0Mfake server\0\0', 'binary')
  const header = Buffer.alloc(5)
  header.write('E', 0)
  header.writeInt32BE(fields.length + 4, 1)
  return Buffer.concat([header, fields])
})()

describe('databaseConnection — what each mode hands the driver', () => {
  const url = 'postgres://u:p@db.example.com:5432/app'

  it('unset passes no ssl option at all, so the URL (or the driver default) decides', () => {
    expect(databaseConnection(url, {})).toEqual({ url })
    expect(databaseConnection(`${url}?sslmode=require`, { DATABASE_SSL: ' ' })).toEqual({
      url: `${url}?sslmode=require`,
    })
  })

  it('off → no TLS; require → TLS unverified; verify-full → TLS verified', () => {
    expect(databaseConnection(url, { DATABASE_SSL: 'off' }).ssl).toBe(false)
    expect(databaseConnection(url, { DATABASE_SSL: 'require' }).ssl).toEqual({
      rejectUnauthorized: false,
    })
    expect(databaseConnection(url, { DATABASE_SSL: 'verify-full' }).ssl).toEqual({
      rejectUnauthorized: true,
    })
  })

  it('refuses a URL carrying its own TLS parameters while DATABASE_SSL is set', () => {
    for (const query of [
      'sslmode=disable',
      'ssl=true',
      'sslrootcert=/ca.pem',
      'uselibpqcompat=true',
    ]) {
      expect(() => databaseConnection(`${url}?${query}`, { DATABASE_SSL: 'verify-full' })).toThrow(
        /DATABASE_SSL decides TLS/
      )
    }
    // A parameter that is not about TLS is fine.
    expect(
      databaseConnection(`${url}?application_name=x`, { DATABASE_SSL: 'require' }).ssl
    ).toEqual({ rejectUnauthorized: false })
  })

  it('refuses an unknown mode', () => {
    expect(() => databaseSslMode({ DATABASE_SSL: 'prefer' })).toThrow(/off, require or verify-full/)
  })

  it('the URL form (OpenWorkflow migrate) carries the same mode as sslmode', () => {
    expect(urlWithDatabaseSsl(url, {})).toBe(url)
    const sslmode = (mode: string) =>
      new URL(urlWithDatabaseSsl(url, { DATABASE_SSL: mode })).searchParams.get('sslmode')
    expect(sslmode('off')).toBe('disable')
    expect(sslmode('require')).toBe('require')
    expect(sslmode('verify-full')).toBe('verify-full')
  })
})

describe('loadConfig — DATABASE_SSL', () => {
  it('refuses an unknown value', () => {
    expect(() => loadConfig({ ...base, DATABASE_SSL: 'on' })).toThrow(/DATABASE_SSL/)
  })

  it('refuses a database URL with its own sslmode while DATABASE_SSL is set, naming the var', () => {
    const tls = 'postgres://u:p@h/db?sslmode=require'
    for (const key of [
      'DATABASE_URL',
      'APP_DATABASE_URL',
      'PREVIEW_DATABASE_URL',
      'DATABASE_LISTEN_URL',
    ]) {
      expect(() => loadConfig({ ...base, DATABASE_SSL: 'require', [key]: tls })).toThrow(
        new RegExp(`${key}: ${key} carries sslmode`)
      )
    }
    // Unset, the URL alone decides — exactly as before DATABASE_SSL existed.
    expect(loadConfig({ ...base, DATABASE_URL: tls }).DATABASE_SSL).toBeUndefined()
  })
})

describe('assertDatabaseTrust — the NODE_EXTRA_CA_CERTS startup check', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rp-ca-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('stops verify-full on a bundle that is missing or holds no certificate, naming the file', () => {
    const missing = path.join(dir, 'missing.pem')
    expect(() =>
      assertDatabaseTrust({ DATABASE_SSL: 'verify-full', NODE_EXTRA_CA_CERTS: missing })
    ).toThrow(new RegExp(`${missing}.*cannot be read \\(ENOENT\\)`))
    const empty = path.join(dir, 'empty.pem')
    writeFileSync(empty, 'not a certificate\n')
    expect(() =>
      assertDatabaseTrust({ DATABASE_SSL: 'verify-full', NODE_EXTRA_CA_CERTS: empty })
    ).toThrow(/holds no PEM certificate/)
  })

  it('passes a PEM bundle, no bundle, and any mode that verifies nothing', () => {
    const pem = path.join(dir, 'ca.pem')
    writeFileSync(pem, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n')
    expect(() =>
      assertDatabaseTrust({ DATABASE_SSL: 'verify-full', NODE_EXTRA_CA_CERTS: pem })
    ).not.toThrow()
    expect(() => assertDatabaseTrust({ DATABASE_SSL: 'verify-full' })).not.toThrow()
    const missing = path.join(dir, 'missing.pem')
    expect(() =>
      assertDatabaseTrust({ DATABASE_SSL: 'require', NODE_EXTRA_CA_CERTS: missing })
    ).not.toThrow()
  })
})

// ---- Every connection factory, on the wire ------------------------------------------------------

interface FakePostgres {
  url: string
  /** The first message of each connection: an SSLRequest, or a plain StartupMessage. */
  seen: Array<'ssl' | 'plain'>
  close(): Promise<void>
}

async function fakePostgres(): Promise<FakePostgres> {
  const seen: Array<'ssl' | 'plain'> = []
  const sockets = new Set<Socket>()
  const server: Server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.once('data', (chunk: Buffer) => {
      const ssl = chunk.length >= 8 && chunk.readInt32BE(4) === SSL_REQUEST_CODE
      seen.push(ssl ? 'ssl' : 'plain')
      // `N` — no TLS here; a plain startup gets a FATAL error, so every client gives up at once
      // rather than reconnecting.
      socket.end(ssl ? 'N' : FATAL)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `postgres://u:p@127.0.0.1:${port}/app`,
    seen,
    close: () =>
      new Promise<void>(resolve => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

async function firstMessage(fake: FakePostgres): Promise<'ssl' | 'plain'> {
  const deadline = Date.now() + 5000
  while (fake.seen.length === 0) {
    if (Date.now() > deadline) throw new Error('the client never connected')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return fake.seen[0] as 'ssl' | 'plain'
}

const swallow = async (work: () => Promise<unknown>) => {
  try {
    await work()
  } catch {
    // The stand-in never completes a connection: every client fails, which is expected.
  }
}

const log = () => {}

/** Each factory: open a connection the way production does, against `url`. */
type FactoryEnv = { readonly [key: string]: string | undefined } & { DATABASE_URL: string }

const FACTORIES: Record<string, (env: FactoryEnv) => Promise<void>> = {
  'the per-request client (openDatabase)': async env => {
    const handle = openDatabase(env)
    await swallow(() => handle.db.execute(sql`select 1`))
    await handle.close()
  },
  'the process pool (installProcessPool)': async env => {
    const pool = installProcessPool(env, { max: 1 })
    await swallow(() => pool.db.execute(sql`select 1`))
    await pool.close()
  },
  'a script / test handle (getScriptDatabase)': async env => {
    const db = getScriptDatabase(env.DATABASE_URL, env, 1)
    await swallow(() => db.execute(sql`select 1`))
    await closeAllDatabases()
  },
  'the scripts and the migrate one-shot (openScriptSql)': async env => {
    const script = openScriptSql(env.DATABASE_URL, env)
    await swallow(() => script.query('select 1'))
    await script.end()
  },
  'pg-boss (createBoss)': async env => {
    const boss = createBoss(env, 'producer')
    boss.on('error', () => {})
    await swallow(() => boss.start())
    await swallow(() => boss.stop({ graceful: false, close: true }))
  },
  "pg-boss's schema install (installJobsSchema)": async env => {
    await swallow(() => installJobsSchema(env))
  },
  "OpenWorkflow's migrator (installRunsSchema)": async env => {
    await swallow(() => installRunsSchema(env))
  },
  "OpenWorkflow's pool (createNodeRuns)": async env => {
    const runs = createNodeRuns({ config: loadConfig({ ...base, ...env }), log })
    await swallow(() => runs.backend.getWorkflowRun({ workflowRunId: randomUUID() }))
    await swallow(() => runs.stop(0))
  },
  "realtime's publisher (createNodeRealtime)": async env => {
    const realtime = createNodeRealtime({
      config: loadConfig({ ...base, ...env }),
      log,
      sockets: false,
    })
    await swallow(() => realtime.hub.toTenant(randomUUID(), { type: 'x' } as never))
    await realtime.stop()
  },
}

describe('every connection factory honours DATABASE_SSL on the wire', () => {
  const cases: Array<[string | undefined, 'ssl' | 'plain']> = [
    [undefined, 'plain'],
    ['off', 'plain'],
    ['require', 'ssl'],
    ['verify-full', 'ssl'],
  ]
  for (const [name, open] of Object.entries(FACTORIES)) {
    for (const [mode, expected] of cases) {
      it(`${name}: DATABASE_SSL=${mode ?? '(unset)'} → ${expected === 'ssl' ? 'asks for TLS' : 'no TLS'}`, async () => {
        const fake = await fakePostgres()
        try {
          await open({ DATABASE_URL: fake.url, ...(mode ? { DATABASE_SSL: mode } : {}) })
          expect(await firstMessage(fake)).toBe(expected)
        } finally {
          await fake.close()
        }
      })
    }
  }

  // With an app login the runtime dials APP_DATABASE_URL, not DATABASE_URL (which points here at a
  // port nobody answers): DATABASE_SSL must reach that connection too.
  const RUNTIME = [
    'the per-request client (openDatabase)',
    'the process pool (installProcessPool)',
    'pg-boss (createBoss)',
    "OpenWorkflow's pool (createNodeRuns)",
    "realtime's publisher (createNodeRealtime)",
  ]
  for (const name of RUNTIME) {
    it(`${name} on the app login (APP_DATABASE_URL) asks for TLS`, async () => {
      const fake = await fakePostgres()
      const open = FACTORIES[name] as (env: FactoryEnv) => Promise<void>
      try {
        await open({
          DATABASE_URL: 'postgres://owner:p@127.0.0.1:1/unused',
          APP_DATABASE_URL: fake.url,
          DATABASE_SSL: 'require',
        })
        expect(await firstMessage(fake)).toBe('ssl')
      } finally {
        await fake.close()
      }
    })
  }

  it("realtime's LISTEN connection (DATABASE_LISTEN_URL) asks for TLS too", async () => {
    const main = await fakePostgres()
    const listen = await fakePostgres()
    const realtime = createNodeRealtime({
      config: loadConfig({
        ...base,
        DATABASE_URL: main.url,
        DATABASE_LISTEN_URL: listen.url,
        DATABASE_SSL: 'verify-full',
      }),
      log,
      sockets: true,
      reconnectMs: 60_000,
    })
    try {
      expect(await firstMessage(listen)).toBe('ssl')
    } finally {
      await realtime.stop()
      await Promise.all([main.close(), listen.close()])
    }
  })
})
