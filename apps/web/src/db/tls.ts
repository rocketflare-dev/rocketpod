/**
 * `DATABASE_SSL` — TLS for EVERY Postgres connection the process opens (docs/DEPLOY.md, "TLS to
 * Postgres"): the postgres.js pool (`client.ts`), the realtime publisher and LISTEN connection,
 * pg-boss (node-postgres), OpenWorkflow, and the migrate one-shot's scripts. Each of them takes
 * its connection through `databaseConnection()`, so this file is the one place the rule lives.
 *
 * - unset: nothing changes — the URL's own `sslmode` (or the driver's default, no TLS) decides,
 *   exactly as before `DATABASE_SSL` existed;
 * - `off`: no TLS;
 * - `require`: TLS, the server's certificate NOT verified (encryption against a passive listener);
 * - `verify-full`: TLS, the certificate verified against Node's trust store plus
 *   `NODE_EXTRA_CA_CERTS` (the image carries the AWS RDS bundle there), and its hostname checked.
 *
 * **One place decides.** With `DATABASE_SSL` set, a connection URL that also carries a TLS
 * parameter (`sslmode`, `ssl`, `sslrootcert`, `sslcert`, `sslkey`, `uselibpqcompat`) is refused —
 * by `loadConfig` and again here. The two drivers read those parameters differently (node-postgres
 * lets the URL override its `ssl` option and reads `sslmode=require` as `verify-full`; postgres.js
 * lets the option override the URL), so a URL that disagreed with `DATABASE_SSL` would mean
 * different TLS on different connections of one process. Client certificates (`sslcert`/`sslkey`)
 * keep working with `DATABASE_SSL` unset, where the URL alone decides.
 *
 * Driver-neutral (both drivers take the same `{ rejectUnauthorized }` / `false`, and both set the
 * SNI servername and check the hostname themselves) and free of Node APIs, so `config.ts` can use it.
 */

export const DATABASE_SSL_MODES = ['off', 'require', 'verify-full'] as const
export type DatabaseSslMode = (typeof DATABASE_SSL_MODES)[number]

/** URL query parameters that change TLS in postgres.js or node-postgres. */
export const URL_TLS_PARAMS = [
  'sslmode',
  'ssl',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'uselibpqcompat',
] as const

/** What a driver's `ssl` option is set to: `false` (no TLS) or TLS with or without verification. */
export type DatabaseTls = false | { rejectUnauthorized: boolean }

export interface DatabaseSslEnv {
  DATABASE_SSL?: string
}

/** One connection: the URL to dial and, when `DATABASE_SSL` is set, the driver's `ssl` option. */
export interface DatabaseConnection {
  url: string
  /** Absent with `DATABASE_SSL` unset: pass no `ssl` option at all (today's behaviour). */
  ssl?: DatabaseTls
}

/** `DATABASE_SSL`, or `undefined` when unset/blank. Throws on any other value. */
export function databaseSslMode(env: DatabaseSslEnv): DatabaseSslMode | undefined {
  const value = env.DATABASE_SSL?.trim()
  if (!value) return undefined
  if ((DATABASE_SSL_MODES as readonly string[]).includes(value)) return value as DatabaseSslMode
  throw new Error(`DATABASE_SSL must be off, require or verify-full, got "${value}"`)
}

/** The TLS parameters a connection URL carries (`[]` for none, or an unparseable URL). */
export function urlTlsParams(url: string): string[] {
  let params: URLSearchParams
  try {
    params = new URL(url).searchParams
  } catch {
    return []
  }
  return URL_TLS_PARAMS.filter(name => params.has(name))
}

/**
 * Why `url` cannot be used with `DATABASE_SSL`, or `undefined` when it can. `label` names the var
 * (`DATABASE_URL`, `DATABASE_LISTEN_URL`…) in the message.
 */
export function databaseSslConflict(url: string, env: DatabaseSslEnv, label: string) {
  const mode = databaseSslMode(env)
  if (!mode) return undefined
  const params = urlTlsParams(url)
  if (params.length === 0) return undefined
  return (
    `${label} carries ${params.join(', ')} while DATABASE_SSL=${mode} is set — DATABASE_SSL decides ` +
    'TLS for every connection: remove them from the URL, or unset DATABASE_SSL and let the URL decide'
  )
}

/** The `ssl` option for a mode: `off` → `false`; `require` → unverified TLS; `verify-full` → verified. */
export function tlsFor(mode: DatabaseSslMode): DatabaseTls {
  if (mode === 'off') return false
  return { rejectUnauthorized: mode === 'verify-full' }
}

/**
 * THE function every Postgres connection goes through: `url` plus the `ssl` option `DATABASE_SSL`
 * asks for. Throws on a URL that contradicts it (see the file header).
 */
export function databaseConnection(url: string, env: DatabaseSslEnv): DatabaseConnection {
  const mode = databaseSslMode(env)
  if (!mode) return { url }
  const conflict = databaseSslConflict(url, env, 'the database URL')
  if (conflict) throw new Error(conflict)
  return { url, ssl: tlsFor(mode) }
}

/** `{ ssl }` to spread into a driver's options — `{}` when `DATABASE_SSL` is unset. */
export function sslOption(connection: DatabaseConnection): { ssl?: DatabaseTls } {
  return connection.ssl === undefined ? {} : { ssl: connection.ssl }
}

/**
 * The URL form, for a library that takes only a URL (OpenWorkflow's migrator): `sslmode`
 * set to what `DATABASE_SSL` asks for. postgres.js reads `disable` / `require` (no verification) /
 * `verify-full` exactly like the `ssl` option. Never hand this form to node-postgres, which reads
 * `sslmode=require` as `verify-full`.
 */
export function urlWithDatabaseSsl(url: string, env: DatabaseSslEnv): string {
  const { ssl } = databaseConnection(url, env)
  if (ssl === undefined) return url
  const parsed = new URL(url)
  parsed.searchParams.set(
    'sslmode',
    ssl === false ? 'disable' : ssl.rejectUnauthorized ? 'verify-full' : 'require'
  )
  return parsed.toString()
}
