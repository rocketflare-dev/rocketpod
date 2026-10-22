/**
 * The kit's own tooling claims, moved out of `tests/config/` so a copy does not carry them: each
 * case either reads THIS checkout as the kit (`app: null`, the root version, the committed
 * `.rocketflare.json`) or covers a branch only the kit runs — cutting a release (default-plugin
 * floors, changelog sections, `isDeployable`) or the rename (kit-only unwiring, the fixed filenames
 * surviving it). The rename deletes `tests/kit-only/`, so a copy's gate never runs a case it could
 * not fail. The shapes a copy DOES run stay in `tests/config/{manifest,upgrade,update-check,
 * bootstrap}-lib.test.ts`. No database.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import rawManifest from '../../../../.rocketflare.json'
import { planDefaultPlugins } from '../../../../scripts/lib/bootstrap-lib.mjs'
import {
  hostKitVersion,
  MANIFEST_FILE,
  readManifest,
  SIDECAR_FILE,
} from '../../../../scripts/lib/manifest.mjs'
import { PLUGIN_MANIFEST_FILE } from '../../../../scripts/lib/plugin-lib.mjs'
import { applyReplacements, deriveNames, KIT } from '../../../../scripts/lib/rename-lib.mjs'
import { skipReason } from '../../../../scripts/lib/update-check-lib.mjs'
import type { Manifest } from '../../../../scripts/lib/upgrade-lib.d.mts'
import {
  behaviourFiles,
  defaultPluginEntries,
  defaultPluginProblems,
  hasChangelogSection,
  isDeployable,
  isKitManifest,
  stripKitOnlyWiring,
} from '../../../../scripts/lib/upgrade-lib.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const WEB_DIR = path.resolve(__dirname, '../..')
const committed = rawManifest as unknown as Manifest
const { isKit } = readManifest()

/**
 * The three filenames the whole plugin toolchain addresses by literal name — the provenance file,
 * its sidecar and a plugin repository's manifest — are the SAME in the kit and in every renamed
 * copy. `.rocketflare.json` is on the rename's exclusion list by design (it describes the kit), and
 * a plugin repository ships one filename for the whole ecosystem.
 *
 * Written as literals, `scripts/rename.mjs` rewrote all three: a copy renamed to `acme` looked for
 * `.acme.json`, found nothing, and every `pnpm plugin` command died with "not found" against a file
 * sitting in the root. Nothing in the kit's own suite could see it, because in the kit the two
 * spellings are the same string. Building them from `KIT.ecosystem` — which lives in a file the rename
 * skips — is what makes them survive, and this is the test that says so.
 */
describe('the fixed filenames survive a rename', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../../..')
  const names = deriveNames('acme', 'Acme')
  const translate = (rel: string) =>
    applyReplacements(readFileSync(path.join(REPO_ROOT, rel), 'utf8'), names).text

  it('belong to the kit, not to the app', () => {
    expect(MANIFEST_FILE).toBe(`.${KIT.ecosystem}.json`)
    expect(SIDECAR_FILE).toBe(`.${KIT.ecosystem}.local.json`)
    expect(PLUGIN_MANIFEST_FILE).toBe(`${KIT.ecosystem}-plugin.json`)
  })

  it('are not written as literals the rename can rewrite', () => {
    for (const rel of ['scripts/lib/manifest.mjs', 'scripts/lib/plugin-lib.mjs']) {
      const renamed = translate(rel)
      // Quoted, so a prose mention in a JSDoc block (which the rename also rewrites, harmlessly)
      // is not what this is about — only a STRING the code would then go looking for.
      expect(renamed).not.toMatch(/'\.acme\.json'/)
      expect(renamed).not.toMatch(/'acme-plugin\.json'/)
      expect(renamed).toContain('KIT.ecosystem')
    }
  })
})

