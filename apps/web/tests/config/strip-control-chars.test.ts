/**
 * `stripControlChars` (utils/core/text): NUL and the other C0 controls go, tab / LF / CR stay —
 * Postgres refuses a NUL in `text` (22021) and in `jsonb` (22P05), so converted text and span
 * content are cleaned before every write.
 */
import { describe, expect, it } from 'vitest'
import { stripControlChars, stripControlCharsDeep } from '@/api/utils/core/text'

describe('stripControlChars', () => {
  it('removes NUL and C0 controls, keeps tab, line feed and carriage return', () => {
    expect(stripControlChars('a\u0000b\u0001c\u0008d\u000Be\u000Cf\u000Eg\u001Fh')).toBe('abcdefgh')
    expect(stripControlChars('tab\there\r\nnext')).toBe('tab\there\r\nnext')
    expect(stripControlChars('café — ünïcode\u007F')).toBe('café — ünïcode\u007F')
  })

  it('walks a JSON-shaped value, keys included, leaving non-strings alone', () => {
    const date = new Date(0)
    expect(
      stripControlCharsDeep({
        'k\u0000': ['x\u0000y', 1, null, true],
        nested: { v: 'a\u0002' },
        date,
      })
    ).toEqual({ k: ['xy', 1, null, true], nested: { v: 'a' }, date })
    expect(stripControlCharsDeep('\u0000')).toBe('')
    expect(stripControlCharsDeep(42)).toBe(42)
  })
})
