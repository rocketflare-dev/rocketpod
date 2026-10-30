/**
 * Provider adapters behind the `ChatClient` / `EmbeddingsClient` seam in `types.ts`.
 *   - `anthropic` / `anthropic_compatible` → `@anthropic-ai/sdk` (fetch-based).
 *     Compatible vendors authenticate with `Authorization: Bearer` (the SDK's `authToken`), NOT
 *     `x-api-key` — passing the key as `apiKey` sends the wrong header and reads as a bad key.
 *   - `openai` → a small fetch client for the Responses API (`/v1/responses`, SSE, `store: false`);
 *     `openai_compatible` → the same for `/v1/chat/completions`. Both use `/v1/embeddings`. Base
 *     URLs include `/v1`.
 * What a MODEL accepts — thinking mode, sampling params, a forced `tool_choice` — is
 * `@rocketpod/shared/ai/models`; each adapter recovers once from a refusal the traits misjudged.
 * Reasoning (Claude thinking blocks, OpenAI reasoning items) rides the transcript as opaque
 * `reasoning` blocks and goes back to the provider that produced it, unmodified.
 * Per-tenant request defaults (`service_tier`, `thinking`) are injected HERE, where the client is
 * built, so no call site can forget them; `reconcileThinking` keeps a thinking budget legal against
 * the request it lands in. `fetch` is injectable so tests drive the adapters without a network.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { TokenUsage } from '@rocketpod/shared/ai/chat'
import {
  ADAPTIVE_THINKING_MIN_MAX_TOKENS,
  type AiProvider,
  EMBEDDING_DIM,
  THINKING_ANSWER_HEADROOM,
} from '@rocketpod/shared/ai/config'
import {
  type ModelTraits,
  modelTraits,
  openAiLowestEffort,
  openAiModelTraits,
} from '@rocketpod/shared/ai/models'
import { cachedSystem, withRollingCacheBreakpoints } from './agent-loop'
import { AiError, normalizeAiError } from './errors'
import { DEFAULT_BASE_URLS } from './providers'
import type {
  ChatClient,
  ChatDelta,
  ChatMessage,
  ChatParams,
  ChatResult,
  ContentBlock,
  EmbeddingsClient,
  ImageBlock,
  RequestDefaults,
  StopReason,
} from './types'

export type FetchLike = typeof fetch

export interface ChatClientOptions {
  provider: AiProvider
  apiKey?: string | null
  baseUrl?: string | null
  defaults?: RequestDefaults
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: FetchLike
}

export interface EmbeddingsClientOptions {
  provider: AiProvider
  model: string
  apiKey?: string | null
  baseUrl?: string | null
  fetch?: FetchLike
}

/** `tool_choice` values that FORCE a tool call and are therefore incompatible with extended thinking. */
const FORCED_TOOL_CHOICES = new Set(['tool', 'any'])

/**
 * Make an enabled thinking budget legal against the request it lands in: (1) thinking may not be
 * enabled when `tool_choice` forces a tool — drop it; (2) `max_tokens` must clear the budget by a
 * usable margin — raise it (output is billed on tokens produced, a cap never reached costs nothing).
 */
export function reconcileThinking(body: Record<string, unknown>): Record<string, unknown> {
  const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined
  if (thinking?.type !== 'enabled' || typeof thinking.budget_tokens !== 'number') return body
  const choice = (body.tool_choice as { type?: string } | undefined)?.type ?? ''
  if (FORCED_TOOL_CHOICES.has(choice)) {
    const { thinking: _dropped, ...rest } = body
    return rest
  }
  const floor = thinking.budget_tokens + THINKING_ANSWER_HEADROOM
  if (typeof body.max_tokens === 'number' && body.max_tokens >= floor) return body
  return { ...body, max_tokens: floor }
}

/**
 * The `thinking` field a config's setting becomes for THIS model, or undefined to send none.
 * `anthropic_compatible` vendors serve their own models behind Anthropic's wire format, so they keep
 * the original contract — explicit `disabled`, `enabled` + budget — and the refusal retry in the
 * client (`modelTraits`). First-party Claude follows `anthropicModelTraits`: 4.5 and earlier take
 * a budget; 4.6+ take `adaptive` (a stored budget is ignored — 4.7+ refuse it); "off" is
 * `disabled`, Sonnet 5.5's `between_tools`, or nothing at all on a model that always thinks.
 */
function anthropicThinking(
  traits: ModelTraits,
  defaults: RequestDefaults | undefined
): Record<string, unknown> | undefined {
  const setting = defaults?.thinking
  const budget = setting?.enabled ? setting.budgetTokens : undefined
  if (traits.thinking === 'extended') {
    return budget ? { type: 'enabled', budget_tokens: budget } : { type: 'disabled' }
  }
  if (setting?.enabled) return { type: 'adaptive' }
  if (traits.thinkingOff === 'disabled') return { type: 'disabled' }
  if (traits.thinkingOff === 'between_tools') return { type: 'between_tools' }
  return undefined
}

