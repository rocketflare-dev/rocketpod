/**
 * One "Ask the Guide" answer over AG-UI (`POST /api/guide/ask`). Loaded LAZILY by the chat's
 * streamer (`import('./guideAsk')`), because it imports the AG-UI schemas, which must stay out of
 * the eager shell — the Guide chat's provider lives in the Layout.
 *
 * Frames: `RUN_STARTED`, `TEXT_MESSAGE_*` (the answer as it is written, citations block included),
 * `TOOL_CALL_*` (each search), `CUSTOM kit.guide.answer` (the answer with its citations
 * resolved), then `RUN_FINISHED` — or `RUN_ERROR`. A cancelled answer simply ends.
 */
import { AguiEventType, KIT_CUSTOM_EVENTS, kitAguiEventSchema } from '@rocketpod/shared/ai/agui'
import { type AskGuideRequest, type GuideAnswer, guideAnswerSchema } from '@rocketpod/shared/guide'
import { ApiError, notifyUnauthorized, parseErrorBody } from './api-client'
import { isAbortError, readSse } from './sse'

export interface GuideAskHandlers {
  onDelta: (text: string) => void
  /** A search started (the tool's name and its query). */
  onProgress: (tool: string, query: string | null) => void
  onDone: (answer: GuideAnswer) => void
  onError: (message: string, code: string) => void
}

export async function streamGuideAsk(
  body: AskGuideRequest,
  handlers: GuideAskHandlers,
  signal: AbortSignal
): Promise<void> {
  let response: Response
  try {
    response = await fetch('/api/guide/ask', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Requested-With': 'fetch',
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (isAbortError(error) || signal.aborted) return
    throw error
  }
  if (!response.ok) {
    const err = new ApiError(await parseErrorBody(response))
    if (err.status === 401) notifyUnauthorized(err)
    handlers.onError(err.message, err.code ?? 'error')
    return
  }
  const names = new Map<string, string>()
  await readSse(
    response,
    json => {
      const parsed = kitAguiEventSchema.safeParse(json)
      return parsed.success
        ? ({ ok: true, event: parsed.data } as const)
        : ({ ok: false, reason: 'unknown frame' } as const)
    },
    event => {
      switch (event.type) {
        case AguiEventType.TEXT_MESSAGE_CONTENT:
          handlers.onDelta(event.delta)
          break
        case AguiEventType.TOOL_CALL_START:
          names.set(event.toolCallId, event.toolCallName)
          break
        case AguiEventType.TOOL_CALL_ARGS: {
          let query: string | null = null
          try {
            const args = JSON.parse(event.delta) as { query?: unknown }
            query = typeof args.query === 'string' ? args.query : null
          } catch {
            // A tool input we cannot read is still a step.
          }
          handlers.onProgress(names.get(event.toolCallId) ?? 'search_guide', query)
          break
        }
        case AguiEventType.CUSTOM:
          if (event.name === KIT_CUSTOM_EVENTS.guideAnswer) {
            const parsed = guideAnswerSchema.safeParse(event.value)
            if (parsed.success) handlers.onDone(parsed.data)
          }
          break
        case AguiEventType.RUN_ERROR:
          handlers.onError(event.message, event.code ?? 'error')
          break
        default:
          break
      }
    },
    { signal }
  )
}
