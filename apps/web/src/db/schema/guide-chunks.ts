/**
 * `guide_chunks` — a retrievable chunk of the Guide, the in-app user guide that "Ask the Guide"
 * answers from (`search_guide`, `services/guide-kb.ts`).
 *
 * ⚠️ This table has NO `tenant_id`, so it is in `RLS_EXCLUDED_TABLES`. The Guide is static product
 * documentation shared by every tenant (`apps/web/content/guide/`, shipped in the image); it holds
 * NO tenant data, so nothing is ever compared across tenants. ACCESS is decided at the route (every
 * member of a tenant), READ SCOPE by `audience` inside retrieval (an `admin` page only for admins)
 * — never per surface. Never join a tenant table against it.
 *
 * Isolation from every other model surface is by construction: knowledge search and the
 * knowledge tools read `chunks`, and only the guide route registers the `search_guide` tool that reads this table
 * (`tests/config/guide-isolation.test.ts`, `tests/api/guide.test.ts`).
 *
 * The rows are DERIVED: every web boot chunks the committed pages and rewrites the table when a
 * chunk differs (`src/node/guide-content.ts`). `embedding` is NULLABLE — a chunk takes a vector only
 * when the committed `embeddings.jsonl.gz` holds one for that exact chunk text, so with no fixture
 * (or for an edited chunk) retrieval is keyword-only for it: `search_vector`, the stored
 * `to_tsvector(SEARCH_TEXT_CONFIG, content)` behind a GIN index — the same shape as
 * `chunks.search_vector`. `contentHash` is the sha256 of the page's raw file.
 */
import { EMBEDDING_DIM, SEARCH_TEXT_CONFIG } from '@rocketpod/shared/ai/config'
import { sql } from 'drizzle-orm'
import { customType, index, integer, pgTable, text, uuid, vector } from 'drizzle-orm/pg-core'
import { timestamps } from './_helpers'

/** A Postgres `tsvector` (drizzle has no built-in): read only inside SQL, never selected. */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })

export const guideChunks = pgTable(
  'guide_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Relative to `content/guide/`, e.g. `start/signing-in.md` — the citation key. */
    pagePath: text('page_path').notNull(),
    /** `GUIDE_PARTS`. */
    part: text('part').notNull(),
    /** `GUIDE_AUDIENCES` — `member | admin`, filtered by `visibleAudiences()`. */
    audience: text('audience').notNull(),
    /** The nearest preceding H2's anchor id, for a finer citation (nullable). */
    heading: text('heading'),
    content: text('content').notNull(),
    /** Null unless the committed fixture embedded this exact chunk text. */
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    embeddingModel: text('embedding_model'),
    contentHash: text('content_hash').notNull(),
    tokens: integer('tokens').notNull().default(0),
    /**
     * The lexical half's vector, stored: `to_tsvector(SEARCH_TEXT_CONFIG, content)`. Raw SQL on
     * purpose — a generated expression cannot take a bind parameter, and the constant is ours.
     */
    searchVector: tsvector('search_vector')
      .notNull()
      .generatedAlwaysAs(sql.raw(`to_tsvector('${SEARCH_TEXT_CONFIG}', content)`)),
    ...timestamps(),
  },
  table => [
    index('guide_chunks_page_idx').on(table.pagePath),
    // Cosine ANN index for the dense half (pgvector HNSW; rows without a vector are not indexed).
    index('guide_chunks_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
    index('guide_chunks_search_vector_idx').using('gin', table.searchVector),
  ]
)

export type GuideChunkRow = typeof guideChunks.$inferSelect
export type NewGuideChunkRow = typeof guideChunks.$inferInsert
