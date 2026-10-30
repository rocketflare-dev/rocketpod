# The driver conformance suite

This directory proves the driver seam (`src/db/CLAUDE.md`): what app code sees through
`src/db/client.ts` — a raw result's shape, a raw array's value, a driver error's code, transaction
semantics — holds, whichever way the connection is held (a per-request client, or a view of the
Node entry's process pool). There is one driver (postgres.js); `pnpm test` runs
the suite in every gate as the vitest project `driver`. It ships to every copy.

- **Each test states ONE fact** about the seam: the same input, the same expected value.
- **No `skip`, `skipIf`, `runIf`, `todo` or `only`, and no branching on the driver inside a
  test.** `tests/config/driver-conformance.test.ts` fails all of them.
- **A failing test means the seam has a hole.** Fix `src/db/client.ts` (normalise it) or
  `tests/config/driver-results.test.ts` (ban the pattern). Never weaken the test.
- **Everything goes through `openDatabase`**, the request path, never the handle scripts and
  fixtures get. Probe both a plain query and the same thing inside `db.transaction(…)`.

```bash
pnpm web test:driver
```
