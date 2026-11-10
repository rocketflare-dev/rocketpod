# AI services

The provider seam and everything that calls a model. Feature code (routes, agents) never imports an
SDK, never reads `ai_configs`, never decrypts a key — it asks `resolve.ts` for a client and calls it
through `agent-loop.ts`.

| File | Role |
|---|---|
| `types.ts` | `ChatClient { stream, complete, countTokens? }`, `EmbeddingsClient { embed, dimension }`, block-shaped `ChatMessage`/`ContentBlock` (incl. `ImageBlock` — base64 in a user turn, each adapter its own wire shape; `IMAGE_MEDIA_TYPES`), `SystemPrompt` (`string \| { stable, volatile }`), `ChatDelta`, `RequestDefaults`, `AiEnv` (`{ converter? }` — the slice of the `Platform` AI code reads) |
| `providers.ts` | `PROVIDERS` catalog — DATA only: `scopes` (an adapter exists), `needsApiKey/BaseUrl`, `supportsThinking/ServiceTier`, presets, `suggestedModels` by scope, `modelsFixed` (the list IS the catalog → the form offers it and no free text). Price every suggested model in `@rocketpod/shared/ai/pricing` |
| `client.ts` | Adapters: `createChatClient` (`anthropic` / `anthropic_compatible` via `@anthropic-ai/sdk`; `openai` via the Responses API (`/responses`, `store: false`, reasoning items round-tripped as `reasoning` blocks; `responsesBody` / `toResponsesInput` / `fromResponsesUsage` — `input_tokens` includes cached AND cache-written tokens, made disjoint here); `openai_compatible` via `/chat/completions` fetch SSE — streamed tool calls arrive as FRAGMENTS keyed by `index` and are reassembled in the stream reader; tool schemas lose the keywords an endpoint refuses — `unsupportedSchemaKeywords(baseUrl, model)` is `maxItems` for Gemini — through `withoutSchemaKeywords`, which restates a dropped bound in the description), `createEmbeddingsClient` (`openai*` `/embeddings`, `dimensions: 1024`). Injects `service_tier` + `thinking`, `reconcileThinking`. **The body follows the MODEL's traits** (`@rocketpod/shared/ai/models` — `modelTraits`): thinking `enabled`+budget (Claude ≤ 4.5, every `anthropic_compatible` vendor), `adaptive` (4.6+), off = `disabled` / Sonnet 5.5's `between_tools` / no field (Opus 5.5, Fable — always think); `temperature` never sent to the Claude API (API version 2026-10-21 refuses it), and to a compatible vendor only where its model takes one; a forced tool on a model that refuses one (Opus/Sonnet 5.5, Fable 5.1) becomes `forcedToolText` in the system prompt + `tool_choice: auto`; `max_tokens` floored at `ADAPTIVE_THINKING_MIN_MAX_TOKENS` while a model thinks adaptively. Thinking / redacted_thinking blocks come back as opaque `reasoning` blocks and are sent back only to the provider that produced them. **Each refusal the traits could misjudge is recovered once and remembered for the client's life** (`AnthropicQuirks` / `ResponsesQuirks`): a refused `thinking` (Fireworks' gpt-oss: "Invalid reasoning effort: none"; a misread Claude id), a refused sampling value, a refused forced tool, a refused OpenAI effort (`none` → `low`); a replayed reasoning block the API rejects (signature / prefix check) is stripped for that one call. `fetch` is injectable. Rows naming the retired `workers_ai` provider stay readable through `RECORDED_AI_PROVIDERS` |
| `decisions/` | The `ctx.decide` engines behind ONE seam (`types.ts`: `DecisionClient { provider, method, ask(request, { model, signal }) }`). `typesafe.ts` = TypeSafe's System One API (Jev) over plain `fetch` — the request IS the shared `DecisionRequest`; status → `AiError` via `codeForStatus`; 429/529 retried twice in-call (`TYPESAFE_RETRY_DELAYS_MS`, `sleep` injectable); a noul's confidence is derived (`|2p − 1|`, the wire carries none); a missing answer throws rather than returning a partial set. `llm.ts` = the fallback: ONE forced `submit_judgments` call whose schema has a property per question (`p_yes`, an option map, `level_<i>`), normalised, confidence from the SAME shared formulas, `method: 'llm_self_report'` |
| `resolve.ts` | `resolveDecisions(…, { fallbackSystem, wrapChat? })` — tenant `scope='decisions'` row → `TYPESAFE_API_KEY` → the chat model on `agent-decide` (`source: 'fallback'`) → the chat 503; `decisionsClientFromRow` for the connection test. `readiness()` reports `decisions` with `source: 'fallback'` when only chat is ready. Also `resolveChat` / `resolveEmbeddings` / `readiness` — tenant default row → `platformChat(cfg, env)` (`ANTHROPIC_API_KEY` → the OpenAI-compatible `AI_API_KEY` at `AI_BASE_URL`) → `AiNotConfiguredError` (503 `ai_not_configured`). The ONLY reader of `ai_configs` and the ONLY decrypt. The PLATFORM DEFAULT (`findPlatformAgentModel` — a `platform_agent_models` row, else the committed `PROMPT_DEFAULT_MODELS` entry — and `platformDefaultModel`) is the model the platform tier runs for a prompt key when no assignment model and no tenant config chose one, and only when the tier is its provider (+ base URL for `*_compatible`, `PlatformChat.baseUrl`); `planChat` returns it as `platformDefault`, `source: 'platform_default'`. `resolvePlatformEmbeddings(cfg)` is the platform `EMBEDDINGS_*` tier ALONE (never a tenant row), for a GLOBAL corpus whose committed vectors came from the operator's model — the Guide (`services/guide-kb.ts`); null without a key. Tests `vi.mock` this module |
| `agent-loop.ts` | `cachedSystem`, `withRollingCacheBreakpoints`, `Tool` (zod schema + optional handler; no handler = terminal), `callStructuredTool` (forced tool, 1 retry; `StructuredOutputError.issues` = the zod issues or `{ reason, stopReason, text }` when there was no call; `tool.jsonSchema` shows the model a stricter schema than the lenient `schema` that validates, for a caller that salvages the valid parts of an answer), `runToolLoop` (the agent runtime's engine — resumable: `onCheckpoint` per turn, `resume` to continue, so `maxTurns`/usage are run-wide; `policy` — `maxTurns`/`maxToolCalls`/`maxConcurrentToolCalls` (default 4; 1 is sequential)/`maxDurationSeconds`/`repeatedFailureLimit` counted across attempts (active time in the checkpoint's `activeMs`, the rest from the transcript), then `onExhaustion`: `'final-answer'` forces ONE call to the single terminal tool (`salvaged: true`), `'fail'` throws `ToolLoopExhaustedError`; no policy = the old behaviour; `authorizeTool` refuses a call by rule BEFORE the gates are collected), `parseToolLoopCheckpoint` (storage → `ToolLoopCheckpoint` or **null**, never a throw), `runStreamingChat` (chat engine). **The HITL gate**: `Tool.requiresApproval` / `requiresApprovalWhen` / `approvalMessage` / `allowEdits` / `onReject`; `InterruptRequested` + `InterruptDeclinedError`; `approvals` / `onInterrupt` / `runApproved` / `beforeTurn` on `RunToolLoopOptions`; `stopReason: 'interrupt'`; `appendUserText` (never two consecutive user turns — Anthropic rejects them, and that is exactly what naive steering produces). The gate scans the WHOLE turn after the assistant message is pushed and before any handler runs, checkpoints, then raises; the resume path (`pendingToolUses` at the top of `runToolLoop`) answers a parked checkpoint's trailing `tool_use` blocks through **the same** `executeToolUses`. `runHandler` rethrows `InterruptRequested` and ONLY that; `runStreamingChat` deliberately does not — chat has no host that can park a turn, so it drops every tool that declares a gate before the model sees the list. `ToolApproval.approvedCall` binds a go-ahead to the shown tool and arguments, once per attempt |
| `chat-compaction.ts` | `compactConversation(db, { config, platform, logger, tracer? }, { tenantId, conversationId, force, maxChars })` — the `chat.compact` job's work (the handler is one call to it): the window, the forced `submit_summary` call, the usage row (awaited before it returns), the compare-and-set on `summarised_through_id`; returns `compacted` or `skipped` with the reason |
| `configs.ts` | The ONE write path for `ai_configs`: `toAiConfig` (row → contract, `hasCredential` only), `validateAiConfigUpsert` (provider × scope × field rules, thinking per `modelTraits`), `listAiConfigs`, `upsertAiConfig` (encrypt, keep the key on a re-save, drop it on a provider change, the default swap in one transaction) and `deleteAiConfig`. `routes/ai-config.ts` is thin over it; another screen managing providers calls it too |
| `chat-turn.ts` · `chat-history.ts` · `chat-stats.ts` · `agui.ts` · `document-content.ts` | The chat turn behind `/api/chat` and `/api/agui/run` (`prepareChatTurn` → `streamChatTurn`; `selectHistoryWindow` under `CHAT_HISTORY_MAX_CHARS`, `pendingCompaction`/`withSummary`); `buildConversationStats`; the AG-UI encoder (`createAguiEncoder` — SSE or protobuf by `Accept`, `kitCustom`, `aguiTextSegmenter`); `readDocumentWindow` / `listDocumentPassages` / `readDocumentCard`, the one reader of a document's text for the routes and `get_document` |
| `errors.ts` | `AiError { code: auth \| rate_limit \| invalid_request \| unavailable \| unknown }`, `normalizeAiError`, `describeAiError`, `redactSecrets`, `AiNotConfiguredError` |
| `prompt-version.ts` | `promptVersion(key, text)` = `<key>@<first 12 hex of sha256(text)>`, the ONE prompt hash: the eval targets record it, baselines carry it (`promptVersions`), the gate's coverage check (`tests/config/eval-coverage.test.ts`) compares it. Callers hash the TEMPLATE (override or default), never the interpolated text |
| `usage.ts` | `recordUsage` → `ai_usage` (cost frozen from `@rocketpod/shared/ai/pricing` unless the caller passes one), `tapUsage(client, cb)`, `summarizeUsage` (prices rows with no stored cost from the same table; `unpricedCalls` counts what has no price at all) |
| `connection-test.ts` | `testConfig` — 10-token completion / one embedding / one `noul` question (decisions), same builders as the resolver, never throws a provider error |
| `deterministic-embedding.ts` | `deterministicEmbedding` (hashed bag of words, `EMBEDDING_DIM` wide, L2-normalised, never zero) + `DETERMINISTIC_EMBEDDING_MODEL = 'seed:deterministic'` — for `pnpm seed --demo` and the test `RecordingAi` stub ONLY; nothing on the request path imports it, so the server bundle (`build:server`) never carries it (`grep -rn deterministic-embedding apps/web/src` must list only this file) |

