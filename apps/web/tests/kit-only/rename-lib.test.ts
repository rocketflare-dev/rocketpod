/**
 * `scripts/rename.mjs`'s pure half (`scripts/lib/rename-lib.mjs`): name derivation, the ordered
 * replacement classes and the careful-row arithmetic. No database, no filesystem — the `config`
 * project. This file is on the tool's exclusion list precisely because it asserts on the kit's
 * own token strings.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandHue } from '../../../../scripts/lib/brand.mjs'
import { themeTokens } from '../../../../scripts/lib/contrast.mjs'
import {
  API_KEY_HANDLE_MARGIN,
  applyColour,
  applyReplacements,
  applyTagline,
  CLASS_IDS,
  choosePortBlock,
  colourProblem,
  DEPLOY_PORT_PATHS,
  deriveNames,
  designTagline,
  EXCLUDED_DIRS,
  EXCLUDED_PATHS,
  hexToRgb,
  isBinary,
  isExcluded,
  KIT,
  KIT_MANIFEST_FILE,
  PORT_BLOCK_COUNT,
  PORT_BLOCK_FIRST,
  PORT_BLOCK_SIZE,
  parseArgs,
  pluginTranslator,
  portsForBlock,
  prefixGuard,
  REDACTED_KEY_MARGIN,
  readIntConstant,
  readStringConstant,
  renameKitManifest,
  restartAppVersion,
  rewriteDevPortStarts,
  rewriteDevServerPorts,
  rewriteIntConstant,
  rewritePorts,
  rewritePrefixComments,
  stampedManifest,
  topLevelObjectSpan,
  validateSlug,
} from '../../../../scripts/lib/rename-lib.mjs'

describe('deriveNames', () => {
  it('derives snake, UPPER, display and the placeholder domain from a hyphenated slug', () => {
    expect(deriveNames('my-app')).toEqual({
      slug: 'my-app',
      snake: 'my_app',
      upper: 'MY_APP',
      display: 'My App',
      domain: 'my-app.example.com',
      prefix: 'my_app_',
      colour: null,
    })
  })

  it('takes an explicit display name, domain and colour', () => {
    const names = deriveNames('acme', 'ACME Corp', { domain: 'Acme.IO', colour: '#FF0000' })
    expect(names.display).toBe('ACME Corp')
    expect(names.domain).toBe('acme.io')
    expect(names.colour).toBe('#ff0000')
    expect(names.snake).toBe('acme')
    expect(names.upper).toBe('ACME')
  })

  it('rejects a bad domain or colour', () => {
    expect(() => deriveNames('acme', undefined, { domain: 'nodots' })).toThrow(/apex host/)
    expect(() => deriveNames('acme', undefined, { colour: 'red' })).toThrow(/not a colour/)
  })

  it('refuses a multi-line display name', () => {
    // `scripts/upgrade.mjs` translates kit diffs with these replacements, and its hunk headers
    // stay valid only because a substitution moves columns and never line counts.
    expect(() => deriveNames('acme', 'Acme\nCorp')).toThrow(/single line/)
    expect(() => deriveNames('acme', 'Acme\rCorp')).toThrow(/single line/)
  })
})

describe('validateSlug', () => {
  it('accepts lowercase slugs with digits and hyphens', () => {
    expect(validateSlug('acme')).toBeNull()
    expect(validateSlug('my-app2')).toBeNull()
  })

  it('refuses the kit name, uppercase, leading digits, underscores and a trailing hyphen', () => {
    expect(validateSlug(KIT.slug)).toMatch(/kit's own name/)
    expect(validateSlug('MyApp')).toMatch(/must match/)
    expect(validateSlug('1app')).toMatch(/must match/)
    expect(validateSlug('my_app')).toMatch(/must match/)
    expect(validateSlug('my-')).toMatch(/trailing|end with a hyphen/)
    expect(validateSlug('')).toMatch(/required/)
  })
})

/** One paragraph with every token class the kit ships. */
const SAMPLE = [
  'import { x } from "@rocketpod/shared/ai/config" // @rocketpod/web',
  "ROCKETPOD_API_KEY=… ROCKETPOD_URL=… ENV_PREFIX = 'ROCKETPOD'",
  "~/.rocketpod/config.json and CONFIG_DIR_NAME = '.rocketpod' and $HOME/.rocketpod",
  'noreply@rocketpod.example.com app.rocketpod.example.com staging.rocketpod.example.com admin@rocketpod.example.com',
  'postgresql://rocketpod:rocketpod_pass@localhost:5432/rocketpod_dev',
  'POSTGRES_USER: rocketpod',
  'pg_isready -U rocketpod -d rocketpod_dev',
  'rocketpod_app rocketpod_test rocketpod_ab12cd34',
  'rocketpod-agent-run-staging rocketpod-jobs rocketpod-files-staging rocketpod-light',
  'APP_NAME=Rocketpod Test <title>Rocketpod</title>',
  'name = "rocketpod" bin rocketpod, cfld.name rocketpod; container rocketpod-dev-postgres',
  'https://github.com/rocketflare-dev/rocketflare.git stays',
].join('\n')

