/**
 * `scripts/upgrade.mjs`'s pure half: path classification against `.rocketflare.json` and the diff
 * translator. The `config` project — no database, no git, no network.
 *
 * The translator is the risky part. It rewrites a kit diff into an adopted app's names before
 * anything is applied, and it is only safe because of two properties asserted below: a
 * substitution moves columns and never lines (so `@@` headers stay valid), and `index` lines are
 * stripped (so `git apply --3way` cannot silently merge against a preimage that no longer
 * describes anything).
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import rawManifest from '../../../../.rocketflare.json'
import { deriveNames } from '../../../../scripts/lib/rename-lib.mjs'
import type { Manifest } from '../../../../scripts/lib/upgrade-lib.d.mts'
import {
  absentSurfaces,
  BinaryPatchError,
  classifyPath,
  countLines,
  defaultPluginEntries,
  defaultPluginEntryProblems,
  globToRegExp,
  isKitManifest,
  isVendored,
  KIT_ONLY_PATHS,
  kitOnlyGlobs,
  matchesAny,
  parseNote,
  splitDiff,
  stripIndexLines,
  translateBlock,
} from '../../../../scripts/lib/upgrade-lib.mjs'

// A JSON import widens every literal to `string`; the manifest's shape is the lib's contract.
const manifest = rawManifest as unknown as Manifest

const names = deriveNames('acme', 'Acme Logistics', { domain: 'acme.io' })

describe('globs', () => {
  it('* stops at a slash, ** does not', () => {
    expect(globToRegExp('apps/*/src').test('apps/web/src')).toBe(true)
    expect(globToRegExp('apps/*/src').test('apps/web/deep/src')).toBe(false)
    expect(globToRegExp('apps/**').test('apps/web/deep/src/x.ts')).toBe(true)
    expect(globToRegExp('apps/web/src/**').test('apps/web/src/x.ts')).toBe(true)
  })

  it('matchesAny is an or over globs', () => {
    expect(matchesAny('LICENSE', ['LICENSE', 'README.md'])).toBe(true)
    expect(matchesAny('CHANGELOG.md', ['LICENSE', 'README.md'])).toBe(false)
  })
})

describe('the manifest predicate', () => {
  it('says the kit is the kit and a copy is not', () => {
    // The predicate, both ways, on values rather than on whichever checkout is running this —
    // `app === null` IS the question, so a renamed copy answers `false` and is RIGHT to. Asserting
    // `isKitManifest(manifest) === true` against the repo's own file made every adopted copy's
    // `pnpm test` red on its first run, which is the opposite of what D27 promises.
    expect(isKitManifest({ ...manifest, app: null })).toBe(true)
    expect(
      isKitManifest({ ...manifest, app: { slug: 'acme', display: 'Acme', domain: 'acme.io' } })
    ).toBe(false)
    // …and this checkout agrees with itself, whichever of the two it is.
    expect(isKitManifest(manifest)).toBe(manifest.app === null)
  })

  it('finds the surfaces whose anchor is gone', () => {
    const withoutAgent = ['README.md']
    expect(absentSurfaces(manifest, withoutAgent)).toContain('example-agent-summarize-text')
    expect(absentSurfaces(manifest, withoutAgent).length).toBe(manifest.surfaces.length)
  })
})

