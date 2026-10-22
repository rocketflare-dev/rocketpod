/**
 * `/api/guide` — the Guide: the in-app user guide (a reader over `apps/web/content/guide/`) and
 * "Ask the Guide", a chat that answers only from it (`docs/CONCEPTS.md` § The Guide).
 *
 *   GET  /toc                the pages this reader may see, in reading order
 *   GET  /page?path=         one page: markdown (facts resolved) + outline
 *   POST /ask                AG-UI stream: text, each `search_guide` call and its result, then
 *                            `CUSTOM kit.guide.answer`
 *   GET  /images/:file       a page image (`![alt](shot:<id>)` → `<id>.png`)
 *
 * - **Every member of a tenant reads it** (a session or an API key — the CLI will ask it too).
 *   It holds no tenant data.
 * - **The audience is derived here, from role.** The client never sends it. Admin-level roles
 *   (`isAdminLevel`) read as `admin` and see every page; everyone else reads `member` pages. The
 *   shared TOC and retrieval apply the rule, and a page outside the reader's audience is the same
 *   404 as one that does not exist.
 * - **Nothing tenant-specific enters the chat.** The screen hint is a short label from a fixed
 *   vocabulary and a page path, validated by zod; the history is the client's own prior turns.
 * - **Stateless.** Nothing about a question is stored except its usage row and its trace.
 */
