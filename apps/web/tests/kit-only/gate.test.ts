/**
 * `pnpm gate` and `pnpm test` (docs/CONCEPTS.md §4): the step list is the contract Launch reads,
 * and the test plan runs every project — the `driver` conformance project included — on the
 * target an explicit variable picks, never the shape of a URL.
 */
import { existsSync, readFileSync } from 'node:fs'
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
import {
  DEFAULT_TEST_PORTS,
  envTestPorts,
  parseTestArgs,
  planSuites,
  planTests,
  resolveTarget,
  testPortMismatches,
  testPorts,
} from '../../../../scripts/lib/test-plan.mjs'

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
      changed: null,
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
    expect(webRuns(p)).toEqual([
      'api @ postgres',
      'api-isolated+api-fixtures+driver+ui+ui-isolated+config+config-isolated @ postgres',
    ])
    // The shared registry is the project's own setting (vitest.config.ts), not a flag.
    expect(p.steps[1]?.command).not.toContain('--no-isolate')
    for (const step of p.steps) expect(step.env.NEON_LOCAL_PROXY).toBeUndefined()
  })

  it('remote: no Docker, the whole suite under postgres against the branch', () => {
    const p = plan(GATE_BRANCH)
    expect(p.compose).toBe(false)
    expect(p.banner).toMatch(/gate-ab12cd-1/)
    expect(webRuns(p)).toEqual([
      'api @ postgres',
      'api-isolated+api-fixtures+driver+ui+ui-isolated+config+config-isolated @ postgres',
    ])
    for (const step of p.steps.filter(s => s.command.includes('vitest'))) {
      expect(step.env).toMatchObject({ TEST_DATABASE_EPHEMERAL: '1', APP_DATABASE_URL: '' })
      // The branch's own DATABASE_URL stands: the plan never sets one.
      expect(step.env.DATABASE_URL).toBeUndefined()
    }
    expect(p.notes).toEqual([])
  })

  it('pnpm test web: the full web plan, without the other packages', () => {
    const p = planTests({}, { kitOnly: false, webOnly: true })
    if ('error' in p) throw new Error(p.error)
    expect(p.steps.map(s => s.label)).not.toContain('the other packages')
    expect(p.steps.map(s => s.part)).toEqual(['api', 'rest'])
  })

  it('names the kit-only project only when the checkout carries it', () => {
    expect(webRuns(plan({}, true))[1]).toBe(
      'api-isolated+api-fixtures+driver+ui+ui-isolated+config+config-isolated+kit-only @ postgres'
    )
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
    expect(parseTestArgs([])).toEqual({ only: null, shard: null, changed: null, positional: [] })
    expect(parseTestArgs(['--only', 'rest', '--shard', '2/3'])).toMatchObject({
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
    expect(parseTestArgs(['--bogus'])).toMatchObject({ error: expect.stringMatching(/unknown/) })
    expect(parseTestArgs(['api', '--only', 'rest'])).toMatchObject({
      error: expect.stringMatching(/not of a suite run/),
    })
    expect(parseTestArgs(['--changed=main', 'api'])).toMatchObject({
      error: expect.stringMatching(/on its own/),
    })
  })

  it('positional words are a suite run; web alone is the web plan', () => {
    expect(parseTestArgs(['api', 'tests/api/x.test.ts', '--sequence.shuffle.files'])).toMatchObject(
      { positional: ['api', 'tests/api/x.test.ts', '--sequence.shuffle.files'] }
    )
    expect(parseTestArgs(['web', '--only', 'api'])).toMatchObject({
      only: 'api',
      positional: ['web'],
    })
    const web = planTests({}, { kitOnly: false, webOnly: true })
    if ('error' in web) throw new Error(web.error)
    expect(web.steps.map(s => s.part)).toEqual(['api', 'rest'])
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

  it('marks a --changed pass as not full, and counts a step it skipped as run', () => {
    const v = gateVerdict({
      requested: ALL,
      ran: [
        ok('lint'),
        { id: 'typecheck', seconds: 0, ok: true, skipped: true },
        ok('test'),
        ok('build'),
      ],
      changed: true,
      ...at,
    })
    expect(v).toMatchObject({ passed: true, full: false, changed: true })
  })
})

describe('pnpm test <suite…>: the inner loop', () => {
  const suites = (input: Parameters<typeof planSuites>[1], env = {}) => {
    const p = planSuites(env, input)
    if ('error' in p) throw new Error(p.error)
    return p
  }
  const projects = (p: TestPlan) =>
    (p.steps[0]?.command ?? []).flatMap((a, i, all) => (all[i - 1] === '--project' ? [a] : []))

  it('a suite is its shared and isolated projects together, in one run', () => {
    const p = suites({ suites: ['api', 'ui'], files: [], kitOnly: false })
    expect(p.steps).toHaveLength(1)
    expect(projects(p)).toEqual(['api', 'api-isolated', 'api-fixtures', 'ui', 'ui-isolated'])
  })

  it('leaves the database alone: the inner loop expects it up, and never pulls the proxy', () => {
    expect(suites({ suites: ['driver'], files: [], kitOnly: false }).compose).toBe(false)
  })

  it('passes files through, and with no suite named runs every web project', () => {
    const p = suites({ suites: [], files: ['/w/tests/api/a.test.ts'], kitOnly: false })
    expect(projects(p)).not.toContain('kit-only')
    expect(projects(p)).toContain('config-isolated')
    expect(p.steps[0]?.command.at(-1)).toBe('/w/tests/api/a.test.ts')
  })

  it('refuses kit-only in a copy, and a suite it does not know', () => {
    expect(planSuites({}, { suites: ['kit-only'], files: [], kitOnly: false })).toHaveProperty(
      'error'
    )
    expect(planSuites({}, { suites: ['nope'], files: [], kitOnly: true })).toHaveProperty('error')
  })
})

describe('the test ports are read, never assumed (Rocketflare #178)', () => {
  it("reads the kit's own compose file and .env.test as :5533 / :7433, and they agree", () => {
    const compose = readFileSync(path.join(REPO, 'apps/web/docker-compose.test.yml'), 'utf8')
    const envTest = readFileSync(path.join(REPO, 'apps/web/.env.test'), 'utf8')
    expect(testPorts(compose)).toEqual(DEFAULT_TEST_PORTS)
    expect(envTestPorts(envTest)).toEqual(DEFAULT_TEST_PORTS)
    expect(testPortMismatches(testPorts(compose), envTestPorts(envTest))).toEqual([])
  })

  it("a copy's moved ports win, and a .env.test left on the old ones is named", () => {
    const compose = [
      'services:',
      '  postgres-test:',
      '    ports:',
      '      - "5633:5432"',
      '  s3-test:',
      '    ports:',
      '      - "127.0.0.1:7533:7070"',
    ].join('\n')
    const ports = testPorts(compose)
    expect(ports).toEqual({ postgres: 5633, s3: 7533 })
    const stale = envTestPorts(
      'DATABASE_URL=postgresql://t:t@localhost:5533/x_test\nSTORAGE_ENDPOINT=http://localhost:7533\n'
    )
    const issues = testPortMismatches(ports, stale)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatch(/:5533.*:5633/)
  })

  it("falls back to the kit's ports when the file does not say, and reads a URL's default port", () => {
    expect(testPorts('')).toEqual(DEFAULT_TEST_PORTS)
    expect(testPorts('services: [')).toEqual(DEFAULT_TEST_PORTS)
    expect(envTestPorts('DATABASE_URL=postgresql://t:t@localhost/x_test\n').postgres).toBe(5432)
    expect(envTestPorts('STORAGE_ENDPOINT=https://s3.example.test\n').s3).toBe(443)
    expect(envTestPorts('NODE_ENV=test\n')).toEqual({ postgres: null, s3: null })
    expect(testPortMismatches(DEFAULT_TEST_PORTS, { postgres: null, s3: null })).toEqual([])
  })
})
