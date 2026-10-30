/** `pnpm eval`'s pure half: reading a run report, baselines, and the regression compare. */
import { describe, expect, it } from 'vitest'
import {
  baselinesFrom,
  compareScores,
  extractCases,
  parseArgs,
  renderSummary,
  runHeader,
  scoreIndex,
  suiteId,
} from '../scripts/lib.mjs'

const assertion = (title: string, scores: Record<string, number | null>, status = 'passed') => ({
  title,
  status,
  failureMessages: [],
  meta: {
    eval: {
      avgScore:
        Object.values(scores).reduce((a: number, s) => a + (s ?? 0), 0) /
        Object.keys(scores).length,
      scores: Object.entries(scores).map(([name, score]) => ({
        name,
        score,
        metadata: { rationale: 'r' },
      })),
    },
    harness: {
      run: {
        usage: { model: 'claude-x', inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        timings: { totalMs: 1200 },
        artifacts: { promptKey: 'chat', promptVersion: 'chat@abc123' },
      },
    },
  },
})

const report = (
  cases: ReturnType<typeof assertion>[],
  file = '/repo/apps/evals/suites/chat/knowledge.eval.ts'
) => ({
  testResults: [{ name: file, assertionResults: cases }],
})

describe('reading a run', () => {
  it('keys suites by path under suites/ and reads scores, usage and prompt versions', () => {
    expect(suiteId('/x/apps/evals/suites/agents/my-agent.eval.ts')).toBe('agents-my-agent')
    const [c] = extractCases(report([assertion('refund-window', { Rubric: 1, Contains: 0.5 })]))
    expect(c).toMatchObject({
      suite: 'chat-knowledge',
      id: 'refund-window',
      avgScore: 0.75,
      scores: { Rubric: 1, Contains: 0.5 },
      model: 'claude-x',
      promptVersion: 'chat@abc123',
      totalMs: 1200,
    })
    const header = runHeader({ sha: 'abc', dirty: false, createdAt: 't', filters: [], cases: [c] })
    expect(header).toMatchObject({
      version: 2,
      promptVersions: { chat: 'chat@abc123' },
      modelsObserved: ['claude-x'],
    })
    expect(renderSummary([c])).toContain('1/1 passed · mean score 0.75')
  })
})

describe('baselinesFrom', () => {
  it("records each suite's own prompt versions and model, which the gate's drift check reads", () => {
    const chat = extractCases(report([assertion('refund-window', { Rubric: 1 })]))
    const triage = extractCases(
      report(
        [assertion('refund-conditions', { Decisions: 1 })],
        '/r/apps/evals/suites/agents/my-agent.eval.ts'
      )
    ).map(c => ({
      ...c,
      model: 'claude-y',
      promptKey: 'my-agent',
      promptVersion: 'my-agent@def456',
      // The chat-model fallback answered `ctx.decide`, so the decisions prompt was measured too.
      promptVersions: {
        'my-agent': 'my-agent@def456',
        'agent-decide': 'agent-decide@0a1b',
      },
    }))
    const header = runHeader({ createdAt: 't', sha: 's', cases: [...chat, ...triage] })
    const out = baselinesFrom([...chat, ...triage], header)
    expect(out['chat-knowledge']).toMatchObject({
      model: 'claude-x',
      promptVersions: { chat: 'chat@abc123' },
    })
    expect(out['agents-my-agent']).toMatchObject({
      model: 'claude-y',
      promptVersions: {
        'my-agent': 'my-agent@def456',
        'agent-decide': 'agent-decide@0a1b',
      },
    })
    // Each suite carries ITS prompts only: chat's baseline knows nothing of the agent's.
    expect(out['chat-knowledge']?.promptVersions).not.toHaveProperty('my-agent')
    expect(out['agents-my-agent']).not.toHaveProperty('provisional')
  })

  it('keeps every version when one suite ran more than one, so the gate reads it as stale', () => {
    const cases = extractCases(
      report([assertion('a', { Rubric: 1 }), assertion('b', { Rubric: 1 })])
    ).map((c, i) => ({ ...c, promptVersion: `chat@v${i}` }))
    expect(
      baselinesFrom(cases, { createdAt: 't', sha: 's', judgeModel: null })['chat-knowledge']
        ?.promptVersions
    ).toEqual({ chat: ['chat@v0', 'chat@v1'] })
  })
})

describe('compareScores', () => {
  const base = scoreIndex(
    baselinesFrom(
      extractCases(
        report([
          assertion('refund-window', { Rubric: 1, Contains: 1 }),
          assertion('greeting', { Rubric: 1 }),
        ])
      ),
      { createdAt: 't', sha: 's', judgeModel: null }
    )
  )

  it('flags a drop past the threshold, a lost case, and a rise as an improvement', () => {
    const now = scoreIndex(
      extractCases(report([assertion('refund-window', { Rubric: 0.5, Contains: 1.0 })]))
    )
    const { regressions, improvements } = compareScores(base, now, 0.1)
    expect(regressions.map(r => [r.id, r.judge])).toEqual([
      ['refund-window', 'Rubric'],
      ['greeting', '(case)'],
    ])
    expect(improvements).toEqual([])
  })

  it('ignores drops within the threshold and suites the run did not include', () => {
    const now = scoreIndex(
      extractCases(
        report([
          assertion('refund-window', { Rubric: 0.95, Contains: 1 }),
          assertion('greeting', { Rubric: 1 }),
        ])
      )
    )
    expect(compareScores(base, now, 0.1).regressions).toEqual([])
    expect(compareScores({ other: {} }, now, 0.1).regressions).toEqual([])
  })
})

describe('parseArgs', () => {
  it('reads filters and flags, and --compare defaults to the baselines', () => {
    expect(parseArgs(['chat', '--model', 'm', '--compare'])).toMatchObject({
      filters: ['chat'],
      model: 'm',
      compare: 'baseline',
    })
    expect(parseArgs(['--compare', 'run.json', '--threshold', '0.2'])).toMatchObject({
      compare: 'run.json',
      threshold: 0.2,
    })
    expect(() => parseArgs(['--nope'])).toThrow('unknown flag --nope')
    expect(() => parseArgs(['--model'])).toThrow('--model needs a value')
  })
})
