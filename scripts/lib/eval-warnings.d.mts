/**
 * Hand-written types for `eval-warnings.mjs` (the workspace has no `allowJs`). Keep in step with
 * the exports there; `apps/web/tests/config/eval-coverage.test.ts` typechecks against this.
 */

/** Relative to the repository root. */
export const EVAL_WARNINGS_FILE: string

export function readEvalWarnings(root: string, sinceMs: number): string[]

export function renderEvalWarnings(lines: readonly string[]): string
