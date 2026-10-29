/**
 * `pnpm gate` and `pnpm test` (docs/CONCEPTS.md §4): the step list is the contract Launch reads,
 * and the test plan runs every project — the `driver` conformance project included — on the
 * target an explicit variable picks, never the shape of a URL.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { gateListSchema } from '@rocketpod/shared/gate'
import { describe, expect, it } from 'vitest'
import {
  GATE_STEPS,
  gateList,
  gateVerdict,
  parseGateArgs,
} from '../../../../scripts/lib/gate-lib.mjs'
import type { TestPlan } from '../../../../scripts/lib/test-plan.d.mts'
import { parseTestArgs, planTests, resolveTarget } from '../../../../scripts/lib/test-plan.mjs'

const REPO = path.resolve(__dirname, '../../../..')
const GATE_BRANCH = {
  DATABASE_URL: 'postgresql://o:p@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/db',
  TEST_DATABASE_BRANCH: 'gate-ab12cd-1',
  TEST_DATABASE_ENDPOINT: 'ep-cool-name-123456',
}

function plan(
  env: Record<string, string | undefined>,
  kitOnly = false,
  argv: string[] = []
): TestPlan {
  const args = parseTestArgs(argv)
  if (!('only' in args)) throw new Error(`bad argv ${argv.join(' ')}`)
  const p = planTests(env, { kitOnly }, args)
  if ('error' in p) throw new Error(p.error)
  return p
}

/** The web vitest steps as `projects @ driver`. */
function webRuns(p: TestPlan): string[] {
  return p.steps
    .filter(s => s.command.includes('vitest'))
    .map(s => {
      const projects = s.command.flatMap((a, i) => (s.command[i - 1] === '--project' ? [a] : []))
      return `${projects.join('+')} @ ${s.env.DATABASE_DRIVER}`
    })
}

describe('pnpm gate', () => {
  it('lists lint → typecheck → test → build, in the shape the shared schema parses', () => {
    const list = gateListSchema.parse(gateList())
    expect(list.steps.map(s => s.id)).toEqual(['lint', 'typecheck', 'test', 'build'])
    expect(list.steps.filter(s => s.database).map(s => s.id)).toEqual(['test'])
    expect(GATE_STEPS.find(s => s.id === 'test')?.command).toEqual(['pnpm', 'test'])
  })

  it('parses steps, --skip and --keep-going, and keeps gate order', () => {
    expect(parseGateArgs([])).toEqual({
      list: false,
      json: false,
      keepGoing: false,
      steps: ['lint', 'typecheck', 'test', 'build'],
    })
    expect(parseGateArgs(['build', 'lint'])).toMatchObject({ steps: ['lint', 'build'] })
    expect(parseGateArgs(['--skip', 'test', '--skip=build'])).toMatchObject({
      steps: ['lint', 'typecheck'],
    })
    expect(parseGateArgs(['--keep-going'])).toMatchObject({ keepGoing: true })
    expect(parseGateArgs(['--list', '--json'])).toMatchObject({ list: true, json: true })
    expect(parseGateArgs(['--help'])).toEqual({ help: true })
  })

  it('refuses what it cannot mean', () => {
    expect(parseGateArgs(['generated'])).toMatchObject({
      error: expect.stringMatching(/unknown step/),
    })
    expect(parseGateArgs(['--skip'])).toMatchObject({ error: expect.stringMatching(/--skip/) })
    expect(parseGateArgs(['--json'])).toMatchObject({ error: expect.stringMatching(/--list/) })
    expect(parseGateArgs(['--list', 'test'])).toMatchObject({ error: expect.any(String) })
    expect(parseGateArgs(['test', '--skip', 'test'])).toMatchObject({
      error: 'nothing left to run',
    })
    expect(parseGateArgs(['--fast'])).toMatchObject({
      error: expect.stringMatching(/unknown option/),
    })
  })
})

describe('pnpm test: the target', () => {
  it('is local by default, remote only when TEST_DATABASE_BRANCH names a branch', () => {
    expect(resolveTarget({})).toEqual({ target: 'local' })
    expect(resolveTarget(GATE_BRANCH)).toEqual({ target: 'remote' })
    // A remote-looking URL alone is NOT a remote target: the local guard refuses it instead.
    expect(resolveTarget({ DATABASE_URL: GATE_BRANCH.DATABASE_URL })).toEqual({ target: 'local' })
  })

  it('refuses conflicting or retired signals rather than guessing', () => {
    expect(resolveTarget({ TEST_DATABASE_EPHEMERAL: '1' })).toMatchObject({
      error: expect.stringMatching(/without TEST_DATABASE_BRANCH/),
    })
    expect(resolveTarget({ GATE_SUITE_DRIVER: 'neon' })).toMatchObject({
      error: expect.stringMatching(/one driver/),
    })
  })
})

