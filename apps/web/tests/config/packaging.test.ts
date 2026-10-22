/**
 * The packaging stays honest (M7, docs/DEPLOY.md): the image runs the files the build produces,
 * compose and the Helm chart start the modes the server accepts, and the chart's ConfigMap/Secret
 * keys are exactly the settings `src/config.ts` reads — a new var with no place in the chart fails
 * here, not at somebody's first deploy. Text checks (there is no YAML parser in the workspace, the
 * same choice as ci-workflows.test.ts); `helm lint`/`kubeconform` run in `.github/workflows/image.yml`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseServerMode } from '../../src/node/server'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const read = (f: string) => readFileSync(path.join(REPO_ROOT, f), 'utf8')

const DOCKERFILE = read('Dockerfile')
const BUILD_SERVER = read('apps/web/scripts/build-server.mjs')
const COMPOSE = read('docker-compose.yml')
const COMPOSE_SINGLE = read('deploy/compose.single.yml')
const CHART = 'deploy/helm/rocketpod'
const VALUES = read(`${CHART}/values.yaml`)
const WEB = read(`${CHART}/templates/web.yaml`)
const WORKER = read(`${CHART}/templates/worker.yaml`)
const MIGRATE = read(`${CHART}/templates/migrate.yaml`)

/** `src/config.ts`'s schema keys, split where the file marks the secrets half. */
function configKeys(): { vars: string[]; secrets: string[] } {
  const src = read('apps/web/src/config.ts')
  const start = src.indexOf('const coreConfigSchema = z.object({')
  const secrets = src.indexOf('// ---- Secrets', start)
  const end = src.indexOf('\n})', secrets)
  expect(start, 'coreConfigSchema').toBeGreaterThan(-1)
  expect(secrets, 'the secrets marker').toBeGreaterThan(start)
  const keys = (text: string) => [...text.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map(m => m[1])
  return { vars: keys(src.slice(start, secrets)), secrets: keys(src.slice(secrets, end)) }
}

/** The two-space keys of one top-level map in values.yaml (`config:` / `secrets:`). */
function valuesMap(name: string): string[] {
  const lines = VALUES.split('\n')
  const start = lines.indexOf(`${name}:`)
  expect(start, `values.yaml ${name}:`).toBeGreaterThan(-1)
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const m = line.match(/^ {2}([A-Z][A-Z0-9_]+):/)
    if (m?.[1]) out.push(m[1])
  }
  return out
}

