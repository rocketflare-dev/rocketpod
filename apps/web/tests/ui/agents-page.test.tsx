/**
 * `/agents` (D7): the registry renders with the exclusive badge; the run modal, built from the
 * agent's own JSON Schema, maps the route's 400 onto the field and posts the exact
 * `{ agentKey, input }` body; a 202 `deduplicated` answer
 * opens the existing run; a 503 `agent_runs_not_configured` renders the explanatory
 * empty state instead of a toast; the runs table shows status, agent and filters.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STACK_HIDE, STACK_ROW, STACK_TABLE } from '@/ui/lib/stacked-table'
import AgentPage from '@/ui/pages/agents/AgentPage'
import AgentsPage from '@/ui/pages/agents/AgentsPage'
import AllRunsPage from '@/ui/pages/agents/AllRunsPage'
import RunPage from '@/ui/pages/agents/RunPage'
import { TEST_RESEARCH, TEST_SUMMARIZE } from '../helpers/test-agents-shared'
import {
  errorResponse,
  IDS,
  jsonResponse,
  makeSession,
  paged,
  type RouteTable,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

// The test-only agents' keys (`tests/helpers/test-agents-shared.ts`), so the page is tested apart
// from the example agents; the responses below are parsed with the real `agentKeySchema`.
vi.mock('@rocketpod/shared/plugins', async importOriginal =>
  (await import('../helpers/test-agents-shared')).withTestAgents(await importOriginal())
)

const now = '2025-06-01T00:00:00Z'
const RUN_ID = '99999999-9999-4999-8999-999999999999'

const AGENTS = {
  items: [
    {
      key: TEST_SUMMARIZE,
      title: 'Summarize text',
      description: 'Summarises a block of text.',
      promptKey: TEST_SUMMARIZE,
      exclusive: true,
      inputJsonSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', title: 'Text to summarise', minLength: 1 },
          style: { type: 'string', title: 'Style', enum: ['bullets', 'paragraph'] },
          index: { type: 'boolean', title: 'Index the result for search' },
        },
        required: ['text'],
      },
    },
  ],
}

const run = (overrides: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  tenantId: IDS.tenant,
  agentKey: TEST_SUMMARIZE,
  status: 'queued',
  input: { text: 'hello', style: 'bullets', index: false },
  output: null,
  error: null,
  requestedByUserId: IDS.user,
  instanceId: RUN_ID,
  attempt: 0,
  startedAt: null,
  finishedAt: null,
  cancelRequestedAt: null,
  createdAt: now,
  ...overrides,
})

const stats = (overrides: Record<string, unknown> = {}) => ({
  since: '2025-05-02T00:00:00Z',
  items: [
    {
      agentKey: TEST_SUMMARIZE,
      runs: 12,
      succeeded: 10,
      failed: 1,
      active: 1,
      tokens: 15300,
      costUsd: 0.0123,
      avgDurationMs: 42_000,
      lastRun: { id: RUN_ID, status: 'succeeded', createdAt: now, finishedAt: now },
      ...overrides,
    },
  ],
})

function mount(routes: RouteTable = {}, route = '/agents') {
  const fetchMock = stubFetch({
    '/api/agents': AGENTS,
    '/api/agents/runs': paged([]),
    '/api/agents/stats': stats(),
    '/api/agents/interrupts': paged([]),
    ...routes,
  })
  // The same route pair App.tsx mounts — two PAGES now, not one page and a drawer — so
  // `navigate('/agents/runs/:id')` really lands on the run workspace.
  renderWithProviders(
    <Routes>
      <Route path="/agents" element={<AgentsPage />} />
      <Route path="/agents/runs" element={<AllRunsPage />} />
      <Route path="/agents/:agentKey" element={<AgentPage />} />
      <Route path="/agents/runs/:runId" element={<RunPage />} />
    </Routes>,
    { session: makeSession(), route }
  )
  return fetchMock
}

const openDialog = () => document.querySelector('dialog[open]') as HTMLElement

describe('Agents page', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('offers no Run button for an agent the app starts itself (startable: false)', async () => {
    const [agent] = AGENTS.items
    mount({
      '/api/agents': {
        items: [agent, { ...agent, key: TEST_RESEARCH, title: 'App-started', startable: false }],
      },
    })
    expect(await screen.findByRole('link', { name: 'App-started' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run Summarize text' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run App-started' })).not.toBeInTheDocument()
  })

  it('lists each agent once, with its last run and 30-day metrics, and no runs table', async () => {
    const fetchMock = mount()
    const table = await screen.findByRole('table', { name: 'Agents' })
    const row = within(table).getByText('Summarize text').closest('tr') as HTMLElement
    expect(within(row).getByRole('link', { name: 'Summarize text' })).toHaveAttribute(
      'href',
      `/agents/${TEST_SUMMARIZE}`
    )
    expect(within(row).getByText('One run at a time')).toBeInTheDocument()
    expect(await within(row).findByText('12 · 1 failed · 1 active')).toBeInTheDocument()
    expect(within(row).getByText(/^15\.3k$/i)).toBeInTheDocument()
    expect(within(row).getByText('42s')).toBeInTheDocument()
    expect(within(row).getByText('$0.0123')).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'Last run of Summarize text' })).toHaveAttribute(
      'href',
      `/agents/runs/${RUN_ID}`
    )
    expect(screen.queryByRole('table', { name: 'Agent runs' })).toBeNull()
    // One request for every agent's metrics, never one per agent.
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/agents/stats'))
    ).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'All runs' })).toHaveAttribute('href', '/agents/runs')
  })

  it('stacks below sm like the runs table: the agent, its last run and Run stay; the figures go', async () => {
    mount()
    const table = await screen.findByRole('table', { name: 'Agents' })
    const row = within(table).getByText('Summarize text').closest('tr') as HTMLElement
    // jsdom applies no media query, so this pins the shared classes (`lib/stacked-table.ts`).
    expect(table).toHaveClass(STACK_TABLE)
    expect(row.className).toContain(STACK_ROW)
    const cellOf = (el: HTMLElement) => el.closest('td') as HTMLElement
    const hidden = (el: HTMLElement) => cellOf(el).className.includes(STACK_HIDE)
    expect(hidden(within(row).getByRole('link', { name: 'Last run of Summarize text' }))).toBe(
      false
    )
    expect(hidden(within(row).getByRole('button', { name: 'Run Summarize text' }))).toBe(false)
    expect(hidden(await within(row).findByText('12 · 1 failed · 1 active'))).toBe(true)
    // The lead cell's minimum width is a desktop rule; on a phone it would force the overflow.
    expect(cellOf(within(row).getByRole('link', { name: 'Summarize text' })).className).not.toMatch(
      /(^|\s)min-w-\[18rem\]/
    )
  })

  it("an agent's page shows its metrics and only its runs", async () => {
    const fetchMock = mount(
      {
        '/api/agents/runs': paged([
          run({ status: 'succeeded', startedAt: now, finishedAt: '2025-06-01T00:00:04Z' }),
        ]),
      },
      `/agents/${TEST_SUMMARIZE}`
    )
    expect(await screen.findByRole('heading', { name: 'Summarize text' })).toBeInTheDocument()
    const metrics = await screen.findByLabelText('Agent metrics')
    expect(await within(metrics).findByText('12')).toBeInTheDocument()
    expect(within(metrics).getByText('10 succeeded · 1 failed')).toBeInTheDocument()
    const table = await screen.findByRole('table', { name: 'Agent runs' })
    expect(within(table).getByText('Succeeded')).toBeInTheDocument()
    expect(within(table).getByText('You')).toBeInTheDocument()
    expect(within(table).getByText('4s')).toBeInTheDocument()
    // Fixed to this agent: no agent filter, and every request names it.
    expect(screen.queryByLabelText('Agent')).toBeNull()
    const runCalls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter(u => u.includes('/api/agents/runs?'))
    expect(runCalls.length).toBeGreaterThan(0)
    expect(runCalls.every(u => u.includes(`agentKey=${TEST_SUMMARIZE}`))).toBe(true)
  })

  it('an unknown agent key is an empty state, not a crash', async () => {
    mount({}, '/agents/no-such-agent')
    expect(await screen.findByText('No such agent')).toBeInTheDocument()
  })

  it("maps the route's 400 onto the field, then posts the exact run body", async () => {
    const fetchMock = mount({
      'POST /api/agents/runs': (init: RequestInit | undefined) => {
        const body = JSON.parse(String(init?.body)) as { input: { text?: string } }
        // A schema-generated form validates thinly; the route's zod issues are the authority.
        if (!body.input.text) {
          return jsonResponse(
            {
              error: 'Validation failed',
              statusCode: 400,
              code: 'validation_failed',
              details: [{ path: ['text'], message: 'Text is required' }],
            },
            400
          )
        }
        return jsonResponse(run({ input: body.input }), 202)
      },
      [`/api/agents/runs/${RUN_ID}`]: { ...run(), events: [], interrupts: [], artifacts: [] },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Run Summarize text' }))
    const form = document.getElementById('run-agent-form') as HTMLFormElement
    expect(openDialog()).toBeTruthy()

    // Empty text → the route's issue lands on the field, and nothing navigates.
    fireEvent.submit(form)
    expect(await screen.findByText('Text is required')).toBeInTheDocument()
    expect(openDialog()).toBeTruthy()

    fireEvent.change(screen.getByLabelText(/Text to summarise/), {
      target: { value: 'Some long text' },
    })
    fireEvent.change(screen.getByLabelText(/Style/), { target: { value: 'paragraph' } })
    fireEvent.click(screen.getByLabelText(/Index the result for search/))
    fireEvent.submit(form)

    const posts = () =>
      fetchMock.mock.calls
        .filter(([, init]) => init?.method === 'POST')
        .map(([, init]) => JSON.parse(String(init?.body)) as unknown)
    await waitFor(() =>
      expect(posts().at(-1)).toEqual({
        agentKey: TEST_SUMMARIZE,
        input: { text: 'Some long text', style: 'paragraph', index: true },
      })
    )
    // Navigated to the run: the detail drawer loads it
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes(`/api/agents/runs/${RUN_ID}`))
      ).toBe(true)
    )
  })

  it('opens the existing run when the 202 is deduplicated', async () => {
    const fetchMock = mount({
      'POST /api/agents/runs': () => jsonResponse({ ...run(), deduplicated: true }, 202),
      [`/api/agents/runs/${RUN_ID}`]: { ...run(), events: [], interrupts: [], artifacts: [] },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Run Summarize text' }))
    fireEvent.change(screen.getByLabelText(/Text to summarise/), { target: { value: 'hello' } })
    fireEvent.submit(document.getElementById('run-agent-form') as HTMLFormElement)

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes(`/api/agents/runs/${RUN_ID}`))
      ).toBe(true)
    )
  })

  it('renders the not-configured empty state on a 503 agent_runs_not_configured', async () => {
    mount({
      'POST /api/agents/runs': () =>
        errorResponse(503, 'Agent runs are not configured', 'agent_runs_not_configured'),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Run Summarize text' }))
    fireEvent.change(screen.getByLabelText(/Text to summarise/), { target: { value: 'hello' } })
    fireEvent.submit(document.getElementById('run-agent-form') as HTMLFormElement)

    expect(await screen.findByText('Agent runs are not configured')).toBeInTheDocument()
    expect(screen.getByText(/no run engine/)).toBeInTheDocument()
  })

  it('all runs: sends the agent and status filters as query params', async () => {
    const fetchMock = mount({}, '/agents/runs')
    await screen.findByText('No runs yet')
    expect(screen.getByLabelText('Agent')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } })
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('status=failed'))).toBe(
        true
      )
    )
    const url = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find(u => u.includes('status=failed'))
    expect(url).toContain('/api/agents/runs?')
    expect(url).toContain('page=1')
  })

  it('all runs: names who asked for each run, never a user id', async () => {
    const OTHER = '00000000-0000-4000-8000-0000000000aa'
    mount(
      {
        '/api/agents/runs': paged([
          run({ requestedByUserId: OTHER, requestedBy: { id: OTHER, name: 'Priya Raman' } }),
        ]),
      },
      '/agents/runs'
    )
    const table = await screen.findByRole('table', { name: 'Agent runs' })
    expect(within(table).getByText('Priya Raman')).toBeInTheDocument()
    expect(within(table).getByText('PR')).toBeInTheDocument()
    expect(table).not.toHaveTextContent(OTHER.slice(0, 8))
  })
})
