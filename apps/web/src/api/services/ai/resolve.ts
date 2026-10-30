/**
 * The single read seam for "which AI client does this tenant get". Resolution order:
 *   chat:       tenant default `ai_configs(scope='chat')` → platform `ANTHROPIC_API_KEY` →
 *               platform `AI_API_KEY` (OpenAI-compatible at `AI_BASE_URL`, else OpenAI; model
 *               `AI_MODEL`) → 503
 *   embeddings: tenant default `ai_configs(scope='embeddings')` → `EMBEDDINGS_API_KEY`
 *               (OpenAI-compatible at `EMBEDDINGS_BASE_URL`, else OpenAI; model
 *               `EMBEDDINGS_MODEL`) → 503; `resolvePlatformEmbeddings` is the platform tier
 *               alone (the Guide's global corpus)
 *   decisions:  tenant default `ai_configs(scope='decisions')` (TypeSafe) → platform
 *               `TYPESAFE_API_KEY` → the chat model on prompt key `agent-decide` (the
 *               uncalibrated `llm_self_report` fallback) → 503 from `resolveChat`
 * Credentials are decrypted here and nowhere else. `readiness()` mirrors both orders WITHOUT
 * building a client or throwing (the Home checklist must not turn a page load into a 503).
 * Feature code never queries `ai_configs`; the chat route, connection test and agents
 * all come through here — and tests mock this module (`vi.mock('@/api/services/ai/resolve')`).
 *
 * `promptKey` consults `agent_models` FIRST: an assignment for `(tenant, promptKey)`
 * names a specific chat config (`aiConfigId`, else the tenant default) and/or a model override; the
 * chain is then assignment → tenant default → platform → 503. Only chat is assignable — embeddings
 * feed a different client shape and no agent runs on them.
 *
 * The PLATFORM DEFAULT is a model id per prompt key for the platform tier only — a
 * `platform_agent_models` row (platform state, written by a global admin or an app's own tooling),
 * else the committed `PROMPT_DEFAULT_MODELS` entry (`@rocketpod/shared/ai/default-models`, empty by
 * default). It applies when the chain lands on the platform's own key (no assignment model, no
 * tenant config) AND that tier is the provider — and, for an `*_compatible` one, the base URL — the
 * id belongs to. So the full order for a prompt key is:
 *   tenant `agent_models` → tenant default `ai_configs` → platform default model on the platform
 *   key → the platform key's own default model → 503.
 * A tenant's own config is never overridden by it: that is the tenant's key and the tenant's spend
 * (`docs/CONCEPTS.md` §9 has the reasons).
 */
import type {
  AiProvider,
  AiReadiness,
  AiScope,
  AiScopeReadiness,
} from '@rocketpod/shared/ai/config'
import { DEFAULT_CHAT_MODELS, DEFAULT_MODELS } from '@rocketpod/shared/ai/config'
import type { DecisionMethod } from '@rocketpod/shared/ai/decisions'
import { promptDefaultModel } from '@rocketpod/shared/ai/default-models'
import type { PromptKey } from '@rocketpod/shared/ai/prompts'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import {
  type AgentModelRow,
  type AiConfigRow,
  agentModels,
  aiConfigs,
  type PlatformAgentModelRow,
  platformAgentModels,
} from '../../../db/schema'
import { decrypt, requireEncryptionKey } from '../../auth/oauth-encryption'
import { createChatClient, createEmbeddingsClient, type FetchLike } from './client'
import { createLlmDecisionClient } from './decisions/llm'
import type { DecisionClient } from './decisions/types'
import { createTypesafeClient } from './decisions/typesafe'
import { AiNotConfiguredError } from './errors'
import type { AiEnv, ChatClient, EmbeddingsClient, SystemPrompt } from './types'

export interface ResolvedChat {
  client: ChatClient
  provider: AiProvider
  model: string
  /**
   * `agent` = an `agent_models` assignment for `promptKey` decided the config and/or model;
   * `platform_default` = the platform tier ran the platform default model for `promptKey`.
   */
  source: 'tenant' | 'platform' | 'platform_default' | 'agent'
  /** `cfg.AGENT_MAX_OUTPUT_TOKENS` — the per-call `max_tokens` consumers pass. */
  maxOutputTokens: number
  configId?: string
}

