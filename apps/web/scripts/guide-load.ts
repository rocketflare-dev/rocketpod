/**
 * `pnpm web guide:load` — load the Guide's pages (and any committed vectors) into `guide_chunks`
 * now; the server also does it at every web boot. A no-op when the table already holds exactly
 * these chunks.
 */
import { closeAllDatabases, getScriptDatabase } from '../src/db/client'
import { describeGuideLoad, loadGuideFromDisk } from '../src/node/guide-content'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required (guide:load loads .env)')
  const db = getScriptDatabase(url, process.env)
  try {
    console.log(describeGuideLoad(await loadGuideFromDisk(db)))
  } finally {
    await closeAllDatabases()
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
