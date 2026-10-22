# Evals — how-to

Developer-run eval suites for the kit's chat and agents (D33; the rules and known gaps are in
`docs/CONCEPTS.md` §9). They answer one question: **did a prompt, model, tool or retrieval change
make answers better or worse?** They run locally with `pnpm eval`, cost real tokens, and are
**never part of the gate**. The `rp-evals` skill drives every step below and coaches as it goes.

## Setup

1. `pnpm test:db:up`. Evals use the TEST database (:5533, `apps/web/.env.test`) and migrate it
   themselves. They never truncate it, so a test run and an eval run can share it.
2. Put `ANTHROPIC_API_KEY` in `apps/web/.env`. It's the only key the target and the judge need:
   both resolve through the kit's own resolver, on the platform tier. With no key, every suite
   **skips** and says why. `EMBEDDINGS_API_KEY` is optional. Without it, retrieval uses the test
   stub's deterministic vectors and leans on the lexical half of hybrid search. That's enough for
   the starter cases, which share vocabulary with their documents.
3. `pnpm eval`. The first run takes a minute or two for the three starter suites (12 cases), and
   about $0.16 on the default Claude model plus the judge.
4. Optional, to compare vendors: `FIREWORKS_API_KEY` and/or `GEMINI_API_KEY` in `.env`, then
   `--provider fireworks|gemini` (and `--judge-provider`, see below).