export interface ResolvedEmbeddings {
  client: EmbeddingsClient
  provider: AiProvider
  model: string
  source: 'tenant' | 'platform'
  configId?: string
}

export interface ResolvedDecisions {
  client: DecisionClient
  provider: AiProvider
  model: string
  method: DecisionMethod
  /** `fallback` = no TypeSafe key anywhere, so the chat model answers (uncalibrated). */
  source: 'tenant' | 'platform' | 'fallback'
  configId?: string
}

/** The prompt key the decisions fallback resolves its chat model and system prompt on. */
export const DECISIONS_FALLBACK_PROMPT_KEY = 'agent-decide'

export interface ResolveOptions {
  /** Per-agent config/model lookup keyed on the prompt registry (`agent_models`). Chat only. */
  promptKey?: PromptKey
  /** Injected for tests. */
  fetch?: FetchLike
}

/** The tenant's default row for a scope (the partial unique index guarantees at most one). */
export async function findDefaultConfig(
  db: Database,
  tenantId: string,
  scope: AiScope
): Promise<AiConfigRow | undefined> {
  return db.query.aiConfigs.findFirst({
    where: and(
      eq(aiConfigs.tenantId, tenantId),
      eq(aiConfigs.scope, scope),
      eq(aiConfigs.isDefault, true)
    ),
  })
}

/** The `agent_models` assignment for a prompt key, or null (= tenant default). */
export async function findAgentModel(
  db: Database,
  tenantId: string,
  promptKey: PromptKey
): Promise<AgentModelRow | null> {
  const row = await db.query.agentModels.findFirst({
    where: and(eq(agentModels.tenantId, tenantId), eq(agentModels.promptKey, promptKey)),
  })
  return row ?? null
}

/** A platform default as resolution reads it: an applied row, or the committed table's entry. */
export type PlatformDefault = Pick<PlatformAgentModelRow, 'provider' | 'baseUrl' | 'model'> & {
  /** `applied` = a `platform_agent_models` row; `code` = a `PROMPT_DEFAULT_MODELS` entry. */
  origin: 'applied' | 'code'
}

/**
 * The platform default model for a prompt key, or null. Not tenant data. A `platform_agent_models`
 * row wins (it is the newer decision); else the committed `PROMPT_DEFAULT_MODELS` entry, so a fresh
 * database runs the chosen model without anyone writing a row.
 */
export async function findPlatformAgentModel(
  db: Database,
  promptKey: PromptKey
): Promise<PlatformDefault | null> {
  const row = await db.query.platformAgentModels.findFirst({
    where: eq(platformAgentModels.promptKey, promptKey),
  })
  if (row) {
    return { provider: row.provider, baseUrl: row.baseUrl, model: row.model, origin: 'applied' }
  }
  const committed = promptDefaultModel(promptKey)
  return committed
    ? { provider: committed.provider, baseUrl: null, model: committed.model, origin: 'code' }
    : null
}

/**
 * The platform default's model when THIS platform tier can serve it — same provider and, for an
 * `*_compatible` provider, the same base URL — else undefined (the tier's own model then runs).
 */
export function platformDefaultModel(
  platform: Pick<PlatformChat, 'provider' | 'baseUrl'> | null,
  row: Pick<PlatformDefault, 'provider' | 'baseUrl' | 'model'> | null
): string | undefined {
  if (!platform || !row) return undefined
  if (row.provider !== platform.provider) return undefined
  if ((row.baseUrl ?? null) !== (platform.baseUrl ?? null)) return undefined
  return row.model
}

/** A tenant's chat config by id — tenant-scoped so a foreign id reads as "not found". */
export async function findChatConfigById(
  db: Database,
  tenantId: string,
  id: string
): Promise<AiConfigRow | undefined> {
  return db.query.aiConfigs.findFirst({
    where: and(eq(aiConfigs.tenantId, tenantId), eq(aiConfigs.id, id), eq(aiConfigs.scope, 'chat')),
  })
}