Rules:

- **One resolve seam.** `resolveChat(db, cfg, env, tenantId, { promptKey? })` / `resolveEmbeddings`
  / `resolveDecisions` are the ONLY readers of `ai_configs` / `agent_models` /
  `platform_agent_models` and the only decrypt. Chat order for a prompt key: `agent_models` → the
  tenant's default config → the platform tier on its platform default for that key (a
  `platform_agent_models` row, else `PROMPT_DEFAULT_MODELS` — when it is that provider) → its own
  default model → 503 (`docs/CONCEPTS.md` §9). The platform chat tier is `platformChat(cfg, env)` —
  `resolveChat`, `readiness` and `routes/ai-agent-models.ts` read it; never re-derive the chain in a
  route. Feature code never imports an SDK, never queries those tables, never sees a key; it asks
  for a client and calls it through `agent-loop.ts` (`runStreamingChat`, `runToolLoop`,
  `callStructuredTool`). No client → `AiNotConfiguredError` (503 `ai_not_configured`) — thrown
  before any row is written or any stream opens. Tests `vi.mock('@/api/services/ai/resolve')`
  (`// @vitest-isolate`) and hand in `FakeChatClient`
- **Credentials never leave the server.** Rows leave as `hasCredential`; every provider failure
  goes through `normalizeAiError` → `AiError { code }` whose message is `redactSecrets`'d; the
  user-facing sentence is `describeAiError(err)`, never the vendor body. Every `ai_configs` write
  goes through `configs.ts`, the one place a key is encrypted (`encrypt(key,
  requireEncryptionKey(cfg))`) and the write-only rule kept — a second screen that manages providers
  calls it rather than re-implementing the upsert
