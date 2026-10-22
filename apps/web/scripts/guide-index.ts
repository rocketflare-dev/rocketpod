/**
 * `pnpm web guide:index [--dry-run]` — rebuild the Guide's committed VECTORS
 * (`content/guide/embeddings.jsonl.gz`): parse → chunk at H2 (facts resolved) → embed with the
 * PLATFORM model (`EMBEDDINGS_*`) → write NDJSON.gz. Commit the file with the pages.
 *
 * It calls a real embeddings API, which costs money (a little: unchanged chunk text keeps its
 * vector, so only new or edited chunks are sent). `--dry-run` says how many chunks would be
 * embedded and calls nothing. Without `EMBEDDINGS_API_KEY` it refuses — and nothing is broken: the
 * server chunks the pages itself at boot, and a chunk the fixture does not cover is found by
 * keyword search only (`docs/CONCEPTS.md` § The Guide).
 */
import { EMBEDDING_DIM } from '@rocketpod/shared/ai/config'
import { resolvePlatformEmbeddings } from '../src/api/services/ai/resolve'
import {
  GUIDE_FIXTURE_FILE,
  guideFixtureRows,
  loadGuidePages,
  reuseGuideEmbeddings,
} from '../src/api/services/guide-content'
import { loadConfig } from '../src/config'
import {
  defaultGuideContentDir,
  readGuideFixture,
  readGuideMarkdownFiles,
  writeGuideFixture,
} from '../src/node/guide-content'

const EMBED_BATCH = 64

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const unknown = process.argv.slice(2).filter(a => a !== '--dry-run')
  if (unknown.length > 0)
    throw new Error(
      `unknown argument(s) ${unknown.join(' ')} — usage: pnpm web guide:index [--dry-run]`
    )
  const dir = defaultGuideContentDir()
  const { pages, problems } = loadGuidePages(await readGuideMarkdownFiles(dir))
  if (problems.length > 0) {
    throw new Error(
      `Refusing to index a Guide with broken pages:\n  ${problems.map(p => p.message).join('\n  ')}`
    )
  }
  const rows = guideFixtureRows(pages)
  console.log(`guide: ${pages.length} pages → ${rows.length} chunks (${dir})`)

  const embedder = resolvePlatformEmbeddings(loadConfig(process.env))
  if (!embedder) {
    throw new Error(
      `No platform embeddings key (EMBEDDINGS_API_KEY in apps/web/.env) — nothing to embed with. The Guide still works without ${GUIDE_FIXTURE_FILE}: keyword search only.`
    )
  }
  // Unchanged chunks keep their vectors: only new or edited chunk text costs an embedding call.
  const previous = (await readGuideFixture(dir, EMBEDDING_DIM)) ?? []
  const todo = reuseGuideEmbeddings(rows, previous, embedder.model)
  console.log(
    `guide: ${embedder.model} — ${rows.length - todo.length} chunks unchanged (vectors reused), ${todo.length} to embed`
  )
  if (dryRun) {
    console.log('guide: --dry-run — no embeddings requested, nothing written')
    return
  }
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const batch = todo.slice(i, i + EMBED_BATCH)
    const vectors = await embedder.client.embed(batch.map(r => r.content))
    if (vectors.length !== batch.length) {
      throw new Error(`embedding count mismatch: expected ${batch.length}, got ${vectors.length}`)
    }
    batch.forEach((row, j) => {
      const v = vectors[j] as number[]
      if (v.length !== EMBEDDING_DIM) {
        throw new Error(`embedding has ${v.length} dimensions, expected ${EMBEDDING_DIM}`)
      }
      row.embedding = v
      row.embeddingModel = embedder.model
    })
    console.log(`  embedded ${Math.min(i + EMBED_BATCH, todo.length)}/${todo.length}`)
  }
  const file = await writeGuideFixture(dir, rows)
  console.log(`guide: wrote ${file} — commit it with the pages`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
