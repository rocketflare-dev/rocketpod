/**
 * The provider seam (D17): a small, provider-neutral chat/embeddings interface that every consumer
 * (chat route, `kit.ts` loops, Phase 3b agents) codes against. Adapters in `client.ts` map it onto
 * the Anthropic Messages API (`anthropic`, `anthropic_compatible`) and OpenAI chat completions
 * (`openai`, `openai_compatible`). Content is block-shaped — text, tool_use, tool_result — because
 * that is what a tool loop needs to round-trip; a plain string is accepted as shorthand.
 */
import type { TokenUsage } from '@rocketpod/shared/ai/chat'
import type { AiProvider, ThinkingSetting } from '@rocketpod/shared/ai/config'
import type { DocumentConverter } from '../../../platform/types'

export type ContentBlock =
  | { type: 'text'; text: string }
  | ImageBlock
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | ReasoningBlock

/**
 * A picture in a USER message, base64. Each adapter sends it in its own wire shape: an Anthropic
 * `image` block, an OpenAI chat `image_url` part (a `data:` URL, in a user message AFTER the turn's
 * tool results, because a `tool` message is text-only), a Responses `input_image` part. A tool
 * result is text here, so a caller that wants the model to SEE a file a tool opened lifts it out
 * into an `image` block of the next user turn.
 *
 * ⚠️ The tracer records messages as they are: a caller sending a user's private file redacts it
 * from its spans (or turns `OBSERVABILITY_CAPTURE_CONTENT` off).
 */
export interface ImageBlock {
  type: 'image'
  mediaType: (typeof IMAGE_MEDIA_TYPES)[number]
  data: string
}

/** The picture types every adapter's wire shape accepts. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

/**
 * A provider's reasoning, carried OPAQUE through a tool loop: Anthropic's `thinking` /
 * `redacted_thinking` blocks, OpenAI's `reasoning` items. Both vendors want them sent back,
 * byte-for-byte, with the tool results that follow — Claude 5.x and the GPT reasoning models lose
 * the reasoning (and the cache) otherwise. Only the adapter that produced one reads `data`; every
 * other adapter drops it. It is never shown, persisted to chat history or counted as text.
 */
export interface ReasoningBlock {
  type: 'reasoning'
  provider: AiProvider
  data: unknown
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

/**
 * A system prompt, optionally split at the prompt-cache breakpoint: `stable` is cached, `volatile`
 * (per-turn context) is appended AFTER the breakpoint so one byte of drift never invalidates the
 * cached prefix. A plain string is entirely stable. Only Anthropic honours the split; the OpenAI
 * adapter concatenates.
 */
export type SystemPrompt = string | { stable: string; volatile?: string }

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema (object) for the tool input — `toolInputSchema` in `kit.ts` builds it from zod (`z.toJSONSchema`). */
  inputSchema: Record<string, unknown>
}

export type ToolChoice =
  | { type: 'auto' }
  | { type: 'none' }
  | { type: 'any' }
  | { type: 'tool'; name: string }

export interface ChatParams {
  model: string
  system?: SystemPrompt
  messages: ChatMessage[]
  maxTokens: number
  tools?: ToolDefinition[]
  toolChoice?: ToolChoice
  temperature?: number
  signal?: AbortSignal
  /** Anthropic prompt caching breakpoints on system + last two messages (default true). */
  cache?: boolean
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'unknown'

export interface ChatResult {
  content: ContentBlock[]
  stopReason: StopReason
  usage: TokenUsage
  model: string
}

/** What `stream()` yields. Tool calls arrive whole once their input JSON is complete. */
export type ChatDelta =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'end'; result: ChatResult }

export interface ChatClient {
  readonly provider: AiProvider
  stream(params: ChatParams): AsyncIterable<ChatDelta>
  complete(params: ChatParams): Promise<ChatResult>
  /** Anthropic only today; absent means "estimate yourself". */
  countTokens?(params: Pick<ChatParams, 'model' | 'system' | 'messages' | 'tools'>): Promise<number>
}

export interface EmbeddingsClient {
  readonly provider: AiProvider
  readonly model: string
  /** Every vector `embed` returns has this many components (D18: 1024). */
  readonly dimension: number
  embed(texts: string[]): Promise<number[][]>
}

/** Per-tenant request-body defaults injected where the client is BUILT (never at call sites). */
export interface RequestDefaults {
  serviceTier?: string | null
  thinking?: ThinkingSetting
}

export type { MarkdownConversion, MarkdownDocumentInput } from '../../../platform/types'

/**
 * What the AI services read from the platform (`Platform` satisfies it). Optional: an install with
 * no converter still indexes text uploads.
 */
export interface AiEnv {
  readonly converter?: DocumentConverter | null
}

/** Sum two usage reports (multi-turn loops report the total). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const out: TokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
  if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined) {
    out.cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0)
  }
  if (a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined) {
    out.cacheWriteTokens = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0)
  }
  return out
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 }

/** The concatenated text blocks of a result. */
export function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('')
}

export function toolUsesOf(content: ContentBlock[]) {
  return content.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
  )
}
