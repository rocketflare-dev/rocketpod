/**
 * A prompt's VERSION: `<key>@<first 12 hex of sha256(text)>`. One function, so the version an eval
 * run records (`apps/evals` targets), the version a baseline carries
 * (`apps/evals/baselines/<suite>.json` → `promptVersions`) and the gate's drift check
 * (`tests/config/eval-coverage.test.ts`) can never disagree about how a text is hashed.
 *
 * Which TEXT is hashed is the caller's choice and changes what the version means: hash the text a
 * call RAN with (interpolated) and it differs per tenant; the eval targets, the baselines and the
 * gate hash the TEMPLATE (override or default), which is the same for every tenant.
 */
import { createHash } from 'node:crypto'

export function promptVersion(key: string, text: string): string {
  return `${key}@${createHash('sha256').update(text).digest('hex').slice(0, 12)}`
}
