/**
 * `c.set('platform')`: the runtime's capabilities for this request — the prebuilt
 * `env.PLATFORM` the entry point handed in (`src/node/platform.ts`), else `EMPTY_PLATFORM`
 * (`src/platform/index.ts`). Routes, services and later middleware read it; none of them reads a
 * capability from `c.env`.
 */
import { createMiddleware } from 'hono/factory'
import { resolvePlatform } from '../../platform'
import type { AppEnv } from '../types'

export const platformMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  c.set('platform', resolvePlatform(c.env))
  await next()
})
