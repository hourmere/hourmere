// Helpers shared by the services. Only validTimeZone is exported from the package, for
// transports that read a time zone themselves (the MCP server's slot search).
import { AvailabilityInputError, validateTimeZone } from '@hourmere/core'
import { DomainError } from './errors.ts'

/** SQLSTATE codes services map to DomainErrors. */
export const SQLSTATE = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
} as const

/**
 * Whether `error` is a Postgres error with this SQLSTATE raised by this constraint (or
 * unique index). Matching the constraint name keeps an unrelated violation from being
 * reported as, say, a taken handle.
 */
export function isConstraintViolation(
  error: unknown,
  sqlState: (typeof SQLSTATE)[keyof typeof SQLSTATE],
  constraint: string,
): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, constraint: name } = error as { code?: unknown; constraint?: unknown }
  return code === sqlState && name === constraint
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Ids from requests are checked before they reach a uuid column: Postgres rejects a
 * malformed one with an error, and no row can have it anyway.
 */
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value)

/**
 * The parameter for a jsonb column. node-postgres would send a JavaScript array as a
 * Postgres array literal (`[]` becomes `'{}'`, an empty object), so JSON is always
 * serialized explicitly.
 */
export const jsonb = (value: unknown): string => JSON.stringify(value)

/** RFC 3339 in UTC with a Z suffix, as the API promises. */
export const timestamp = (value: Date): string => value.toISOString()

/**
 * Runs one of the availability engine's validators and turns its error into a 400 with
 * `code`. The engine's message names the field and repeats only the caller's own input,
 * so it is safe to show.
 */
export function engineValidation<T>(code: string, validate: () => T): T {
  try {
    return validate()
  } catch (error) {
    if (error instanceof AvailabilityInputError)
      throw new DomainError('invalid', code, error.message)
    throw error
  }
}

/** An IANA time zone name the engine accepts, normalized; 400 `invalid_time_zone` otherwise. */
export function validTimeZone(value: unknown, path = 'timeZone'): string {
  return engineValidation('invalid_time_zone', () => validateTimeZone(value, path))
}
