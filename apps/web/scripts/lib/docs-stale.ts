/**
 * The pure half of `pnpm web docs:stale`: which Guide pages describe code that has moved since
 * somebody last checked them. Scoped to the Guide — the engineering docs here
 * (`docs/CONCEPTS.md`) carry no frontmatter; a doc joins by adding a glob to `DOC_GLOBS`.
 *
 * A doc in scope declares, in YAML frontmatter, the code it describes and the commit at which it
 * was last checked against that code:
 *
 * ```yaml
 * sources: [apps/web/src/api/routes/auth/**, packages/shared/src/auth.ts]
 * verified: 2a22b5f
 * ```
 *
 * A doc is STALE when a file matching `sources` changed after `verified`. Staleness is reported,
 * never fatal — a refactor is not held hostage by prose. STRUCTURAL errors are fatal: a doc in
 * scope without `sources`/`verified`, a glob that matches nothing (it describes code that has
 * gone), or a `verified` sha git does not know.
 *
 * ⚠️ **A commit that touches the doc itself counts as a check.** `verified` cannot name the commit
 * it is written in, so the normal flow — fix the code, run /rp-doc-sync, bump `verified` to HEAD,
 * commit both — would otherwise leave the doc stale the moment it lands. Commits after `verified`
 * that also modify the doc are therefore not counted against it.
 *
 * Everything git-shaped goes through the `DocsGit` seam so the rules are testable without a repo.
 */
import path from 'node:path'
import { guidePageFrontmatterSchema } from '@rocketpod/shared/guide'
import { parse as parseYaml } from 'yaml'
import { isGuidePagePath } from '../../src/api/services/guide-content'

/** Repo-relative: where the Guide's pages live. */
export const GUIDE_CONTENT_PREFIX = 'apps/web/content/guide/'

/** Other docs that carry `sources` + `verified` (none yet). */
export const DOC_GLOBS: string[] = []

/** Guide pages: the content dir's pages — the Guide's own rule (`isGuidePagePath`). */
export function isGuidePage(file: string): boolean {
  return (
    file.startsWith(GUIDE_CONTENT_PREFIX) &&
    isGuidePagePath(file.slice(GUIDE_CONTENT_PREFIX.length))
  )
}

export function isDocInScope(file: string): boolean {
  return isGuidePage(file) || DOC_GLOBS.some(g => path.matchesGlob(file, g))
}

/** One owner for the shape: the Guide's schema already defines these two fields. */
const freshnessSchema = guidePageFrontmatterSchema.pick({ sources: true, verified: true })

export interface FileChange {
  path: string
  /** Lines added/deleted; null for binary files and untracked files. */
  added: number | null
  deleted: number | null
}

export interface CommitChanges {
  sha: string
  files: FileChange[]
}

/** Everything the check needs from git — faked in tests. */
export interface DocsGit {
  /** Tracked plus untracked-but-not-ignored files, repo-relative. */
  listFiles(): string[]
  readFile(file: string): string
  /** The full sha if `ref` names a commit, else null. */
  resolveCommit(ref: string): string | null
  /** Commits in `sha..HEAD`, each with its numstat (renames split into delete + add). */
  commitsSince(sha: string): CommitChanges[]
  /** Index + working tree vs HEAD, plus untracked files. */
  workingChanges(): FileChange[]
}

export interface StaleDoc {
  doc: string
  verified: string
  files: FileChange[]
}

export interface DocError {
  doc: string
  message: string
}

export interface DocsStaleReport {
  mode: 'history' | 'changed'
  checked: number
  stale: StaleDoc[]
  errors: DocError[]
}

/** The YAML between a leading `---` line and the next `---` line, or null when there is none. */
export function readFrontmatter(text: string): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return null
  const parsed: unknown = parseYaml(match[1] ?? '')
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null
}

function matchesAny(file: string, globs: string[]): boolean {
  return globs.some(g => path.matchesGlob(file, g))
}

