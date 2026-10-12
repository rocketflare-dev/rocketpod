/**
 * The guards that decide what `ci.yml` runs, and where — plus `gatedDecision`, the "is this commit
 * already gated?" rule a deploy workflow asks before gating again (M7 brings the image workflow
 * that calls it).
 *
 * Promises that live only in YAML, where nothing else would notice them regress:
 *   - `ci.yml`'s gate job runs `pnpm gate` and adds nothing of its own but the secrets scan — so
 *     what passes in CI is what passes on a laptop and in Launch's ship gate (docs/CONCEPTS.md §4).
 *     No `test-neon`, no `services:` database beside the compose file, no `--skip`. The one
 *     narrowing is `pnpm gate build` on a tree Launch already gated, opt-in through
 *     LAUNCH_GATE_APP_ID (the lookup's rules: `gate-verified.test.ts`).
 *
 * There is no YAML parser in the workspace, so the jobs are read by indentation (two spaces under
 * `jobs:`), which is all these files use. `gatedDecision` lives in `scripts/release-check.mjs`
 * and is driven here with a fake API, because its failure mode is the security property: any doubt
 * must mean "gate here". `--version-only` itself is `tests/config/release-version-only.test.ts`.
 * The kit's OWN workflow (kit.yml) is pinned by `tests/kit-only/kit-workflow.test.ts`: a copy has
 * none. The `config` project: no database.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { gatedDecision, successfulCiRuns } from '../../../../scripts/release-check.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const read = (f: string) => readFileSync(path.join(REPO_ROOT, '.github/workflows', f), 'utf8')
const CI = read('ci.yml')

/** A GitHub Actions expression, `${{ … }}`, as the workflow writes it. */
const expr = (inner: string) => `\${{ ${inner} }}`

/** The lines of one job: from `  <id>:` to the next two-space key (comments excluded). */
function job(workflow: string, id: string): string[] {
  const lines = workflow.split('\n')
  const start = lines.indexOf(`  ${id}:`)
  expect(start, `job ${id}`).toBeGreaterThan(-1)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(l => /^ {0,2}[\w-]+:/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).filter(l => !l.trim().startsWith('#'))
}

/** A job-level key's value, a `|` block folded onto one whitespace-normalised line. */
function key(lines: string[], name: string): string | undefined {
  const i = lines.findIndex(l => l.startsWith(`    ${name}:`))
  if (i === -1) return undefined
  const inline = (lines[i] ?? '').slice(`    ${name}:`.length).trim()
  if (inline !== '|') return inline
  const body: string[] = []
  for (const l of lines.slice(i + 1)) {
    if (!l.startsWith('      ') && l.trim() !== '') break
    body.push(l.trim())
  }
  return body.join(' ').replace(/\s+/g, ' ').trim()
}

/** Every command a job's steps run: a `run: x` line, or each line of a `run: |` block. */
function commands(lines: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? '').match(/^(\s*)(?:- )?run: (.*)$/)
    if (!m) continue
    if (m[2]?.trim() !== '|') {
      out.push(m[2]?.trim() ?? '')
      continue
    }
    const indent = (lines[i + 1] ?? '').match(/^ */)?.[0].length ?? 0
    for (const l of lines.slice(i + 1)) {
      if (l.trim() !== '' && !l.startsWith(' '.repeat(indent))) break
      if (l.trim()) out.push(l.trim())
    }
  }
  return out
}