describe('applyReplacements', () => {
  it('renames every class for a hyphenated slug without partial-form mismatches', () => {
    const names = deriveNames('my-app')
    const { text, counts, preserved } = applyReplacements(SAMPLE, names)
    expect(text).toBe(
      [
        'import { x } from "@my-app/shared/ai/config" // @my-app/web',
        "MY_APP_API_KEY=… MY_APP_URL=… ENV_PREFIX = 'MY_APP'",
        "~/.my-app/config.json and CONFIG_DIR_NAME = '.my-app' and $HOME/.my-app",
        'noreply@my-app.example.com app.my-app.example.com staging.my-app.example.com admin@my-app.example.com',
        'postgresql://my_app:my_app_pass@localhost:5432/my_app_dev',
        'POSTGRES_USER: my_app',
        'pg_isready -U my_app -d my_app_dev',
        'my_app_app my_app_test my_app_ab12cd34',
        'my-app-agent-run-staging my-app-jobs my-app-files-staging my-app-light',
        'APP_NAME=My App Test <title>My App</title>',
        'name = "my-app" bin my-app, cfld.name my-app; container my-app-dev-postgres',
        'https://github.com/rocketflare-dev/rocketflare.git stays',
      ].join('\n')
    )
    // The classic mismatches: scope/env must not pick up the hyphenated or snake forms.
    expect(text).not.toMatch(/my-app_|@my_app\/|MY-APP|my_app-|\.my_app\b/)
    expect(text).toContain('-staging')
    expect(preserved).toBe(1)
    expect(counts).toEqual({
      scope: 2,
      env: 3,
      domain: 4,
      cfgdir: 3,
      dbuser: 3,
      snake: 6,
      kebab: 5,
      display: 2,
      bare: 3,
    })
  })

  it('collapses every class to the same word for a single-word slug', () => {
    const { text } = applyReplacements(SAMPLE, deriveNames('acme', 'Acme Ops'))
    expect(text).toContain('@acme/shared')
    expect(text).toContain('ACME_API_KEY')
    expect(text).toContain('~/.acme/config.json')
    expect(text).toContain('noreply@acme.example.com')
    expect(text).toContain('postgresql://acme:acme_pass@localhost:5432/acme_dev')
    expect(text).toContain('acme_app')
    expect(text).toContain('acme-agent-run-staging')
    expect(text).toContain('APP_NAME=Acme Ops Test')
    expect(text.replace(KIT.preservedPattern, '')).not.toMatch(/[Rr]ocketflare/)
  })

  /**
   * Anything in the `rocketflare-dev` org is upstream — the kit, its plugin repositories, the
   * reusable plugin CI — and a renamed app still pulls it from there; rewritten, it became
   * `acme-dev/…`, an org that does not exist. A container image under `ghcr.io/` is the exception:
   * it is the app's own, so it follows the rename (the next test).
   */
  it('never rewrites the rocketflare-dev org or its repositories, but still moves container names', () => {
    const input = [
      'image: ghcr.io/rocketflare-dev/local-neon-proxy@sha256:abc',
      'uses: rocketflare-dev/rocketflare/.github/workflows/plugin-ci.yml@main',
      'repo=rocketflare-dev/rocketflare-plugins;',
      'see rocketflare-dev/rocketflare-plugin-analytics.git@1.0.2',
      'mirrored to `ghcr.io/rocketflare-dev` and rebuilt',
      'https://raw.githubusercontent.com/rocketflare-dev/rocketflare/0.10.0/CHANGELOG.md',
      'container_name: rocketpod-dev-postgres, volume rocketpod-dev-data',
    ].join('\n')
    const { text, preserved } = applyReplacements(input, deriveNames('acme'))
    expect(text).toBe(
      input
        .replace('rocketpod-dev-postgres', 'acme-dev-postgres')
        .replace('rocketpod-dev-data', 'acme-dev-data')
    )
    expect(preserved).toBe(4)
  })

  it("renames the app's own image, which is not upstream", () => {
    const { text } = applyReplacements(
      'repository: ghcr.io/rocketflare-dev/rocketpod\nhome: https://github.com/rocketflare-dev/rocketpod',
      deriveNames('acme')
    )
    expect(text).toBe(
      'repository: ghcr.io/rocketflare-dev/acme\nhome: https://github.com/rocketflare-dev/rocketpod'
    )
  })

  it('leaves no <slug>-dev/ reference anywhere in the renamed tree', () => {
    const repoRoot = path.resolve(__dirname, '../../../..')
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\0')
      .filter(f => f.length > 0 && !isExcluded(f))
    const names = deriveNames('acme')
    const offenders = files.filter(f => {
      const full = path.join(repoRoot, f)
      if (!existsSync(full)) return false
      const buffer = readFileSync(full)
      if (isBinary(buffer)) return false
      return /acme-dev\/|ghcr\.io\/acme\b/.test(
        applyReplacements(buffer.toString('utf8'), names).text
      )
    })
    expect(offenders).toEqual([])
  })

  /**
   * The three filenames that keep the KIT's name in a renamed app. `.rocketflare.json` describes
   * the kit and is deliberately never renamed (D27); its sidecar follows it; and
   * `rocketflare-plugin.json` is the same in every plugin repository in the world (D31). Rewritten,
   * a copy renamed to `acme` looked for `.acme.json` and every `pnpm plugin` command died against a
   * file sitting in its root, `.gitignore` stopped ignoring the sidecar, and the app could never
   * install any plugin. They are preserved LONGEST FIRST, or `.rocketflare.json` would claim the
   * head of `.rocketflare.local.json` and leave `.local.json` behind for the domain class.
   */
  it('never rewrites the three filenames that name the kit on purpose', () => {
    const names = deriveNames('acme', 'Acme')
    const input = [
      'Provenance lives in `.rocketflare.json`, and `pnpm plugin` reads it.', // prose
      '.rocketflare.local.json', // a .gitignore line, alone on it
      'node_modules/', // its neighbour, untouched either way
      "export const MANIFEST_FILE = '.rocketflare.json'", // a JS string
      "if (!source.has('rocketflare-plugin.json')) stop(5)", // and the plugin manifest
      'but rocketpod-web and @rocketpod/shared still move', // …while everything else does
    ].join('\n')
    const { text, preserved } = applyReplacements(input, names)
    expect(text).toContain('`.rocketflare.json`')
    expect(text.split('\n')[1]).toBe('.rocketflare.local.json')
    expect(text).toContain("MANIFEST_FILE = '.rocketflare.json'")
    expect(text).toContain("source.has('rocketflare-plugin.json')")
    expect(text).toContain('acme-web and @acme/shared still move')
    expect(text).not.toMatch(/\.acme\.json|acme-plugin\.json|acme\.example\.com\.json/)
    expect(preserved).toBe(4)
  })

  it('never rewrites the published plugin catalogue page, while the app domain still moves', () => {
    const input =
      'Browse https://rocketflare.dev/plugins; the app is https://app.rocketpod.example.com'
    const { text } = applyReplacements(input, deriveNames('acme', 'Acme'))
    expect(text).toContain('https://rocketflare.dev/plugins;')
    expect(text).not.toContain('https://app.rocketpod.example.com')
  })

  it('applies the classes longest-first: the env class takes the bare ENV_PREFIX too', () => {
    const { text, counts } = applyReplacements("'ROCKETPOD' ROCKETPOD_X", deriveNames('a-b'))
    expect(text).toBe("'A_B' A_B_X")
    expect(counts.env).toBe(2)
    expect(counts.bare).toBe(0)
  })

  it('keeps the domain ahead of the config-dir class (app.rocketpod.example.com is not a config dir)', () => {
    const { text, counts } = applyReplacements(
      'https://app.rocketpod.example.com',
      deriveNames('a-b')
    )
    expect(text).toBe('https://app.a-b.example.com')
    expect(counts.cfgdir).toBe(0)
  })

  it('returns the identical string and zero counts when nothing matches', () => {
    const input = 'nothing to see here'
    const result = applyReplacements(input, deriveNames('acme'))
    expect(result.text).toBe(input)
    expect(result.total).toBe(0)
  })

  it('table columns are the class ids in application order', () => {
    expect(CLASS_IDS).toEqual([
      'scope',
      'env',
      'domain',
      'cfgdir',
      'dbuser',
      'snake',
      'kebab',
      'display',
      'bare',
    ])
  })
})

