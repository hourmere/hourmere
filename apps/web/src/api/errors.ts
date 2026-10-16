/** A request the server answered with an error status. `message` is safe to show. */
export class RequestError extends Error {
  readonly status: number
  /** The machine-readable code: `error` for /api/v1, `code` for Better Auth's /api/auth. */
  readonly code: string | undefined

  constructor(status: number, code: string | undefined, message: string) {
    super(message)
    this.name = 'RequestError'
    this.status = status
    this.code = code
  }
}

export const UNREACHABLE = "Can't reach Hourmere. Check your connection and try again."

function messageForStatus(status: number): string {
  if (status === 401) return 'Your session has ended. Sign in again.'
  if (status === 403) return "You don't have permission to do that."
  if (status === 429) return 'Too many requests. Wait a minute and try again.'
  if (status >= 500) return 'Something went wrong on our side. Try again in a moment.'
  return 'That did not work. Try again.'
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The error for a response with status `status` and parsed body `body`. Both APIs send
 * human-readable messages meant to be shown (docs/api-conventions.md); without one, the
 * status decides.
 */
export function requestError(status: number, body: unknown): RequestError {
  const record = isRecord(body) ? body : {}
  const code =
    typeof record.error === 'string'
      ? record.error
      : typeof record.code === 'string'
        ? record.code
        : undefined
  const message =
    typeof record.message === 'string' && record.message.trim()
      ? record.message
      : messageForStatus(status)
  return new RequestError(status, code, message)
}

export async function errorFromResponse(response: Response): Promise<RequestError> {
  const body: unknown = await response.json().catch(() => undefined)
  return requestError(response.status, body)
}

/** What to tell people about a failed request (or any other error). */
export function errorMessage(err: unknown): string {
  return err instanceof RequestError ? err.message : UNREACHABLE
}
