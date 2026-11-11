/**
 * Text that is about to be stored in Postgres.
 *
 * Postgres refuses a NUL anywhere in a `text` value (22021 `character_not_in_repertoire`) and a
 * `\u0000` inside `jsonb` (22P05), and real documents carry them: some PDFs come back from
 * `AI.toMarkdown` with NULs in the text, and a span's recorded content is that same text again.
 * One NUL fails the whole insert, so a converted PDF never indexes and a run's spans are lost.
 *
 * So every write of converted or model-facing text strips the C0 control characters first —
 * everything below U+0020 except tab, line feed and carriage return, which are whitespace a
 * reader expects to keep. They carry no meaning in indexed prose, and dropping them is the only
 * repair that never fails.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

/** `text` without NUL and the other C0 control characters; `\t`, `\n` and `\r` are kept. */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, '')
}

/**
 * `stripControlChars` over every string in a JSON-shaped value — object keys included — for a
 * `jsonb` column. Anything that is not a string, an array or a plain object comes back unchanged.
 */
export function stripControlCharsDeep<T>(value: T): T {
  if (typeof value === 'string') return stripControlChars(value) as T
  if (Array.isArray(value)) return value.map(item => stripControlCharsDeep(item)) as T
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[stripControlChars(key)] = stripControlCharsDeep(item)
    }
    return out as T
  }
  return value
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