/** The body params a config's defaults imply. Thinking is sent EXPLICITLY when the model takes it. */
function anthropicDefaults(
  traits: ModelTraits,
  defaults: RequestDefaults | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (defaults?.serviceTier) out.service_tier = defaults.serviceTier
  const thinking = anthropicThinking(traits, defaults)
  if (thinking) out.thinking = thinking
  return out
}

export function createChatClient(opts: ChatClientOptions): ChatClient {
  switch (opts.provider) {
    case 'anthropic':
    case 'anthropic_compatible':
      return createAnthropicChatClient(opts)
    case 'openai':
      return createOpenAiResponsesClient(opts)
    case 'openai_compatible':
      return createOpenAiChatClient(opts)
    default:
      throw new AiError('invalid_request', opts.provider, `${opts.provider} has no chat adapter`)
  }
}

export function createEmbeddingsClient(opts: EmbeddingsClientOptions): EmbeddingsClient {
  switch (opts.provider) {
    case 'openai':
    case 'openai_compatible':
      return createOpenAiEmbeddings(opts)
    default:
      throw new AiError(
        'invalid_request',
        opts.provider,
        `${opts.provider} has no embeddings adapter`
      )
  }
}

// ---- Anthropic -----------------------------------------------------------------------------------

function toAnthropicContent(
  content: string | ContentBlock[],
  provider: AiProvider
): Anthropic.MessageParam['content'] {
  if (typeof content === 'string') return content
  // Reasoning goes back only to the provider that produced it; another adapter's is dropped whole.
  const own = content.filter(b => b.type !== 'reasoning' || b.provider === provider)
  return own.map((block): Anthropic.ContentBlockParam => {
    switch (block.type) {
      case 'reasoning':
        return block.data as Anthropic.ContentBlockParam
      case 'text':
        return { type: 'text', text: block.text }
      case 'image':
        return {
          type: 'image',
          source: { type: 'base64', media_type: block.mediaType, data: block.data },
        }
      case 'tool_use':
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} }
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: block.content,
          ...(block.isError ? { is_error: true } : {}),
        }
      default:
        throw new Error(`Unknown content block: ${JSON.stringify(block)}`)
    }
  })
}

function fromAnthropicContent(
  content: Anthropic.ContentBlock[],
  provider: AiProvider
): ContentBlock[] {
  const out: ContentBlock[] = []
  for (const block of content) {
    if (block.type === 'text') out.push({ type: 'text', text: block.text })
    else if (block.type === 'tool_use')
      out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
    // Thinking rides along opaque and UNMODIFIED (signature included): the API checks it when the
    // turn comes back with its tool results. Server tool blocks are dropped from the transcript.
    else if (block.type === 'thinking' || block.type === 'redacted_thinking')
      out.push({ type: 'reasoning', provider, data: block })
  }
  return out
}

function fromAnthropicUsage(usage: Anthropic.Usage | undefined): TokenUsage {
  const out: TokenUsage = {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  }
  if (usage?.cache_read_input_tokens != null) out.cacheReadTokens = usage.cache_read_input_tokens
  if (usage?.cache_creation_input_tokens != null)
    out.cacheWriteTokens = usage.cache_creation_input_tokens
  return out
}

function fromAnthropicStop(reason: Anthropic.Message['stop_reason']): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
      return reason
    default:
      return 'unknown'
  }
}

function toAnthropicToolChoice(choice: ChatParams['toolChoice']): Anthropic.ToolChoice | undefined {
  if (!choice) return undefined
  switch (choice.type) {
    case 'auto':
      return { type: 'auto' }
    case 'any':
      return { type: 'any' }
    case 'none':
      return { type: 'none' }
    case 'tool':
      return { type: 'tool', name: choice.name }
  }
}

/** What a client has learned its model refuses (see `createAnthropicChatClient`). */
interface AnthropicQuirks {
  omitThinking: boolean
  noSampling: boolean
  unforced: boolean
}

/** One recovery per kind, plus the reasoning strip — a bound, not a loop. */
const MAX_RECOVERIES = 4

function anthropicBody(
  provider: AiProvider,
  params: ChatParams,
  defaults: RequestDefaults | undefined,
  quirks?: AnthropicQuirks
): Anthropic.MessageCreateParams {
  const parsed = modelTraits(provider, params.model)
  const traits: ModelTraits = {
    ...parsed,
    sampling: parsed.sampling && !quirks?.noSampling,
    forcedToolChoice: parsed.forcedToolChoice && !quirks?.unforced,
  }
  const cache = params.cache ?? true
  const messages: Anthropic.MessageParam[] = params.messages.map(m => ({
    role: m.role,
    content: toAnthropicContent(m.content, provider),
  }))
  // A model that refuses a FORCED tool (Opus/Sonnet 5.5, Fable 5.1) is asked in the prompt instead
  // and left on `auto`; `callStructuredTool` already retries a reply that did not call it.
  const forced = params.toolChoice?.type === 'tool' || params.toolChoice?.type === 'any'
  const instruction =
    forced && !traits.forcedToolChoice ? forcedToolText(params.toolChoice) : undefined
  const system = instruction ? appendSystem(params.system, instruction) : params.system
  const body: Record<string, unknown> = {
    ...anthropicDefaults(traits, defaults),
    model: params.model,
    max_tokens: params.maxTokens,
    messages: cache ? withRollingCacheBreakpoints(messages) : messages,
  }
  if (system !== undefined) body.system = cachedSystem(system, cache)
  if (params.tools?.length) {
    body.tools = params.tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }))
    const choice = instruction
      ? { type: 'auto' as const }
      : toAnthropicToolChoice(params.toolChoice)
    if (choice) body.tool_choice = choice
  }
  // Claude 4.7+ refuse ANY non-default sampling value, and older models refuse it while thinking.
  const thinking = (body.thinking as { type?: string } | undefined)?.type
  const thinks = traits.thinksAnyway || thinking === 'enabled' || thinking === 'adaptive'
  if (params.temperature !== undefined && traits.sampling && !thinks) {
    body.temperature = params.temperature
  }
  // Adaptive thinking spends `max_tokens` too; a cap sized for the answer alone truncates it.
  if (
    traits.thinking === 'adaptive' &&
    thinks &&
    params.maxTokens < ADAPTIVE_THINKING_MIN_MAX_TOKENS
  ) {
    body.max_tokens = ADAPTIVE_THINKING_MIN_MAX_TOKENS
  }
  if (quirks?.omitThinking) body.thinking = undefined
  return reconcileThinking(body) as unknown as Anthropic.MessageCreateParams
}

