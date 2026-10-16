import { describe, expect, it } from 'vitest'
import { escapeControlCharacters } from './log.ts'

describe('escapeControlCharacters', () => {
  it('escapes line breaks, other control characters and bidi controls', () => {
    expect(escapeControlCharacters('a\nb\r\tc')).toBe('a\\nb\\r\\tc')
    expect(escapeControlCharacters('\u0000\u001b[31m\u007f\u0085')).toBe(
      '\\u0000\\u001b[31m\\u007f\\u0085',
    )
    expect(escapeControlCharacters('\u2028\u2029')).toBe('\\u2028\\u2029')
    // Embeddings and overrides (U+202A to U+202E), isolates (U+2066 to U+2069).
    expect(escapeControlCharacters('x\u202ay\u202ez\u2066w\u2069')).toBe(
      'x\\u202ay\\u202ez\\u2066w\\u2069',
    )
  })

  it('leaves ordinary text alone, including other non-ASCII', () => {
    expect(escapeControlCharacters('Zoë → 李雷 \\ "quoted"')).toBe('Zoë → 李雷 \\ "quoted"')
  })
})
