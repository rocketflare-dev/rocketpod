/**
 * `resolveClientIp` (`src/api/utils/routes/client-ip.ts`), the one rule for a client's address:
 * the socket unless trusted proxies are declared; the first X-Forwarded-For entry when the runtime
 * knows no socket (a bare `app.request`). `cf-connecting-ip` is never read (M6b).
 */
import { describe, expect, it } from 'vitest'
import { resolveClientIp } from '@/api/utils/routes/client-ip'

const headers =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name.toLowerCase()]

describe('resolveClientIp', () => {
  it('Node, no trusted proxy: the socket, and X-Forwarded-For is ignored (a client writes it)', () => {
    expect(
      resolveClientIp({
        clientAddress: '203.0.113.9',
        trustedProxyHops: 0,
        header: headers({ 'x-forwarded-for': '1.1.1.1' }),
      })
    ).toBe('203.0.113.9')
  })

  it('Node behind N proxies: the Nth entry from the right', () => {
    const header = headers({ 'x-forwarded-for': 'spoofed, 198.51.100.7, 10.0.0.2' })
    expect(resolveClientIp({ clientAddress: '10.0.0.3', trustedProxyHops: 1, header })).toBe(
      '10.0.0.2'
    )
    expect(resolveClientIp({ clientAddress: '10.0.0.3', trustedProxyHops: 2, header })).toBe(
      '198.51.100.7'
    )
  })

  it('Node: a header shorter than the hops falls back to its leftmost entry, then the socket', () => {
    expect(
      resolveClientIp({
        clientAddress: '10.0.0.3',
        trustedProxyHops: 3,
        header: headers({ 'x-forwarded-for': '198.51.100.7' }),
      })
    ).toBe('198.51.100.7')
    expect(
      resolveClientIp({ clientAddress: '10.0.0.3', trustedProxyHops: 2, header: headers({}) })
    ).toBe('10.0.0.3')
    expect(resolveClientIp({ clientAddress: '', trustedProxyHops: 0, header: headers({}) })).toBe(
      null
    )
  })

  it('no socket address: the first X-Forwarded-For entry, and never cf-connecting-ip', () => {
    expect(
      resolveClientIp({
        trustedProxyHops: 0,
        header: headers({ 'cf-connecting-ip': '2.2.2.2', 'x-forwarded-for': '1.1.1.1' }),
      })
    ).toBe('1.1.1.1')
    expect(
      resolveClientIp({ trustedProxyHops: 0, header: headers({ 'cf-connecting-ip': '2.2.2.2' }) })
    ).toBe(null)
    expect(
      resolveClientIp({
        trustedProxyHops: 0,
        header: headers({ 'x-forwarded-for': '1.1.1.1, 9.9.9.9' }),
      })
    ).toBe('1.1.1.1')
    expect(resolveClientIp({ trustedProxyHops: 0, header: headers({}) })).toBe(null)
  })
})