describe('readManifest, on this checkout', () => {
  it('reads this repository, and agrees with the committed file about which it is', () => {
    const { manifest, isKit, sidecar, manifestPath, sidecarPath } = readManifest()
    // Not `toBe(true)`: this suite also runs in every adopted copy, where the honest answer is
    // `false`. What must hold in both is that `isKit` is the `app === null` question and nothing
    // else — a renamed app failing the kit's own identity assertion is a red gate on day one.
    expect(isKit).toBe(manifest?.app == null)
    // The provenance names the KIT even in a copy: the rename deliberately leaves this file alone.
    expect(manifest?.kit.name).toBe(KIT.slug)
    expect(manifestPath.endsWith(MANIFEST_FILE)).toBe(true)
    expect(sidecarPath.endsWith(SIDECAR_FILE)).toBe(true)
    // The sidecar is git-ignored, so a developer's checkout may legitimately have one; what must
    // hold either way is that `isKit` reads the COMMITTED file, never the merged view.
    expect(sidecar === null || typeof sidecar === 'object').toBe(true)
  })
})

describe('hostKitVersion in the kit', () => {
  const base = {
    kit: { name: KIT.slug, repo: 'r', version: '0.5.0', commit: null },
    app: null,
  } as unknown as Manifest

  it('is the root package.json version in the kit itself', () => {
    expect(hostKitVersion({ manifest: base, isKit: true }, '0.17.6')).toBe('0.17.6')
    expect(() => hostKitVersion({ manifest: base, isKit: true }, undefined)).toThrow(
      /root package\.json has no "version"/
    )
  })

  it('answers from readManifest for this checkout', () => {
    const read = readManifest()
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf8')
    )
    const expected = read.isKit ? pkg.version : read.manifest?.kit.version
    expect(hostKitVersion(read, pkg.version)).toBe(expected)
  })
})

describe('.rocketflare.json', () => {
  it('names the KIT, in the kit and in every copy', () => {
    // The rename leaves this file alone by design, so the provenance is the same string everywhere
    // — which is what `kit:upgrade` descends from.
    expect(committed.kit.name).toBe(KIT.slug)
    expect(committed.kit.repo).toMatch(/^https:\/\/github\.com\/.+\.git$/)
    // …and the two readers agree about which checkout this is, whichever it is.
    expect(isKitManifest(committed)).toBe(committed.app == null)
    expect(isKit).toBe(committed.app == null)
  })
})

describe('the update check, on this checkout', () => {
  // The real manifest: `app: null` in the kit, stamped by `rename.mjs` in a copy — and this test
  // ships to both, so it asserts the decision each one should get rather than assuming the kit.
  it('stays silent in the kit repository itself and checks a renamed copy — from the real manifest', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, '.rocketflare.json'), 'utf8'))
    const reason = skipReason({ source: 'startup', manifest, env: {} })
    if (manifest.app === null) expect(reason).toMatch(/kit itself/)
    else expect(reason).toBeNull()
  })
})

describe('the default plugins this kit ships', () => {
  it('matches what the kit ships in .rocketflare.json', () => {
    const { manifest } = readManifest(path.join(WEB_DIR, '../..'))
    expect(Array.isArray(manifest?.defaultPlugins)).toBe(true)
    expect(planDefaultPlugins(manifest?.defaultPlugins, []).problems).toEqual([])
  })
})

describe('kit-only wiring, as the rename strips it', () => {
  it('drops `--project kit-only` from every script and removes a script that only runs it', () => {
    const pkg = `${JSON.stringify(
      {
        name: '@acme/web',
        scripts: {
          'test:isolated': 'vitest run --project api-isolated --project config --project kit-only',
          'test:ephemeral': 'X=1 vitest run --project kit-only --project ui && echo done',
          'test:kit-only': 'vitest run --project kit-only',
          'test:config': 'vitest run --project config',
          other: 'vitest run --project kit-only-lookalike',
        },
      },
      null,
      2
    )}\n`
    const { text, removed, edited } = stripKitOnlyWiring(pkg)
    expect(removed).toEqual(['test:kit-only'])
    expect(edited).toEqual(['test:isolated', 'test:ephemeral'])
    const scripts = JSON.parse(text).scripts
    expect(scripts['test:isolated']).toBe('vitest run --project api-isolated --project config')
    expect(scripts['test:ephemeral']).toBe('X=1 vitest run --project ui && echo done')
    expect(scripts.other).toBe('vitest run --project kit-only-lookalike')
    expect(text.endsWith('}\n')).toBe(true)
  })

  it('returns the text untouched when there is nothing to unwire', () => {
    const pkg = '{\n  "scripts": { "test": "vitest run" }\n}\n'
    expect(stripKitOnlyWiring(pkg)).toEqual({ text: pkg, removed: [], edited: [] })
  })
})

