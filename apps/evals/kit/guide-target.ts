/**
 * The Guide target: one case → one "Ask the Guide" answer, IN-PROCESS, through the route the
 * reader calls (`POST /api/guide/ask`). Driving the route is the point: the `guide-chat` prompt,
 * the screen hint, the asker's audience and the `search_guide` tool are all decided there.
 *
 * The world is a fresh tenant (`caseWorld`) whose platform reads the COMMITTED Guide
 * (`apps/web/content/guide`), loaded into `guide_chunks` exactly as a web boot loads it — so a case
 * grades the pages that ship, not text the case brings (`context` is unused). What the model was
 * shown is read back from the `search_guide` results (`TOOL_CALL_RESULT`), so a faithfulness judge
 * grades the answer against the passages, never against the dataset.
 *
 * Without `EMBEDDINGS_API_KEY` (or with no committed vectors) retrieval is keyword-only, as it is
 * on a server in the same state; the answer event says which.
 */
import type { EvalCase, EvalContextDoc } from '@rocketpod/shared/ai/evals'
import { createHarness, type Harness } from 'vitest-evals'
import { withEvalScope } from '@/api/observability/context'
import { promptVersion } from '@/api/services/ai/prompt-version'
import { getPrompt } from '@/api/services/prompts'
import { createNodeGuideSource, loadGuideFromDisk } from '@/node/guide-content'
import { aguiFrames } from '../../web/tests/helpers/ai'
import { request } from '../../web/tests/helpers/request'
import { createTestEnv } from '../../web/tests/mocks/bindings'
import { caseWorld } from './fixtures'
import { tenantSpend } from './spend'
import { transcriptFromAgui } from './transcript'

const GUIDE_DIR = new URL('../../web/content/guide', import.meta.url).pathname
const SEARCH_GUIDE = 'search_guide'

/** `renderGuideChunks`' text → one context doc per `[page=… | heading=…]` block. */
export function contextFromGuideResult(result: string | undefined): EvalContextDoc[] {
  if (!result) return []
  return result.split('\n\n---\n\n').flatMap(block => {
    const m = /^\[page=([^|\]]+) \| heading=([^\]]+)\]\n([\s\S]*)$/.exec(block.trim())
    if (!m) return []
    const [, page, heading, text] = m
    return [{ title: heading === '-' ? `${page}` : `${page}#${heading}`, text: text ?? '' }]
  })
}

export function guideHarness(): Harness<EvalCase, string> {
  return createHarness<EvalCase, string>({
    name: 'rocketpod-guide',
    run: async ({ input: evalCase }) => {
      if (typeof evalCase.input !== 'string') {
        throw new Error(`case ${evalCase.id}: a Guide case's input is the question (a string)`)
      }
      const question = evalCase.input
      const world = await caseWorld({ context: [] }, ['guide-chat'])
      await loadGuideFromDisk(world.db, GUIDE_DIR)
      const env = createTestEnv({
        ...(process.env.EMBEDDINGS_API_KEY ? { ai: null } : {}),
        guide: createNodeGuideSource(GUIDE_DIR),
      })
      const started = Date.now()
      const events = await withEvalScope(async () => {
        const res = await request(
          '/api/guide/ask',
          { method: 'POST', headers: world.cookie },
          {
            env,
            json: {
              question,
              history: evalCase.messages.map(m => ({ role: m.role, content: m.content })),
            },
          }
        )
        if (!res.ok) throw new Error(`guide: the ask answered ${res.status}: ${await res.text()}`)
        return aguiFrames(res)
      })
      const totalMs = Date.now() - started
      const transcript = transcriptFromAgui(events, question)
      if (transcript.error) throw new Error(`guide answer failed: ${transcript.error}`)
      const retrieved = transcript.toolCalls
        .filter(c => c.name === SEARCH_GUIDE)
        .flatMap(c => contextFromGuideResult(c.result))
      const prompt = (await getPrompt(world.db, world.tenantId, 'guide-chat')).effectiveText
      return {
        output: transcript.output,
        events: transcript.events,
        usage: {
          provider: transcript.provider,
          model: transcript.model,
          toolCalls: transcript.toolCalls.length,
          ...(await tenantSpend(world.db, world.tenantId)),
        },
        timings: { totalMs },
        artifacts: {
          retrieved,
          promptKey: 'guide-chat',
          promptVersion: promptVersion('guide-chat', prompt),
        },
      }
    },
  })
}