/** Strip every reasoning block — the recovery when the API refuses a replayed one (see below). */
function withoutReasoning(params: ChatParams): ChatParams {
  return {
    ...params,
    messages: params.messages.map(m =>
      typeof m.content === 'string'
        ? m
        : { ...m, content: m.content.filter(b => b.type !== 'reasoning') }
    ),
  }
}

const hasReasoning = (params: ChatParams): boolean =>
  params.messages.some(
    m => typeof m.content !== 'string' && m.content.some(b => b.type === 'reasoning')
  )

function fromAnthropicMessage(message: Anthropic.Message, provider: AiProvider): ChatResult {
  return {
    content: fromAnthropicContent(message.content, provider),
    stopReason: fromAnthropicStop(message.stop_reason),
    usage: fromAnthropicUsage(message.usage),
    model: message.model,
  }
}

function createAnthropicChatClient(opts: ChatClientOptions): ChatClient {
  const provider = opts.provider
  if (!opts.apiKey) throw new AiError('auth', provider, 'An API key is required')
  if (provider === 'anthropic_compatible' && !opts.baseUrl) {
    throw new AiError(
      'invalid_request',
      provider,
      'A base URL is required for an Anthropic-compatible provider'
    )
  }
  // `apiKey: null` stops the SDK reading a platform env var and sending both headers.
  const sdk =
    provider === 'anthropic'
      ? new Anthropic({
          apiKey: opts.apiKey,
          baseURL: opts.baseUrl || undefined,
          fetch: opts.fetch,
          maxRetries: 2,
        })
      : new Anthropic({
          apiKey: null,
          authToken: opts.apiKey,
          baseURL: opts.baseUrl as string,
          fetch: opts.fetch,
          maxRetries: 2,
        })

  // Each refusal the traits could misjudge is recovered ONCE and remembered for the rest of this
  // client (one resolve, i.e. one turn or run step), so only its first call pays for finding out:
  // - `omitThinking`: the model refuses the `thinking` we sent. We send `disabled` by default
  //   because some vendors' models (Fireworks' GLM/Kimi) reason — and bill for it — unless told
  //   not to, but Fireworks maps it to reasoning effort `none`, which gpt-oss answers with a 400; and
  //   a Claude id `anthropicModelTraits` misreads can refuse `disabled` / `between_tools` / a budget.
  // - `noSampling` / `unforced`: a non-default `temperature`, or a forced `tool_choice`, refused.
  // - reasoning blocks the API will not take back (a changed prefix invalidates their signatures)
  //   are stripped for that one call — never remembered, the next turn's blocks are fresh.
  const quirks: AnthropicQuirks = { omitThinking: false, noSampling: false, unforced: false }
  const bodyFor = (params: ChatParams): Anthropic.MessageCreateParams =>
    anthropicBody(provider, params, opts.defaults, quirks)
  /** The recovery a 400 calls for, applied; null when there is none left to try. */
  const recover = (err: unknown, params: ChatParams): ChatParams | null => {
    if (!(err instanceof Anthropic.APIError) || err.status !== 400) return null
    const message = err.message
    if (hasReasoning(params) && /signature|cannot be modified|redacted_thinking/i.test(message)) {
      return withoutReasoning(params)
    }
    if (!quirks.omitThinking && /reasoning effort|thinking/i.test(message)) {
      quirks.omitThinking = true
      return params
    }
    if (
      !quirks.noSampling &&
      params.temperature !== undefined &&
      /temperature|top_p|top_k/i.test(message)
    ) {
      quirks.noSampling = true
      return params
    }
    if (!quirks.unforced && /tool_choice/i.test(message)) {
      quirks.unforced = true
      return params
    }
    return null
  }

  /** One streamed request, raw SDK errors and all — `stream` decides whether to retry. */
  async function* streamOnce(params: ChatParams): AsyncIterable<ChatDelta> {
    const stream = sdk.messages.stream(bodyFor(params), { signal: params.signal })
    const pendingTools = new Map<number, { id: string; name: string; json: string }>()
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        pendingTools.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name,
          json: '',
        })
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') yield { type: 'text', text: event.delta.text }
        else if (event.delta.type === 'input_json_delta') {
          const pending = pendingTools.get(event.index)
          if (pending) pending.json += event.delta.partial_json
        }
      } else if (event.type === 'content_block_stop') {
        const pending = pendingTools.get(event.index)
        if (pending) {
          pendingTools.delete(event.index)
          yield {
            type: 'tool_use',
            id: pending.id,
            name: pending.name,
            input: safeJson(pending.json),
          }
        }
      }
    }
    const result = fromAnthropicMessage(await stream.finalMessage(), provider)
    yield { type: 'usage', usage: result.usage }
    yield { type: 'end', result }
  }

  return {
    provider,
    async complete(params) {
      let current = params
      for (let attempt = 0; ; attempt++) {
        try {
          const message = await sdk.messages.create(
            { ...bodyFor(current), stream: false },
            { signal: params.signal }
          )
          return fromAnthropicMessage(message, provider)
        } catch (err) {
          const next = attempt < MAX_RECOVERIES ? recover(err, current) : null
          if (!next) throw normalizeAiError(err, provider)
          current = next
        }
      }
    },
    async *stream(params) {
      let current = params
      for (let attempt = 0; ; attempt++) {
        let yielded = false
        try {
          for await (const delta of streamOnce(current)) {
            yielded = true
            yield delta
          }
          return
        } catch (err) {
          // A refusal arrives before the first event, so a retry can never duplicate output.
          const next = !yielded && attempt < MAX_RECOVERIES ? recover(err, current) : null
          if (!next) throw normalizeAiError(err, provider)
          current = next
        }
      }
    },

    async countTokens(params) {
      try {
        const body = anthropicBody(provider, { ...params, maxTokens: 1 }, undefined)
        const { input_tokens } = await sdk.messages.countTokens({
          model: body.model,
          messages: body.messages,
          ...(body.system ? { system: body.system } : {}),
          ...(body.tools
            ? { tools: body.tools as Anthropic.MessageCountTokensParams['tools'] }
            : {}),
        })
        return input_tokens
      } catch (err) {
        throw normalizeAiError(err, provider)
      }
    },
  }
}

