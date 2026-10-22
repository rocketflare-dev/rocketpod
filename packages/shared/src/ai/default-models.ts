/**
 * The COMMITTED platform default model per prompt key: what the platform chat tier runs for a key
 * when nothing of the tenant's chose a model AND no `platform_agent_models` row exists (a row always
 * wins over this table — it is the newer decision).
 *
 * **Empty in the kit**: the kit has measured nothing worth committing. An app fills it from its own
 * evals — an agent whose prompt scored clearly better on a bigger model gets that model here, with
 * the measurement in `evidence`. Change an entry only with a new measurement.
 *
 * A key absent here runs the platform tier's own model. An entry applies only when the tier IS its
 * provider (the same rule as a `platform_agent_models` row, `platformDefaultModel` in
 * `services/ai/resolve.ts`), so a deployment whose platform key is OpenAI-compatible is never
 * handed a Claude id.
 */
import type { AiProvider } from './config'

export interface PromptDefaultModel {
  provider: AiProvider
  model: string
  /** One line: the score it won on, against what, and at what cost. */
  evidence: string
}

/** Keyed by registry prompt key, e.g. `'summarize-text': { provider: 'anthropic', model, evidence }`. */
export const PROMPT_DEFAULT_MODELS: Readonly<Record<string, PromptDefaultModel>> = Object.freeze({})

/** The committed default for a key, or null when the platform tier's own model runs. */
export function promptDefaultModel(promptKey: string): PromptDefaultModel | null {
  return PROMPT_DEFAULT_MODELS[promptKey] ?? null
}
