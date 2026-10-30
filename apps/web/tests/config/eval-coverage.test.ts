/**
 * The eval COVERAGE CONTRACT (`docs/EVALS.md` § "The coverage contract"), checked with no
 * model call and no database. Every prompt in `PROMPT_REGISTRY` and every agent in `AGENTS`
 * (installed plugins' included, through `SharedPlugin.evalCoverage`) has an entry in
 * `@rocketpod/shared/ai/eval-coverage`, and every entry's suite, datasets and baseline exist under
 * `apps/evals`, each dataset holding at least the entry's `minCases`. Any of that missing FAILS the
 * gate.
 *
 * Prompt DRIFT only WARNS: a baseline whose recorded prompt version is not the prompt's current
 * template version (`promptVersion`, the one function the eval targets and `pnpm eval:baseline`
 * use), or that is provisional, is printed here and written to `EVAL_WARNINGS_FILE`, which
 * `pnpm test` and `pnpm gate` print last. Re-baselining spends tokens and reads model output — a
 * person's call, never the gate's.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  baselineWarning,
  type EvalBaselineHeader,
  type EvalCoverage,
  type EvalCoverageEntry,
  evalCoverageOf,
  isExemption,
} from '@rocketpod/shared/ai/eval-coverage'
import { type SharedPlugin, sharedPlugins } from '@rocketpod/shared/plugins'
import { describe, expect, it } from 'vitest'
import { AGENTS } from '@/api/services/agents/registry'
import { promptVersion } from '@/api/services/ai/prompt-version'
import { PROMPT_KEYS, PROMPT_REGISTRY } from '@/api/services/prompts'
import {
  EVAL_WARNINGS_FILE,
  readEvalWarnings,
  renderEvalWarnings,
} from '../../../../scripts/lib/eval-warnings.mjs'

const REPO = path.resolve(__dirname, '../../../..')
const EVALS = path.join(REPO, 'apps/evals')

const COVERAGE = evalCoverageOf(sharedPlugins)

const covered = (map: Readonly<Record<string, EvalCoverageEntry>>) =>
  Object.entries(map).filter((e): e is [string, EvalCoverage] => !isExemption(e[1]))

/** Cases in a JSONL dataset: non-blank lines that are not `//` comments, each a JSON object with an id. */
function countCases(file: string): number {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//'))
    .filter(l => {
      const parsed = JSON.parse(l) as { id?: unknown }
      return typeof parsed.id === 'string'
    }).length
}

/** What is wrong with one entry's files — empty when the suite, datasets and baseline are all there. */
function missingFiles(owner: string, entry: EvalCoverage, root = EVALS): string[] {
  const problems: string[] = []
  if (!existsSync(path.join(root, entry.suite))) problems.push(`${owner}: no suite ${entry.suite}`)
  for (const dataset of entry.datasets) {
    const file = path.join(root, 'datasets', `${dataset}.jsonl`)
    if (!existsSync(file)) {
      problems.push(`${owner}: no dataset datasets/${dataset}.jsonl`)
      continue
    }
    const n = countCases(file)
    if (n < entry.minCases) {
      problems.push(`${owner}: datasets/${dataset}.jsonl has ${n} cases, needs ${entry.minCases}`)
    }
  }
  if (!existsSync(path.join(root, 'baselines', `${entry.baseline}.json`))) {
    problems.push(`${owner}: no baseline baselines/${entry.baseline}.json (pnpm eval:baseline)`)
  }
  return problems
}

describe('eval coverage: every prompt and agent ships with its suite', () => {
  it('has an entry for every registered prompt and agent, and none for anything unregistered', () => {
    const agentKeys = Object.keys(AGENTS)
    expect(COVERAGE.problems).toEqual([])
    expect(PROMPT_KEYS.filter(k => !Object.hasOwn(COVERAGE.prompts, k))).toEqual([])
    expect(agentKeys.filter(k => !Object.hasOwn(COVERAGE.agents, k))).toEqual([])
    // A removed prompt or agent must take its entry with it, or the map lies about coverage.
    expect(Object.keys(COVERAGE.prompts).filter(k => !PROMPT_KEYS.includes(k as never))).toEqual([])
    expect(Object.keys(COVERAGE.agents).filter(k => !agentKeys.includes(k))).toEqual([])
  })

  it('finds every covered suite, dataset (with its minimum cases) and baseline', () => {
    const problems = [
      ...covered(COVERAGE.prompts).flatMap(([key, e]) => missingFiles(`prompt ${key}`, e)),
      ...covered(COVERAGE.agents).flatMap(([key, e]) => missingFiles(`agent ${key}`, e)),
    ]
    expect(problems).toEqual([])
  })

  it('reports when a dataset falls below its minimum or a file is missing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'eval-coverage-'))
    mkdirSync(path.join(root, 'datasets'))
    writeFileSync(
      path.join(root, 'datasets', 'thin.jsonl'),
      '// a comment is not a case\n{"id":"one"}\n\n'
    )
    const entry: EvalCoverage = {
      suite: 'suites/thin.eval.ts',
      datasets: ['thin', 'absent'],
      baseline: 'thin',
      minCases: 2,
    }
    expect(missingFiles('prompt thin', entry, root)).toEqual([
      'prompt thin: no suite suites/thin.eval.ts',
      'prompt thin: datasets/thin.jsonl has 1 cases, needs 2',
      'prompt thin: no dataset datasets/absent.jsonl',
      'prompt thin: no baseline baselines/thin.json (pnpm eval:baseline)',
    ])
    rmSync(root, { recursive: true, force: true })
  })

  it("takes a plugin's entries for its own keys, lets core override them, and refuses a foreign key", () => {
    const exempt = { exempt: 'no suite yet' }
    const plugin = {
      id: 'orders',
      label: 'Orders',
      promptKeys: ['orders-triage'],
      agentKeys: ['orders-triage'],
      evalCoverage: {
        prompts: { 'orders-triage': exempt, chat: exempt },
        agents: { 'orders-triage': exempt },
      },
    } satisfies SharedPlugin
    const host: EvalCoverage = {
      suite: 'suites/orders/triage.eval.ts',
      datasets: ['orders-triage'],
      baseline: 'orders-triage',
      minCases: 5,
    }
    const maps = evalCoverageOf([plugin], { prompts: { 'orders-triage': host }, agents: {} })
    // The host wrote a suite for the plugin's prompt: its entry wins over the plugin's exemption.
    expect(maps.prompts['orders-triage']).toBe(host)
    expect(maps.agents['orders-triage']).toBe(exempt)
    // A plugin may not speak for a key it does not own — not even to exempt a core prompt.
    expect(maps.prompts).not.toHaveProperty('chat')
    expect(maps.problems).toEqual(['plugin orders: covers prompt chat, which it does not declare'])
  })
})

