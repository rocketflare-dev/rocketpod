/**
 * Per-model request rules (`@rocketpod/shared/ai/models`): which thinking control a model takes,
 * what "off" becomes, whether it accepts a temperature or a forced tool. Checked against the
 * vendors' docs on `MODEL_TRAITS_CHECKED`; an unrecognised id gets the NEWEST generation's rules.
 */
import {
  anthropicModelTraits,
  modelTraits,
  openAiLowestEffort,
  openAiModelTraits,
  parseClaudeModel,
} from '@rocketpod/shared/ai/models'
import { describe, expect, it } from 'vitest'

describe('parseClaudeModel', () => {
  it('reads family and version, ignoring a snapshot date and a Bedrock prefix', () => {
    expect(parseClaudeModel('claude-sonnet-4-5-20250929')).toEqual({
      family: 'sonnet',
      version: 4.5,
      legacy: false,
    })
    expect(parseClaudeModel('claude-opus-4-20250514')).toMatchObject({ family: 'opus', version: 4 })
    expect(parseClaudeModel('anthropic.claude-opus-5-5')).toMatchObject({ version: 5.5 })
    expect(parseClaudeModel('claude-fable-5-1')).toMatchObject({ family: 'fable', version: 5.1 })
    expect(parseClaudeModel('claude-3-5-sonnet-20241022').legacy).toBe(true)
    expect(parseClaudeModel('claude-mythos-preview')).toMatchObject({ version: null })
  })
})

describe('anthropicModelTraits', () => {
  it.each([
    // model, thinking, off, thinksAnyway, forcedToolChoice, sampling
    ['claude-fable-5-1', 'adaptive', 'omit', true, false, false],
    ['claude-fable-5', 'adaptive', 'omit', true, true, false],
    ['claude-opus-5-5', 'adaptive', 'omit', true, false, false],
    ['claude-opus-5', 'adaptive', 'disabled', false, true, false],
    ['claude-sonnet-5-5', 'adaptive', 'between_tools', false, false, false],
    ['claude-sonnet-5', 'adaptive', 'disabled', false, true, false],
    ['claude-haiku-5-5', 'adaptive', 'disabled', false, true, false],
    ['claude-opus-4-8', 'adaptive', 'disabled', false, true, false],
    ['claude-opus-4-7', 'adaptive', 'disabled', false, true, false],
    ['claude-opus-4-6', 'adaptive', 'disabled', false, true, true],
    ['claude-sonnet-4-6', 'adaptive', 'disabled', false, true, true],
    ['claude-sonnet-4-5-20250929', 'extended', 'disabled', false, true, true],
    ['claude-haiku-4-5', 'extended', 'disabled', false, true, true],
    ['claude-opus-4-1', 'extended', 'disabled', false, true, true],
    ['claude-3-5-sonnet-20241022', 'extended', 'disabled', false, true, true],
    // Not recognised → the newest rules, which every current model accepts.
    ['claude-opus-6', 'adaptive', 'omit', true, false, false],
    ['claude-something-new', 'adaptive', 'omit', true, false, false],
  ] as const)('%s', (model, thinking, thinkingOff, thinksAnyway, forcedToolChoice, sampling) => {
    expect(anthropicModelTraits(model)).toEqual({
      thinking,
      thinkingOff,
      thinksAnyway,
      forcedToolChoice,
      sampling,
    })
  })
})

describe('OpenAI traits', () => {
  it('reasoning models take an effort and no temperature; the lowest effort is per model', () => {
    expect(openAiModelTraits('gpt-4.1-mini')).toMatchObject({ thinking: 'none', sampling: true })
    expect(openAiModelTraits('gpt-6-luna')).toMatchObject({
      thinking: 'effort',
      thinksAnyway: false,
      sampling: false,
    })
    expect(openAiModelTraits('gpt-6-astra').thinksAnyway).toBe(true)
    expect(openAiLowestEffort('gpt-6-luna')).toBe('none')
    expect(openAiLowestEffort('gpt-6-sol')).toBe('none')
    expect(openAiLowestEffort('gpt-5.6-terra')).toBe('none')
    expect(openAiLowestEffort('gpt-6-astra')).toBe('low')
    expect(openAiLowestEffort('gpt-6.1-sol')).toBe('low')
    expect(openAiLowestEffort('gpt-5-mini')).toBe('low')
    expect(openAiLowestEffort('o4-mini')).toBe('low')
  })

  it('anthropic_compatible keeps the budget contract; providers without a control have none', () => {
    expect(modelTraits('anthropic_compatible', 'claude-opus-5-5').thinking).toBe('extended')
    expect(modelTraits('openai_compatible', 'gpt-6-luna').thinking).toBe('none')
    expect(modelTraits('workers_ai', '@cf/zai-org/glm-5.3').thinking).toBe('none')
  })
})
