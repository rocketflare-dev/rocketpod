/**
 * The Guide chat's conversation state — the transcript, the in-flight list of searches, the
 * streaming flag — driven by a streamer. Held ONCE in `GuideChatProvider`, so the header's
 * slide-over and the reader's pane show the same conversation and it outlives either.
 *
 * Each send owns an `AbortController`: `stop()`, `reset()` and unmounting the host abort the
 * request, so a closed panel never leaves a model generating for nobody. Nothing is persisted —
 * the transcript is this tab's; the server is stateless.
 */
import type { GuideChatTurn, GuideCitation } from '@rocketpod/shared/guide'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GuideAskHandlers } from '@/ui/lib/guideAsk'

export interface GuideChatMessage {
  role: 'user' | 'assistant'
  content: string
  citations?: GuideCitation[]
  /** Found by keywords only (no vectors) — said under the answer, never hidden. */
  lexicalOnly?: boolean
  /**
   * The answer failed or was stopped: `content` is the error (or the partial text). Shown, but
   * never sent back as history — and neither is the question it failed to answer.
   */
  error?: boolean
}

export type GuideStreamer = (
  question: string,
  history: GuideChatTurn[],
  handlers: GuideAskHandlers,
  signal: AbortSignal
) => Promise<void>

export interface GuideConversation {
  messages: GuideChatMessage[]
  /** The searches the model has run for the in-flight question. */
  steps: string[]
  streaming: boolean
  send: (question: string) => Promise<void>
  stop: () => void
  reset: () => void
}

export const STOPPED_MESSAGE = 'Stopped.'

/**
 * The turns sent back with the next question: every completed exchange, nothing from one whose
 * answer failed — a model that re-reads its own error text as something it said builds on it.
 */
export function guideHistory(messages: GuideChatMessage[]): GuideChatTurn[] {
  const turns: GuideChatTurn[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as GuideChatMessage
    const answer = m.role === 'user' ? messages[i + 1] : undefined
    if (m.role === 'user' && answer?.role === 'assistant' && answer.error) {
      i++
      continue
    }
    if (m.error || !m.content.trim()) continue
    turns.push({ role: m.role, content: m.content })
  }
  return turns
}

/** The streamed text without the trailing `CITATIONS:` block (shown as links once resolved). */
export function stripCitationsBlock(text: string): string {
  return (text.split(/\n?CITATIONS:/i)[0] ?? '').trimEnd()
}

export function useGuideConversation(stream: GuideStreamer): GuideConversation {
  const [messages, setMessages] = useState<GuideChatMessage[]>([])
  const [steps, setSteps] = useState<string[]>([])
  const [streaming, setStreaming] = useState(false)
  const streamRef = useRef(stream)
  streamRef.current = stream
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const send = useCallback(async (raw: string) => {
    const question = raw.trim()
    if (!question || abortRef.current) return
    const controller = new AbortController()
    abortRef.current = controller
    setStreaming(true)
    setSteps([])
    const history = guideHistory(messagesRef.current)
    setMessages(prev => [
      ...prev,
      { role: 'user', content: question },
      { role: 'assistant', content: '' },
    ])
    const setAssistant = (update: (m: GuideChatMessage) => GuideChatMessage) => {
      if (controller.signal.aborted && abortRef.current !== controller) return
      setMessages(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.role === 'assistant') next[next.length - 1] = update(last)
        return next
      })
    }
    try {
      await streamRef.current(
        question,
        history,
        {
          onDelta: text => setAssistant(m => ({ ...m, content: m.content + text })),
          onProgress: (_tool, query) =>
            setSteps(prev => [
              ...prev,
              query ? `Searching the Guide for “${query}”` : 'Searching the Guide',
            ]),
          onDone: answer => {
            setAssistant(m => ({
              ...m,
              content: answer.answer || stripCitationsBlock(m.content),
              citations: answer.citations,
              lexicalOnly: answer.retrieval === 'lexical',
            }))
            setSteps([])
          },
          onError: message => {
            setAssistant(m => ({ ...m, content: message, error: true }))
            setSteps([])
          },
        },
        controller.signal
      )
      if (controller.signal.aborted) {
        setAssistant(m =>
          m.citations ? m : { ...m, content: m.content || STOPPED_MESSAGE, error: true }
        )
      }
    } catch (err) {
      setAssistant(m => ({
        ...m,
        content: err instanceof Error ? err.message : 'The Guide could not answer.',
        error: true,
      }))
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        setStreaming(false)
        setSteps([])
      }
    }
  }, [])

  const stop = useCallback(() => abortRef.current?.abort(), [])
  const reset = useCallback(() => {
    const inFlight = abortRef.current
    abortRef.current = null
    inFlight?.abort()
    setStreaming(false)
    setMessages([])
    setSteps([])
  }, [])

  return useMemo(
    () => ({ messages, steps, streaming, send, stop, reset }),
    [messages, steps, streaming, send, stop, reset]
  )
}
