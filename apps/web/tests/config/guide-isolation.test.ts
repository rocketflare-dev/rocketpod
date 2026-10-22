/**
 * The Guide's isolation guarantee, by construction: a MODEL reaches `guide_chunks` only through
 * `search_guide`, and only the guide route builds that tool. A source scan (tracked AND untracked
 * files, so a new caller fails the moment it is written): if anything else starts importing the
 * tool, the retrieval, the audience rule or the table, this fails — main chat, agents and the
 * knowledge tools must never read the Guide (`tests/api/guide.test.ts` holds the behavioural half).
 * The table is global, so a second reader is also a second place that must apply the audience.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WEB_ROOT } from '../helpers/source-files'

function sources(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src'],
    { cwd: WEB_ROOT, encoding: 'utf8' }
  )
    .split('\n')
    .filter(f => /\.tsx?$/.test(f) && existsSync(path.join(WEB_ROOT, f)))
}

/** Files under `src/` whose code (comments stripped) names `symbol` as an identifier. */
function filesNaming(symbol: string): string[] {
  const word = new RegExp(`\\b${symbol}\\b`)
  return sources()
    .filter(f => {
      const code = readFileSync(path.join(WEB_ROOT, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      return word.test(code)
    })
    .sort()
}

describe('the Guide is reachable by a model only through the guide route', () => {
  it('only the guide route builds the search_guide tool', () => {
    expect(filesNaming('createGuideTools')).toEqual([
      'src/api/routes/guide.ts',
      'src/api/services/guide-tools.ts',
    ])
  })

  it('only the tool runs Guide retrieval', () => {
    expect(filesNaming('retrieveGuide')).toEqual([
      'src/api/services/guide-kb.ts',
      'src/api/services/guide-tools.ts',
    ])
  })

  it('only the Guide route resolves a Guide audience', () => {
    expect(filesNaming('guideAudienceFor')).toEqual([
      'src/api/routes/guide.ts',
      'src/api/services/guide-kb.ts',
    ])
  })

  it('only the Guide services and the schema touch guide_chunks', () => {
    expect(filesNaming('guideChunks')).toEqual([
      'src/api/services/guide-kb.ts',
      'src/db/schema/guide-chunks.ts',
    ])
  })
})
