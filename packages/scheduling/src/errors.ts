/** What kind of failure, independent of transport; the HTTP layer maps each to a status. */
export type DomainErrorKind = 'invalid' | 'not_found' | 'forbidden' | 'conflict'

/**
 * A failure the caller can act on: bad input, a missing resource, a permission problem or a
 * conflict (e.g. the slot was just taken). `code` is the machine-readable value clients see
 * as `{ "error": code }` (see docs/api-conventions.md); `message` is optional detail.
 * Anything else a service throws is a bug and surfaces as 500 internal_error.
 */
export class DomainError extends Error {
  readonly kind: DomainErrorKind
  readonly code: string

  constructor(kind: DomainErrorKind, code: string, message?: string) {
    super(message ?? code)
    this.name = 'DomainError'
    this.kind = kind
    this.code = code
  }
}
