/**
 * `gatedDecision` and `successfulCiRuns` (`scripts/release-check.mjs`): the "is this commit already
 * gated?" rule a deploy workflow asks before gating again, driven with a fake API, because its
 * failure mode is the security property — any doubt must mean "gate here". `--version-only` itself
 * is `tests/config/release-version-only.test.ts`. What `ci.yml` runs is checked by running it
 * (`.claude/rules/testing.md`: no test reads workflow YAML). The `config` project: no database.
 */
import { describe, expect, it } from 'vitest'
import { gatedDecision, successfulCiRuns } from '../../../../scripts/release-check.mjs'

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
