/**
 * `storage()` — the one body behind every plugin context's method of that name.
 *
 * `RequestCtx` and the background contexts (`JobCtx`, `CronCtx`, `PublicCtx`) all answer the same
 * `StorageService` — the platform's object store — so a plugin's own service function that takes
 * a `StorageService` is callable from any of them. Keys are the plugin's to build, under
 * `tenants/<tenantId>/<plugin id>/…`: the tenant prefix is what the `tenant.purge` job deletes,
 * so an object anywhere else outlives its organisation.
 *
 * No object store on the platform is a 503 `storage_not_configured` — loud, because a silently
 * absent store loses bytes.
 */

import type { StorageService } from '../../api/services/storage'
import { ServiceUnavailableError } from '../../api/utils/core/errors'
import type { Platform } from '../../platform/types'

export function filesStorage(platform: Pick<Platform, 'storage'>): StorageService {
  if (!platform.storage) {
    throw new ServiceUnavailableError('File storage is not configured', 'storage_not_configured')
  }
  return platform.storage
}
