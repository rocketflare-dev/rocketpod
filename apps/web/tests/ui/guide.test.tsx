/**
 * The Guide reader's half of the heading contract: the reader renders a page with react-markdown
 * and gives its H2/H3s the SERVER's outline ids (`remarkGuide`). If the two ever disagree — a
 * heading the line scanner and remark count differently — a citation lands nowhere. So every
 * committed page is rendered and its anchors compared with its outline. Plus the callouts, the
 * links between pages, the screen hint's vocabulary and the chat history rule.
 */
import path from 'node:path'
import { guideHref } from '@rocketpod/shared/guide'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  guideOutline,
  guideReaderMarkdown,
  loadGuidePages,
  parseGuidePage,
} from '@/api/services/guide-content'
import { readGuideMarkdownFiles } from '@/node/guide-content'
import { guideHistory, stripCitationsBlock } from '@/ui/components/guide/useGuideConversation'
import { screenForRoute } from '@/ui/lib/guideScreens'
import { GuideMarkdown } from '@/ui/pages/guide/GuideMarkdown'
import { renderWithProviders } from './helpers/renderWithProviders'

const GUIDE_DIR = path.resolve(__dirname, '../../content/guide')

function renderPage(page: ReturnType<typeof parseGuidePage>) {
  const markdown = guideReaderMarkdown(page)
  const outline = guideOutline(markdown)
  const view = renderWithProviders(
    <GuideMarkdown markdown={markdown} pagePath={page.path} outline={outline} />
  )
  return { outline, view }
}

describe('the reader renders every committed page with the outline’s anchors', () => {
  it('gives each H2/H3 exactly the id the server outline (and every citation) uses', async () => {
    const { pages } = loadGuidePages(await readGuideMarkdownFiles(GUIDE_DIR))
    expect(pages.length).toBeGreaterThan(0)
    for (const page of pages) {
      const { outline, view } = renderPage(page)
      const rendered = [...view.container.querySelectorAll('h2, h3')].map(h => ({
        id: h.id,
        text: h.textContent,
      }))
      expect(rendered, page.path).toEqual(outline.map(o => ({ id: o.id, text: o.text })))
      view.unmount()
    }
  }, 30_000) // renders every committed Guide page: grows with the Guide
})

const fm = `---\ntitle: T\npart: start\nsection: start-here\norder: 1\naudience: member\nsummary: S\nsources:\n  - x\nverified: abcdef1\n---\n`

describe('the Guide’s markdown conventions', () => {
  it('turns a labelled blockquote into a callout, in sentence case, and keeps a plain quote', () => {
    const page = parseGuidePage(
      'start/t.md',
      `${fm}# T\n\n> **RULE OF THUMB** — Invite them **once**.\n\n> Just a quote.\n`
    )
    renderPage(page)
    const callout = document.querySelector('aside.guide-callout')
    expect(callout).toHaveAttribute('data-callout', 'rule-of-thumb')
    expect(callout?.querySelector('.guide-callout-label')?.textContent).toBe('Rule of thumb')
    expect(callout?.textContent).toContain('Invite them once.')
    expect(callout?.textContent).not.toContain('—')
    expect(screen.getByText('Just a quote.').closest('blockquote')).not.toBeNull()
  })

  it('routes links between pages in the app and sends others to a new tab', () => {
    const page = parseGuidePage(
      'start/t.md',
      `${fm}# T\n\nSee [the roles](../admin/roles.md#who-can-do-what) and [Anthropic](https://www.anthropic.com).\n\n<script>alert(1)</script>\n`
    )
    renderPage(page)
    expect(screen.getByRole('link', { name: 'the roles' })).toHaveAttribute(
      'href',
      guideHref('admin/roles.md', 'who-can-do-what')
    )
    const out = screen.getByRole('link', { name: 'Anthropic' })
    expect(out).toHaveAttribute('target', '_blank')
    expect(out).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders a page’s raw HTML (our own content) but never a script', () => {
    const page = parseGuidePage(
      'start/t.md',
      `${fm}# T\n\n<details><summary>Exit codes</summary>\n\nPress <kbd>⌘K</kbd> to **search**.\n\n</details>\n\n<script>alert(1)</script>\n`
    )
    renderPage(page)
    expect(screen.getByText('Exit codes').closest('details')).not.toBeNull()
    expect(screen.getByText('⌘K').tagName).toBe('KBD')
    // Markdown inside the HTML block still renders as markdown.
    expect(screen.getByText('search').tagName).toBe('STRONG')
    expect(document.querySelector('script')).toBeNull()
  })

  it('resolves a shot: image to the image route', () => {
    const page = parseGuidePage(
      'start/t.md',
      `${fm}# T\n\n![The people tab](shot:settings-people)\n`
    )
    renderPage(page)
    expect(screen.getByAltText('The people tab')).toHaveAttribute(
      'src',
      '/api/guide/images/settings-people.png'
    )
  })
})

describe('the screen hint', () => {
  it('names the screen from fixed words and never echoes an id from the URL', () => {
    const run = screenForRoute('/agents/runs/1f6d2c0e-secret-run')
    expect(run).toMatchObject({ label: 'Agents', part: 'workspace' })
    expect(JSON.stringify(run)).not.toMatch(/secret/)
    expect(JSON.stringify(screenForRoute('/documents/doc-acme-payroll'))).not.toMatch(/acme/)
    // A Settings tab with a page of its own names that page; an unknown tab falls back to Settings.
    expect(screenForRoute('/settings', '?tab=ai')).toMatchObject({
      label: 'Settings › AI',
      page: 'admin/ai-settings.md',
    })
    expect(screenForRoute('/settings', '?tab=nope')?.label).toBe('Settings')
    expect(screenForRoute('/profile/')).toEqual(screenForRoute('/profile'))
    expect(screenForRoute('/somewhere-else')).toBeNull()
  })
})

describe('the Guide conversation', () => {
  it('never sends a failed exchange back as history, and hides the raw citations block', () => {
    expect(
      guideHistory([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'answer a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'provider down', error: true },
        { role: 'user', content: 'c' },
        { role: 'assistant', content: '' },
      ])
    ).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'answer a' },
      { role: 'user', content: 'c' },
    ])
    expect(stripCitationsBlock('Answer.\n\nCITATIONS:\npage=x.md | heading=- | note=-')).toBe(
      'Answer.'
    )
  })
})
