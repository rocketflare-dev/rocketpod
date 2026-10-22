/**
 * One Guide page's markdown, rendered: react-markdown + GFM + raw HTML (`rehype-raw`), plus the
 * Guide's conventions (`remarkGuide`). A link between pages stays in the app; anything else opens
 * in a new tab.
 *
 * Raw HTML is allowed HERE ONLY: Guide pages are our own committed content (no user or analysed-
 * repo text ever reaches this renderer), and a dev tool's docs want `<details>`, `<kbd>`, a table
 * with a `colspan`. `<script>` is still dropped. Everything else that renders untrusted text —
 * Ask the Guide's answers (model output), the workspace's docs, chat — keeps `skipHtml`.
 * Headings and links between pages stay MARKDOWN: the outline and the link rewrite read the
 * markdown tree, not raw HTML.
 */
import type { GuideOutlineItem } from '@rocketpod/shared/guide'
import { memo, useMemo } from 'react'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import { Link } from 'react-router-dom'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { remarkGuide } from './remarkGuide'

const REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [rehypeRaw]
const DISALLOWED = ['script']

const COMPONENTS: Components = {
  a: ({ node: _node, href, children, ...props }) =>
    href?.startsWith('/guide') ? (
      <Link to={href} className="link link-accent">
        {children}
      </Link>
    ) : href?.startsWith('#') ? (
      <a href={href} className="link link-accent">
        {children}
      </a>
    ) : (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
  img: ({ node: _node, alt, src }) => (
    <img src={src} alt={alt ?? ''} loading="lazy" className="rounded-lg border border-base-300" />
  ),
}

function GuideMarkdownImpl({
  markdown,
  pagePath,
  outline,
}: {
  markdown: string
  pagePath: string
  outline: GuideOutlineItem[]
}) {
  const plugins = useMemo<NonNullable<Options['remarkPlugins']>>(
    () => [remarkGfm, [remarkGuide, { pagePath, outline }]],
    [pagePath, outline]
  )
  return (
    <div className="guide-content prose prose-sm md:prose-base max-w-none prose-a:text-accent prose-headings:scroll-mt-4">
      <ReactMarkdown
        remarkPlugins={plugins}
        rehypePlugins={REHYPE_PLUGINS}
        disallowedElements={DISALLOWED}
        components={COMPONENTS}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}

export const GuideMarkdown = memo(GuideMarkdownImpl)
