import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'

export interface TabConfig {
  id: string
  label: string
  content: ReactNode
  icon?: ReactNode
  badge?: string | number
  /** Vertical rail only: the heading this tab sits under (consecutive tabs share one heading). */
  group?: string
}

interface URLTabsProps {
  tabs: TabConfig[]
  defaultTab?: string
  /** Query parameter name (default `tab`) */
  param?: string
  className?: string
  /** Rendered at the end of the tab bar */
  actions?: ReactNode
  /**
   * `vertical` puts the tabs in a left rail (from `lg`; a scrolling row above the panel below it),
   * for a page with many sections that should use the full width — Settings.
   */
  orientation?: 'horizontal' | 'vertical'
}

/** Tabs whose active state lives in `?tab=`, so deep links and back/forward work. */
export function URLTabs({
  tabs,
  defaultTab,
  param = 'tab',
  className = '',
  actions,
  orientation = 'horizontal',
}: URLTabsProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const activeId = searchParams.get(param) ?? defaultTab ?? tabs[0]?.id
  const active = tabs.find(t => t.id === activeId) ?? tabs[0]

  const selectTab = (id: string) => {
    const next = new URLSearchParams(searchParams)
    next.set(param, id)
    setSearchParams(next, { replace: true })
  }

  if (orientation === 'vertical') {
    return (
      <div className={`lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8 ${className}`}>
        <nav aria-label="Sections" className="mb-6 lg:mb-0">
          <div
            role="tablist"
            aria-orientation="vertical"
            className="flex gap-1 overflow-x-auto border-b border-[color:var(--border-default)] pb-2 lg:sticky lg:top-4 lg:flex-col lg:overflow-visible lg:border-b-0 lg:pb-0"
          >
            {tabs.map((tab, i) => {
              const selected = tab.id === active?.id
              const heading = tab.group && tab.group !== tabs[i - 1]?.group ? tab.group : null
              return (
                <div key={tab.id} className="contents">
                  {heading && (
                    <div
                      className={`hidden px-3 pb-1 text-xs font-semibold text-muted lg:block ${i === 0 ? '' : 'pt-5'}`}
                    >
                      {heading}
                    </div>
                  )}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    data-active={selected}
                    className="nav-item flex shrink-0 items-center gap-2 whitespace-nowrap px-3 py-1.5 lg:w-full"
                    onClick={() => selectTab(tab.id)}
                  >
                    {tab.icon}
                    <span className="flex-1 text-left">{tab.label}</span>
                    {tab.badge !== undefined && <span className="badge badge-sm">{tab.badge}</span>}
                  </button>
                </div>
              )
            })}
          </div>
          {actions && <div className="mt-4">{actions}</div>}
        </nav>
        <div role="tabpanel" className="min-w-0">
          {active?.content}
        </div>
      </div>
    )
  }

  return (
    <div className={className}>
      <div className="flex items-center border-b border-[color:var(--border-default)] mb-6">
        <div role="tablist" className="tabs tabs-border flex-1">
          {tabs.map(tab => {
            const selected = tab.id === active?.id
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`tab gap-2 ${selected ? 'tab-active font-semibold' : ''}`}
                onClick={() => selectTab(tab.id)}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {tab.badge !== undefined && <span className="badge badge-sm">{tab.badge}</span>}
              </button>
            )
          })}
        </div>
        {actions && <div className="shrink-0 pb-1">{actions}</div>}
      </div>
      <div role="tabpanel">{active?.content}</div>
    </div>
  )
}
