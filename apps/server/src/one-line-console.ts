import { formatWithOptions, type InspectOptions, inspect } from 'node:util'
import { escapeControlCharacters } from '@hourmere/auth'

// dirxml is Node's log under another name, bound on its own, so it needs wrapping too.
const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'dirxml'] as const
const ONE_LINE = { breakLength: Number.POSITIVE_INFINITY }

/** console's own formatting (%s, objects, Error stacks), as one line with escapes. */
export function formatOneLine(args: unknown[]): string {
  return escapeControlCharacters(formatWithOptions(ONE_LINE, ...args))
}

/**
 * Makes every console call in the process print exactly one line, control characters
 * escaped. Our own log lines already are; this also covers dependencies that print errors
 * raw (Better Auth's database adapter, pg), whose messages can carry request input, e.g.
 * Postgres quoting a malformed value. Nothing a request influences can then start a line
 * of its own, so nothing can imitate a `[mail]` record.
 *
 * log, info, warn, error, debug and dirxml are wrapped, and dir (which writes on its own).
 * The other methods go through those: trace and assert through error and warn, table,
 * count and time through log. Writing to process.stdout / process.stderr directly is
 * outside this guarantee; no runtime dependency does so today.
 *
 * Returns a function that undoes it.
 */
export function installOneLineConsole(target: Console = console): () => void {
  const originals = [...METHODS, 'dir' as const].map((method) => [method, target[method]] as const)
  for (const method of METHODS) {
    const original = target[method]
    target[method] = (...args: unknown[]) => original.call(target, formatOneLine(args))
  }
  const log = target.log
  target.dir = (item?: unknown, options?: InspectOptions) =>
    log.call(target, escapeControlCharacters(inspect(item, { ...options, ...ONE_LINE })))
  return () => {
    for (const [method, original] of originals) {
      ;(target as unknown as Record<string, unknown>)[method] = original
    }
  }
}
