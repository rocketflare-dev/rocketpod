/**
 * The Guide's content model: markdown pages with frontmatter under `apps/web/content/guide/`. The
 * TOC is DERIVED from the frontmatter — there is no hand-kept index to drift from the files.
 *
 * What is a page: every `**\/*.md` except a root `VOICE.md` / `README.md` (notes for writers,
 * never shown or indexed) and anything under a `_`-prefixed directory (drafts, research notes).
 *
 * PURE: no filesystem, no database, no config. The files arrive as `{ path, raw }` — from the
 * Platform's `guide` source at run time (`src/node/guide-content.ts`), from `node:fs` in the
 * scripts and the staleness test — so everything here runs in the DB-free `config` test project.
 */
import { createHash } from 'node:crypto'
import {
  GUIDE_AUDIENCES,
  GUIDE_PARTS,
  GUIDE_SECTIONS,
  type GuideAudience,
  type GuideOutlineItem,
  type GuidePageFrontmatter,
  type GuidePart,
  type GuideTocEntry,
  guideLinkHref,
  guidePageFrontmatterSchema,
  guideSectionIndex,
  guideSlugger,
  visibleAudiences,
} from '@rocketpod/shared/guide'
import { parse as parseYaml } from 'yaml'
import { chunkText, estimateTokens } from './ai/chunking'
import { resolveGuideFacts } from './guide-facts'

/** One file under the content dir: its POSIX path relative to it, and its text. */
export interface GuideSourceFile {
  path: string
  raw: string
}

/** The screenshot manifest, beside the pages; a missing file is an empty manifest. */
export const GUIDE_SCREENSHOT_MANIFEST = 'screenshots.yaml'
/**
 * The committed VECTORS, beside the pages (`pnpm web guide:index` writes it, with a platform
 * embeddings key). Optional: the chunks themselves are always derived from the pages at boot, and a
 * chunk takes a vector from here only when its exact text was embedded — so a missing or stale
 * fixture degrades retrieval to keywords, never breaks it.
 */
export const GUIDE_FIXTURE_FILE = 'embeddings.jsonl.gz'
/** The command that rebuilds the fixture — named in every stale-fixture message. */
export const GUIDE_INDEX_COMMAND = 'pnpm web guide:index'

/** Root-level files that live beside the pages but are not pages. */
const NON_PAGE_FILES = new Set(['VOICE.md', 'README.md'])

/** Whether a content-relative path is a Guide page. */
export function isGuidePagePath(rel: string): boolean {
  if (!rel.endsWith('.md')) return false
  const segs = rel.split('/')
  if (segs.some(s => s.startsWith('.') || s === '')) return false
  if (segs.slice(0, -1).some(s => s.startsWith('_'))) return false
  return !(segs.length === 1 && NON_PAGE_FILES.has(rel))
}

export interface GuidePage {
  /** Relative to the content dir, POSIX separators — the citation key. */
  path: string
  /** The file exactly as committed. */
  raw: string
  frontmatter: GuidePageFrontmatter
  /** The markdown after the frontmatter, placeholders unresolved. */
  body: string
  /** sha256 of `raw` — what the fixture records and the staleness test compares. */
  contentHash: string
}

export interface GuidePageProblem {
  path: string
  message: string
}

export function guideContentHash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** Parse one page. Throws with a readable message on missing or invalid frontmatter. */
export function parseGuidePage(pagePath: string, raw: string): GuidePage {
  const m = FRONTMATTER.exec(raw)
  if (!m) throw new Error(`${pagePath}: no frontmatter (a page starts with a --- block)`)
  let data: unknown
  try {
    data = parseYaml(m[1] ?? '')
  } catch (err) {
    throw new Error(`${pagePath}: frontmatter is not valid YAML — ${(err as Error).message}`)
  }
  const parsed = guidePageFrontmatterSchema.safeParse(data)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`${pagePath}: invalid frontmatter — ${issues.join('; ')}`)
  }
  const { part, section } = parsed.data
  if (!GUIDE_SECTIONS[part].some(s => s.id === section)) {
    const known = GUIDE_SECTIONS[part].map(s => s.id).join(', ')
    throw new Error(
      `${pagePath}: section "${section}" is not one of the ${part} sections (${known})`
    )
  }
  if (pagePath.split('/')[0] !== part) {
    throw new Error(`${pagePath}: a ${part} page lives under ${part}/`)
  }
  return {
    path: pagePath,
    raw,
    frontmatter: parsed.data,
    body: raw.slice(m[0].length),
    contentHash: guideContentHash(raw),
  }
}