describe('classifyPath', () => {
  const base = { manifest, existsLocally: true, change: 'modified' as const }

  it('drops anything under a surface this app deleted — the rule that matters most', () => {
    const c = classifyPath('apps/web/src/api/services/agents/examples/summarize-text.ts', {
      ...base,
      absent: ['example-agent-summarize-text'],
    })
    expect(c.class).toBe('skipped-surface-absent')
    expect(c.surface).toBe('example-agent-summarize-text')
    expect(c.translate).toBe(false)
  })

  it('never touches a file an installed plugin owns, even though the kit shipped it', () => {
    // D31: a plugin has its own repository and its own release chain. A kit diff that rewrote its
    // files would be porting one version of a plugin over another, with neither side told.
    const withPlugin = {
      ...manifest,
      surfaces: [
        ...manifest.surfaces,
        {
          id: 'approvals',
          kind: 'plugin' as const,
          label: 'Approvals',
          anchor: 'apps/web/src/plugins/approvals/plugin.json',
          paths: ['apps/web/src/plugins/approvals/**'],
          registries: ['apps/web/src/plugins/server.ts'],
        },
      ],
    }
    const c = classifyPath('apps/web/src/plugins/approvals/api/routes.ts', {
      ...base,
      manifest: withPlugin,
    })
    expect(c.class).toBe('skipped-plugin-owned')
    expect(c.surface).toBe('approvals')
    expect(c.translate).toBe(false)
    expect(c.reason).toMatch(/pnpm plugin upgrade approvals/)
  })

  it('still drops a plugin whose anchor is gone as absent, not as plugin-owned', () => {
    // Order matters: "the adopter removed it" is the stronger statement, and an uninstalled
    // plugin's leftovers must not be recreated by an upgrade any more than a deleted example is.
    const withPlugin = {
      ...manifest,
      surfaces: [
        ...manifest.surfaces,
        {
          id: 'approvals',
          kind: 'plugin' as const,
          label: 'Approvals',
          anchor: 'apps/web/src/plugins/approvals/plugin.json',
          paths: ['apps/web/src/plugins/approvals/**'],
          registries: [],
        },
      ],
    }
    const c = classifyPath('apps/web/src/plugins/approvals/api/routes.ts', {
      ...base,
      manifest: withPlugin,
      absent: ['approvals'],
    })
    expect(c.class).toBe('skipped-surface-absent')
  })

  it('never applies a kit migration', () => {
    const c = classifyPath('apps/web/migrations/0007_add_thing.sql', base)
    expect(c.class).toBe('migration-derived')
    expect(classifyPath('apps/web/migrations/meta/_journal.json', base).class).toBe(
      'migration-derived'
    )
    expect(c.reason).toMatch(/db:generate/)
  })

  it('sends the env examples to a human', () => {
    expect(classifyPath('apps/web/.env.example', base).class).toBe('manual-env')
  })

  it('keeps kit-only files out of an app', () => {
    for (const p of [
      'LICENSE',
      'SECURITY.md',
      'scripts/install.sh',
      'docs/ADAPTING.md',
      'pnpm-lock.yaml',
    ]) {
      expect(classifyPath(p, base).class, p).toBe('skipped-kit-only')
    }
  })

  it("never ports the kit's own tests, whatever the kit did to them", () => {
    // `kitOnly` (docs/CONCEPTS.md §13): true of the kit repository and of nothing made from it.
    for (const change of ['added', 'modified', 'deleted'] as const) {
      const c = classifyPath('apps/web/tests/kit-only/upgrade-notes.test.ts', {
        ...base,
        change,
        existsLocally: false,
        includeKitTooling: true,
      })
      expect(c.class, change).toBe('skipped-kit-only')
      expect(c.translate).toBe(false)
    }
  })

  it("honours the floor for a manifest that predates `kitOnly`, and the TARGET kit's list", () => {
    // `.rocketflare.json` is never ported, so an older copy's file has no `kitOnly` key at all.
    const older = { ...manifest, kitOnly: undefined }
    expect(
      classifyPath('apps/web/tests/kit-only/x.test.ts', { ...base, manifest: older }).class
    ).toBe('skipped-kit-only')
    // A path a LATER kit declares kit-only, which this copy's manifest has never heard of.
    const later = 'apps/cli/tests/kit-only/release.test.ts'
    expect(
      classifyPath(later, { ...base, manifest: older, change: 'added', existsLocally: false }).class
    ).toBe('added')
    expect(
      classifyPath(later, {
        ...base,
        manifest: older,
        change: 'added',
        existsLocally: false,
        kitOnly: ['apps/cli/tests/kit-only/**'],
      }).class
    ).toBe('skipped-kit-only')
  })

  it('ports the kit tooling untranslated when asked', () => {
    const c = classifyPath('scripts/rename.mjs', { ...base, includeKitTooling: true })
    expect(c.class).toBe('verbatim')
    expect(c.translate).toBe(false)
  })

  it('treats the README and CI as decisions, not edits', () => {
    expect(classifyPath('README.md', base).class).toBe('manual')
    expect(classifyPath('.github/workflows/deploy.yml', base).class).toBe('manual')
  })

  it('reads a file the adopter deleted as skipped, not as an error', () => {
    const c = classifyPath('apps/web/src/api/routes/members.ts', { ...base, existsLocally: false })
    expect(c.class).toBe('skipped-locally-deleted')
  })

  it('separates a clean add from one that collides', () => {
    expect(
      classifyPath('apps/web/src/api/routes/new.ts', {
        ...base,
        change: 'added',
        existsLocally: false,
      }).class
    ).toBe('added')
    expect(
      classifyPath('apps/web/src/api/routes/new.ts', {
        ...base,
        change: 'added',
        existsLocally: true,
      }).class
    ).toBe('added-collides')
  })

  it('never deletes on its own', () => {
    expect(
      classifyPath('apps/web/src/api/routes/old.ts', { ...base, change: 'deleted' }).class
    ).toBe('deleted')
  })

  it('classifies an ordinary source change as modified and translated', () => {
    const c = classifyPath('apps/web/src/api/index.ts', base)
    expect(c.class).toBe('modified')
    expect(c.translate).toBe(true)
  })
})

