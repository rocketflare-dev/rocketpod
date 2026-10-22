/**
 * The Guide's markdown conventions as one remark plugin, run by the reader before react-markdown
 * renders (raw HTML then goes through `rehype-raw` — see `GuideMarkdown`):
 *
 * - **Heading ids come from the server's outline**, in order, onto the page's top-level H2/H3s —
 *   the same ids the indexer stamps on chunks and citations name, so a citation always lands.
 *   (`tests/ui/guide-reader.test.tsx` renders every committed page and checks they line up.)
 * - **Callouts**: a blockquote opening `**RULE OF THUMB** —` becomes an `<aside>` with its label
 *   (shown in sentence case; the UI never shouts).
 * - **Links between pages** (`../concepts/x.md#h`) become reader URLs; `shot:<id>` images become
 *   the image route.
 *
 * Pure (mdast in, mdast out) and typed loosely on purpose: the mdast types are not a dependency.
 */
import {
  GUIDE_CALLOUT_LABELS,
  type GuideOutlineItem,
  guideImageSrc,
  guideLinkHref,
} from '@rocketpod/shared/guide'

interface MdNode {
  type: string
  depth?: number
  value?: string
  url?: string
  children?: MdNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

const LABELS = new Set<string>(GUIDE_CALLOUT_LABELS)

/** `RULE OF THUMB` → `Rule of thumb`. */
export function calloutLabelText(label: string): string {
  const lower = label.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function textOf(node: MdNode): string {
  if (node.value) return node.value
  return (node.children ?? []).map(textOf).join('')
}

function walk(node: MdNode, visit: (n: MdNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function toCallout(quote: MdNode): void {
  const first = quote.children?.[0]
  const strong = first?.type === 'paragraph' ? first.children?.[0] : undefined
  if (!first || strong?.type !== 'strong') return
  const label = textOf(strong).trim()
  if (!LABELS.has(label)) return
  // Drop the label and the dash that follows it; the rest of the paragraph is the body.
  const rest = (first.children ?? []).slice(1)
  const lead = rest[0]
  if (lead?.type === 'text' && lead.value) lead.value = lead.value.replace(/^\s*[—–-]\s*/, '')
  first.children = rest
  quote.data = {
    hName: 'aside',
    hProperties: {
      className: ['guide-callout'],
      dataCallout: label.toLowerCase().replace(/\s+/g, '-'),
    },
  }
  quote.children = [
    {
      type: 'paragraph',
      data: { hName: 'div', hProperties: { className: ['guide-callout-label'] } },
      children: [{ type: 'text', value: calloutLabelText(label) }],
    },
    ...(quote.children ?? []),
  ]
}

export function remarkGuide(options: { pagePath: string; outline: readonly GuideOutlineItem[] }) {
  return (tree: MdNode) => {
    const ids = options.outline.map(o => o.id)
    let next = 0
    for (const node of tree.children ?? []) {
      if (node.type === 'heading' && (node.depth === 2 || node.depth === 3)) {
        const id = ids[next++]
        if (id) node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } }
      }
    }
    walk(tree, n => {
      if (n.type === 'blockquote') toCallout(n)
      else if (n.type === 'link' && n.url) n.url = guideLinkHref(n.url, options.pagePath)
      else if (n.type === 'image' && n.url) n.url = guideImageSrc(n.url)
    })
  }
}
