/**
 * Test-only agents for the agent RUNTIME's suites. The example agents (`services/agents/examples/`)
 * are demos a copy deletes, so the runtime is driven through two small agents that live here,
 * never in `src/`:
 *
 * - `test-summarize` — one forced `submit_summary` call, an `approval` interrupt before an optional
 *   `ingestText` write behind `ctx.once`, artifacts, `ai_usage` under `agent:test-summarize`;
 * - `test-research` — a `runToolLoop` over `ctx.tools` plus a `save_note` tool gated by
 *   `requiresApproval` (`allowEdits`), checkpointed (`ctx.checkpoint`), the loop's usage written
 *   once (`ctx.once('loop-usage')`), ending in a terminal `submit_answer`.
 *
 * They are registered through the PLUGIN seam, exactly as an installed plugin's agents are:
 * a file mocks both barrels, and is `// @vitest-isolate` for it —
 *
 *     vi.mock('@rocketpod/shared/plugins', async importOriginal =>
 *       (await import('../helpers/test-agents-shared')).withTestAgents(await importOriginal())
 *     )
 *     vi.mock('@/plugins/server', async () =>
 *       (await import('../helpers/test-agents')).testAgentsServerBarrel()
 *     )
 *
 * Every runtime import is LAZY (inside `run`): this module is loaded by the `@/plugins/server`
 * mock factory, and a top-level import of a module that reads that barrel would close a cycle.
 */
import type { TokenUsage } from '@rocketpod/shared/ai/chat'
import { approvalPayloadSchema } from '@rocketpod/shared/ai/interrupts'
import type { PromptDefinition } from '@rocketpod/shared/ai/prompts'
import { z } from 'zod'
import type {
  AgentContext,
  AgentDefinition,
  AnyAgentDefinition,
} from '@/api/services/agents/registry'
import type { Tool } from '@/api/services/ai/agent-loop'
import type { ChatMessage } from '@/api/services/ai/types'
import { TEST_AGENTS_SHARED, TEST_RESEARCH, TEST_SUMMARIZE } from './test-agents-shared'

export { TEST_RESEARCH, TEST_SUMMARIZE } from './test-agents-shared'

export const SUBMIT_SUMMARY_TOOL = 'submit_summary'
export const SUBMIT_ANSWER_TOOL = 'submit_answer'
export const SAVE_NOTE_TOOL = 'save_note'

const kit = () => import('@/api/services/ai/agent-loop')
const ingest = () => import('@/api/services/ai/ingest')
const usageLedger = () => import('@/api/services/ai/usage')

// ---- test-summarize -----------------------------------------------------------------------------

export const testSummarizeInputSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  style: z.enum(['bullets', 'paragraph']).default('bullets'),
  index: z.boolean().default(false),
})
type SummarizeInput = z.infer<typeof testSummarizeInputSchema>

export const testSummarizeOutputSchema = z.object({
  summary: z.string().min(1),
  keyPoints: z.array(z.string().min(1)).max(20),
  documentId: z.string().uuid().optional(),
})
type SummarizeOutput = z.infer<typeof testSummarizeOutputSchema>

const submitSummarySchema = z.object({
  summary: z.string().min(1),
  keyPoints: z.array(z.string().min(1)).min(1).max(20),
})

