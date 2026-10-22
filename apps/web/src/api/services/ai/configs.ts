/**
 * A tenant's AI provider rows (D17) — the ONE write path for `ai_configs`, behind `/api/ai/config`
 * and anything else that manages a tenant's providers (an admin screen for another tenant, a seed).
 * One implementation, so no two callers can disagree on what a valid row is or on how a credential
 * is kept:
 *
 * - credentials are encrypted on the way in and NEVER come back out (`toAiConfig` →
 *   `hasCredential` only);
 * - an upsert keys on (tenant, scope, label); omitting `apiKey` on a re-save keeps the stored key,
 *   and a provider change without a new key drops it (a key belongs to the provider it was entered
 *   for);
 * - `isDefault` swaps the scope's default inside the transaction (clear-others-then-set — the
 *   partial unique index rejects the reverse order), and the first row in a scope is always made
 *   default.
 *
 * Every function takes the tenant id from its CALLER — the auth context, or the tenant a global
 * admin is managing — and every query carries it.
 */
import type { AiConfig, AiScope, UpsertAiConfigRequest } from '@rocketpod/shared/ai/config'
import { modelTraits } from '@rocketpod/shared/ai/models'
import { and, asc, eq, ne } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type AiConfigRow, aiConfigs } from '../../../db/schema'
import { encrypt, requireEncryptionKey } from '../../auth/oauth-encryption'
import { BadRequestError } from '../../utils/core/errors'
import { providerInfo, providerSupportsScope } from './providers'