/**
 * What `resolveChat` will use for a prompt key, BEFORE building a client: the assignment (if any),
 * the config row it lands on (tenant default when the assignment names none) and the model.
 * `config: undefined` means the platform key is next in line, and then `platformDefault` is the
 * platform default that may pick its model (`platformDefaultModel` decides whether the tier can
 * serve it) — read only when nothing of the tenant's chose a model. Shared by `resolveChat` and the
 * agent-models settings list so the two can never disagree.
 */
export async function planChat(
  db: Database,
  tenantId: string,
  promptKey?: PromptKey
): Promise<{
  assignment: AgentModelRow | null
  config: AiConfigRow | undefined
  model?: string
  /** The platform default for `promptKey`, when the chain falls through to the platform tier. */
  platformDefault: PlatformDefault | null
}> {
  const assignment = promptKey ? await findAgentModel(db, tenantId, promptKey) : null
  const config = assignment?.aiConfigId
    ? await findChatConfigById(db, tenantId, assignment.aiConfigId)
    : await findDefaultConfig(db, tenantId, 'chat')
  const model = assignment?.model ?? undefined
  const platformDefault =
    !config && !model && promptKey ? await findPlatformAgentModel(db, promptKey) : null
  return { assignment, config, model, platformDefault }
}

/** Decrypt a row's credential (null for key-less providers). The ONLY place `apiKeyEnc` is read. */
export async function credentialOf(
  row: Pick<AiConfigRow, 'apiKeyEnc'>,
  cfg: AppConfig
): Promise<string | null> {
  if (!row.apiKeyEnc) return null
  return decrypt(row.apiKeyEnc, requireEncryptionKey(cfg))
}

/** Build a chat client from ONE config row — exported for the connection test, which probes a named row. */
export async function chatClientFromRow(
  row: AiConfigRow,
  cfg: AppConfig,
  env: AiEnv,
  fetchImpl?: FetchLike
): Promise<ChatClient> {
  return createChatClient({
    provider: row.provider,
    apiKey: await credentialOf(row, cfg),
    baseUrl: row.baseUrl,
    defaults: { serviceTier: row.serviceTier, thinking: row.thinking },
    fetch: fetchImpl,
  })
}

/**
 * The OpenAI-compatible platform chat tier: `AI_API_KEY`, at `AI_BASE_URL` when one is set
 * (provider `openai_compatible`, which needs `AI_MODEL` — there is no sensible default model for an
 * arbitrary endpoint), else OpenAI itself (`AI_MODEL` or OpenAI's chat default).
 */
function platformOpenAiChat(cfg: AppConfig): PlatformChat | null {
  const apiKey = cfg.AI_API_KEY
  if (!apiKey) return null
  const baseUrl = cfg.AI_BASE_URL
  if (baseUrl) {
    const model = cfg.AI_MODEL
    if (!model) return null
    return {
      provider: 'openai_compatible',
      model,
      baseUrl,
      build: fetchImpl =>
        createChatClient({ provider: 'openai_compatible', apiKey, baseUrl, fetch: fetchImpl }),
    }
  }
  return {
    provider: 'openai',
    model: cfg.AI_MODEL ?? DEFAULT_CHAT_MODELS.openai ?? DEFAULT_MODELS.openai,
    build: fetchImpl => createChatClient({ provider: 'openai', apiKey, fetch: fetchImpl }),
  }
}

/** The platform embeddings tier for `EMBEDDINGS_API_KEY` (optionally at `EMBEDDINGS_BASE_URL`). */
function platformKeyEmbeddings(
  cfg: AppConfig
): { provider: AiProvider; model: string; apiKey: string; baseUrl?: string } | null {
  const apiKey = cfg.EMBEDDINGS_API_KEY
  if (!apiKey) return null
  const baseUrl = cfg.EMBEDDINGS_BASE_URL
  if (baseUrl) {
    const model = cfg.EMBEDDINGS_MODEL
    if (!model) return null
    return { provider: 'openai_compatible', model, apiKey, baseUrl }
  }
  return { provider: 'openai', model: cfg.EMBEDDINGS_MODEL ?? DEFAULT_MODELS.openai, apiKey }
}

/** The platform chat tier that answers when a tenant has no chat row, or null when none exists. */
export interface PlatformChat {
  provider: AiProvider
  model: string
  /** The `*_compatible` tier's endpoint (`AI_BASE_URL`); a platform default must match it. */
  baseUrl?: string
  build: (fetchImpl?: FetchLike) => ChatClient
}

