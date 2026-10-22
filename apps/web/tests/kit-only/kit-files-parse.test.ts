/**
 * Kit-only: the workflows THIS checkout carries parse with the dependency-free reader
 * `scripts/kit-check.mjs` uses (`scripts/lib/yaml-lite.mjs`). A copy's files are the app's to
 * change, so the readers' own tests (`kit-check-parsers.test.ts`) use inline
 * documents. Rocketpod has no tomls to parse (M6b).
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { parseYaml } from '../../../../scripts/lib/yaml-lite.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const WORKFLOWS = path.join(REPO_ROOT, '.github/workflows')

it('parses every workflow', () => {
  const files = readdirSync(WORKFLOWS).filter(f => f.endsWith('.yml'))
  expect(files).toContain('ci.yml')
  for (const f of files) {
    const doc = parseYaml(readFileSync(path.join(WORKFLOWS, f), 'utf8'))
    expect(doc.jobs && Object.keys(doc.jobs).length > 0, f).toBe(true)
  }
})