- **Per-tenant request defaults live in the adapter** (`service_tier`, `thinking`), never at call
  sites. Thinking is OFF unless a config turns it on (sent explicitly where the model takes it);
  `reconcileThinking` drops a BUDGET on forced tool choice and lifts `max_tokens`. **What a MODEL
  accepts is `modelTraits(provider, model)`** (`@rocketpod/shared/ai/models`): the thinking mode,
  what "off" becomes, whether it takes a `temperature` or a forced `tool_choice`. Never branch on a
  model id anywhere else — the adapter and the settings form both read the traits, and a new model
  is a row in the traits test.
- **Reasoning stays in the loop.** A `reasoning` block is replayed verbatim within a tool loop and
  kept in checkpoints, never written to chat history; anything that rebuilds or edits an earlier
  assistant turn invalidates its signature (the adapter then strips and retries, losing the
  reasoning), so transcripts are append-only.
- **`recordUsage(db, …)` on every model call** (`usage.ts`): `feature` is the prompt key or
  `agent:<key>`, with `provider`, `model`, the `TokenUsage`; the cost is filled from
  `@rocketpod/shared/ai/pricing` at write time (pass `costMicrocents` only to override) and an
  unknown model stays null. The chat route records after the stream (on the stream DB client). An
  agent records nothing itself — the run's meter does (`../agents/CLAUDE.md`)
