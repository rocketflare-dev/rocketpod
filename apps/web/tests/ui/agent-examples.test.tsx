/**
 * The `summarize-text` EXAMPLE's own UI (`forms/summarize-text.tsx`, `outputs/summarize-text.tsx`):
 * its hand-written form validates with the shared input schema before anything is posted, and a
 * settled run renders through its typed output view. The pages themselves are tested apart from
 * the examples (`agents-page`, `run-page`, on the test-only agents); this file goes with the
 * example when a copy deletes it.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentsPage from '@/ui/pages/agents/AgentsPage'
import RunPage from '@/ui/pages/agents/RunPage'
import {
  IDS,
  jsonResponse,
  makeSession,
  paged,
  type RouteTable,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const now = '2025-06-01T00:00:00Z'
const RUN_ID = '99999999-9999-4999-8999-999999999999'
const DOC_ID = '55555555-5555-4555-8555-555555555555'

const AGENTS = {
  items: [
    {
      key: 'summarize-text',
      title: 'Summarize text',
      description: 'Summarises a block of text.',
      promptKey: 'summarize-text',
      exclusive: true,
    },
  ],
}

const run = (overrides: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  tenantId: IDS.tenant,
  agentKey: 'summarize-text',
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
  events: [],
  interrupts: [],
  artifacts: [],
  ...overrides,
})

function mount(routes: RouteTable, route: string) {
  const fetchMock = stubFetch({
    '/api/agents': AGENTS,
    '/api/agents/runs': paged([]),
    '/api/agents/interrupts': paged([]),
    [`/api/agents/runs/${RUN_ID}/agui`]: { events: [], lastSeq: 0 },
    ...routes,
  })
  renderWithProviders(
    <Routes>
      <Route path="/agents" element={<AgentsPage />} />
      <Route path="/agents/runs/:runId" element={<RunPage />} />
    </Routes>,
    { session: makeSession(), route }
  )
  return fetchMock
}

describe('summarize-text (example agent) UI', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('its form validates with the shared schema, then posts the trimmed input with defaults', async () => {
    const fetchMock = mount(
      {
        'POST /api/agents/runs': (init: RequestInit | undefined) => {
          const body = JSON.parse(String(init?.body)) as { input: unknown }
          return jsonResponse(run({ input: body.input }), 202)
        },
        [`/api/agents/runs/${RUN_ID}`]: run(),
      },
      '/agents'
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Run Summarize text' }))
    const form = document.getElementById('run-agent-form') as HTMLFormElement

    // Empty text → a field error, and no request: the shared schema runs in the browser.
    fireEvent.submit(form)
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0)
    expect(requestBody(fetchMock, 'POST /api/agents/runs')).toBeUndefined()

    fireEvent.change(screen.getByLabelText('Text to summarise'), {
      target: { value: '  Some long text  ' },
    })
    fireEvent.change(screen.getByLabelText('Style'), { target: { value: 'paragraph' } })
    fireEvent.click(screen.getByLabelText('Index the result for search'))
    fireEvent.submit(form)

    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/agents/runs')).toEqual({
        agentKey: 'summarize-text',
        input: { text: 'Some long text', style: 'paragraph', index: true },
      })
    )
  })

  it('a settled run renders through its typed output view', async () => {
    mount(
      {
        [`/api/agents/runs/${RUN_ID}`]: run({
          status: 'succeeded',
          startedAt: now,
          finishedAt: '2025-06-01T00:00:04Z',
          output: { summary: 'Short summary', keyPoints: ['One', 'Two'], documentId: DOC_ID },
        }),
      },
      `/agents/runs/${RUN_ID}`
    )
    expect(await screen.findByText('Short summary')).toBeInTheDocument()
    expect(screen.getByText('One')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open the indexed document/ })).toHaveAttribute(
      'href',
      `/documents/${DOC_ID}`
    )
  })
})
