/**
 * The eval COVERAGE CONTRACT (D33, `docs/EVALS.md` § "The coverage contract"): every prompt in the
 * registry and every registered agent says how its quality is measured — the suite that runs it,
 * the dataset(s) it runs over and the committed baseline a run is compared with — or says, with a
 * reason, why it has none.
 *
 * Pure data and pure functions, so both sides can read it without importing the other's runtime:
 * the gate's `apps/web/tests/config/eval-coverage.test.ts` checks it against `PROMPT_REGISTRY` /
 * `AGENTS` and the files under `apps/evals` (no model call, no database).
 *
 * - A registered prompt or agent with no entry FAILS the gate, as does an entry for a key nothing
 *   registers.
 * - An entry naming a suite, dataset or baseline that does not exist FAILS the gate, as does a
 *   dataset with fewer than `minCases` cases.
 * - A baseline whose recorded prompt version differs from the prompt's current template, or that
 *   is `provisional` (no recorded versions), only WARNS — model output varies, so re-baselining is
 *   a person's call, never the gate's.
 *
 * Adding a prompt or an agent = adding its entry here, in the same change. An installed PLUGIN's
 * prompts and agents are registered too: the plugin declares their entries in its own
 * `SharedPlugin.evalCoverage` (a plugin cannot write under `apps/evals`, so it usually declares an
 * `exempt` with its reason, or names a suite the host wrote for it), and an entry here for the same
 * key overrides the plugin's — which is how an app that wrote a suite for a plugin's prompt says so
 * without editing the plugin. `exempt` is for what genuinely has no suite yet; a reviewer reads the
 * reason.
 *
 * This module never imports the plugin barrel: it is handed the plugin list
 * (`evalCoverageOf(sharedPlugins)`), so it is not one of the composers a plugin must not import.
 */
import type { SharedPlugin } from '../plugins/types'

export interface EvalCoverage {
  /** The suite file, relative to `apps/evals` (`suites/chat/knowledge.eval.ts`). */
  suite: string
  /** Dataset names — `apps/evals/datasets/<name>.jsonl`. */
  datasets: readonly string[]
  /** The baseline's suite id — `apps/evals/baselines/<baseline>.json` (`pnpm eval:baseline`). */
  baseline: string
  /** The fewest cases each dataset may hold. */
  minCases: number
}

export interface EvalExemption {
  /** Why no suite measures this — a sentence a reviewer can disagree with. */
  exempt: string
}

export type EvalCoverageEntry = EvalCoverage | EvalExemption

/** What a plugin declares for its own prompt and agent keys (`SharedPlugin.evalCoverage`). */
export interface PluginEvalCoverage {
  readonly prompts?: Readonly<Record<string, EvalCoverageEntry>>
  readonly agents?: Readonly<Record<string, EvalCoverageEntry>>
}

export const isExemption = (entry: EvalCoverageEntry): entry is EvalExemption => 'exempt' in entry

/**
 * The command a stale or provisional baseline is refreshed with (the gate's warning prints it).
 * `pnpm eval` filters by suite FILE path, `pnpm eval:baseline` by suite id.
 */
export const rebaselineCommand = (entry: EvalCoverage) =>
  `pnpm eval ${entry.suite.replace(/\.eval\.[cm]?[jt]s$/, '')} && pnpm eval:baseline ${entry.baseline}`

/** What the drift check reads from `apps/evals/baselines/<baseline>.json`. */
export interface EvalBaselineHeader {
  suite?: string
  /** A placeholder written without a model run: accepted by the gate, and warned about. */
  provisional?: boolean
  /** `promptKey → promptVersion` (a list when one run saw several) — `pnpm eval:baseline` writes it. */
  promptVersions?: Record<string, string | readonly string[]>
}

/**
 * The gate's drift WARNING for one prompt, or null when its baseline is current. `current` is
 * `promptVersion(key, template)` — the same function the eval targets record and the baseline
 * carries (`apps/web/src/api/services/ai/prompt-version.ts`); this function only compares.
 *
 * A baseline with no `promptVersions` at all predates them (or was hand-written) and reads as
 * provisional: its scores are real, but nothing says which prompt text earned them.
 */