Only the model keys (Anthropic, Fireworks, Gemini), the embeddings key and the tracing keys are
read from `.env`. A variable in the environment
(CI's secret) wins over both files. If `LANGFUSE_*` or `OTEL_EXPORTER_OTLP_*` keys are set, eval
traces are exported too, tagged `rocketpod.eval=true`.

## Layout

```
apps/evals/
  kit/            targets (chat, agent), judges, the judge harness, datasets, scoring — import from '../../kit'
  suites/<surface>/<name>.eval.ts     one describeCases(...) per suite
  datasets/<name>.jsonl               one EvalCase per line (packages/shared/src/ai/evals.ts)
  baselines/<suite>.json              committed scores of a known-good run
  .evals/runs/<ts>-<sha>.json         every run's full report (git-ignored)
  tests/          the kit's own unit tests — in the gate
```

It is its own workspace package because vitest-evals needs vitest 4 while `apps/web` is on vitest 3.
The targets import `apps/web` source in-process through the same `@/` alias.

## Write a suite

```ts
// apps/evals/suites/agents/triage-ticket.eval.ts
import { triageTicketOutputSchema } from '@rocketpod/shared/ai/agents'
import { agentHarness, ContainsJudge, describeCases, loadDataset, RubricJudge, SchemaJudge } from '../../kit'

describeCases('agent · triage-ticket', {
  harness: agentHarness('triage-ticket'),
  judges: [SchemaJudge(triageTicketOutputSchema), ContainsJudge(), RubricJudge()],
  cases: loadDataset('triage-ticket'),
  threshold: 0.7, // mean judge score a case must reach
  gates: [SchemaJudge(triageTicketOutputSchema)], // must score exactly 1, whatever the mean
})
```

```jsonl
{"id":"billing-refund","input":{"subject":"Charged twice","body":"…"},"expected":{"contains":["billing"],"rubric":"Routes to billing with high priority; quotes the duplicate charge."}}
```

- **The case carries its own expectations.** The harness input IS the `EvalCase`, so each judge reads
  `expected.contains | tools | toolsMatch | rubric | output` from the case. A judge is attached only
  to cases that declare something for it, because vitest-evals averages a `null` score as 0.
- **Each case runs in a tenant of its own**, with its `context` documents ingested first, so
  retrieval can only find what the case put there. Chat `messages` are seeded as the thread's
  earlier turns.
- **A gate is a judge a case must pass outright.** List it in `gates` (and in `judges` too if its
  score belongs in the run file and the baseline): a broken schema, or a tool the case must never
  call, then fails the case instead of averaging away against the judges that passed.
- 5–10 cases per suite: happy paths, one the model should refuse or not know, one that should call
  **no** tool (`"tools": [], "toolsMatch": "strict"`), and one edge case.

## Pick judges

Deterministic judges first: they're free, instant and never flaky. Use an LLM judge only for what a
string can't check.

| Want to check | Judge |
|---|---|
| a fact appears | `ContainsJudge()` + `expected.contains` |
| the output has the declared shape | `SchemaJudge(schema)` |
| it searched (or didn't), in what order | `TrajectoryJudge(mode)` + `expected.tools` / `toolsMatch` |
| latency, tokens, cost | `BudgetJudge({ maxMs, maxTokens, maxCostUsd })` |
| its typed decisions (`ctx.decide`, D37) came out right — and how well calibrated | `DecisionJudge()` + `expected.decisions` (scored from `agent_run_decisions`, no model call; Brier in the rationale). `suites/agents/triage-research.eval.ts` is the example; run it with and without `TYPESAFE_API_KEY` to compare Jev with the chat-model fallback |
| criteria in plain language | `RubricJudge()` + `expected.rubric` |
| every claim is grounded in what it retrieved | `FaithfulnessJudge()` |
| it agrees with a reference answer | `ReferenceJudge()` + `expected.output` |

The full catalogue, with scoring, is `.claude/skills/rp-evals/reference.md`. LLM judges run
through the `evals-judge` prompt (Settings → Prompts), on whatever model Settings → Agent models
assigns it, or on `--judge-model <id>` for one run. Every judge call is costed in `ai_usage`
(feature `evals.judge`) and never counted in a case's own spend.

## Run and read

```
pnpm eval                          # everything
pnpm eval knowledge --case refund-window,not-covered
pnpm eval agents --model claude-haiku-5-5 --judge-model claude-opus-5-5
pnpm eval knowledge --provider gemini                      # gemini-2.5-flash as the target
pnpm eval knowledge --provider fireworks --model accounts/fireworks/models/gpt-oss-120b
pnpm eval knowledge --judge-provider gemini                # a non-Claude judge
```

`--provider anthropic` (the default) is the resolver's platform tier. `fireworks` and `gemini`
write a real, encrypted `ai_configs` row on each case's tenant (Fireworks through the kit's own
`fireworks` preset, which is exactly what Settings → AI offers a tenant; Gemini as
`openai_compatible` at Google's OpenAI-compatible endpoint), so those runs also exercise the
tenant-config tier. `--model` picks a model on that
provider. Fireworks serverless availability varies by account, so pick one your key can call.
Neither vendor is in the kit's price table, so their cost reads "—". Hold the judge constant when
comparing targets.

Each case prints its judge scores. The run ends with a table of score, tokens, cost and
milliseconds, plus the path of the run file. For a failure, the run file has the judge's
`rationale`, the transcript, the tool calls and exactly what retrieval returned.
`pnpm eval:view` prints the per-judge score diff against the previous run (or two named runs, or
`--compare baseline`), then opens the vitest-evals report UI over the runs to walk the transcripts.

## Baselines

1. Run, read the results, and agree they're the new normal.
2. `pnpm eval:baseline [suite]` writes `apps/evals/baselines/<suite>.json` from the latest run
   (`--from <run.json>` to pick another). Commit it, with a sentence in the PR saying why.
3. From then on, `pnpm eval --compare` (or `--compare <run.json>`) prints regressions per case and
   judge, and exits 1 when one drops by more than `--threshold` (0.1).

Never refresh a baseline to make a comparison pass. A baseline is a claim about quality, not a
snapshot of the last run.

A baseline also records `promptVersions`: `<key>@<first 12 hex of sha256>` of each prompt
TEMPLATE its suite ran (`promptVersion`, `apps/web/src/api/services/ai/prompt-version.ts`). That is
what the gate's coverage check compares with the prompt's current text.

## The coverage contract

Every prompt in the registry and every registered agent says how its quality is measured, in
`packages/shared/src/ai/eval-coverage.ts`: the suite file, its datasets, its baseline and the fewest
cases each dataset may hold. Or it says why nothing measures it (`{ exempt: '<reason>' }`, which a
reviewer reads). `apps/web/tests/config/eval-coverage.test.ts` checks it in the gate, with no model
call and no database:

- **Fails**: a registered prompt or agent with no entry, an entry for a key nothing registers, a
  suite, dataset or baseline file that is missing, or a dataset below its `minCases`. Fix it in the
  same change that added the prompt or agent. Write the suite (`rp-evals` → Author), or add an
  exemption with an honest reason.
- **Warns, never fails**: a baseline whose `promptVersions` differ from the prompt's current
  template (you edited the prompt), or a **provisional** one (`"provisional": true`, or no
  `promptVersions` at all, as with a baseline written before versions were recorded). The warning
  names the command that refreshes it (`pnpm eval <suite> && pnpm eval:baseline <id>`). The test
  writes the lines to `apps/evals/.evals/gate-warnings.txt`, and `pnpm test` and `pnpm gate` print
  them last (`scripts/lib/eval-warnings.mjs`; a file older than the run is ignored). Re-baselining
  spends tokens and needs someone to read the run, so the gate never does it. When the warning
  appears: run the suite, read it (`--compare baseline` against the old scores), and re-baseline
  only if the new answers are at least as good. If they are worse, the prompt change is the bug.

The kit's own entries: `chat` → `suites/chat/knowledge.eval.ts`; each example agent and its prompt →
`suites/agents/<key>.eval.ts`; `agent-decide` → the triage-research suite, whose `DecisionJudge`
measures the chat-model fallback when `TYPESAFE_API_KEY` is unset (the agent target then records
that prompt's version too); `chat-compaction` and `evals-judge` are exempt. The three committed
baselines carry `promptVersions` recorded without a model run, because each prompt's template is
unchanged since the run that wrote them (`sha` 2d41fc1). `agents-triage-research.json` is a
provisional placeholder with no cases, so a fresh kit warns about `triage-research` and
`agent-decide` until somebody runs that suite and baselines it.

**A plugin's prompts and agents** are registered too, so they need entries. The plugin declares them
for its OWN keys in `SharedPlugin.evalCoverage` (`{ prompts?, agents? }`, same entry shape). A
plugin cannot write under `apps/evals`, so it usually declares an exemption. An app that writes a
suite for a plugin's prompt adds the entry to the core map, which overrides the plugin's. A plugin
covering a key it does not own fails the gate.

## Real traffic: thumbs and promotion

People rate answers in the UI (thumbs on chat replies and on run output → `POST /api/feedback`). An
admin turns a bad one into a case:

```
pnpm cli feedback list --rating down
pnpm cli evals promote <messageId|runId> --dataset knowledge-chat
```

The draft contains the question, the earlier turns, the passages retrieved, the tools called and
the **observed** answer as `expected.output`. That's the answer somebody disliked, so correct it and
write a rubric before committing (the `rp-evals` skill drafts both and waits for your sign-off). **A
promoted case is tenant data**: the command refuses to write without `--yes` or a confirmed prompt.
Redact names and emails before the line enters the repository.

## CI (optional)

`.github/workflows/evals.yml` runs `pnpm eval --compare` on manual dispatch, or on a pull request
labelled `run-evals`, with the `ANTHROPIC_API_KEY` repository secret. It uploads the run file as an
artifact. It is outside the gate on purpose: model variance must never block a merge.
