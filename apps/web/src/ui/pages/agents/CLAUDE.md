# Agents UI (`/agents`, `/agents/runs/:runId`)

`AgentsPage` (roster + runs table) and `RunPage` (its OWN lazy chunk), both `read AgentRun`. Also
covers `hooks/useAgents.ts`, `hooks/useRunStream.ts`, `hooks/useNavBadges.ts`,
`lib/runAguiStream.ts`, `lib/notificationLink.ts`. Polling and the `['agent-run-agui']` cache rule
are in `.claude/rules/ui.md`.

`hooks/useAgents.ts`: `useAgentList`, `useAgentRuns` (paginated + filters), `useAgentRun(id)` and
`useAgentRunRow(id)`, `useCreateAgentRun`, `useCancelAgentRun`, `useResolveInterrupt(runId)`,
`useSendSteering(runId)`, `useAwaitingInterruptCount`, `isAgentRunsNotConfigured`,
`isInterruptNotPending`, `runOwesAnswer`, `runPollInterval`. `useNavBadges` holds the SideNav counts.

## Runs are durable rows, never client state

- `POST /api/agents/runs` answers 202 with the row and the page navigates to `/agents/runs/:id`;
  `RunPage` renders `GET /runs/:id` (row + `events` + `interrupts` + `artifacts`, reconciled
  server-side). A `deduplicated: true` 202 is a SUCCESS (an exclusive agent already had an active
  run — toast, open that run); 503 `agent_runs_not_configured` is the modal's business
  (`isAgentRunsNotConfigured` → `EmptyState` explaining the deployment has no run engine, no
  toast); everything else re-toasts. The UI never sends `?strict=1`.
- **Freshness = nudge + poll.** The runs family root is `['agent-run']` (`queryKeys.agentRuns`),
  the `entity` string in the server's `entity.changed { entity: 'agent-run', id }` nudge, so the
  generic `WebSocketProvider` invalidation already covers it — no hook watches the socket or the
  store. Belt and braces: `useAgentRun`/`useAgentRunRow` poll every `RUN_POLL_MS` (3 s) while
  **`runOwesAnswer`**, and `useAgentRuns` while any listed row does. `runPollInterval(status)` is
  the pure decision (unit-tested); don't fight `refetchInterval` with fake timers.
- **`runOwesAnswer` (`queued || running`) is NOT `isRunActive`**: `isRunActive` includes
  `awaiting_input`, because the exclusive index and "is this agent busy?" genuinely do — but a run
  parked on a person changes only when somebody answers, and the server nudges that. Point a poll
  or a pulse at `isRunActive` and a parked run is re-fetched every three seconds, and announced by
  `RunStatusBadge`'s `aria-live`, for the length of `AGENT_INTERRUPT_TIMEOUT`. `isRunActive` drives
  exclusivity copy and "can this still be cancelled/steered"; `runOwesAnswer` drives freshness.

## Timeline (`RunPage.tsx` + `run/**`)

- **Everything it decides is decided in `run/timeline/timelineModel.ts`, which is pure**
  (`tests/config/run-timeline.test.ts`): `buildTimeline(events)` → rows, `groupTimeline(rows)` →
  stage groups, then the selectors (`selectArtifacts`, `selectPendingInterrupts`,
  `selectWorkStats`, `defaultExpanded`, `windowGroups`). **Everything the right pane shows that is
  not `run.output` is a selector over those same rows — never a second fetch.**
- Three properties are load-bearing: `at` is the tool call's START (`endedAt`/`durationMs` are
  separate — overwriting `at` with the answer would make a per-call duration impossible); the
  reducer is **idempotent under duplicated events** (deduplicated by `event.id`, because a stream
  and a fetch can both deliver the same row); and a step row carries `endedSeq`, because a `done`
  merges into the row its `running` wrote, so without it a settled run's trailing rows get
  swallowed by the last stage.
- Grouping: a `running` step opens, non-step rows attach, its `done` closes, a different key
  implicitly closes (an unclosed step is a real state, shown spinning); `__preamble__` and
  `__tail__` hold the loose stretches. Expansion is `defaultExpanded` XOR the reader's toggles,
  keyed by `headerId`, so a live run never reopens a group somebody closed.
- Long runs **window (`TIMELINE_WINDOW_GROUPS` = 40 groups from the end), never virtualise** — row
  heights vary wildly and a virtualiser needs measurement, which fights auto-scroll and collapsing.
  `useStickToBottom` fires only when the reader is at the bottom AND the last row id changed — and
  it needs a REAL scroll container to do it: from `lg` up the list is `overflow-y-auto` under a
  viewport-relative `max-h`, without which the `<ol>` grew unbounded, the panel grew with it, and
  `scrollIntoView` moved the page instead of the list. Below `lg` the bound is dropped on purpose
  (the columns stack, and a fixed-height inner scroller on a phone is worse than the page
  scrolling), and the "Jump to latest" pill is absolutely positioned over the scroller so it lands
  in the same place either way.
