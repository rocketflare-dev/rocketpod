/**
 * `pnpm web docs:stale` — list every Guide page whose declared `sources` changed after its
 * `verified` commit The rules live in `scripts/lib/docs-stale.ts`; this file
 * is the git adapter and the CLI. Paths are repo-relative wherever it is run from.
 *
 * Usage:
 *   pnpm web docs:stale              # history: commits in verified..HEAD, with a diffstat
 *   pnpm web docs:stale --changed    # only the working tree + index vs HEAD (the Stop hook)
 *   pnpm web docs:stale --json       # machine-readable, for /rp-doc-sync
 *   pnpm web docs:stale --quiet      # print nothing when clean
 *   pnpm web docs:stale --changed --quiet --hook   # the Claude Code Stop hook (.claude/settings.json)
 *
 * `--hook` wraps the message as `{"systemMessage": …}`: a successful Stop hook's plain stdout
 * goes to the debug log, not the screen, and `systemMessage` is the documented way to show the
 * user a warning without blocking. (`hookSpecificOutput.additionalContext` would instead make
 * Claude continue the turn, so a stale doc would re-trigger it on every stop.) It always exits 0:
 * the hook is a reminder, never a gate.
 *
 * Exit 1 on a structural error (a doc missing `sources`/`verified`, a dead glob, an unknown sha);
 * staleness alone exits 0 — it is reported, not blocking. Needs full history (it is not in the
 * gate; a shallow clone cannot answer it).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  checkDocs,
  type DocsGit,
  exitCodeFor,
  type FileChange,
  formatReport,
  parseNumstatLine,
  parseNumstatLog,
} from './lib/docs-stale'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function lines(out: string): string[] {
  return out.split('\n').filter(Boolean)
}

const realGit: DocsGit = {
  listFiles: () => lines(git('ls-files', '--cached', '--others', '--exclude-standard')),
  readFile: file => readFileSync(path.join(root, file), 'utf8'),
  resolveCommit: ref => {
    try {
      return git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).trim() || null
    } catch {
      return null
    }
  },
  commitsSince: sha =>
    parseNumstatLog(git('log', '--no-renames', '--numstat', '--format=@@%H', `${sha}..HEAD`)),
  workingChanges: () => {
    const tracked = lines(git('diff', '--no-renames', '--numstat', 'HEAD'))
      .map(parseNumstatLine)
      .filter((c): c is FileChange => c !== null)
    const untracked = lines(git('ls-files', '--others', '--exclude-standard')).map(p => ({
      path: p,
      added: null,
      deleted: null,
    }))
    return [...tracked, ...untracked]
  },
}

const args = new Set(process.argv.slice(2))
const known = new Set(['--changed', '--json', '--quiet', '--hook'])
const unknown = [...args].filter(a => !known.has(a))
if (unknown.length > 0) {
  console.error(`docs:stale: unknown flag(s) ${unknown.join(', ')} — use ${[...known].join(', ')}`)
  process.exit(args.has('--hook') ? 0 : 2)
}

const report = checkDocs(realGit, { changed: args.has('--changed') })
if (args.has('--hook')) {
  const text = formatReport(report, { quiet: true })
  if (text) console.log(JSON.stringify({ systemMessage: text }))
  process.exit(0)
}
if (args.has('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const text = formatReport(report, { quiet: args.has('--quiet') })
  if (text) console.log(text)
}
process.exit(exitCodeFor(report))
