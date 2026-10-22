---
name: rp-doc-sync
description: Bring the in-app Guide back in line with the code it describes. Use after changing code a Guide page claims (the Stop hook says "run /rp-doc-sync before committing"), when `pnpm web docs:stale` lists stale pages, or when asked to sync, check or audit the Guide, its facts or its screenshots. `/rp-doc-sync` fixes the stale set incrementally; `/rp-doc-sync audit` sweeps every page and proposes edits without applying them.
argument-hint: "[audit]"
---

# rp-doc-sync

Every Guide page (`apps/web/content/guide/**/*.md`, not a root `VOICE.md`/`README.md`, not `_*/`
directories) carries frontmatter naming the code it describes and when someone last checked it:

```yaml
sources: [apps/web/src/ui/pages/settings/People.tsx, packages/shared/src/tenants.ts]
verified: 790a55b   # the commit at which this page was last checked against its sources
```

`pnpm web docs:stale` lists every page whose sources changed after `verified`, with a diffstat (a
commit that also touches the page counts as a check). The engineering docs (`docs/CONCEPTS.md`,
`.claude/rules/*`) carry no frontmatter and are kept in sync by the "Docs in sync" rule instead.
How the Guide works mechanically is `docs/CONCEPTS.md` § The Guide.

## The rules

- **The code is the truth.** When a page and the code disagree, the code wins. Read the code, not
  a comment or an issue about it.
- **Never write a line number into a page.** Name a command, a screen, a flag.
- **Never inventory a directory**, and keep `sources:` globs coarse.
- **One owner per fact.** A number, limit, exit code or on-screen name that code owns is
  `{{fact:key}}`, resolved from `apps/web/src/api/services/guide-facts.ts` — import the real
  constant there from `@rocketpod/shared` (a CLI constant, or one in a heavy server module, is a
  PINNED literal plus its line in `apps/web/tests/config/guide-facts.test.ts`). Never type the
  value into prose.
- **Describe what the product does today.** What `docs/CONCEPTS.md` lists under "Known gaps" is not
  built — say "not built yet" when a reader would expect it.
- **No tenant data.** The Guide is the same for every organisation: invented, obviously
  illustrative examples only, never a real customer, person or document.
- **A `member` page never links to an `admin` page** (its reader would get a 404) — the staleness
  test fails it. Say it in words instead, or write the member-facing part on the member page.
- **Never polish prose the diff did not touch.** If the app has a `VOICE.md` beside the pages, it
  is the register.

## `/rp-doc-sync` (incremental)

1. **Gather.** `pnpm -C apps/web -s docs:stale --json` →
   `{ stale: [{ doc, verified, files }], errors }`. Fix `errors` first (a missing field, a glob
   that matches nothing — point it at where the code went — or an unknown sha). Add pages the
   session is editing: `pnpm -C apps/web docs:stale --changed`.
2. **Read the diff, then the page.** `git diff <verified>..HEAD -- <files>` plus the working tree.
   List every claim in the page the diff touches: behaviour, commands and flags, names, limits,
   who sees what, the order of steps.
3. **Check each claim against the code as it is now.** Leave a right claim alone.
4. **Rewrite in the page's register**, only the claims that changed.
5. **Fact-check with a SEPARATE sub-agent** (the edited pages, the diff, a file allowlist; ask it to
   verify every changed sentence against the code). Fix what it finds.
6. **Screenshots.** `pnpm -C apps/web guide:shots --stale` reshoots entries whose `sources` changed.
   It needs `pnpm dev` up with the demo seed (`pnpm seed --demo`) and Playwright (the script says
   how to install it); say so if either is missing — never skip it silently. Look at each `changed`
   image before accepting it.
7. **Vectors.** A page edit needs NO re-index to ship: the server chunks the pages at boot and the
   edited chunks are keyword-searchable at once. To make them searchable by meaning again,
   `pnpm -C apps/web guide:index --dry-run` says how many chunks would be embedded; only with the
   user's go-ahead (it calls a real embeddings API and costs money — a little) run
   `pnpm -C apps/web guide:index` and commit `apps/web/content/guide/embeddings.jsonl.gz`. Never
   run it without a platform `EMBEDDINGS_API_KEY`, and never hand-edit the file.
8. **Bump `verified`** to `git rev-parse --short HEAD` on every page you checked.
9. **Repeat `docs:stale` until clean**, then `pnpm gate`. A behaviour change the Guide describes
   also gets its `docs/upgrades/unreleased.md` entry, like any other change (CLAUDE.md).

Report the pages checked, the claims changed (page, old, new, and the code that proves it), the
screenshots rewritten, and whether the vectors were rebuilt.

## `/rp-doc-sync audit` (whole Guide)

A report plus proposed edits — never silent rewrites; apply only after the user agrees.

1. **Repetition sweep**: the same fact stated in two pages → name the owner, propose a link or a
   `{{fact:}}`. Flag pages drifting into internals a user never touches.
2. **Drift sweep**: check every page against the code regardless of `verified` — one sub-agent per
   part with a file allowlist, a separate agent spot-checking their findings. Look for behaviour
   that changed outside the declared `sources` (propose wider globs) and dead links.
3. **Screenshot sweep**: `pnpm -C apps/web guide:shots` (everything); every `shot:` reference has a
   manifest entry and every entry is used.
4. **Report** grouped by page.

## Tools

| command | what it does | spends money |
|---|---|---|
| `pnpm web docs:stale [--changed] [--json] [--quiet]` | stale pages + structural errors; non-zero only on errors | no |
| `pnpm web guide:shots [--only id,…] [--stale]` | reshoots manifest entries on the local dev server | no |
| `pnpm web guide:index [--dry-run]` | embeds new or edited chunks into `embeddings.jsonl.gz` | yes, a little (never with `--dry-run`) |
| `pnpm web guide:load` | loads the pages (and vectors) into `guide_chunks` now (the server also does it at boot) | no |
