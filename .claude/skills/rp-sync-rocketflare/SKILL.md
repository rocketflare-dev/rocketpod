---
name: rp-sync-rocketflare
description: Kit repository only. Port the Rocketflare releases Rocketpod has not caught up with yet — finds them from docs/FORK.md, plans the order, ports each release by hand onto the Node/Postgres platform with its tests, records FORK.md rows and the porting note, verifies on the real stack, and cuts the matching Rocketpod release. Use when someone asks to sync, catch up with, pull in or port Rocketflare.
argument-hint: "[--to <rocketflare version>]"
---

# /rp-sync-rocketflare — catch Rocketpod up with Rocketflare

Rocketpod is a hard fork of Rocketflare (`docs/FORK.md`): **concept parity, not code parity**.
Rocketflare releases are ported by hand, one release at a time, and Rocketpod then releases under
the version of the Rocketflare release it has caught up with. This skill is the whole procedure.
The translations, mappings and templates are in [`reference.md`](reference.md). Read it before
step 3.

This is a maintainer's skill. It is `kitOnly` (`.rocketflare.json`), so the rename deletes it and a
copy never sees it. A copy upgrades from Rocketpod releases with `/rp-upgrade` instead.

## Ground rules

- **Port by hand, by meaning.** Read upstream's note and diff, then write Rocketpod's code against
  its own seams (`platform.*`, pg-boss, OpenWorkflow, S3, Helm). Never copy a migration file, a
  toml, or a `@cloudflare/*` import.
- **Release order, one release per commit** (adjacent small ones may share one). Later releases
  patch earlier ones, so a gate failure stays attributable.
- **Every upstream test ports**, translated, or the FORK.md row says why not. Never weaken a test
  to make it pass. `.claude/rules/testing.md` still decides what counts as a test.
- **The user decides collisions.** When upstream ships something Rocketpod already does its own
  way (Rocketpod's `/mcp` was the first), stop and ask with `AskUserQuestion`. Give the options and
  a recommendation. Never silently replace a Rocketpod-only feature.
- **Outward actions need a yes.** Pushing, opening or merging a PR, tagging and publishing a
  GitHub release each need the user's approval in this conversation.

## 0. Where things stand

```bash
RF=${ROCKETFLARE_DIR:-$HOME/work/rocketflare}
git -C "$RF" fetch -q --tags origin && git -C "$RF" status -sb | head -1   # clean, on main
tail -3 docs/FORK.md | cut -c1-80          # the last Rocketflare version ported
git -C "$RF" tag --sort=v:refname           # every release; the pending ones follow FORK.md's last
```

For each pending release, print its size and the first paragraph of its "What changed":

```bash
prev=<last ported>; for v in <pending…>; do
  echo "== $v $(git -C "$RF" diff --shortstat $prev..$v)"
  awk '/^## What changed/{f=1;next} /^## How to apply/{f=0} f' "$RF/docs/upgrades/$v.md" | head -3
  prev=$v; done
```

Tell the user what is pending, what is large, and anything that collides with Rocketpod's own
work. Also check `docs/upgrades/unreleased.md` here: Rocketpod-only changes waiting there ship
with this port.

## 1. Branch

From an up-to-date `main`: `git checkout -b port/rocketflare-<target version>`. Use Node 26: prefix
every `pnpm` command with `export PATH=$HOME/.nvm/versions/node/v26.<x>/bin:$PATH;` when the shell's
`node -v` is older, because `pnpm test` refuses Node < 26.

## 2. Plan the order

Group the pending releases in release order. A big release gets a step of its own, and patch
releases may ride with their minor. For each group, note the Cloudflare-only parts to skip and the
translations that apply (reference.md § Translations). A group that needs a decision (step 0)
waits for it.

## 3. Port each group

Give each group to one subagent, **sequentially**, never in parallel: every group edits the same
schema, config and docs, and two gates on one test database wipe each other (§ Problems we hit).
Use the brief in reference.md § Subagent brief. Each subagent leaves a commit with the gate passed
and reports what it translated, skipped and was unsure of. Read every report. Carry new mappings
into the next brief, and check its claims (`git show --stat`, `.gate/last.json`) before
starting the next group.

Each group's commit carries:
- **Code, schema and tests.** Schema goes through `apps/web/src/db/schema/` → `pnpm db:generate`
  with a descriptive name → `pnpm db:migrate`. A new tenant table calls `tenantIsolation()`.
- **Config, everywhere it lives.** Each new key goes into `src/config.ts`, `.env.example`, Helm
  `values.yaml` and compose when it needs it (`packaging.test.ts`).
- **Docs.** CONCEPTS, DEPLOY, the rules and the per-directory `CLAUDE.md` files, in Rocketpod's own
  words. Regenerate `docs/plugin-api.md` when a declared plugin entry changed. Fix the Guide pages
  `pnpm web docs:stale` flags.
- **The record.** Add a section to `docs/upgrades/unreleased.md` (What changed / How to apply /
  Conflicts / Verify, in Rocketpod paths) and one row per release in `docs/FORK.md`, in the style
  of the rows above it: ported, translated, not ported, and why.

## 4. Check the whole branch

1. Run `pnpm gate` yourself on the tip with **nothing else touching the test database**. Judge
   it by `✔ pnpm gate passed` and `.gate/last.json` (`passed`, `full`, `sha` = HEAD, `dirty: false`).
2. When a release changed the runtime (runs, jobs, cron, realtime, auth flows), verify it on the
   real Node stack: reference.md § Verifying on the Node stack. Fix what it finds with a
   regression test, then gate again.
3. Read the FORK.md rows and the `unreleased.md` sections once more against the commits.

## 5. Pull request

With the user's approval: push, `gh pr create` (what came over, what was translated, deploy
notes, verification, what was not done), then `gh pr checks <n> --watch`. Merge with a merge
commit (`gh pr merge <n> --merge`) once every check is green and the user has said to merge.

