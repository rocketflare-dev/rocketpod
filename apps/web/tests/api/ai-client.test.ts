/**
 * `services/ai/client.ts` (D17) with an INJECTED fetch (no globals mocked): OpenAI-compatible
 * SSE parsing incl. tool-call deltas and usage; error normalisation 401→auth, 429→rate_limit,
 * 404→invalid_request; the Anthropic path through the real SDK against a fake SSE body (bearer
 * `authToken` for compatible vendors, explicit `thinking: disabled`, `reconcileThinking`);
 * and embeddings over OpenAI-shaped `/embeddings`.
 */

import { ADAPTIVE_THINKING_MIN_MAX_TOKENS, defaultModelFor } from '@rocketpod/shared/ai/config'
import { priceFor } from '@rocketpod/shared/ai/pricing'
import { describe, expect, it } from 'vitest'
import {
  createChatClient,
  createEmbeddingsClient,
  type FetchLike,
  reconcileThinking,
  toResponsesInput,
  unsupportedSchemaKeywords,
  withoutSchemaKeywords,
} from '@/api/services/ai/client'
import { AiError, describeAiError, normalizeAiError, redactSecrets } from '@/api/services/ai/errors'
import { providerInfo } from '@/api/services/ai/providers'
import { type ChatDelta, type ChatMessage, textOf } from '@/api/services/ai/types'
import { sseResponse } from '../helpers/ai'

interface Captured {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** A fetch that records the request and answers with `respond()`. */
function fakeFetch(respond: (req: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = []
  const impl: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    const captured: Captured = {
      url: String(input instanceof Request ? input.url : input),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    }
    calls.push(captured)
    return respond(captured)
  }
  return { fetch: impl, calls }
}

async function collect(iter: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = []
  for await (const d of iter) out.push(d)
  return out
}

const openAiChunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: 'x', model: 'fake-1', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`

describe('OpenAI-compatible chat client', () => {
  it('streams text deltas, assembles tool calls from argument fragments, and reports usage', async () => {
    const { fetch, calls } = fakeFetch(() =>
      sseResponse([
        openAiChunk({ role: 'assistant', content: 'Hel' }),
        openAiChunk({ content: 'lo' }),
        openAiChunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'search', arguments: '{"q":' },
            },
          ],
        }),
        openAiChunk({ tool_calls: [{ index: 0, function: { arguments: '"cats"}' } }] }),
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } } })}\n\n`,
        'data: [DONE]\n\n',
      ])
    )
    const client = createChatClient({
      provider: 'openai_compatible',
      apiKey: 'k',
      baseUrl: 'http://mock/v1/',
      fetch,
    })
    const deltas = await collect(
      client.stream({
        model: 'fake-1',
        maxTokens: 50,
        system: { stable: 'SYS', volatile: 'now' },
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'search', description: 'd', inputSchema: { type: 'object' } }],
        toolChoice: { type: 'auto' },
      })
    )
    expect(deltas.map(d => d.type)).toEqual(['text', 'text', 'tool_use', 'usage', 'end'])
    expect(deltas[2]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'search',
      input: { q: 'cats' },
    })
    const end = deltas.at(-1)
    expect(end?.type === 'end' && end.result).toMatchObject({
      stopReason: 'tool_use',
      model: 'fake-1',
      // `prompt_tokens` (11) INCLUDES the 4 cached, so uncached input is 7 — priced once, not twice.
      usage: { inputTokens: 7, outputTokens: 7, cacheReadTokens: 4 },
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', name: 'search' },
      ],
    })
    expect(calls[0]?.url).toBe('http://mock/v1/chat/completions')
    expect(calls[0]?.headers.authorization).toBe('Bearer k')
    expect(calls[0]?.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 50,
      messages: [
        { role: 'system', content: 'SYS\n\nnow' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', function: { name: 'search' } }],
      tool_choice: 'auto',
    })
  })

  it('complete() round-trips tool_result turns as role=tool messages', async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            model: 'fake-1',
            choices: [
              { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    )
    const client = createChatClient({
      provider: 'openai_compatible',
      apiKey: 'k',
      baseUrl: 'https://compat.test/v1',
      fetch,
    })
    const result = await client.complete({
      model: 'fake-1',
      maxTokens: 10,
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'c1', name: 'search', input: { q: 'x' } }],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'found' }] },
      ],
    })
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Done' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 1 },
      model: 'fake-1',
    })
    expect(calls[0]?.url).toBe('https://compat.test/v1/chat/completions')
    expect(calls[0]?.body.messages).toEqual([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'found' },
    ])
  })

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [404, 'invalid_request'],
    [400, 'invalid_request'],
    [503, 'unavailable'],
  ] as const)('HTTP %i → AiError code %s, body never leaks a key', async (status, code) => {
    const { fetch } = fakeFetch(
      () => new Response(`{"error":"bad key sk-abcdefghijklmnopqrstuvwxyz012345"}`, { status })
    )
    const client = createChatClient({
      provider: 'openai_compatible',
      apiKey: 'sk-secret',
      baseUrl: 'http://mock/v1',
      fetch,
    })
    const err = await client
      .complete({ model: 'm', maxTokens: 1, messages: [{ role: 'user', content: 'x' }] })
      .catch(e => e)
    expect(err).toBeInstanceOf(AiError)
    expect(err.code).toBe(code)
    expect(err.status).toBe(status)
    expect(err.message).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(describeAiError(err)).toMatch(/provider/i)
  })

  it('requires a key and a base URL up front', () => {
    expect(() => createChatClient({ provider: 'openai_compatible', apiKey: 'k' })).toThrow(AiError)
    expect(() => createChatClient({ provider: 'openai', apiKey: '' })).toThrow(AiError)
  })
})