export function toAiConfig(row: AiConfigRow): AiConfig {
  return {
    id: row.id,
    tenantId: row.tenantId,
    scope: row.scope,
    provider: row.provider,
    label: row.label,
    baseUrl: row.baseUrl,
    model: row.model,
    isDefault: row.isDefault,
    hasCredential: row.apiKeyEnc !== null,
    thinking: row.thinking,
    serviceTier: row.serviceTier,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Provider × scope × field rules the contract alone cannot express. */
export function validateAiConfigUpsert(
  body: UpsertAiConfigRequest,
  existing: AiConfigRow | undefined
): void {
  const info = providerInfo(body.provider)
  if (!providerSupportsScope(body.provider, body.scope)) {
    throw new BadRequestError(
      `${info.name} has no ${body.scope} adapter`,
      'provider_scope_unsupported'
    )
  }
  if (info.needsBaseUrl && !body.baseUrl) {
    throw new BadRequestError(`${info.name} requires a base URL`, 'base_url_required')
  }
  // A key is required unless the row already holds one FOR THE SAME PROVIDER (a stored credential
  // belongs to the provider it was entered for and will not authenticate elsewhere).
  const keepsKey = existing?.apiKeyEnc && existing.provider === body.provider
  if (info.needsApiKey && !body.apiKey && !keepsKey) {
    throw new BadRequestError(`${info.name} requires an API key`, 'api_key_required')
  }
  // What thinking means is per MODEL (`@rocketpod/shared/ai/models`): a budget only where the
  // model takes one (Claude ≤ 4.5, compatible vendors); adaptive and effort models take a switch.
  const traits = modelTraits(body.provider, body.model)
  if (body.thinking?.enabled && (!info.supportsThinking || traits.thinking === 'none')) {
    throw new BadRequestError(
      `${info.name} · ${body.model} has no thinking control`,
      'thinking_unsupported'
    )
  }
  if (body.thinking?.enabled && traits.thinking === 'extended' && !body.thinking.budgetTokens) {
    throw new BadRequestError(
      'Enabling thinking needs a budgetTokens value',
      'thinking_budget_required'
    )
  }
  if (body.serviceTier && !info.supportsServiceTier) {
    throw new BadRequestError(
      `${info.name} does not offer service tiers`,
      'service_tier_unsupported'
    )
  }
}

/** Make `id` the sole default for its scope. Clears the others FIRST (partial unique index). */
async function makeDefault(
  tx: Database,
  tenantId: string,
  scope: AiScope,
  id: string
): Promise<void> {
  await tx
    .update(aiConfigs)
    .set({ isDefault: false })
    .where(and(eq(aiConfigs.tenantId, tenantId), eq(aiConfigs.scope, scope), ne(aiConfigs.id, id)))
  await tx
    .update(aiConfigs)
    .set({ isDefault: true })
    .where(and(eq(aiConfigs.tenantId, tenantId), eq(aiConfigs.id, id)))
}

async function hasDefault(tx: Database, tenantId: string, scope: AiScope): Promise<boolean> {
  const row = await tx.query.aiConfigs.findFirst({
    columns: { id: true },
    where: and(
      eq(aiConfigs.tenantId, tenantId),
      eq(aiConfigs.scope, scope),
      eq(aiConfigs.isDefault, true)
    ),
  })
  return Boolean(row)
}

/** The tenant's rows, by scope then label; `scope` narrows to one. */
export async function listAiConfigs(
  db: Database,
  tenantId: string,
  scope?: AiScope
): Promise<AiConfigRow[]> {
  return db
    .select()
    .from(aiConfigs)
    .where(
      scope
        ? and(eq(aiConfigs.tenantId, tenantId), eq(aiConfigs.scope, scope))
        : eq(aiConfigs.tenantId, tenantId)
    )
    .orderBy(asc(aiConfigs.scope), asc(aiConfigs.label))
}

export interface UpsertedAiConfig {
  row: AiConfigRow
  /** False when an existing (scope, label) row was updated. */
  created: boolean
}

/** Validate, encrypt the key if one was given, and upsert on (tenant, scope, label). */
export async function upsertAiConfig(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  body: UpsertAiConfigRequest
): Promise<UpsertedAiConfig> {
  const existing = await db.query.aiConfigs.findFirst({
    where: and(
      eq(aiConfigs.tenantId, tenantId),
      eq(aiConfigs.scope, body.scope),
      eq(aiConfigs.label, body.label)
    ),
  })
  validateAiConfigUpsert(body, existing)
  const apiKeyEnc = body.apiKey ? await encrypt(body.apiKey, requireEncryptionKey(cfg)) : undefined
  // A provider change without a new key must not carry the old provider's credential along.
  const dropKey = !body.apiKey && existing && existing.provider !== body.provider

  const values = {
    tenantId,
    scope: body.scope,
    provider: body.provider,
    label: body.label,
    baseUrl: body.baseUrl ?? null,
    model: body.model,
    thinking: body.thinking ?? { enabled: false },
    serviceTier: body.serviceTier ? body.serviceTier : null,
    ...(apiKeyEnc !== undefined ? { apiKeyEnc } : dropKey ? { apiKeyEnc: null } : {}),
  }

  const row = await db.transaction(async tx => {
    // `isDefault` is deliberately NOT in `values`: it is a cross-row invariant applied by
    // `makeDefault` after the row exists. `apiKeyEnc` is only in the SET when a key was supplied.
    const [saved] = await tx
      .insert(aiConfigs)
      .values(values)
      .onConflictDoUpdate({
        target: [aiConfigs.tenantId, aiConfigs.scope, aiConfigs.label],
        set: { ...values, updatedAt: new Date() },
      })
      .returning()
    if (!saved) throw new Error('ai_configs: upsert returned no row')
    if (body.isDefault || !(await hasDefault(tx, tenantId, body.scope))) {
      await makeDefault(tx, tenantId, body.scope, saved.id)
      return { ...saved, isDefault: true }
    }
    return saved
  })
  return { row, created: !existing }
}

/** Delete one row of the tenant's; null when there is none with that id. */
export async function deleteAiConfig(
  db: Database,
  tenantId: string,
  id: string
): Promise<AiConfigRow | null> {
  const [row] = await db
    .delete(aiConfigs)
    .where(and(eq(aiConfigs.id, id), eq(aiConfigs.tenantId, tenantId)))
    .returning()
  return row ?? null
}