/** The block of one compose service: from `  <name>:` to the next two-space key. */
function service(compose: string, name: string): string {
  const lines = compose.split('\n')
  const start = lines.indexOf(`  ${name}:`)
  expect(start, `service ${name}`).toBeGreaterThan(-1)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(l => /^ {0,2}[\w-]+:/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

describe('the image', () => {
  it('ships exactly the bundles build-server.mjs produces, and runs the server one', () => {
    const bundles = [...BUILD_SERVER.matchAll(/'[^']+\.ts': '(dist\/[\w.-]+\.js)'/g)].map(m => m[1])
    expect(bundles).toEqual(['dist/server.js', 'dist/migrate.js'])
    for (const bundle of bundles) expect(DOCKERFILE).toContain(`/repo/apps/web/${bundle}`)
    expect(DOCKERFILE).toContain('ENTRYPOINT ["node", "dist/server.js"]')
    expect(DOCKERFILE).toMatch(/^CMD \["web"\]$/m)
    expect(DOCKERFILE).toContain('/repo/apps/web/dist/ui ./dist/ui')
    expect(DOCKERFILE).toContain('/repo/apps/web/migrations ./migrations')
    // `defaultGuideContentDir()` reads `content/guide` under the working directory (`/app`).
    expect(DOCKERFILE).toContain('/repo/apps/web/content/guide ./content/guide')
    expect(DOCKERFILE).toMatch(/^USER node$/m)
  })

  /**
   * `pnpm install` runs on the manifests copied BEFORE `COPY . .` — so a workspace package with no
   * `COPY <dir>/package.json` line there is installed with none of its dependencies, and the build
   * fails inside the image only (Agentic Mapper's vendored package did, at a release). A glob
   * cannot fix it: Docker's `COPY packages/*\/package.json` flattens the directories.
   */
  it('copies every workspace package manifest before pnpm install', () => {
    const install = DOCKERFILE.indexOf('pnpm install')
    const copied = DOCKERFILE.slice(0, install)
    const packages = ['apps', 'packages'].flatMap(root =>
      readdirSync(path.join(REPO_ROOT, root))
        .map(dir => `${root}/${dir}`)
        .filter(dir => existsSync(path.join(REPO_ROOT, dir, 'package.json')))
    )
    expect(packages.length).toBeGreaterThan(3)
    const missing = packages.filter(dir => !copied.includes(`COPY ${dir}/package.json ${dir}/`))
    expect(missing, 'add a COPY <dir>/package.json <dir>/ line before pnpm install').toEqual([])
  })

  it('the migrate entry runs what pnpm db:migrate runs', () => {
    const pkg = JSON.parse(read('apps/web/package.json')) as { scripts: Record<string, string> }
    const migrate = pkg.scripts['db:migrate'] ?? ''
    expect(migrate).toMatch(/db-roles\.ts --phase=role.*migrate\.ts.*db-roles\.ts --phase=grants/)
    const entry = read('apps/web/scripts/migrate-all.ts')
    const order = ["phase: 'role'", 'runMigrations(', "phase: 'grants'"].map(s => entry.indexOf(s))
    expect(order.every(i => i > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
})

describe('docker compose', () => {
  it('starts each app service in a mode the server accepts', () => {
    expect(service(COMPOSE, 'migrate')).toContain('entrypoint: ["node", "dist/migrate.js"]')
    expect(service(COMPOSE, 'web')).toContain('command: ["web"]')
    expect(service(COMPOSE, 'worker')).toContain('command: ["worker"]')
    expect(service(COMPOSE_SINGLE, 'web')).toContain('command: ["all"]')
    for (const mode of ['web', 'worker', 'all']) expect(parseServerMode(mode)).toBe(mode)
  })

  it('passes the required settings, and only real ones', () => {
    const { vars, secrets } = configKeys()
    const known = new Set([...vars, ...secrets, 'APP_DATABASE_URL'])
    // The shared `x-app` environment block every app service merges.
    const start = COMPOSE.indexOf('environment: &app-env')
    const end = COMPOSE.indexOf('depends_on: &app-depends', start)
    expect(start, 'the &app-env block').toBeGreaterThan(-1)
    const env = COMPOSE.slice(start, end)
    const keys = [...env.matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map(m => m[1] as string)
    expect(keys).toEqual(expect.arrayContaining(['APP_URL', 'DATABASE_URL', 'STORAGE_ENDPOINT']))
    expect(keys.filter(k => !known.has(k))).toEqual([])
  })
})

describe('the Helm chart', () => {
  it('maps every config var to the ConfigMap and every secret to the Secret — no more, no less', () => {
    const { vars, secrets } = configKeys()
    expect(valuesMap('config').sort()).toEqual([...vars].sort())
    // APP_DATABASE_URL is read by the migrate Job (scripts/db-roles.ts), not by loadConfig.
    expect(valuesMap('secrets').sort()).toEqual([...secrets, 'APP_DATABASE_URL'].sort())
  })

  it('runs the same entry points as the image and compose', () => {
    expect(WEB).toContain('args: ["web"]')
    expect(WORKER).toContain('args: ["worker"]')
    expect(MIGRATE).toContain('command: ["node", "dist/migrate.js"]')
    expect(MIGRATE).toContain('helm.sh/hook: pre-install,pre-upgrade')
    expect(WEB).toContain('path: /readyz')
    expect(WEB).toContain('path: /healthz')
    expect(WORKER).toContain('path: /healthz')
  })
})
