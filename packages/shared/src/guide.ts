import { z } from 'zod'

/**
 * Contracts for the Guide: the in-app user guide — a reader over `apps/web/content/guide/` and
 * "Ask the Guide", a chat that answers only from it (`docs/CONCEPTS.md` § The Guide).
 *
 * The Guide is GLOBAL static content: identical for every tenant, shipped in the image, indexed
 * into its own table (`guide_chunks`). Every signed-in member of a tenant may read it; the audience
 * a caller reads as is derived server-side from their role — never sent by the client. No other
 * model surface can reach it: only the guide route registers `search_guide`.
 *
 * Browser-safe and dependency-free beyond zod: the reader, the CLI and the server share it.
 *
 * An app REWRITES the parts and sections below to fit its own pages — they are the Guide's table of
 * contents, not an engine rule. A page's frontmatter must name a part listed here and a section of
 * that part, and sit under `content/guide/<part>/`.
 */

/** The parts of the Guide, in reading order. */
export const GUIDE_PARTS = ['start', 'workspace', 'admin', 'reference'] as const
export const guidePartSchema = z.enum(GUIDE_PARTS)
export type GuidePart = z.infer<typeof guidePartSchema>

export const GUIDE_PART_LABELS: Record<GuidePart, string> = {
  start: 'Getting started',
  workspace: 'The workspace',
  admin: 'Administration',
  reference: 'Reference',
}

/**
 * Who a page is written for. A `member` page is for everyone in a tenant; an `admin` page
 * (settings, members and access, AI providers and models) is for tenant admins, who read both.
 */
export const GUIDE_AUDIENCES = ['member', 'admin'] as const
export const guideAudienceSchema = z.enum(GUIDE_AUDIENCES)
export type GuideAudience = z.infer<typeof guideAudienceSchema>

/**
 * The audiences a reader of the given audience may see.
 *
 * @serverOnly The audience rule is applied once, server-side, in the Guide's TOC and retrieval
 * functions; the UI only ever receives what that rule let through.
 */
export function visibleAudiences(reader: GuideAudience): GuideAudience[] {
  return reader === 'admin' ? ['member', 'admin'] : ['member']
}

/**
 * The sections of each part, in reading order, with the label the contents rail shows. A page's
 * frontmatter `section` must be one of its part's ids (the loader refuses anything else), and the
 * TOC sorts by this order — never alphabetically by id. A part with no pages is not shown.
 */
export const GUIDE_SECTIONS: Record<GuidePart, readonly { id: string; label: string }[]> = {
  start: [{ id: 'start-here', label: 'Start here' }],
  workspace: [{ id: 'everyday', label: 'Everyday use' }],
  admin: [
    { id: 'organisation', label: 'Your organisation' },
    { id: 'ai', label: 'AI providers and models' },
  ],
  reference: [{ id: 'reference', label: 'Reference' }],
}

/**
 * A section's position within its part; unknown sections sort last.
 *
 * @serverOnly The server sorts the TOC with it; the rail renders the order it is sent.
 */
export function guideSectionIndex(part: GuidePart, section: string): number {
  const i = GUIDE_SECTIONS[part].findIndex(s => s.id === section)
  return i === -1 ? 99 : i
}

/** Frontmatter every Guide page must carry. Validated at load; a bad page fails the test. */
export const guidePageFrontmatterSchema = z.object({
  title: z.string().min(1),
  part: guidePartSchema,
  section: z.string().min(1),
  order: z.number().int(),
  audience: guideAudienceSchema,
  summary: z.string().min(1),
  /** Coarse globs (repo-relative) of the code this page describes — read by `docs:stale`. */
  sources: z.array(z.string().min(1)).min(1),
  /** Commit at which this page was last checked against its sources. */
  verified: z.string().min(7),
})
export type GuidePageFrontmatter = z.infer<typeof guidePageFrontmatterSchema>

/** One entry in the Guide's TOC, derived from frontmatter (there is no hand-kept index). */
export const guideTocEntrySchema = z.object({
  /** Path relative to `content/guide/`, e.g. `start/signing-in.md`. */
  path: z.string(),
  title: z.string(),
  part: guidePartSchema,
  section: z.string(),
  order: z.number().int(),
  summary: z.string(),
  audience: guideAudienceSchema,
})
export type GuideTocEntry = z.infer<typeof guideTocEntrySchema>