describe('pluginTranslator (a plugin is written in the ecosystem vocabulary)', () => {
  const kitOnly = pluginTranslator(null)
  const toApp = pluginTranslator(deriveNames('my-app', 'My App'))

  it("moves Rocketflare's names into the kit's, so a shared plugin typechecks here", () => {
    if (!kitOnly) throw new Error('the kit is not the ecosystem, so there is always a translator')
    expect(kitOnly("import { z } from '@rocketflare/shared/plugins'")).toBe(
      "import { z } from '@rocketpod/shared/plugins'"
    )
    expect(kitOnly('ROCKETFLARE_API_KEY · Rocketflare · rocketflare_ · rocketflare-sso')).toBe(
      'ROCKETPOD_API_KEY · Rocketpod · rocketpod_ · rocketpod-sso'
    )
  })

  it('keeps the fixed filenames and upstream references', () => {
    if (!kitOnly) throw new Error('expected a translator')
    const text =
      '.rocketflare.json rocketflare-plugin.json .rocketflare.local.json ' +
      'https://github.com/rocketflare-dev/rocketflare-commercial-plugins'
    expect(kitOnly(text)).toBe(text)
  })

  it("then into a renamed copy's names", () => {
    if (!toApp) throw new Error('expected a translator')
    expect(toApp("from '@rocketflare/shared/auth' and '@rocketpod/shared/auth'")).toBe(
      "from '@my-app/shared/auth' and '@my-app/shared/auth'"
    )
  })

  it('never changes a line count', () => {
    if (!kitOnly) throw new Error('expected a translator')
    const text = 'a @rocketflare/x\nROCKETFLARE_Y\n\nRocketflare\n'
    expect(kitOnly(text).split('\n')).toHaveLength(text.split('\n').length)
  })
})