const testSummarizeAgent: AgentDefinition<SummarizeInput, SummarizeOutput> = {
  meta: {
    key: TEST_SUMMARIZE,
    title: 'Test summarize',
    description: 'Test-only: one forced tool call, optionally indexed after an approval.',
    inputSchema: testSummarizeInputSchema,
    outputSchema: testSummarizeOutputSchema,
    promptKey: TEST_SUMMARIZE,
    exclusive: true,
  },

  async run(ctx) {
    const { callStructuredTool } = await kit()
    const { recordUsage } = await usageLedger()
    const { input } = ctx
    await ctx.step('precheck', 'Checking the input', 'running')
    const text = input.text.trim()
    await ctx.step('precheck', 'Checking the input', 'done', `${text.length} characters`)
    await ctx.checkCancelled()

    // The whole phase is behind `ctx.once`: a run parked on the approval below re-enters `run()`
    // from the top when somebody answers, and must not pay for (or log) the summary twice.
    const result = await ctx.once('summary', async () => {
      await ctx.step('summarize', 'Summarising', 'running')
      const system = await ctx.prompt({ style: input.style })
      await ctx.emit({
        type: 'tool.start',
        data: { name: SUBMIT_SUMMARY_TOOL, style: input.style },
      })
      const summary = await callStructuredTool(ctx.chat.client, {
        model: ctx.chat.model,
        maxTokens: ctx.chat.maxOutputTokens,
        system,
        messages: [{ role: 'user', content: `Summarise the following text:\n\n${text}` }],
        tool: {
          name: SUBMIT_SUMMARY_TOOL,
          description: 'Submit the summary and its key points.',
          schema: submitSummarySchema,
        },
        onUsage: usage =>
          void recordUsage(ctx.db, {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            feature: `agent:${TEST_SUMMARIZE}`,
            provider: ctx.chat.client.provider,
            model: ctx.chat.model,
            usage,
          }),
      })
      await ctx.emit({
        type: 'tool.end',
        data: { name: SUBMIT_SUMMARY_TOOL, keyPoints: summary.keyPoints.length },
      })
      await ctx.emit({ type: 'text', data: { text: summary.summary } })
      await ctx.step('summarize', 'Summarising', 'done', `${summary.keyPoints.length} key points`)
      await ctx.artifact({
        key: 'summary',
        title: 'Summary',
        data: {
          kind: 'markdown',
          markdown: [summary.summary, ...summary.keyPoints.map(p => `- ${p}`)].join('\n\n'),
        },
      })
      return summary
    })
    await ctx.checkCancelled()

    const output: SummarizeOutput = { summary: result.summary, keyPoints: result.keyPoints }
    if (!input.index) return output

    const approval = await ctx.interrupt({
      key: 'approve-index',
      spec: {
        kind: 'approval',
        title: 'Index this summary?',
        message: 'Add it to the knowledge base?',
      },
    })
    const note = approvalPayloadSchema.safeParse(approval.payload)
    await ctx.step(
      'index',
      'Indexing the summary',
      'running',
      note.success && note.data.note ? `approved: ${note.data.note}` : 'approved'
    )
    const { ingestText } = await ingest()
    const document = await ctx.once('index-summary', async () => {
      const { document: row } = await ingestText(
        ctx.db,
        ctx.cfg,
        ctx.env,
        {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          title: 'Summary',
          text: [result.summary, ...result.keyPoints.map(p => `- ${p}`)].join('\n\n'),
          source: `agent:${TEST_SUMMARIZE}`,
        },
        { jobs: ctx.env.jobs }
      )
      return { id: row.id, status: row.status, chunkCount: row.chunkCount }
    })
    output.documentId = document.id
    await ctx.artifact({
      key: 'summary-document',
      title: 'Indexed document',
      data: { kind: 'document', documentId: document.id },
    })
    await ctx.step(
      'index',
      'Indexing the summary',
      document.status === 'failed' ? 'error' : 'done',
      `${document.chunkCount} chunks`
    )
    return output
  },
}

// ---- test-research ------------------------------------------------------------------------------

export const testResearchInputSchema = z.object({ topic: z.string().trim().min(1).max(2_000) })
type ResearchInput = z.infer<typeof testResearchInputSchema>

export const testResearchOutputSchema = z.object({
  answer: z.string().min(1),
  /** Model turns the run spent — carried across a resumed attempt by the checkpoint. */
  turns: z.number().int().nonnegative(),
})
type ResearchOutput = z.infer<typeof testResearchOutputSchema>

const submitAnswerSchema = z.object({ answer: z.string().min(1) })

