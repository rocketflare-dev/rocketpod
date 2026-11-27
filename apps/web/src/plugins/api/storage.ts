/**
 * `storage()` — the one body behind every plugin context's method of that name.
 *
 * Every context answers ONE TENANT's `StorageService` (docs/TENANT-ISOLATION.md, "The storage
 * fence"): the tenant contexts (`RequestCtx`, `EventCtx`, `ToolCtx`, `AgentCtx`) bind their own
 * `tenantId`, the background ones (`JobCtx`, `CronCtx`, `PublicCtx`) take it per call —
 * `storage(tenantId)`. A key outside `tenants/<tenantId>/` is refused before any network call, and
 * under `STORAGE_TENANT_FENCE=on` the calls sign with that tenant's own credentials. Keys are the
 * plugin's to build, under `tenants/<tenantId>/<plugin id>/…`: the tenant prefix is what the
 * `tenant.purge` job deletes.
 *
 * No object store on the platform is a 503 `storage_not_configured` — loud, because a silently
 * absent store loses bytes. A missing tenant id throws (`StorageTenantRequiredError`): fail closed.
 */

import type { StorageService } from '../../api/services/storage'
import { ServiceUnavailableError } from '../../api/utils/core/errors'
import type { Platform } from '../../platform/types'

export function filesStorage(
  platform: Pick<Platform, 'storage'>,
  tenantId: string
): StorageService {
  if (!platform.storage) {
    throw new ServiceUnavailableError('File storage is not configured', 'storage_not_configured')
  }
  return platform.storage.forTenant(tenantId)
}
