#!/usr/bin/env node
/**
 * `pnpm build:server` (M2): bundle the Node entry (`src/node/server.ts`) into ONE file,
 * `dist/server.js`, so the runtime image needs Node and that file plus `dist/ui` — no
 * `node_modules`. ESM for Node 24; the banner gives bundled CommonJS dependencies the `require`,
 * `__filename` and `__dirname` an ES module lacks.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

await build({
  absWorkingDir: WEB_ROOT,
  entryPoints: ['src/node/server.ts'],
  outfile: 'dist/server.js',
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
console.log('dist/server.js')
