/**
 * `pnpm web docs:stale` — the pure rules (`scripts/lib/docs-stale.ts`) over a fake git: which Guide
 * pages describe code that moved after their `verified` commit, and which are structurally broken.
 */
import { describe, expect, it } from 'vitest'
import {
  type CommitChanges,
  checkDocs,
  type DocsGit,
  exitCodeFor,
  type FileChange,
  formatReport,
  isDocInScope,
  parseNumstatLog,
  readFrontmatter,
} from '../../scripts/lib/docs-stale'

const G = 'apps/web/content/guide/'
const fm = (sources: string[], verified = 'aaaaaaa') =>
  `---\nsources:\n${sources.map(s => `  - ${s}`).join('\n')}\nverified: ${verified}\n---\n\n# Doc\n`

interface FakeRepo {
  files: Record<string, string>
  commits?: Record<string, CommitChanges[]>
  working?: FileChange[]
}

function fakeGit(repo: FakeRepo): DocsGit {
  return {
    listFiles: () => Object.keys(repo.files),
    readFile: f => repo.files[f] ?? '',
    resolveCommit: ref => (repo.commits && ref in repo.commits ? `${ref}full` : null),
    commitsSince: sha => repo.commits?.[sha.replace(/full$/, '')] ?? [],
    workingChanges: () => repo.working ?? [],
  }
}

const change = (path: string, added = 1, deleted = 0): FileChange => ({ path, added, deleted })

describe('scope', () => {
  it('takes Guide pages, not VOICE.md, _ dirs or the manifest', () => {
    expect(isDocInScope(`${G}admin/members.md`)).toBe(true)
    expect(isDocInScope(`${G}VOICE.md`)).toBe(false)
    expect(isDocInScope(`${G}_research/x.md`)).toBe(false)
    expect(isDocInScope(`${G}screenshots.yaml`)).toBe(false)
    expect(isDocInScope('docs/CONCEPTS.md')).toBe(false)
  })

  it('reads a leading YAML block and nothing else', () => {
    expect(readFrontmatter(fm(['src/a.ts']))).toEqual({
      sources: ['src/a.ts'],
      verified: 'aaaaaaa',
    })
    expect(readFrontmatter('# no frontmatter\n---\nx: 1\n---\n')).toBeNull()
  })
})

describe('history mode', () => {
  const page = `${G}start/a.md`

  it('reports a page whose sources changed after verified, with a summed diffstat', () => {
    const git = fakeGit({
      files: { [page]: fm(['packages/core/**']), 'packages/core/a.ts': '', 'apps/x.ts': '' },
      commits: {
        aaaaaaa: [
          { sha: 'c1', files: [change('packages/core/a.ts', 3, 1), change('apps/x.ts')] },
          { sha: 'c2', files: [change('packages/core/a.ts', 2, 2)] },
        ],
      },
    })
    const report = checkDocs(git)
    expect(report.errors).toEqual([])
    expect(report.stale).toEqual([
      {
        doc: page,
        verified: 'aaaaaaa',
        files: [{ path: 'packages/core/a.ts', added: 5, deleted: 3 }],
      },
    ])
    expect(exitCodeFor(report)).toBe(0)
    expect(formatReport(report)).toContain('packages/core/a.ts | +5 -3')
  })

  it('does not count a commit that also touched the page — that commit is the check', () => {
    const git = fakeGit({
      files: { [page]: fm(['packages/core/**']), 'packages/core/a.ts': '' },
      commits: {
        aaaaaaa: [{ sha: 'c1', files: [change('packages/core/a.ts'), change(page)] }],
      },
    })
    expect(checkDocs(git).stale).toEqual([])
  })

  it('fails on missing frontmatter fields, dead globs and unknown shas', () => {
    const git = fakeGit({
      files: {
        [`${G}start/a.md`]: '---\nsources: [src/a.ts]\n---\n',
        [`${G}start/b.md`]: fm(['src/gone/**']),
        [`${G}start/c.md`]: fm(['src/a.ts'], 'deadbeef'),
        'src/a.ts': '',
      },
      commits: { aaaaaaa: [] },
    })
    const report = checkDocs(git)
    expect(report.errors.map(e => e.doc.slice(G.length))).toEqual([
      'start/a.md',
      'start/b.md',
      'start/c.md',
    ])
    expect(report.errors[1]?.message).toContain('src/gone/**')
    expect(report.errors[2]?.message).toContain('deadbeef')
    expect(exitCodeFor(report)).toBe(1)
  })
})

describe('changed mode (the Stop hook)', () => {
  it('considers only working-tree changes, and skips a page being edited alongside them', () => {
    const a = `${G}start/a.md`
    const b = `${G}start/b.md`
    const git = fakeGit({
      files: { [a]: fm(['apps/web/src/ui/**']), [b]: fm(['apps/web/src/api/**']) },
      commits: { aaaaaaa: [{ sha: 'old', files: [change('apps/web/src/api/old.ts')] }] },
      working: [change('apps/web/src/ui/x.tsx', 4, 1)],
    })
    const report = checkDocs(git, { changed: true })
    expect(report.stale.map(s => s.doc)).toEqual([a])
    expect(formatReport(report, { quiet: true })).toContain('run /rp-doc-sync before committing')
    const editing = fakeGit({
      files: { [a]: fm(['apps/web/src/ui/**']) },
      commits: { aaaaaaa: [] },
      working: [change('apps/web/src/ui/x.tsx'), change(a)],
    })
    expect(checkDocs(editing, { changed: true }).stale).toEqual([])
  })
})

describe('parseNumstatLog', () => {
  it('splits commits and keeps binary counts null', () => {
    expect(parseNumstatLog('@@abc\n3\t1\ta.ts\n-\t-\tb.png\n@@def\n1\t0\tc.ts\n')).toEqual([
      {
        sha: 'abc',
        files: [
          { path: 'a.ts', added: 3, deleted: 1 },
          { path: 'b.png', added: null, deleted: null },
        ],
      },
      { sha: 'def', files: [{ path: 'c.ts', added: 1, deleted: 0 }] },
    ])
  })
})
