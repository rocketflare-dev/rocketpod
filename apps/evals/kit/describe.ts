/**
 * `describeCases(name, { harness, judges, cases })` (D33) — `describeEval` once per case, each with
 * only the judges that case gives something to check (`EvalJudge.appliesTo`). vitest-evals averages
 * a `null` score as 0, so a suite-wide judge list would fail a greeting for having no
 * `expected.contains`; attaching per case keeps every average honest. Every block shares the suite
 * name, so reports and baselines still read `<suite> › <case id>`.
 *
 * `gates` are judges that must score 1 whatever the mean is: a case that broke its output schema or
 * called a tool it must never call fails outright, rather than averaging the failure away against
 * the judges that passed. List a gate in `judges` too when its score should land in the run file
 * and the baseline.
 */
import type { EvalCase } from '@rocketpod/shared/ai/evals'
import { expect } from 'vitest'
import { describeEval, type Harness, type JsonValue } from 'vitest-evals'
import { skipEvals } from './env'
import { judgeHarness } from './judge-harness'
import type { EvalJudge } from './judges'

export interface DescribeCasesOptions<TOutput extends JsonValue | undefined> {
  harness: Harness<EvalCase, TOutput>
  judges: EvalJudge[]
  cases: EvalCase[]
  /** Mean judge score a case must reach to pass (default 0.7). */
  threshold?: number
  /** Judges that must score exactly 1 for the case to pass. */
  gates?: EvalJudge[]
}

export function describeCases<TOutput extends JsonValue | undefined>(
  name: string,
  { harness, judges, cases, threshold = 0.7, gates = [] }: DescribeCasesOptions<TOutput>
): void {
  for (const evalCase of cases) {
    const applies = (j: EvalJudge) => j.appliesTo?.(evalCase) ?? true
    const caseGates = gates.filter(applies)
    describeEval(
      name,
      {
        harness,
        judgeHarness,
        judges: judges.filter(applies),
        judgeThreshold: threshold,
        skipIf: skipEvals,
      },
      it => {
        it(evalCase.id, async ({ run }) => {
          const result = await run(evalCase)
          for (const gate of caseGates) {
            // biome-ignore lint/suspicious/noExplicitAny: the matcher's judge type is per harness
            await expect(result).toSatisfyJudge(gate as any, { input: evalCase, threshold: 1 })
          }
        })
      }
    )
  }
}