function safeJson(text: string): unknown {
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text }
  }
}

// ---- OpenAI-compatible chat ------------------------------------------------------------------------

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** A user message's parts when it carries a picture (`image_url` takes a `data:` URL). */
type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAiContentPart[] | null
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}

interface OpenAiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

interface OpenAiChoice {
  index: number
  finish_reason: string | null
  /** An ANSWER's message: its content is text (parts are only ever sent, never received). */
  message?: Omit<OpenAiMessage, 'content'> & { content: string | null }
  delta?: Partial<Omit<OpenAiMessage, 'content'>> & {
    content?: string | null
    tool_calls?: Array<
      Partial<OpenAiToolCall> & { index: number; function?: Partial<OpenAiToolCall['function']> }
    >
  }
}

interface OpenAiCompletion {
  model?: string
  choices: OpenAiChoice[]
  usage?: OpenAiUsage
}

function systemText(system: ChatParams['system']): string | undefined {
  if (system === undefined) return undefined
  if (typeof system === 'string') return system
  return system.volatile?.trim() ? `${system.stable}\n\n${system.volatile}` : system.stable
}

/** Our block-shaped transcript → OpenAI's flat message list (tool results become `role: tool` turns). */
function toOpenAiMessages(params: ChatParams): OpenAiMessage[] {
  const out: OpenAiMessage[] = []
  const system = systemText(params.system)
  if (system) out.push({ role: 'system', content: system })
  for (const m of params.messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    if (m.role === 'assistant') {
      const text = m.content
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('')
      const calls = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map<OpenAiToolCall>(b => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }))
      out.push({
        role: 'assistant',
        // Null is correct OpenAI for a pure tool-call turn.
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      })
      continue
    }
    const texts: string[] = []
    const images: ImageBlock[] = []
    for (const block of m.content) {
      if (block.type === 'text') texts.push(block.text)
      else if (block.type === 'image') images.push(block)
      else if (block.type === 'tool_result')
        out.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content })
    }
    // A tool message is text-only, so a picture follows the tool results as a user message.
    if (images.length) {
      out.push({
        role: 'user',
        content: [
          ...(texts.length ? [{ type: 'text' as const, text: texts.join('\n') }] : []),
          ...images.map(image => ({
            type: 'image_url' as const,
            image_url: { url: `data:${image.mediaType};base64,${image.data}` },
          })),
        ],
      })
    } else if (texts.length) out.push({ role: 'user', content: texts.join('\n') })
  }
  return out
}

/**
 * JSON Schema keywords an OpenAI-compatible endpoint refuses in a tool's `parameters`. MEASURED,
 * never assumed: Gemini's endpoint answers a bare `400 INVALID_ARGUMENT` to a tool schema carrying
 * `maxItems` (bisected live on `gemini-3.8-flash`). Recognised by the base URL or a `gemini-*` model id —
 * a proxy in front of Gemini is caught by the second. The parse on our side still enforces every
 * bound, so a model that ignores the restated cap costs that answer, never the data.
 */