describe('default plugins, at release time', () => {
  const KIT_REPO = 'https://github.com/rocketflare-dev/rocketflare.git'
  const ok = (minKit: string | null) => () => ({ ok: true, minKit })

  it('passes a plugin whose floor is at or below the version being cut', () => {
    const entries = defaultPluginEntries({
      defaultPlugins: [{ id: 'analytics', repo: 'https://example.test/a.git', ref: '0.2.0' }],
    } as never)
    expect(defaultPluginProblems(entries, '0.6.0', ok('0.5.0'))).toEqual([])
    // The floor is a floor: equal passes, and there is no ceiling to fall off the top of.
    expect(defaultPluginProblems(entries, '0.6.0', ok('0.6.0'))).toEqual([])
    expect(defaultPluginProblems(entries, '9.9.9', ok('0.5.0'))).toEqual([])
  })

  it('refuses a version BELOW the floor, naming the floor and the release', () => {
    const entries = defaultPluginEntries({
      defaultPlugins: [{ id: 'analytics', repo: 'https://example.test/a.git' }],
    } as never)
    const problems = defaultPluginProblems(entries, '0.6.0', ok('0.7.0'))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/analytics.*needs kit 0\.7\.0 or newer.*this release is 0\.6\.0/)
  })

  it('refuses an entry the resolver cannot reach, and one with no repo', () => {
    const entries = defaultPluginEntries({
      defaultPlugins: [
        { id: 'gone', repo: 'https://example.test/gone.git', ref: '9.9.9' },
        'nameless',
      ],
    } as never)
    const problems = defaultPluginProblems(entries, '0.6.0', entry =>
      entry.id === 'gone' ? { ok: false, reason: 'no such ref' } : { ok: true, minKit: '0.1.0' }
    )
    // Shape problems come first now: they are the whole of `defaultPluginEntryProblems`, and
    // somebody fixing a hand-edited list wants every one of them in one run.
    expect(problems).toEqual([
      expect.stringContaining('has no "repo"'),
      expect.stringContaining('no such ref'),
    ])
  })

  it('tells an unread floor, an OLD-SHAPE declaration and a real refusal apart', () => {
    // "I could not check", "this plugin was written against a contract this kit no longer reads"
    // and "I checked and it is too old" are three different answers with three different fixes,
    // and only the absence of all three may cut a release.
    const entries = defaultPluginEntries({
      defaultPlugins: [{ id: 'analytics', repo: 'https://example.test/a.git' }],
    } as never)
    expect(defaultPluginProblems(entries, '0.6.0', ok(null))[0]).toMatch(
      /cannot read its minKit floor/
    )
    // A manifest still carrying `requires.kit` is named, never silently skipped — the range is
    // carried out of the resolver for exactly this sentence, and is never used as a floor.
    const legacy = () => ({ ok: true, minKit: null, legacyRange: '>=0.5.0 <1.0.0' })
    const problem = defaultPluginProblems(entries, '0.6.0', legacy)[0]
    expect(problem).toMatch(/declares requires\.kit '>=0\.5\.0 <1\.0\.0'/)
    expect(problem).toMatch(/"minKit"/)
    // And a floor wearing range language is reported, not approximated: nothing here can read it.
    expect(defaultPluginProblems(entries, '0.6.0', ok('>=0.5.0'))[0]).toMatch(
      /not a bare X\.Y\.Z version/
    )
  })

  it('exempts a VENDORED plugin from the floor check, as §16 says', () => {
    // Same repository, no subdirectory: the same release cut both, so the floor describes the kit
    // it shipped inside rather than a compatibility claim.
    const entries = defaultPluginEntries({
      defaultPlugins: [{ id: 'example-feature', repo: KIT_REPO, ref: '0.4.0' }],
    } as never)
    expect(defaultPluginProblems(entries, '0.6.0', ok('9.9.9'), { kitRepo: KIT_REPO })).toEqual([])
    // …but a plugin in a SUBDIRECTORY of the kit repo is not vendored, and is checked.
    const sub = [{ id: 'x', repo: KIT_REPO, ref: null, subdir: 'plugins/x' }]
    expect(defaultPluginProblems(sub, '0.6.0', ok('9.9.9'), { kitRepo: KIT_REPO })).toHaveLength(1)
  })

  it('catches the same plugin listed twice', () => {
    const entries = defaultPluginEntries({
      defaultPlugins: [
        { id: 'a', repo: 'https://example.test/a.git' },
        { id: 'a', repo: 'https://example.test/a.git' },
      ],
    } as never)
    expect(defaultPluginProblems(entries, '0.6.0', ok('0.1.0'))).toEqual([
      expect.stringContaining("lists 'a' twice"),
    ])
  })
})

