/**
 * Where the app gets its `Platform`: the entry point builds one (`src/node/platform.ts`) and hands
 * it in as `env.PLATFORM`; a bare env (a script, a unit test) gets `EMPTY_PLATFORM`, whose null
 * members are the "not configured" state every caller already answers for.
 */
import { EMPTY_PLATFORM, type Platform } from './types'

export type * from './types'
export { EMPTY_PLATFORM } from './types'

/** The runtime env as the app sees it: vars and secrets by name, plus the prebuilt platform. */
export interface PlatformEnv {
  PLATFORM?: Platform
}

export function resolvePlatform(env: object | undefined): Platform {
  return (env as PlatformEnv | undefined)?.PLATFORM ?? EMPTY_PLATFORM
}
