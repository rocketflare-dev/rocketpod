/**
 * `pnpm web guide:shots [--only id,…] [--stale]` — regenerate the Guide's screenshots from
 * `content/guide/screenshots.yaml` against a LOCAL dev server.
 *
 * 1. Checks the dev server answers (UI port from `scripts/lib/dev-ports.mjs`) and that dev login
 *    works. It does not start one: run `pnpm dev`, seeded with `pnpm seed --demo`.
 * 2. Signs in through `POST /auth/dev-login` as the seed's owner — development only (the route is
 *    a 404 anywhere else) — and hands Playwright the session cookie.
 * 3. Kills animation and fixes theme and viewport, so the same screen is the same pixels.
 * 4. Shoots each entry to memory, compares it with the committed `images/<id>.png`, and rewrites
 *    the file only above a small diff threshold. Prints a table.
 *
 * `--stale` shoots only entries whose `sources` changed since their image was last committed.
 * Images are plain PNGs (no Git LFS). Exit 1 if any entry failed.
 *
 * **Playwright is not a dependency of the kit** — the gate never needs a browser. This script
 * loads it on demand and says how to install it when it is missing.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { devPorts } from '../../../scripts/lib/dev-ports.mjs'
import {
  compareShots,
  freezeInitScript,
  IMAGES_DIR,
  imagePathFor,
  MANIFEST_PATH,
  parseManifest,
  resolveRoute,
  routePlaceholders,
  type ShotEntry,
  staleEntries,
} from './lib/guide-shots'

const PORTS = devPorts()
const UI_URL = `http://localhost:${PORTS.ui}`
const OWNER_EMAIL = 'owner@example.test'
/** The `data-theme` values `ThemeToggle` writes to `localStorage['theme']`. */
const THEMES = { light: 'rocketpod-light', dark: 'rocketpod-dark' } as const

const PLAYWRIGHT_HINT =
  'Playwright is not installed (the kit does not depend on it). Install it once:\n' +
  '  pnpm --filter @rocketpod/web add -D playwright && pnpm --filter @rocketpod/web exec playwright install chromium'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

function fail(message: string): never {
  console.error(`guide:shots: ${message}`)
  process.exit(1)
}

function parseArgs(argv: string[]): { only: string[] | null; stale: boolean } {
  let only: string[] | null = null
  let stale = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--stale') stale = true
    else if (arg === '--only') only = (argv[++i] ?? '').split(',').filter(Boolean)
    else if (arg.startsWith('--only=')) only = arg.slice(7).split(',').filter(Boolean)
    else fail(`unknown argument ${arg} — usage: pnpm web guide:shots [--only id,…] [--stale]`)
  }
  return { only, stale }
}

type Session = { name: string; value: string }