/** An Anthropic Messages SSE body for one text reply. */
function anthropicStream(text: string, toolUse?: { id: string; name: string; json: string }) {
  const ev = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const chunks = [
    ev('message_start', {
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 12,
          output_tokens: 1,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 0,
        },
      },
    }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(0, 3) } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(3) } }),
    ev('content_block_stop', { index: 0 }),
  ]
  if (toolUse) {
    chunks.push(
      ev('content_block_start', {
        index: 1,
        content_block: { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: {} },
      }),
      ev('content_block_delta', {
        index: 1,
        delta: { type: 'input_json_delta', partial_json: toolUse.json },
      }),
      ev('content_block_stop', { index: 1 })
    )
  }
  chunks.push(
    ev('message_delta', {
      delta: { stop_reason: toolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 9 },
    }),
    ev('message_stop', {})
  )
  return chunks
}

describe('Gemini tool schemas (OpenAI-compatible)', () => {
  it('is recognised by its endpoint or a gemini model id', () => {
    expect(
      unsupportedSchemaKeywords('https://generativelanguage.googleapis.com/v1beta/openai', 'x')
    ).toEqual(['maxItems'])
    expect(unsupportedSchemaKeywords('https://proxy.example', 'gemini-3.8-flash')).toEqual([
      'maxItems',
    ])
    expect(unsupportedSchemaKeywords('https://api.fireworks.ai/inference/v1', 'kimi')).toEqual([])
  })

  it('drops the keyword at schema positions only and restates the bound', () => {
    const schema = {
      type: 'object',
      properties: {
        maxItems: { type: 'string' },
        items: { type: 'array', maxItems: 6, description: 'Things.', items: { type: 'string' } },
      },
    }
    expect(withoutSchemaKeywords(schema, ['maxItems'])).toEqual({
      type: 'object',
      properties: {
        maxItems: { type: 'string' },
        items: {
          type: 'array',
          description: 'Things. At most 6 items.',
          items: { type: 'string' },
        },
      },
    })
  })

  it('sends Gemini a tool schema without maxItems, and every other endpoint the schema as is', async () => {
    const inputSchema = {
      type: 'object',
      properties: { tags: { type: 'array', maxItems: 3, items: { type: 'string' } } },
    }
    const answer = () =>
      new Response(
        JSON.stringify({
          model: 'm',
          choices: [{ index: 0, finish_reason: 'stop', message: { content: 'ok' } }],
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    const sent = async (baseUrl: string) => {
      const { fetch, calls } = fakeFetch(answer)
      const client = createChatClient({
        provider: 'openai_compatible',
        apiKey: 'k',
        baseUrl,
        fetch,
      })
      await client.complete({
        model: 'gemini-3.8-flash',
        maxTokens: 10,
        messages: [{ role: 'user', content: 'q' }],
        tools: [{ name: 'tag', description: 'd', inputSchema }],
      })
      const tools = calls[0]?.body.tools as { function: { parameters: unknown } }[]
      return tools[0]?.function.parameters
    }
    expect(await sent('https://generativelanguage.googleapis.com/v1beta/openai')).toEqual({
      type: 'object',
      properties: {
        tags: { type: 'array', description: 'At most 3 items.', items: { type: 'string' } },
      },
    })
    const { fetch, calls } = fakeFetch(answer)
    await createChatClient({
      provider: 'openai_compatible',
      apiKey: 'k',
      baseUrl: 'https://compat.test/v1',
      fetch,
    }).complete({
      model: 'fake-1',
      maxTokens: 10,
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ name: 'tag', description: 'd', inputSchema }],
    })
    const tools = calls[0]?.body.tools as { function: { parameters: unknown } }[]
    expect(tools[0]?.function.parameters).toEqual(inputSchema)
  })
})

describe('Anthropic chat client (real SDK, fake transport)', () => {
  it('anthropic_compatible sends Authorization: Bearer to the base URL, thinking disabled explicitly, cache breakpoints on', async () => {
    const { fetch, calls } = fakeFetch(() =>
      sseResponse(anthropicStream('Hi there', { id: 'tu_1', name: 'search', json: '{"q":"x"}' }))
    )
    const client = createChatClient({
      provider: 'anthropic_compatible',
      apiKey: 'fw-token',
      baseUrl: 'https://compat.test/inference',
      fetch,
    })
    const deltas = await collect(
      client.stream({
        model: 'accounts/x/models/y',
        maxTokens: 64,
        system: 'SYS',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          { name: 'search', description: 'd', inputSchema: { type: 'object', properties: {} } },
        ],
      })
    )
    expect(deltas.map(d => d.type)).toEqual(['text', 'text', 'tool_use', 'usage', 'end'])
    expect(deltas[2]).toEqual({ type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'x' } })
    const end = deltas.at(-1)
    expect(end?.type === 'end' && end.result).toMatchObject({
      model: 'claude-x',
      stopReason: 'tool_use',
      usage: { inputTokens: 12, outputTokens: 9, cacheReadTokens: 5, cacheWriteTokens: 0 },
      content: [
        { type: 'text', text: 'Hi there' },
        { type: 'tool_use', id: 'tu_1' },
      ],
    })
    const req = calls[0]
    expect(req?.url).toBe('https://compat.test/inference/v1/messages')
    expect(req?.headers.authorization).toBe('Bearer fw-token')
    expect(req?.headers['x-api-key']).toBeUndefined()
    expect(req?.body).toMatchObject({
      model: 'accounts/x/models/y',
      max_tokens: 64,
      stream: true,
      thinking: { type: 'disabled' },
      system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }],
        },
      ],
      tools: [{ name: 'search' }],
    })
  })

  it('anthropic_compatible retries once without thinking when the vendor rejects `disabled`, and remembers', async () => {
    // Fireworks maps `thinking: disabled` to reasoning effort `none`; gpt-oss refuses it with a 400.
    const refusal = () =>
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Invalid reasoning effort: none' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    const { fetch, calls } = fakeFetch(req =>
      req.body.thinking ? refusal() : sseResponse(anthropicStream('Hello'))
    )
    const client = createChatClient({
      provider: 'anthropic_compatible',
      apiKey: 'fw-token',
      baseUrl: 'https://compat.test/inference',
      fetch,
    })
    const params = {
      model: 'accounts/fireworks/models/gpt-oss-120b',
      maxTokens: 64,
      messages: [{ role: 'user' as const, content: 'hi' }],
    }
    const deltas = await collect(client.stream(params))
    const text = deltas.map(d => (d.type === 'text' ? d.text : '')).join('')
    expect(text).toBe('Hello')
    expect(calls.map(c => 'thinking' in c.body)).toEqual([true, false])
    // Remembered: the next call goes straight out without the field.
    await collect(client.stream(params))
    expect(calls.map(c => 'thinking' in c.body)).toEqual([true, false, false])

    // A different 400 is not retried, and first-party Anthropic never is.
    const other = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'bad' },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
    )
    const strict = createChatClient({
      provider: 'anthropic_compatible',
      apiKey: 'fw-token',
      baseUrl: 'https://compat.test/inference',
      fetch: other.fetch,
    })
    await expect(collect(strict.stream(params))).rejects.toBeInstanceOf(AiError)
    expect(other.calls).toHaveLength(1)
  })

  it('anthropic sends x-api-key and maps 401/429/overloaded to codes', async () => {
    let status = 401
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'invalid x-api-key' },
          }),
          { status }
        )
    )
    const client = createChatClient({ provider: 'anthropic', apiKey: 'sk-ant-secret', fetch })
    const params = {
      model: 'claude-x',
      maxTokens: 5,
      messages: [{ role: 'user' as const, content: 'x' }],
      cache: false,
    }
    let err = await client.complete(params).catch(e => e)
    expect(err).toBeInstanceOf(AiError)
    expect(err.code).toBe('auth')
    expect(calls[0]?.headers['x-api-key']).toBe('sk-ant-secret')
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    status = 529
    err = await client.complete(params).catch(e => e)
    expect(err.code).toBe('rate_limit')
  })

  it('reconcileThinking drops thinking on a forced tool choice and lifts max_tokens under a budget', () => {
    const forced = reconcileThinking({
      thinking: { type: 'enabled', budget_tokens: 2000 },
      tool_choice: { type: 'tool', name: 'x' },
      max_tokens: 100,
    })
    expect(forced).not.toHaveProperty('thinking')
    const lifted = reconcileThinking({
      thinking: { type: 'enabled', budget_tokens: 2000 },
      max_tokens: 100,
    })
    expect(lifted.max_tokens).toBe(2512)
    const fine = reconcileThinking({
      thinking: { type: 'enabled', budget_tokens: 2000 },
      max_tokens: 8000,
    })
    expect(fine.max_tokens).toBe(8000)
    expect(reconcileThinking({ thinking: { type: 'disabled' }, max_tokens: 5 })).toEqual({
      thinking: { type: 'disabled' },
      max_tokens: 5,
    })
  })
})