## 6. Release

The version is the Rocketflare version caught up with (`docs/FORK.md`, "Versions match
Rocketflare's"). With the user's approval, on an up-to-date `main`:

1. `pnpm kit:release <version> --dry-run`, then without `--dry-run`.
2. **Condense the note.** The folded `docs/upgrades/<version>.md` carries one section per
   Rocketflare release, written for porting Rocketflare, but its readers are Rocketpod copies
   running `/rp-upgrade`. Rewrite it into the four headings and ≤ 150 lines, following
   reference.md § The release note. The detailed text stays reachable through
   `git show <merge sha>:docs/upgrades/unreleased.md`.
3. Make the `CHANGELOG.md` line the note's new first paragraph.
4. Run `node scripts/release-check.mjs --tag <version>`, `pnpm web test:kit-only` and `pnpm gate`.
5. `git add` the note, the changelog, `package.json`, `.rocketflare.json` and `unreleased.md`;
   `git commit -m "Release <version>"`; `git tag -m "Release <version>" <version>`;
   `git push origin main <version>`.
6. `gh release create <version> --verify-tag --latest` with notes in the style of the previous
   release (`gh release view <previous>`).
7. Watch the tag's Image workflow (`gh run list`, `gh run watch <id> --exit-status`). A
   tag is a release and pushes the image.

## Problems we hit

- **Two test runs at once wipe each other.** Every vitest run's global setup truncates the test
  database once. A lone test file run while the gate runs deletes the gate's seeded tenant, and
  20 unrelated tests fail with missing rows. Run one thing at a time against `:5533`.
- **Timeouts under load.** On a loaded machine (load average 25+) a 5 s test timeout trips in
  files the port never touched. Run that file alone. If it passes, run the gate again; never raise
  a test's limit.
- **Eval baseline warnings** printed after the verdict are warnings, not failures. Clearing them
  needs `pnpm eval` against real models, which costs money: say so, don't run it unasked.
- **A new prompt or agent** needs an eval suite or an exemption in
  `packages/shared/src/ai/eval-coverage.ts`, or the coverage contract fails the gate.
- **Lint fails on warnings** (since 0.39.0). Fix them; never add ignores without a reason line.
- **A test sweeping across every tenant** (sweepers, prunes) settles other files' rows in the
  full suite. Scope it to its own run or tenant (`sweepRun`, not `runSweepLostRuns`).
- **Don't trust a subagent's summary over the tree.** Check commits, `git status` and
  `.gate/last.json` yourself.