export function unsupportedSchemaKeywords(baseUrl: string, model: string): readonly string[] {
  return /generativelanguage\.googleapis\.com/.test(baseUrl) || /^(models\/)?gemini-/.test(model)
    ? ['maxItems']
    : []
}

const BOUND_WORDING: Record<string, (n: number) => string> = {
  maxItems: n => `At most ${n} item${n === 1 ? '' : 's'}.`,
  minItems: n => `At least ${n} item${n === 1 ? '' : 's'}.`,
  maxLength: n => `At most ${n} characters.`,
  minLength: n => `At least ${n} character${n === 1 ? '' : 's'}.`,
  maximum: n => `At most ${n}.`,
  minimum: n => `At least ${n}.`,
}

/**
 * `schema` with `unsupported` keywords removed at every SCHEMA position (a key inside `properties`
 * is a field name, so a field called `maxItems` survives); a dropped bound is restated in the
 * description so the model is still told it.
 */
export function withoutSchemaKeywords(schema: unknown, unsupported: readonly string[]): unknown {
  if (Array.isArray(schema)) return schema.map(item => withoutSchemaKeywords(item, unsupported))
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  const restated: string[] = []
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (unsupported.includes(key)) {
      const wording = BOUND_WORDING[key]
      if (wording && typeof value === 'number') restated.push(wording(value))
      continue
    }
    if ((key === 'properties' || key === '$defs' || key === 'definitions') && value) {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, sub]) => [
          name,
          withoutSchemaKeywords(sub, unsupported),
        ])
      )
    } else {
      out[key] = withoutSchemaKeywords(value, unsupported)
    }
  }
  if (restated.length) {
    const prior = typeof out.description === 'string' ? out.description.trimEnd() : ''
    out.description = [prior, ...restated].filter(Boolean).join(' ')
  }
  return out
}

function openAiBody(
  params: ChatParams,
  stream: boolean,
  unsupported: readonly string[] = []
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: toOpenAiMessages(params),
    max_tokens: params.maxTokens,
    stream,
  }
  if (stream) body.stream_options = { include_usage: true }
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.tools?.length) {
    body.tools = params.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: unsupported.length
          ? withoutSchemaKeywords(t.inputSchema, unsupported)
          : t.inputSchema,
      },
    }))
    const choice = params.toolChoice
    if (choice?.type === 'tool')
      body.tool_choice = { type: 'function', function: { name: choice.name } }
    else if (choice?.type === 'any') body.tool_choice = 'required'
    else if (choice?.type === 'none') body.tool_choice = 'none'
    else if (choice) body.tool_choice = 'auto'
  }
  return body
}

/**
 * `TokenUsage.inputTokens` means UNCACHED input everywhere: that is what Anthropic reports
 * (`input_tokens` excludes both cache counters) and what `estimateCostMicrocents` prices at the
 * input rate. OpenAI counts the other way — `prompt_tokens` INCLUDES
 * `prompt_tokens_details.cached_tokens` — so the cached half is subtracted here, or it is billed
 * twice, at the full rate and again at the cache rate. Normalising in the adapter keeps the one
 * meaning in one place, rather than a per-provider branch inside pricing where nobody reading a
 * cost would think to look.
 */
function fromOpenAiUsage(usage: OpenAiUsage | undefined): TokenUsage {
  const prompt = usage?.prompt_tokens ?? 0
  const cached = usage?.prompt_tokens_details?.cached_tokens
  const out: TokenUsage = {
    inputTokens: typeof cached === 'number' ? Math.max(prompt - cached, 0) : prompt,
    outputTokens: usage?.completion_tokens ?? 0,
  }
  if (typeof cached === 'number') out.cacheReadTokens = cached
  return out
}

function fromOpenAiFinish(reason: string | null | undefined, hadTools: boolean): StopReason {
  if (reason === 'tool_calls' || (reason === 'stop' && hadTools)) return 'tool_use'
  if (reason === 'stop') return 'end_turn'
  if (reason === 'length') return 'max_tokens'
  return reason ? 'unknown' : 'end_turn'
}

function parseArguments(args: string): unknown {
  return safeJson(args)
}

class OpenAiHttpError extends Error {
  constructor(
    public readonly status: number,
    body: string
  ) {
    super(`${status} ${body}`)
    this.name = 'OpenAiHttpError'
  }
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  apiKey: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok)
    throw new OpenAiHttpError(res.status, (await res.text().catch(() => '')).slice(0, 500))
  return res
}

