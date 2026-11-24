/**
 * `Platform.publicFetch` on Node: a GET to a URL an anonymous party chose (an OAuth client's
 * metadata document, `api/services/mcp/cimd.ts`) that can never reach this machine or the network
 * it runs in.
 *
 * `cimd.ts` already refuses IP literals and private-looking names, but a public NAME can resolve to
 * a private address — on purpose, or by rebinding between a check and the connect. So the address
 * is judged where it is used: the socket's own `lookup` resolves the name, and if ANY answer is not
 * public the connection is never opened. An IP literal never reaches `lookup` (Node connects to it
 * directly), so it is judged up front. https only; redirects are returned, never followed.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { Readable } from 'node:stream'
import type { PublicFetch } from '../platform/types'

const BLOCKED_V4 = new BlockList()
const BLOCKED_V6 = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local: cloud metadata lives here
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
] as const) {
  BLOCKED_V4.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 embeds an IPv4 address
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED_V6.addSubnet(net, prefix, 'ipv6')
}

/** An address on the public internet (not loopback, private, link-local, reserved…). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  if (family === 4) return !BLOCKED_V4.check(address, 'ipv4')
  // IPv4-mapped (`::ffff:a.b.c.d`, or its hex form) is refused whole: no resolver hands one out
  // for a public name, and a BlockList would judge it against the IPv6 rules.
  if (/^::ffff:/i.test(address)) return false
  return !BLOCKED_V6.check(address, 'ipv6')
}

export class EgressRefusedError extends Error {
  readonly code = 'ERR_EGRESS_REFUSED'
  constructor(host: string) {
    super(`refused to connect to ${host}: it is not a public address`)
    this.name = 'EgressRefusedError'
  }
}

type Resolve = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void

type SocketLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number
  ) => void
) => void

/** A socket `lookup` that resolves through `resolve` and refuses the name if any answer is private. */
export function guardedLookup(resolve: Resolve = dnsLookup as unknown as Resolve): SocketLookup {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, [])
      const first = addresses[0]
      if (!first || addresses.some(a => !isPublicAddress(a.address))) {
        return callback(new EgressRefusedError(hostname), [])
      }
      if (options.all) return callback(null, addresses)
      callback(null, first.address, first.family)
    })
  }
}

export function createPublicFetch(options: { resolve?: Resolve } = {}): PublicFetch {
  const lookup = guardedLookup(options.resolve)
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input)
      if (url.protocol !== 'https:') return reject(new TypeError('publicFetch is https only'))
      const host = url.hostname.replace(/^\[|\]$/g, '')
      if (isIP(host) && !isPublicAddress(host)) return reject(new EgressRefusedError(host))
      const method = (init.method ?? 'GET').toUpperCase()
      if (method !== 'GET') return reject(new TypeError('publicFetch only GETs'))
      const req = httpsRequest(
        url,
        {
          method,
          headers: Object.fromEntries(new Headers(init.headers)),
          lookup,
          agent: false,
          signal: init.signal ?? undefined,
        },
        res => {
          const headers = new Headers()
          for (const [name, value] of Object.entries(res.headers)) {
            for (const one of [value ?? []].flat()) headers.append(name, one)
          }
          const status = res.statusCode ?? 502
          const body =
            status === 204 || status === 304
              ? null
              : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>)
          resolve(new Response(body, { status, headers }))
        }
      )
      req.on('error', reject)
      req.end()
    })
}
