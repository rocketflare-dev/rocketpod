/**
 * The startup check behind `DATABASE_SSL=verify-full` (`src/db/tls.ts`, docs/DEPLOY.md "TLS to
 * Postgres"). Node reads `NODE_EXTRA_CA_CERTS` once, as the process starts, and only WARNS when the
 * file is missing or unreadable — every connection would then fail its certificate check with an
 * error that names no file. So when the variable names a bundle, it must be a readable PEM file or
 * the process stops here, naming it. Unset is allowed: the server's CA may be one Node already
 * trusts. The server (`server.ts` `main`) and the migrate one-shot (`scripts/migrate-all.ts`) run it.
 */
import { readFileSync } from 'node:fs'
import { databaseSslMode } from '../db/tls'

export interface DatabaseTrustEnv {
  readonly DATABASE_SSL?: string | undefined
  readonly NODE_EXTRA_CA_CERTS?: string | undefined
}

export function assertDatabaseTrust(env: DatabaseTrustEnv): void {
  if (databaseSslMode(env) !== 'verify-full') return
  const bundle = env.NODE_EXTRA_CA_CERTS?.trim()
  if (!bundle) return
  let pem: string
  try {
    pem = readFileSync(bundle, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? String(err)
    throw new Error(
      `DATABASE_SSL=verify-full: NODE_EXTRA_CA_CERTS names ${bundle}, which cannot be read (${code})`
    )
  }
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(
      `DATABASE_SSL=verify-full: NODE_EXTRA_CA_CERTS names ${bundle}, which holds no PEM certificate`
    )
  }
}
