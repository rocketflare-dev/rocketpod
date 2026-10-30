/**
 * `platform_agent_models` — the PLATFORM DEFAULT model per prompt key: what the platform's own key
 * (`ANTHROPIC_API_KEY`, else `AI_*`) runs for one agent or prompt when a tenant has decided nothing
 * for it. Written by a global admin (SQL, or an app's own admin tooling — core ships no writer),
 * read only by `services/ai/resolve.ts` (`planChat`) — the order and its reasons are
 * `docs/CONCEPTS.md` §9. A row wins over the committed `PROMPT_DEFAULT_MODELS` entry for its key.
 *
 * A row is a MODEL ID and the provider (and base URL, for the `*_compatible` ones) it belongs to —
 * never a credential: the platform tier's key is the operator's environment, and a tenant's own
 * keys stay the tenant's. The provider pair is what lets resolve apply the row only to a platform
 * tier that can serve it: a Claude id must not be sent to the OpenAI-compatible tier.
 *
 * Platform-level state with no `tenant_id`, like `feature_flags`, so it is in `RLS_EXCLUDED_TABLES`.
 * `prompt_key` is the primary key: one default per key; reverting is a delete.
 */
import type { AiProvider } from '@rocketpod/shared/ai/config'
import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { timestamps } from './_helpers'
import { users } from './users'

export const platformAgentModels = pgTable('platform_agent_models', {
  /** A registry prompt key (`services/prompts.ts`) — text, so a new agent is no migration. */
  promptKey: text('prompt_key').primaryKey(),
  /** The provider the model id belongs to; the row applies only to a platform tier of this one. */
  provider: text('provider').$type<AiProvider>().notNull(),
  /** For an `*_compatible` provider, the endpoint the id belongs to; null otherwise. */
  baseUrl: text('base_url'),
  model: text('model').notNull(),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  ...timestamps(),
})

export type PlatformAgentModelRow = typeof platformAgentModels.$inferSelect