/** Yield the `data:` payloads of an SSE body, stopping at `[DONE]`. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n')
        if (data === '[DONE]') return
        if (data) yield data
        boundary = buffer.indexOf('\n\n')
      }
    }
    const tail = buffer.trim()
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim()
      if (data && data !== '[DONE]') yield data
    }
  } finally {
    reader.releaseLock()
  }
}

function createOpenAiChatClient(opts: ChatClientOptions): ChatClient {
  const provider = opts.provider
  if (!opts.apiKey) throw new AiError('auth', provider, 'An API key is required')
  const base = (opts.baseUrl || DEFAULT_BASE_URLS[provider] || '').replace(/\/+$/, '')
  if (!base)
    throw new AiError(
      'invalid_request',
      provider,
      'A base URL is required for an OpenAI-compatible provider'
    )
  const apiKey = opts.apiKey
  const fetchImpl = opts.fetch ?? fetch
  const url = `${base}/chat/completions`

  return {
    provider,
    async complete(params) {
      try {
        const res = await postJson(
          fetchImpl,
          url,
          apiKey,
          openAiBody(params, false, unsupportedSchemaKeywords(base, params.model)),
          params.signal
        )
        const json = (await res.json()) as OpenAiCompletion
        const choice = json.choices?.[0]
        const content: ContentBlock[] = []
        if (choice?.message?.content) content.push({ type: 'text', text: choice.message.content })
        for (const call of choice?.message?.tool_calls ?? []) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: parseArguments(call.function.arguments),
          })
        }
        return {
          content,
          stopReason: fromOpenAiFinish(
            choice?.finish_reason,
            Boolean(choice?.message?.tool_calls?.length)
          ),
          usage: fromOpenAiUsage(json.usage),
          model: json.model ?? params.model,
        }
      } catch (err) {
        throw normalizeAiError(err, provider)
      }
    },
    async *stream(params) {
      try {
        const res = await postJson(
          fetchImpl,
          url,
          apiKey,
          openAiBody(params, true, unsupportedSchemaKeywords(base, params.model)),
          params.signal
        )
        if (!res.body) throw new AiError('unavailable', provider, 'Empty response body')
        let text = ''
        let model = params.model
        let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
        let finish: string | null = null
        const calls = new Map<number, { id: string; name: string; args: string }>()
        for await (const data of sseData(res.body)) {
          const chunk = safeJson(data) as OpenAiCompletion & { error?: { message?: string } }
          if (chunk.error)
            throw new AiError('unknown', provider, chunk.error.message ?? 'Provider error')
          if (chunk.model) model = chunk.model
          if (chunk.usage) usage = fromOpenAiUsage(chunk.usage)
          const choice = chunk.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finish = choice.finish_reason
          const delta = choice.delta
          if (delta?.content) {
            text += delta.content
            yield { type: 'text', text: delta.content }
          }
          for (const tc of delta?.tool_calls ?? []) {
            const entry = calls.get(tc.index) ?? { id: '', name: '', args: '' }
            if (tc.id) entry.id = tc.id
            if (tc.function?.name) entry.name = tc.function.name
            if (tc.function?.arguments) entry.args += tc.function.arguments
            calls.set(tc.index, entry)
          }
        }
        const content: ContentBlock[] = []
        if (text) content.push({ type: 'text', text })
        for (const call of [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c)) {
          const block: ContentBlock = {
            type: 'tool_use',
            id: call.id || crypto.randomUUID(),
            name: call.name,
            input: parseArguments(call.args),
          }
          content.push(block)
          yield block
        }
        const result: ChatResult = {
          content,
          stopReason: fromOpenAiFinish(finish, calls.size > 0),
          usage,
          model,
        }
        yield { type: 'usage', usage }
        yield { type: 'end', result }
      } catch (err) {
        throw normalizeAiError(err, provider)
      }
    },
  }
}

// ---- OpenAI Responses (first-party `openai`) -----------------------------------------------------

/**
 * OpenAI's own endpoint speaks the Responses API, not Chat Completions: Chat Completions cannot call
 * tools on `gpt-6-astra` / `gpt-6.1-sol` at all, and on Luna/Sol only with reasoning switched off,
 * which is every tool loop the app runs. `store: false` keeps nothing on OpenAI's side; the
 * reasoning items come back with `encrypted_content` and ride the transcript as opaque
 * `reasoning` blocks, sent back in their original order with the tool results that follow — "all
 * items between the last user message and your function call output … untouched".
 * `openai_compatible` stays on Chat Completions, which is what vLLM, Ollama and proxies speak.
 */
type ResponsesItem = Record<string, unknown>

interface ResponsesUsage {
  input_tokens?: number
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  output_tokens?: number
}

interface ResponsesResult {
  model?: string
  status?: string
  incomplete_details?: { reason?: string } | null
  error?: { message?: string } | null
  output?: ResponsesItem[]
  usage?: ResponsesUsage
}

/** Our block-shaped transcript → Responses input items, assistant blocks kept in order. */
export function toResponsesInput(params: ChatParams): ResponsesItem[] {
  const out: ResponsesItem[] = []
  for (const m of params.messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    if (m.role === 'assistant') {
      let text = ''
      const flush = () => {
        if (text) out.push({ role: 'assistant', content: text })
        text = ''
      }
      for (const block of m.content) {
        if (block.type === 'text') text += block.text
        else if (block.type === 'reasoning') {
          if (block.provider !== 'openai') continue
          flush()
          out.push(block.data as ResponsesItem)
        } else if (block.type === 'tool_use') {
          flush()
          out.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          })
        }
      }
      flush()
      continue
    }
    const texts: string[] = []
    const images: ImageBlock[] = []
    for (const block of m.content) {
      if (block.type === 'text') texts.push(block.text)
      else if (block.type === 'image') images.push(block)
      else if (block.type === 'tool_result')
        out.push({ type: 'function_call_output', call_id: block.toolUseId, output: block.content })
    }
    if (images.length) {
      out.push({
        role: 'user',
        content: [
          ...(texts.length ? [{ type: 'input_text', text: texts.join('\n') }] : []),
          ...images.map(image => ({
            type: 'input_image',
            image_url: `data:${image.mediaType};base64,${image.data}`,
          })),
        ],
      })
    } else if (texts.length) out.push({ role: 'user', content: texts.join('\n') })
  }
  return out
}