describe('behaviourFiles', () => {
  // The porting-note predicate, shared by the CI gate (`release-check --unreleased`) and the
  // pre-commit hook (`changelog-nudge.mjs`). They were two copies of one regex pair, and a hook
  // that disagrees with the gate is a hook people learn to ignore.
  it('is source under apps/ or packages/, tests and markdown excluded', () => {
    expect(
      behaviourFiles([
        'apps/web/src/api/index.ts',
        'packages/shared/src/jobs.ts',
        'apps/web/tests/api/chat.test.ts',
        'apps/web/src/api/thing.test.ts',
        'apps/web/src/ui/CLAUDE.md',
        'docs/CONCEPTS.md',
        'scripts/release.mjs',
        '.github/workflows/ci.yml',
      ])
    ).toEqual(['apps/web/src/api/index.ts', 'packages/shared/src/jobs.ts'])
    expect(behaviourFiles([])).toEqual([])
    expect(behaviourFiles(undefined)).toEqual([])
  })
})

describe('hasChangelogSection', () => {
  const changelog = '# Changelog\n\n## 0.6.10 — 2026-01-02\n\nx\n\n## 0.6.1 — 2026-01-01\n\ny\n'

  it('does not accept 0.6.10 as 0.6.1 — the bug a two-digit patch would have found', () => {
    // `changelog.includes('## 0.6.1')` is true of `## 0.6.10`, so the tag gate would have passed
    // on another release's section, in the direction that lets a release through.
    expect(hasChangelogSection('# Changelog\n\n## 0.6.10 — 2026-01-02\n', '0.6.1')).toBe(false)
    expect(hasChangelogSection(changelog, '0.6.1')).toBe(true)
    expect(hasChangelogSection(changelog, '0.6.10')).toBe(true)
    expect(hasChangelogSection(changelog, '0.7.0')).toBe(false)
  })

  it('anchors to the start of a line, so a mention in prose is not a section', () => {
    expect(hasChangelogSection('see ## 0.6.1 below\n', '0.6.1')).toBe(false)
  })
})

describe('isDeployable', () => {
  // This gates a release workflow, so the expensive mistake is a false "skip": somebody's
  // production release quietly not happening. Every ambiguous case must deploy.
  const KIT = { app: null } as unknown as Manifest
  const APP = { app: { slug: 'acme', display: 'Acme', domain: 'acme.io' } } as unknown as Manifest

  it('skips only the kit itself', () => {
    const d = isDeployable(KIT)
    expect(d.deployable).toBe(false)
    expect(d.reason).toContain('the kit itself')
  })

  it('deploys an app', () => {
    expect(isDeployable(APP).deployable).toBe(true)
  })

  it('deploys when there is no manifest at all', () => {
    expect(isDeployable(null).deployable).toBe(true)
  })
})