/**
 * Parse every page among `files`. A page that fails to parse is reported, not thrown: the reader
 * keeps serving the rest, and the staleness test fails on any problem.
 */
export function loadGuidePages(files: readonly GuideSourceFile[]): {
  pages: GuidePage[]
  problems: GuidePageProblem[]
} {
  const pages: GuidePage[] = []
  const problems: GuidePageProblem[] = []
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!isGuidePagePath(file.path)) continue
    try {
      pages.push(parseGuidePage(file.path, file.raw))
    } catch (err) {
      problems.push({ path: file.path, message: (err as Error).message })
    }
  }
  return { pages, problems }
}

const PART_ORDER = new Map<string, number>(GUIDE_PARTS.map((p, i) => [p, i]))

/** Sort by part (reading order), then section, then order, then path. */
export function compareGuideEntries(a: GuideTocEntry, b: GuideTocEntry): number {
  return (
    (PART_ORDER.get(a.part) ?? 99) - (PART_ORDER.get(b.part) ?? 99) ||
    guideSectionIndex(a.part, a.section) - guideSectionIndex(b.part, b.section) ||
    a.order - b.order ||
    a.path.localeCompare(b.path)
  )
}

export function tocEntryFor(page: GuidePage): GuideTocEntry {
  const f = page.frontmatter
  return {
    path: page.path,
    title: f.title,
    part: f.part,
    section: f.section,
    order: f.order,
    summary: f.summary,
    audience: f.audience,
  }
}

/** Whether a reader of `audience` may see this page — THE audience rule for pages. */
export function isVisibleTo(page: GuidePage, audience: GuideAudience): boolean {
  return visibleAudiences(audience).includes(page.frontmatter.audience)
}

/**
 * The TOC a reader of `audience` sees. The audience filter is applied HERE, once, and the page
 * endpoint resolves paths through this list — so a page outside the reader's audience is unknown
 * to them, not merely unlisted.
 */
export function guideToc(pages: readonly GuidePage[], audience: GuideAudience): GuideTocEntry[] {
  return pages
    .filter(p => isVisibleTo(p, audience))
    .map(tocEntryFor)
    .sort(compareGuideEntries)
}

/** The page's markdown with facts resolved (frontmatter off) — what is rendered AND embedded. */
export function guidePageMarkdown(page: GuidePage): string {
  return resolveGuideFacts(page.body)
}

/** The reader's markdown: facts resolved and the leading `# Title` dropped (the reader shows it). */
export function guideReaderMarkdown(page: GuidePage): string {
  return guidePageMarkdown(page).replace(/^\s*#\s+[^\n]*\n+/, '')
}

// ---- Headings: ONE scan, shared by the outline, the chunker and the reader ------------------

/** A fenced code block's opening or closing line: ``` or ~~~, optionally indented. */
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/
const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*#*\s*$/

/** A heading's text as the reader shows it: inline code, emphasis and link syntax removed. */
export function headingPlainText(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .trim()
}

export interface GuideHeading {
  /** The 0-based line the heading sits on. */
  line: number
  level: number
  text: string
  id: string
}

/**
 * Every ATX heading outside a fenced code block, in order, with its anchor id from ONE slugger —
 * so a repeated `## Do it` is `do-it-1` in the outline, in the chunk that cites it and on the
 * rendered page alike. A `## …` inside a fence is code, not a heading.
 */
export function scanGuideHeadings(md: string): GuideHeading[] {
  const slug = guideSlugger()
  const out: GuideHeading[] = []
  let fence: string | null = null
  md.split('\n').forEach((line, i) => {
    const marker = FENCE_LINE.exec(line)?.[1]
    if (marker) {
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      return
    }
    if (fence !== null) return
    const h = HEADING_LINE.exec(line)
    if (!h) return
    const level = (h[1] as string).length
    if (level === 1) return
    const text = headingPlainText(h[2] as string)
    out.push({ line: i, level, text, id: slug(text) })
  })
  return out
}

/** The reader's outline: the page's H2 and H3 headings. */
export function guideOutline(readerMarkdown: string): GuideOutlineItem[] {
  return scanGuideHeadings(readerMarkdown)
    .filter(h => h.level <= 3)
    .map(h => ({ id: h.id, text: h.text, level: h.level }))
}

// ---- Chunks ------------------------------------------------------------------------------------

export interface GuideChunk {
  /** The id of the nearest preceding H2, or null before the first one. */
  heading: string | null
  content: string
  tokens: number
}

const IMAGE_ONLY_LINE = /^!\[[^\]]*\]\([^)]*\)\s*$/

