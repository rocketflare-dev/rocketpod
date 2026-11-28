---
version: unreleased
previous: 0.46.0
date: null
breaking: false
migrations: []
areas: [tooling]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

`pnpm kit:release` releases a version a version file already carries, instead of refusing it: a merge of an upstream kit's release tag can bring the bump in first.

- `scripts/release.mjs`: a version file already at the release version is stamped as it is; a file with no version field is still an error (`tests/kit-only/release-stamp.test.ts`).

## How to apply

1. Take the `scripts/release.mjs` hunk as it is.

## Conflicts to expect

None.

## Verify

1. `pnpm test kit-only apps/web/tests/kit-only/release-stamp.test.ts` passes.
