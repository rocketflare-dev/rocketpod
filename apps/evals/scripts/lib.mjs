/**
 * The pure half of `pnpm eval`: read a vitest JSON report (with vitest-evals' task meta) into
 * per-case scores, write/read baselines, compare two score sets, and render the summaries. No
 * filesystem, no process — `tests/compare.test.ts` exercises all of it on fixtures.
 */
import path from 'node:path'

/** `…/suites/chat/knowledge.eval.ts` → `chat-knowledge` — the baseline file name and the suite key. */
export function suiteId(file) {
  const norm = file.split(path.sep).join('/')
  const rel = norm.includes('/suites/')
    ? norm.slice(norm.lastIndexOf('/suites/') + 8)
    : path.basename(norm)
  return rel.replace(/\.eval\.[cm]?[jt]s$/, '').replace(/\//g, '-')
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * One row per eval case: `{ suite, id, status, avgScore, scores: { judge: score|null }, rationales,
 * usage, totalMs, promptKey, promptVersion, promptVersions, model }`. Skipped cases (no key) come
 * back `status: skipped`. `promptVersion` is `<key>@<hash of the prompt TEMPLATE>` — the same
 * function the gate's coverage check compares (`apps/web/src/api/services/ai/prompt-version.ts`);
 * `promptVersions` is every prompt the case used (`{ key: version }`, the target's own included —
 * an agent run that fell back to the chat model for `ctx.decide` adds `agent-decide`).
 */
export function extractCases(report) {
  const rows = []
  for (const file of report.testResults ?? []) {
    const suite = suiteId(file.name)
    for (const a of file.assertionResults ?? []) {
      const meta = a.meta ?? {}
      const evalMeta = meta.eval
      const run = meta.harness?.run
      const scores = {}
      const rationales = {}
      for (const s of evalMeta?.scores ?? []) {
        scores[s.name] = num(s.score)
        if (s.metadata?.rationale) rationales[s.name] = String(s.metadata.rationale)
      }
      rows.push({
        suite,
        id: a.title,
        status: a.status === 'pending' || a.status === 'skipped' ? 'skipped' : a.status,
        avgScore: num(evalMeta?.avgScore),
        scores,
        rationales,
        usage: run?.usage ?? {},
        totalMs: num(run?.timings?.totalMs),
        promptKey: run?.artifacts?.promptKey ?? null,
        promptVersion: run?.artifacts?.promptVersion ?? null,
        promptVersions: run?.artifacts?.promptVersions ?? {},
        model: run?.usage?.model ?? run?.artifacts?.model ?? run?.session?.model ?? null,
        failure: a.failureMessages?.[0]?.split('\n')[0] ?? null,
      })
    }
  }
  return rows
}

/**
 * The header `pnpm eval` stamps on every run file, next to vitest's own keys.
 * @param {{ sha?: string, dirty?: boolean, createdAt: string, filters?: string[], model?: string | null, judgeModel?: string | null, provider?: string, judgeProvider?: string, cases: any[] }} opts
 */
export function runHeader({
  sha,
  dirty,
  createdAt,
  filters,
  model,
  judgeModel,
  provider,
  judgeProvider,
  cases,
}) {
  const models = new Set()
  for (const c of cases) if (c.model) models.add(c.model)
  return {
    version: 2,
    sha,
    dirty,
    createdAt,
    filters,
    provider: provider ?? 'anthropic',
    model: model ?? null,
    modelsObserved: [...models].sort(),
    judgeProvider: judgeProvider ?? 'anthropic',
    judgeModel: judgeModel ?? null,
    promptVersions: promptVersionsOf(cases),
  }
}

/**
 * `{ promptKey: version }` over some cases — or `[versions]` when they ran more than one (an
 * override changed mid-run), which the gate's drift check then reads as "re-baseline".
 */
export function promptVersionsOf(cases) {
  const seen = {}
  const add = (key, version) => {
    if (!key || !version) return
    seen[key] ??= new Set()
    seen[key].add(version)
  }
  for (const c of cases) {
    add(c.promptKey, c.promptVersion)
    for (const [key, version] of Object.entries(c.promptVersions ?? {})) add(key, version)
  }
  return Object.fromEntries(
    Object.entries(seen).map(([key, set]) => [key, set.size === 1 ? [...set][0] : [...set].sort()])
  )
}

/**
 * Baseline files keyed by suite: `{ suite, createdAt, sha, model, judgeModel, promptVersions,
 * cases: { id: { avgScore, scores } } }`. `model` is the `--model` the run was given, else the
 * models THIS suite's cases observed; `promptVersions` is what the gate compares with the
 * prompts' current text, so a baseline written from a run is never `provisional`.
 */
export function baselinesFrom(cases, header) {
  const bySuite = {}
  for (const c of cases) {
    if (c.status === 'skipped') continue
    bySuite[c.suite] ??= []
    bySuite[c.suite].push(c)
  }
  return Object.fromEntries(
    Object.entries(bySuite).map(([suite, suiteCases]) => {
      const observed = [...new Set(suiteCases.map(c => c.model).filter(Boolean))].sort()
      return [
        suite,
        {
          suite,
          createdAt: header.createdAt,
          sha: header.sha,
          model: header.model ?? (observed.length ? observed.join(', ') : null),
          judgeModel: header.judgeModel,
          promptVersions: promptVersionsOf(suiteCases),
          cases: Object.fromEntries(
            suiteCases.map(c => [c.id, { avgScore: c.avgScore, scores: c.scores }])
          ),
        },
      ]
    })
  )
}

/** A baseline or a run's cases, as `suite → id → { avgScore, scores }`. */
export function scoreIndex(source) {
  const index = {}
  if (Array.isArray(source)) {
    for (const c of source) {
      if (c.status === 'skipped') continue
      index[c.suite] ??= {}
      index[c.suite][c.id] = { avgScore: c.avgScore, scores: c.scores, status: c.status }
    }
    return index
  }
  for (const [suite, baseline] of Object.entries(source)) index[suite] = { ...baseline.cases }
  return index
}

/**
 * Compare `current` against `base` (both `scoreIndex` shapes), per case and per judge. A drop of
 * more than `threshold` is a regression; a rise of more than it an improvement. A case the base
 * has and the current run lost (or failed outright) is a regression too — silence is not a pass.
 * Suites the current run did not include are ignored, so `pnpm eval chat --compare` works.
 */
export function compareScores(base, current, threshold = 0.1) {
  const regressions = []
  const improvements = []
  for (const [suite, cases] of Object.entries(current)) {
    const baseCases = base[suite]
    if (!baseCases) continue
    for (const [id, was] of Object.entries(baseCases)) {
      const now = cases[id]
      if (!now) {
        regressions.push({
          suite,
          id,
          judge: '(case)',
          was: was.avgScore,
          now: null,
          reason: 'missing from this run',
        })
        continue
      }
      for (const [judge, wasScore] of Object.entries(was.scores ?? {})) {
        const nowScore = now.scores?.[judge] ?? null
        if (wasScore === null || wasScore === undefined) continue
        if (nowScore === null) {
          regressions.push({
            suite,
            id,
            judge,
            was: wasScore,
            now: null,
            reason: 'no longer scored',
          })
        } else if (nowScore < wasScore - threshold) {
          regressions.push({ suite, id, judge, was: wasScore, now: nowScore })
        } else if (nowScore > wasScore + threshold) {
          improvements.push({ suite, id, judge, was: wasScore, now: nowScore })
        }
      }
      if (
        now.status === 'failed' &&
        was.avgScore !== null &&
        (now.avgScore ?? 0) < was.avgScore - threshold
      ) {
        if (!regressions.some(r => r.suite === suite && r.id === id)) {
          regressions.push({ suite, id, judge: '(average)', was: was.avgScore, now: now.avgScore })
        }
      }
    }
  }
  return { regressions, improvements }
}

const fmt = v => (v === null || v === undefined ? '—' : v.toFixed(2))

function table(rows) {
  if (rows.length === 0) return ''
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i]).length)))
  return rows
    .map(r =>
      r
        .map((cell, i) => String(cell).padEnd(widths[i]))
        .join('  ')
        .trimEnd()
    )
    .join('\n')
}

