/**
 * No Cloudflare anywhere (M6b): the kit runs on Node in a container, and nothing in it may depend on
 * the Workers runtime again — no `wrangler`/`miniflare`/`workerd`/`@cloudflare/*` package in any
 * workspace manifest, no script that runs `wrangler`, no `cloudflare:*` import, no Workers global
 * type and no Worker binding read off an env, in `src/`, `tests/` or `scripts/`. Routes, services,
 * queue handlers, cron tasks and the agent-run body depend on the neutral interfaces of
 * `src/platform/types.ts` and read `c.get('platform')`. A source scan on the model of
 * `driver-results.test.ts`: tokens, not text, so a comment or a string that mentions `R2Bucket` is
 * fine and a type annotation is not.
 *
 * The same scan keeps the Node entry fenced: `process`, Node's server-side modules and
 * `@hono/node-server` appear ONLY in `src/node/`, and nothing else under `src/` imports it — config
 * comes through `loadConfig(env)` and the runtime through the `Platform`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { WEB_ROOT } from '../helpers/source-files'

const REPO_ROOT = path.resolve(WEB_ROOT, '../..')

/**
 * The Workers runtime's global types and the `Cloudflare` namespace. `ExecutionContext` is not
 * here: Hono declares its own, which the app and the Node entry use.
 */
const CLOUDFLARE_TYPES = new Set([
  'Ai',
  'Cloudflare',
  'DurableObject',
  'DurableObjectNamespace',
  'DurableObjectState',
  'DurableObjectStub',
  'ExportedHandler',
  'Fetcher',
  'Hyperdrive',
  'KVNamespace',
  'MessageBatch',
  'MessageSendRequest',
  'Queue',
  'QueueSendBatchOptions',
  'QueueSendOptions',
  'R2Bucket',
  'R2Object',
  'R2ObjectBody',
  'Rpc',
  'ScheduledController',
  'WebSocketPair',
  'WebSocketRequestResponsePair',
  'Workflow',
  'WorkflowEntrypoint',
  'WorkflowEvent',
  'WorkflowSleepDuration',
  'WorkflowStep',
])

/** The Worker's binding names — read them through the `Platform`, never off an env. */
const BINDINGS = new Set([
  'AGENT_RUN_WORKFLOW',
  'FILES',
  'JOBS_QUEUE',
  'NOTIFICATIONS_HUB',
  'RATE_LIMIT_KV',
])

/** Tracked AND untracked sources under `dirs`, so a file is scanned the moment it is written. */
function sources(dirs: string[] = ['src'], pattern = /\.tsx?$/): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...dirs],
    { cwd: WEB_ROOT, encoding: 'utf8' }
  )
  return out
    .split('\n')
    .filter(f => pattern.test(f))
    .filter(f => existsSync(path.join(WEB_ROOT, f)))
    .sort()
}

/**
 * A whole-tree scan's budget. Locally both scans take well under a second; on CI's 2-vCPU runner,
 * beside every other config file and a growing app tree, the Cloudflare scan once passed vitest's
 * default 5 s and failed a copy's release. The guard is worth the time; the default is not.
 */
const SCAN_TIMEOUT_MS = 30_000

/** Each source read once, whichever scan asks first. */
const texts = new Map<string, string>()
function read(file: string): string {
  let text = texts.get(file)
  if (text === undefined) {
    text = readFileSync(path.join(WEB_ROOT, file), 'utf8')
    texts.set(file, text)
  }
  return text
}