/**
 * Platform order: the operator's `ANTHROPIC_API_KEY` (a deliberate choice) → the operator's
 * OpenAI-compatible `AI_API_KEY` (OpenRouter, vLLM, Ollama… at `AI_BASE_URL`; OpenAI itself
 * without one) → nothing. The ONE definition `resolveChat`, `readiness` and the agent-models list all read, so
 * the three can never disagree.
 */
export function platformChat(cfg: AppConfig, env: AiEnv): PlatformChat | null {
  if (cfg.ANTHROPIC_API_KEY) {
    const apiKey = cfg.ANTHROPIC_API_KEY
    return {
      provider: 'anthropic',
      model: DEFAULT_MODELS.anthropic,
      build: fetchImpl => createChatClient({ provider: 'anthropic', apiKey, fetch: fetchImpl }),
    }
  }
  const openAiCompatible = platformOpenAiChat(cfg)
  return openAiCompatible
}

export async function embeddingsClientFromRow(
  row: AiConfigRow,
  cfg: AppConfig,
  env: AiEnv,
  fetchImpl?: FetchLike
): Promise<EmbeddingsClient> {
  return createEmbeddingsClient({
    provider: row.provider,
    model: row.model,
    apiKey: await credentialOf(row, cfg),
    baseUrl: row.baseUrl,
    fetch: fetchImpl,
  })
}

/** Build a decisions client from ONE config row (TypeSafe) — the connection test probes through it. */
export async function decisionsClientFromRow(
  row: AiConfigRow,
  cfg: AppConfig,
  fetchImpl?: FetchLike
): Promise<DecisionClient> {
  const apiKey = await credentialOf(row, cfg)
  if (row.provider !== 'typesafe' || !apiKey) {
    throw new Error(`ai_configs row ${row.id} is not a usable decisions provider`)
  }
  return createTypesafeClient({ apiKey, baseUrl: row.baseUrl, fetch: fetchImpl })
}

/**
 * The client behind `ctx.decide`. `fallbackSystem` is the resolved `agent-decide` prompt —
 * the caller resolves it (prompts are read through `resolvePrompt`, which this module does not
 * import) and it is used only when the chain lands on the chat model.
 */
export async function resolveDecisions(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string,
  options: ResolveOptions & {
    fallbackSystem: SystemPrompt
    /** Wraps the fallback's chat client — the runtime passes `traceChatClient` so its calls are spans. */
    wrapChat?: (client: ChatClient, provider: AiProvider) => ChatClient
  }
): Promise<ResolvedDecisions> {
  const row = await findDefaultConfig(db, tenantId, 'decisions')
  if (row) {
    return {
      client: await decisionsClientFromRow(row, cfg, options.fetch),
      provider: row.provider,
      model: row.model,
      method: 'typesafe',
      source: 'tenant',
      configId: row.id,
    }
  }
  if (cfg.TYPESAFE_API_KEY) {
    return {
      client: createTypesafeClient({ apiKey: cfg.TYPESAFE_API_KEY, fetch: options.fetch }),
      provider: 'typesafe',
      model: DEFAULT_MODELS.typesafe,
      method: 'typesafe',
      source: 'platform',
    }
  }
  const chat = await resolveChat(db, cfg, env, tenantId, {
    promptKey: DECISIONS_FALLBACK_PROMPT_KEY,
    fetch: options.fetch,
  })
  return {
    client: createLlmDecisionClient({
      chat: options.wrapChat ? options.wrapChat(chat.client, chat.provider) : chat.client,
      system: options.fallbackSystem,
    }),
    provider: chat.provider,
    model: chat.model,
    method: 'llm_self_report',
    source: 'fallback',
    configId: chat.configId,
  }
}

