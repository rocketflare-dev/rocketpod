/**
 * Provider catalog (D17) — DATA only, no SDK imports. What each provider can do, what a config row
 * for it must carry, and its presets. `scopes` is the "an adapter exists" gate: a provider is only
 * offered for a scope `client.ts` can build a client for, so a saveable-but-unusable row can never
 * be created. Read by `routes/ai-config.ts` (validation) and served to the settings form.
 */
import {
  type AiProvider,
  type AiScope,
  DEFAULT_MODELS,
  type ProviderPreset,
  presetsFor,
} from '@rocketpod/shared/ai/config'

export interface ProviderInfo {
  id: AiProvider
  name: string
  /** Scopes an adapter exists for. */
  scopes: readonly AiScope[]
  needsApiKey: boolean
  needsBaseUrl: boolean
  /**
   * Has a thinking control the config's switch maps onto — Anthropic's `thinking`, OpenAI's
   * `reasoning.effort`. What each model accepts is `@rocketpod/shared/ai/models`.
   */
  supportsThinking: boolean
  /** Accepts `service_tier`. */
  supportsServiceTier: boolean
  defaultModel: string
  presets: readonly ProviderPreset[]
  /**
   * Models offered in the picker, BY SCOPE. Keyed by scope because a flat list offers an embeddings
   * model on a chat config and vice versa, which reads as a bug the first time someone picks one.
   */
  suggestedModels: Readonly<Record<AiScope, readonly string[]>>
  /**
   * `true` when the list above IS the catalog, so the form offers those ids and no free text
   * (a provider with a closed model catalog; none of the built-in ones today). Everywhere else a model id is whatever the endpoint calls it, so the picker keeps
   * an "other" escape. It is a form affordance, never a validation rule: a stored row naming a
   * model that has since left the list is still shown and still saveable, because the alternative
   * is a config silently rewritten to a model its owner did not choose.
   */
  modelsFixed?: boolean
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    scopes: ['chat'],
    needsApiKey: true,
    needsBaseUrl: false,
    supportsThinking: true,
    supportsServiceTier: true,
    defaultModel: DEFAULT_MODELS.anthropic,
    presets: [],
    suggestedModels: {
      // Cheapest first; checked 2026-10-13. `claude-opus-4-1` was retired on the Claude API.
      chat: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'],
      embeddings: [],
      decisions: [],
    },
  },
  {
    id: 'anthropic_compatible',
    name: 'Anthropic-compatible (Fireworks, Moonshot, …)',
    scopes: ['chat'],
    needsApiKey: true,
    needsBaseUrl: true,
    // Fireworks' GLM/Kimi models reason unless told not to — the disabled default is real money.
    supportsThinking: true,
    supportsServiceTier: true,
    defaultModel: DEFAULT_MODELS.anthropic_compatible,
    presets: presetsFor('anthropic_compatible'),
    suggestedModels: {
      chat: [
        'accounts/fireworks/models/gpt-oss-120b',
        'accounts/fireworks/models/kimi-k2p5',
        'kimi-k2-0905-preview',
      ],
      embeddings: [],
      decisions: [],
    },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    scopes: ['chat', 'embeddings'],
    needsApiKey: true,
    needsBaseUrl: false,
    // Off = the model's lowest `reasoning.effort`; on = its default. Older models take neither.
    supportsThinking: true,
    supportsServiceTier: false,
    defaultModel: DEFAULT_MODELS.openai,
    presets: [],
    suggestedModels: {
      // Served through the Responses API (`client.ts`): Chat Completions cannot call tools on
      // `gpt-6-astra` / `gpt-6.1-sol`, nor on Luna while it reasons. Checked 2026-10-13.
      chat: ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
      embeddings: ['text-embedding-3-small', 'text-embedding-3-large'],
      decisions: [],
    },
  },
  {
    id: 'openai_compatible',
    name: 'OpenAI-compatible endpoint',
    scopes: ['chat', 'embeddings'],
    needsApiKey: true,
    needsBaseUrl: true,
    supportsThinking: false,
    supportsServiceTier: false,
    defaultModel: DEFAULT_MODELS.openai_compatible,
    presets: presetsFor('openai_compatible'),
    suggestedModels: { chat: [], embeddings: [], decisions: [] },
  },
  {
    // D37: typed judgments with probabilities, never text — so `decisions` is its ONLY scope, and
    // `decisions` has no other provider (the chat-model fallback is implicit, not a row).
    id: 'typesafe',
    name: 'TypeSafe (Jev)',
    scopes: ['decisions'],
    needsApiKey: true,
    needsBaseUrl: false,
    supportsThinking: false,
    supportsServiceTier: false,
    defaultModel: DEFAULT_MODELS.typesafe,
    presets: [],
    suggestedModels: { chat: [], embeddings: [], decisions: ['jev-latest'] },
  },
]

export function providerInfo(id: AiProvider): ProviderInfo {
  const info = PROVIDERS.find(p => p.id === id)
  if (!info) throw new Error(`Unknown AI provider: ${id}`)
  return info
}

export const providersForScope = (scope: AiScope): ProviderInfo[] =>
  PROVIDERS.filter(p => p.scopes.includes(scope))

export const providerSupportsScope = (id: AiProvider, scope: AiScope): boolean =>
  providerInfo(id).scopes.includes(scope)

/** Default endpoint for providers that have one; `*_compatible` rows must carry their own. */
export const DEFAULT_BASE_URLS: Partial<Record<AiProvider, string>> = {
  openai: 'https://api.openai.com/v1',
}