export function baselineWarning(
  promptKey: string,
  entry: EvalCoverage,
  baseline: EvalBaselineHeader,
  current: string
): string | null {
  const fix = `run \`${rebaselineCommand(entry)}\``
  if (baseline.provisional || baseline.promptVersions === undefined) {
    return `${promptKey}: baselines/${entry.baseline}.json is provisional (no recorded prompt versions) — ${fix}`
  }
  const recorded = baseline.promptVersions[promptKey]
  if (recorded === undefined) {
    return `${promptKey}: baselines/${entry.baseline}.json records no version of this prompt — ${fix}`
  }
  const versions = typeof recorded === 'string' ? [recorded] : recorded
  if (versions.length === 1 && versions[0] === current) return null
  return `${promptKey} changed since its baseline (${versions.join(', ')} → ${current}) — ${fix}`
}

const CHAT: EvalCoverage = {
  suite: 'suites/chat/knowledge.eval.ts',
  datasets: ['knowledge-chat'],
  baseline: 'chat-knowledge',
  minCases: 5,
}

const SUMMARIZE_TEXT: EvalCoverage = {
  suite: 'suites/agents/summarize-text.eval.ts',
  datasets: ['summarize-text'],
  baseline: 'agents-summarize-text',
  minCases: 4,
}

const RESEARCH_TOPIC: EvalCoverage = {
  suite: 'suites/agents/research-topic.eval.ts',
  datasets: ['research-topic'],
  baseline: 'agents-research-topic',
  minCases: 3,
}

/** Its `DecisionJudge` cases also measure `agent-decide` when no TypeSafe key is set. */
const TRIAGE_RESEARCH: EvalCoverage = {
  suite: 'suites/agents/triage-research.eval.ts',
  datasets: ['triage-research'],
  baseline: 'agents-triage-research',
  minCases: 3,
}

/** Core prompt key → coverage. Keys are `CORE_PROMPT_REGISTRY`'s. */
export const CORE_PROMPT_EVAL_COVERAGE: Readonly<Record<string, EvalCoverageEntry>> = {
  chat: CHAT,
  'summarize-text': SUMMARIZE_TEXT,
  'research-topic': RESEARCH_TOPIC,
  'triage-research': TRIAGE_RESEARCH,
  // The chat-model fallback for `ctx.decide`: measured by triage-research's DecisionJudge on a run
  // without `TYPESAFE_API_KEY` (the agent target then records this prompt's version too).
  'agent-decide': TRIAGE_RESEARCH,
  'chat-compaction': {
    exempt:
      'Background summariser with no suite yet; its summary is only read back by the chat model. A compaction suite (a long thread whose early facts must survive the fold) is the follow-up.',
  },
  'evals-judge': {
    exempt: 'The LLM judge itself: it grades the suites, so no suite can grade it.',
  },
}

/** Core agent key → coverage. Keys are `CORE_AGENTS`'. */
export const CORE_AGENT_EVAL_COVERAGE: Readonly<Record<string, EvalCoverageEntry>> = {
  'summarize-text': SUMMARIZE_TEXT,
  'research-topic': RESEARCH_TOPIC,
  'triage-research': TRIAGE_RESEARCH,
}

export interface EvalCoverageMaps {
  /** Prompt key → coverage: every plugin's, then the core map (which wins on a shared key). */
  prompts: Record<string, EvalCoverageEntry>
  agents: Record<string, EvalCoverageEntry>
  /** A plugin covering a key it does not own (`promptKeys` / `agentKeys`) — the gate fails these. */
  problems: string[]
}

/** The whole contract for an app with `plugins` installed (the gate passes `sharedPlugins`). */
export function evalCoverageOf(
  plugins: readonly SharedPlugin[],
  core: {
    prompts: Readonly<Record<string, EvalCoverageEntry>>
    agents: Readonly<Record<string, EvalCoverageEntry>>
  } = {
    prompts: CORE_PROMPT_EVAL_COVERAGE,
    agents: CORE_AGENT_EVAL_COVERAGE,
  }
): EvalCoverageMaps {
  const prompts: Record<string, EvalCoverageEntry> = {}
  const agents: Record<string, EvalCoverageEntry> = {}
  const problems: string[] = []
  for (const plugin of plugins) {
    const sides = [
      ['prompt', plugin.evalCoverage?.prompts, plugin.promptKeys ?? [], prompts],
      ['agent', plugin.evalCoverage?.agents, plugin.agentKeys ?? [], agents],
    ] as const
    for (const [kind, declared, owned, into] of sides) {
      for (const [key, entry] of Object.entries(declared ?? {})) {
        if (!owned.includes(key)) {
          problems.push(`plugin ${plugin.id}: covers ${kind} ${key}, which it does not declare`)
          continue
        }
        into[key] = entry
      }
    }
  }
  return {
    prompts: { ...prompts, ...core.prompts },
    agents: { ...agents, ...core.agents },
    problems,
  }
}
