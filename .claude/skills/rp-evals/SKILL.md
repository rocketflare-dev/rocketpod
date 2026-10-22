---
name: rp-evals
description: Write, run and interpret evals for this kit's chat and agents — decide what "good" means, scaffold a suite and starter cases, run pnpm eval, explain failures from the judges' reasoning, compare models or prompts on score/cost/latency, harvest thumbs-down answers into cases, manage baselines and CI, and run a disciplined improve loop. Use when someone says "eval", "evaluate", "is this prompt better", "compare models", "did this change make it worse", "regression", "thumbs down", "golden set", "eval baselines need attention" (the gate's coverage warning), or wants to test AI quality.
argument-hint: "[explain | author <what> | run [suite] | compare <a> <b> | harvest | baseline | improve <suite>]"
---

# Evals — measure whether chat and agents got better or worse

The kit ships a developer-run eval harness (D33, `docs/CONCEPTS.md` §9, how-to in `docs/EVALS.md`).
It lives in `apps/evals` (vitest-evals on vitest 4), runs locally with `pnpm eval`, and is **never
part of the gate**. Its targets run the product's real code in-process against the TEST database
(:5533): the chat target calls the real chat route and the agent target runs the real agent runtime.
Each case gets a tenant of its own with its documents ingested. `reference.md` beside this file has
the judge catalogue, the `EvalCase` schema and the command table. Read it before you author anything.

Pick the mode from `$ARGUMENTS`, or from what the person says. If you can't tell, start with
**Explain**.

**Ground rules, in every mode:**
- **Never edit an `expected` value, a rubric or a baseline to make a case pass.** A gold expectation
  changes only when a person has read the new answer and said it is better. Say what you would
  change and why, and wait.
- **Never weaken a judge** (a lower threshold, a judge removed, `toolsMatch` loosened) without asking.
- **Prompts never overfit to the data that found the bug.** Fix the cause with a general rule, not a
  phrase tuned to the conversation that exposed it. A prompt, its examples and a new gold case never
  reuse that conversation's words, names, numbers or domain. The data that found the bug may replay
  it in a unit test; it does not become a gold case. Before committing a prompt or dataset change,
  search the diff for the source's words. `docs/EVALS.md` § "Avoiding overfitting" has the full list.
- **One run is not a result.** On a five-case suite, run-to-run noise can reach ±0.1 on a judge's
  mean with nothing changed. Compare variants inside ONE run (or back to back, same judge), and
  repeat a run before you believe a delta smaller than that.
- A run costs real tokens. Before a full `pnpm eval`, say roughly how many cases will run and
  suggest a suite filter or `--case` if a smaller run answers the question.
- Promoted cases are **tenant data**. Say so every time one is about to enter the repository.

## Preconditions (check once)

1. `pnpm test:db:up` — the evals use the test database and migrate it themselves.
2. A model key: `ANTHROPIC_API_KEY` in `apps/web/.env` (or in the environment), or
   `FIREWORKS_API_KEY` / `GEMINI_API_KEY` for `--provider fireworks|gemini`. Without one,
   every suite skips and prints why. That is not a failure, but it's not a result either. Say so.
   `EMBEDDINGS_API_KEY` is optional: without it retrieval uses the test stub's deterministic vectors
   plus lexical search, which is fine for the starter cases.
3. `pnpm cli login` is needed only for **Harvest** (`feedback list`, `evals promote` are admin+).

## Explain / orient

Before anything is written, ask **what "good" means** for the surface in one or two sentences, and
**what would make them distrust an answer**. Then map that onto:

| Surface | Target | Typical judges |
|---|---|---|
| Knowledge chat (RAG) | `chatHarness()` | `Trajectory` (did it search, or stay quiet), `Contains`, `Faithfulness`, `Rubric` |
| A tool-calling agent | `agentHarness('<key>')` | `Trajectory`, `Schema` (its output schema), `Faithfulness`, `Rubric` |
| A structured-output agent | `agentHarness('<key>')` | `Schema`, `Contains`, `Rubric`, `Budget` |

Teach the order: **deterministic first** (`Contains`, `Matches`, `Schema`, `Trajectory`, `Budget`).
They are free, instant and never flaky. Add an **LLM judge** only for what a string check can't see:
tone, completeness, grounding. Faithfulness grades against what retrieval **actually returned**, not
against the dataset's documents.

## Author

1. Agree the surface, the target and 3–4 judges with the person, and say why each judge.
2. Draft **5–10 cases** into `apps/evals/datasets/<name>.jsonl`, one `EvalCase` per line:
   happy paths, one "should refuse / should not know", one "should NOT call a tool", one edge
   (too short, multi-turn, ambiguous). Every case must say what good means: `contains`, `tools`,
   `rubric` or `output`. `tests/datasets.test.ts` enforces it. Explain each case in a sentence so
   the person learns the pattern.
3. Write `apps/evals/suites/<surface>/<name>.eval.ts` with `describeCases(...)`, copying
   `suites/chat/knowledge.eval.ts`. A new agent needs nothing else: the target resolves it from the
   registry. A judge that must never average away (the output schema, a tool it must not call)
   goes in `gates` as well as `judges`.
4. Point the prompt's (and the agent's) entry in `packages/shared/src/ai/eval-coverage.ts` at the
   suite, dataset and baseline id (`<surface>-<name>`), with `minCases` = the cases you wrote. Take
   the cases from a different domain than the prompt's own examples (see the ground rules).
