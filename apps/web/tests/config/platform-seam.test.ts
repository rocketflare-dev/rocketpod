/**
 * The platform seam (M1, `src/platform/types.ts`): no Cloudflare type, binding or module escapes
 * the adapters. Routes, services, queue handlers, cron tasks and the agent-run body depend on the
 * neutral interfaces and read `c.get('platform')`; only the places that ARE the Worker may name the
 * platform — the adapters in `src/platform/cloudflare/`, the entry (`src/worker.ts`) and the two
 * classes it exports (the Durable Object and the Workflow shim).
 *
 * That is what lets a second runtime replace the adapters and the entry and leave everything else
 * alone. A source scan on the model of `driver-results.test.ts`: tokens, not text, so a comment or
 * a string that mentions `R2Bucket` is fine and a type annotation is not.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { WEB_ROOT } from '../helpers/source-files'

/** Where the Worker may be named. Everything else under `src/` is platform-neutral. */
const ALLOWED = [
  /^src\/platform\/cloudflare\//,
  /^src\/worker\.ts$/,
  /^src\/api\/durable-objects\/notifications-hub\.ts$/,
  /^src\/api\/workflows\/agent-run\.ts$/,
]

/** Cloudflare's global types (from `worker-configuration.d.ts`) and the `Cloudflare` namespace. */
const CLOUDFLARE_TYPES = new Set([
  'Ai',
  'Cloudflare',
  'DurableObject',
  'DurableObjectNamespace',
  'DurableObjectState',
  'DurableObjectStub',
  'ExecutionContext',
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

/** Tracked AND untracked sources, so a file is scanned the moment it is written. */
function sources(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src'],
    { cwd: WEB_ROOT, encoding: 'utf8' }
  )
  return out
    .split('\n')
    .filter(f => /\.tsx?$/.test(f))
    .filter(f => existsSync(path.join(WEB_ROOT, f)))
    .sort()
}

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

describe('the platform seam', () => {
  it('keeps every Cloudflare type, binding and module inside the adapters and the Worker entry', () => {
    const offenders = sources()
      .filter(file => !ALLOWED.some(re => re.test(file)))
      .flatMap(file => cloudflareReferences(file, readFileSync(path.join(WEB_ROOT, file), 'utf8')))
      .map(f => `${f.file}:${f.line} ${f.what}`)
    expect(offenders, 'read the capability through `Platform` (src/platform/types.ts)').toEqual([])
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

  it('allows the adapters to name the platform', () => {
    expect(
      ALLOWED.some(re => re.test('src/platform/cloudflare/storage.ts')) &&
        ALLOWED.some(re => re.test('src/worker.ts'))
    ).toBe(true)
  })
})
