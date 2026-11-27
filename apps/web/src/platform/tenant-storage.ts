/**
 * The key half of the storage fence (docs/TENANT-ISOLATION.md): a tenant's `StorageService`
 * refuses every key and prefix outside `tenants/<tenantId>/` with `StorageTenantMismatchError`,
 * before any network call, whatever the credentials underneath. The adapter decides those
 * (`src/node/storage.ts`: the process's own, or the tenant's STS session); this decides the keys.
 *
 * Runtime-neutral: the Node adapter and the tests' in-memory bucket wrap their store the same way.
 */
import {
  type StorageService,
  StorageTenantMismatchError,
  StorageTenantRequiredError,
  type TenantStorageFactory,
} from './types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The tenant id, checked: a UUID or `StorageTenantRequiredError`. A UUID also cannot widen the
 * credentials it selects: no `*`, `?` or `/` reaches the session tag an IAM policy interpolates.
 */
export function requireTenantId(tenantId: unknown): string {
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
    throw new StorageTenantRequiredError(tenantId)
  }
  return tenantId
}

/** `tenants/<tenantId>/`: the one prefix a tenant's objects live under. */
export function tenantPrefix(tenantId: string): string {
  return `tenants/${tenantId}/`
}

/** `storage` restricted to `tenantId`'s prefix. Async, so a refused key is a rejected promise. */
export function fenceToTenant(storage: StorageService, tenantId: string): StorageService {
  const id = requireTenantId(tenantId)
  const prefix = tenantPrefix(id)
  const check = (key: string): string => {
    if (!key.startsWith(prefix) || key.split('/').includes('..')) {
      throw new StorageTenantMismatchError(id, key)
    }
    return key
  }
  return Object.freeze({
    put: async (key, body, options) => storage.put(check(key), body, options),
    putStream: async (key, body, options) => storage.putStream(check(key), body, options),
    get: async (key, options) => storage.get(check(key), options),
    head: async key => storage.head(check(key)),
    delete: async key => storage.delete(check(key)),
    deleteMany: async keys => storage.deleteMany(keys.map(check)),
    listPage: async (p, options) => storage.listPage(check(p), options),
    list: async p => storage.list(check(p)),
  } satisfies StorageService)
}

/** Every tenant over ONE store and its credentials, behind the prefix check (`fence=off`). */
export function tenantStorageOver(storage: StorageService): TenantStorageFactory {
  return { forTenant: tenantId => fenceToTenant(storage, tenantId) }
}
