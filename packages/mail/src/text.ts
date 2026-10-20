// Making text from bookings (names, answers, reasons: all typed by someone else) safe to put
// into an email header, a plain-text body or HTML.

// C0 and C1 control characters, line and paragraph separators, and bidi embedding, override
// and isolate characters, which can make text read differently from what it contains.
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
// The same, except tab and line feed.
const NOT_TAB_LF =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

/** Text for one line: every control character or line break becomes a space, runs collapse. */
export function singleLine(text: string): string {
  return text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
}

/** Text that may span lines: line breaks become `\n`, other control characters are removed. */
export function multiLine(text: string): string {
  return text
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(NOT_TAB_LF, '')
    .trim()
}

/**
 * A subject line: one line, so nothing can end the header and start another (e.g. `Bcc:`),
 * and at most `max` characters.
 */
export function subjectLine(text: string, max = 200): string {
  const line = singleLine(text)
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

/** Space Han/Latin substitution boundaries without rewriting the user's text itself. */
export function formatChineseTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string, offset: number) => {
    const value = values[name]
    if (value === undefined) return placeholder
    const before = template.slice(0, offset)
    const after = template.slice(offset + placeholder.length)
    const leading = /\p{Script=Han}$/u.test(before) && /^\p{Script=Latin}/u.test(value) ? ' ' : ''
    const trailing =
      /\p{Script=Latin}\p{M}*$/u.test(value) && /^\p{Script=Han}/u.test(after) ? ' ' : ''
    return `${leading}${value}${trailing}`
  })
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** A URL that may be linked: absolute http(s) only, so no `javascript:` or `data:` links. */
export function linkableUrl(url: string): string | undefined {
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed) || !URL.canParse(trimmed)) return undefined
  return trimmed
}