describe('ci.yml', () => {
  it('has a gate job that runs pnpm gate, last — and is never skipped', () => {
    const gate = commands(job(CI, 'gate'))
    expect(gate.at(-1)).toBe('pnpm gate')
    expect(key(job(CI, 'gate'), 'name')).toBe('Gate')
    // No job-level condition and nothing to wait for: the one required check always runs, at once.
    expect(key(job(CI, 'gate'), 'if')).toBeUndefined()
    expect(key(job(CI, 'gate'), 'needs')).toBeUndefined()
  })

  it('adds nothing of substance to the gate but the secrets scan (and the scope it decides)', () => {
    const substantive = commands(job(CI, 'gate')).filter(
      c =>
        c !== 'pnpm gate' &&
        c !== 'pnpm gate build' &&
        c !== 'pnpm install --frozen-lockfile' &&
        !c.startsWith('nohup docker compose -f apps/web/docker-compose.test.yml') &&
        !c.startsWith('> "$RUNNER_TEMP/pull.log"') &&
        !/gitleaks/.test(c) &&
        // the attestation lookup
        c !== 'node scripts/gate-verified.mjs'
    )
    expect(substantive).toEqual([])
  })

  it('runs the full gate unless the lookup step proved this tree was gated by Launch', () => {
    const text = job(CI, 'gate').join('\n')
    // The full gate is the fallback: any output but `true` (empty, `false`, a skipped step) runs it.
    expect(text).toMatch(/- if: steps\.verified\.outputs\.verified != 'true'\n\s+run: pnpm gate\n/)
    expect(text).toMatch(
      /if: steps\.verified\.outputs\.verified == 'true'\n\s+run: pnpm gate build\n/
    )
    // gitleaks is never conditional.
    const gitleaks = text.indexOf('- name: gitleaks')
    expect(text.slice(gitleaks, text.indexOf('run:', gitleaks))).not.toMatch(/if:/)
    // Same job, same checkout: the old cross-job `scope` re-read of the tree has nothing to guard.
    expect(text).not.toContain('needs.verified')
    expect(text).not.toContain('steps.scope')
  })

  it('looks up a Launch attestation FIRST, in Gate, only when LAUNCH_GATE_APP_ID is set', () => {
    const gate = job(CI, 'gate')
    const text = gate.join('\n')
    // Gate holds the lookup's read scopes — and deploy.yml's `ci` job grants exactly these.
    expect(text).toMatch(
      /permissions:\n\s+contents: read\n\s+checks: read\n\s+pull-requests: read\n/
    )
    expect(text).not.toMatch(/: write/)
    // The first step after the checkout, before any install.
    const steps = gate.filter(l => /^ {6}- /.test(l)).map(l => l.trim())
    expect(steps[0]).toBe('- uses: actions/checkout@v4')
    expect(steps[1]).toBe('- name: Verified by Launch?')
    const at = text.indexOf('- name: Verified by Launch?')
    const step = text.slice(at, text.indexOf('\n      - ', at + 1))
    expect(step).toContain('id: verified')
    expect(step).toContain("if: vars.LAUNCH_GATE_APP_ID != ''")
    expect(step).toContain('run: node scripts/gate-verified.mjs')
    expect(step).toContain(`LAUNCH_GATE_APP_ID: ${expr('vars.LAUNCH_GATE_APP_ID')}`)
    expect(step).toContain(`GITHUB_TOKEN: ${expr('github.token')}`)
    expect(step).toContain(`PR_HEAD_SHA: ${expr('github.event.pull_request.head.sha')}`)
    // One job: no second runner to queue for before the gate can start.
    const jobs = CI.slice(CI.indexOf('\njobs:\n'))
      .split('\n')
      .filter(l => /^ {2}[\w-]+:$/.test(l))
    expect(jobs).toEqual(['  gate:'])
  })

  it('has no second test job, no services: database and no skipped step', () => {
    expect(CI.split('\n')).not.toContain('  test-neon:')
    expect(CI).not.toMatch(/^\s+services:/m)
    expect(CI).not.toMatch(/pnpm gate[^\n]*--skip/)
    expect(CI).not.toMatch(/inputs\.deploy/)
  })

  it('is callable from another workflow, with no inputs', () => {
    expect(CI).toMatch(/\n {2}workflow_call:\n(?! {4}inputs:)/)
  })
})

const SHA = 'a'.repeat(40)
const PARENT = 'b'.repeat(40)

