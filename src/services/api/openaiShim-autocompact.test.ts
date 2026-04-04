import { afterEach, beforeEach, expect, test, describe } from 'bun:test'
import { createOpenAIShimClient } from './openaiShim.ts'

type FetchType = typeof globalThis.fetch

const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
}

const originalFetch = globalThis.fetch

type OpenAIShimClient = {
  beta: {
    messages: {
      create: (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<unknown> & {
        withResponse: () => Promise<{ data: AsyncIterable<Record<string, unknown>> }>
      }
    }
  }
}

function makeSseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line))
        }
        controller.close()
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

function makeStreamChunks(chunks: unknown[]): string[] {
  return [
    ...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`),
    'data: [DONE]\n\n',
  ]
}

beforeEach(() => {
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  process.env.OPENAI_API_KEY = 'test-key'
})

afterEach(() => {
  process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
  process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY
  globalThis.fetch = originalFetch
})

describe('auto-compact usage estimation', () => {
  test('emits estimated usage when provider returns no usage data', async () => {
    // Simulate a provider that ignores stream_options.include_usage
    globalThis.fetch = (async (_input, _init) => {
      const chunks = makeStreamChunks([
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model: 'local-model',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Here is a response with some content for testing.' },
              finish_reason: null,
            },
          ],
          // No usage field at all
        },
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model: 'local-model',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
          // No usage field
        },
        // No final usage-only chunk either
      ])

      return makeSseResponse(chunks)
    }) as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient

    const result = await client.beta.messages
      .create({
        model: 'local-model',
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        stream: true,
      })
      .withResponse()

    const events: Array<Record<string, unknown>> = []
    for await (const event of result.data) {
      events.push(event)
    }

    // Should have a message_delta with estimated usage (non-zero)
    const usageEvents = events.filter(
      event =>
        event.type === 'message_delta' &&
        typeof event.usage === 'object' &&
        event.usage !== null,
    ) as Array<{ usage: { input_tokens: number; output_tokens: number } }>

    expect(usageEvents.length).toBeGreaterThan(0)

    const lastUsage = usageEvents[usageEvents.length - 1]!
    // Estimated input_tokens should be > 0 (derived from request body size)
    expect(lastUsage.usage.input_tokens).toBeGreaterThan(0)
    // Estimated output_tokens should be > 0 (derived from generated text length)
    expect(lastUsage.usage.output_tokens).toBeGreaterThan(0)
  })

  test('uses real usage when provider returns it (no estimation needed)', async () => {
    globalThis.fetch = (async (_input, _init) => {
      const chunks = makeStreamChunks([
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'hello world' },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
        },
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model: 'gpt-4o',
          choices: [],
          usage: {
            prompt_tokens: 5000,
            completion_tokens: 200,
            total_tokens: 5200,
          },
        },
      ])

      return makeSseResponse(chunks)
    }) as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient

    const result = await client.beta.messages
      .create({
        model: 'gpt-4o',
        system: 'test system',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        stream: true,
      })
      .withResponse()

    const events: Array<Record<string, unknown>> = []
    for await (const event of result.data) {
      events.push(event)
    }

    const usageEvents = events.filter(
      event =>
        event.type === 'message_delta' &&
        typeof event.usage === 'object' &&
        event.usage !== null,
    ) as Array<{ usage: { input_tokens: number; output_tokens: number } }>

    // Should use real usage, not estimation
    const realUsage = usageEvents.find(e => e.usage.input_tokens === 5000)
    expect(realUsage).toBeDefined()
    expect(realUsage!.usage.output_tokens).toBe(200)

    // Should NOT have a second estimated usage (hasEmittedFinalUsage should be true)
    // The last usage event should be the real one
    const lastUsage = usageEvents[usageEvents.length - 1]!
    expect(lastUsage.usage.input_tokens).toBe(5000)
  })

  test('estimated usage scales with request body size', async () => {
    // Create a large conversation to verify estimation scales
    const longContent = 'A'.repeat(10000) // ~2500 tokens

    globalThis.fetch = (async (_input, _init) => {
      const chunks = makeStreamChunks([
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model: 'local-model',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'short reply' },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model: 'local-model',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
        },
      ])

      return makeSseResponse(chunks)
    }) as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient

    const result = await client.beta.messages
      .create({
        model: 'local-model',
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: longContent }],
        max_tokens: 64,
        stream: true,
      })
      .withResponse()

    const events: Array<Record<string, unknown>> = []
    for await (const event of result.data) {
      events.push(event)
    }

    const usageEvents = events.filter(
      event =>
        event.type === 'message_delta' &&
        typeof event.usage === 'object' &&
        event.usage !== null,
    ) as Array<{ usage: { input_tokens: number; output_tokens: number } }>

    expect(usageEvents.length).toBeGreaterThan(0)

    const lastUsage = usageEvents[usageEvents.length - 1]!
    // With 10000 chars of content, estimated input tokens should be at least 2000
    expect(lastUsage.usage.input_tokens).toBeGreaterThan(2000)
    // Output "short reply" = 11 chars → ~3 tokens
    expect(lastUsage.usage.output_tokens).toBeGreaterThan(0)
  })
})
