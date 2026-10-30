/**
 * `/api/ai/config`: a tenant's AI providers. Credentials are encrypted on the way in and
 * NEVER come back out (`hasCredential` only). `POST /` upserts on (tenant, scope, label): omitting
 * `apiKey` on a re-save keeps the stored key; `isDefault` swaps the scope's default inside one
 * transaction (clear-others-then-set — the partial unique index rejects the reverse order). The
 * first row in a scope is always made default. `POST /test` spends money at a provider on demand,
 * so it is rate-limited per IP. `GET /readiness` is what the Home checklist reads. `manage AiConfig`
 * = admin+; members may `read` (the list shows what will answer them, not how to change it).
 */
import {
  aiReadinessSchema,
  testAiConfigRequestSchema,
  upsertAiConfigRequestSchema,
} from '@rocketpod/shared/ai/config'
import { guardPermission } from '../middleware/permissions'
import { rateLimit } from '../middleware/rate-limit'
import { recordActivity } from '../services/activity'
import { deleteAiConfig, listAiConfigs, toAiConfig, upsertAiConfig } from '../services/ai/configs'
import { testConfig } from '../services/ai/connection-test'
import { PROVIDERS } from '../services/ai/providers'
import { readiness } from '../services/ai/resolve'
import { NotFoundError } from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const aiConfigRouter = createRouter()

/** 10 tests / minute / IP — authenticated and admin-only, but every call spends provider money. */
const aiTestRateLimit = rateLimit({ name: 'ai-test', max: 10, windowSeconds: 60 })

// ---- GET /api/ai/config ------------------------------------------------------------------------

aiConfigRouter.get('/', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AiConfig')
  const rows = await listAiConfigs(db, tenantId)
  return c.json({ items: rows.map(toAiConfig) })
})

/** Static catalog for the settings form (what each provider needs, presets, suggested models). */
aiConfigRouter.get('/providers', async c => {
  withAuthAndDb(c)
  guardPermission(c, 'read', 'AiConfig')
  return c.json({
    items: PROVIDERS,
    defaultMaxOutputTokens: c.get('config').AGENT_MAX_OUTPUT_TOKENS,
  })
})

aiConfigRouter.get('/readiness', async c => {
  const { db, tenantId, cfg } = withAuthAndDb(c)
  guardPermission(c, 'read', 'AiConfig')
  return c.json(aiReadinessSchema.parse(await readiness(db, cfg, c.get('platform'), tenantId)))
})

// ---- POST /api/ai/config/test --------------------------------------------------------------------

aiConfigRouter.post(
  '/test',
  aiTestRateLimit,
  validate('json', testAiConfigRequestSchema),
  async c => {
    const { db, tenantId, cfg } = withAuthAndDb(c)
    guardPermission(c, 'manage', 'AiConfig')
    return c.json(await testConfig(db, cfg, c.get('platform'), tenantId, c.req.valid('json')))
  }
)

// ---- POST /api/ai/config (upsert) -----------------------------------------------------------------

aiConfigRouter.post('/', validate('json', upsertAiConfigRequestSchema), async c => {
  const { db, tenantId, user, cfg, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'AiConfig')
  const { row: saved, created } = await upsertAiConfig(db, cfg, tenantId, c.req.valid('json'))

  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: created ? 'ai_config.created' : 'ai_config.updated',
      subjectType: 'AiConfig',
      subjectId: saved.id,
      metadata: {
        scope: saved.scope,
        provider: saved.provider,
        label: saved.label,
        model: saved.model,
      },
    })
  )
  return c.json(toAiConfig(saved), created ? 201 : 200)
})

// ---- DELETE /api/ai/config/:id --------------------------------------------------------------------

aiConfigRouter.delete('/:id', async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'AiConfig')
  const id = uuidParam(c, 'id')
  const row = await deleteAiConfig(db, tenantId, id)
  if (!row) throw new NotFoundError('AI config not found')
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'ai_config.deleted',
      subjectType: 'AiConfig',
      subjectId: row.id,
      metadata: { scope: row.scope, provider: row.provider, label: row.label },
    })
  )
  return c.body(null, 204)
})
