// Free text from clients (names, emails, answers, reasons, question labels) ends up in
// emails, calendar events, logs and other people's screens. These helpers accept only
// well-formed Unicode without control characters: no NUL, no C0 controls (except tab and
// line breaks in multi-line text), no DEL, no C1 controls and no U+2028/U+2029, which some
// renderers and log viewers treat as line breaks.
import { z } from 'zod'

/**
 * Whether `value` contains a C0 control (other than tab, line feed and carriage return
 * when `multiline`), DEL, a C1 control, LINE SEPARATOR or PARAGRAPH SEPARATOR.
 */
function hasControlCharacters(value: string, multiline: boolean): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x20) {
      if (multiline && (c === 0x09 || c === 0x0a || c === 0x0d)) continue
      return true
    }
    if ((c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true
  }
  return false
}

/** Well-formed (no lone surrogates) and free of control characters and line breaks. */
export function isSingleLineText(value: string): boolean {
  return value.isWellFormed() && !hasControlCharacters(value, false)
}

/** Like isSingleLineText, but tab, line feed and carriage return are allowed. */
export function isMultiLineText(value: string): boolean {
  return value.isWellFormed() && !hasControlCharacters(value, true)
}

export interface TextRules {
  /** Allow tab, line feed and carriage return. Defaults to false. */
  multiline?: boolean
  /** Minimum length after trimming, in UTF-16 code units. Defaults to 1. */
  min?: number
  /** Maximum length after trimming, in UTF-16 code units. */
  max: number
}

/**
 * Trims `value` and returns it when it is a string of acceptable text within the length
 * bounds; otherwise undefined, for the caller to answer with its own error code.
 */
export function cleanText(value: unknown, { multiline = false, min = 1, max }: TextRules) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length < min || text.length > max) return undefined
  return (multiline ? isMultiLineText(text) : isSingleLineText(text)) ? text : undefined
}

/** A zod string that is trimmed and must pass cleanText's rules. */
export function textSchema({ multiline = false, min = 1, max }: TextRules) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine(multiline ? isMultiLineText : isSingleLineText, {
      message: multiline
        ? 'must be text without control characters other than tabs and line breaks'
        : 'must be a single line of text without control characters',
    })
}
