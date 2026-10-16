import { formatWithOptions } from 'node:util'
import { escapeControlCharacters } from '@hourmere/auth'

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const

/** console's own formatting (%s, objects, Error stacks), as one line with escapes. */
export function formatOneLine(args: unknown[]): string {
  return escapeControlCharacters(
    formatWithOptions({ breakLength: Number.POSITIVE_INFINITY }, ...args),
  )
}

/**
 * Makes every console call in the process print exactly one line, control characters
 * escaped. Our own log lines already are; this also covers dependencies that print errors
 * raw (Better Auth's database adapter, pg), whose messages can carry request input, e.g.
 * Postgres quoting a malformed value. Nothing a request influences can then start a line
 * of its own, so nothing can imitate a `[mail]` record. Returns a function that undoes it.
 */
export function installOneLineConsole(target: Console = console): () => void {
  const originals = METHODS.map((method) => [method, target[method]] as const)
  for (const [method, original] of originals) {
    target[method] = (...args: unknown[]) => original.call(target, formatOneLine(args))
  }
  return () => {
    for (const [method, original] of originals) target[method] = original
  }
}
