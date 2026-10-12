/**
 * Where the app gets its `Platform` (M1). An entry point that builds one itself hands it in as
 * `env.PLATFORM`; otherwise the Worker's bindings are adapted on the spot. The Cloudflare fallback
 * goes when the Node entry replaces `src/worker.ts` (M2).
 */
import { createCloudflarePlatform } from './cloudflare'
import type { Platform } from './types'

export type * from './types'
export { EMPTY_PLATFORM } from './types'

/** The runtime env as the app sees it: vars and secrets by name, plus an optional prebuilt platform. */
export interface PlatformEnv {
  PLATFORM?: Platform
}

export function resolvePlatform(env: object | undefined): Platform {
  const given = (env as PlatformEnv | undefined)?.PLATFORM
  if (given) return given
  return createCloudflarePlatform((env ?? {}) as Parameters<typeof createCloudflarePlatform>[0])
}
