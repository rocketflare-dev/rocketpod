/**
 * The Node platform's `DocumentConverter` (M6) — what Workers AI's `toMarkdown` does on the Worker,
 * for the upload types the Node server can read with plain libraries:
 *
 * | Type | How | Answers |
 * |---|---|---|
 * | PDF | `unpdf` (PDF.js), text per page | `text`, pages separated by a blank line |
 * | Word (.docx) | `mammoth` → markdown | `markdown` |
 * | HTML | tags stripped, block elements kept as line breaks | `text` |
 * | XML, text-like | decoded as UTF-8 | `text` |
 *
 * Excel and OpenDocument are NOT converted here: they answer `format: 'error'`, which
 * `document.convert` records as a permanent failure with this message. The type comes from the
 * blob (`document.convert` sets it from the resolved upload type), the extension as a fallback.
 * `tokens` is the usual ~4-characters-per-token estimate; nothing bills on it.
 */
import { resolveDocumentUploadType } from '@rocketpod/shared/ai/embeddings'
import mammoth from 'mammoth'
import { extractText } from 'unpdf'
import type { DocumentConverter, MarkdownConversion } from '../platform/types'

const estimateTokens = (text: string) => Math.ceil(text.length / 4)

/** `convertToMarkdown` exists in mammoth (deprecated upstream, still shipped) but not in its types. */
type MammothMarkdown = (input: { buffer: Buffer }) => Promise<{ value: string }>

const BLOCK_TAGS =
  /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|pre)\b[^>]*>/gi

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** Readable text from HTML: no scripts or styles, block boundaries as newlines, entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(BLOCK_TAGS, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith('#x') || name.startsWith('#X'))
        return String.fromCodePoint(Number.parseInt(name.slice(2), 16))
      if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10))
      return ENTITIES[name.toLowerCase()] ?? whole
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function ok(
  name: string,
  mimeType: string,
  format: 'markdown' | 'text',
  data: string
): MarkdownConversion {
  return { name, mimeType, format, tokens: estimateTokens(data), data }
}

export function createNodeConverter(): DocumentConverter {
  return async ({ name, blob }) => {
    const mimeType = resolveDocumentUploadType(name, blob.type)?.contentType ?? blob.type
    try {
      switch (mimeType) {
        case 'application/pdf': {
          const { text } = await extractText(new Uint8Array(await blob.arrayBuffer()), {
            mergePages: false,
          })
          return ok(
            name,
            mimeType,
            'text',
            text
              .map(page => page.trim())
              .join('\n\n')
              .trim()
          )
        }
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
          const toMarkdown = (mammoth as unknown as { convertToMarkdown: MammothMarkdown })
            .convertToMarkdown
          const { value } = await toMarkdown({ buffer: Buffer.from(await blob.arrayBuffer()) })
          return ok(name, mimeType, 'markdown', value.trim())
        }
        case 'text/html':
          return ok(name, mimeType, 'text', htmlToText(await blob.text()))
        case 'application/xml':
        case 'text/plain':
        case 'text/markdown':
        case 'text/csv':
        case 'application/json':
          return ok(name, mimeType, 'text', await blob.text())
        default:
          return {
            name,
            mimeType,
            format: 'error',
            error: `${mimeType || 'this file type'} cannot be converted on this server (PDF, Word, HTML, XML and text can)`,
          }
      }
    } catch (err) {
      // A file the library cannot parse is corrupt or unsupported: permanent, like Workers AI's
      // `format: 'error'`, rather than a transient throw the queue would retry three times.
      return {
        name,
        mimeType,
        format: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
