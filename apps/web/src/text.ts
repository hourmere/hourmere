// The API's rules for free text (docs/api-conventions.md, Validation): well-formed Unicode
// without control characters; only multi-line fields may hold tabs and line breaks. The same
// checks as packages/scheduling/src/text.ts, so the forms can say what is wrong before the
// server refuses it.

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

/** Well-formed and free of control characters and line breaks. */
export function isSingleLineText(value: string): boolean {
  return value.isWellFormed() && !hasControlCharacters(value, false)
}

/** Like isSingleLineText, but tab, line feed and carriage return are allowed. */
export function isMultiLineText(value: string): boolean {
  return value.isWellFormed() && !hasControlCharacters(value, true)
}

/**
 * What is wrong with a required one-line text field (trimmed, as the server trims it), or
 * null when it is fine.
 */
export function singleLineProblem(value: string, name: string, max: number): string | null {
  const text = value.trim()
  if (text === '') return `Enter ${name}.`
  if (text.length > max) return `Use at most ${max} characters (now ${text.length}).`
  if (!isSingleLineText(text)) return 'Use one line of text without special control characters.'
  return null
}
