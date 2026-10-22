/**
 * THE GUIDE'S STALENESS TEST. No database and no env file — it reads the committed content and
 * vectors (`apps/web/content/guide/`), so it runs in the DB-free `config` project.
 *
 * It fails when a page could ship wrong:
 *
 * - its frontmatter is invalid, or it sits outside its part's directory;
 * - it uses a `{{fact:…}}` key the registry does not know;
 * - it references a `shot:` screenshot `screenshots.yaml` does not declare;
 * - it links to a page, or a heading, that does not exist — or, from a `member` page, to an
 *   `admin` page its reader would get a 404 for — and so does the screen map, whose every target
 *   must be a page EVERY member can read;
 * - the committed vectors (`embeddings.jsonl.gz`), when there are any, would not load.
 *
 * A STALE fixture is not a failure: the server chunks the pages itself at boot and borrows only
 * the vectors whose chunk text still matches, so an edited page is keyword-searchable at once and
 * found by meaning again after `pnpm web guide:index` (`docs/CONCEPTS.md` § The Guide).
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { EMBEDDING_DIM } from '@rocketpod/shared/ai/config'
import { guideHref, guideLinkHref, resolveGuideLink } from '@rocketpod/shared/guide'
import {
  GUIDE_ADMIN_SCREEN_PAGES,
  GUIDE_SCREEN_PAGES,
  GUIDE_TOPIC_PAGES,
} from '@rocketpod/shared/guide-screens'
import { describe, expect, it } from 'vitest'
import {
  buildGuideRows,
  chunkGuidePage,
  fixtureModel,
  guideOutline,
  guidePageMarkdown,
  guideReaderMarkdown,
  guideShotRefs,
  guideToc,
  isGuidePagePath,
  loadGuidePages,
  parseGuidePage,
  parseScreenshotIds,
  reuseGuideEmbeddings,
  scanGuideHeadings,
} from '@/api/services/guide-content'
import { unknownGuideFactKeys } from '@/api/services/guide-facts'
import { readGuideFixture, readGuideMarkdownFiles } from '@/node/guide-content'
import { WEB_ROOT } from '../helpers/source-files'

const GUIDE_DIR = path.join(WEB_ROOT, 'content/guide')

async function committed() {
  return loadGuidePages(await readGuideMarkdownFiles(GUIDE_DIR))
}

/** Every markdown link target on a page (images excluded). */
function linksOf(markdown: string): string[] {
  return [...markdown.matchAll(/(?<!!)\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g)].map(
    m => m[1] as string
  )
}