export const guideTocResponseSchema = z.object({
  entries: z.array(guideTocEntrySchema),
})
export type GuideTocResponse = z.infer<typeof guideTocResponseSchema>

export const guideOutlineItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  level: z.number().int(),
})
export type GuideOutlineItem = z.infer<typeof guideOutlineItemSchema>

/**
 * One page for the reader: its markdown with facts resolved (frontmatter and the H1 removed), and
 * its outline. The reader renders the markdown itself and gives each H2/H3 the outline's id — the
 * same ids the indexer stamps on chunks and citations name.
 */
export const guidePageResponseSchema = z.object({
  path: z.string(),
  title: z.string(),
  meta: guideTocEntrySchema,
  markdown: z.string(),
  outline: z.array(guideOutlineItemSchema),
})
export type GuidePageResponse = z.infer<typeof guidePageResponseSchema>

export const guidePageQuerySchema = z.object({
  path: z.string().min(1).max(300),
})

/** The reader's route. */
export const GUIDE_PATH = '/guide'

/**
 * The reader URL for a page, optionally at a heading anchor — the one shape every link into the
 * reader takes: citations, `GuideLink`, the TOC, and links BETWEEN pages.
 */
export function guideHref(page: string, heading?: string | null): string {
  const hash = heading ? `#${encodeURIComponent(heading)}` : ''
  return `${GUIDE_PATH}?path=${encodeURIComponent(page)}${hash}`
}

/**
 * The anchor slug of a Guide heading — one function for both halves: the server stamps it on a
 * chunk's `heading` and on the outline, and the reader gives the rendered heading that id. Base
 * form; repeats on one page get `-1`, `-2` ({@link guideSlugger}).
 */
export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/['’"“”]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  )
}

/** A per-page slugger: the first `Do it` is `do-it`, the second `do-it-1`. */
export function guideSlugger(): (text: string) => string {
  const seen = new Map<string, number>()
  return text => {
    const base = slugifyHeading(text)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n ? `${base}-${n}` : base
  }
}

/** Where a link between Guide pages points: a page path and, optionally, a heading slug. */
export interface GuideLinkTarget {
  path: string
  hash: string | null
}

/** A scheme (`https:`, `mailto:`) or a protocol-relative `//host` — a link out, left alone. */
const EXTERNAL_HREF = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

function decodeHrefPart(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/** POSIX `normalize(join(dirname(from), rel))` for relative paths — no `node:path` in a browser. */
function joinRelative(fromPath: string, rel: string): string | null {
  const out = fromPath.split('/').slice(0, -1)
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
    } else out.push(seg)
  }
  return out.join('/')
}

/**
 * Resolve a link written on page `fromPath` to the Guide page it names, or `null` when it is not a
 * link between pages. Pages link the way markdown files do — `../admin/x.md`, `x.md#heading`,
 * `#heading` — so they read correctly in the repository too; the reader turns the result into a
 * reader URL, and the staleness test holds every one to a real page and a real heading.
 *
 * Not a page link: an external URL, a site-absolute path, a non-`.md` target, or a path that
 * climbs out of the content directory.
 */
export function resolveGuideLink(href: string, fromPath: string): GuideLinkTarget | null {
  const h = href.trim()
  if (!h || EXTERNAL_HREF.test(h) || h.startsWith('/')) return null
  const hashAt = h.indexOf('#')
  const target = hashAt >= 0 ? h.slice(0, hashAt) : h
  const hash = hashAt >= 0 ? decodeHrefPart(h.slice(hashAt + 1)) || null : null
  if (target === '') return hash ? { path: fromPath, hash } : null
  if (!/\.md$/i.test(target)) return null
  const resolved = joinRelative(fromPath, decodeHrefPart(target))
  if (!resolved) return null
  return { path: resolved, hash }
}

/** A link on page `pagePath` → the reader URL of the page it names, or the href unchanged. */
export function guideLinkHref(href: string, pagePath: string): string {
  const target = resolveGuideLink(href, pagePath)
  return target ? guideHref(target.path, target.hash) : href
}

/** Where page images are served from; a `shot:<id>` reference resolves to `<id>.png` here. */
export const GUIDE_IMAGE_ROUTE = '/api/guide/images/'

