/**
 * The Guide chat's citations. The model ends an answer with a plain-text block, one line per
 * source, `|`-separated `field=value` pairs, `-` for "none":
 *
 *     CITATIONS:
 *     page=admin/members-and-invitations.md | heading=invite-someone | note=the invite form
 *
 * Here it is split off, parsed, resolved against the asker's OWN TOC (already audience-filtered,
 * so a page they may not read comes back `valid: false`) and de-duplicated. Pure.
 */
import type { GuideCitation, GuideTocEntry } from '@rocketpod/shared/guide'

export interface RawGuideCitation {
  page: string | null
  heading: string | null
  note: string | null
}

const CITATIONS_HEADER = /\n?CITATIONS:\s*\n/i
const FIELD = /^\s*(page|heading|note)\s*=\s*(.*?)\s*$/

/** Split the trailing `CITATIONS:` block off an answer. Lines without a `page` are dropped. */
export function splitGuideCitations(text: string): {
  answer: string
  citations: RawGuideCitation[]
} {
  const idx = text.search(CITATIONS_HEADER)
  if (idx === -1) return { answer: text.trim(), citations: [] }
  const answer = text.slice(0, idx).trim()
  const block = text.slice(idx).replace(CITATIONS_HEADER, '')
  const dash = (v: string | undefined) => (!v || v === '-' ? null : v)
  const citations: RawGuideCitation[] = []
  for (const line of block.split('\n')) {
    if (!line.trim()) continue
    const fields: Partial<Record<keyof RawGuideCitation, string>> = {}
    for (const part of line.split('|')) {
      const m = FIELD.exec(part)
      if (m) fields[m[1] as keyof RawGuideCitation] = m[2]
    }
    if (!dash(fields.page)) continue
    citations.push({
      page: dash(fields.page),
      heading: dash(fields.heading),
      note: dash(fields.note),
    })
  }
  return { answer, citations }
}

/** Resolve a raw citation against the reader's own TOC. */
export function resolveGuideCitation(
  c: RawGuideCitation,
  byPath: ReadonlyMap<string, GuideTocEntry>
): GuideCitation {
  const entry = c.page ? (byPath.get(c.page) ?? null) : null
  return {
    page: c.page,
    heading: entry ? c.heading : null,
    note: c.note,
    title: entry?.title ?? c.note ?? c.page ?? 'Source',
    valid: Boolean(entry),
  }
}

/**
 * One entry per page + heading (a Guide citation opens a heading, so two headings on one page are
 * two links). The first occurrence wins unless a later duplicate resolves where it did not.
 */
export function dedupeGuideCitations(citations: GuideCitation[]): GuideCitation[] {
  const byKey = new Map<string, GuideCitation>()
  for (const c of citations) {
    const key = `${c.page ?? ''}#${c.heading ?? ''}`
    const existing = byKey.get(key)
    if (!existing || (!existing.valid && c.valid)) byKey.set(key, c)
  }
  return [...byKey.values()]
}