describe('eval coverage: prompt drift warns, never fails', () => {
  const entry: EvalCoverage = {
    suite: 'suites/x.eval.ts',
    datasets: ['x'],
    baseline: 'x',
    minCases: 1,
  }
  const now = promptVersion('x', 'the prompt as it is today')

  it('is silent for a baseline recorded against the current text, and names every other state', () => {
    expect(baselineWarning('x', entry, { promptVersions: { x: now } }, now)).toBeNull()
    expect(baselineWarning('x', entry, { promptVersions: { x: [now] } }, now)).toBeNull()
    const old = promptVersion('x', 'the prompt as it was')
    expect(old).not.toBe(now)
    expect(baselineWarning('x', entry, { promptVersions: { x: old } }, now)).toBe(
      `x changed since its baseline (${old} → ${now}) — run \`pnpm eval suites/x && pnpm eval:baseline x\``
    )
    // A run that saw two versions is not a baseline of either.
    expect(baselineWarning('x', entry, { promptVersions: { x: [old, now] } }, now)).toMatch(
      /changed since its baseline/
    )
    // A baseline that versions other prompts but not this one has not measured it.
    expect(baselineWarning('x', entry, { promptVersions: { y: now } }, now)).toMatch(
      /records no version of this prompt/
    )
    // No versions at all (written before they existed, or by hand) reads as provisional.
    expect(baselineWarning('x', entry, {}, now)).toMatch(/is provisional/)
    expect(
      baselineWarning('x', entry, { provisional: true, promptVersions: { x: now } }, now)
    ).toMatch(/is provisional/)
  })

  it('hands the runners only warnings written during THIS run', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'eval-warnings-'))
    const file = path.join(root, EVAL_WARNINGS_FILE)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, 'chat changed since its baseline\n\n')
    const written = Date.now()
    expect(readEvalWarnings(root, written - 60_000)).toEqual(['chat changed since its baseline'])
    // A file left by an earlier run (the test that writes it did not run this time) is stale.
    const old = new Date(written - 3_600_000)
    utimesSync(file, old, old)
    expect(readEvalWarnings(root, written - 60_000)).toEqual([])
    expect(readEvalWarnings(path.join(root, 'nowhere'), 0)).toEqual([])
    expect(renderEvalWarnings([])).toBe('')
    expect(renderEvalWarnings(['a', 'b']).split('\n').slice(1)).toEqual(['  · a', '  · b'])
    rmSync(root, { recursive: true, force: true })
  })

  it('compares every covered prompt with its committed baseline and hands the gate the warnings', () => {
    const warnings: string[] = []
    for (const [key, e] of covered(COVERAGE.prompts)) {
      const baseline = JSON.parse(
        readFileSync(path.join(EVALS, 'baselines', `${e.baseline}.json`), 'utf8')
      ) as EvalBaselineHeader
      // The file is the suite's: a baseline copied under another name would compare nonsense.
      expect(baseline.suite, `baselines/${e.baseline}.json`).toBe(e.baseline)
      const current = promptVersion(
        key,
        PROMPT_REGISTRY[key as keyof typeof PROMPT_REGISTRY].defaultText
      )
      const warning = baselineWarning(key, e, baseline, current)
      if (warning) warnings.push(warning)
    }
    const file = path.join(REPO, EVAL_WARNINGS_FILE)
    if (warnings.length > 0) {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, `${warnings.join('\n')}\n`)
      console.warn(`eval baselines need attention:\n${warnings.map(w => `  · ${w}`).join('\n')}`)
    } else {
      rmSync(file, { force: true })
    }
  })
})
