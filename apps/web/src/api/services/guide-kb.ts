/**
 * The Guide as a retrievable corpus: loading the committed fixture into `guide_chunks`, and the
 * search `search_guide` runs (`guide-tools.ts`, its ONE caller).
 *
 * **Retrieval is hybrid when it can be and says so when it cannot.** The lexical half (any query
 * word, `ts_rank_cd` over the stored `search_vector`) always runs. The dense half runs only
 * when the loaded chunks carry vectors AND the platform embedder (`EMBEDDINGS_*` — never a
 * tenant's, so query and fixture match) is configured with the SAME model; otherwise the result is
 * keyword-only and carries `mode: 'lexical'` with the reason, which the route traces and the
 * answer event reports. Both halves are fused by RRF exactly as kit search is (`fuseByRank`). A
 * chunk without a vector (an edited page the fixture has not caught up with) is still found by
 * the keyword half, so hybrid search over a partly embedded table never loses a page.
 *
 * **Audience, in SQL.** The reader's audience is REQUIRED and is a predicate on both halves, so a
 * member's search never sees an admin page — not a filter on what came back.
 */
import {
  GUIDE_DEFAULT_TOP_K,
  GUIDE_MAX_TOP_K,
  type GuideAudience,
  type GuidePart,
  visibleAudiences,
} from '@rocketpod/shared/guide'
import { and, asc, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { guideChunks } from '../../db/schema'
import { isAdminLevel } from '../middleware/permissions'
import { traceEmbed, traceStep } from '../observability/context'
import {
  anyTermTsquery,
  candidatePoolSize,
  fuseByRank,
  SEARCH_TEXT_CONFIG,
  vectorLiteral,
} from './ai/retrieval'
import type { EmbeddingsClient } from './ai/types'
import type { GuideFixtureRow } from './guide-content'

/**
 * Which audience the caller reads as — THE role → audience line, for every Guide surface (the
 * reader routes and Ask the Guide). Admin-level roles read
 * as `admin`; everyone else as `member`. Never from the client.
 */
export function guideAudienceFor(auth: Parameters<typeof isAdminLevel>[0]): GuideAudience {
  return isAdminLevel(auth) ? 'admin' : 'member'
}

// ---- Loading --------------------------------------------------------------------------------

export interface LoadGuideResult {
  /** True when the table was rewritten; false when it already held exactly this fixture. */
  loaded: boolean
  chunks: number
  /** Chunks that carry a vector — 0 means retrieval is keyword-only. */
  embedded: number
}

const INSERT_BATCH = 200

/** One chunk as the loader compares it: everything a load would write except the vector. */
function chunkKey(r: {
  pagePath: string
  part: string
  audience: string
  heading: string | null
  content: string
  contentHash: string
  embeddingModel: string | null
}): string {
  return JSON.stringify([
    r.pagePath,
    r.part,
    r.audience,
    r.heading,
    r.contentHash,
    r.embeddingModel,
    r.content,
  ])
}

/**
 * Make `guide_chunks` hold exactly `rows`. A no-op only when the table already holds the same
 * chunks — page, heading, text, hash and model each — so an edited page AND a changed chunker both
 * reload; "populated" is not enough. (The Guide is small: comparing every chunk is one read.) Runs
 * in one transaction under a transaction-scoped advisory lock, so two replicas booting at once load
 * it once.
 */
export async function loadGuideRows(
  db: Database,
  rows: readonly GuideFixtureRow[]
): Promise<LoadGuideResult> {
  const embedded = rows.filter(r => r.embedding).length
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('guide_chunks'))`)
    const existing = await tx
      .select({
        pagePath: guideChunks.pagePath,
        part: guideChunks.part,
        audience: guideChunks.audience,
        heading: guideChunks.heading,
        content: guideChunks.content,
        contentHash: guideChunks.contentHash,
        embeddingModel: guideChunks.embeddingModel,
      })
      .from(guideChunks)
    const have = existing.map(chunkKey).sort()
    const want = rows
      .map(r => chunkKey({ ...r, embeddingModel: r.embedding ? r.embeddingModel : null }))
      .sort()
    if (have.length === want.length && have.every((k, i) => k === want[i])) {
      return { loaded: false, chunks: rows.length, embedded }
    }

    await tx.delete(guideChunks)
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      await tx.insert(guideChunks).values(
        rows.slice(i, i + INSERT_BATCH).map(r => ({
          pagePath: r.pagePath,
          part: r.part,
          audience: r.audience,
          heading: r.heading,
          content: r.content,
          tokens: r.tokens,
          contentHash: r.contentHash,
          embedding: r.embedding,
          embeddingModel: r.embedding ? r.embeddingModel : null,
        }))
      )
    }
    return { loaded: true, chunks: rows.length, embedded }
  })
}

// ---- Retrieval ------------------------------------------------------------------------------

export interface GuideRetrievedChunk {
  content: string
  score: number
  pagePath: string
  heading: string | null
  part: GuidePart
  audience: GuideAudience
  /** The chunk's rank in the keyword half, null when only the dense half found it. */
  lexicalRank: number | null
  /** The chunk's rank in the dense half, null when only the keyword half found it. */
  denseRank: number | null
}

/** The platform embedder, or null when `EMBEDDINGS_*` is not configured. */
export interface GuideEmbedder {
  client: EmbeddingsClient
  provider: string
  model: string
}

export type GuideRetrievalMode = 'hybrid' | 'lexical'

/** Why a search was keyword-only. */
export type GuideLexicalReason = 'no_vectors' | 'no_embedder' | 'model_mismatch'

export interface GuideRetrieval {
  chunks: GuideRetrievedChunk[]
  mode: GuideRetrievalMode
  reason: GuideLexicalReason | null
}

export interface RetrieveGuideOptions {
  query: string
  topK?: number
  /** The READER's audience — derived server-side from role, never from the client. */
  audience: GuideAudience
  /** The screen's part — a soft boost: that part first, then the rest, fused order kept. */
  preferPart?: GuidePart | null
  embedder: GuideEmbedder | null
}

interface Candidate {
  id: string
  content: string
  pagePath: string
  heading: string | null
  part: string
  audience: string
}

export function retrieveGuide(db: Database, opts: RetrieveGuideOptions): Promise<GuideRetrieval> {
  return traceStep(
    {
      name: 'retrieval search_guide',
      kind: 'retrieval',
      input: { query: opts.query, topK: opts.topK ?? GUIDE_DEFAULT_TOP_K },
    },
    () => runRetrieveGuide(db, opts),
    r => ({
      output: r.chunks.map(c => ({ page: c.pagePath, heading: c.heading, score: c.score })),
      attributes: {
        'rocketpod.retrieval.hits': r.chunks.length,
        'rocketpod.guide.retrieval_mode': r.mode,
        ...(r.reason ? { 'rocketpod.guide.lexical_reason': r.reason } : {}),
      },
    })
  )
}

async function runRetrieveGuide(db: Database, opts: RetrieveGuideOptions): Promise<GuideRetrieval> {
  const topK = Math.min(Math.max(opts.topK ?? GUIDE_DEFAULT_TOP_K, 1), GUIDE_MAX_TOP_K)
  const pool = candidatePoolSize(topK)
  const scope = inArray(guideChunks.audience, visibleAudiences(opts.audience))
  const select = {
    id: guideChunks.id,
    content: guideChunks.content,
    pagePath: guideChunks.pagePath,
    heading: guideChunks.heading,
    part: guideChunks.part,
    audience: guideChunks.audience,
  }

  // Which model the loaded vectors came from (null = the fixture carries none).
  const [stored] = await db
    .select({ model: guideChunks.embeddingModel })
    .from(guideChunks)
    .where(isNotNull(guideChunks.embedding))
    .limit(1)
  const reason: GuideLexicalReason | null = !stored
    ? 'no_vectors'
    : !opts.embedder
      ? 'no_embedder'
      : stored.model !== opts.embedder.model
        ? 'model_mismatch'
        : null

  let dense: Candidate[] = []
  if (!reason && opts.embedder) {
    const embedder = opts.embedder
    const [vector] = await traceEmbed(embedder, [opts.query], () =>
      embedder.client.embed([opts.query])
    )
    if (vector) {
      const vec = vectorLiteral(vector)
      dense = await db
        .select(select)
        .from(guideChunks)
        .where(and(scope, isNotNull(guideChunks.embedding)))
        .orderBy(sql`${guideChunks.embedding} <=> ${vec}::vector`, asc(guideChunks.id))
        .limit(pool)
    }
  }

  const terms = anyTermTsquery(opts.query)
  const tsv = guideChunks.searchVector
  const tsq = sql`to_tsquery(${SEARCH_TEXT_CONFIG}, ${terms})`
  const lexical: Candidate[] = terms
    ? await db
        .select(select)
        .from(guideChunks)
        .where(and(scope, sql`${tsv} @@ ${tsq}`))
        .orderBy(sql`ts_rank_cd(${tsv}, ${tsq}) DESC`, asc(guideChunks.id))
        .limit(pool)
    : []

  const fused = fuseByRank(dense, lexical, c => c.id).slice(0, topK)
  const chunks = fused.map(f => ({
    content: f.item.content,
    score: f.score,
    pagePath: f.item.pagePath,
    heading: f.item.heading,
    part: f.item.part as GuidePart,
    audience: f.item.audience as GuideAudience,
    lexicalRank: f.lexicalRank,
    denseRank: f.denseRank,
  }))
  return {
    chunks: preferPart(chunks, opts.preferPart ?? null),
    mode: reason ? 'lexical' : 'hybrid',
    reason,
  }
}

/** Stable partition: the preferred part first, everything else after, fused order kept. */
export function preferPart<T extends { part: GuidePart }>(
  chunks: T[],
  part: GuidePart | null
): T[] {
  if (!part) return chunks
  return [...chunks.filter(c => c.part === part), ...chunks.filter(c => c.part !== part)]
}

/** Cap on the concatenated tool output fed back to the model. */
const MAX_RENDER_CHARS = 8000

/**
 * Retrieved chunks as the tool's result: each tagged with its page and heading so the model can
 * cite precisely. Capped in length.
 */
export function renderGuideChunks(chunks: GuideRetrievedChunk[]): string {
  if (chunks.length === 0) return 'No matching passages found in the Guide.'
  const parts: string[] = []
  let total = 0
  for (const c of chunks) {
    const block = `[page=${c.pagePath} | heading=${c.heading ?? '-'}]\n${c.content}`
    if (total + block.length > MAX_RENDER_CHARS && parts.length > 0) break
    parts.push(block)
    total += block.length
  }
  return parts.join('\n\n---\n\n')
}
