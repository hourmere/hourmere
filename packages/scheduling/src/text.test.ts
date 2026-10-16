import { describe, expect, it } from 'vitest'
import { cleanText, isMultiLineText, isSingleLineText, textSchema } from './text.ts'

// Built from code points so this file itself holds no control characters.
const ch = (code: number) => String.fromCharCode(code)
const forbiddenEverywhere = [
  ['NUL', 'A\u0000B'],
  ['a lone high surrogate', 'a\ud800b'],
  ['a lone low surrogate', 'a\udc00b'],
  ['BEL (C0)', `a${ch(0x07)}b`],
  ['ESC (C0)', `a${ch(0x1b)}b`],
  ['vertical tab', `a${ch(0x0b)}b`],
  ['DEL', `a${ch(0x7f)}b`],
  ['NEL (C1)', `a${ch(0x85)}b`],
  ['CSI (C1)', `a${ch(0x9b)}b`],
  ['LINE SEPARATOR', `a${ch(0x2028)}b`],
  ['PARAGRAPH SEPARATOR', `a${ch(0x2029)}b`],
] as const

describe('text', () => {
  it.each(forbiddenEverywhere)('refuses %s in single- and multi-line text', (_, text) => {
    expect(isSingleLineText(text)).toBe(false)
    expect(isMultiLineText(text)).toBe(false)
  })

  it('allows tabs and line breaks only in multi-line text', () => {
    for (const text of ['a\tb', 'a\nb', 'a\r\nb']) {
      expect(isSingleLineText(text)).toBe(false)
      expect(isMultiLineText(text)).toBe(true)
    }
  })

  it('accepts ordinary Unicode, including emoji (surrogate pairs) and right-to-left text', () => {
    for (const text of ['Zoë Ångström', '李雷', 'שלום', 'Ada 👩‍💻', 'a – b “c”']) {
      expect(isSingleLineText(text)).toBe(true)
    }
  })

  it('cleans text: trims, checks bounds and characters', () => {
    expect(cleanText('  Ada  ', { max: 10 })).toBe('Ada')
    expect(cleanText('   ', { max: 10 })).toBeUndefined()
    expect(cleanText('', { min: 0, max: 10 })).toBe('')
    expect(cleanText('x'.repeat(11), { max: 10 })).toBeUndefined()
    expect(cleanText(5, { max: 10 })).toBeUndefined()
    expect(cleanText('A\u0000B', { max: 10 })).toBeUndefined()
    expect(cleanText('line 1\nline 2', { max: 20 })).toBeUndefined()
    expect(cleanText(' line 1\nline 2\n', { multiline: true, max: 20 })).toBe('line 1\nline 2')
  })

  it('offers the same rules as a zod schema', () => {
    const schema = textSchema({ max: 5 })
    expect(schema.parse(' abc ')).toBe('abc')
    expect(schema.safeParse('A\u0000B').success).toBe(false)
    expect(schema.safeParse('a\ud800b').success).toBe(false)
    expect(schema.safeParse('abcdef').success).toBe(false)
    expect(textSchema({ multiline: true, max: 5 }).parse('a\nb')).toBe('a\nb')
  })
})