/** What a Responses client has learned its model refuses (see `createOpenAiResponsesClient`). */
interface ResponsesQuirks {
  effortLow: boolean
  noSampling: boolean
}

export function responsesBody(
  params: ChatParams,
  defaults: RequestDefaults | undefined,
  stream: boolean,
  quirks?: ResponsesQuirks
): Record<string, unknown> {
  const traits = openAiModelTraits(params.model)
  const body: Record<string, unknown> = {
    model: params.model,
    input: toResponsesInput(params),
    max_output_tokens: params.maxTokens,
    stream,
    store: false,
  }
  const instructions = systemText(params.system)
  if (instructions) body.instructions = instructions
  // Thinking on = the model's own default effort; off = the lowest it takes.
  let effort: string | undefined
  if (traits.thinking === 'effort' && !defaults?.thinking?.enabled) {
    effort = quirks?.effortLow ? 'low' : openAiLowestEffort(params.model)
    body.reasoning = { effort }
  }
  const reasons = traits.thinking === 'effort' && effort !== 'none'
  // GPT-6: "When reasoning effort is not `none`, remove `temperature`".
  if (params.temperature !== undefined && !quirks?.noSampling && (traits.sampling || !reasons)) {
    body.temperature = params.temperature
  }
  if (reasons && params.maxTokens < ADAPTIVE_THINKING_MIN_MAX_TOKENS) {
    body.max_output_tokens = ADAPTIVE_THINKING_MIN_MAX_TOKENS
  }
  if (params.tools?.length) {
    body.tools = params.tools.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      // Strict mode needs every property `required` + `additionalProperties: false`, which a zod
      // schema with optional fields does not render to; `callStructuredTool` validates anyway.
      strict: false,
    }))
    const choice = params.toolChoice
    if (choice?.type === 'tool') body.tool_choice = { type: 'function', name: choice.name }
    else if (choice?.type === 'any') body.tool_choice = 'required'
    else if (choice?.type === 'none') body.tool_choice = 'none'
    else if (choice) body.tool_choice = 'auto'
  }
  return body
}

/**
 * `input_tokens` INCLUDES the cached and the cache-written tokens (OpenAI's caching guide:
 * ordinary = input − cached − cache_write); `TokenUsage` counters are disjoint, as everywhere.
 */
export function fromResponsesUsage(usage: ResponsesUsage | undefined): TokenUsage {
  const input = usage?.input_tokens ?? 0
  const cached = usage?.input_tokens_details?.cached_tokens
  const written = usage?.input_tokens_details?.cache_write_tokens
  const out: TokenUsage = {
    inputTokens: Math.max(input - (cached ?? 0) - (written ?? 0), 0),
    outputTokens: usage?.output_tokens ?? 0,
  }
  if (typeof cached === 'number') out.cacheReadTokens = cached
  if (typeof written === 'number' && written > 0) out.cacheWriteTokens = written
  return out
}

function fromResponsesItems(items: ResponsesItem[]): ContentBlock[] {
  const content: ContentBlock[] = []
  for (const item of items) {
    if (item.type === 'message') {
      const parts = (item.content as Array<{ type?: string; text?: string }> | undefined) ?? []
      const text = parts
        .filter(p => p.type === 'output_text')
        .map(p => p.text ?? '')
        .join('')
      if (text) content.push({ type: 'text', text })
    } else if (item.type === 'function_call') {
      content.push({
        type: 'tool_use',
        id: String(item.call_id ?? item.id ?? crypto.randomUUID()),
        name: String(item.name ?? ''),
        input: parseArguments(String(item.arguments ?? '')),
      })
    } else if (item.type === 'reasoning') {
      content.push({ type: 'reasoning', provider: 'openai', data: item })
    }
  }
  return content
}

function fromResponsesResult(
  json: ResponsesResult,
  items: ResponsesItem[],
  model: string
): ChatResult {
  const content = fromResponsesItems(items)
  const calls = content.some(b => b.type === 'tool_use')
  const stopReason: StopReason =
    json.status === 'incomplete'
      ? json.incomplete_details?.reason === 'max_output_tokens'
        ? 'max_tokens'
        : 'unknown'
      : calls
        ? 'tool_use'
        : json.status === 'completed' || json.status === undefined
          ? 'end_turn'
          : 'unknown'
  return { content, stopReason, usage: fromResponsesUsage(json.usage), model: json.model ?? model }
}