- **Trace every LLM call**: `withAgentTrace(name, { tracer, tenantId, userId, conversationId |
  runId, … }, trace => traceChatClient(client, trace, { provider }, tracer))`. `withAgentTrace`
  makes its span ACTIVE (`observability/context.ts`, `AsyncLocalStorage`), so the other tracing
  hooks — one line each and in ONE place — nest under it with no extra parameter: `agent-loop.ts`'s
  `runHandler` (the single tool runner both loops call) wraps every tool in `traceToolCall` (never
  trace a tool yourself), `retrieval.ts` wraps `searchChunks` in a `retrieval` span and its query
  embedding in `traceEmbed`, `ingest.ts` wraps each embeddings batch; `traceStep` nests anything
  else. All are no-ops without an active span — never add a `trace` parameter to a service to get
  nesting. `tracer` comes from `withAuth` in a route, from `ctx.tracer` in a job (`?? noopTracer`),
  and from `tracerFor(cfg, { store: databaseSpanStore(db) })` in a durable-run step — flush it
  yourself there, BEFORE the step's client closes (no `waitUntil`). A run's steps join ONE trace:
  `traceId: traceIdForRun(runId)`, `parentSpanId: rootSpanIdForRun(runId)`, `spanName:
  'execute#N'`; the root is recorded by the `finish` step (`recordRunRoot`). Attribute names only
  in `genai-attributes.ts`
- **Wrap, don't fork.** Tracing (`observability/tracing.ts` `traceChatClient`) and usage
  (`tapUsage`) are client wrappers; a new cross-cutting concern is another wrapper, never a fork of
  the adapter.
- **Streaming (`chat-turn.ts` is the ONE implementation; `routes/chat.ts` and `routes/agui.ts` are
  wrappers around it).** Resolve, authorise, validate and write anything that can fail as JSON
  **before** the stream opens — after the first frame a failure can only be a `RUN_ERROR`. Inside
  the stream use `streamDatabase(c)` (`utils/routes/route-helpers.ts`) for every write and close it
  in the stream's `finally`: `databaseMiddleware` ends the request's `db` in deferred work
  (`deferOrAwait`) the moment the Response object is returned, which is BEFORE the stream body runs.
  Transport is hono's generic `stream(c, cb)` plus `createAguiEncoder(c.req.header('Accept'))`
  (`agui.ts`) — **never `streamSSE`**, whose `writeSSE` imposes an `event:` line and pins the
  content type, and spec AG-UI frames are `data:` only. `encodeBinary` covers SSE and protobuf in
  one path; await every write and the tracer flush inside the stream — there is no `defer` after the
  Response. A cancelled run emits NOTHING: closing with neither `RUN_FINISHED` nor `RUN_ERROR` IS
  the cancellation signal
- Adding a provider: enum value in `@rocketpod/shared/ai/config` (append last) → `PROVIDERS` entry →
  adapter branch in `client.ts` → `ai-client.test.ts` case. Per-agent model assignment
  (`agent_models`) is `resolveChat`'s `promptKey` branch (`planChat` — shared with
  `routes/ai-agent-models.ts`).
- **Prompts are code.** A new system prompt is a `CORE_PROMPT_REGISTRY` entry in `../prompts.ts`
  (title, description, `variables`, `defaultText`) read through `resolvePrompt(db, tenantId, key,
  vars)`; never a hard-coded string in a route or agent; no migration. **A prompt never overfits to
  the data that found its bug**: fix the cause with a general rule, and never put that
  conversation's words, names or domain into the prompt or its examples (`docs/EVALS.md` §
  "Avoiding overfitting"). A prompt edit also makes its eval baseline stale, which the gate WARNS
  about (§ "The coverage contract")
