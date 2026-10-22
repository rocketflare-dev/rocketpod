// @vitest-isolate
// Mocks `@rocketpod/shared/ai/default-models` (empty in the kit) with one entry, so this file needs its own module registry.
/**
 * The PLATFORM DEFAULT layer of `resolveChat`: a model id per prompt key — a `platform_agent_models`
 * row, else the committed `PROMPT_DEFAULT_MODELS` entry — that the platform tier runs when the
 * tenant decided nothing for that key. What would go wrong: the default ignored by resolve (or by
 * the Settings → Agent models list, which must say what resolve will do); a tenant's own pin or own
 * default config overridden by the platform's choice; a Claude id sent to an OpenAI-compatible
 * platform tier (or to a different compatible endpoint); the committed table winning over a row.
 *
 * `platform_agent_models` is platform state shared by every file, so this one uses `evals-judge`,
 * a key no other api test resolves, and deletes its row when done.
 */
import { agentModelsListResponseSchema } from '@rocketpod/shared/ai/agent-models'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { resolveChat } from '@/api/services/ai/resolve'
import { loadConfig } from '@/config'
import { agentModels, platformAgentModels } from '@/db/schema'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv, FAKE_CHAT_MODEL, FAKE_MODELS_BASE_URL } from '../mocks/bindings'

const COMMITTED_MODEL = 'claude-committed-for-evals-judge'

vi.mock('@rocketpod/shared/ai/default-models', () => {
  const entry = {
    provider: 'anthropic',
    model: 'claude-committed-for-evals-judge',
    evidence: 'test fixture',
  }
  return {
    PROMPT_DEFAULT_MODELS: { 'evals-judge': entry },
    promptDefaultModel: (key: string) => (key === 'evals-judge' ? entry : null),
  }
})

const db = setupTestDatabase()
// No Anthropic key: the platform tier is the fake OpenAI-compatible endpoint.
const env = createTestEnv({ ANTHROPIC_API_KEY: '' })
const cfg = loadConfig(env)
const KEY = 'evals-judge'

async function promote(row: { provider: string; baseUrl: string | null; model: string }) {
  await db
    .insert(platformAgentModels)
    .values({ promptKey: KEY, ...row, provider: row.provider as 'openai_compatible' })
    .onConflictDoUpdate({ target: platformAgentModels.promptKey, set: row as never })
}

async function unpromote() {
  await db.delete(platformAgentModels).where(eq(platformAgentModels.promptKey, KEY))
}

afterAll(unpromote)

async function effective(cookie: Record<string, string>) {
  const list = agentModelsListResponseSchema.parse(
    await json(await request('/api/ai/agent-models', { headers: cookie }, { env }))
  )
  return list.items.find(i => i.promptKey === KEY)?.effective
}

describe('platform default model per prompt key', () => {
  it('runs on the platform tier when the tenant decided nothing, and a tenant row wins over it', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'admin')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    await promote({
      provider: 'openai_compatible',
      baseUrl: FAKE_MODELS_BASE_URL,
      model: 'promoted',
    })

    expect(await resolveChat(db, cfg, env, tenant.id, { promptKey: KEY })).toMatchObject({
      provider: 'openai_compatible',
      model: 'promoted',
      source: 'platform_default',
    })
    expect(await effective(cookie)).toEqual({
      source: 'platform_default',
      provider: 'openai_compatible',
      model: 'promoted',
    })
    // Another key of the same tenant is untouched.
    expect(await resolveChat(db, cfg, env, tenant.id, { promptKey: 'chat' })).toMatchObject({
      model: FAKE_CHAT_MODEL,
      source: 'platform',
    })

    // The tenant's own pin for the key wins.
    await db.insert(agentModels).values({ tenantId: tenant.id, promptKey: KEY, model: 'pinned' })
    expect(await resolveChat(db, cfg, env, tenant.id, { promptKey: KEY })).toMatchObject({
      model: 'pinned',
      source: 'agent',
    })
    await db.delete(agentModels).where(eq(agentModels.tenantId, tenant.id))

    // So does the tenant's own default config: its key, its spend, its model.
    const created = await request(
      '/api/ai/config',
      { method: 'POST', headers: cookie },
      {
        env,
        json: {
          label: 'own',
          provider: 'anthropic',
          model: 'tenant-model',
          apiKey: 'sk-ant-own-0123456789abcdef',
        },
      }
    )
    expect(created.status).toBe(201)
    expect(await resolveChat(db, cfg, env, tenant.id, { promptKey: KEY })).toMatchObject({
      provider: 'anthropic',
      model: 'tenant-model',
      source: 'tenant',
    })
    expect((await effective(cookie))?.source).toBe('tenant')
  })

  it('is ignored by a platform tier that cannot serve it', async () => {
    const { tenant } = await createTestTenantWithUser(db, 'admin')
    // A Claude id promoted while the platform tier is the OpenAI-compatible endpoint.
    await promote({ provider: 'anthropic', baseUrl: null, model: 'claude-sonnet-5-5' })
    expect(await resolveChat(db, cfg, env, tenant.id, { promptKey: KEY })).toMatchObject({
      provider: 'openai_compatible',
      model: FAKE_CHAT_MODEL,
      source: 'platform',
    })
    // The right provider on a different compatible endpoint.
    await promote({
      provider: 'openai_compatible',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      model: 'accounts/fireworks/models/x',
    })
    expect((await resolveChat(db, cfg, env, tenant.id, { promptKey: KEY })).model).toBe(
      FAKE_CHAT_MODEL
    )
  })
})

describe('the committed default model per prompt key (PROMPT_DEFAULT_MODELS)', () => {
  // The platform tier here is Anthropic (the key is never called — resolveChat only builds the client).
  const anthropicEnv = createTestEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' })
  const anthropicCfg = loadConfig(anthropicEnv)

  it('runs the committed model with no row, a row wins, another provider ignores it', async () => {
    await unpromote()
    const { tenant } = await createTestTenantWithUser(db, 'admin')

    expect(
      await resolveChat(db, anthropicCfg, anthropicEnv, tenant.id, { promptKey: KEY })
    ).toMatchObject({ provider: 'anthropic', model: COMMITTED_MODEL, source: 'platform_default' })
    // A key with no committed entry runs the tier's own model.
    expect(
      await resolveChat(db, anthropicCfg, anthropicEnv, tenant.id, { promptKey: 'chat' })
    ).toMatchObject({ provider: 'anthropic', source: 'platform' })
    // The OpenAI-compatible tier is never handed the committed Claude id.
    expect(await resolveChat(db, cfg, env, tenant.id, { promptKey: KEY })).toMatchObject({
      model: FAKE_CHAT_MODEL,
      source: 'platform',
    })

    // A row is the newer decision and wins over the committed table.
    await promote({ provider: 'anthropic', baseUrl: null, model: 'applied-model' })
    expect(
      await resolveChat(db, anthropicCfg, anthropicEnv, tenant.id, { promptKey: KEY })
    ).toMatchObject({ model: 'applied-model', source: 'platform_default' })
  })
})
