/**
 * The Guide's content on disk — the Node half of `Platform.guide` — its committed vectors, and the
 * boot load into `guide_chunks`.
 *
 * Where the content is: `apps/web/content/guide/`, which is the process's `content/guide` both in
 * development (`pnpm dev` runs in `apps/web`) and in the image (`WORKDIR /app`, the Dockerfile
 * copies it beside `dist/`). A missing directory is an empty Guide, not a crash.
 *
 * Content is static in an image, so production reads it once and keeps it; development re-reads
 * on every call, so an edited page shows on refresh.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { EMBEDDING_DIM } from '@rocketpod/shared/ai/config'
import {
  buildGuideRows,
  GUIDE_FIXTURE_FILE,
  GUIDE_INDEX_COMMAND,
  GUIDE_SCREENSHOT_MANIFEST,
  type GuideFixtureRow,
  loadGuidePages,
  validateGuideFixtureRow,
} from '../api/services/guide-content'
import { type LoadGuideResult, loadGuideRows } from '../api/services/guide-kb'
import type { Database } from '../db/client'
import type { GuideContentSource, GuideFile } from '../platform/types'

/** `content/guide` under the working directory, else under `apps/web` (a script run from the root). */
export function defaultGuideContentDir(): string {
  const here = path.resolve(process.cwd(), 'content/guide')
  if (existsSync(here)) return here
  const fromRoot = path.resolve(process.cwd(), 'apps/web/content/guide')
  return existsSync(fromRoot) ? fromRoot : here
}

/** Every `.md` file under `dir` (dot-entries skipped), as content-relative POSIX paths. */
export async function readGuideMarkdownFiles(dir: string): Promise<GuideFile[]> {
  const out: GuideFile[] = []
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(childRel)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push({ path: childRel, raw: await readFile(path.join(dir, childRel), 'utf8') })
      }
    }
  }
  try {
    await walk('')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/**
 * `<dir>/images/<file>`: a bare filename (no separators), a known raster type (no SVG — it can
 * carry script), and a resolved path inside `images/`. Anything else is null — never a hint about
 * what exists.
 */
export async function readGuideImage(
  dir: string,
  file: string
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!/^[a-zA-Z0-9._-]+$/.test(file)) return null
  const contentType = IMAGE_TYPES[path.extname(file).toLowerCase()]
  if (!contentType) return null
  const imagesDir = path.resolve(dir, 'images')
  const resolved = path.resolve(imagesDir, file)
  if (!resolved.startsWith(imagesDir + path.sep)) return null
  try {
    return { bytes: new Uint8Array(await readFile(resolved)), contentType }
  } catch {
    return null
  }
}

export function createNodeGuideSource(
  dir = defaultGuideContentDir(),
  options: { cache?: boolean } = {}
): GuideContentSource {
  const cache = options.cache ?? process.env.NODE_ENV === 'production'
  let files: Promise<GuideFile[]> | null = null
  let manifest: Promise<string | null> | null = null
  return {
    markdownFiles() {
      if (!cache) return readGuideMarkdownFiles(dir)
      files ??= readGuideMarkdownFiles(dir)
      return files
    },
    screenshotManifest() {
      const read = () => readOptional(path.join(dir, GUIDE_SCREENSHOT_MANIFEST))
      if (!cache) return read()
      manifest ??= read()
      return manifest
    },
    image: file => readGuideImage(dir, file),
  }
}

// ---- The fixture (`embeddings.jsonl.gz`, NDJSON gzipped) ------------------------------------

export function guideFixturePath(dir: string): string {
  return path.join(dir, GUIDE_FIXTURE_FILE)
}

/** Read and validate the fixture; null when there is none. */
export async function readGuideFixture(
  dir: string,
  dimensions: number
): Promise<GuideFixtureRow[] | null> {
  let gz: Buffer
  try {
    gz = await readFile(guideFixturePath(dir))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const rows: GuideFixtureRow[] = []
  gunzipSync(gz)
    .toString('utf8')
    .split('\n')
    .forEach((line, i) => {
      if (!line.trim()) return
      const row = JSON.parse(line) as unknown
      const problem = validateGuideFixtureRow(row, dimensions)
      if (problem) throw new Error(`Guide fixture line ${i + 1}: ${problem}`)
      rows.push(row as GuideFixtureRow)
    })
  return rows
}

/**
 * Write the fixture. gzip's header carries no timestamp from `gzipSync`, so the same rows are the
 * same bytes — a re-index of unchanged pages is no diff.
 */
export async function writeGuideFixture(
  dir: string,
  rows: readonly GuideFixtureRow[]
): Promise<string> {
  const file = guideFixturePath(dir)
  const ndjson = rows.map(r => JSON.stringify(r)).join('\n')
  await writeFile(file, gzipSync(Buffer.from(`${ndjson}\n`, 'utf8'), { level: 9 }))
  return file
}

/**
 * Make `guide_chunks` hold the Guide as it is on disk: the pages chunked NOW, each chunk carrying
 * the committed fixture's vector when the fixture embedded that exact text (`buildGuideRows`). No
 * fixture, or a stale one, is keyword-only search for the chunks it does not cover — never an empty
 * Guide. Run at boot by every `web`/`all` process — the advisory lock in `loadGuideRows` makes
 * concurrent boots safe, and an unchanged Guide is a no-op — and by `pnpm web guide:load`. A page
 * that fails to parse is left out here; the staleness test is what stops one shipping.
 */
export async function loadGuideFromDisk(
  db: Database,
  dir = defaultGuideContentDir()
): Promise<{ fixture: boolean; skipped: number } & LoadGuideResult> {
  const { pages, problems } = loadGuidePages(await readGuideMarkdownFiles(dir))
  const fixture = await readGuideFixture(dir, EMBEDDING_DIM)
  const result = await loadGuideRows(db, buildGuideRows(pages, fixture))
  return { ...result, fixture: fixture !== null, skipped: problems.length }
}

/** One line for the log: what the Guide's retrieval can do after a load. */
export function describeGuideLoad(result: Awaited<ReturnType<typeof loadGuideFromDisk>>): string {
  const what = result.loaded ? 'loaded' : 'up to date'
  const skipped = result.skipped ? ` (${result.skipped} broken page(s) left out)` : ''
  const search =
    result.chunks === 0
      ? 'no pages'
      : result.embedded === 0
        ? `keyword search only (${result.fixture ? 'the fixture covers no current chunk' : `no ${GUIDE_FIXTURE_FILE}`} — ${GUIDE_INDEX_COMMAND} with EMBEDDINGS_API_KEY)`
        : result.embedded < result.chunks
          ? `${result.embedded}/${result.chunks} chunks embedded, the rest keyword-only until ${GUIDE_INDEX_COMMAND}`
          : 'every chunk embedded'
  return `guide: ${what}, ${result.chunks} chunks${skipped} — ${search}`
}
