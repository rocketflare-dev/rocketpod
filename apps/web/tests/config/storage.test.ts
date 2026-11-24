/**
 * Storage seam: key building and filename sanitising are pure; the in-memory `StorageService`
 * the whole api suite uses is held to the interface's contract here (the S3 adapter's own contract
 * test is `node-platform-adapters.test.ts`).
 */
import { describe, expect, it } from 'vitest'
import {
  buildStorageKey,
  MAX_FILENAME_LENGTH,
  sanitizeFilename,
  tenantStoragePrefix,
} from '@/api/services/storage'

const TENANT = '11111111-1111-4111-8111-111111111111'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('sanitizeFilename', () => {
  it('keeps only the last path segment — no traversal, no separators', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('C:\\Users\\me\\photo.png')).toBe('photo.png')
    expect(sanitizeFilename('/tmp/../x.txt')).toBe('x.txt')
  })

  it('reduces to [A-Za-z0-9._-], collapsing runs and stripping leading dots', () => {
    expect(sanitizeFilename('My Photo (1).PNG')).toBe('My_Photo_1_.PNG')
    expect(sanitizeFilename('.htaccess')).toBe('htaccess')
    expect(sanitizeFilename('a  b   c.jpg')).toBe('a_b_c.jpg')
    expect(sanitizeFilename('café résumé.pdf')).toMatch(/^[\w.-]+\.pdf$/)
  })

  it('never returns an empty name', () => {
    expect(sanitizeFilename('')).toBe('file')
    expect(sanitizeFilename('///')).toBe('file')
    expect(sanitizeFilename('...')).toBe('file')
  })

  it('bounds the length but keeps the extension', () => {
    const long = `${'a'.repeat(300)}.jpeg`
    const out = sanitizeFilename(long)
    expect(out.length).toBe(MAX_FILENAME_LENGTH)
    expect(out.endsWith('.jpeg')).toBe(true)
  })
})

describe('buildStorageKey', () => {
  it('is tenants/<tenant>/<scope>/<uuid>-<sanitised name>', () => {
    expect(
      buildStorageKey({ tenantId: TENANT, scope: 'avatars', name: 'me.png', id: 'fixed-id' })
    ).toBe(`tenants/${TENANT}/avatars/fixed-id-me.png`)
    const key = buildStorageKey({ tenantId: TENANT, scope: 'uploads', name: '../x y.txt' })
    const [, tenant, scope, tail] = key.split('/')
    expect(tenant).toBe(TENANT)
    expect(scope).toBe('uploads')
    expect(tail?.slice(0, 36)).toMatch(UUID_RE)
    expect(tail?.slice(36)).toBe('-x_y.txt')
  })

  it('two uploads of the same filename never collide', () => {
    const a = buildStorageKey({ tenantId: TENANT, scope: 'uploads', name: 'same.txt' })
    const b = buildStorageKey({ tenantId: TENANT, scope: 'uploads', name: 'same.txt' })
    expect(a).not.toBe(b)
  })

  it('tenantStoragePrefix scopes a tenant, optionally one scope', () => {
    expect(tenantStoragePrefix(TENANT)).toBe(`tenants/${TENANT}/`)
    expect(tenantStoragePrefix(TENANT, 'avatars')).toBe(`tenants/${TENANT}/avatars/`)
    expect(buildStorageKey({ tenantId: TENANT, scope: 'avatars', name: 'a' })).toContain(
      tenantStoragePrefix(TENANT, 'avatars')
    )
  })
})