5. `pnpm --filter @rocketpod/evals test` (the dataset parses) → `pnpm eval <name>` → **Run & interpret**
   → `pnpm eval:baseline <id>` once the person agrees the run is the new normal.

## Run & interpret

```
pnpm eval [suite] [--case id,id] [--model <id>] [--judge-model <id>] [--compare [baseline|<run.json>]]
```

The terminal shows each case's judge scores, then a table of score / tokens / cost / ms and the run
file `apps/evals/.evals/runs/<ts>-<sha>.json`. For each failing case, read that file (`jq`), not
just the table: `testResults[].assertionResults[].meta.eval.scores[]` gives the judge's
`metadata.rationale` (and `output`), and `meta.harness.run` gives the transcript, tool calls,
`artifacts.retrieved` and usage. Explain in plain language, per case: what was asked, what the model
did (which tools, what it retrieved), which judge failed and **the judge's own reasoning**. Then say
whether the fault is the model, the prompt, the tools/retrieval, or the case itself. Offer
`pnpm eval:view` when a visual walk through transcripts helps. It prints the score diff against the
previous run first. Eval traces are in `ai_spans` tagged `rocketpod.eval=true`
(`pnpm cli traces …` against the test DB is not wired, so read the run file).

## Compare (model vs model, prompt vs prompt)

- Models: `pnpm eval <suite> --model A` then `--model B`, then `pnpm eval:view <runA> <runB>`
  (it prints the diff and serves both). Use the same judge for both, or the comparison is
  confounded.
- Vendors: `--provider gemini` or `--provider fireworks [--model accounts/fireworks/models/…]`
  (keys in `.env`). Their cost shows as "—" (not in the price table), so compare on tokens and
  latency, and say so.
- Prompts: prompts are code (`apps/web/src/api/services/prompts.ts`). Run, change the prompt, run
  again. The run header's `promptVersions` (`<key>@<sha256 12 hex>` of each prompt TEMPLATE)
  proves which text each run used.
- Present a table: mean score, pass count, tokens, cost, total ms per variant, plus the cases that
  moved and why (from the rationales). Recommend one, with the trade-off in a sentence.
