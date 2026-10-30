# Durable agent runs

`agent-run-body.ts` — `runAgentRun(params, step, { env, platform })`, the agent run's durable body
against the neutral `Step` (`src/platform/types.ts`). OpenWorkflow drives it on Node
(`src/node/runs.ts`, workflow name `agent-run`); tests drive it with `tests/mocks/step.ts`.

Shape: `step.do('claim')` → a LOOP of `step.do('execute#N', { retries: { limit: 2, delay:
'10 seconds', backoff: 'exponential' }, timeout: '10 minutes' })` and, whenever that returns
`awaiting_input`, `step.waitForEvent('resume#N', { type: AGENT_RESUME_EVENT, timeout:
cfg.AGENT_INTERRUPT_TIMEOUT })` → `step.do('finish')`. The bodies are plain functions in
`../services/agents/runtime.ts` (`claimStep` / `executeRun` / `finishStep`, called with a `db` and the
`Platform`); `runAgentRun` only wires steps and opens/closes ONE DB client per step (`withStepDatabase`, awaited `close()` in `finally`). Step return
values are small serialisable objects (ids + status), never rows. Tracing: `execute#N`
passes `{ round }` so the attempt's span is named for its step, and only `finish` passes `{ cfg }`
to `finishStep`, which records the run's root span — one root per run, so the `expire#N` call
must not.

**A step name is its IDENTITY to the platform**, so every name inside the loop carries its round.
A fixed `'execute'` called a second time replays the first call's cached result — the run re-asks
the question it already had answered, and the bug reads as "the agent ignored my approval". Nothing
in a Node suite can catch that; `tests/api/agent-run-workflow.test.ts` asserts the recorded names
are distinct per round, which is the closest we get.

Three more things the loop holds:

- **The resume payload is ignored on purpose.** The answer is already an `agent_run_interrupts` row,
  written by the resolve route, which also flips `awaiting_input → running` BEFORE it wakes the
  instance. `execute#N+1` re-enters `run()` from the top and reads it. That is what
  lets `nudgeOrRestartInstance` create a fresh instance when the old one is gone — a new instance
  has no event to replay and needs none. `AGENT_RESUME_EVENT` (`'agent-resume'`) is a constant, with no `.`,
  which some run engines reject (`workflow.invalid_event_type`).
- **The `try/catch` around `execute` lives inside the loop and clears `outcome`** — a previous
  round's `awaiting_input` falling through to `finish` would say the run is parked when it is not.
- **`MAX_INTERRUPT_ROUNDS` (32)** ends a runaway agent `failed`. A correctness guard, not a capacity
  one: OpenWorkflow allows 1,000 step attempts a run and a round costs two steps.

**The whole tool loop lives in the ONE `execute` step by decision, not by omission** — one `step.do`
per model turn was investigated and rejected (`docs/CONCEPTS.md` §9 Known gaps). Steps do not nest,
so it needs `run()` outside a step, and the engine replays everything outside a step. Wall clock per
step is unlimited, so a long run is a bigger `timeout`, not more steps.

Rules: idempotent steps (the `agent_runs` row is the claim); cooperative cancel (poll the row between
turns); no `waitUntil` — await everything, including nudges (`createStepRealtime().settle()`).
`pnpm dev` runs the engine locally; inspect a run in the `openworkflow` schema
(`workflow_runs`, `step_attempts`) by the `instanceId` on its `agent_runs` row.

Testing: `tests/api/agent-run-workflow.test.ts` drives `runAgentRun` with `createTestEnv()` and
`createFakeStep(options)` (`tests/mocks/step.ts`) and asserts on the rows.
The fake's `waitForEvent` is a recorder: `{ events?, onWait? }` in, `{ step, calls, waits, names,
queueEvent }` out. `onWait` is the test's stand-in for the resolve route (write the answer, flip the
row, return a payload); an empty queue with no `onWait` rejects the way the platform's timeout does,
which is how the expiry path is driven. `names` is every step name in call order.

## On Node: OpenWorkflow

`src/node/runs.ts` runs `runAgentRun` (`agent-run-body.ts`) on OpenWorkflow, through
`openWorkflowStep`. The body must stay engine-neutral (only the `Step` interface), and two rules
keep it correct on OpenWorkflow:

- **Every `catch` around a step rethrows engine control flow first**:
  `if (step.isControlFlow?.(err)) throw err`. OpenWorkflow parks a run by THROWING out of
  `waitForEvent`; swallowing that turns every park into a timeout.
- **Every `waitForEvent` whose event can arrive before the wait passes `arrived`** — a check that
  the effect already landed (here: the row left `awaiting_input`). OpenWorkflow drops a signal
  nobody is waiting on, so without it a fast answer is lost.

Retries are in-process on Node (one OpenWorkflow step per `step.do`, with the policy applied
inside it), and a step that ran out of retries replays its recorded error. A repeated step name is
auto-suffixed rather than replayed, so the per-round names are still required — a suffixed name
would run a round's step again instead of returning its result.
`tests/api/node-runs.test.ts` drives the engine: crash replay, retries, timeouts, park and resume,
the signal race, terminate, and the agent run end to end.

