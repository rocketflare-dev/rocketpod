/**
 * The reader's workspace: the contents rail, the page, a drag handle and the right-hand Ask pane.
 * Full-bleed under the header; the Ask pane's width persists in `localStorage`.
 */
import { type ReactNode, type RefObject, useCallback, useEffect, useState } from 'react'

const RIGHT_MIN = 320
const RIGHT_MAX = 900
const RIGHT_DEFAULT = 384
const STORAGE_KEY = 'guide-ask-width'
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** A vertical drag handle; reports the horizontal delta while dragging (arrows nudge it too). */
function Resizer({ onDelta }: { onDelta: (dx: number) => void }) {
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      let lastX = e.clientX
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - lastX
        lastX = ev.clientX
        if (dx) onDelta(dx)
      }
      const up = () => {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [onDelta]
  )
  return (
    <div
      onMouseDown={onMouseDown}
      onKeyDown={e => {
        if (e.key === 'ArrowLeft') onDelta(-24)
        else if (e.key === 'ArrowRight') onDelta(24)
      }}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the Ask pane"
      aria-valuenow={0}
      tabIndex={0}
      className="relative z-10 hidden w-1 shrink-0 cursor-col-resize bg-base-300 transition-colors hover:bg-accent focus:bg-accent focus:outline-none lg:block"
    >
      <span className="absolute inset-y-0 -left-1.5 -right-1.5" />
    </div>
  )
}

export function ReaderLayout({
  toc,
  aside,
  children,
  contentRef,
}: {
  toc: ReactNode
  aside: ReactNode
  children: ReactNode
  contentRef: RefObject<HTMLDivElement>
}) {
  const [rightW, setRightW] = useState(() => {
    const v = Number(localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(v) && v > 0 ? clamp(v, RIGHT_MIN, RIGHT_MAX) : RIGHT_DEFAULT
  })
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(rightW))
  }, [rightW])
  const onDelta = useCallback(
    (dx: number) => setRightW(w => clamp(w - dx, RIGHT_MIN, RIGHT_MAX)),
    []
  )

  return (
    // Cancel Layout's main padding (p-4 / md:p-8) so the reader is full-bleed.
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] overflow-hidden bg-base-200 md:-m-8">
      {toc}
      <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto bg-base-100">
        {children}
      </div>
      <Resizer onDelta={onDelta} />
      <aside
        style={{ width: rightW }}
        aria-label="Ask the Guide"
        className="hidden flex-none flex-col border-l border-base-300 bg-base-100 lg:flex"
      >
        {aside}
      </aside>
    </div>
  )
}
