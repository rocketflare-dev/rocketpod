/**
 * Chunk discipline (`.claude/rules/ui.md`): the eager shell must not carry the chat, analytics or
 * markdown dependencies, and **protobuf must not reach the browser at all** — `@ag-ui/encoder` and
 * `@ag-ui/proto` are `apps/web` server dependencies; only `@ag-ui/core`'s zod schemas ship, and
 * only in the lazy chat chunk.
 *
 * It reads the built output, so it is skipped when there is none (CI builds after it runs; a local
 * `pnpm web build:ui` makes it assert). The import-graph rule itself is not enforceable from a
 * bundle — this catches the consequence, which is the thing that actually costs users bytes.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The source-level half, which runs whether or not there is a build: `components/shared` is the
 * barrel `App.tsx` imports EAGERLY, so one markdown import anywhere under it puts `react-markdown`
 * in the main chunk. `DocumentCard` is the reason this is worth pinning — it is rendered
 * from Search, from a citation and from inside `Markdown` itself, and the temptation to let it
 * render its own excerpt as markdown is exactly the mistake.
 */
describe('components/shared', () => {
  it('imports no markdown renderer, directly or through components/ai', () => {
    const dir = path.resolve(__dirname, '../../src/ui/components/shared')
    const offenders = readdirSync(dir)
      .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
      .filter(file => {
        const imports = (
          readFileSync(path.join(dir, file), 'utf8').match(/^import .*$/gm) ?? []
        ).join('\n')
        return /react-markdown|remark-|components\/ai/.test(imports)
      })
    expect(offenders).toEqual([])
  })
})

/**
 * The Guide's header button and its conversation provider live in the eager shell; the chat body
 * (markdown) and the AG-UI client (`@ag-ui/core` schemas) must arrive only when someone asks.
 */
describe('the Guide in the shell', () => {
  const UI_DIR = path.resolve(__dirname, '../../src/ui')
  it('loads the chat body and the AG-UI client lazily', () => {
    const help = readFileSync(path.join(UI_DIR, 'components/guide/GuideHelp.tsx'), 'utf8')
    expect(help).not.toMatch(/^import [^\n]*'\.\/GuideChat'/m)
    expect(help).toMatch(/lazy\(\(\) => import\('\.\/GuideChat'\)\)/)
    const provider = readFileSync(
      path.join(UI_DIR, 'components/guide/GuideChatProvider.tsx'),
      'utf8'
    )
    expect(provider).not.toMatch(/^import [^\n]*guideAsk/m)
    expect(provider).toMatch(/await import\('@\/ui\/lib\/guideAsk'\)/)
  })
})