describe('embeddings clients', () => {
  it('OpenAI-shaped /embeddings with dimensions=1024, order restored by index', async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [2] },
              { index: 0, embedding: [1] },
            ],
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    )
    const client = createEmbeddingsClient({
      provider: 'openai_compatible',
      model: 'emb',
      apiKey: 'k',
      baseUrl: 'http://mock/v1',
      fetch,
    })
    expect(await client.embed(['a', 'b'])).toEqual([[1], [2]])
    expect(await client.embed([])).toEqual([])
    expect(calls[0]?.url).toBe('http://mock/v1/embeddings')
    expect(calls[0]?.body).toEqual({ model: 'emb', input: ['a', 'b'], dimensions: 1024 })
    expect(client.dimension).toBe(1024)
  })
})

describe('error helpers', () => {
  it('redactSecrets scrubs headers, bearer tokens, sk-/AKIA prefixes and long tokens', () => {
    const text =
      'Authorization: Bearer abc.def x-api-key=sk-ant-0123456789 AKIA0123456789AB and 0123456789abcdef0123456789abcdef'
    const out = redactSecrets(text)
    expect(out).not.toMatch(/abc\.def|sk-ant|AKIA0|0123456789abcdef0123456789abcdef/)
    expect(out).toContain('[redacted]')
  })

  it('normalizeAiError passes AiError through and classifies transport failures', () => {
    const own = new AiError('auth', 'openai', 'x')
    expect(normalizeAiError(own, 'anthropic')).toBe(own)
    expect(normalizeAiError(new TypeError('fetch failed'), 'openai').code).toBe('unavailable')
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(normalizeAiError(abort, 'openai').code).toBe('unavailable')
    expect(
      normalizeAiError(
        Object.assign(new Error('Your credit balance is too low'), { status: 400 }),
        'anthropic'
      ).code
    ).toBe('auth')
    expect(normalizeAiError(new Error('weird'), 'openai').code).toBe('unknown')
  })
})

