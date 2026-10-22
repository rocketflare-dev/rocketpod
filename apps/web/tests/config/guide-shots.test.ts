/**
 * `pnpm web guide:shots` — the pure rules (`scripts/lib/guide-shots.ts`): the manifest, route
 * placeholders, which shots are stale, and when a fresh shot is different enough to rewrite.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import {
  compareShots,
  MANIFEST_PATH,
  parseManifest,
  resolveRoute,
  routePlaceholders,
  staleEntries,
} from '../../scripts/lib/guide-shots'
import { WEB_ROOT } from '../helpers/source-files'

function png(width: number, height: number, paint: (x: number, y: number) => number): Buffer {
  const img = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const v = paint(x, y)
      img.data[i] = v
      img.data[i + 1] = v
      img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  }
  return PNG.sync.write(img)
}

describe('the manifest', () => {
  it('the committed manifest parses', () => {
    const file = path.resolve(WEB_ROOT, '../..', MANIFEST_PATH)
    expect(() => parseManifest(readFileSync(file, 'utf8'))).not.toThrow()
  })

  it('applies defaults and rejects duplicates and unknown fields', () => {
    const [entry] = parseManifest(
      'shots:\n  - id: a-shot\n    route: /x\n    sources: [apps/web/src/ui/**]\n'
    )
    expect(entry).toMatchObject({
      theme: 'light',
      viewport: { width: 1440, height: 900 },
      steps: [],
    })
    const dup =
      'shots:\n  - {id: a, route: /x, sources: [s]}\n  - {id: a, route: /y, sources: [s]}\n'
    expect(() => parseManifest(dup)).toThrow(/duplicate/)
    expect(() => parseManifest('shots:\n  - {id: a, route: /x, sources: [s], zoom: 2}\n')).toThrow()
  })

  it('fills placeholders from the looked-up values, and refuses an unknown one or one it cannot fill', () => {
    expect(resolveRoute('/projects/{project}?tab=a', { project: 'p 1' })).toBe(
      '/projects/p%201?tab=a'
    )
    expect(() => resolveRoute('/x/{nope}', { project: 'p' })).toThrow(/nope.*routeValues/)
    expect(() => resolveRoute('/projects/{project}', { project: null })).toThrow(/has none/)
    expect(resolveRoute('/settings?tab=people', {})).toBe('/settings?tab=people')
    const entries = parseManifest(
      'shots:\n  - {id: a, route: "/p/{project}/{doc}", sources: [s]}\n  - {id: b, route: "/q/{project}", sources: [s]}\n'
    )
    expect(routePlaceholders(entries)).toEqual(['doc', 'project'])
  })
})

describe('staleness and comparison', () => {
  it('picks never-committed images and those whose sources moved since their commit', () => {
    const entries = parseManifest(
      'shots:\n  - {id: a, route: /a, sources: [src/ui/a/**]}\n  - {id: b, route: /b, sources: [src/ui/b/**]}\n  - {id: c, route: /c, sources: [src/ui/c/**]}\n'
    )
    const stale = staleEntries(entries, {
      lastCommitOf: f => (f.endsWith('/c.png') ? null : 'sha'),
      changedSince: () => ['src/ui/a/Board.tsx', 'src/api/x.ts'],
    })
    expect(stale.map(e => e.id)).toEqual(['a', 'c'])
  })

  it('a few wobbling pixels are unchanged; a new, resized or moved image is changed', () => {
    const base = png(100, 100, () => 200)
    expect(compareShots(null, base).reason).toBe('new')
    expect(
      compareShots(
        base,
        png(100, 101, () => 200)
      ).reason
    ).toBe('size')
    expect(
      compareShots(
        base,
        png(100, 100, (x, y) => (x === 0 && y === 0 ? 0 : 200))
      ).changed
    ).toBe(false)
    expect(
      compareShots(
        base,
        png(100, 100, (_x, y) => (y < 10 ? 0 : 200))
      )
    ).toMatchObject({
      changed: true,
      reason: 'pixels',
    })
  })
})