describe('exclusions', () => {
  it('lists the files that must survive the pass', () => {
    for (const p of [
      'pnpm-lock.yaml',
      'LICENSE',
      'CODE_OF_CONDUCT.md',
      'SECURITY.md',
      'CONTRIBUTING.md',
      'apps/web/src/ui/public/logo.svg',
      'apps/web/src/ui/public/favicon.svg',
      'scripts/rename.mjs',
      'scripts/lib/rename-lib.mjs',
      'scripts/lib/rename-lib.d.mts',
      '.claude/skills/rp-adapt/SKILL.md',
      '.claude/skills/rp-adapt/checklist.md',
      '.rocketflare.json',
    ]) {
      expect(EXCLUDED_PATHS, p).toContain(p)
      expect(isExcluded(p), p).toBe(true)
    }
    // The kit's own tests, this file among them, by prefix — the rename deletes them anyway.
    expect(isExcluded('apps/web/tests/kit-only/rename-lib.test.ts')).toBe(true)
    // Licence files anywhere: a commercial plugin's own LICENSE travels into the app and must
    // keep its licensor's name. Source files that merely look similar are still translated.
    for (const p of [
      'apps/web/src/plugins/sso/LICENSE',
      'LICENSES/kit-MIT.txt',
      'packages/x/LICENCE.md',
      'NOTICE',
      'apps/web/LICENSE-MIT',
    ])
      expect(isExcluded(p), p).toBe(true)
    for (const p of ['apps/web/src/ui/components/Notice.tsx', 'apps/web/src/api/license.ts'])
      expect(isExcluded(p), p).toBe(false)
    for (const d of ['node_modules', 'dist', '.git']) expect(EXCLUDED_DIRS).toContain(d)
    expect(isExcluded('apps/web/node_modules/x/package.json')).toBe(true)
    expect(isExcluded('apps/web/dist/ui/index.html')).toBe(true)
    expect(isExcluded('apps/web/migrations/0000_kit-baseline.sql')).toBe(false)
    expect(isExcluded('apps/web/migrations/meta/0000_snapshot.json')).toBe(false)
    expect(isExcluded('apps/web/wrangler.staging.toml')).toBe(false)
  })

  it('spots a binary by a NUL byte in the head', () => {
    expect(isBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBe(true)
    expect(isBinary(new TextEncoder().encode('plain text\n'))).toBe(false)
  })
})

describe('prefix guard (row a)', () => {
  it('sets both handle lengths to prefix + margin for a longer prefix', () => {
    const g = prefixGuard(deriveNames('northwind-traders'), {
      apiKeyPrefixLength: 20,
      redactedKeyChars: 16,
    })
    expect(g.prefix).toBe('northwind_traders_')
    expect(g.prefixLength).toBe(18)
    expect(g.apiKeyPrefixLength).toEqual({ current: 20, required: 26, change: true })
    expect(g.redactedKeyChars).toEqual({ current: 16, required: 22, change: true })
    expect(API_KEY_HANDLE_MARGIN).toBe(8)
    expect(REDACTED_KEY_MARGIN).toBe(4)
  })

  it('shrinks them for a shorter prefix (the CLI tests assume prefix + 4 exactly)', () => {
    const g = prefixGuard(deriveNames('acme'), { apiKeyPrefixLength: 20, redactedKeyChars: 16 })
    expect(g.apiKeyPrefixLength).toEqual({ current: 20, required: 13, change: true })
    expect(g.redactedKeyChars).toEqual({ current: 16, required: 9, change: true })
  })

  it('reads and rewrites the constants and their arithmetic comments', () => {
    const hash =
      "export const API_KEY_PREFIX = 'acme_'\n" +
      'export const API_KEY_PREFIX_LENGTH = 20 // `acme_` (12) + 8 chars — must exceed the prefix\n'
    expect(readIntConstant(hash, 'API_KEY_PREFIX_LENGTH')).toBe(20)
    expect(readIntConstant(hash, 'NOPE')).toBeNull()
    const out = rewriteIntConstant(hash, 'API_KEY_PREFIX_LENGTH', 13, 'acme_', 8)
    expect(out).toContain('export const API_KEY_PREFIX_LENGTH = 13 // `acme_` (5) + 8 chars')
    const cli = '/** Characters shown of a key: `acme_` (12) + 4 — never the full secret. */\n'
    expect(rewritePrefixComments(cli, 'acme_', 4)).toContain('`acme_` (5) + 4 — never')
  })

  it('the real API_KEY_PREFIX renames to exactly `<snake>_`, hyphenated slug or not', () => {
    const root = path.resolve(__dirname, '../../../..')
    const hash = readFileSync(path.join(root, 'apps/web/src/api/utils/core/hash.ts'), 'utf8')
    // This file is not renamed, but hash.ts is: in a renamed copy the prefix is already the app's.
    const app = JSON.parse(readFileSync(path.join(root, '.rocketflare.json'), 'utf8')).app
    const expected = app ? deriveNames(app.slug).prefix : `${KIT.slug}_`
    expect(readStringConstant(hash, 'API_KEY_PREFIX')).toBe(expected)
    expect(readStringConstant(hash, 'NOPE')).toBeNull()
    if (app) return
    for (const slug of ['acme', 'my-app', 'northwind-traders']) {
      const names = deriveNames(slug)
      const renamed = applyReplacements(hash, names).text
      expect(readStringConstant(renamed, 'API_KEY_PREFIX')).toBe(names.prefix)
    }
  })
})

describe('colour (row e)', () => {
  // Rocketpod's own palette is hex, with no oklch() hue to turn: the hue cases read the one-hue
  // look in `fixtures/one-hue-look/` (brand-look.test.ts says why), the hex case the real files.
  const repo = path.resolve(__dirname, '../../../..')
  const look = path.join(__dirname, 'fixtures/one-hue-look')
  const read = (rel: string) => readFileSync(path.join(look, rel), 'utf8')
  const live = () => ({
    tokensCss: readFileSync(path.join(repo, 'apps/web/src/shared/theme-tokens.css'), 'utf8'),
    indexCss: readFileSync(path.join(repo, 'apps/web/src/ui/index.css'), 'utf8'),
    html: readFileSync(path.join(repo, 'apps/web/src/ui/index.html'), 'utf8'),
  })
  const files = () => ({
    tokensCss: read('apps/web/src/shared/theme-tokens.css'),
    indexCss: read('apps/web/src/ui/index.css'),
    html: read('apps/web/src/ui/index.html'),
  })

  it("turns the palette to the colour's hue, keeping lightness, the flare and the state colours", () => {
    const before = files()
    const kitHue = brandHue(`${before.tokensCss}\n${before.indexCss}`) as number
    const kitTokens = themeTokens(`${before.tokensCss}\n${before.indexCss}`).light.tokens
    const lc = (token: string) => {
      const [, l, c, h] = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(kitTokens[token]) ?? []
      return { l: l.replace('.', '\\.'), c: c.replace('.', '\\.'), h: Number(h) }
    }
    const r = applyColour(before, '#b91c1c')
    expect(r.from).toBe(kitHue)
    expect(r.to).toBeCloseTo(27.5, 0)
    expect(r.cssReplacements).toBeGreaterThan(50)
    // The kit's primary keeps its lightness and chroma at the new hue.
    const primary = lc('--color-primary')
    expect(r.tokensCss).toMatch(
      new RegExp(`--color-primary: oklch\\(${primary.l} ${primary.c} 27\\.\\d+\\);`)
    )
    expect(r.tokensCss).not.toContain(`--color-primary: ${kitTokens['--color-primary']};`)
    // The accent keeps its offset from the brand hue.
    const accent = lc('--color-accent')
    const accentHue = (((accent.h - kitHue + Number(r.to)) % 360) + 360) % 360
    expect(r.tokensCss).toMatch(
      new RegExp(
        `--color-accent: oklch\\(${accent.l} ${accent.c} ${Math.floor(accentHue)}\\.\\d+\\);`
      )
    )
    // The flare and the hex state colours are their own.
    expect(r.indexCss).toContain(`--flare: ${kitTokens['--flare']};`)
    expect(r.tokensCss).toContain('--color-error: #be123c;')
    // Comments are not rewritten: the header still documents the kit's own hue.
    const header =
      before.indexCss.match(/\/\*[\s\S]*?\*\//g)?.find(c => c.includes('REBRANDING')) ?? ''
    expect(header).toContain(`oklch(L C ${kitHue})`)
    expect(r.indexCss).toContain(header)
    expect(r.primary).toMatch(/^#[0-9a-f]{6}$/)
    expect(r.html).toContain(`<meta name="theme-color" content="${r.primary}"`)
    expect(r.htmlReplaced).toBe(true)
    // Turning back to the kit's hue restores the kit's files byte for byte.
    const back = applyColour(
      { tokensCss: r.tokensCss, indexCss: r.indexCss, html: r.html },
      String(kitHue)
    )
    expect(back.tokensCss).toBe(before.tokensCss)
    expect(back.indexCss).toBe(before.indexCss)
  })

  it('takes a hue in degrees, refuses a grey, and keeps the hex helper', () => {
    expect(applyColour(files(), '145').to).toBe(145)
    expect(() => applyColour(files(), '#777777')).toThrow(/grey/)
    expect(colourProblem('oklch(0.6 0.15 30)')).toBeNull()
    expect(colourProblem('400')).toMatch(/0–360/)
    expect(hexToRgb('#ffffff')).toBe('255, 255, 255')
  })

  it('over a hex palette, rewrites the light primary wherever it appears, and the meta tag', () => {
    const before = live()
    const from = /--color-primary:\s*(#[0-9a-f]{6})/i.exec(before.tokensCss)?.[1] ?? ''
    expect(from).toMatch(/^#/)
    const r = applyColour(before, '#b91c1c')
    expect(r.mode).toBe('hex')
    expect(r.from).toBe(from.toLowerCase())
    expect(r.tokensCss).not.toMatch(new RegExp(from, 'i'))
    expect(r.indexCss).not.toMatch(new RegExp(from, 'i'))
    expect(r.tokensCss).toContain('--color-primary: #b91c1c')
    expect(r.indexCss).toContain('--focus-ring: #b91c1c')
    expect(r.cssReplacements).toBeGreaterThan(3)
    expect(r.html).toContain('<meta name="theme-color" content="#b91c1c"')
    // The dark primary is its own contrast decision: kept, and listed.
    const dark = [...before.tokensCss.matchAll(/--color-primary:\s*(#[0-9a-f]{6})/gi)][1]?.[1] ?? ''
    expect(r.tokensCss).toContain(`--color-primary: ${dark}`)
    expect(r.manual.join('\n')).toContain(dark)
    // A bare hue names no hex to write.
    expect(() => applyColour(before, '145')).toThrow(/needs a colour, not a hue/)
  })
})

describe('stampedManifest (.rocketflare.json in a copy)', () => {
  const kitManifest = () =>
    JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../../.rocketflare.json'), 'utf8')
    ) as Record<string, unknown>

  it("carries the guard's keys into the copy, with the guard's variable in the app's names", () => {
    const names = deriveNames('acme', 'Acme')
    const kit = kitManifest()
    expect(kit.guard).toEqual({ enabled: true })
    expect(kit.localEdits).toEqual([])
    const out = stampedManifest(kit, names, ['design:docs'])
    expect(out.app).toEqual({ slug: 'acme', display: 'Acme', domain: names.domain })
    expect(out.guard).toEqual({ enabled: true })
    expect(out.localEdits).toEqual([])
    expect(out.kitOnlyScripts).toEqual(['design:docs'])
    expect(out).not.toHaveProperty('retiredSurfaces')
    expect(String(out.$guard)).toContain('ACME_GUARD=0')
    expect(String(out.$guard)).not.toContain('ROCKETPOD_GUARD')
    // The kit block names the KIT, verbatim.
    expect(out.kit).toEqual(kit.kit)
    // The renamed guard reads the same variable the explanation names.
    const lib = readFileSync(
      path.resolve(__dirname, '../../../../scripts/lib/kit-guard-lib.mjs'),
      'utf8'
    )
    expect(applyReplacements(lib, names).text).toContain("env.ACME_GUARD === '0'")
  })

  it("keeps a copy's guard setting and ledger, and fills them in when an older manifest lacks them", () => {
    const names = deriveNames('acme', 'Acme')
    const entry = { path: 'apps/web/src/db/client.ts', kind: 'fix', reason: 'x'.repeat(30) }
    const kept = stampedManifest(
      { kit: {}, app: null, guard: { enabled: false }, localEdits: [entry] },
      names
    )
    expect(kept.guard).toEqual({ enabled: false })
    expect(kept.localEdits).toEqual([entry])
    const filled = stampedManifest({ kit: {}, app: null }, names)
    expect(filled.guard).toEqual({ enabled: true })
    expect(filled.localEdits).toEqual([])
  })
})

describe('the sign-in tagline (row f)', () => {
  const source = `/** \`tagline\` is the one line. */
export const LOGIN_PANEL: { art: 'rocket' | 'type'; tagline: string } = {
  art: 'rocket',
  tagline: "Your team's work, in one place.",
}
`
  it("reads design.json's app.tagline: one trimmed line, or nothing", () => {
    expect(designTagline({ app: { tagline: '  Rooms, guests, done.  ' } })).toBe(
      'Rooms, guests, done.'
    )
    expect(designTagline({ app: { name: 'x' } })).toBeNull()
    expect(designTagline({ app: { tagline: 'two\nlines' } })).toBeNull()
    expect(designTagline(null)).toBeNull()
  })

  it('rewrites LOGIN_PANEL.tagline only, quoting for an apostrophe', () => {
    expect(applyTagline(source, 'Rooms, guests, done.')).toContain(
      "  tagline: 'Rooms, guests, done.',"
    )
    expect(applyTagline(source, "The front desk's ledger")).toContain(
      '  tagline: "The front desk\'s ledger",'
    )
    expect(applyTagline(source, 'x')).toContain('`tagline` is the one line')
    expect(applyTagline('export const OTHER = 1\n', 'x')).toBeNull()
  })
})

describe('parseArgs', () => {
  it('parses flags, options and the two positionals', () => {
    expect(
      parseArgs(['--dry-run', '--domain', 'acme.io', '--colour', '#112233', 'acme', 'Acme Ops'])
    ).toEqual({
      dryRun: true,
      force: false,
      skipInstall: false,
      domain: 'acme.io',
      colour: '#112233',
      slug: 'acme',
      display: 'Acme Ops',
    })
  })

  it('reports usage problems instead of throwing', () => {
    expect(parseArgs([])).toEqual({ error: 'a slug is required' })
    expect(parseArgs(['--bogus', 'acme'])).toEqual({ error: 'unknown option --bogus' })
    expect(parseArgs(['--domain'])).toEqual({ error: '--domain needs a value' })
    expect(parseArgs(['rocketpod'])).toMatchObject({ error: expect.stringMatching(/kit's own/) })
    expect(parseArgs(['acme', 'A', 'extra'])).toMatchObject({
      error: expect.stringMatching(/extra/),
    })
    expect(parseArgs(['--colour', 'red', 'acme'])).toMatchObject({
      error: expect.stringMatching(/hex/),
    })
    expect(parseArgs(['--colour', '145', 'acme'])).toMatchObject({ colour: '145', slug: 'acme' })
    expect(parseArgs(['--help'])).toEqual({ help: true })
  })
})

describe('restartAppVersion', () => {
  const root = readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf8')
  const kitVersion = JSON.parse(root).version as string

  it("restarts the kit's own root package.json at 0.1.0 and empties the changelog", () => {
    const out = restartAppVersion(root, kitVersion)
    expect(out).not.toBeNull()
    expect(out?.from).toBe(kitVersion)
    expect(JSON.parse(out?.packageJson ?? '{}').version).toBe('0.1.0')
    // Only the version moved: every other line is byte-for-byte the kit's.
    const before = root.split('\n').filter(l => !/^\s*"version"/.test(l))
    const after = (out?.packageJson ?? '').split('\n').filter(l => !/^\s*"version"/.test(l))
    expect(after).toEqual(before)
    expect(out?.changelog).toMatch(/^# Changelog\n/)
    expect(out?.changelog).toMatch(/## Unreleased\n$/)
    expect(out?.changelog).not.toMatch(/## \d+\.\d+\.\d+/)
  })

  it("leaves an app's own numbering alone", () => {
    const own = root.replace(/("version"\s*:\s*")[^"]*/, '$12.3.4')
    expect(restartAppVersion(own, kitVersion)).toBeNull()
  })

  it('does nothing without a kit version to compare against', () => {
    expect(restartAppVersion(root, null)).toBeNull()
    expect(restartAppVersion('{"name":"x"}', kitVersion)).toBeNull()
  })

  it('rewrites the top-level version, never a nested one', () => {
    const pkg = `{\n  "name": "x",\n  "version": "1.0.0",\n  "engines": { "version": "1.0.0" }\n}\n`
    const out = restartAppVersion(pkg, '1.0.0')
    expect(JSON.parse(out?.packageJson ?? '{}')).toEqual({
      name: 'x',
      version: '0.1.0',
      engines: { version: '1.0.0' },
    })
  })
})

describe('renameKitManifest (launch.kit.json, kept by every copy)', () => {
  const REPO = path.resolve(__dirname, '../../../..')
  const text = readFileSync(path.join(REPO, KIT_MANIFEST_FILE), 'utf8')
  const names = deriveNames('my-app', 'My App', { domain: 'example.com' })

  it('finds the top-level kit block by scanning, past strings that contain braces', () => {
    const json =
      '{\n  "a": "{ \\"kit\\": {} }",\n  "kit": { "id": "x", "b": [1, { "c": "}" }] },\n  "z": 1\n}\n'
    const span = topLevelObjectSpan(json, 'kit')
    expect(span).not.toBeNull()
    const [start, end] = span ?? [0, 0]
    expect(JSON.parse(json.slice(start, end))).toEqual({ id: 'x', b: [1, { c: '}' }] })
    expect(topLevelObjectSpan('{ "a": { "kit": {} } }', 'kit')).toBeNull()
    expect(topLevelObjectSpan('{ "kit": "x" }', 'kit')).toBeNull()
  })

  it("keeps the kit block byte for byte and renames the env names the copy's scripts read", () => {
    const out = renameKitManifest(text, names)
    const before = JSON.parse(text)
    const after = JSON.parse(out.text)
    expect(after.kit).toEqual(before.kit)
    expect(after.kit.id).toBe(KIT.slug)
    expect(after.kit.name).toBe(KIT.display)
    expect(after.session.env).toEqual({
      skip: 'MY_APP_BOOTSTRAP_SKIP',
      allowRoot: 'MY_APP_ALLOW_ROOT',
    })
    // The provenance file keeps its name, and upstream references stay upstream.
    expect(after.scaffold.appManifest).toBe('.rocketflare.json')
    expect(after.plugins.defaults).toEqual(before.plugins.defaults)
    expect(out.total).toBe(2)
    expect(out.counts.env).toBe(2)
  })

  it('a plain applyReplacements would have renamed the kit — which is why it is special-cased', () => {
    expect(JSON.parse(applyReplacements(text, names).text).kit.id).toBe('my-app')
  })

  it('is the identity when nothing outside the kit block names the kit', () => {
    const plain = '{\n  "kit": { "id": "rocketpod", "name": "Rocketpod" },\n  "x": 1\n}\n'
    const out = renameKitManifest(plain, names)
    expect(out.total).toBe(0)
    expect(out.text).toBe(plain)
  })
})

describe('local port blocks — every copy gets its own ports', () => {
  const all = () => true
  const KIT_PORTS = [5432, 5433, 5533, 7070, 7433]

  it('lays a block out above both kits, and the last block still ends below 7000', () => {
    const first = portsForBlock(PORT_BLOCK_FIRST)
    expect(first).toEqual({
      base: 5600,
      devUi: 5610,
      devApi: 5611,
      testDb: 5633,
      devDbStart: 5640,
      testS3: 5670,
      devS3Start: 5680,
    })
    const last = portsForBlock(PORT_BLOCK_FIRST + (PORT_BLOCK_COUNT - 1) * PORT_BLOCK_SIZE)
    expect(last.devS3Start + 19).toBeLessThan(7000)
    for (let k = 0; k < PORT_BLOCK_COUNT; k += 1) {
      const b = portsForBlock(PORT_BLOCK_FIRST + k * PORT_BLOCK_SIZE)
      for (const port of [b.devUi, b.devApi, b.testDb, b.testS3, b.devDbStart, b.devS3Start])
        expect(KIT_PORTS).not.toContain(port)
    }
  })

  it('is stable per slug, spreads different slugs, and skips a block whose test ports are taken', () => {
    const a = choosePortBlock('acme-crm', all)
    expect(choosePortBlock('acme-crm', all)).toEqual(a)
    const bases = new Set(
      ['acme-crm', 'my-app', 'invoices', 'ops-portal', 'zeta'].map(
        s => choosePortBlock(s, all)?.base
      )
    )
    expect(bases.size).toBeGreaterThan(1)
    const held = new Set([a?.testDb])
    const moved = choosePortBlock('acme-crm', p => !held.has(p))
    expect(moved?.base).not.toBe(a?.base)
    expect(choosePortBlock('acme-crm', () => false)).toBeNull()
  })

  it('rewrites a port written as a port, never digits inside a uuid or a hash, and honours rename: keep', () => {
    const ports = portsForBlock(5800)
    const text = [
      'DATABASE_URL=postgresql://test:test@localhost:5533/my_app_test',
      '      - "5533:5432"',
      '      - "7433:7070"',
      'STORAGE_ENDPOINT=http://localhost:7433',
      'the test database (:5533) and `5533`',
      'export const TEST_DB_PORT = 5533',
      'id: "a1b2c3d4-5533-4e5f-8a9b-7433c0ffee00"',
      'sha512-ab5533cd7433ef==',
      'export const KIT_TEST_DB_PORTS = [5433, 5533] // rename: keep',
    ].join('\n')
    const { text: out, count } = rewritePorts(text, ports)
    expect(out.split('\n')).toEqual([
      'DATABASE_URL=postgresql://test:test@localhost:5833/my_app_test',
      '      - "5833:5432"',
      '      - "5870:7070"',
      'STORAGE_ENDPOINT=http://localhost:5870',
      'the test database (:5833) and `5833`',
      'export const TEST_DB_PORT = 5833',
      'id: "a1b2c3d4-5533-4e5f-8a9b-7433c0ffee00"',
      'sha512-ab5533cd7433ef==',
      'export const KIT_TEST_DB_PORTS = [5433, 5533] // rename: keep',
    ])
    expect(count).toBe(7)
  })

  it('moves the dev UI/API ports only where they are written as dev ports', () => {
    const ports = portsForBlock(5800)
    const text = [
      'APP_URL=http://localhost:3000',
      "  'http://127.0.0.1:3001',",
      'Vite (:3000) and `:3001`',
      'export const DEFAULT_UI_PORT = 3000',
      'export const DEFAULT_API_PORT: 3001',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell default, not a template
      'PORT=${DEV_API_PORT:-3001} node',
      '# DEV_UI_PORT=3000',
      // Not dev ports: a duration, the container's port, a longer number, a kept line.
      'const GRACE_MS = 3000',
      '              containerPort: 3001',
      'retry after 30001 ms',
      "  'http://localhost:3000', // rename: keep",
    ].join('\n')
    const { text: out, count } = rewriteDevServerPorts(text, ports)
    expect(out.split('\n')).toEqual([
      'APP_URL=http://localhost:5810',
      "  'http://127.0.0.1:5811',",
      'Vite (:5810) and `:5811`',
      'export const DEFAULT_UI_PORT = 5810',
      'export const DEFAULT_API_PORT: 5811',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell default, not a template
      'PORT=${DEV_API_PORT:-5811} node',
      '# DEV_UI_PORT=5810',
      'const GRACE_MS = 3000',
      '              containerPort: 3001',
      'retry after 30001 ms',
      "  'http://localhost:3000', // rename: keep",
    ])
    expect(count).toBe(8)
    expect(DEPLOY_PORT_PATHS.test('docker-compose.yml')).toBe(true)
    expect(DEPLOY_PORT_PATHS.test('deploy/helm/acme/templates/web.yaml')).toBe(true)
    expect(DEPLOY_PORT_PATHS.test('apps/web/src/api/middleware/cors.ts')).toBe(false)
  })

  it('moves the two dev range starts in bootstrap-lib', () => {
    const src = readFileSync(
      path.join(__dirname, '../../../../scripts/lib/bootstrap-lib.mjs'),
      'utf8'
    )
    const out = rewriteDevPortStarts(src, portsForBlock(6100))
    expect(out).toContain('export const DEV_DB_PORT_START = 6140')
    expect(out).toContain('export const DEV_S3_PORT_START = 6180')
  })
})
