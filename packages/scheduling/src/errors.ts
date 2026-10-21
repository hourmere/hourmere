/** What kind of failure, independent of transport; the HTTP layer maps each to a status. */
export type DomainErrorKind = 'invalid' | 'not_found' | 'forbidden' | 'conflict'

/** Codes the API uses for generic cases; services name specific cases instead. */
export const RESERVED_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'internal_error',
])

/**
 * A failure the caller can act on: bad input, a missing resource, a permission problem or a
 * conflict (e.g. the slot was just taken). Anything else a service throws is a bug and
 * surfaces as 500 internal_error.
 *
 * - `code` is a specific, stable snake_case value clients branch on, e.g.
 *   `event_type_not_found` or `slot_taken` (see https://hourmere.com/docs/api-conventions). The HTTP status
 *   already carries the category.
 * - `message` is shown to API clients verbatim: write it as a constant sentence. Never pass
 *   a lower-level error's text (database errors can contain other users' data); keep that
 *   error as `cause`, which only reaches the server log.
 */
export class DomainError extends Error {
  readonly kind: DomainErrorKind
  readonly code: string
  /** The client-visible message, if one was given. */
  readonly detail: string | undefined

  constructor(
    kind: DomainErrorKind,
    code: string,
    message?: string,
    options?: { cause?: unknown },
  ) {
    if (RESERVED_ERROR_CODES.has(code)) {
      throw new TypeError(`DomainError code "${code}" is reserved; name the specific case`)
    }
    super(message ?? code, options)
    this.name = 'DomainError'
    this.kind = kind
    this.code = code
    this.detail = message || undefined
  }
}