- **Noise first.** A delta under ~0.1 on a small suite is inside run-to-run noise. Run each variant
  at least twice (same judge, same cases), report the spread beside the mean, and call a win only
  when it survives the repeat. Say "flat" when it does not, rather than shipping the better-looking
  run. A code change's "before" is best measured from a second checkout: `git worktree add --detach
  <dir> <commit>`, `pnpm install`, `pnpm eval` there (it shares the test database, which evals
  never truncate), on the cases both checkouts have.

## Harvest (from real traffic)

1. `pnpm cli feedback list --rating down` (admin+). Pick candidates with the person.
2. `pnpm cli evals promote <messageId|runId> --dataset <name>`. **Warn that the case is tenant
   data** before it runs, and suggest redacting names, emails and ids in the written line.
3. The draft's `expected.output` is the answer the user **disliked**. Draft a corrected expectation
   and a `rubric` from the feedback comment and the retrieved context, show them, and **stop for
   sign-off on every gold expectation.** Never commit an unreviewed promoted case.

## Baseline & CI

- `pnpm eval:baseline [suite]` writes `apps/evals/baselines/<suite>.json` from the latest run
  (`--from <run.json>` for another). Update it only after reading the run and agreeing it's the new
  normal, with a sentence in the PR saying so. Then `pnpm eval --compare` exits 1 on any per-case,
  per-judge drop over `--threshold` (0.1).
- CI: `.github/workflows/evals.yml` runs on manual dispatch or the `run-evals` PR label, with the
  `ANTHROPIC_API_KEY` repository secret, and uploads the run file. It is outside the gate on
  purpose: a model's variance must never block a merge.

## Coverage contract (when the gate warns or fails)

Every registry prompt and every agent has an entry in `packages/shared/src/ai/eval-coverage.ts`:
a suite, its datasets, its baseline and `minCases`, or `{ exempt: '<reason>' }`. Installed plugins
declare theirs in `SharedPlugin.evalCoverage`. `tests/config/eval-coverage.test.ts` checks it in
`pnpm test` and `pnpm gate` (`docs/EVALS.md` § "The coverage contract").

- **It fails** when a prompt or agent has no entry, an entry names a key nothing registers, a suite,
  dataset or baseline file is missing, or a dataset is below `minCases`. Fix it in the same change.
  For a new prompt or agent, run **Author** (suite, 5+ cases), then a first run and
  `pnpm eval:baseline`. If nothing can measure it yet, write an `exempt` reason a reviewer can
  disagree with, and say so to the person. Never lower `minCases` or delete a case to get under it.
- **It warns** (the `⚠ eval baselines need attention` block printed last) when a baseline's
  `promptVersions` differ from the prompt's current template, or the baseline is provisional (no
  recorded versions). It never fails, because re-baselining spends tokens and needs a person to
  read the run. When it appears after a prompt edit: say how many cases the suggested
  `pnpm eval <suite> && pnpm eval:baseline <id>` will run, run the suite with `--compare baseline`,
  read what moved, and re-baseline only if the person agrees the new answers are at least as good.
  If they are worse, the prompt change is the regression. Never hand-edit `promptVersions` to
  silence the warning: the versions are a claim that the scores were earned by that text.

## Practical traps

- **Infra failures are not quality.** A timeout, `ECONNRESET`, a 429/529 or a provider 5xx fails a
  case without saying anything about the answer, yet the summary's mean counts it as 0 and
  `--compare` reports it as a regression. Read the failed cases' errors (`failure` in the run file)
  before quoting a score, and re-run those cases (`--case`) rather than averaging them in.
- **Throughput is the provider's.** `pnpm eval` runs `--concurrency` suite files at once (2 by
  default, `EVAL_CONCURRENCY`). Raising it mostly buys rate-limit errors (see above). A full run of
  a larger suite set takes minutes, not seconds: suggest a filter or `--case` first.
- **A machine that slept mid-run** leaves timeouts and wall-clock numbers in the thousands of
  seconds. Re-run, and never compare latency (`totalMs`, `BudgetJudge`) across a sleep.
- **The judge is part of the measurement.** Two runs on different `--judge-model`s are not
  comparable. A Rubric verdict that looks wrong is a rationale to read, not a score to average.
- **Datasets are read from source.** `pnpm eval` loads `apps/evals/datasets/*.jsonl` directly
  (nothing copies them into `dist/`), so an edited case is live on the next run. An app that ships
  datasets in its build must make sure a stale copy never shadows the source.

## Improve loop

Only with a target ("Rubric ≥ 0.9 on knowledge-chat") and an iteration cap (default 3).

1. Split the dataset: keep ~⅓ of cases as a **held-out** set (tag them `holdout`), and don't look at
   their failures while diagnosing.
2. Run and mine the failures on the rest. Find the pattern behind them, not the individual cases.
3. Propose **one** change to the prompt, a tool description or the retrieval parameters, explained.
   On a yes, apply it.
4. Re-run the training cases **and** the held-out ones. Keep the change only if the training cases
   improve and the held-out ones don't regress. Otherwise revert it and say what you learned.
5. Stop at the target, at the cap, or when two changes in a row don't help. Report what changed,
   the before/after table, and what is left.

Never edit an expected output or loosen a judge inside this loop. That's gaming, not improving.
And never fix a failure by writing the failing case's words into the prompt: the held-out cases
exist to catch exactly that.