function saveNoteTool(ctx: AgentContext<ResearchInput>): Tool {
  const schema = z.object({ title: z.string().min(1).max(200), text: z.string().min(1) })
  const tool: Tool<z.infer<typeof schema>> = {
    name: SAVE_NOTE_TOOL,
    description: 'Save a note into the knowledge base. A person approves every call.',
    schema,
    requiresApproval: true,
    allowEdits: true,
    onReject: 'tell_model',
    handler: async ({ title, text }) => {
      const { ingestText } = await ingest()
      const { document } = await ingestText(
        ctx.db,
        ctx.cfg,
        ctx.env,
        {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          title,
          text,
          source: `agent:${TEST_RESEARCH}`,
        },
        { jobs: ctx.env.jobs }
      )
      await ctx.artifact({
        key: `note:${document.id}`,
        title,
        data: { kind: 'document', documentId: document.id },
      })
      return `Saved as "${title}".`
    },
  }
  return tool as Tool
}

const testResearchAgent: AgentDefinition<ResearchInput, ResearchOutput> = {
  meta: {
    key: TEST_RESEARCH,
    title: 'Test research',
    description: 'Test-only: a checkpointed tool loop with one approval-gated tool.',
    inputSchema: testResearchInputSchema,
    outputSchema: testResearchOutputSchema,
    promptKey: TEST_RESEARCH,
    exclusive: true,
  },

  async run(ctx) {
    const { runToolLoop } = await kit()
    const { recordUsage } = await usageLedger()
    const system = await ctx.prompt()
    const messages: ChatMessage[] = [{ role: 'user', content: `Research this: ${ctx.input.topic}` }]
    const resume = await ctx.checkpoint.load()
    const loop = await runToolLoop(ctx.chat.client, {
      model: ctx.chat.model,
      maxTokens: ctx.chat.maxOutputTokens,
      system,
      messages,
      tools: [
        ...ctx.tools,
        saveNoteTool(ctx),
        {
          name: SUBMIT_ANSWER_TOOL,
          description: 'Submit the answer.',
          schema: submitAnswerSchema,
        } as Tool,
      ],
      maxTurns: ctx.cfg.AGENT_MAX_TURNS,
      approvals: ctx.approvals,
      runApproved: ctx.once,
      ...(resume ? { resume } : {}),
      onCheckpoint: checkpoint => ctx.checkpoint.save(checkpoint),
      onStep: () => ctx.checkCancelled(),
    })
    // Once per RUN, summing every attempt: the resumed loop's usage already includes the turns the
    // checkpoint carried, so writing it per attempt would ledger them twice.
    await ctx.once('loop-usage', async () => {
      const usage: TokenUsage = loop.usage
      await recordUsage(ctx.db, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        feature: `agent:${TEST_RESEARCH}`,
        provider: ctx.chat.client.provider,
        model: ctx.chat.model,
        usage,
      })
      return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
    })
    const submitted = submitAnswerSchema.safeParse(loop.terminalInput)
    const answer = submitted.success ? submitted.data.answer : `No answer (${loop.stopReason}).`
    await ctx.artifact({
      key: 'answer',
      title: 'Answer',
      data: { kind: 'markdown', markdown: answer },
    })
    return { answer, turns: loop.turns }
  },
}

// ---- The plugin --------------------------------------------------------------------------------

const prompt = (key: string, defaultText: string): PromptDefinition => ({
  key,
  title: key,
  description: `Test-only prompt for ${key}.`,
  variables: ['appName', 'tenantName', 'style'],
  defaultText,
})

// Literal keys, not `[TEST_SUMMARIZE]`: the constants are typed `AgentKey`, and in a copy whose
// own agents make that a single literal, two computed keys of one type are a duplicate-key error.
export const TEST_AGENTS_SERVER = {
  shared: TEST_AGENTS_SHARED,
  agents: {
    'test-summarize': testSummarizeAgent as AnyAgentDefinition,
    'test-research': testResearchAgent as AnyAgentDefinition,
  },
  prompts: {
    'test-summarize': prompt(TEST_SUMMARIZE, 'Summarise, working for {{tenantName}} ({{style}}).'),
    'test-research': prompt(TEST_RESEARCH, 'Research for {{tenantName}}.'),
  },
}

/**
 * The mocked `@/plugins/server`: the test plugin as the one installed server plugin (the shared
 * half, `withTestAgents`, does the same), so the installed plugins never shape a runtime test.
 */
export function testAgentsServerBarrel() {
  return { SERVER_PLUGINS: [TEST_AGENTS_SERVER], serverPlugins: [TEST_AGENTS_SERVER] }
}