describe('pnpm test: the plan', () => {
  it('local: every package, then the web suite under postgres (driver conformance included)', () => {
    const p = plan({})
    expect(p.compose).toBe(true)
    expect(p.steps[0]?.command).toEqual(['pnpm', '-r', '--filter', '!./apps/web', 'test'])
    expect(webRuns(p)).toEqual(['api @ postgres', 'api-isolated+driver+ui+config @ postgres'])
    expect(p.steps[1]?.command).toContain('--no-isolate')
    for (const step of p.steps) expect(step.env.NEON_LOCAL_PROXY).toBeUndefined()
  })

  it('remote: no Docker, the whole suite under postgres against the branch', () => {
    const p = plan(GATE_BRANCH)
    expect(p.compose).toBe(false)
    expect(p.banner).toMatch(/gate-ab12cd-1/)
    expect(webRuns(p)).toEqual(['api @ postgres', 'api-isolated+driver+ui+config @ postgres'])
    for (const step of p.steps.filter(s => s.command.includes('vitest'))) {
      expect(step.env).toMatchObject({ TEST_DATABASE_EPHEMERAL: '1', APP_DATABASE_URL: '' })
      // The branch's own DATABASE_URL stands: the plan never sets one.
      expect(step.env.DATABASE_URL).toBeUndefined()
    }
    expect(p.notes).toEqual([])
  })

  it('names the kit-only project only when the checkout carries it', () => {
    expect(webRuns(plan({}, true))[1]).toBe('api-isolated+driver+ui+config+kit-only @ postgres')
    expect(webRuns(plan({}, false)).join('\n')).not.toMatch(/kit-only/)
    expect(existsSync(path.join(REPO, 'scripts/test.mjs'))).toBe(true)
  })
})

describe('pnpm test: --only and --shard (CI runs the plan in parts)', () => {
  /** A step with its `--shard` pair removed: what the unsharded run would execute. */
  function unsharded(command: string[]): string[] {
    const i = command.indexOf('--shard')
    return i === -1 ? command : [...command.slice(0, i), ...command.slice(i + 2)]
  }

  it('the parts, in plan order, are exactly the whole plan', () => {
    for (const env of [{}, GATE_BRANCH]) {
      const whole = plan(env, true)
      const parts = ['packages', 'api', 'rest'].flatMap(
        part => plan(env, true, ['--only', part]).steps
      )
      expect(parts).toEqual(whole.steps)
    }
  })

  it('N shards of rest are the unsharded rest run, each slice named once', () => {
    const [rest] = plan({}, false, ['--only', 'rest']).steps
    for (const count of [1, 3, 4]) {
      const shards = Array.from({ length: count }, (_, i) =>
        plan({}, false, ['--only', 'rest', '--shard', `${i + 1}/${count}`])
      )
      const slices = shards.map(p => {
        expect(p.steps).toHaveLength(1)
        const command = p.steps[0]?.command ?? []
        // Same projects, env and cwd as the unsharded run: vitest's --shard partitions its files.
        expect(unsharded(command)).toEqual(rest?.command)
        expect(p.steps[0]?.env).toEqual(rest?.env)
        return command[command.indexOf('--shard') + 1]
      })
      expect(new Set(slices)).toEqual(
        new Set(Array.from({ length: count }, (_, i) => `${i + 1}/${count}`))
      )
    }
  })

  it('starts the database only for a part that needs one', () => {
    expect(plan({}).compose).toBe(true)
    expect(plan({}, false, ['--only', 'packages']).compose).toBe(false)
    expect(plan({}, false, ['--only', 'api']).compose).toBe(true)
    expect(plan({}, false, ['--only=rest', '--shard=1/3']).compose).toBe(true)
    expect(plan(GATE_BRANCH, false, ['--only', 'api']).compose).toBe(false)
  })

  it('no flags is the whole plan; refuses what it cannot mean', () => {
    expect(parseTestArgs([])).toEqual({ only: null, shard: null })
    expect(parseTestArgs(['--only', 'rest', '--shard', '2/3'])).toEqual({
      only: 'rest',
      shard: { index: 2, count: 3 },
    })
    expect(parseTestArgs(['--help'])).toEqual({ help: true })
    expect(parseTestArgs(['--only', 'ui'])).toMatchObject({
      error: expect.stringMatching(/--only/),
    })
    expect(parseTestArgs(['--only', 'api', '--only', 'rest'])).toMatchObject({
      error: expect.stringMatching(/one part/),
    })
    for (const bad of ['0/3', '4/3', '1/0', '3', 'a/b']) {
      expect(parseTestArgs(['--only', 'rest', '--shard', bad])).toMatchObject({
        error: expect.stringMatching(/--shard/),
      })
    }
    expect(parseTestArgs(['--shard', '1/2'])).toMatchObject({
      error: expect.stringMatching(/only to --only rest/),
    })
    expect(parseTestArgs(['--only', 'api', '--shard', '1/2'])).toMatchObject({
      error: expect.stringMatching(/only to --only rest/),
    })
    expect(parseTestArgs(['api'])).toMatchObject({ error: expect.stringMatching(/unknown/) })
  })
})

describe('gateVerdict', () => {
  const ALL = GATE_STEPS.map(s => s.id)
  const at = { sha: 'abc', dirty: false, finishedAt: '2026-10-22T00:00:00.000Z' }
  const ok = (id: string) => ({ id, seconds: 1, ok: true })

  it('passes only when every requested step ran and none failed', () => {
    expect(gateVerdict({ requested: ALL, ran: ALL.map(ok), ...at })).toMatchObject({
      passed: true,
      full: true,
      failed: [],
    })
    // A stop at the first failure leaves the later steps unrun: failed, never passed.
    const stopped = gateVerdict({
      requested: ALL,
      ran: [ok('lint'), { id: 'typecheck', seconds: 3, ok: false }],
      ...at,
    })
    expect(stopped).toMatchObject({ passed: false, failed: ['typecheck'] })
    // A step that never ran is not a pass either, even with no failure recorded.
    expect(gateVerdict({ requested: ALL, ran: [ok('lint')], ...at }).passed).toBe(false)
  })

  it('marks a partial gate as not full, so `pnpm gate lint` is never read as the gate', () => {
    const v = gateVerdict({ requested: ['lint'], ran: [ok('lint')], ...at })
    expect(v).toMatchObject({ passed: true, full: false })
  })
})