/** A line that only opens or closes a wrapper `<div>` (a status table's): layout, not content. */
const DIV_ONLY_LINE = /^<\/?div(\s[^>]*)?>$/

/** A `<span …>text</span>` (a status badge) reads as its text: the model needs "Built", not markup. */
const unwrapSpans = (text: string) => text.replace(/<span\b[^>]*>([^<]*)<\/span>/g, '$1')

/** Each line inside an inline `<svg>…</svg>` diagram: drawn in the reader, noise to a model. */
function svgLines(lines: string[]): Set<number> {
  const inside = new Set<number>()
  let open = false
  lines.forEach((l, i) => {
    if (!open && /^\s*<svg[\s>]/.test(l)) open = true
    if (open) inside.add(i)
    if (open && /<\/svg>\s*$/.test(l)) open = false
  })
  return inside
}

/**
 * A page → retrievable chunks: split at H2 (ids from {@link scanGuideHeadings}, the reader's own),
 * each section packed by the chunker, each chunk led by `Title › Section` so a passage read
 * on its own says where it is from. Image-only lines and inline `<svg>` diagrams are dropped: they
 * are viewed in the reader (a diagram's prose equivalent stays).
 */
export function chunkGuidePage(page: GuidePage): GuideChunk[] {
  const md = guideReaderMarkdown(page)
  const lines = md.split('\n')
  const svg = svgLines(lines)
  const h2s = scanGuideHeadings(md).filter(h => h.level === 2)
  const sections: { heading: GuideHeading | null; text: string }[] = []
  let start = 0
  let current: GuideHeading | null = null
  for (const h of [...h2s, null]) {
    const end = h ? h.line : lines.length
    const text = lines
      .slice(start, end)
      .filter(
        (l, i) =>
          !svg.has(start + i) && !IMAGE_ONLY_LINE.test(l.trim()) && !DIV_ONLY_LINE.test(l.trim())
      )
      .map(unwrapSpans)
      .join('\n')
      .trim()
    if (text) sections.push({ heading: current, text })
    if (h) {
      current = h
      start = h.line + 1
    }
  }
  const title = page.frontmatter.title
  // Links between pages become reader URLs, so a passage the model quotes links somewhere real.
  const linked = (text: string) =>
    text.replace(/(?<!!)\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g, (m, label: string, href: string) => {
      const url = guideLinkHref(href, page.path)
      return url === href ? m : `[${label}](${url})`
    })
  return sections.flatMap(s =>
    chunkText(linked(s.text)).map(c => {
      const content = `${s.heading ? `${title} › ${s.heading.text}` : title}\n\n${c.text}`
      return { heading: s.heading?.id ?? null, content, tokens: estimateTokens(content) }
    })
  )
}

// ---- Screenshots ---------------------------------------------------------------------------

const SHOT_REF = /!\[[^\]]*\]\(\s*shot:([^)\s]+)\s*\)/g

/** The screenshot ids a page references as `![alt](shot:<id>)`. */
export function guideShotRefs(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(SHOT_REF)].map(m => m[1] as string))]
}

/** The ids `screenshots.yaml` declares (`{ shots: [{ id, … }] }` or a bare list). */
export function parseScreenshotIds(raw: string | null): Set<string> {
  if (!raw) return new Set()
  const data = parseYaml(raw) as unknown
  const entries = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { shots?: unknown }).shots)
      ? (data as { shots: unknown[] }).shots
      : []
  const ids = new Set<string>()
  for (const e of entries) {
    if (e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string') {
      ids.add((e as { id: string }).id)
    }
  }
  return ids
}

// ---- The fixture ---------------------------------------------------------------------------

/**
 * One chunk as `guide_chunks` holds it, and one line of the committed fixture
 * (`embeddings.jsonl.gz`, NDJSON gzipped). `embedding` is null for a chunk no fixture embedded:
 * retrieval for it is then keyword-only, and says so.
 */
