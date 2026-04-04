import { expect, test, describe } from 'bun:test'
import { tokenCountWithEstimation, getTokenCountFromUsage } from './tokens.ts'
import type { Message } from '../types/message.ts'

function makeAssistantMessage(
  text: string,
  usage: { input_tokens: number; output_tokens: number },
  id?: string,
): Message {
  return {
    type: 'assistant',
    message: {
      id: id ?? `msg_${Math.random().toString(36).slice(2)}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'gpt-4o',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    uuid: Math.random().toString(36),
    timestamp: new Date().toISOString(),
  } as unknown as Message
}

function makeUserMessage(text: string): Message {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
    uuid: Math.random().toString(36),
    timestamp: new Date().toISOString(),
  } as unknown as Message
}

describe('tokenCountWithEstimation with zero-usage messages', () => {
  test('skips zero-usage assistant messages and falls back to rough estimation', () => {
    const longUserMsg = 'A'.repeat(8000) // ~2000 tokens rough estimate
    const messages: Message[] = [
      makeUserMessage(longUserMsg),
      makeAssistantMessage('response', { input_tokens: 0, output_tokens: 0 }),
      makeUserMessage('follow up'),
    ]

    const estimate = tokenCountWithEstimation(messages)

    // Without the fix, this would return ~0 (zero usage + tiny tail estimate).
    // With the fix, it should fall through to rough estimation of ALL messages,
    // which should be at least 2000 (from the 8000-char user message).
    expect(estimate).toBeGreaterThan(1500)
  })

  test('uses real usage when available (non-zero)', () => {
    const messages: Message[] = [
      makeUserMessage('hello'),
      makeAssistantMessage('world', { input_tokens: 50000, output_tokens: 2000 }),
      makeUserMessage('follow up question'),
    ]

    const estimate = tokenCountWithEstimation(messages)

    // Should use the real usage (50000 + 2000 = 52000) plus rough estimate of tail
    expect(estimate).toBeGreaterThan(50000)
  })

  test('skips multiple zero-usage messages and finds real one', () => {
    const messages: Message[] = [
      makeUserMessage('hello'),
      makeAssistantMessage('first response', { input_tokens: 30000, output_tokens: 1000 }),
      makeUserMessage('question 2'),
      makeAssistantMessage('second response', { input_tokens: 0, output_tokens: 0 }),
      makeUserMessage('question 3'),
      makeAssistantMessage('third response', { input_tokens: 0, output_tokens: 0 }),
      makeUserMessage('question 4'),
    ]

    const estimate = tokenCountWithEstimation(messages)

    // Should skip the two zero-usage messages, find the first one with 31000,
    // then estimate everything after it (3 user + 2 assistant messages)
    expect(estimate).toBeGreaterThan(30000)
  })

  test('all zero-usage messages → falls back to full rough estimation', () => {
    const longText = 'B'.repeat(20000) // ~5000 tokens
    const messages: Message[] = [
      makeUserMessage(longText),
      makeAssistantMessage('reply 1', { input_tokens: 0, output_tokens: 0 }),
      makeUserMessage('more text here for testing purposes'),
      makeAssistantMessage('reply 2', { input_tokens: 0, output_tokens: 0 }),
    ]

    const estimate = tokenCountWithEstimation(messages)

    // All usage is zero, so should estimate ALL messages.
    // 20000 chars / ~4 ≈ 5000 tokens minimum
    expect(estimate).toBeGreaterThan(4000)
  })
})

describe('getTokenCountFromUsage', () => {
  test('returns 0 for empty usage', () => {
    const result = getTokenCountFromUsage({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    expect(result).toBe(0)
  })

  test('sums all token fields correctly', () => {
    const result = getTokenCountFromUsage({
      input_tokens: 5000,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    expect(result).toBe(5200)
  })
})
