/**
 * The header's "I'm stuck" path: a `?` button (and the `?` key) that opens "Ask the Guide" in a
 * right-hand slide-over, floating over the page without re-laying it out. On `/guide` itself it
 * focuses the reader's Ask pane instead. Every signed-in member may use it.
 *
 * The chat body (markdown) is `lazy()`: this control lives in the eager shell.
 */

import { BookOpenIcon, QuestionMarkCircleIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { GUIDE_PATH } from '@rocketpod/shared/guide'
import { lazy, Suspense, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { LoadingIndicator } from '../LoadingIndicator'
import { useGuideChat } from './GuideChatProvider'

const GuideChat = lazy(() => import('./GuideChat'))

/** Is the keystroke going into something the user is typing in? Then `?` is a character. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (
    target.isContentEditable ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  )
}

export function GuideHelp() {
  const { panelOpen, closePanel, summon } = useGuideChat()
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  // Opening puts the caret in the composer; closing hands focus back to where it was summoned.
  useEffect(() => {
    if (panelOpen) {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      const id = window.setTimeout(() => composerRef.current?.focus(), 50)
      return () => window.clearTimeout(id)
    }
    const back = returnFocusRef.current
    returnFocusRef.current = null
    if (back?.isConnected) back.focus()
  }, [panelOpen])

  // `?` opens it from anywhere — except while typing, and never with a modifier held. Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && panelOpen) {
        closePanel()
        return
      }
      if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      if (isTypingTarget(e.target)) return
      e.preventDefault()
      summon()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [summon, closePanel, panelOpen])

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm btn-square"
        onClick={summon}
        aria-label="Ask the Guide"
        title="Ask the Guide (?)"
      >
        <QuestionMarkCircleIcon className="h-5 w-5" />
      </button>
      {panelOpen && (
        <aside
          aria-label="Ask the Guide"
          className="fixed inset-y-0 right-0 z-50 flex w-[420px] max-w-full flex-col border-l border-base-300 bg-base-100 shadow-xl"
        >
          <div className="flex flex-none items-center justify-between border-b border-base-300 px-4 py-2.5">
            <h2 className="text-sm">Ask the Guide</h2>
            <button
              type="button"
              className="btn btn-ghost btn-xs btn-square"
              onClick={closePanel}
              aria-label="Close"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <Suspense fallback={<LoadingIndicator centered />}>
              <GuideChat onNavigate={closePanel} inputRef={composerRef} />
            </Suspense>
          </div>
          <div className="flex-none border-t border-base-300 px-4 py-2.5">
            <Link
              to={GUIDE_PATH}
              onClick={closePanel}
              className="link link-accent inline-flex items-center gap-1.5 text-sm"
            >
              <BookOpenIcon className="h-4 w-4" />
              Open the full Guide
            </Link>
          </div>
        </aside>
      )}
    </>
  )
}