- **Evals drive the real code in-process.** `apps/evals` calls the chat ROUTE and the agent
  runtime's step bodies directly, inside `withEvalScope` (`observability/context.ts`), which marks
  every trace started under it `rocketpod.eval=true`. Nothing in the server enters that scope; do
  not add a request flag for it. The judge's prompt is the `evals-judge` registry entry and its
  spend is `ai_usage` feature `evals.judge`
- **Ingest: two ways in, one path.** `chunking.ts` (pure paragraph-aware chunker, ~800 tokens / 100
  overlap, 4 chars per token); `ingest.ts` — `ingestText(db, cfg, env, input, { jobs })` (JSON text)
  and `ingestFile(db, cfg, env, input, { jobs, storage })` (multipart — original to object storage
  as a `files` row scope `documents`, `fileId` on the document). Text-like types index inline ≤ 50
  chunks else a `document.index` job; PDF/Office/HTML enqueue `document.convert`
  (`convertAndIndexDocument`: storage → the platform `DocumentConverter` → the same
  `indexDocument`, shared with `queues/handlers/document-index.ts` / `document-convert.ts`).
  `convert.ts` is `needsConversion` / `canConvert` / `converterSupports` / `decodeText` /
  `convertToText` over the platform `DocumentConverter`; `ConversionFailedError` is the permanent
  case. Everything that can refuse (`resolveEmbeddings`, `canConvert`, `converterSupports`) runs
  BEFORE any write; the upload route maps `ConversionNotConfiguredError` → 503
  `conversion_not_configured`, and a `convert` type the converter does not declare in
  `contentTypes` is a 415 `unsupported_media_type` (`UnsupportedConversionTypeError`)
- **Strip NULs before storing**: every stored text — `documents.content`, `chunks.text`, every
  `ai_spans` string — goes through `stripControlChars` / `stripControlCharsDeep`
  (`utils/core/text.ts`), because Postgres refuses a NUL in `text` (22021) and `jsonb` (22P05)
- **An `externalId` makes ingest an upsert**: the same `(tenant, source, externalId)` updates the row
  in one `ON CONFLICT` statement (partial unique index), replaces its grants, rebuilds its chunks
  and drops a replaced stored original; `deleteExternalDocument` is the delete. Plugins reach both
  only through `@/plugins/api` (`ingestDocument`, `deleteIngestedDocument`)
- **Retrieval only through `searchChunks(db, cfg, env, scope, request)`** (`retrieval.ts`): dense
  `<=>` + lexical over ANY query word (`anyTermTsquery`: the distinct `\p{L}\p{N}` words OR-ed —
  never `websearch_to_tsquery`, which ANDs a sentence's filler words into zero hits) ranked by
  `ts_rank_cd` over the stored `chunks.search_vector`, RRF `k = 60`; an optional `documents` corpus
  predicate (`SearchChunksOptions`) is ANDed with the reader's visibility, so it narrows and never
  widens; `RerankFn` is the documented, unbuilt seam. **A document's TEXT only through
  `document-content.ts`** (`readDocumentWindow` / `listDocumentPassages` / `readDocumentCard`),
  which BOTH `get_document` and `GET /api/ai/documents/:id/{content,passages,card}` call — never a
  second slice in JS, and never a `select()` over `chunks` that could widen onto `embedding`
- **Reading a document takes an `AccessScope`, not a tenant id**: `searchChunks` and the three
  `document-content.ts` readers ALL take one (for an agent run, built at EXECUTE time from
  `requestedByUserId`), so a restricted document is absent from search, from `get_document` and
  from the viewer by the same predicate. The scope carries the tenant, which is why there is no
  separate `tenantId` argument to keep in step with it; `documentId` narrows the tenant predicate,
  never replaces it. `fullAccessScope(tenantId)` is for maintenance paths only. The dense half
  additionally sets `hnsw.iterative_scan = relaxed_order` `SET LOCAL` inside a transaction WHEN a
  visibility predicate is in play — an approximate index can otherwise exhaust its candidate list
  before filling the pool and hand back an empty dense half to a reader who may see very little.
- `DELETE /api/ai/documents/:id` deletes the stored original too (`deleteStoredFile`); `/api/files`
  refuses a `documents`-scope delete with 409 `owned_by_document`