export interface GuideFixtureRow {
  pagePath: string
  part: GuidePart
  audience: GuideAudience
  heading: string | null
  content: string
  tokens: number
  /** sha256 of the page's raw file when it was indexed. */
  contentHash: string
  embeddingModel: string | null
  embedding: number[] | null
}

/** A problem with one fixture row, or null. */
export function validateGuideFixtureRow(row: unknown, dimensions: number): string | null {
  if (!row || typeof row !== 'object') return 'not an object'
  const r = row as Partial<GuideFixtureRow>
  if (!r.pagePath || typeof r.pagePath !== 'string') return 'missing pagePath'
  if (!r.contentHash || typeof r.contentHash !== 'string') return 'missing contentHash'
  if (!r.content || typeof r.content !== 'string') return 'missing content'
  if (!(GUIDE_PARTS as readonly string[]).includes(r.part as string)) {
    return `unknown part '${r.part}'`
  }
  if (!(GUIDE_AUDIENCES as readonly string[]).includes(r.audience as string)) {
    return `unknown audience '${r.audience}'`
  }
  if (r.embedding !== null && r.embedding !== undefined) {
    if (!Array.isArray(r.embedding) || r.embedding.length !== dimensions) {
      return `embedding must be null or ${dimensions} numbers`
    }
    if (!r.embeddingModel) return 'an embedding without its embeddingModel'
  }
  return null
}

/** `pagePath -> contentHash` for every page in a set of fixture rows. */
export function fixturePageHashes(
  rows: ReadonlyArray<Pick<GuideFixtureRow, 'pagePath' | 'contentHash'>>
): Map<string, string> {
  return new Map(rows.map(r => [r.pagePath, r.contentHash]))
}

/**
 * Carry vectors over from the previous fixture: a row whose exact chunk text was already embedded
 * by `model` takes that vector, so a re-index after an edit embeds only the chunks that changed.
 * Mutates `rows`; returns the rows still needing a vector. A different model reuses nothing.
 */
export function reuseGuideEmbeddings(
  rows: GuideFixtureRow[],
  previous: readonly GuideFixtureRow[],
  model: string
): GuideFixtureRow[] {
  const byContent = new Map<string, number[]>()
  for (const row of previous) {
    if (row.embedding && row.embeddingModel === model) byContent.set(row.content, row.embedding)
  }
  const missing: GuideFixtureRow[] = []
  for (const row of rows) {
    const vector = byContent.get(row.content)
    if (vector) {
      row.embedding = vector
      row.embeddingModel = model
    } else missing.push(row)
  }
  return missing
}

/** The rows for these pages, without embeddings (`buildGuideRows` or the indexer adds them). */
export function guideFixtureRows(pages: readonly GuidePage[]): GuideFixtureRow[] {
  return pages.flatMap(page =>
    chunkGuidePage(page).map(chunk => ({
      pagePath: page.path,
      part: page.frontmatter.part,
      audience: page.frontmatter.audience,
      heading: chunk.heading,
      content: chunk.content,
      tokens: chunk.tokens,
      contentHash: page.contentHash,
      embeddingModel: null,
      embedding: null,
    }))
  )
}

/**
 * The model most of a fixture's vectors came from, or null when it carries none. One model per
 * table: the dense half compares a query embedded by the platform model with these vectors, so
 * vectors from two models would rank against each other meaninglessly.
 */
export function fixtureModel(rows: readonly GuideFixtureRow[]): string | null {
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (r.embedding && r.embeddingModel) {
      counts.set(r.embeddingModel, (counts.get(r.embeddingModel) ?? 0) + 1)
    }
  }
  let best: string | null = null
  for (const [model, n] of counts) if (!best || n > (counts.get(best) ?? 0)) best = model
  return best
}

/**
 * What `guide_chunks` should hold: the pages AS THEY ARE, chunked now, each chunk carrying the
 * committed fixture's vector when the fixture embedded that exact text (with its majority model).
 * The pages are the source of truth and the fixture only a cache of vectors, so an edited page is
 * searchable by keyword at once and by meaning after the next `guide:index`.
 */
export function buildGuideRows(
  pages: readonly GuidePage[],
  fixture: readonly GuideFixtureRow[] | null
): GuideFixtureRow[] {
  const rows = guideFixtureRows(pages)
  const model = fixture ? fixtureModel(fixture) : null
  if (fixture && model) reuseGuideEmbeddings(rows, fixture, model)
  return rows
}