/** Every workspace `package.json`, repo-relative. */
function manifests(): string[] {
  return execFileSync('git', ['ls-files', '--', 'package.json', '*/package.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(f => f.endsWith('package.json') && !f.includes('node_modules'))
}

/** A Cloudflare toolchain or runtime package. */
const CLOUDFLARE_PACKAGE = /^(wrangler|miniflare|workerd|cloudflared|@cloudflare\/|@cliftonc\/cfld)/

interface Finding {
  file: string
  line: number
  what: string
}

/** Identifiers and module specifiers that name the Worker, in code (never comments or strings). */
function cloudflareReferences(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: Finding[] = []
  const at = (node: ts.Node, what: string) =>
    found.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      what,
    })
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith('cloudflare:')
    ) {
      at(node, `import '${node.moduleSpecifier.text}'`)
    } else if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
      const name = ts.isTypeReferenceNode(node) ? node.typeName : node.expression
      const head = ts.isQualifiedName(name)
        ? leftmost(name)
        : ts.isPropertyAccessExpression(name)
          ? leftmostExpression(name)
          : name
      if (ts.isIdentifier(head) && CLOUDFLARE_TYPES.has(head.text)) at(node, head.text)
    } else if (ts.isPropertyAccessExpression(node) && BINDINGS.has(node.name.text)) {
      at(node, `.${node.name.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function leftmost(name: ts.QualifiedName): ts.EntityName {
  let left: ts.EntityName = name
  while (ts.isQualifiedName(left)) left = left.left
  return left
}

function leftmostExpression(expr: ts.PropertyAccessExpression): ts.Expression {
  let left: ts.Expression = expr
  while (ts.isPropertyAccessExpression(left)) left = left.expression
  return left
}

/** Where Node's process and server modules may be used: the Node entry and nothing else. */
const NODE_ONLY = /^src\/node\//

/**
 * `node:*` modules the app's own code may use anywhere — the ones that are runtime plumbing rather
 * than a server. Everything else (`node:fs`, `node:http`, `node:net`…) is the Node entry's business.
 */
const PORTABLE_NODE_MODULES = new Set([
  'node:async_hooks',
  'node:buffer',
  'node:crypto',
  'node:events',
  'node:util',
])

/** `process`, Node-only modules, and imports of the Node entry — outside `src/node/`. */
function nodeReferences(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: Finding[] = []
  const at = (node: ts.Node, what: string) =>
    found.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      what,
    })
  const dir = path.posix.dirname(file)
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text
      if (spec.startsWith('node:') && !PORTABLE_NODE_MODULES.has(spec)) at(node, `import '${spec}'`)
      if (spec.startsWith('@hono/node-server')) at(node, `import '${spec}'`)
      const target = spec.startsWith('.')
        ? path.posix.normalize(path.posix.join(dir, spec))
        : spec.startsWith('@/')
          ? `src/${spec.slice(2)}`
          : null
      if (target && NODE_ONLY.test(`${target}/`)) at(node, `import '${spec}' (the Node entry)`)
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process'
    ) {
      at(node, `process.${node.name.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('the Node entry stays in src/node/', () => {
  it(
    'no process, Node server module or Node-entry import anywhere else under src/',
    () => {
      const offenders = sources()
        .filter(file => !NODE_ONLY.test(file))
        .flatMap(file => nodeReferences(file, read(file)))
        .map(f => `${f.file}:${f.line} ${f.what}`)
      expect(offenders, 'config comes through loadConfig(env); runtime through Platform').toEqual(
        []
      )
    },
    SCAN_TIMEOUT_MS
  )

  it('sees what it is looking for', () => {
    const probe = [
      "import { readFile } from 'node:fs/promises'",
      "import { AsyncLocalStorage } from 'node:async_hooks'",
      "import { serve } from '@hono/node-server'",
      "import { startServer } from '../node/server'",
      "import { createNodeAssets } from '@/node/assets'",
      '// process.env in a comment is fine',
      'const port = process.env.PORT',
    ].join('\n')
    expect(nodeReferences('src/api/probe.ts', probe).map(f => f.what)).toEqual([
      "import 'node:fs/promises'",
      "import '@hono/node-server'",
      "import '../node/server' (the Node entry)",
      "import '@/node/assets' (the Node entry)",
      'process.env',
    ])
  })
})

describe('no Cloudflare anywhere', () => {
  it('no workspace package depends on the Workers toolchain or runtime', () => {
    const offenders = manifests().flatMap(file => {
      const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8'))
      return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
        .flatMap(field => Object.keys(pkg[field] ?? {}))
        .filter(name => CLOUDFLARE_PACKAGE.test(name))
        .map(name => `${file}: ${name}`)
    })
    expect(offenders).toEqual([])
  })

  it('no package script runs wrangler', () => {
    const offenders = manifests().flatMap(file => {
      const scripts = JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8')).scripts ?? {}
      return Object.entries(scripts as Record<string, string>)
        .filter(([, command]) => /\bwrangler\b/.test(command))
        .map(([name]) => `${file}: ${name}`)
    })
    expect(offenders).toEqual([])
  })

  it(
    'no Cloudflare type, binding or module in src/, tests/ or scripts/',
    () => {
      const files = sources(['src', 'tests', 'scripts'], /\.(tsx?|mjs)$/)
      expect(files.length).toBeGreaterThan(100)
      const offenders = files
        .flatMap(file => cloudflareReferences(file, read(file)))
        .map(f => `${f.file}:${f.line} ${f.what}`)
      expect(offenders, 'read the capability through `Platform` (src/platform/types.ts)').toEqual(
        []
      )
    },
    SCAN_TIMEOUT_MS
  )

  it('no wrangler toml, Worker entry or generated Workers types are left', () => {
    for (const file of [
      'wrangler.toml',
      'wrangler.staging.toml',
      'worker-configuration.d.ts',
      'src/worker.ts',
    ]) {
      expect(existsSync(path.join(WEB_ROOT, file)), file).toBe(false)
    }
  })

  it('sees what it is looking for (the scanner is not vacuous)', () => {
    const probe = [
      "import { DurableObject } from 'cloudflare:workers'",
      '// R2Bucket in a comment is fine',
      "const s = 'Queue in a string is fine'",
      'function f(b: R2Bucket, q: Queue<unknown>, e: Cloudflare.Env) {',
      '  return env.FILES ?? c.env.JOBS_QUEUE',
      '}',
    ].join('\n')
    expect(cloudflareReferences('probe.ts', probe).map(f => f.what)).toEqual([
      "import 'cloudflare:workers'",
      'R2Bucket',
      'Queue',
      'Cloudflare',
      '.FILES',
      '.JOBS_QUEUE',
    ])
  })
})