/** The dev server is up and dev login answers — then its session cookie. */
async function devSession(): Promise<Session> {
  const hint = `Start the dev server with \`pnpm dev\` (ui :${PORTS.ui}, api :${PORTS.api}) and seed the demo (\`pnpm seed --demo\`), then re-run.`
  let res: Response
  try {
    const health = await fetch(`${UI_URL}/api/health`, { signal: AbortSignal.timeout(5000) })
    if (!health.ok) fail(`${UI_URL}/api/health answered ${health.status}. ${hint}`)
    res = await fetch(`${UI_URL}/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ email: OWNER_EMAIL }),
      signal: AbortSignal.timeout(10000),
    })
  } catch (err) {
    fail(`the dev server is not reachable (${(err as Error).message}). ${hint}`)
  }
  if (!res.ok) fail(`dev login answered ${res.status} — is APP_ENV=development? ${hint}`)
  const cookie = res.headers
    .getSetCookie()
    .map(c => c.split(';')[0] ?? '')
    .find(c => c.includes('session'))
  if (!cookie) fail('dev login set no session cookie.')
  const at = cookie.indexOf('=')
  return { name: cookie.slice(0, at), value: cookie.slice(at + 1) }
}

/**
 * The values of the route placeholders the selected entries use, looked up on the dev server as
 * the signed-in owner. The kit's pages need none; an app whose screens live under an id
 * (`/projects/{project}`) adds a lookup here — an API read, or a seed of its own that it deletes
 * again in `main`'s `finally`.
 */
async function routeValues(
  names: readonly string[],
  _session: Session
): Promise<Record<string, string | null>> {
  const values: Record<string, string | null> = {}
  for (const name of names) {
    switch (name) {
      // case 'project': values.project = await firstProjectId(_session); break
      default:
        break
    }
  }
  return values
}

function selectEntries(all: ShotEntry[], only: string[] | null, stale: boolean): ShotEntry[] {
  let entries = all
  if (only) {
    const unknown = only.filter(id => !all.some(e => e.id === id))
    if (unknown.length > 0) fail(`unknown shot id(s): ${unknown.join(', ')}`)
    entries = entries.filter(e => only.includes(e.id))
  }
  if (stale) {
    entries = staleEntries(entries, {
      lastCommitOf: file => git('log', '-1', '--format=%H', '--', file).trim() || null,
      changedSince: sha =>
        [
          ...git('diff', '--name-only', '--no-renames', sha, 'HEAD').split('\n'),
          ...git('diff', '--name-only', '--no-renames', 'HEAD').split('\n'),
          ...git('ls-files', '--others', '--exclude-standard').split('\n'),
        ].filter(Boolean),
    })
  }
  return entries
}

/** The slice of Playwright this script drives — typed here so the kit compiles without it. */
interface Locator {
  first(): Locator
  click(): Promise<void>
  fill(text: string): Promise<void>
  waitFor(options: { state: 'visible'; timeout?: number }): Promise<void>
  screenshot(options: object): Promise<Buffer>
}
interface Page {
  goto(url: string, options: { waitUntil: 'networkidle' }): Promise<unknown>
  locator(selector: string): Locator
  keyboard: { press(key: string): Promise<void> }
  waitForLoadState(state: 'networkidle'): Promise<void>
  evaluate(fn: () => Promise<undefined>): Promise<unknown>
  screenshot(options: object): Promise<Buffer>
}
interface BrowserContext {
  addCookies(cookies: object[]): Promise<void>
  addInitScript(script: { content: string }): Promise<void>
  newPage(): Promise<Page>
  close(): Promise<void>
}
interface Browser {
  newContext(options: object): Promise<BrowserContext>
  close(): Promise<void>
}

async function launchChromium(): Promise<Browser> {
  // A variable specifier: the kit typechecks and bundles without the package present.
  const specifier = 'playwright'
  let mod: { chromium: { launch(): Promise<Browser> } }
  try {
    mod = (await import(specifier)) as typeof mod
  } catch {
    fail(PLAYWRIGHT_HINT)
  }
  try {
    return await mod.chromium.launch()
  } catch (err) {
    fail(
      `Chromium would not start (${(err as Error).message.split('\n')[0]}). Install it with: pnpm --filter @rocketpod/web exec playwright install chromium`
    )
  }
}

interface Row {
  id: string
  result: 'changed' | 'unchanged' | 'failed'
  detail: string
}

async function main(): Promise<void> {
  const { only, stale } = parseArgs(process.argv.slice(2))
  if (process.env.NODE_ENV === 'production') fail('refusing to run with NODE_ENV=production.')
  const manifestFile = path.join(root, MANIFEST_PATH)
  const all = existsSync(manifestFile) ? parseManifest(readFileSync(manifestFile, 'utf8')) : []
  const entries = selectEntries(all, only, stale)
  if (entries.length === 0) {
    console.log(stale ? 'guide:shots — no stale shots.' : 'guide:shots — nothing to shoot.')
    return
  }
  const session = await devSession()
  const values = await routeValues(routePlaceholders(entries), session)
  await mkdir(path.join(root, IMAGES_DIR), { recursive: true })

  const rows: Row[] = []
  const browser = await launchChromium()
  try {
    for (const entry of entries) {
      const context = await browser.newContext({
        viewport: entry.viewport,
        deviceScaleFactor: 2,
        colorScheme: entry.theme,
        locale: 'en-GB',
        timezoneId: 'Europe/London',
        reducedMotion: 'reduce',
      })
      try {
        // `__Host-` / `__Secure-` cookies must be Secure; Chromium treats localhost as secure.
        const secure = /^__(Host|Secure)-/.test(session.name)
        await context.addCookies([
          { ...session, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', secure },
        ])
        await context.addInitScript({ content: freezeInitScript(THEMES[entry.theme]) })
        const page = await context.newPage()
        await page.goto(`${UI_URL}${resolveRoute(entry.route, values)}`, {
          waitUntil: 'networkidle',
        })
        for (const step of entry.steps) {
          if ('click' in step) await page.locator(step.click).first().click()
          else if ('press' in step) await page.keyboard.press(step.press)
          else if ('fill' in step)
            await page.locator(step.fill.selector).first().fill(step.fill.text)
          else await page.locator(step.waitFor).first().waitFor({ state: 'visible' })
          await page.waitForLoadState('networkidle')
        }
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        const shotOptions = { animations: 'disabled', caret: 'hide' } as const
        let fresh: Buffer
        if (entry.crop) {
          const target = page.locator(entry.crop).first()
          await target.waitFor({ state: 'visible', timeout: 15000 })
          fresh = await target.screenshot(shotOptions)
        } else {
          fresh = await page.screenshot(shotOptions)
        }
        const file = path.join(root, imagePathFor(entry.id))
        const baseline = existsSync(file) ? readFileSync(file) : null
        const cmp = compareShots(baseline, fresh)
        if (cmp.changed) writeFileSync(file, fresh)
        rows.push({
          id: entry.id,
          result: cmp.changed ? 'changed' : 'unchanged',
          detail: `${cmp.reason}, ${(cmp.ratio * 100).toFixed(3)}% px differ`,
        })
      } catch (err) {
        rows.push({
          id: entry.id,
          result: 'failed',
          detail: (err as Error).message.split('\n')[0] ?? '',
        })
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }

  const width = Math.max(4, ...rows.map(r => r.id.length))
  console.log(`\n${'shot'.padEnd(width)}  ${'result'.padEnd(9)}  detail`)
  for (const r of rows) console.log(`${r.id.padEnd(width)}  ${r.result.padEnd(9)}  ${r.detail}`)
  const changed = rows.filter(r => r.result === 'changed').length
  if (changed > 0)
    console.log(`\n${changed} image(s) rewritten under ${IMAGES_DIR}/ — commit them.`)
  if (rows.some(r => r.result === 'failed')) process.exitCode = 1
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