/** Sum numstat rows per path, keeping null (binary/untracked) sticky. */
function mergeChanges(changes: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>()
  for (const c of changes) {
    const prev = byPath.get(c.path)
    if (!prev) {
      byPath.set(c.path, { ...c })
      continue
    }
    prev.added = prev.added === null || c.added === null ? null : prev.added + c.added
    prev.deleted = prev.deleted === null || c.deleted === null ? null : prev.deleted + c.deleted
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export function checkDocs(git: DocsGit, opts: { changed?: boolean } = {}): DocsStaleReport {
  const files = git.listFiles()
  const docs = files.filter(isDocInScope).sort()
  const errors: DocError[] = []
  const stale: StaleDoc[] = []
  const working = opts.changed ? git.workingChanges() : []
  const workingPaths = new Set(working.map(c => c.path))
  const historyCache = new Map<string, CommitChanges[]>()

  for (const doc of docs) {
    const fm = readFrontmatter(git.readFile(doc))
    if (!fm) {
      errors.push({ doc, message: 'no frontmatter (needs `sources:` and `verified:`)' })
      continue
    }
    const parsed = freshnessSchema.safeParse(fm)
    if (!parsed.success) {
      const fields = parsed.error.issues.map(i => i.path.join('.') || '(root)')
      errors.push({ doc, message: `bad or missing ${[...new Set(fields)].join(', ')}` })
      continue
    }
    const { sources, verified } = parsed.data

    for (const glob of sources) {
      if (!files.some(f => path.matchesGlob(f, glob))) {
        errors.push({ doc, message: `source glob matches no files: ${glob}` })
      }
    }
    const full = git.resolveCommit(verified)
    if (!full) {
      errors.push({ doc, message: `verified sha is not a known commit: ${verified}` })
      continue
    }

    let changed: FileChange[]
    if (opts.changed) {
      // The doc is being edited alongside the code — assume that edit is the sync.
      if (workingPaths.has(doc)) continue
      changed = working.filter(c => matchesAny(c.path, sources))
    } else {
      let commits = historyCache.get(full)
      if (!commits) {
        commits = git.commitsSince(full)
        historyCache.set(full, commits)
      }
      changed = commits
        .filter(commit => !commit.files.some(f => f.path === doc))
        .flatMap(commit => commit.files.filter(f => matchesAny(f.path, sources)))
    }
    if (changed.length > 0) stale.push({ doc, verified, files: mergeChanges(changed) })
  }

  return { mode: opts.changed ? 'changed' : 'history', checked: docs.length, stale, errors }
}

function stat(c: FileChange): string {
  if (c.added === null || c.deleted === null) return 'new/binary'
  return `+${c.added} -${c.deleted}`
}

/** Human output. Empty string when there is nothing to say and `quiet` is set. */
export function formatReport(report: DocsStaleReport, opts: { quiet?: boolean } = {}): string {
  const { stale, errors } = report
  if (opts.quiet && stale.length === 0 && errors.length === 0) return ''
  const lines: string[] = []

  if (report.mode === 'changed' && stale.length > 0) {
    lines.push(
      `These docs describe code you changed: ${stale.map(s => s.doc).join(', ')} — run /rp-doc-sync before committing.`
    )
    for (const s of stale) {
      for (const f of s.files) lines.push(`  ${s.doc} ← ${f.path} (${stat(f)})`)
    }
  } else if (stale.length > 0) {
    lines.push(`${stale.length} stale doc(s) — their sources changed after \`verified\`:`)
    for (const s of stale) {
      lines.push('', `${s.doc}  (verified ${s.verified})`)
      const width = Math.max(...s.files.map(f => f.path.length))
      for (const f of s.files) lines.push(`  ${f.path.padEnd(width)} | ${stat(f)}`)
    }
    lines.push('', 'Run /rp-doc-sync to check them against the code and bump `verified`.')
  }

  if (errors.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(`${errors.length} structural error(s):`)
    for (const e of errors) lines.push(`  ${e.doc}: ${e.message}`)
  }

  if (lines.length === 0) {
    lines.push(`docs:stale — ${report.checked} doc(s) checked, none stale.`)
  }
  return lines.join('\n')
}

/** Structural errors fail; staleness alone does not. */
export function exitCodeFor(report: DocsStaleReport): number {
  return report.errors.length > 0 ? 1 : 0
}

/** Parse `git log --numstat --format=@@%H` output into commits. */
export function parseNumstatLog(out: string): CommitChanges[] {
  const commits: CommitChanges[] = []
  let current: CommitChanges | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('@@')) {
      current = { sha: line.slice(2).trim(), files: [] }
      commits.push(current)
      continue
    }
    const row = parseNumstatLine(line)
    if (row && current) current.files.push(row)
  }
  return commits
}

/** One `added<TAB>deleted<TAB>path` row; `-` counts mean binary. */
export function parseNumstatLine(line: string): FileChange | null {
  const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
  if (!m) return null
  return {
    path: m[3] as string,
    added: m[1] === '-' ? null : Number(m[1]),
    deleted: m[2] === '-' ? null : Number(m[2]),
  }
}
