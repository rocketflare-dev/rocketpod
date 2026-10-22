import { describe, expect, it } from 'vitest'
import {
  hostKitVersion,
  MANIFEST_FILE,
  mergeSidecar,
  pluginSurfaces,
  readManifest,
} from '../../../../scripts/lib/manifest.mjs'
import { KIT } from '../../../../scripts/lib/rename-lib.mjs'
import type { Manifest, Surface } from '../../../../scripts/lib/upgrade-lib.d.mts'

const surface = (id: string, kind: Surface['kind'] = 'plugin'): Surface => ({
  id,
  kind,
  label: id,
  anchor: `apps/web/src/plugins/${id}/plugin.json`,
  paths: [`apps/web/src/plugins/${id}/**`],
  registries: ['apps/web/src/plugins/server.ts'],
})

const base = {
  $purpose: 'x',
  $doNotDelete: 'y',
  kit: { name: KIT.slug, repo: 'r', version: '0.5.0', commit: null },
  app: null,
  history: [],
  surfaces: [surface('feature-chat', 'optional-feature')],
  neverPort: [],
  manual: [],
  core: [],
} satisfies Manifest

describe('mergeSidecar', () => {
  it('is the manifest itself when there is no sidecar', () => {
    expect(mergeSidecar(base, null)).toBe(base)
    expect(mergeSidecar(base, { surfaces: [] })).toBe(base)
  })

  it('appends the sidecar surfaces without touching anything else', () => {
    const merged = mergeSidecar(base, { surfaces: [surface('analytics')] })
    expect(merged?.surfaces.map(s => s.id)).toEqual(['feature-chat', 'analytics'])
    expect(merged?.kit).toEqual(base.kit)
    expect(merged?.app).toBeNull()
    // The committed manifest is not mutated — a writer reads it back to write it out.
    expect(base.surfaces).toHaveLength(1)
  })

  it('lets a local entry replace a committed one of the same id', () => {
    const local = { ...surface('feature-chat', 'plugin'), label: 'local copy' }
    const merged = mergeSidecar(base, { surfaces: [local] })
    expect(merged?.surfaces).toHaveLength(1)
    expect(merged?.surfaces[0]?.label).toBe('local copy')
  })

  it('survives a missing manifest', () => {
    expect(mergeSidecar(null, { surfaces: [surface('analytics')] })).toBeNull()
  })
})

describe('pluginSurfaces', () => {
  it('is only the plugin kind', () => {
    const merged = mergeSidecar(base, { surfaces: [surface('analytics')] })
    expect(pluginSurfaces(merged).map(s => s.id)).toEqual(['analytics'])
    expect(pluginSurfaces(null)).toEqual([])
  })
})

describe('readManifest', () => {
  it('is honest about a directory that has no manifest at all', () => {
    const { manifest, isKit, sidecar } = readManifest('/')
    expect(manifest).toBeNull()
    expect(sidecar).toBeNull()
    // Not the kit: an unknown state is not a licence to behave like it.
    expect(isKit).toBe(false)
  })
})

describe('hostKitVersion', () => {
  const copy: Manifest = {
    ...base,
    app: { slug: 'demo-app', display: 'Demo App', domain: 'x.dev' },
  }

  it('is kit.version in a copy, whose package.json carries the app version', () => {
    const manifest = { ...copy, kit: { ...copy.kit, version: '0.17.6' } }
    expect(hostKitVersion({ manifest, isKit: false }, '0.1.0')).toBe('0.17.6')
  })

  it('throws, naming the file, for a copy with no kit.version — never falls back to the app version', () => {
    const manifest = { ...copy, kit: { ...copy.kit, version: undefined } } as unknown as Manifest
    expect(() => hostKitVersion({ manifest, isKit: false }, '0.1.0')).toThrow(
      `${MANIFEST_FILE} has no kit.version`
    )
    expect(() => hostKitVersion({ manifest: null, isKit: false }, '0.1.0')).toThrow(/not found/)
  })
})