describe('gatedDecision', () => {
  const versionOnly =
    (problems: string[] = []) =>
    () => ({ parent: PARENT, problems })
  const runs = (counts: Record<string, number | null>) => (sha: string) => counts[sha] ?? 0

  it('(a) is gated when the commit itself has a successful CI run — today’s rule', () => {
    const asked: string[] = []
    const d = gatedDecision({
      sha: SHA,
      runs: sha => {
        asked.push(sha)
        return 2
      },
      versionOnly: () => {
        throw new Error('the parent must not be consulted once the commit itself is gated')
      },
    })
    expect(d.gated).toBe(true)
    expect(asked).toEqual([SHA])
  })

  it('(b) is gated when it is a version-only bump over a parent with a successful run', () => {
    const d = gatedDecision({ sha: SHA, runs: runs({ [PARENT]: 1 }), versionOnly: versionOnly() })
    expect(d).toEqual({
      gated: true,
      reason: expect.stringContaining(`version-only bump over ${PARENT}`),
    })
  })

  it('gates here when the bump is version-only but the parent has no successful run (yet)', () => {
    // A parent whose CI is still running counts as none: the API is asked for completed,
    // successful runs only, so the deploy gates itself rather than waiting.
    const d = gatedDecision({ sha: SHA, runs: runs({}), versionOnly: versionOnly() })
    expect(d.gated).toBe(false)
  })

  it('gates here when the commit is not version-only, however green its parent is', () => {
    const d = gatedDecision({
      sha: SHA,
      runs: runs({ [PARENT]: 5 }),
      versionOnly: versionOnly(['files other than the root package.json changed: src/a.ts']),
    })
    expect(d.gated).toBe(false)
    expect(d.reason).toContain('src/a.ts')
  })

  it('treats an unreadable API as no proof, for the commit and for its parent', () => {
    expect(gatedDecision({ sha: SHA, runs: () => null, versionOnly: versionOnly() }).gated).toBe(
      false
    )
    expect(
      gatedDecision({
        sha: SHA,
        runs: runs({ [SHA]: null, [PARENT]: null }),
        versionOnly: versionOnly(),
      }).gated
    ).toBe(false)
  })

  it('gates here when the version-only check itself throws', () => {
    const d = gatedDecision({
      sha: SHA,
      runs: runs({ [PARENT]: 1 }),
      versionOnly: () => {
        throw new Error('git exploded')
      },
    })
    expect(d).toEqual({ gated: false, reason: expect.stringContaining('git exploded') })
  })
})

describe('successfulCiRuns', () => {
  const exec = (body: string | Error) => () => {
    if (body instanceof Error) throw body
    return body
  }
  const runsBody = (runs: object[]) =>
    JSON.stringify({ total_count: runs.length, workflow_runs: runs })

  it('counts completed, successful push and pull_request runs on exactly that sha', () => {
    const body = runsBody([
      { event: 'push', conclusion: 'success', head_sha: SHA },
      { event: 'pull_request', conclusion: 'success', head_sha: SHA },
      { event: 'workflow_call', conclusion: 'success', head_sha: SHA },
      { event: 'push', conclusion: null, head_sha: SHA },
      { event: 'push', conclusion: 'success', head_sha: PARENT },
    ])
    expect(successfulCiRuns('acme/app', SHA, { exec: exec(body) })).toBe(2)
  })

  it('asks for the ci.yml runs of that sha', () => {
    const calls: string[][] = []
    successfulCiRuns('acme/app', SHA, {
      exec: (cmd, args) => {
        calls.push([cmd, ...args])
        return runsBody([])
      },
    })
    expect(calls).toEqual([
      [
        'gh',
        'api',
        `repos/acme/app/actions/workflows/ci.yml/runs?head_sha=${SHA}&status=success&per_page=100`,
      ],
    ])
  })

  it('answers null — no proof — when the API fails or answers something unexpected', () => {
    expect(successfulCiRuns('acme/app', SHA, { exec: exec(new Error('HTTP 403')) })).toBeNull()
    expect(successfulCiRuns('acme/app', SHA, { exec: exec('') })).toBeNull()
    expect(successfulCiRuns('acme/app', SHA, { exec: exec('null') })).toBeNull()
    expect(successfulCiRuns('acme/app', SHA, { exec: exec('{"message":"Not Found"}') })).toBeNull()
  })
})
