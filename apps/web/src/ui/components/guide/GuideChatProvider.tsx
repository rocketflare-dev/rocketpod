/**
 * Holds the ONE Guide conversation and the slide-over's open state at Layout level, so both
 * survive navigation and closing/reopening the panel. Every question carries a `screen` hint from
 * the current route (`screenForRoute` — fixed vocabulary, never a project name).
 *
 * The AG-UI client is imported on the first question (`import('@/ui/lib/guideAsk')`), never
 * eagerly: this provider sits in the shell, and the AG-UI schemas must not.
 */
import { GUIDE_MAX_HISTORY, GUIDE_MAX_QUESTION, GUIDE_PATH } from '@rocketpod/shared/guide'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useLocation } from 'react-router-dom'
import { screenForRoute } from '@/ui/lib/guideScreens'
import { type GuideConversation, useGuideConversation } from './useGuideConversation'

/** A turn is at most this long on the wire (`guideChatTurnSchema`). */
const MAX_TURN = 8000

interface GuideChatContextValue {
  chat: GuideConversation
  panelOpen: boolean
  openPanel: () => void
  closePanel: () => void
  /**
   * The header button and the `?` key. On `/guide` it focuses the reader's own Ask pane (the reader
   * registers it) rather than opening a second view of the same chat; anywhere else it opens the
   * slide-over.
   */
  summon: () => void
  registerAskPane: (focus: (() => void) | null) => void
}

const GuideChatContext = createContext<GuideChatContextValue | null>(null)

export function GuideChatProvider({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation()
  const [panelOpen, setPanelOpen] = useState(false)
  const askFocus = useRef<(() => void) | null>(null)

  const chat = useGuideConversation(async (question, history, handlers, signal) => {
    const { streamGuideAsk } = await import('@/ui/lib/guideAsk')
    const screen = screenForRoute(pathname, search)
    return streamGuideAsk(
      {
        question: question.slice(0, GUIDE_MAX_QUESTION),
        history: history
          .slice(-GUIDE_MAX_HISTORY)
          .map(t => ({ role: t.role, content: t.content.slice(0, MAX_TURN) })),
        ...(screen ? { screen } : {}),
      },
      handlers,
      signal
    )
  })

  const openPanel = useCallback(() => setPanelOpen(true), [])
  const closePanel = useCallback(() => setPanelOpen(false), [])
  const registerAskPane = useCallback((focus: (() => void) | null) => {
    askFocus.current = focus
  }, [])
  const summon = useCallback(() => {
    if (pathname === GUIDE_PATH && askFocus.current) {
      setPanelOpen(false)
      askFocus.current()
    } else {
      setPanelOpen(true)
    }
  }, [pathname])

  const value = useMemo(
    () => ({ chat, panelOpen, openPanel, closePanel, summon, registerAskPane }),
    [chat, panelOpen, openPanel, closePanel, summon, registerAskPane]
  )
  return <GuideChatContext.Provider value={value}>{children}</GuideChatContext.Provider>
}

export function useGuideChat(): GuideChatContextValue {
  const ctx = useContext(GuideChatContext)
  if (!ctx) throw new Error('useGuideChat must be used within a GuideChatProvider')
  return ctx
}