const PATCH = `diff --git a/apps/web/src/api/index.ts b/apps/web/src/api/index.ts
index 1234abc..5678def 100644
--- a/apps/web/src/api/index.ts
+++ b/apps/web/src/api/index.ts
@@ -1,4 +1,4 @@ export function createApp(rocketpod: string) {
 import { thing } from '@rocketpod/shared/errors'
-const name = 'rocketpod-web'
+const name = 'rocketpod-worker'
 export const ROCKETPOD_KEY = 'rocketpod_'
diff --git a/LICENSE b/LICENSE
index aaa..bbb 100644
--- a/LICENSE
+++ b/LICENSE
@@ -1,2 +1,2 @@
-Copyright Rocketpod
+Copyright Rocketpod Ltd
`

describe('kit-only wiring', () => {
  it('unions the floor, the manifest and the extra list, once each', () => {
    expect(kitOnlyGlobs(null)).toEqual([...KIT_ONLY_PATHS])
    expect(kitOnlyGlobs({ kitOnly: ['a/**', ...KIT_ONLY_PATHS] }, ['a/**', 'b/**'])).toEqual([
      ...KIT_ONLY_PATHS,
      'a/**',
      'b/**',
    ])
  })
})

describe('isVendored', () => {
  // ONE implementation, in this file, re-exported by plugin-lib. The two that existed disagreed:
  // this one normalises the URL, the other compared strings exactly — so the same plugin could be
  // vendored for `kit:release` and third-party for `plugin check`, over one manifest.
  const KIT_REPO = 'https://github.com/rocketflare-dev/rocketflare.git'

  it('normalises a trailing slash and a missing .git, and refuses a subdirectory', () => {
    expect(isVendored({ repo: KIT_REPO, subdir: '' }, KIT_REPO)).toBe(true)
    expect(isVendored({ repo: KIT_REPO }, KIT_REPO)).toBe(true)
    expect(isVendored({ repo: 'https://github.com/rocketflare-dev/rocketflare' }, KIT_REPO)).toBe(
      true
    )
    expect(isVendored({ repo: `${KIT_REPO}/` }, KIT_REPO)).toBe(true)
    expect(isVendored({ repo: KIT_REPO, subdir: 'plugins/x' }, KIT_REPO)).toBe(false)
    expect(isVendored({ repo: 'https://github.com/acme/p.git' }, KIT_REPO)).toBe(false)
    expect(isVendored(null, KIT_REPO)).toBe(false)
    expect(isVendored({ repo: '' }, KIT_REPO)).toBe(false)
  })
})

