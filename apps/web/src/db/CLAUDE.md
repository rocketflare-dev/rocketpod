# Database access

`client.ts` opens a database (`openDatabase(env)`, one handle per request), `tenant-scope.ts` wraps
tenant-scoped work (`withTenantScope`, `docs/RLS.md`), `schema/` holds the tables (its own
CLAUDE.md). Rules for queries: `.claude/rules/database.md`.

## The driver seam

The app runs on postgres.js (D35, narrowed in Rocketpod — Rocketflare's Neon serverless driver was
removed). A request's handle is either a view of the Node entry's ONE process pool
(`installProcessPool`, `src/node/server.ts`; its `close()` is a no-op) or, on the Worker, a client
of its own over Hyperdrive. **App code knows neither.** `client.ts` is the ONLY place the driver
is named, and three things hold that:

- **`client.ts` normalises**: a raw result's shape (`rows()`, `affected()`), a raw array's value
  (`ARRAY_PARSERS` — postgres.js runs with `fetch_types: false`, so arrays are parsed here), a
  driver error's SQLSTATE (`pgErrorCode()`, `isUniqueViolation()`).
- **`tests/config/driver-results.test.ts` bans** (an AST scan over `src/`, installed plugins
  included; `src/node/` exempt):

  | Banned outside `client.ts` | Use instead |
  |---|---|
  | a cast, index or `.rows`/`.rowCount`/`.count`/`.length` on an `execute()` result | `rows(result)`, `affected(result)` |
  | a driver import (`postgres`, `drizzle-orm/postgres-js`) | `openDatabase(env)` |
  | a SQLSTATE read by hand (`err.code === '23505'`, `case '40001':`) | `isUniqueViolation(err)`, `pgErrorCode(err) === '40001'` |
  | session state outside a transaction: a statement `SET`, `set_config(…, false)`, `pg_advisory_lock`, `CREATE TEMP TABLE` — the connection is pooled, so it leaks into the next request | run it inside `db.transaction(…)` / `withTenantScope(…)`, or use the transaction-scoped form (`SET LOCAL`, `set_config(…, true)`, `pg_advisory_xact_lock`) |
  | `LISTEN` / `UNLISTEN` on the request path | a queue job or the realtime platform member |

- **`tests/driver/` proves it**: the conformance suite, run by every `pnpm test` — through a
  per-request client and through a view of the process pool.

**A failing conformance test is a seam bug. Fix `client.ts` or the guard, never the test.** Never
skip it or `skipIf` it. `tests/config/driver-conformance.test.ts` fails both.

When you find a new divergence:
1. Reproduce it in `tests/driver/` as a fact that fails.
2. Normalise it in `client.ts`. If it cannot be normalised, add a rule to
   `driver-results.test.ts` that bans the pattern, with the replacement in its message and a row
   in the table above.
3. Add a porting note, because a copy's own code may already contain the pattern.

Raw date/time values are Postgres's text: drizzle keeps them unparsed so its column mappers can.
Code reading a timestamp from raw SQL parses it itself (`new Date(value)`). The query builder
returns `Date`s.
