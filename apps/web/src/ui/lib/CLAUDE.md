# UI lib (transports, keys, navigation)

The rules every UI edit follows (cache-only server data, realtime roots, SSE via `fetch`) are in
`.claude/rules/ui.md`; this is the detail for editing the modules here.

- `api-client.ts` — fetch wrapper, `ApiError`, `parseErrorBody` (reuse it for any non-JSON
  transport), `setUnauthorizedHandler` / `notifyUnauthorized` (the global 401 path, coalesced),
  `api.upload` for multipart (no JSON content-type). `queryClient.ts` is the module-level client
  and routes `QueryCache` and `MutationCache` 401s into it.
- `query-keys.ts` — `queryKeys` = `CORE_QUERY_KEYS` spread with every plugin's families, plus
  `cleanFilters` / `toSearchParams`. The family roots — `['invitations']`,
  `['pending-invitations']`, `['members']`, `['tenant']`… — are what `REALTIME_INVALIDATIONS` in
  `@rocketpod/shared/realtime` names; `agentRuns.all` is `['agent-run']` because that is the
  `entity` the server's `entity.changed` nudge carries (`pages/agents/CLAUDE.md`).
- `websocketClient.ts` — singleton outside React: `/ws?tenantId=` (same origin; the Vite proxy
  forwards it in dev), exponential backoff (base `min(1 s · 2^attempt, 30 s)`, jittered in
  `[base/2, base]`); a close with code 1001/1012 or a reason "upgraded"/"new version" (server
  redeployed) reconnects in 100 ms without counting as a failure; sends `{"type":"ping"}` every
  30 s; events are parsed with `realtimeEventSchema`. `subscribe(topic)` is reference-counted and
  resent on every reconnect (`hooks/useRealtimeTopic.ts`). It is the only writer of
  `stores/websocketStore.ts` (`status: 'connecting' | 'open' | 'closed'`, `connectedAt`,
  `disconnectedAt` — kept at the FIRST drop so `ConnectionBanner` measures the whole outage —
  `attempt`, `lastEvent`), read by the status dot and the banner. `setFactory()` is the test seam
  — reset it in `afterEach`.
- `sse.ts` — `readSse(response, parse, onEvent, { signal })`, `SseFrameBuffer` (survives frames
  split across chunks), `parseSseFrame`. Each `data` goes through the parser the CALLER passes
  (`kitAguiEventSchema.safeParse`); unknown frames are dropped, never thrown. It imports no schema —
  that keeps `@ag-ui/core` out of the eager shell.
- `aguiStream.ts` — `runChatTurn({ conversationId, content, onEvent, signal })` POSTs and streams
  **AG-UI** with `credentials: 'include'` + `X-Requested-With`, parsing with `kitAguiEventSchema`.
  It does not go through `api-client`'s `request()` (JSON only); a pre-stream non-2xx is the shared
  envelope via `parseErrorBody`, and 503 `ai_not_configured` throws `AiNotConfiguredError`
  (`isAiNotConfigured()`), so the page renders a "configure AI" call to action instead of a toast.
- Frame order the chat UI relies on: `RUN_STARTED` → `CUSTOM kit.chat.ids` (swap the optimistic
  user id for `userMessageId`) → `STATE_SNAPSHOT` → per model turn `TEXT_MESSAGE_START → CONTENT* →
  END` and `TOOL_CALL_START → ARGS → END → RESULT` → `CUSTOM kit.usage` → `RUN_FINISHED`. Tool
  calls render as one-liners through `toolLabel(name)` (`pages/chat/CLAUDE.md`).
- `runAguiStream.ts` — the run READ-stream, the one GET — deliberately, so a third-party client can
  point a bare `EventSource` at it — resuming with `?afterSeq=`, which beats an inbound
  `Last-Event-ID` when both arrive. A close with no terminal event means reconnect; reconnection
  lives in `hooks/useRunStream.ts`, not here (`pages/agents/CLAUDE.md`).
- `navigation.ts` — `NavigationBridge`, `navigateTo`, `hardNavigate` (full-page: OAuth,
  dev-login, logout), `loginUrl`, `safeReturnUrl`.
- `feature-guards.ts` exports only `featureGuard(feature, guard)`; core declares no flag consts
  here (`.claude/rules/ui.md` → Guards).
- `format.ts` (date-fns helpers), `environment.ts`.
- `notificationLink.ts`, `highlight.ts` (`<mark>` nodes, never HTML) — see `pages/agents/CLAUDE.md`
  and `pages/documents/CLAUDE.md`; `guide.ts`, `guideAsk.ts`, `guideScreens.ts` —
  `pages/guide/CLAUDE.md`.
