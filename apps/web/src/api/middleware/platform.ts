/**
 * `c.set('platform')` (M1): the runtime's capabilities for this request — the prebuilt
 * `env.PLATFORM` an entry point handed in, else the Worker's bindings adapted on the spot
 * (`src/platform/index.ts`). Routes, services and later middleware read it; none of them reads a
 * binding from `c.env`.
 */
import { createMiddleware } from 'hono/factory'
import { resolvePlatform } from '../../platform'
import type { AppEnv } from '../types'

export const platformMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  c.set('platform', resolvePlatform(c.env))
  await next()
})
