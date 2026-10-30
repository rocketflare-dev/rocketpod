/**
 * `tenant.purge`: delete what a deleted tenant left OUTSIDE Postgres.
 *
 * Inside Postgres the FK cascade from `tenantRef()` is the whole cleanup, and it is complete. It
 * reaches nothing else, though — stored objects under `tenants/<tenantId>/` would sit there for
 * the life of the bucket — so this job is the other half, and it is a QUEUE message rather than
 * best-effort work in the delete route for the same reason `agent_run_effects` exists: a durable
 * record with at-least-once delivery beats a `waitUntil` that a restarting replica can drop on the
 * floor.
 *
 * The tenant row is gone before the first delivery, so everything the purge needs is in the
 * payload; there is nothing left to look up.
 *
 * **Idempotent**: a second delivery lists an empty prefix and deletes nothing, and every plugin
 * hook promises the same, so a retry is free and a half-finished run resumes rather than restarts.
 */
import type { JobOf } from '@rocketpod/shared/jobs'
import { purgeTenantObjects } from '../../services/storage'
import { runTenantDeletedHooks } from '../../utils/db/tenant-helpers'
import type { JobContext } from '../jobs'

export async function handleTenantPurge(
  job: JobOf<'tenant.purge'>,
  ctx: JobContext
): Promise<void> {
  const { tenantId, tenantSlug } = job.payload

  // Plugins FIRST, and the order is a decision. A hook can never throw out of here (each is
  // try/caught), while the storage purge below can and is then retried — so running storage first
  // would let a transient storage outage delay every plugin's cleanup, and after
  // `JOBS_RETRY_LIMIT` retries skip it entirely. Both halves are idempotent, so a retry re-running
  // the hooks costs nothing.
  await runTenantDeletedHooks(ctx.db, tenantId, ctx.env, ctx.logger)

  const storage = ctx.platform.storage
  if (!storage) {
    // Permanent, so ACK rather than throw: no storage means no objects were ever written, and
    // no number of retries can conjure one. Deliberately the opposite of `document.convert`, which
    // throws on missing storage — there the bytes exist and are unreachable, which is data loss;
    // here their absence IS the answer.
    ctx.logger.warn(
      { tenantId, tenantSlug },
      'tenant.purge: no object storage configured, no stored objects to delete'
    )
    return
  }

  // A thrown storage error is RETRYABLE and is allowed to propagate: the alternative is a tenant's
  // files living on in the bucket for ever because one list call timed out.
  const deleted = await purgeTenantObjects(storage, tenantId)
  ctx.logger.info({ tenantId, tenantSlug, deleted }, 'tenant.purge: storage purged')
}
