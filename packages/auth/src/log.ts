import { inspect } from 'node:util'

// C0 and C1 control characters, the Unicode line and paragraph separators, and the bidi
// embedding, override and isolate characters (which can make a log line read differently
// from what it contains).
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
const NAMED: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/**
 * Makes text safe to put on one log line: control characters become visible escapes, so a
 * value from a request (Better Auth logs rejected callback URLs verbatim) cannot start a
 * line of its own and imitate other log output, such as a sign-in link.
 */
export function escapeControlCharacters(text: string): string {
  return text.replace(
    CONTROL,
    (c) => NAMED[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

const format = (arg: unknown) =>
  typeof arg === 'string' ? arg : inspect(arg, { breakLength: Number.POSITIVE_INFINITY })

/**
 * Better Auth's log output, one line per entry with control characters escaped. A rejected
 * API key, which Better Auth logs as a multi-line error with a stack trace, becomes one info
 * line with the reason only (never the key): a wrong key is the caller's problem.
 */
export function betterAuthLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  ...args: unknown[]
): void {
  if (message.startsWith('Failed to validate API key')) {
    const code = (args[0] as { body?: { code?: unknown } } | undefined)?.body?.code
    const reason = typeof code === 'string' ? code : 'INVALID_API_KEY'
    console.info(`[auth] API key rejected: ${escapeControlCharacters(reason)}`)
    return
  }
  const text = escapeControlCharacters([message, ...args.map(format)].join(' '))
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [Better Auth]: ${text}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}
