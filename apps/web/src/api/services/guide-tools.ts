/**
 * The `search_guide` tool — the ONLY way a model reaches the Guide.
 *
 * ⚠️ Built by the guide route's "Ask the Guide" chat and nowhere else. Chat, agents and the
 * knowledge tools search `chunks` (a tenant's documents); the Guide is invisible to them because
 * nothing appends this tool to theirs.
 * `tests/config/guide-isolation.test.ts` fails if anything outside the guide route starts to.
 *
 * The model supplies only `query` / `topK`. The audience and the preferred part are fixed by the
 * caller from server-side facts (role, screen), so nothing the model writes can widen what it
 * reads. Every call's retrieval mode is reported back through `onRetrieval`, so the answer can say
 * whether it was found by meaning or by keyword.
 */
import {
  GUIDE_DEFAULT_TOP_K,
  GUIDE_MAX_TOP_K,
  type GuideAudience,
  type GuidePart,
} from '@rocketpod/shared/guide'
import { z } from 'zod'
import type { Database } from '../../db/client'
import type { Tool } from './ai/kit'
import {
  type GuideEmbedder,
  type GuideRetrieval,
  renderGuideChunks,
  retrieveGuide,
} from './guide-kb'

export const SEARCH_GUIDE_TOOL = 'search_guide'

export interface GuideToolContext {
  /** The STREAM's database client — the request's is closed before the tool runs. */
  db: Database
  audience: GuideAudience
  preferPart?: GuidePart | null
  embedder: GuideEmbedder | null
  onRetrieval?: (retrieval: GuideRetrieval) => void
}

const searchGuideInput = z.object({
  query: z.string().min(1).max(4000).describe('What to search for in the Guide.'),
  topK: z
    .number()
    .int()
    .positive()
    .max(GUIDE_MAX_TOP_K)
    .optional()
    .describe(`Max passages to return (default ${GUIDE_DEFAULT_TOP_K}).`),
})

export function createGuideTools(ctx: GuideToolContext): Tool[] {
  const search: Tool<z.infer<typeof searchGuideInput>> = {
    name: SEARCH_GUIDE_TOOL,
    description:
      "Search the Guide — the product's own user guide: how to sign in, the workspace, " +
      'members and settings, AI configuration and the CLI. ' +
      'Returns the most relevant passages, each tagged with its page path and heading for ' +
      'citation. Issue several focused queries to cover a question. Read-only.',
    schema: searchGuideInput,
    async handler(input) {
      const retrieval = await retrieveGuide(ctx.db, {
        query: input.query,
        topK: input.topK,
        audience: ctx.audience,
        preferPart: ctx.preferPart ?? null,
        embedder: ctx.embedder,
      })
      ctx.onRetrieval?.(retrieval)
      return renderGuideChunks(retrieval.chunks)
    },
  }
  return [search as Tool]
}
