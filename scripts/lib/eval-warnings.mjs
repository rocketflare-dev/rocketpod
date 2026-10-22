/**
 * The eval coverage contract's WARNINGS, carried out of the test run (`docs/EVALS.md` § "The
 * coverage contract"). `apps/web/tests/config/eval-coverage.test.ts` writes one line per stale or
 * provisional baseline to `EVAL_WARNINGS_FILE` (git-ignored, under `apps/evals/.evals/`) and
 * deletes it when there are none; `scripts/test.mjs` and `scripts/gate.mjs` print it at the very
 * end, where it cannot scroll away. Warnings never fail anything: re-baselining spends tokens and
 * is a person's call.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export const EVAL_WARNINGS_FILE = 'apps/evals/.evals/gate-warnings.txt'

/** The warning lines written since `sinceMs` (a stale file from an earlier run is ignored). */
export function readEvalWarnings(root, sinceMs) {
  const file = path.join(root, EVAL_WARNINGS_FILE)
  if (!existsSync(file) || statSync(file).mtimeMs < sinceMs) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
}

/** The block both runners print. */
export function renderEvalWarnings(lines) {
  if (lines.length === 0) return ''
  return [
    `⚠ eval baselines need attention (${lines.length}) — a warning, not a failure:`,
    ...lines.map(l => `  · ${l}`),
  ].join('\n')
}