describe('the committed Guide content', () => {
  it('VOICE.md, README.md and _-prefixed directories are not pages', () => {
    expect(isGuidePagePath('VOICE.md')).toBe(false)
    expect(isGuidePagePath('README.md')).toBe(false)
    expect(isGuidePagePath('_notes/x.md')).toBe(false)
    expect(isGuidePagePath('admin/_draft/x.md')).toBe(false)
    expect(isGuidePagePath('admin/roles.md')).toBe(true)
  })

  it('every page has valid frontmatter', async () => {
    const { problems } = await committed()
    expect(problems.map(p => p.message)).toEqual([])
  })

  it('every page uses only known fact keys, and every fact resolves', async () => {
    const { pages } = await committed()
    const unknown = pages.flatMap(p => unknownGuideFactKeys(p.body).map(k => `${p.path}: ${k}`))
    // Add the key to GUIDE_FACTS in src/api/services/guide-facts.ts, built from the real constant.
    expect(unknown).toEqual([])
    for (const page of pages) expect(guidePageMarkdown(page)).not.toMatch(/\{\{\s*fact:/)
  })

  it('every shot: reference is declared in screenshots.yaml', async () => {
    const { pages } = await committed()
    const declared = parseScreenshotIds(
      readFileSync(path.join(GUIDE_DIR, 'screenshots.yaml'), 'utf8')
    )
    const undeclared = pages.flatMap(p =>
      guideShotRefs(p.body)
        .filter(id => !declared.has(id))
        .map(id => `${p.path}: shot:${id}`)
    )
    expect(undeclared).toEqual([])
  })

  it('the committed vectors, if any, load (a corrupt file would fail every web boot’s load)', async () => {
    await expect(readGuideFixture(GUIDE_DIR, EMBEDDING_DIM)).resolves.not.toThrow()
  })

  it('every link between pages lands on a real page, and every #heading on a real heading', async () => {
    const { pages } = await committed()
    const ids = new Map(
      pages.map(p => [p.path, new Set(guideOutline(guideReaderMarkdown(p)).map(o => o.id))])
    )
    const broken: string[] = []
    for (const page of pages) {
      for (const href of linksOf(guidePageMarkdown(page))) {
        if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) continue // external
        const target = resolveGuideLink(href, page.path)
        if (!target) {
          broken.push(`${page.path}: ${href} (not a link to a Guide page)`)
          continue
        }
        if (!ids.has(target.path)) broken.push(`${page.path}: ${target.path} (no such page)`)
        else if (target.hash && !ids.get(target.path)?.has(target.hash)) {
          broken.push(`${page.path}: ${target.path}#${target.hash} (no such heading)`)
        }
      }
    }
    expect(broken).toEqual([])
  })

  it('a member page never links to an admin page (its reader would get a 404)', async () => {
    const { pages } = await committed()
    const audience = new Map(pages.map(p => [p.path, p.frontmatter.audience]))
    const leaks = pages
      .filter(p => p.frontmatter.audience === 'member')
      .flatMap(page =>
        linksOf(guidePageMarkdown(page))
          .map(href => resolveGuideLink(href, page.path))
          .filter(t => t !== null && audience.get(t.path) === 'admin')
          .map(t => `${page.path} → ${t?.path}`)
      )
    expect(leaks).toEqual([])
  })

  it('every page the screen and topic maps point at is a page every member can read', async () => {
    const { pages } = await committed()
    const memberPages = new Set(guideToc(pages, 'member').map(e => e.path))
    const missing = [...Object.entries(GUIDE_SCREEN_PAGES), ...Object.entries(GUIDE_TOPIC_PAGES)]
      .filter(([, page]) => page !== null && !memberPages.has(page))
      .map(([screen, page]) => `${screen} → ${page}`)
    expect(missing).toEqual([])
  })

  it('every page the admin screen map points at exists', async () => {
    const { pages } = await committed()
    const adminPages = new Set(guideToc(pages, 'admin').map(e => e.path))
    const missing = Object.entries(GUIDE_ADMIN_SCREEN_PAGES)
      .filter(([, page]) => page !== null && !adminPages.has(page))
      .map(([screen, page]) => `${screen} → ${page}`)
    expect(missing).toEqual([])
  })
})

const page = (rel: string, frontmatter: Record<string, unknown>, body: string) =>
  parseGuidePage(
    rel,
    `---\n${Object.entries({
      title: 'T',
      part: 'admin',
      section: 'organisation',
      order: 10,
      audience: 'member',
      summary: 'S',
      sources: ['x'],
      verified: 'abcdef1',
      ...frontmatter,
    })
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n')}\n---\n${body}`
  )

describe('pages', () => {
  it('refuse a section their part does not declare, and a part outside its directory', () => {
    expect(() => page('admin/x.md', { section: 'chat' }, '# T\n')).toThrow(
      /not one of the admin sections/
    )
    expect(() => page('reference/x.md', {}, '# T\n')).toThrow(/lives under admin\//)
  })

  it('sort by part, then section order, then order — and admin pages only reach admins', () => {
    const pages = [
      page('start/a.md', { part: 'start', section: 'start-here', order: 1 }, ''),
      page('admin/b.md', { section: 'ai', order: 1 }, ''),
      page('admin/c.md', { section: 'organisation', order: 20 }, ''),
      page('admin/d.md', { section: 'organisation', order: 10, audience: 'admin' }, ''),
    ]
    expect(guideToc(pages, 'admin').map(e => e.path)).toEqual([
      'start/a.md',
      'admin/d.md',
      'admin/c.md',
      'admin/b.md',
    ])
    expect(guideToc(pages, 'member').map(e => e.path)).not.toContain('admin/d.md')
  })
})

describe('headings, outline and chunks', () => {
  const md = [
    '# Title',
    '',
    'Intro.',
    '',
    '## Do it',
    '',
    '```bash',
    '## not a heading',
    '```',
    '',
    '### Use `rocketpod login`',
    '',
    '## Do it',
    '',
    '![shot](shot:x)',
    '<svg viewBox="0 0 10 10" role="img" aria-label="A box">',
    '  <rect width="10" height="10" />',
    '</svg>',
    '<div class="guide-status-table">',
    'Second <span class="guide-status" data-status="built">Built</span>.',
    '</div>',
  ].join('\n')
  const p = page('admin/h.md', { title: 'Title' }, md)

  it('one slugger: a repeated heading gets -1, a fenced ## is code, inline code is plain text', () => {
    const outline = guideOutline(guideReaderMarkdown(p))
    expect(outline).toEqual([
      { id: 'do-it', text: 'Do it', level: 2 },
      { id: 'use-rocketpod-login', text: 'Use rocketpod login', level: 3 },
      { id: 'do-it-1', text: 'Do it', level: 2 },
    ])
    expect(scanGuideHeadings('```\n## x\n```\n## y').map(h => h.id)).toEqual(['y'])
  })

  it('chunks cite the SAME ids the outline anchors on, lead with title › section, drop images, svgs and wrapper divs, read badges as text', () => {
    const chunks = chunkGuidePage(p)
    expect(chunks.map(c => c.heading)).toEqual([null, 'do-it', 'do-it-1'])
    expect(chunks[2]?.content).toBe('Title › Do it\n\nSecond Built.')
    expect(chunks[1]?.content).toContain('## not a heading')
  })
})

describe('re-indexing', () => {
  const row = (
    content: string,
    model: string | null = null,
    embedding: number[] | null = null
  ) => ({
    pagePath: 'start/a.md',
    part: 'start' as const,
    audience: 'member' as const,
    heading: null,
    content,
    tokens: 1,
    contentHash: 'h',
    embeddingModel: model,
    embedding,
  })

  it('keeps the vector of an unchanged chunk, embeds only the changed ones, never across models', () => {
    const previous = [row('kept', 'm1', [1]), row('edited before', 'm1', [2]), row('x', 'm0', [3])]
    const rows = [row('kept'), row('edited after'), row('x')]
    const todo = reuseGuideEmbeddings(rows, previous, 'm1')
    expect(todo.map(r => r.content)).toEqual(['edited after', 'x'])
    expect(rows[0]).toMatchObject({ embedding: [1], embeddingModel: 'm1' })
    expect(rows[2]?.embedding).toBeNull()
  })

  it('the boot rows are the pages as they are now, borrowing only vectors for unchanged chunk text', () => {
    const edited = page(
      'admin/b.md',
      { title: 'B' },
      '# B\n\nIntro.\n\n## Kept\n\nSame.\n\n## New\n\nEdited.\n'
    )
    const [intro, kept, changed] = buildGuideRows([edited], null)
    const vector = (n: number) => new Array<number>(4).fill(n)
    // A fixture from an older version of the page: two chunks still match, one does not, and one
    // stray vector came from another model.
    const fixture = [
      { ...intro, embedding: vector(1), embeddingModel: 'm1' },
      { ...kept, embedding: vector(2), embeddingModel: 'm1' },
      { ...changed, content: 'B › New\n\nOriginal.', embedding: vector(3), embeddingModel: 'm1' },
      { ...changed, embedding: vector(9), embeddingModel: 'm0' },
    ].map(r => ({ ...(r as NonNullable<typeof r>) }))
    expect(fixtureModel(fixture)).toBe('m1')
    const rows = buildGuideRows([edited], fixture)
    expect(rows.map(r => r.embedding?.[0] ?? null)).toEqual([1, 2, null])
    expect(rows.map(r => r.embeddingModel)).toEqual(['m1', 'm1', null])
    // No fixture at all is a keyword-only Guide, never an empty one.
    expect(buildGuideRows([edited], null).every(r => r.embedding === null)).toBe(true)
    expect(fixtureModel([])).toBeNull()
  })
})

describe('chunk links', () => {
  it('turn links between pages into reader URLs, so a quoted passage links somewhere real', () => {
    const p = page(
      'admin/l.md',
      {},
      '# T\n\nSee [the roles](roles.md#how-it-works), [out](https://x.test) and ![i](shot:a).\n'
    )
    const [chunk] = chunkGuidePage(p)
    expect(chunk?.content).toContain(`[the roles](${guideHref('admin/roles.md', 'how-it-works')})`)
    expect(chunk?.content).toContain('[out](https://x.test)')
  })
})

describe('links between Guide pages', () => {
  it('resolve against the page they sit on', () => {
    const from = 'start/signing-in.md'
    expect(resolveGuideLink('welcome.md', from)).toEqual({
      path: 'start/welcome.md',
      hash: null,
    })
    expect(resolveGuideLink('../admin/x.md#how-it-works', from)).toEqual({
      path: 'admin/x.md',
      hash: 'how-it-works',
    })
    expect(resolveGuideLink('./y.md', from)).toEqual({ path: 'start/y.md', hash: null })
    expect(resolveGuideLink('#do-it', from)).toEqual({ path: from, hash: 'do-it' })
    for (const href of [
      'https://example.com/a.md',
      'mailto:a@b.c',
      '/settings',
      '//x/y.md',
      'x.png',
      '../../escape.md',
    ]) {
      expect(resolveGuideLink(href, from), href).toBeNull()
    }
  })

  it('render as reader URLs; external links stay as written', () => {
    const from = 'reference/glossary.md'
    expect(guideLinkHref('../admin/roles.md#how-it-works', from)).toBe(
      guideHref('admin/roles.md', 'how-it-works')
    )
    expect(guideHref('admin/roles.md', 'how-it-works')).toBe(
      '/guide?path=admin%2Froles.md#how-it-works'
    )
    expect(guideLinkHref('https://www.anthropic.com', from)).toBe('https://www.anthropic.com')
  })
})
