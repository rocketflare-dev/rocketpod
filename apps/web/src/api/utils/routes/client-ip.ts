/**
 * The client's IP address, for rate-limit keys and the auth audit trail — one rule for every
 * caller (M2):
 *
 * - **Node entry** (`src/node/server.ts` puts the socket's peer on the request's execution
 *   context, `executionCtx.props.clientAddress` — not on the env, which is one object per process
 *   so `loadConfig` parses it once): with
 *   `TRUSTED_PROXY_HOPS = 0` (the default) the socket address IS the client and `X-Forwarded-For`
 *   is ignored — a client could write anything there. Behind N trusted proxies, each appends the
 *   address it saw, so the client is the Nth entry from the RIGHT; a header shorter than that
 *   falls back to the leftmost entry, then to the socket.
 * - **No socket address** (a bare `app.request` in a test): the first `X-Forwarded-For` entry.
 */
import type { AppContext } from '../../types'

export interface ClientIpInput {
  /** The socket peer, when the runtime knows it (the Node entry). */
  clientAddress?: string | null
  /** `TRUSTED_PROXY_HOPS`. */
  trustedProxyHops: number
  header(name: string): string | null | undefined
}

export function resolveClientIp(input: ClientIpInput): string | null {
  const forwarded = (input.header('x-forwarded-for') ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
  if (input.clientAddress !== undefined) {
    const socket = input.clientAddress || null
    if (input.trustedProxyHops <= 0 || forwarded.length === 0) return socket
    return forwarded[forwarded.length - input.trustedProxyHops] ?? forwarded[0] ?? socket
  }
  return forwarded[0] ?? null
}

/** The socket peer the runtime recorded for this request, if any (the Node entry does). */
function clientAddressOf(c: AppContext): string | undefined {
  try {
    const props = (c.executionCtx as { props?: { clientAddress?: unknown } }).props
    return typeof props?.clientAddress === 'string' ? props.clientAddress : undefined
  } catch {
    return undefined // no ExecutionContext (a bare `app.request` in a test)
  }
}

export function clientIpOf(c: AppContext): string | null {
  const address = clientAddressOf(c)
  return resolveClientIp({
    clientAddress: address,
    trustedProxyHops: c.get('config')?.TRUSTED_PROXY_HOPS ?? 0,
    header: name => c.req.header(name),
  })
}
