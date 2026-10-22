/**
 * "Ask the Guide" — the one Guide chat, hosted twice: in the reader's right-hand pane and in the
 * header's slide-over. Both show the SAME conversation (`GuideChatProvider`). A citation opens the
 * cited page at its heading in the reader; `onNavigate` lets the slide-over close itself.
 *
 * Renders model output through `Markdown` (react-markdown, `skipHtml`), so it is reached ONLY
 * lazily: from the reader page and from the slide-over's `lazy()` import.
 */

import {
  BookOpenIcon,
  PaperAirplaneIcon,
  SparklesIcon,
  StopIcon,
} from '@heroicons/react/24/outline'
import { GUIDE_PATH, type GuideCitation, guideHref } from '@rocketpod/shared/guide'
import { type RefObject, useEffect, useRef, useState } from 'react'
import type { Components } from 'react-markdown'
import { Link, useNavigate } from 'react-router-dom'
import { Markdown } from '@/ui/components/ai/Markdown'
import { useAppInfo } from '@/ui/hooks/useAppInfo'
import { useGuideChat } from './GuideChatProvider'
import { stripCitationsBlock } from './useGuideConversation'

/** A link to a Guide page stays in the app (the slide-over closes via the route change). */
const ANSWER_COMPONENTS: Components = {
  a: ({ node: _node, href, children, ...props }) =>
    href?.startsWith(`${GUIDE_PATH}?`) ? (
      <Link to={href} className="link link-accent">
        {children}
      </Link>
    ) : (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
}

/** A citation's chip: the page, and what it supports when the model said. */
export function citationLabel(c: GuideCitation): string {
  return c.note && c.note !== c.title ? `${c.title} — ${c.note}` : c.title
}

/** What a person tends to ask first — one click sends it. */
export const GUIDE_STARTER_QUESTIONS = [
  'How do I sign in?',
  'How do I invite someone to my organisation?',
  'How do I use the command-line tool?',
] as const

export default function GuideChat({
  onNavigate,
  inputRef,
}: {
  onNavigate?: () => void
  inputRef?: RefObject<HTMLTextAreaElement>
}) {
  const { chat } = useGuideChat()
  const { messages, steps, streaming, send, stop, reset } = chat
  const navigate = useNavigate()
  const { name } = useAppInfo()
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages/steps are the triggers
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, steps])

  const openCitation = (c: GuideCitation) => {
    if (!c.valid || !c.page) return
    navigate(guideHref(c.page, c.heading))
    onNavigate?.()
  }

  const submit = () => {
    const question = input.trim()
    if (!question || streaming) return
    setInput('')
    void send(question)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-busy={streaming}
        aria-label="Conversation with the Guide"
        className="flex-1 min-h-0 space-y-4 overflow-y-auto p-4"
      >
        {messages.length === 0 && (
          <div className="mt-6 space-y-4 text-sm">
            <div className="space-y-2 text-center text-muted">
              <SparklesIcon className="mx-auto h-8 w-8 text-accent" />
              <p>Ask how anything in {name} works.</p>
              <p className="text-xs">Answers come from the Guide, with links to the page.</p>
            </div>
            <ul className="space-y-1.5" aria-label="Suggested questions">
              {GUIDE_STARTER_QUESTIONS.map(q => (
                <li key={q}>
                  <button
                    type="button"
                    onClick={() => void send(q)}
                    className="w-full rounded-lg border border-base-300 px-3 py-2 text-left text-[13px] transition-colors hover:border-accent hover:bg-base-200"
                  >
                    {q}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1
          const display = m.role === 'assistant' ? stripCitationsBlock(m.content) : m.content
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only chat log
              key={i}
              className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
            >
              <div
                className={`max-w-[90%] rounded-lg px-3 py-2 text-sm ${
                  m.role === 'user'
                    ? 'bg-primary text-primary-content whitespace-pre-wrap'
                    : m.error
                      ? 'bg-base-200 text-error'
                      : 'bg-base-200 text-base-content'
                }`}
                data-error={m.error ? 'true' : undefined}
              >
                {m.role === 'assistant' ? (
                  display ? (
                    m.error ? (
                      <p>{display}</p>
                    ) : (
                      <Markdown content={display} components={ANSWER_COMPONENTS} />
                    )
                  ) : (
                    isLast &&
                    streaming && (
                      <ul className="space-y-1 text-xs text-muted" aria-label="Searching">
                        {(steps.length ? steps : ['Thinking…']).map((s, si) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: append-only steps
                          <li key={si} className="flex items-center gap-1.5">
                            <span className="loading loading-dots loading-xs" />
                            {s}
                          </li>
                        ))}
                      </ul>
                    )
                  )
                ) : (
                  display
                )}
                {m.citations && m.citations.length > 0 && (
                  <div className="mt-2 space-y-1 border-t border-base-content/10 pt-2">
                    {m.citations.map((c, ci) => (
                      <button
                        // biome-ignore lint/suspicious/noArrayIndexKey: static citation list
                        key={ci}
                        type="button"
                        disabled={!c.valid || !c.page}
                        onClick={() => openCitation(c)}
                        className="flex w-full items-center gap-1.5 text-left text-xs hover:text-accent disabled:cursor-default disabled:opacity-70"
                      >
                        <BookOpenIcon className="h-3.5 w-3.5 flex-none" />
                        <span className="truncate">{citationLabel(c)}</span>
                      </button>
                    ))}
                  </div>
                )}
                {m.lexicalOnly && (
                  <p className="mt-1.5 text-[11px] text-muted">
                    Found by keyword search — the Guide's semantic index is not built on this
                    server.
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="border-t border-base-300 p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={2}
            placeholder="Ask the Guide…"
            aria-label="Ask the Guide"
            className="textarea textarea-bordered textarea-sm flex-1 resize-none"
          />
          {streaming ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-square"
              onClick={stop}
              aria-label="Stop"
              title="Stop answering"
            >
              <StopIcon className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm btn-square"
              onClick={submit}
              disabled={!input.trim()}
              aria-label="Send"
            >
              <PaperAirplaneIcon className="h-4 w-4" />
            </button>
          )}
        </div>
        {messages.length > 0 && !streaming && (
          <button type="button" className="link link-accent mt-1.5 text-xs" onClick={reset}>
            New conversation
          </button>
        )}
      </div>
    </div>
  )
}
