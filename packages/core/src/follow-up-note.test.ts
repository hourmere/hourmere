import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { FOLLOW_UP_HOST_NOTE_MAX_LENGTH, normalizeFollowUpHostNote } from './follow-up-note.ts'

type Normalize = typeof normalizeFollowUpHostNote
type Replacement = readonly [string, string]

function sourceCopy(replacement?: Replacement): Normalize {
  let source = readFileSync('packages/core/src/follow-up-note.ts', 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  return new Function(
    `${stripTypeScriptTypes(source).replace(/\bexport /g, '')}; return normalizeFollowUpHostNote`,
  )() as Normalize
}

function verifyPlainText(normalize: Normalize) {
  const literal = '<a href="https://example.test">A & B</a>\t中文 😀'
  expect(normalize(literal)).toBe(literal)
  expect(normalize('Line one\r\nLine two\rLine three\n')).toBe('Line one\nLine two\nLine three\n')
  expect(normalize('A\u0085B\u2028C\u2029D')).toBe('A\nB\nC\nD')
  expect(normalize('safe\u202areversed\u202e\u2066isolated\u2069')).toBe('safereversedisolated')
  const forbidden = Array.from({ length: 160 }, (_, code) => code)
    .filter((code) => (code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code !== 133))
    .map((code) => String.fromCharCode(code))
    .join('')
  expect(normalize(`safe${forbidden}body`)).toBe('safebody')
  expect(normalize('broken\ud800value\udc00')).toBe('broken\ufffdvalue\ufffd')
  expect(normalize('a'.repeat(FOLLOW_UP_HOST_NOTE_MAX_LENGTH + 100))).toBe(
    'a'.repeat(FOLLOW_UP_HOST_NOTE_MAX_LENGTH),
  )
  const splitPair = normalize(`${'a'.repeat(FOLLOW_UP_HOST_NOTE_MAX_LENGTH - 1)}😀`)
  expect(splitPair).toBe(`${'a'.repeat(FOLLOW_UP_HOST_NOTE_MAX_LENGTH - 1)}\ufffd`)
  expect(splitPair.length).toBe(FOLLOW_UP_HOST_NOTE_MAX_LENGTH)
  expect(splitPair.isWellFormed()).toBe(true)
}

describe('follow-up host note normalization', () => {
  it('preserves plain text while bounding, repairing and normalizing untrusted notes', () => {
    expect(FOLLOW_UP_HOST_NOTE_MAX_LENGTH).toBe(2000)
    expect(normalizeFollowUpHostNote('')).toBe('')
    verifyPlainText(normalizeFollowUpHostNote)
    verifyPlainText(sourceCopy())
  })

  it.each<[string, Replacement]>([
    ['line-ending normalization', [".replace(/\\r\\n?|[\\u0085\\u2028\\u2029]/g, '\\n')", '']],
    [
      'control-character removal',
      [
        '/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]/g',
        '/[]/g',
      ],
    ],
    ['length bound', ['.slice(0, FOLLOW_UP_HOST_NOTE_MAX_LENGTH)', '']],
    ['Unicode repair after truncation', ['.toWellFormed()', '']],
  ])('detects source-copy removal of %s with a real assertion failure', (_, replacement) => {
    expect(() => verifyPlainText(sourceCopy(replacement))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