/** A non-streamed Anthropic Messages answer. */
function anthropicMessage(content: unknown[], stop = 'end_turn') {
  return new Response(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-x',
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { headers: { 'content-type': 'application/json' } }
  )
}

const anthropic400 = (message: string) =>
  new Response(
    JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
    { status: 400, headers: { 'content-type': 'application/json' } }
  )

const SEARCH_TOOL = {
  name: 'search',
  description: 'd',
  inputSchema: { type: 'object', properties: {} },
}

describe('Anthropic chat client — per-model rules (Claude 4.5 → 5.5)', () => {
  const send = async (
    model: string,
    params: Record<string, unknown> = {},
    thinking?: { enabled: boolean; budgetTokens?: number }
  ) => {
    const { fetch, calls } = fakeFetch(() => anthropicMessage([{ type: 'text', text: 'ok' }]))
    const client = createChatClient({
      provider: 'anthropic',
      apiKey: 'k',
      fetch,
      defaults: thinking ? { thinking } : undefined,
    })
    await client.complete({
      model,
      maxTokens: 64,
      cache: false,
      messages: [{ role: 'user', content: 'hi' }],
      ...params,
    })
    return calls[0]?.body as Record<string, unknown>
  }

  it('Opus 5.5 always thinks: no `thinking` field, no temperature, a forced tool becomes an instruction, room to think', async () => {
    const body = await send('claude-opus-5-5', {
      temperature: 0,
      system: 'SYS',
      tools: [SEARCH_TOOL],
      toolChoice: { type: 'tool', name: 'search' },
    })
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('temperature')
    expect(body.tool_choice).toEqual({ type: 'auto' })
    expect(JSON.stringify(body.system)).toContain(
      'You must answer by calling the \\"search\\" tool'
    )
    expect(body.max_tokens).toBe(ADAPTIVE_THINKING_MIN_MAX_TOKENS)
  })

  it('Sonnet 5.5 turns thinking down with `between_tools`; on is adaptive and a stored budget is not sent', async () => {
    expect((await send('claude-sonnet-5-5')).thinking).toEqual({ type: 'between_tools' })
    const on = await send('claude-sonnet-5-5', {}, { enabled: true, budgetTokens: 2048 })
    expect(on.thinking).toEqual({ type: 'adaptive' })
    expect(on.max_tokens).toBe(ADAPTIVE_THINKING_MIN_MAX_TOKENS)
  })

  it('Haiku 5.5 takes `disabled` and a forced tool, but never a temperature', async () => {
    const body = await send('claude-haiku-5-5', {
      temperature: 0,
      tools: [SEARCH_TOOL],
      toolChoice: { type: 'tool', name: 'search' },
    })
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'search' })
    expect(body).not.toHaveProperty('temperature')
    expect(body.max_tokens).toBe(64)
  })

  it('Claude 4.5 keeps the budget contract and its temperature while thinking is off', async () => {
    const off = await send('claude-haiku-4-5-20251001', { temperature: 0.2 })
    expect(off.thinking).toEqual({ type: 'disabled' })
    expect(off.temperature).toBe(0.2)
    const on = await send(
      'claude-sonnet-4-5',
      { temperature: 0.2 },
      {
        enabled: true,
        budgetTokens: 2048,
      }
    )
    expect(on.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
    // Older models refuse a temperature while they think.
    expect(on).not.toHaveProperty('temperature')
  })

  it('thinking blocks ride the transcript opaque and go back unmodified; another provider’s are dropped', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig-1' }
    const { fetch, calls } = fakeFetch(() =>
      anthropicMessage(
        [thinking, { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'x' } }],
        'tool_use'
      )
    )
    const client = createChatClient({ provider: 'anthropic', apiKey: 'k', fetch })
    const first = await client.complete({
      model: 'claude-haiku-5-5',
      maxTokens: 64,
      cache: false,
      messages: [{ role: 'user', content: 'q' }],
      tools: [SEARCH_TOOL],
    })
    expect(first.content[0]).toEqual({ type: 'reasoning', provider: 'anthropic', data: thinking })
    expect(textOf(first.content)).toBe('')

    await client.complete({
      model: 'claude-haiku-5-5',
      maxTokens: 64,
      cache: false,
      tools: [SEARCH_TOOL],
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', provider: 'openai', data: { type: 'reasoning', id: 'rs_1' } },
            ...first.content,
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu_1', content: 'found' }] },
      ],
    })
    const messages = calls[1]?.body.messages as Array<{ content: unknown[] }>
    const sent = messages[1]?.content
    expect(sent).toEqual([
      thinking,
      { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'x' } },
    ])
  })

  it('a replayed thinking block the API refuses is stripped for that call and the call retried', async () => {
    const { fetch, calls } = fakeFetch(req =>
      JSON.stringify(req.body).includes('sig-stale')
        ? anthropic400('messages.1.content.0: Invalid `signature` in `thinking` block.')
        : anthropicMessage([{ type: 'text', text: 'ok' }])
    )
    const client = createChatClient({ provider: 'anthropic', apiKey: 'k', fetch })
    const result = await client.complete({
      model: 'claude-sonnet-5-5',
      maxTokens: 64,
      cache: false,
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              provider: 'anthropic',
              data: { type: 'thinking', thinking: '', signature: 'sig-stale' },
            },
            { type: 'text', text: 'earlier' },
          ],
        },
        { role: 'user', content: 'again' },
      ],
    })
    expect(textOf(result.content)).toBe('ok')
    expect(calls).toHaveLength(2)
    expect(JSON.stringify(calls[1]?.body)).not.toContain('sig-stale')
  })

  it('a model the traits misread recovers once from a refused `thinking`, and remembers', async () => {
    const { fetch, calls } = fakeFetch(req =>
      req.body.thinking
        ? anthropic400('"thinking.type.disabled" is not supported for this model.')
        : anthropicMessage([{ type: 'text', text: 'ok' }])
    )
    const client = createChatClient({ provider: 'anthropic', apiKey: 'k', fetch })
    const params = {
      model: 'claude-haiku-5-5',
      maxTokens: 64,
      cache: false,
      messages: [{ role: 'user' as const, content: 'hi' }],
    }
    await client.complete(params)
    await client.complete(params)
    expect(calls.map(c => 'thinking' in c.body)).toEqual([true, false, false])
  })
})