/** `shot:<id>` → the image URL; any other href is left alone. */
export function guideImageSrc(href: string): string {
  const m = /^shot:(.+)$/.exec(href.trim())
  return m ? `${GUIDE_IMAGE_ROUTE}${encodeURIComponent(m[1] ?? '')}.png` : href
}

/**
 * The callouts a page may use: a blockquote that opens with one of these labels in bold, then an
 * em dash — `> **RULE OF THUMB** — Invite people by email, not by sharing a link.` The reader
 * renders it as a labelled aside (in sentence case: the UI never shouts).
 */
export const GUIDE_CALLOUT_LABELS = ['RULE OF THUMB', 'IN PRACTICE', 'WATCH OUT'] as const
export type GuideCalloutLabel = (typeof GUIDE_CALLOUT_LABELS)[number]

/** A resolved citation from the chat → a reader link. */
export const guideCitationSchema = z.object({
  page: z.string().nullable(),
  heading: z.string().nullable(),
  note: z.string().nullable(),
  title: z.string(),
  valid: z.boolean(),
})
export type GuideCitation = z.infer<typeof guideCitationSchema>

/** The screen hint label's character set — see {@link guideScreenHintSchema}. */
export const GUIDE_SCREEN_LABEL_PATTERN = /^[\p{L}\p{N} ,.&'()/›…-]+$/u

/**
 * Where the reader is when they ask — a short label derived from the route by the UI's
 * `screenForRoute()`. Deliberately carries no tenant data and no names: nothing tenant-specific
 * enters a global-corpus chat.
 */
export const guideScreenHintSchema = z.object({
  /**
   * e.g. "Settings". Limited to the characters the fixed vocabulary uses — letters, digits,
   * spaces, `› … , . & ' ( ) / -` — because it is appended to a system prompt verbatim: no
   * newlines, quotes, colons or brackets to start a new instruction with.
   */
  label: z
    .string()
    .min(1)
    .max(120)
    .regex(GUIDE_SCREEN_LABEL_PATTERN, 'Screen label contains unsupported characters'),
  /** The Guide page the screen maps to, if any. */
  page: z.string().max(300).nullable().optional(),
  /** The part the screen belongs to; a soft retrieval preference (that part ranks first). */
  part: guidePartSchema.nullable().optional(),
})
export type GuideScreenHint = z.infer<typeof guideScreenHintSchema>

export const guideChatTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
})
export type GuideChatTurn = z.infer<typeof guideChatTurnSchema>

/** Caps on what one ask carries — the UI trims to them, the server refuses beyond them. */
export const GUIDE_MAX_QUESTION = 4000
export const GUIDE_MAX_HISTORY = 20

/**
 * Request body for `POST /api/guide/ask` — streamed as AG-UI (`RUN_STARTED`, `TEXT_MESSAGE_*`,
 * `TOOL_CALL_*`, `CUSTOM kit.guide.answer`, `RUN_FINISHED` | `RUN_ERROR`). Stateless: the client
 * sends the prior turns; nothing is persisted.
 */
export const askGuideSchema = z.object({
  question: z.string().min(1).max(GUIDE_MAX_QUESTION),
  history: z.array(guideChatTurnSchema).max(GUIDE_MAX_HISTORY).optional(),
  screen: guideScreenHintSchema.optional(),
})
export type AskGuideRequest = z.infer<typeof askGuideSchema>

/**
 * The payload of `CUSTOM kit.guide.answer` (`KIT_CUSTOM_EVENTS.guideAnswer`): the answer with its
 * trailing `CITATIONS:` block resolved against the asker's own TOC.
 */
export const guideAnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(guideCitationSchema),
  /**
   * How the passages were found: `hybrid` (vectors + keywords), `lexical` (keywords only — no
   * vectors were loaded, no platform embedder, or a different model built them) or `none` (the
   * model never searched).
   */
  retrieval: z.enum(['hybrid', 'lexical', 'none']),
})
export type GuideAnswer = z.infer<typeof guideAnswerSchema>

/** Default number of passages per `search_guide` call, and the hard cap. */
export const GUIDE_DEFAULT_TOP_K = 8
export const GUIDE_MAX_TOP_K = 24
