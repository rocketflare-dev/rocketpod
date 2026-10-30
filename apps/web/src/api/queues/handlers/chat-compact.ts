/**
 * `chat.compact` — fold the messages that no longer fit a conversation's context budget into
 * its rolling summary, so a long thread forgets gracefully instead of either overflowing the model
 * or silently losing its beginning.
 *
 * It is a JOB, not part of the turn, for one reason: a chat reply is the latency a person feels,
 * and compaction is a whole extra model call. The cost of that choice is honest and bounded — the
 * turn that FIRST crosses the budget answers without a summary, and says so with
 * `CUSTOM kit.notice { history_truncated }`. Every turn after it has one.
 *
 * The message carries ids only, so the handler recomputes the window from the database with the
 * same pure `selectHistoryWindow` the route used. That matters: by the time this runs, the turn
 * that enqueued it has usually persisted its answer, and summarising the window as it is NOW is
 * more correct than summarising the window as it was.
 *
 * Concurrency is a compare-and-set, not a lock: the write only lands while
 * `summarised_through_id` is still what this run read. Two overlapping jobs therefore produce one
 * summary and one no-op rather than a lost update, and the loser costs tokens, not correctness.
 *
 * The work is `compactConversation` (`services/ai/chat-compaction.ts`), so anything else that
 * compacts a thread — an eval target, a script — runs exactly this path.
 */
import type { JobOf } from '@rocketpod/shared/jobs'
import { compactConversation } from '../../services/ai/chat-compaction'
import type { JobContext } from '../jobs'

export async function handleChatCompact(
  job: JobOf<'chat.compact'>,
  ctx: JobContext
): Promise<void> {
  await compactConversation(
    ctx.db,
    { config: ctx.config, platform: ctx.platform, logger: ctx.logger, tracer: ctx.tracer },
    {
      tenantId: job.payload.tenantId,
      conversationId: job.payload.conversationId,
      force: Boolean(job.payload.force),
      maxChars: ctx.config.CHAT_HISTORY_MAX_CHARS,
    }
  )
}
