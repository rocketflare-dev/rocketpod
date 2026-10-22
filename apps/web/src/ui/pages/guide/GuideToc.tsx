/**
 * The Guide's contents rail, grouped by part and then by section, in reading order. `entries`
 * arrive ordered by the server (`compareGuideEntries`) — the same order prev/next follows.
 */
import {
  GUIDE_PART_LABELS,
  GUIDE_PARTS,
  GUIDE_SECTIONS,
  type GuideTocEntry,
} from '@rocketpod/shared/guide'
import { useAppInfo } from '@/ui/hooks/useAppInfo'

export function GuideToc({
  entries,
  selectedPath,
  onSelect,
}: {
  entries: GuideTocEntry[]
  selectedPath: string
  onSelect: (path: string) => void
}) {
  const { name } = useAppInfo()
  const groups = GUIDE_PARTS.map(part => ({
    part,
    sections: GUIDE_SECTIONS[part]
      .map(sec => ({
        ...sec,
        entries: entries.filter(e => e.part === part && e.section === sec.id),
      }))
      .filter(sec => sec.entries.length > 0),
  })).filter(g => g.sections.length > 0)

  return (
    <nav
      aria-label="Guide contents"
      className="hidden w-72 flex-none overflow-y-auto border-r border-base-300 bg-base-100 md:block"
    >
      <div className="sticky top-0 z-10 border-b border-base-300 bg-base-100 px-4 py-3">
        <h2 className="text-sm">The Guide</h2>
        <p className="text-xs text-muted">How {name} works, and how to use it</p>
      </div>
      <div className="px-2.5 py-3">
        {groups.map((g, gi) => (
          <section
            key={g.part}
            aria-labelledby={`guide-part-${g.part}`}
            className={gi > 0 ? 'mt-4 border-t border-base-300 pt-4' : undefined}
          >
            <h3
              id={`guide-part-${g.part}`}
              className="px-1.5 pb-2 text-xs text-muted"
              data-testid="guide-part"
            >
              {GUIDE_PART_LABELS[g.part]}
            </h3>
            <div className="space-y-3">
              {g.sections.map(sec => (
                <div key={sec.id}>
                  <h4 className="px-1.5 pb-1 text-xs" data-testid="guide-section">
                    {sec.label}
                  </h4>
                  <ul className="ml-1.5 flex flex-col border-l border-base-300 pl-1.5">
                    {sec.entries.map(e => {
                      const active = e.path === selectedPath
                      return (
                        <li key={e.path}>
                          <button
                            type="button"
                            onClick={() => onSelect(e.path)}
                            aria-current={active ? 'page' : undefined}
                            title={e.summary}
                            className={`w-full rounded-md px-2 py-1 text-left text-[13px] leading-snug transition-colors ${
                              active ? 'bg-base-200 font-semibold text-accent' : 'hover:bg-base-200'
                            }`}
                          >
                            {e.title}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </nav>
  )
}
