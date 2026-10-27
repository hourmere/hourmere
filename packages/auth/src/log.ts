import { inspect } from 'node:util'

// C0 and C1 control characters, the Unicode line and paragraph separators, and the bidi
// embedding, override and isolate characters (which can make a log line read differently
// from what it contains).
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
const NAMED: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/**
 * Makes text safe to put on one log line: control characters become visible escapes, so
 * request input in an error cannot start a line of its own and imitate other log output,
 * such as a sign-in link.
 */
export function escapeControlCharacters(text: string): string {
  return text.replace(
    CONTROL,
    (c) => NAMED[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

// Include absolute URLs/URIs and local paths. Queries can contain quotes or backslashes;
// only whitespace ends a URL token, so its entire query/fragment is removed.
const URL_TEXT = /(?:\b[a-z][a-z\d+.-]*:|\/)\S*/gi
const UUID = /\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi

/** Preserve diagnostic text while removing identifiers and URL query/fragment values. */
export function redactLogDetails(text: string): string {
  return text
    .replace(URL_TEXT, (url) => url.split(/[?#]/, 1)[0] ?? url)
    .replace(UUID, '[redacted UUID]')
}

const MAIL_FAILURE = '[auth] sign-in email not sent'

/**
 * Logs a sign-in email that could not be sent, as one line: the SMTP error's code, response
 * code and command (nodemailer sets them, e.g. EAUTH 535 AUTH PLAIN), never its message,
 * which can quote the recipient or the message with its link. Never throws: it runs where a
 * throw would be an unhandled rejection.
 */
export function logMailFailure(err: unknown): void {
  try {
    const details: string[] = []
    if (typeof err === 'object' && err !== null) {
      for (const field of ['code', 'responseCode', 'command'] as const) {
        const value: unknown = (err as Record<string, unknown>)[field]
        if (value !== undefined && value !== null) {
          details.push(`${field}=${String(value).slice(0, 64)}`)
        }
      }
    }
    console.error(
      details.length
        ? `${MAIL_FAILURE} (${escapeControlCharacters(details.join(', '))})`
        : MAIL_FAILURE,
    )
  } catch {
    try {
      console.error(`${MAIL_FAILURE} (details unavailable)`)
    } catch {}
  }
}

const format = (arg: unknown) =>
  typeof arg === 'string'
    ? redactLogDetails(arg)
    : inspect(arg, { breakLength: Number.POSITIVE_INFINITY })

/**
 * Better Auth's diagnostic message and arguments, redacted before control escaping so
 * each entry stays useful and occupies one line. Rejected API keys retain a bounded code,
 * never the key: a wrong key is the caller's problem.
 */
export function betterAuthLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  ...args: unknown[]
): void {
  if (message.startsWith('Failed to validate API key')) {
    const code = (args[0] as { body?: { code?: unknown } } | undefined)?.body?.code
    const reason =
      typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'INVALID_API_KEY'
    console.info(`[auth] API key rejected: ${reason}`)
    return
  }
  const text = escapeControlCharacters(redactLogDetails([message, ...args.map(format)].join(' ')))
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [Better Auth]: ${text}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}