describe('default plugins', () => {
  // `defaultPlugins` is what a fresh clone installs and what `kit:release` refuses to ship past
  // (D31, decision 5). The entries are OBJECTS because a bare id says nothing about where the
  // plugin comes from; a string still parses, and is then reported as having no repo rather than
  // having a URL guessed for it.
  const KIT = 'https://github.com/rocketflare-dev/rocketflare.git'

  it('normalises both shapes and defaults the optional fields', () => {
    expect(
      defaultPluginEntries({
        defaultPlugins: [{ id: 'analytics', repo: KIT, ref: '0.6.0' }, 'legacy'],
      } as never)
    ).toEqual([
      { id: 'analytics', repo: KIT, ref: '0.6.0', subdir: '' },
      { id: 'legacy', repo: null, ref: null, subdir: '' },
    ])
    expect(defaultPluginEntries(null)).toEqual([])
    expect(defaultPluginEntries({} as never)).toEqual([])
  })
})

describe('defaultPluginEntryProblems', () => {
  // The shape check, alone. Four callers share it — `kit:release`, the bootstrap's plugins step and
  // both GitHub workflows (through `scripts/default-plugins.mjs`) — and before that they answered
  // the same question three different ways.
  const entries = (list: unknown[]) =>
    defaultPluginEntries({ defaultPlugins: list } as unknown as Manifest)

  it('passes a well-formed list', () => {
    expect(
      defaultPluginEntryProblems(entries([{ id: 'a', repo: 'https://x.test/a.git', ref: '1.0.0' }]))
    ).toEqual([])
    expect(defaultPluginEntryProblems([])).toEqual([])
    expect(defaultPluginEntryProblems(undefined)).toEqual([])
  })

  it('reports a missing id, a missing repo and a duplicate — all of them, in one pass', () => {
    const problems = defaultPluginEntryProblems(
      entries([
        { repo: 'https://x.test/a.git' },
        { id: 'b' },
        { id: 'c', repo: 'https://x.test/c.git' },
        { id: 'c', repo: 'https://x.test/c.git' },
      ])
    )
    expect(problems).toEqual([
      expect.stringContaining('has no "id"'),
      expect.stringContaining(`'b' has no "repo"`),
      expect.stringContaining(`lists 'c' twice`),
    ])
  })

  it('treats a bare STRING as an id with no repo, which is what it is', () => {
    // Not "not an object": the entry names something, it just cannot be fetched.
    expect(defaultPluginEntryProblems(entries(['analytics']))[0]).toMatch(
      /'analytics' has no "repo"/
    )
  })
})

describe('splitDiff', () => {
  it('splits on the file header and keeps each block whole', () => {
    const blocks = splitDiff(PATCH)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].header).toContain('apps/web/src/api/index.ts')
    expect(blocks[1].header).toContain('LICENSE')
    expect(blocks[0].raw).toContain('@@ -1,4 +1,4 @@')
  })

  it('is empty for an empty diff', () => {
    expect(splitDiff('')).toEqual([])
  })
})