/** One Responses-API SSE event. */
const responsesEvent = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

describe('OpenAI Responses client (first-party `openai`)', () => {
  const reasoningItem = {
    type: 'reasoning',
    id: 'rs_1',
    summary: [],
    encrypted_content: 'enc-1',
  }
  const callItem = {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_1',
    name: 'search',
    arguments: '{"q":"x"}',
    status: 'completed',
  }
  const usage = {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
    output_tokens: 7,
    output_tokens_details: { reasoning_tokens: 3 },
  }

  it('complete(): posts a stateless Responses body and reads items back in order, usage made disjoint', async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            model: 'gpt-6-luna',
            status: 'completed',
            output: [
              reasoningItem,
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Looking', annotations: [] }],
              },
              callItem,
            ],
            usage,
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    )
    const client = createChatClient({ provider: 'openai', apiKey: 'k', fetch })
    const result = await client.complete({
      model: 'gpt-6-luna',
      maxTokens: 512,
      temperature: 0,
      system: { stable: 'SYS', volatile: 'NOW' },
      tools: [SEARCH_TOOL],
      toolChoice: { type: 'tool', name: 'search' },
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', provider: 'openai', data: { ...reasoningItem, id: 'rs_0' } },
            { type: 'reasoning', provider: 'anthropic', data: { type: 'thinking' } },
            { type: 'text', text: 'Checking' },
            { type: 'tool_use', id: 'call_0', name: 'search', input: { q: 'a' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_0', content: 'found' }] },
      ],
    })

    const req = calls[0]
    expect(req?.url).toBe('https://api.openai.com/v1/responses')
    expect(req?.headers.authorization).toBe('Bearer k')
    expect(req?.body).toMatchObject({
      model: 'gpt-6-luna',
      store: false,
      stream: false,
      instructions: 'SYS\n\nNOW',
      max_output_tokens: 512,
      // Thinking off on Luna = effort `none`, which also leaves temperature legal.
      reasoning: { effort: 'none' },
      temperature: 0,
      tool_choice: { type: 'function', name: 'search' },
      tools: [{ type: 'function', name: 'search', description: 'd', strict: false }],
    })
    expect(req?.body.input).toEqual([
      { role: 'user', content: 'q' },
      { ...reasoningItem, id: 'rs_0' },
      { role: 'assistant', content: 'Checking' },
      { type: 'function_call', call_id: 'call_0', name: 'search', arguments: '{"q":"a"}' },
      { type: 'function_call_output', call_id: 'call_0', output: 'found' },
    ])
    expect(result).toEqual({
      content: [
        { type: 'reasoning', provider: 'openai', data: reasoningItem },
        { type: 'text', text: 'Looking' },
        { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 60, outputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 10 },
      model: 'gpt-6-luna',
    })
  })

  it('stream(): text deltas, whole tool calls from `output_item.done`, usage and an incomplete stop', async () => {
    const { fetch } = fakeFetch(() =>
      sseResponse([
        responsesEvent('response.created', { response: { status: 'in_progress' } }),
        responsesEvent('response.output_item.added', { output_index: 0, item: reasoningItem }),
        responsesEvent('response.output_item.done', { output_index: 0, item: reasoningItem }),
        responsesEvent('response.output_text.delta', { output_index: 1, delta: 'Hel' }),
        ': keep-alive\n\n',
        responsesEvent('response.output_text.delta', { output_index: 1, delta: 'lo' }),
        responsesEvent('response.output_item.done', {
          output_index: 1,
          item: {
            type: 'message',
            content: [{ type: 'output_text', text: 'Hello' }],
          },
        }),
        responsesEvent('response.function_call_arguments.delta', { output_index: 2, delta: '{' }),
        responsesEvent('response.output_item.done', { output_index: 2, item: callItem }),
        responsesEvent('response.incomplete', {
          response: {
            model: 'gpt-6-luna',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage,
          },
        }),
      ])
    )
    const client = createChatClient({ provider: 'openai', apiKey: 'k', fetch })
    const deltas = await collect(
      client.stream({
        model: 'gpt-6-luna',
        maxTokens: 64,
        tools: [SEARCH_TOOL],
        messages: [{ role: 'user', content: 'q' }],
      })
    )
    expect(deltas.map(d => d.type)).toEqual(['text', 'text', 'tool_use', 'usage', 'end'])
    const end = deltas.at(-1)
    expect(end?.type === 'end' && end.result).toEqual({
      content: [
        { type: 'reasoning', provider: 'openai', data: reasoningItem },
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } },
      ],
      stopReason: 'max_tokens',
      usage: { inputTokens: 60, outputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 10 },
      model: 'gpt-6-luna',
    })
  })

  it('a model that refuses `none` gets `low` (known up front, or learned once); thinking on sends no effort', async () => {
    const astra = fakeFetch(() => new Response(JSON.stringify({ status: 'completed', output: [] })))
    const client = createChatClient({ provider: 'openai', apiKey: 'k', fetch: astra.fetch })
    await client.complete({
      model: 'gpt-6-astra',
      maxTokens: 64,
      temperature: 0,
      messages: [{ role: 'user', content: 'q' }],
    })
    expect(astra.calls[0]?.body.reasoning).toEqual({ effort: 'low' })
    expect(astra.calls[0]?.body).not.toHaveProperty('temperature')
    expect(astra.calls[0]?.body.max_output_tokens).toBe(ADAPTIVE_THINKING_MIN_MAX_TOKENS)

    const learning = fakeFetch(req =>
      (req.body.reasoning as { effort?: string } | undefined)?.effort === 'none'
        ? new Response(
            JSON.stringify({ error: { message: "Unsupported value: 'reasoning.effort' none" } }),
            { status: 400 }
          )
        : new Response(JSON.stringify({ status: 'completed', output: [] }))
    )
    const unknown = createChatClient({ provider: 'openai', apiKey: 'k', fetch: learning.fetch })
    const params = {
      model: 'gpt-7-nova',
      maxTokens: 64,
      messages: [{ role: 'user' as const, content: 'q' }],
    }
    await unknown.complete(params)
    await unknown.complete(params)
    expect(learning.calls.map(c => (c.body.reasoning as { effort: string }).effort)).toEqual([
      'none',
      'low',
      'low',
    ])

    const on = fakeFetch(() => new Response(JSON.stringify({ status: 'completed', output: [] })))
    await createChatClient({
      provider: 'openai',
      apiKey: 'k',
      fetch: on.fetch,
      defaults: { thinking: { enabled: true } },
    }).complete({ model: 'gpt-6-luna', maxTokens: 64, messages: [{ role: 'user', content: 'q' }] })
    expect(on.calls[0]?.body).not.toHaveProperty('reasoning')

    // A non-reasoning model takes no reasoning field and keeps its temperature.
    const old = fakeFetch(() => new Response(JSON.stringify({ status: 'completed', output: [] })))
    await createChatClient({ provider: 'openai', apiKey: 'k', fetch: old.fetch }).complete({
      model: 'gpt-4.1-mini',
      maxTokens: 64,
      temperature: 0.3,
      messages: [{ role: 'user', content: 'q' }],
    })
    expect(old.calls[0]?.body).not.toHaveProperty('reasoning')
    expect(old.calls[0]?.body.temperature).toBe(0.3)
  })

  it('a failed response is an AiError, never a silent empty answer', async () => {
    const { fetch } = fakeFetch(() =>
      sseResponse([
        responsesEvent('response.failed', {
          response: { status: 'failed', error: { message: 'model overloaded' } },
        }),
      ])
    )
    const client = createChatClient({ provider: 'openai', apiKey: 'k', fetch })
    await expect(
      collect(
        client.stream({
          model: 'gpt-6-luna',
          maxTokens: 8,
          messages: [{ role: 'user', content: 'q' }],
        })
      )
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('provider catalog', () => {
  it('suggests current models and defaults to Haiku 5.5 / GPT-6 Luna', () => {
    expect(providerInfo('anthropic').suggestedModels.chat).toContain('claude-haiku-5-5')
    expect(providerInfo('anthropic').suggestedModels.chat).not.toContain('claude-opus-4-1')
    expect(providerInfo('anthropic').defaultModel).toBe('claude-haiku-5-5')
    expect(defaultModelFor('openai', 'chat')).toBe('gpt-6-luna')
    // Every suggested chat model is priced, so the Usage page never shows it as unpriced.
    for (const id of ['anthropic', 'openai'] as const) {
      for (const model of providerInfo(id).suggestedModels.chat) {
        expect(priceFor(id, model), `${id} ${model}`).not.toBeNull()
      }
    }
  })
})

describe('image blocks — each adapter its own wire shape', () => {
  const PNG = 'iVBORw0KGgo='
  // A turn that answers a tool call AND shows the model the picture the tool opened.
  const turn: ChatMessage[] = [
    { role: 'user', content: 'look at the file' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: {} }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'c1', content: 'an image, attached' },
        { type: 'text', text: 'Here it is.' },
        { type: 'image', mediaType: 'image/png', data: PNG },
      ],
    },
  ]
  const textAnswer = () =>
    new Response(
      JSON.stringify({
        model: 'm',
        choices: [{ index: 0, finish_reason: 'stop', message: { content: 'ok' } }],
      }),
      { headers: { 'content-type': 'application/json' } }
    )

  it('OpenAI-compatible: an image_url data URL in a user message AFTER the tool results', async () => {
    const { fetch, calls } = fakeFetch(textAnswer)
    await createChatClient({
      provider: 'openai_compatible',
      apiKey: 'k',
      baseUrl: 'https://compat.test/v1',
      fetch,
    }).complete({ model: 'm', maxTokens: 10, messages: turn })
    expect((calls[0]?.body.messages as unknown[] | undefined)?.slice(2)).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'an image, attached' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Here it is.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
        ],
      },
    ])
  })

  it('OpenAI Responses: an input_image part after the function_call_output', () => {
    expect(
      toResponsesInput({ model: 'gpt-6-luna', maxTokens: 10, messages: turn }).slice(-2)
    ).toEqual([
      { type: 'function_call_output', call_id: 'c1', output: 'an image, attached' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Here it is.' },
          { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
        ],
      },
    ])
  })

  it('Anthropic: a base64 image block in place, beside the tool_result', async () => {
    const { fetch, calls } = fakeFetch(() => anthropicMessage([{ type: 'text', text: 'ok' }]))
    await createChatClient({
      provider: 'anthropic',
      apiKey: 'k',
      fetch,
    }).complete({ model: 'claude-haiku-5-5', maxTokens: 10, messages: turn })
    const messages = calls[0]?.body.messages as { content: unknown[] }[]
    expect(messages[2]?.content).toEqual([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'c1' }),
      expect.objectContaining({ type: 'text', text: 'Here it is.' }),
      expect.objectContaining({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: PNG },
      }),
    ])
  })
})