export async function resolveChat(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string,
  options: ResolveOptions = {}
): Promise<ResolvedChat> {
  const {
    assignment,
    config: row,
    model: override,
    platformDefault,
  } = await planChat(db, tenantId, options.promptKey)
  const source = assignment ? 'agent' : 'tenant'
  if (row) {
    return {
      client: await chatClientFromRow(row, cfg, env, options.fetch),
      provider: row.provider,
      model: override ?? row.model,
      source,
      maxOutputTokens: cfg.AGENT_MAX_OUTPUT_TOKENS,
      configId: row.id,
    }
  }
  const platform = platformChat(cfg, env)
  if (platform) {
    const promoted = platformDefaultModel(platform, platformDefault)
    return {
      client: platform.build(options.fetch),
      provider: platform.provider,
      model: override ?? promoted ?? platform.model,
      source: assignment ? 'agent' : promoted ? 'platform_default' : 'platform',
      maxOutputTokens: cfg.AGENT_MAX_OUTPUT_TOKENS,
    }
  }
  throw new AiNotConfiguredError('chat')
}

/**
 * The PLATFORM embeddings tier alone (`EMBEDDINGS_*`), never a tenant's row — for a GLOBAL corpus
 * (the Guide, `services/guide-kb.ts`) whose committed vectors were built with the operator's
 * model, so the query embedder must be the same one whichever tenant asks. Null when no platform
 * key is set.
 */
export function resolvePlatformEmbeddings(
  cfg: AppConfig,
  options: { fetch?: FetchLike } = {}
): { client: EmbeddingsClient; provider: AiProvider; model: string } | null {
  const keyed = platformKeyEmbeddings(cfg)
  if (!keyed) return null
  return {
    client: createEmbeddingsClient({
      provider: keyed.provider,
      model: keyed.model,
      apiKey: keyed.apiKey,
      baseUrl: keyed.baseUrl,
      fetch: options.fetch,
    }),
    provider: keyed.provider,
    model: keyed.model,
  }
}

export async function resolveEmbeddings(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string,
  options: ResolveOptions = {}
): Promise<ResolvedEmbeddings> {
  const row = await findDefaultConfig(db, tenantId, 'embeddings')
  if (row) {
    return {
      client: await embeddingsClientFromRow(row, cfg, env, options.fetch),
      provider: row.provider,
      model: row.model,
      source: 'tenant',
      configId: row.id,
    }
  }
  const keyed = platformKeyEmbeddings(cfg)
  if (keyed) {
    return {
      client: createEmbeddingsClient({
        provider: keyed.provider,
        model: keyed.model,
        apiKey: keyed.apiKey,
        baseUrl: keyed.baseUrl,
        fetch: options.fetch,
      }),
      provider: keyed.provider,
      model: keyed.model,
      source: 'platform',
    }
  }
  throw new AiNotConfiguredError('embeddings')
}

/** What the three resolvers WOULD pick — no client is built, no credential decrypted, nothing thrown. */
export async function readiness(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string
): Promise<AiReadiness> {
  const [chatRow, embRow, decisionsRow] = await Promise.all([
    findDefaultConfig(db, tenantId, 'chat'),
    findDefaultConfig(db, tenantId, 'embeddings'),
    findDefaultConfig(db, tenantId, 'decisions'),
  ])
  const none: AiScopeReadiness = { ready: false, source: 'none' }
  const platform = platformChat(cfg, env)
  const platformEmbeddings = platformKeyEmbeddings(cfg)
  const chat: AiScopeReadiness = chatRow
    ? { ready: true, source: 'tenant', provider: chatRow.provider, model: chatRow.model }
    : platform
      ? { ready: true, source: 'platform', provider: platform.provider, model: platform.model }
      : none
  const embeddings: AiScopeReadiness = embRow
    ? { ready: true, source: 'tenant', provider: embRow.provider, model: embRow.model }
    : platformEmbeddings
      ? {
          ready: true,
          source: 'platform',
          provider: platformEmbeddings.provider,
          model: platformEmbeddings.model,
        }
      : none
  const decisions: AiScopeReadiness = decisionsRow
    ? { ready: true, source: 'tenant', provider: decisionsRow.provider, model: decisionsRow.model }
    : cfg.TYPESAFE_API_KEY
      ? { ready: true, source: 'platform', provider: 'typesafe', model: DEFAULT_MODELS.typesafe }
      : chat.ready
        ? { ready: true, source: 'fallback', provider: chat.provider, model: chat.model }
        : none
  return { chat, embeddings, decisions }
}