describe('translateBlock', () => {
  const [source, license] = splitDiff(PATCH)

  it('rewrites the body into the app’s names', () => {
    const t = translateBlock(source, names)
    expect(t).toContain("from '@acme/shared/errors'")
    expect(t).toContain("-const name = 'acme-web'")
    expect(t).toContain("+const name = 'acme-worker'")
    expect(t).toContain('ACME_KEY')
    expect(t).toContain("'acme_'")
    expect(t).not.toContain('rocketpod')
  })

  it('leaves the hunk header counts byte-identical', () => {
    const t = translateBlock(source, names)
    expect(t).toContain('@@ -1,4 +1,4 @@')
    // Against the STRIPPED original: dropping `index` lines is the only length change allowed.
    expect(countLines(stripIndexLines(source.raw))).toBe(countLines(t))
  })

  it('strips the index lines so --3way cannot silently misbehave', () => {
    expect(source.raw).toMatch(/^index /m)
    expect(translateBlock(source, names)).not.toMatch(/^index /m)
  })

  it('translates the path lines even when the body is left alone', () => {
    const t = translateBlock(license, names, { translate: false })
    expect(t).toContain('-Copyright Rocketpod')
    expect(t).toContain('+Copyright Rocketpod Ltd')
    expect(countLines(stripIndexLines(license.raw))).toBe(countLines(t))
  })

  it('refuses a binary block rather than corrupting base85', () => {
    const binary = splitDiff(
      `diff --git a/logo.png b/logo.png
index a..b 100644
GIT binary patch
literal 12
zcmZQ
`
    )[0]
    expect(() => translateBlock(binary, names)).toThrow(BinaryPatchError)
  })
})

describe('parseNote', () => {
  it('reads scalars, booleans, lists and a literal null', () => {
    const note = parseNote(`---
version: 0.5.0
previous: null
breaking: true
migrations: ["a budget column"]
areas: [api, ui]
---

## What changed
body
`)
    expect(note?.data).toMatchObject({
      version: '0.5.0',
      previous: null,
      breaking: true,
      migrations: ['a budget column'],
      areas: ['api', 'ui'],
    })
    expect(note?.body).toContain('## What changed')
  })

  it('reads a block sequence, which is how three long migrations are written', () => {
    const note = parseNote(`---
version: 0.6.0
migrations:
  - "conversations gains a rolling summary"
  - "messages gains nullable provider and model columns"
areas: [api]
---

## What changed
`)
    expect(note?.data.migrations).toEqual([
      'conversations gains a rolling summary',
      'messages gains nullable provider and model columns',
    ])
    expect(note?.data.areas).toEqual(['api'])
  })

  it('keeps a comma inside a quoted item instead of splitting on it', () => {
    // A migrations entry is a human sentence, and sentences contain commas. Splitting on every
    // one turns a description into fragments — a corrupted note rather than a rejected one.
    const note = parseNote(`---
migrations: ["group types, groups and membership, and a visibility column", "a second one"]
---

## What changed
`)
    expect(note?.data.migrations).toEqual([
      'group types, groups and membership, and a visibility column',
      'a second one',
    ])
  })

  it('reads an empty key as null, not as an empty list', () => {
    const note = parseNote(`---
previous:
areas: [api]
---

## What changed
`)
    expect(note?.data.previous).toBeNull()
  })

  it('is null without frontmatter', () => {
    expect(parseNote('# just a heading\n')).toBeNull()
  })
})

/**
 * `mirror().isAncestor` — the predicate behind `kit:upgrade`'s "this diff runs BACKWARDS" warning.
 *
 * The failure it guards against is not a crash: with an untagged branch head as `--from`,
 * `latestTag()` picks an OLDER release as `--to` and the report says "the kit deleted 22 file(s)",
 * listing whole subsystems. Exercised against this repository's own history, which always has at
 * least two commits.
 */
describe('mirror().isAncestor', () => {
  it('knows which way round two commits are', async () => {
    const { mirror } = await import('../../../../scripts/lib/git-lib.mjs')
    const repo = mirror(path.resolve(__dirname, '../../../..'))
    expect(repo.isAncestor('HEAD~1', 'HEAD')).toBe(true)
    expect(repo.isAncestor('HEAD', 'HEAD~1')).toBe(false)
    // A commit is its own ancestor, which is why `upgrade.mjs` answers "already on it" first.
    expect(repo.isAncestor('HEAD', 'HEAD')).toBe(true)
  })
})