/** Per-case scores plus the cost/latency/token totals — what a model-vs-model comparison reads. */
export function renderSummary(cases) {
  const scored = cases.filter(c => c.status !== 'skipped')
  if (scored.length === 0) return 'No eval cases ran (all skipped).'
  const judges = [...new Set(scored.flatMap(c => Object.keys(c.scores)))]
  const rows = [['suite', 'case', 'avg', ...judges, 'tokens', 'cost', 'ms']]
  let tokens = 0
  let cost = 0
  let priced = true
  let ms = 0
  for (const c of scored) {
    const t = (c.usage.inputTokens ?? 0) + (c.usage.outputTokens ?? 0)
    tokens += t
    if (typeof c.usage.costUsd === 'number') cost += c.usage.costUsd
    else priced = false
    ms += c.totalMs ?? 0
    rows.push([
      c.suite,
      c.status === 'failed' ? `${c.id} ✗` : c.id,
      fmt(c.avgScore),
      ...judges.map(j => fmt(c.scores[j])),
      t,
      typeof c.usage.costUsd === 'number' ? `$${c.usage.costUsd.toFixed(4)}` : '—',
      c.totalMs ?? '—',
    ])
  }
  const passed = scored.filter(c => c.status === 'passed').length
  const avg = scored.reduce((sum, c) => sum + (c.avgScore ?? 0), 0) / scored.length
  return [
    table(rows),
    '',
    `${passed}/${scored.length} passed · mean score ${avg.toFixed(2)} · ${tokens} tokens · ` +
      `${priced ? '' : '≥'}$${cost.toFixed(4)} · ${(ms / 1000).toFixed(1)}s of target time`,
  ].join('\n')
}

