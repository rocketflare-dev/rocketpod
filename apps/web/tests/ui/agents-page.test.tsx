/**
 * `/agents` (D7): the registry renders with the exclusive badge; the run modal, built from the
 * agent's own JSON Schema, maps the route's 400 onto the field and posts the exact
 * `{ agentKey, input }` body; a 202 `deduplicated` answer
 * opens the existing run; a 503 `agent_runs_not_configured` renders the explanatory
 * empty state instead of a toast; the runs table shows status, agent and filters.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentsPage from '@/ui/pages/agents/AgentsPage'
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

function mount(routes: RouteTable = {}, route = '/agents') {
  const fetchMock = stubFetch({
    '/api/agents': AGENTS,
    '/api/agents/runs': paged([]),
    ...routes,
  })
  // The same route pair App.tsx mounts — two PAGES now, not one page and a drawer — so
  // `navigate('/agents/runs/:id')` really lands on the run workspace.
  renderWithProviders(
    <Routes>
      <Route path="/agents" element={<AgentsPage />} />
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
    expect(await screen.findByText('App-started', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run Summarize text' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run App-started' })).not.toBeInTheDocument()
  })

  it('lists the registry with the exclusive badge and the runs table', async () => {
    mount({
      '/api/agents/runs': paged([
        run({ status: 'succeeded', startedAt: now, finishedAt: '2025-06-01T00:00:04Z' }),
      ]),
    })
    expect(await screen.findByText('Summarize text', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('exclusive')).toBeInTheDocument()
    const table = await screen.findByRole('table', { name: 'Agent runs' })
    expect(within(table).getByText('Succeeded')).toBeInTheDocument()
    expect(within(table).getByText('You')).toBeInTheDocument()
    expect(within(table).getByText('4s')).toBeInTheDocument()
    expect(screen.getByLabelText('Agent')).toHaveValue('')
    expect(screen.getByLabelText('Status')).toHaveValue('')
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

  it('sends the agent and status filters as query params', async () => {
    const fetchMock = mount()
    await screen.findByText('No runs yet')
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
})
