/**
 * `scripts/release.mjs` stamps the version files. A file already AT the release version is
 * stamped as it is: a merge of an upstream kit's release tag brings the bump in before the
 * downstream release runs. Only a file with no version field to stamp is an error. Driven once
 * against a scratch kit, because which files it rewrites and its exit code are the behaviour.
 * The `kit-only` project: no database.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

const NOTE = `---
version: unreleased
previous: 0.46.0
date: null
breaking: false
migrations: []
areas: [tooling]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

A scratch kit releases a version its package.json already carries.

- One change.

## How to apply

1. Nothing to do.

## Conflicts to expect

None.

## Verify

1. \`pnpm gate\` passes.
`

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function scratchKit(packageVersion: string, packageJson?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'release-stamp-'))
  dirs.push(root)
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  write(
    'package.json',
    packageJson ?? `{\n  "name": "scratch-kit",\n  "version": "${packageVersion}"\n}\n`
  )
  write(
    '.rocketflare.json',
    `${JSON.stringify({ kit: { id: 'scratch-kit', version: '0.46.0' }, app: null }, null, 2)}\n`
  )
  write('docs/upgrades/unreleased.md', NOTE)
  write('docs/upgrades/0.46.0.md', NOTE.replace('version: unreleased', 'version: 0.46.0'))
  write('CHANGELOG.md', '# Changelog\n\n## 0.46.0 — 2026-11-28\n\nThe last release.\n')
  return root
}

const release = (root: string, version: string) => {
  const r = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'scripts/release.mjs'),
      version,
      '--repo-root',
      root,
      '--date',
      '2026-12-01',
    ],
    { encoding: 'utf8' }
  )
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('release.mjs version stamping', () => {
  it('releases a version the root package.json already carries', () => {
    const root = scratchKit('0.47.0')
    const r = release(root, '0.47.0')
    expect(r.code, r.out).toBe(0)
    expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version).toBe('0.47.0')
    const manifest = JSON.parse(readFileSync(path.join(root, '.rocketflare.json'), 'utf8'))
    expect(manifest.kit.version).toBe('0.47.0')
  })

  it('still refuses a version file with no version field to stamp', () => {
    const root = scratchKit('', '{\n  "name": "scratch-kit"\n}\n')
    const r = release(root, '0.47.0')
    expect(r.code).toBe(1)
    expect(r.out).toContain('could not find the version to stamp in package.json')
  })
})