- **The column split is `runLayout(status, override)`, pure and beside the rest of the model** —
  timeline-major while the run is active (progress is the story, the output pane is an empty
  state), output-major once it settles, **and the reader's override wins permanently**. Same shape
  as `defaultExpanded` XOR the toggles: the default is a guess, and a run settling mid-read must
  never swap the columns under somebody. The chevron that flips it is a CHILD of the timeline panel
  riding that panel's own right edge — never absolutely positioned over the grid at a percentage,
  which ignores the gutter (`3fr/2fr` + `gap-8` puts the real border at `3/5 × (W − gap)`) and
  drifts further every time the gap widens. The minor column stays narrow but readable, never
  collapsed to a rail — a settled run's timeline is where you check HOW it got there.

## Tool results

- **Do not write tool-result parsers.** `documentCardsFromToolResult(name, result)` in
  `@rocketpod/shared/ai/embeddings` is the one mapper (four callers: the chat stream, the AG-UI
  projection, a persisted message and `run/timeline/toolResults.tsx`) — the rendering is a
  `DocumentLink` ONE-LINER there, not a card strip: in a timeline row four cards bury the stage
  that comes next. Every other tool keeps `<details><pre>` truncated at `TOOL_RESULT_MAX_CHARS` — a
  200 KB result in the DOM is a real hang.
- An agent should not emit tool frames for its TERMINAL tool: that "call" is the answer, which the
  Output tab already renders.
- `text` renders via `components/ai/Markdown`, which is why `pages/agents/**` is a lazy chunk like
  `ChatPage` — Vite emits `Markdown-*.js` once, shared by both, and `RunPage-*.js` is its own chunk.
  `components/ai/StatRows.tsx` (`Row`, `Section`, `formatCost`, shared with the chat inspector)
  lives in `components/ai/` for the same reason.

## Action panel (`run/ActionRequiredPanel.tsx`, `run/interrupts/*`)

- **The action panel is the reason the page exists.** Pinned ABOVE the timeline and unmounted the
  moment the run leaves `awaiting_input`; kind dispatch is an exhaustive `switch` over the shared
  union, so a fifth kind is a type error until it has a branch.
- Four rules: **409 is information** (`isInterruptNotPending` → `alert-info`, "Someone else
  answered this", refetch — no toast, no red); **expiry ticks at a rate `expiryState` chooses**
  (`run/interrupts/expiry.ts`; 1 s / 60 s / `null` past a day); **a non-approver sees one sentence,
  not disabled buttons**; and **focus lands on the heading, never Approve** (an autofocused
  destructive button plus a stray Enter is how 412 subscribers get an email).
- No optimistic write — this is a decision with a side effect. Validation is
  `interruptPayloadSchema(spec)`, the same function the route applies, and the answer is
  `status: 'resolved' | 'cancelled'` — **there is no `approved` boolean anywhere**.

## Input, output, forms

- **The input is ONE block above both columns, not a tab** (`run/RunInputSummary.tsx` over the
  pure `run/inputSummary.ts`): labelled values read from the agent's `inputJsonSchema` through the
  SAME `fieldsFromJsonSchema`, with a per-value "Show more" for the long one (`research-topic`'s
  question). It falls back to the JSON **whole** — never per field — both when the schema is
  outside the closed set and when the input carries a key the schema never declared, because
  labelling the rest would silently hide it. "What was it asked?" is the first question about a run
  you did not start, and two homes for one fact is the trap the rest of this feature avoids.
- **The right pane is `URLTabs` (`?tab=output|artifacts|usage`), and `run.error` is above it,
  always — a failure is not a tab.** `outputs/` mirrors `forms/`: `outputFor(agentKey) → { schema,
  Component, artifacts? }`, so **an agent is one shared input schema + one `forms/` entry + one
  `outputs/` entry** and no component branches on an agent key. Artifacts come from the table,
  ordered by their event rows, with `outputFor().artifacts?.()` as the fallback for an agent that
  declares none. Usage reports what the ROWS know — including the run's timestamps (requested, by
  whom, started, finished), not rows of chrome in the header; only DURATION is there, because it is
  the one a person glances at — and **says in words** that model cost is not attributed per run in
  this deployment, rather than rendering a `$0.00`.
- **One field renderer, two callers.** `fields/schemaFields.ts` is pure: `fieldsFromJsonSchema`
  supports a flat object of string / number / boolean / enum and **returns `null` for `$ref`,
  `allOf`/`anyOf`/`oneOf`, nested objects and arrays — the caller then falls back to the JSON
  textarea WHOLE, never per field**, because a form that silently drops a required field is
  invisible until the run 400s. `fields/FieldInput.tsx` + `FieldSet.tsx` serve both the `form`
  interrupt kind and `formFor`'s middle rung, `schemaForm(agent.inputJsonSchema)`.
  `submittableValues` drops empty optionals: `formValuesSchemaFor` is `.strict()`.
