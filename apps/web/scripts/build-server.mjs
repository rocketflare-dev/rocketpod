#!/usr/bin/env node
/**
 * `pnpm build:server` (M2): bundle the Node entry (`src/node/server.ts`) into ONE file,
 * `dist/server.js`, so the runtime image needs Node and that file plus `dist/ui` — no
 * `node_modules`. The migrate one-shot (`scripts/migrate-all.ts`, M7) is bundled the same way into
 * `dist/migrate.js`; it reads the drizzle SQL from `migrations/` at run time. ESM for Node 24; the banner gives bundled CommonJS dependencies the `require`,
 * `__filename` and `__dirname` an ES module lacks.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Entry → bundle. Both run on Node 24 with no `node_modules` beside them (the image, M7). */
export const SERVER_BUNDLES = Object.freeze({
  'src/node/server.ts': 'dist/server.js',
  'scripts/migrate-all.ts': 'dist/migrate.js',
})

for (const [entry, outfile] of Object.entries(SERVER_BUNDLES)) {
  await bundle(entry, outfile)
  console.log(outfile)
}

async function bundle(entry, outfile) {
  await build({
    absWorkingDir: WEB_ROOT,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: true,
    legalComments: 'none',
    logLevel: 'warning',
    tsconfig: 'tsconfig.json',
    banner: {
      js: [
        "import { createRequire as __rpCreateRequire } from 'node:module'",
        "import { fileURLToPath as __rpFileURLToPath } from 'node:url'",
        "import { dirname as __rpDirname } from 'node:path'",
        'const require = __rpCreateRequire(import.meta.url)',
        'const __filename = __rpFileURLToPath(import.meta.url)',
        'const __dirname = __rpDirname(__filename)',
      ].join('\n'),
    },
  })
}
