/**
 * Chat compaction (D17): fold the messages that no longer fit a conversation's context budget into
 * its rolling summary. The `chat.compact` job (`queues/handlers/chat-compact.ts`) calls it with the
 * deployment's `CHAT_HISTORY_MAX_CHARS`; anything else that wants a thread compacted — an eval
 * target on a seeded thread, a maintenance script — calls the SAME function, so it measures or
 * runs the path production runs.
 *
 * The window is recomputed from the database with the same pure `selectHistoryWindow` the chat route
 * uses. The write is a compare-and-set on `summarised_through_id`: two overlapping runs produce one
 * summary and one no-op rather than a lost update, and the loser costs tokens, not correctness.
 */
import {
  CHAT_COMPACTION_MIN_CHARS,
  CHAT_SUMMARY_MAX_CHARS,
  type TokenUsage,
} from '@rocketpod/shared/ai/chat'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { conversations, messages } from '../../../db/schema'
import { noopTracer, type Tracer } from '../../observability/tracer'
import { traceChatClient, withAgentTrace } from '../../observability/tracing'
import type { Logger } from '../../utils/core/logger'
import { resolvePrompt } from '../prompts'
import { pendingCompaction, selectHistoryWindow } from './chat-history'
import { AiNotConfiguredError } from './errors'
import { callStructuredTool } from './kit'
import { resolveChat } from './resolve'
import type { AiEnv } from './types'
import { recordUsage } from './usage'

export const COMPACTION_PROMPT_KEY = 'chat-compaction'
const SUBMIT_SUMMARY_TOOL = 'submit_summary'

const submitSummarySchema = z.object({
  summary: z
    .string()
    .trim()
    .min(1)
    .max(CHAT_SUMMARY_MAX_CHARS)
    .describe('The single replacement summary of everything so far'),
})

/** `role: text` — a transcript the model reads, not a conversation it continues. */
function transcript(rows: { role: string; content: string }[]): string {
  return rows.map(row => `${row.role}: ${row.content}`).join('\n\n')
}

export interface CompactDeps {
  config: AppConfig
  platform: AiEnv
  logger: Logger
  tracer?: Tracer
}

export interface CompactInput {
  tenantId: string
  conversationId: string
  /** A person asked (the chat inspector): compact even below `CHAT_COMPACTION_MIN_CHARS`. */
  force: boolean
  /** The history budget the window is cut at — `CHAT_HISTORY_MAX_CHARS` in production. */
  maxChars: number
}

export type CompactOutcome =
  | { status: 'compacted'; summary: string; folded: number }
  | {
      status: 'skipped'
      reason:
        | 'no_conversation'
        | 'nothing_pending'
        | 'below_threshold'
        | 'no_provider'
        | 'lost_race'
    }

export async function compactConversation(
  db: Database,
  deps: CompactDeps,
  input: CompactInput
): Promise<CompactOutcome> {
  const { config, platform, logger } = deps
  const { tenantId, conversationId } = input
  const conversation = await db.query.conversations.findFirst({
    where: and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)),
  })
  // Deleted between enqueue and delivery: nothing to summarise, nothing wrong.
  if (!conversation) return { status: 'skipped', reason: 'no_conversation' }

  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.tenantId, tenantId)))
    .orderBy(asc(messages.createdAt), asc(messages.id))

  const { dropped } = selectHistoryWindow(rows, { maxChars: input.maxChars })
  const pending = pendingCompaction(dropped, conversation.summarisedThroughId)
  const pendingChars = pending.reduce((total, row) => total + row.content.length, 0)
  // Nothing uncovered is always a no-op. Below the threshold is a no-op only for the AUTOMATIC
  // path: the window slides by a message or two per turn, so it runs often, and spending a model
  // call on a sentence is how compaction gets more expensive than the problem it solves. `force`
  // is a person asking from the chat inspector, and they have already decided it is worth one.
  const through = pending[pending.length - 1]
  if (!through) return { status: 'skipped', reason: 'nothing_pending' }
  if (!input.force && pendingChars < CHAT_COMPACTION_MIN_CHARS) {
    return { status: 'skipped', reason: 'below_threshold' }
  }

  let resolved: Awaited<ReturnType<typeof resolveChat>>
  try {
    resolved = await resolveChat(db, config, platform, tenantId, {
      promptKey: COMPACTION_PROMPT_KEY,
    })
  } catch (err) {
    // No provider: the thread still works, it just forgets. Never retry — nothing will change.
    if (err instanceof AiNotConfiguredError) {
      logger.warn({ conversationId }, 'chat.compact: no chat provider, skipping')
      return { status: 'skipped', reason: 'no_provider' }
    }
    throw err
  }

  const system = await resolvePrompt(db, tenantId, COMPACTION_PROMPT_KEY, {
    appName: config.APP_NAME,
    tenantName: '',
    maxChars: String(CHAT_SUMMARY_MAX_CHARS),
  })
  const previous = conversation.summary?.trim()
  const watermark = conversation.summarisedThroughId
  const tracer = deps.tracer ?? noopTracer
  // The usage write starts the moment the call reports it and is awaited before this returns
  // (whatever happened), so a caller reading `ai_usage` afterwards sees it — and a job's DB client
  // is never closed under a write still in flight.
  let usageWrite: Promise<void> | undefined
  const record = (usage: TokenUsage) => {
    usageWrite = recordUsage(db, {
      tenantId,
      userId: conversation.userId,
      feature: 'chat:compaction',
      provider: resolved.provider,
      model: resolved.model,
      usage,
    }).catch(err => logger.warn({ err }, 'chat.compact: usage write failed'))
  }
  try {
    // D32: the compaction call is traced as its own job trace, in the thread's session.
    const result = await withAgentTrace(
      'chat.compact',
      {
        tracer,
        tenantId,
        userId: conversation.userId,
        conversationId,
        kind: 'job',
        spanName: 'job chat.compact',
        tags: ['chat', 'compaction'],
        metadata: { folded: pending.length, model: resolved.model },
      },
      trace =>
        callStructuredTool(
          traceChatClient(resolved.client, trace, { provider: resolved.provider }, tracer),
          {
            model: resolved.model,
            maxTokens: resolved.maxOutputTokens,
            system,
            messages: [
              {
                role: 'user',
                content: [
                  previous ? `Summary so far:\n\n${previous}` : 'There is no summary yet.',
                  `Messages to fold in:\n\n${transcript(pending)}`,
                ].join('\n\n---\n\n'),
              },
            ],
            tool: {
              name: SUBMIT_SUMMARY_TOOL,
              description: 'Submit the single replacement summary. Call exactly once.',
              schema: submitSummarySchema,
            },
            onUsage: record,
          }
        )
    )
    // Compare-and-set on what this run read: a concurrent job that already moved the watermark
    // wins, and this one is a no-op rather than a lost update.
    const updated = await db
      .update(conversations)
      .set({ summary: result.summary, summarisedThroughId: through.id })
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.tenantId, tenantId),
          watermark === null
            ? isNull(conversations.summarisedThroughId)
            : eq(conversations.summarisedThroughId, watermark)
        )
      )
      .returning({ id: conversations.id })
    if (updated.length === 0) {
      logger.info({ conversationId }, 'chat.compact: another run compacted first, discarding')
      return { status: 'skipped', reason: 'lost_race' }
    }
    logger.info(
      { conversationId, folded: pending.length, chars: result.summary.length },
      'chat.compact: summary updated'
    )
    return { status: 'compacted', summary: result.summary, folded: pending.length }
  } finally {
    await usageWrite
  }
}
