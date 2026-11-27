/**
 * The `summarize-text` example's indexed-summary title (`summaryDocumentTitle`): what the summary
 * is stored, searched and cited under. Part of the example's surface — deleting the example
 * deletes this file.
 */
import { describe, expect, it } from 'vitest'
import {
  SUMMARY_TITLE_MAX_CHARS,
  summaryDocumentTitle,
} from '@/api/services/agents/examples/summarize-text'

describe("summarize-text: the indexed summary's title", () => {
  it('titles an indexed summary by its subject: the heading, else the first sentence, clipped at a word', () => {
    expect(summaryDocumentTitle('# Q3 carrier review\n\nNineteen joined.', 'x')).toBe(
      'Summary: Q3 carrier review'
    )
    expect(
      summaryDocumentTitle('Carrier onboarding review, Q3. Nineteen new carriers joined.', 'x')
    ).toBe('Summary: Carrier onboarding review, Q3')
    const long = summaryDocumentTitle(
      'This week marks the 25th anniversary of the Nintendo GameCube, the first console I ever bought with my own money.',
      'x'
    )
    expect(long).toBe(
      'Summary: This week marks the 25th anniversary of the Nintendo GameCube, the first…'
    )
    expect(long.length).toBeLessThanOrEqual('Summary: '.length + SUMMARY_TITLE_MAX_CHARS)
    // Never a timestamp: two summaries of different texts are told apart by name.
    expect(summaryDocumentTitle('**Bold** opening line', 'x')).toBe('Summary: Bold opening line')
  })
})
