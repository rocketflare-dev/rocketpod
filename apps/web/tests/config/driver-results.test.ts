/**
 * D35, narrowed to one driver in Rocketpod: `src/db/client.ts` is the only file that knows the
 * driver (postgres.js), so the driver stays swappable and the request path stays honest about
 * pooled connections. `Database` types `db.execute()` as `unknown`, so most wrong reads are type
 * errors already; what still compiles is a CAST, and that is what this scan refuses.
 *
 * The rules, over every `.ts`/`.tsx` under `src/` (installed plugins included) except
 * `db/client.ts`, which is where the driver's shapes are read:
 * 1. an `execute(…)` result is never cast, indexed or read for `.rows` / `.rowCount` / `.count` /
 *    `.length` — pass it to `rows()` or `affected()` from `@/db/client` instead;
 * 2. no cast to a type literal that gives a `count`, `rowCount` or `rows` member a CONCRETE type
 *    (`as { count?: number }` — a result read by hand, trusting one driver's shape) — `affected()`.
 *    A member typed `unknown` is allowed: the code then has to check it at runtime (the analytics
 *    plugin's own `rowsOf` / `affectedRows`, kept for kits from before `rows()` existed);
 * 3. no driver import (`postgres`, `drizzle-orm/postgres-js`) — `openDatabase` opens the database;
 * 4. no SQLSTATE read by hand (`err.code === '23505'`, `case '40001':` on a `.code`) — drizzle
 *    wraps the driver's error, so `pgErrorCode()` / `isUniqueViolation()` walk the chain;
 * 5. no session state outside a transaction. A request's connection is POOLED — a view of the
 *    Node process pool, or Hyperdrive on the Worker — so a statement-level `SET`,
 *    `set_config(…, false)`, a session advisory lock (`pg_advisory_lock`, not
 *    `pg_advisory_xact_lock`) or a `CREATE TEMP TABLE` leaks into whichever request gets that
 *    connection next. Inside a callback passed to `.transaction(…)`, `transaction(…)` or
 *    `withTenantScope(…)` the connection is held, so it is allowed there. `LISTEN` / `UNLISTEN`
 *    are refused on the request path too: a notification needs a DEDICATED connection, which
 *    only the Node entry's realtime adapter holds (`src/node/`, exempt).
 *
 * This file is half of the driver seam (src/db/CLAUDE.md); `tests/driver/` is the other half.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '../../src')
const EXEMPT = new Set([path.join(SRC, 'db/client.ts')])
/** The Node entry holds connections of its own (the LISTEN connection, M5). */
const EXEMPT_DIRS = [path.join(SRC, 'node') + path.sep]
const DRIVER_MODULES = [/^postgres$/, /^drizzle-orm\/postgres-js(\/|$)/]
const RESULT_MEMBERS = new Set(['rows', 'rowCount', 'count', 'length'])
/** A Postgres SQLSTATE: five characters, a digit class first (`23505`, `40001`, `42P01`). */
const SQLSTATE = /^[0-9][0-9A-Z]{4}$/
/** Session-level state: fine on one held connection, leaked into the next request on a pooled one. */
const SESSION_STATE: Array<[RegExp, string]> = [
  [/^\s*set\s+(?!local\b)/i, 'SET'],
  [/set_config\s*\([^;]*?,\s*false\s*\)/i, 'set_config(…, false)'],
  [/\bpg_(try_)?advisory_lock(_shared)?\s*\(/i, 'a session advisory lock'],
  [/\bcreate\s+(temp|temporary)\s+table\b/i, 'CREATE TEMP TABLE'],
]
const NO_NOTIFICATIONS = /^\s*(listen|unlisten)\b/i
const TRANSACTION_CALLEES = new Set(['transaction', 'withTenantScope'])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : []
  })
}

/** Climb through `await` and parentheses to the expression that consumes the call's value. */
function consumer(node: ts.Node): ts.Node {
  let current = node
  while (ts.isAwaitExpression(current.parent) || ts.isParenthesizedExpression(current.parent)) {
    current = current.parent
  }
  return current.parent
}

function isExecuteCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'execute'
  )
}

/** `x.code` (or `x?.code`), the member a driver error's SQLSTATE sits on. */
function isCodeAccess(node: ts.Node): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression
  return ts.isPropertyAccessExpression(node) && node.name.text === 'code'
}

function isSqlstateLiteral(node: ts.Node): boolean {
  return ts.isStringLiteralLike(node) && SQLSTATE.test(node.text)
}

/** The static text of a `sql\`…\`` template or a `sql.raw('…')` call, placeholders as `$`. */
function sqlText(node: ts.Node): string | null {
  if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === 'sql') {
    const t = node.template
    if (ts.isNoSubstitutionTemplateLiteral(t)) return t.text
    return [t.head.text, ...t.templateSpans.map(span => span.literal.text)].join('$')
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'sql' &&
    node.expression.name.text === 'raw' &&
    node.arguments[0] &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0].text
  }
  return null
}

/** Inside a function passed to `.transaction(…)`, `transaction(…)` or `withTenantScope(…)`. */
function insideTransaction(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) continue
    const call = current.parent
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(current as ts.Expression)) {
      continue
    }
    const callee = call.expression
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : ''
    if (TRANSACTION_CALLEES.has(name)) return true
  }
  return false
}

function findViolations(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const at = (node: ts.Node, message: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    found.push(`${path.relative(SRC, file)}:${line + 1} ${message}`)
  }
  const visit = (node: ts.Node) => {
    if (isExecuteCall(node)) {
      const parent = consumer(node)
      if (ts.isAsExpression(parent)) at(node, 'execute() result cast — use rows() / affected()')
      else if (ts.isElementAccessExpression(parent)) {
        at(node, 'execute() result indexed — use rows()')
      } else if (ts.isPropertyAccessExpression(parent) && RESULT_MEMBERS.has(parent.name.text)) {
        at(node, `execute() result .${parent.name.text} — use rows() / affected()`)
      }
    }
    if (ts.isAsExpression(node) && ts.isTypeLiteralNode(node.type)) {
      const member = node.type.members.find(
        m =>
          ts.isPropertySignature(m) &&
          ts.isIdentifier(m.name) &&
          ['count', 'rowCount', 'rows'].includes(m.name.text) &&
          m.type?.kind !== ts.SyntaxKind.UnknownKeyword
      )
      if (member?.name && ts.isIdentifier(member.name)) {
        at(node, `cast to { ${member.name.text} } — a query result read by hand, use affected()`)
      }
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      DRIVER_MODULES.some(re => re.test((node.moduleSpecifier as ts.StringLiteral).text))
    ) {
      at(node, `imports the driver '${node.moduleSpecifier.text}' — use openDatabase()`)
    }
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        node.operatorToken.kind
      ) &&
      ((isCodeAccess(node.left) && isSqlstateLiteral(node.right)) ||
        (isCodeAccess(node.right) && isSqlstateLiteral(node.left)))
    ) {
      at(node, 'SQLSTATE read by hand — use pgErrorCode() / isUniqueViolation()')
    }
    if (
      ts.isCaseClause(node) &&
      isSqlstateLiteral(node.expression) &&
      isCodeAccess(node.parent.parent.expression)
    ) {
      at(node, 'SQLSTATE read by hand — switch on pgErrorCode(err)')
    }
    const text = sqlText(node)
    if (text !== null) {
      if (NO_NOTIFICATIONS.test(text)) {
        at(
          node,
          'LISTEN / UNLISTEN on a pooled connection — use a queue or the realtime platform member'
        )
      }
      const session = SESSION_STATE.find(([re]) => re.test(text))
      if (session && !insideTransaction(node)) {
        at(
          node,
          `${session[1]} outside a transaction — the connection is pooled, so it leaks into ` +
            'the next request; run it inside db.transaction()'
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('driver-specific code (D35, the driver seam)', () => {
  it('src/ reads raw results, error codes and session state only in driver-agnostic ways', () => {
    const violations = sourceFiles(SRC)
      .filter(file => !EXEMPT.has(file) && !EXEMPT_DIRS.some(dir => file.startsWith(dir)))
      .flatMap(file => findViolations(file, readFileSync(file, 'utf8')))
    expect(violations).toEqual([])
  })

  it('catches the shapes it exists for', () => {
    const sample = `
      import postgres from 'postgres'
      async function f(db: any) {
        const a = (await db.execute(sql\`select 1\`)) as unknown as Row[]
        const b = (await db.execute(sql\`select 1\`))[0]
        const c = (await db.execute(sql\`select 1\`)).rows
        const d = (result as unknown as { count?: number }).count
        const ok = rows(await db.execute(sql\`select 1\`))
        // A reader of BOTH shapes narrows to \`unknown\` and checks at runtime — allowed.
        const { count, rowCount } = result as { count?: unknown; rowCount?: unknown }
        const { rows: maybe } = result as { rows: unknown }
      }`
    const found = findViolations(path.join(SRC, 'sample.ts'), sample)
    expect(found).toHaveLength(5)
    expect(found.join('\n')).toMatch(/imports the driver 'postgres'/)
    expect(found.join('\n')).toMatch(/result cast/)
    expect(found.join('\n')).toMatch(/result indexed/)
    expect(found.join('\n')).toMatch(/result \.rows/)
    expect(found.join('\n')).toMatch(/cast to \{ count \}/)
  })

  it('catches a SQLSTATE read by hand', () => {
    const sample = `
      function f(err: any) {
        if (err.code === '23505') return 1
        if ('40001' !== (err as any).code) return 2
        switch (err.cause.code) { case '40P01': return 3 }
        // Not SQLSTATEs, or not on \`.code\`: allowed.
        if (err.code === 'ECONNREFUSED') return 4
        if (err.status === '23505') return 5
        if (pgErrorCode(err) === '40001') return 6
      }`
    const found = findViolations(path.join(SRC, 'sample.ts'), sample)
    expect(found).toHaveLength(3)
    expect(found.every(f => /SQLSTATE read by hand/.test(f))).toBe(true)
  })

  it('catches session state outside a transaction, and allows it inside one', () => {
    const sample = `
      async function f(db: any, id: string) {
        await db.execute(sql\`SET statement_timeout = 1000\`)
        await db.execute(sql\`select set_config('app.x', \${id}, false)\`)
        await db.execute(sql\`select pg_advisory_lock(42)\`)
        await db.execute(sql.raw('create temp table t (x int)'))
        await db.execute(sql\`LISTEN jobs\`)
        await db.transaction(async (tx: any) => {
          await tx.execute(sql\`select set_config('app.x', \${id}, false)\`)
          await tx.execute(sql\`select pg_advisory_lock(42)\`)
          await tx.execute(sql\`listen jobs\`)
        })
        await withTenantScope(db, id, 'enforce', async (s: any) => s.execute(sql\`SET search_path = x\`))
        // Transaction-scoped, or not a SET statement at all: allowed anywhere.
        await db.execute(sql\`SET LOCAL statement_timeout = 1000\`)
        await db.execute(sql\`select set_config('app.x', \${id}, true)\`)
        await db.execute(sql\`select pg_advisory_xact_lock(42)\`)
        await db.execute(sql\`update t set x = 1\`)
      }`
    const found = findViolations(path.join(SRC, 'sample.ts'), sample)
    expect(found.map(f => f.replace(/^\S+ /, ''))).toEqual([
      expect.stringMatching(/^SET outside a transaction/),
      expect.stringMatching(/^set_config\(…, false\) outside a transaction/),
      expect.stringMatching(/^a session advisory lock outside a transaction/),
      expect.stringMatching(/^CREATE TEMP TABLE outside a transaction/),
      expect.stringMatching(/^LISTEN \/ UNLISTEN/),
      expect.stringMatching(/^LISTEN \/ UNLISTEN/),
    ])
  })
})