function createOpenAiResponsesClient(opts: ChatClientOptions): ChatClient {
  const provider = opts.provider
  if (!opts.apiKey) throw new AiError('auth', provider, 'An API key is required')
  const base = (opts.baseUrl || DEFAULT_BASE_URLS[provider] || '').replace(/\/+$/, '')
  const apiKey = opts.apiKey
  const fetchImpl = opts.fetch ?? fetch
  const url = `${base}/responses`

  // Recovered ONCE and remembered for this client, like the Anthropic adapter: a model that
  // refuses the lowest effort we sent (`none` on a model this file does not know), or `temperature`.
  const quirks: ResponsesQuirks = { effortLow: false, noSampling: false }
  const recover = (err: unknown, params: ChatParams): boolean => {
    if (!(err instanceof OpenAiHttpError) || err.status !== 400) return false
    if (!quirks.effortLow && /effort|reasoning/i.test(err.message)) {
      quirks.effortLow = true
      return true
    }
    if (
      !quirks.noSampling &&
      params.temperature !== undefined &&
      /temperature/i.test(err.message)
    ) {
      quirks.noSampling = true
      return true
    }
    return false
  }
  const post = async (params: ChatParams, stream: boolean): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const body = responsesBody(params, opts.defaults, stream, quirks)
        return await postJson(fetchImpl, url, apiKey, body, params.signal)
      } catch (err) {
        if (attempt >= 2 || !recover(err, params)) throw err
      }
    }
  }

  return {
    provider,
    async complete(params) {
      try {
        const res = await post(params, false)
        const json = (await res.json()) as ResponsesResult
        if (json.status === 'failed')
          throw new AiError('unknown', provider, json.error?.message ?? 'Provider error')
        return fromResponsesResult(json, json.output ?? [], params.model)
      } catch (err) {
        throw normalizeAiError(err, provider)
      }
    },
    async *stream(params) {
      try {
        const res = await post(params, true)
        if (!res.body) throw new AiError('unavailable', provider, 'Empty response body')
        // Items are taken from `output_item.done` — `encrypted_content` on `.added` may be partial.
        const items = new Map<number, ResponsesItem>()
        let final: ResponsesResult | undefined
        for await (const data of sseData(res.body)) {
          const event = safeJson(data) as {
            type?: string
            delta?: string
            output_index?: number
            item?: ResponsesItem
            response?: ResponsesResult
            message?: string
          }
          if (event.type === 'response.output_text.delta' && event.delta) {
            yield { type: 'text', text: event.delta }
          } else if (event.type === 'response.output_item.done' && event.item) {
            items.set(event.output_index ?? items.size, event.item)
            const [block] = fromResponsesItems([event.item])
            if (block?.type === 'tool_use') yield block
          } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
            final = event.response
          } else if (event.type === 'response.failed') {
            throw new AiError(
              'unknown',
              provider,
              event.response?.error?.message ?? 'Provider error'
            )
          } else if (event.type === 'error') {
            throw new AiError('unknown', provider, event.message ?? 'Provider error')
          }
        }
        const ordered = [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
        const result = fromResponsesResult(
          final ?? {},
          ordered.length ? ordered : (final?.output ?? []),
          params.model
        )
        yield { type: 'usage', usage: result.usage }
        yield { type: 'end', result }
      } catch (err) {
        throw normalizeAiError(err, provider)
      }
    },
  }
}

// ---- Forced tools ----------------------------------------------------------------------------------

/** A forcing `tool_choice` as a sentence, for a model that cannot be forced on the wire. */
export function forcedToolText(choice: ChatParams['toolChoice']): string | undefined {
  if (choice?.type === 'tool')
    return `You must answer by calling the "${choice.name}" tool with its required arguments. Do not reply in plain text.`
  if (choice?.type === 'any')
    return 'You must answer by calling one of the available tools. Do not reply in plain text.'
  return undefined
}

function appendSystem(system: ChatParams['system'], extra: string): ChatParams['system'] {
  if (system === undefined) return extra
  if (typeof system === 'string') return `${system}\n\n${extra}`
  return {
    stable: system.stable,
    volatile: system.volatile?.trim() ? `${system.volatile}\n\n${extra}` : extra,
  }
}

// ---- Embeddings ----------------------------------------------------------------------------------

function createOpenAiEmbeddings(opts: EmbeddingsClientOptions): EmbeddingsClient {
  const provider = opts.provider
  if (!opts.apiKey) throw new AiError('auth', provider, 'An API key is required')
  const base = (opts.baseUrl || DEFAULT_BASE_URLS[provider] || '').replace(/\/+$/, '')
  if (!base)
    throw new AiError(
      'invalid_request',
      provider,
      'A base URL is required for an OpenAI-compatible provider'
    )
  const apiKey = opts.apiKey
  const fetchImpl = opts.fetch ?? fetch
  return {
    provider,
    model: opts.model,
    dimension: EMBEDDING_DIM,
    async embed(texts) {
      if (texts.length === 0) return []
      try {
        const res = await postJson(fetchImpl, `${base}/embeddings`, apiKey, {
          model: opts.model,
          input: texts,
          dimensions: EMBEDDING_DIM,
        })
        const json = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> }
        return json.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
      } catch (err) {
        throw normalizeAiError(err, provider)
      }
    },
  }
}

/** Re-exported so consumers wiring messages by hand have one import. */
export type { ChatMessage }
