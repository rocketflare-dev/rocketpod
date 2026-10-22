/**
 * The Guide reader — the "I want to learn it" path. Three panes: the contents rail grouped by part
 * and section, the page, and "Ask the Guide". The page lives in `?path=` with `#heading` anchors,
 * so every page and section is linkable (citations and `GuideLink` land here); with no path it
 * opens the first page. Every signed-in member reads it; admins also see the admin pages.
 */

import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline'
import { GUIDE_PART_LABELS, type GuideTocEntry, guideHref } from '@rocketpod/shared/guide'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import GuideChat from '@/ui/components/guide/GuideChat'
import { useGuideChat } from '@/ui/components/guide/GuideChatProvider'
import { EmptyState, LoadingIndicator } from '@/ui/components/shared'
import { ApiError } from '@/ui/lib/api-client'
import { guidePageQueryOptions, guideTocQueryOptions } from '@/ui/lib/guide'
import { GuideMarkdown } from './GuideMarkdown'
import { GuideToc } from './GuideToc'
import { ReaderLayout } from './ReaderLayout'

/** The `#heading` a reader URL points at, if any. */
function headingFromHash(hash: string): string | null {
  if (!hash || hash === '#') return null
  try {
    return decodeURIComponent(hash.slice(1))
  } catch {
    return hash.slice(1)
  }
}

export default function GuideReader() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { hash } = useLocation()
  const navigate = useNavigate()
  const selectedPath = searchParams.get('path') ?? ''
  const heading = headingFromHash(hash)
  const contentRef = useRef<HTMLDivElement>(null)
  const askRef = useRef<HTMLTextAreaElement>(null)
  const { registerAskPane } = useGuideChat()

  // The header's `?` focuses THIS pane while the reader is open, instead of opening the slide-over.
  useEffect(() => {
    registerAskPane(() => askRef.current?.focus())
    return () => registerAskPane(null)
  }, [registerAskPane])

  const tocQuery = useQuery(guideTocQueryOptions())
  const entries = useMemo(() => tocQuery.data?.entries ?? [], [tocQuery.data])
  const first = entries[0]

  useEffect(() => {
    if (!selectedPath && first) setSearchParams({ path: first.path }, { replace: true })
  }, [selectedPath, first, setSearchParams])

  const openPage = (path: string) => navigate(guideHref(path))

  if (tocQuery.isLoading) return <LoadingIndicator size="xl" centered />
  if (tocQuery.isError) {
    return (
      <div className="p-8">
        <EmptyState message="Could not load the Guide." />
      </div>
    )
  }

  return (
    <ReaderLayout
      contentRef={contentRef}
      toc={<GuideToc entries={entries} selectedPath={selectedPath} onSelect={openPage} />}
      aside={
        <>
          <div className="flex flex-none items-center gap-1.5 border-b border-base-300 px-4 py-2.5 text-sm font-semibold">
            <ChatBubbleLeftRightIcon className="h-4 w-4 text-accent" />
            Ask the Guide
          </div>
          <div className="min-h-0 flex-1">
            <GuideChat inputRef={askRef} />
          </div>
        </>
      }
    >
      {entries.length === 0 ? (
        <div className="p-8">
          <EmptyState message="The Guide has no pages yet." />
        </div>
      ) : (
        <GuidePageView
          path={selectedPath}
          heading={heading}
          entries={entries}
          scrollRef={contentRef}
          onSelect={openPage}
        />
      )}
    </ReaderLayout>
  )
}

function GuidePageView({
  path,
  heading,
  entries,
  scrollRef,
  onSelect,
}: {
  path: string
  heading: string | null
  entries: GuideTocEntry[]
  scrollRef: React.RefObject<HTMLDivElement>
  onSelect: (path: string) => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const query = useQuery(guidePageQueryOptions(path))
  const idx = entries.findIndex(e => e.path === path)
  const prev = idx > 0 ? entries[idx - 1] : null
  const next = idx >= 0 && idx < entries.length - 1 ? entries[idx + 1] : null

  const data = query.data
  // Once the page is in the DOM, scroll to the cited heading (if any), else to the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: data/heading are the triggers; refs are stable
  useEffect(() => {
    if (!data) return
    const target = heading ? bodyRef.current?.querySelector(`#${CSS.escape(heading)}`) : null
    if (target) {
      target.scrollIntoView?.({ block: 'start' })
      return
    }
    const el = scrollRef.current
    if (el) el.scrollTop = 0
  }, [data, heading])

  if (!path || query.isLoading) return <LoadingIndicator size="xl" centered />
  if (query.isError || !data) {
    const missing = query.error instanceof ApiError && query.error.status === 404
    return (
      <div className="space-y-4 p-8">
        <EmptyState
          message={missing ? 'This page of the Guide does not exist.' : 'Could not load this page.'}
        />
        {missing && entries[0] && (
          <div className="text-center">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onSelect(entries[0]?.path ?? '')}
            >
              Go to the start of the Guide
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    // A dense manual: the page fills the column between the contents rail and the Ask pane (centred,
    // capped only where a line would get too long to read), not a narrow blog column.
    <article className="mx-auto w-full max-w-[1040px] px-6 py-8 md:px-10">
      <label className="mb-4 block md:hidden">
        <span className="sr-only">Guide page</span>
        <select
          className="select select-bordered select-sm w-full"
          value={path}
          onChange={e => onSelect(e.target.value)}
        >
          {entries.map(e => (
            <option key={e.path} value={e.path}>
              {GUIDE_PART_LABELS[e.part]} › {e.title}
            </option>
          ))}
        </select>
      </label>
      <p className="mb-1 text-xs font-semibold text-muted">{GUIDE_PART_LABELS[data.meta.part]}</p>
      <h1 className="mb-6 text-3xl tracking-tight">{data.title}</h1>
      <div ref={bodyRef}>
        <GuideMarkdown markdown={data.markdown} pagePath={data.path} outline={data.outline} />
      </div>
      {(prev || next) && (
        <nav
          aria-label="Previous and next"
          className="mt-10 flex items-stretch gap-3 border-t border-base-300 pt-6"
        >
          {[prev, next].map((target, i) =>
            target ? (
              <button
                key={target.path}
                type="button"
                onClick={() => onSelect(target.path)}
                className={`flex flex-1 flex-col gap-1 rounded-lg border border-base-300 p-4 transition-colors hover:border-accent hover:bg-base-200 ${
                  i === 1 ? 'items-end text-right' : 'items-start text-left'
                }`}
              >
                <span className="text-xs text-muted">{i === 1 ? 'Next →' : '← Previous'}</span>
                <span className="text-sm font-semibold leading-snug">{target.title}</span>
              </button>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: an empty slot keeps the other aligned
              <div key={i} className="flex-1" />
            )
          )}
        </nav>
      )}
    </article>
  )
}