export function renderComparison({ regressions, improvements }, threshold) {
  const lines = []
  const row = r => [r.suite, r.id, r.judge, fmt(r.was), '→', fmt(r.now), r.reason ?? '']
  if (regressions.length) {
    lines.push(`REGRESSIONS (drop > ${threshold}):`, table(regressions.map(row)))
  }
  if (improvements.length) {
    lines.push(`Improvements (rise > ${threshold}):`, table(improvements.map(row)))
  }
  if (!regressions.length && !improvements.length) lines.push(`No change beyond ±${threshold}.`)
  return lines.join('\n')
}

/** `run [filters] [--model x] [--judge-model y] [--compare [target]] [--threshold n] [--case ids] [--concurrency n]` */
export function parseArgs(argv) {
  const out = { filters: [], compare: null, threshold: 0.1 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`)
      i++
      return v
    }
    switch (arg) {
      case '--model':
        out.model = next()
        break
      case '--judge-model':
        out.judgeModel = next()
        break
      case '--provider':
        out.provider = next()
        break
      case '--judge-provider':
        out.judgeProvider = next()
        break
      case '--threshold':
        out.threshold = Number(next())
        if (!(out.threshold >= 0 && out.threshold <= 1)) throw new Error('--threshold is 0..1')
        break
      case '--case':
        out.cases = next()
        break
      case '--concurrency':
        out.concurrency = next()
        break
      case '--from':
        out.from = next()
        break
      case '--compare': {
        const v = argv[i + 1]
        if (v && !v.startsWith('--')) {
          out.compare = v
          i++
        } else out.compare = 'baseline'
        break
      }
      default:
        if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`)
        out.filters.push(arg)
    }
  }
  return out
}
