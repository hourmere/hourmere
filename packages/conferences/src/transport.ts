export type ZoomFailure = 'provider_unavailable' | 'needs_reauth' | 'permissions_missing'
/** Upstream bodies, request URLs and credentials never become messages/causes. */
export class ZoomError extends Error {
  readonly code: ZoomFailure
  readonly knownNoCreate: boolean
  readonly retryable: boolean
  constructor(code: ZoomFailure, options: { knownNoCreate?: boolean; retryable?: boolean } = {}) {
    super(code)
    this.name = 'ZoomError'
    this.code = code
    this.knownNoCreate = options.knownNoCreate === true
    this.retryable = options.retryable === true
  }
}

export const ZOOM_NOT_FOUND = Symbol('zoom-not-found')
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let rejectAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new ZoomError('provider_unavailable', { retryable: true }))
    signal.addEventListener('abort', rejectAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (rejectAbort) signal.removeEventListener('abort', rejectAbort)
  }
}
/** Callers supply fixed official endpoints, never a provider-returned URL. No body escapes. */
export async function boundedZoomJson(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  options: {
    maximum?: number | undefined
    empty?: boolean
    missing?: boolean
    oauthTokens?: boolean
  } = {},
): Promise<unknown> {
  try {
    signal.throwIfAborted()
    const response = await abortable(request(url, { ...init, redirect: 'error', signal }), signal)
    if (!response.ok) {
      let invalidGrant = false
      if (options.oauthTokens && response.status >= 400 && response.status < 500) {
        // Inspect only the bounded, documented OAuth discriminator; never retain its prose.
        const reader = response.body?.getReader()
        if (reader) {
          try {
            const parts: Uint8Array[] = []
            let length = 0
            for (;;) {
              const { done, value } = await abortable(reader.read(), signal)
              if (done) break
              length += value.byteLength
              if (length > 32768) break
              parts.push(value)
            }
            if (length <= 32768) {
              const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as { error?: unknown }
              invalidGrant = body.error === 'invalid_grant'
            }
          } catch {
            // Malformed provider errors do not establish revoked authorization.
          } finally {
            void reader.cancel().catch(() => {})
          }
        }
      }
      void response.body?.cancel().catch(() => {})
      if (options.missing && response.status === 404) return ZOOM_NOT_FOUND
      throw new ZoomError(
        (!options.oauthTokens && response.status === 401) || invalidGrant
          ? 'needs_reauth'
          : !options.oauthTokens && response.status === 403
            ? 'permissions_missing'
            : 'provider_unavailable',
        {
          knownNoCreate: [400, 401, 403, 429].includes(response.status),
          retryable: response.status === 429 || response.status >= 500,
        },
      )
    }
    if (options.empty && response.status === 204) {
      void response.body?.cancel().catch(() => {})
      return undefined
    }
    if (!response.body) throw new ZoomError('provider_unavailable')
    const reader = response.body.getReader(),
      parts: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const { done, value } = await abortable(reader.read(), signal)
        if (done) break
        length += value.byteLength
        if (length > (options.maximum ?? 131072)) throw new ZoomError('provider_unavailable')
        parts.push(value)
      }
    } finally {
      void reader.cancel().catch(() => {})
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown
  } catch (error) {
    if (error instanceof ZoomError) throw error
    throw new ZoomError('provider_unavailable', { retryable: !(error instanceof SyntaxError) })
  }
}