import { AguiEventType, KIT_CUSTOM_EVENTS, type KitAguiEvent } from '@rocketpod/shared/ai/agui'
import {
  type AskGuideRequest,
  askGuideSchema,
  type GuideAnswer,
  type GuideAudience,
  type GuidePageResponse,
  type GuideScreenHint,
  type GuideTocEntry,
  guidePageQuerySchema,
} from '@rocketpod/shared/guide'
import { GUIDE_ADMIN_SCREEN_PAGES, GUIDE_SCREEN_PAGES } from '@rocketpod/shared/guide-screens'
import { stream } from 'hono/streaming'
import { traceChatClient, withAgentTrace } from '../observability/tracing'
import { aguiTextSegmenter, createAguiEncoder } from '../services/ai/agui'
import { AiError, describeAiError, normalizeAiError } from '../services/ai/errors'
import { runStreamingChat } from '../services/ai/kit'
import { resolveChat, resolvePlatformEmbeddings } from '../services/ai/resolve'
import { recordUsage } from '../services/ai/usage'
import {
  dedupeGuideCitations,
  resolveGuideCitation,
  splitGuideCitations,
} from '../services/guide-citations'
import {
  type GuidePage,
  guideOutline,
  guideReaderMarkdown,
  guideToc,
  loadGuidePages,
} from '../services/guide-content'
import { type GuideRetrieval, guideAudienceFor } from '../services/guide-kb'
import { createGuideTools } from '../services/guide-tools'
import { resolvePrompt } from '../services/prompts'
import type { AppContext } from '../types'
import { NotFoundError } from '../utils/core/errors'
import { streamDatabase, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const guideRouter = createRouter()

/** The turn cap of one answer: a few searches, then the answer. */
const GUIDE_MAX_TURNS = 6

/** The parsed pages, re-parsed only when the source hands back a different file list. */
const parsed = new WeakMap<object, GuidePage[]>()

async function guidePages(c: AppContext): Promise<GuidePage[]> {
  const source = c.get('platform').guide
  if (!source) return []
  const files = await source.markdownFiles()
  const cached = parsed.get(files)
  if (cached) return cached
  const { pages, problems } = loadGuidePages(files)
  // A broken page is left out rather than taking the Guide down; the staleness test is what keeps
  // one from shipping.
  for (const p of problems)
    c.get('logger').warn({ path: p.path }, `Guide page skipped: ${p.message}`)
  parsed.set(files, pages)
  return pages
}

async function tocFor(
  c: AppContext,
  audience: GuideAudience
): Promise<{ pages: Map<string, GuidePage>; entries: GuideTocEntry[] }> {
  const all = await guidePages(c)
  const entries = guideToc(all, audience)
  const visible = new Set(entries.map(e => e.path))
  return { pages: new Map(all.filter(p => visible.has(p.path)).map(p => [p.path, p])), entries }
}

// ---- reader ---------------------------------------------------------------------------------

guideRouter.get('/toc', async c => {
  const { auth } = withAuthAndDb(c)
  return c.json({ entries: (await tocFor(c, guideAudienceFor(auth))).entries })
})

guideRouter.get('/page', validate('query', guidePageQuerySchema), async c => {
  const { auth } = withAuthAndDb(c)
  const { path: rel } = c.req.valid('query')
  // Resolved through the reader's OWN TOC: a page outside their audience is unknown to them,
  // exactly like a page that does not exist.
  const { pages, entries } = await tocFor(c, guideAudienceFor(auth))
  const page = pages.get(rel)
  const meta = entries.find(e => e.path === rel)
  if (!page || !meta) throw new NotFoundError('Unknown Guide page')
  const markdown = guideReaderMarkdown(page)
  const body: GuidePageResponse = {
    path: rel,
    title: meta.title,
    meta,
    markdown,
    outline: guideOutline(markdown),
  }
  return c.json(body)
})

guideRouter.get('/images/:file', async c => {
  withAuthAndDb(c)
  const image = await c.get('platform').guide?.image(c.req.param('file'))
  if (!image) throw new NotFoundError('Not found')
  return new Response(new Uint8Array(image.bytes), {
    headers: { 'Content-Type': image.contentType, 'Cache-Control': 'private, max-age=3600' },
  })
})

// ---- Ask the Guide --------------------------------------------------------------------------

/** Every page a screen hint may name — the screen maps' own targets (member and admin screens). */
const SCREEN_PAGES = new Set<string>(
  [
    ...Object.values<string | null>(GUIDE_SCREEN_PAGES),
    ...Object.values<string | null>(GUIDE_ADMIN_SCREEN_PAGES),
  ].filter((p): p is string => p !== null)
)

/**
 * The screen hint as one line of system context — single-line, no tenant data by contract. Its
 * `page` is named only when it is a screen-map target the asker can read: anything else is a stale
 * client or a guess, and the model would cite a page the reader cannot open.
 */
export function guideScreenContext(
  screen: GuideScreenHint | undefined,
  readable: ReadonlyMap<string, unknown>
): string {
  if (!screen) return ''
  const label = screen.label.replace(/\s+/g, ' ').trim()
  const known = screen.page && SCREEN_PAGES.has(screen.page) && readable.has(screen.page)
  const page = known ? ` The Guide page for that screen is ${screen.page}.` : ''
  return `\n\nThe person is currently on: ${label}.${page} When they ask what to do "now" or "here", answer about that screen.`
}

guideRouter.post('/ask', validate('json', askGuideSchema), async c => {
  const { db, cfg, tenantId, user, auth, tracer, logger } = withAuthAndDb(c)
  const body: AskGuideRequest = c.req.valid('json')
  const audience = guideAudienceFor(auth)

  // Everything that can fail as a JSON envelope happens BEFORE the stream: no chat provider is a
  // 503 `ai_not_configured` here, not a broken stream.
  const resolved = await resolveChat(db, cfg, c.get('platform'), tenantId, {
    promptKey: 'guide-chat',
  })
  const { entries } = await tocFor(c, audience)
  const byPath = new Map(entries.map(e => [e.path, e]))
  const prompt = await resolvePrompt(db, tenantId, 'guide-chat', { appName: cfg.APP_NAME })
  const system = `${prompt}${guideScreenContext(body.screen, byPath)}`
  // The Guide's retrieval is the operator's (platform tier): the committed vectors were built with
  // the platform model, so the query must be embedded with it whichever tenant asks.
  const embedder = resolvePlatformEmbeddings(cfg)
  const messages = [
    ...(body.history ?? []).map(t => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: body.question },
  ]

  const encoder = createAguiEncoder(c.req.header('Accept'))
  c.header('Content-Type', encoder.contentType)
  if (!encoder.binary) {
    c.header('Cache-Control', 'no-cache')
    c.header('Connection', 'keep-alive')
    c.header('X-Accel-Buffering', 'no')
  }
  const runId = crypto.randomUUID()
  const threadId = crypto.randomUUID()

  return stream(c, async s => {
    // The request's client is closed once this Response is returned; the tools need their own.
    const handle = streamDatabase(c)
    const abort = new AbortController()
    s.onAbort(() => abort.abort())
    const emit = async (event: KitAguiEvent) => {
      const bytes = encoder.encode(event)
      if (bytes) await s.write(bytes)
    }
    const text = aguiTextSegmenter(emit, crypto.randomUUID())
    // The weakest retrieval any search of this answer used — reported, never hidden.
    let retrieval: GuideAnswer['retrieval'] = 'none'
    const onRetrieval = (r: GuideRetrieval) => {
      if (r.mode === 'lexical' || retrieval === 'none') retrieval = r.mode
      if (r.reason) logger.info({ reason: r.reason }, 'guide: keyword-only retrieval')
    }
    const tools = createGuideTools({
      db: handle.db,
      audience,
      preferPart: body.screen?.part ?? null,
      embedder,
      onRetrieval,
    })

    try {
      await emit({ type: AguiEventType.RUN_STARTED, threadId, runId })
      const result = await withAgentTrace(
        'guide-chat',
        {
          tracer,
          tenantId,
          userId: user.id,
          tags: ['guide'],
          metadata: { model: resolved.model, audience },
          input: body.question,
        },
        trace =>
          runStreamingChat(
            traceChatClient(resolved.client, trace, { provider: resolved.provider }, tracer),
            {
              model: resolved.model,
              maxTokens: resolved.maxOutputTokens,
              system,
              messages,
              tools,
              maxTurns: GUIDE_MAX_TURNS,
              signal: abort.signal,
              onDelta: delta => text.delta(delta),
              onToolStart: async call => {
                await text.close()
                await emit({
                  type: AguiEventType.TOOL_CALL_START,
                  toolCallId: call.toolUseId,
                  toolCallName: call.name,
                  parentMessageId: text.parentMessageId(),
                })
                await emit({
                  type: AguiEventType.TOOL_CALL_ARGS,
                  toolCallId: call.toolUseId,
                  delta: JSON.stringify(call.input ?? {}),
                })
                await emit({ type: AguiEventType.TOOL_CALL_END, toolCallId: call.toolUseId })
              },
              // The passages the search returned — Guide text the asker may read (the audience
              // was a SQL predicate), so the transcript (and the eval suite) sees what the model saw.
              onToolEnd: async call => {
                await emit({
                  type: AguiEventType.TOOL_CALL_RESULT,
                  messageId: crypto.randomUUID(),
                  toolCallId: call.toolUseId,
                  content: call.result,
                  role: 'tool',
                })
              },
            }
          )
      )
      await text.close()
      await recordUsage(handle.db, {
        tenantId,
        userId: user.id,
        feature: 'guide-chat',
        provider: resolved.provider,
        model: resolved.model,
        usage: result.usage,
      })
      const { answer, citations } = splitGuideCitations(result.text)
      const done: GuideAnswer = {
        answer,
        citations: dedupeGuideCitations(citations.map(cit => resolveGuideCitation(cit, byPath))),
        retrieval,
      }
      await emit({ type: AguiEventType.CUSTOM, name: KIT_CUSTOM_EVENTS.guideAnswer, value: done })
      await emit({ type: AguiEventType.RUN_FINISHED, threadId, runId })
    } catch (err) {
      // A cancelled answer closes silently: the client went away.
      if (abort.signal.aborted) return
      const aiError = err instanceof AiError ? err : normalizeAiError(err, resolved.provider)
      logger.warn({ err: aiError }, 'guide: answer failed')
      try {
        await text.close()
        await emit({
          type: AguiEventType.RUN_ERROR,
          message: describeAiError(aiError),
          code: aiError.code,
        })
      } catch {
        // The connection went away while reporting the failure.
      }
    } finally {
      await handle.close()
      await tracer.flush()
    }
  })
})