- **Forms come from `forms/`**: `formFor(agentKey)` → `{ initial, schema, Component }`, and
  **`formFor` is three rungs**: a registered form (`forms/index.ts`: `CORE_AGENT_FORMS` + every
  plugin's) → `schemaForm` built from the agent's own `inputJsonSchema` → `jsonForm` (a JSON
  textarea; the server's 400 `details` issues map back onto the fields through the one
  `issues.ts`). `summarize-text` ships its own (textarea counted against
  `SUMMARIZE_TEXT_MAX_CHARS`, style, "index the result" toggle), parsed with the SAME
  `summarizeTextInputSchema` the route applies (trimmed, defaults filled); `research-topic` ships a
  single question textarea counted against `RESEARCH_TOPIC_MAX_CHARS`.

## Live progress is ADDITIVE

- `lib/runAguiStream.ts` (`streamRunAgui` — GET `/api/agents/runs/:id/agui/stream`,
  `{ lastSeq, received, terminal, aborted }`; **reconnect lives in the hook, not the transport**)
  and `hooks/useRunStream.ts` (`useRunStream(runId, { enabled })` → `{ events, isLoading,
  connected, fallback, lastSeq, terminal }`, plus `streamEnabled(status)` — false for
  `awaiting_input`, which the server answers and closes at once). The run page is built against the
  poll path, so deleting the hook must leave a working page.
- **The cache rule, flatly: the stream is the ONLY writer of `['agent-run-agui', id]`, appends with
  `setQueryData`, never touches the run row, and invalidates `queryKeys.agentRuns.all` exactly once
  on a terminal frame** — a terminal status is never synthesised client-side. The cursor moves only
  on a frame that carries an `id:` (the last of a row's group), so a mid-group drop replays the
  group whole. After `RUN_STREAM_FALLBACK_ATTEMPTS` connections that delivered nothing it stops and
  gives the key a `RUN_POLL_MS` `refetchInterval` — the poll behaviour against a different URL.
- **`['agent-run-agui']` must stay out of `REALTIME_INVALIDATIONS`**: the runtime nudges
  `entity: 'agent-run'` on every row it writes, so parking the accumulated list under that root
  would make each nudge discard what the stream just built — a more expensive poll.

## Cancel, steer, finding what is waiting

- **Leaving the page never touches the run**; Cancel is the explicit button (`POST …/cancel`, shown
  while `isRunActive`). Once `cancelRequestedAt` is set it stays ENABLED as "Force cancel" — the
  second press makes the server terminate the run instance and settle the row, so a run that
  stopped polling never strands the user (and never blocks an exclusive agent). `SteerComposer`
  posts `POST …/steering` while the run is active; the note is an event row, so the timeline shows
  it where it happened and the runtime delivers it once. Requested-by is "You" / short id /
  "system" — the row carries only a user id (resolving names is on the to-document list).
- **Finding what is waiting**: the runs table's filters live in `useSearchParams`, so
  `/agents?awaiting=1` is a URL and there is a chip for it, and every row is a real `<Link>` (so
  middle-click and open-in-new-tab work — half the point of a run being a page). The SideNav badge
  is `NavItem.badgeKey`/`badgeTone` resolved by `useNavBadges()` inside `SideNav` (the nav-badge
  convention, `.claude/rules/ui.md`), fed by `GET /interrupts?status=pending&pageSize=1` under
  `['agent-run','awaiting']` (`useAwaitingInterruptCount`; both server nudges cover it) — never
  polled.
- `lib/notificationLink.ts` maps a notification's `type` + `data` to a path (unknown → `null`) and
  is used by BOTH `NotificationsBell` and `/notifications`, so a parked run's bell entry opens the
  run rather than a list of notifications about it.

## Tests

- `tests/ui/`: `agents-page`, `run-page`, `run-stream`, `run-agent-modal`, `agent-examples`,
  `sidenav` (the badge and its collapsed dot). `run-page` mounts `RunPage` on the real
  `/agents/runs/:runId` route, inside `WebSocketProvider` with the `FakeSocket` from
  `websocket-provider.test.tsx`, to prove the nudge refetches AND leaves `['agent-run-agui']` alone.
  Mount `AgentsPage` inside the same `<Routes>` pair `App.tsx` uses so `navigate('/agents/runs/:id')`
  really lands on `RunPage`.
- The pure halves live in the `config` project: `tests/config/run-timeline.test.ts` (the reducer,
  grouping, `runLayout`, `summariseInput`, `expiryState`, `fieldsFromJsonSchema`).
