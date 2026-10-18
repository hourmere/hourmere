export type ZoomFailure = 'provider_unavailable' | 'needs_reauth' | 'permissions_missing'
/** Upstream bodies, request URLs and credentials never become messages/causes. */
export class ZoomError extends Error {
  readonly code: ZoomFailure
  constructor(code: ZoomFailure) {
    super(code)
    this.name = 'ZoomError'
    this.code = code
  }
}

export const ZOOM_NOT_FOUND = Symbol('zoom-not-found')
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let rejectAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new ZoomError('provider_unavailable'))
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
    badRequestReauth?: boolean
  } = {},
): Promise<unknown> {
  try {
    signal.throwIfAborted()
    const response = await abortable(request(url, { ...init, redirect: 'error', signal }), signal)
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      if (options.missing && response.status === 404) return ZOOM_NOT_FOUND
      throw new ZoomError(
        response.status === 401 || (options.badRequestReauth && response.status === 400)
          ? 'needs_reauth'
          : response.status === 403
            ? 'permissions_missing'
            : 'provider_unavailable',
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
    throw new ZoomError('provider_unavailable')
  }
}
