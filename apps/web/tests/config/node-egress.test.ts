/**
 * `Platform.publicFetch` on Node (`src/node/egress.ts`): the fetch an MCP client's metadata
 * document is read through must never reach this machine or its network — not by an IP literal,
 * and not by a public-looking name that resolves (or rebinds) to a private address.
 */
import type { LookupAddress } from 'node:dns'
import { describe, expect, it } from 'vitest'
import { createPublicFetch, guardedLookup, isPublicAddress } from '@/node/egress'

const PRIVATE = [
  '127.0.0.1',
  '127.8.9.10',
  '10.1.2.3',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.1',
  '169.254.169.254',
  '100.64.0.1',
  '0.0.0.0',
  '224.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  '::ffff:127.0.0.1',
  'fc00::1',
  'fd12:3456::1',
  'fe80::1',
  '64:ff9b::7f00:1',
]

describe('isPublicAddress', () => {
  it('refuses loopback, private, link-local, CGNAT, unique-local and mapped addresses', () => {
    for (const address of PRIVATE) expect(isPublicAddress(address), address).toBe(false)
  })

  it('admits public addresses of both families', () => {
    for (const address of ['8.8.8.8', '172.32.0.1', '2606:4700:4700::1111']) {
      expect(isPublicAddress(address), address).toBe(true)
    }
  })
})

/** A resolver that answers `addresses` for every name. */
const answering =
  (...addresses: string[]) =>
  (
    _host: string,
    _options: unknown,
    callback: (err: NodeJS.ErrnoException | null, a: LookupAddress[]) => void
  ) =>
    callback(
      null,
      addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
    )

function lookupWith(resolve: ReturnType<typeof answering>, all = false) {
  return new Promise<{ err: Error | null; address: unknown }>(done =>
    guardedLookup(resolve)('docs.example.com', { all }, (err, address) => done({ err, address }))
  )
}

describe('the socket lookup', () => {
  it('refuses a public name that resolves to a private address', async () => {
    const { err } = await lookupWith(answering('10.0.0.5'))
    expect(err).toMatchObject({ code: 'ERR_EGRESS_REFUSED' })
  })

  it('refuses the name when ANY answer is private (a rebinding mix)', async () => {
    const { err } = await lookupWith(answering('8.8.8.8', '127.0.0.1'))
    expect(err).toMatchObject({ code: 'ERR_EGRESS_REFUSED' })
  })

  it('passes a wholly public answer through, in either lookup form', async () => {
    expect(await lookupWith(answering('8.8.8.8'))).toEqual({ err: null, address: '8.8.8.8' })
    const all = await lookupWith(answering('8.8.8.8', '2606:4700:4700::1111'), true)
    expect(all.err).toBeNull()
    expect(all.address).toHaveLength(2)
  })
})

describe('publicFetch', () => {
  const init = { method: 'GET' }

  it('never connects to a loopback or private IP literal', async () => {
    const fetch = createPublicFetch()
    for (const url of [
      'https://127.0.0.1/doc.json',
      'https://[::1]/doc.json',
      'https://10.0.0.1/x',
    ]) {
      await expect(fetch(url, init), url).rejects.toMatchObject({ code: 'ERR_EGRESS_REFUSED' })
    }
  })

  it('refuses a name that resolves to loopback, at connect time', async () => {
    const fetch = createPublicFetch({ resolve: answering('127.0.0.1') })
    await expect(fetch('https://client.example.com/doc.json', init)).rejects.toMatchObject({
      code: 'ERR_EGRESS_REFUSED',
    })
  })

  it('refuses a real lookup of localhost', async () => {
    await expect(createPublicFetch()('https://localhost/doc.json', init)).rejects.toMatchObject({
      code: 'ERR_EGRESS_REFUSED',
    })
  })

  it('is https and GET only', async () => {
    const fetch = createPublicFetch()
    await expect(fetch('http://client.example.com/doc.json', init)).rejects.toThrow(/https only/)
    await expect(fetch('https://client.example.com/doc.json', { method: 'POST' })).rejects.toThrow(
      /only GETs/
    )
  })
})
