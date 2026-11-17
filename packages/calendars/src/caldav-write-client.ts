import type { CalDavCredentials } from './caldav-credentials.ts'
import {
  CALDAV_MAX_RESPONSE_BYTES,
  CalDavError,
  type CalDavPrivateTarget,
  type CalDavRequest,
  type CalDavTransport,
  calDavUrl,
  redactCalDavRequest,
  sendCalDav,
} from './caldav-transport.ts'

interface Resource {
  calendarUrl: string
  resourceUrl: string
}
export type CalDavPutResult = { etag: string | null } | { conflict: true } | { missing: true }
export interface CalDavWriteClient {
  get(
    credentials: CalDavCredentials,
    input: Resource,
    signal?: AbortSignal,
  ): Promise<{ etag: string; body: string } | null>
  put(
    credentials: CalDavCredentials,
    input: Resource & { body: string; etag: string | null },
    signal?: AbortSignal,
  ): Promise<CalDavPutResult>
  delete(
    credentials: CalDavCredentials,
    input: Resource & { etag: string },
    signal?: AbortSignal,
  ): Promise<'deleted' | 'missing' | 'conflict'>
}
/** Only strong, bounded entity tags may authorize a destructive operation. */
function strongEtag(value: string): string {
  if (value.length > 1024 || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value))
    throw new CalDavError('invalid_response')
  return value
}
/** Stateless conditional writes; the durable reconciler decides ownership and retries. */
export function createCalDavWriteClient(
  transport: CalDavTransport = sendCalDav,
  options: {
    privateTargets?: readonly CalDavPrivateTarget[]
    allowedOrigins?: readonly string[]
  } = {},
): CalDavWriteClient {
  const privateTargets = (options.privateTargets ?? []).map((target) =>
    Object.freeze({ ...target }),
  )
  const allowedOrigins = [...(options.allowedOrigins ?? [])]
  async function request(
    credentials: CalDavCredentials,
    input: Resource,
    method: 'GET' | 'PUT' | 'DELETE',
    body: string,
    etag: string | null | undefined,
    outerSignal?: AbortSignal,
  ) {
    const signal = AbortSignal.any([
      ...(outerSignal ? [outerSignal] : []),
      AbortSignal.timeout(30_000),
    ])
    const server = calDavUrl(credentials.serverUrl, privateTargets)
    const origins = new Set([new URL(server).origin, ...allowedOrigins])
    function resolve(value: string, base: string) {
      try {
        if (!value.isWellFormed() || /[\s\\]/.test(value)) throw new Error()
        const url = calDavUrl(new URL(value, base).href, privateTargets)
        if (!origins.has(new URL(url).origin)) throw new Error()
        return url
      } catch {
        throw new CalDavError('destination_refused')
      }
    }
    const collection = new URL(resolve(input.calendarUrl, server))
    const resource = new URL(resolve(input.resourceUrl, collection.href))
    // Never let a caller's mapping mutate a sibling calendar or an encoded path traversal.
    const prefix = `${collection.pathname.replace(/\/$/, '')}/`
    let suffix: string
    try {
      suffix = decodeURIComponent(resource.pathname.slice(prefix.length))
    } catch {
      throw new CalDavError('destination_refused')
    }
    if (
      resource.origin !== collection.origin ||
      !resource.pathname.startsWith(prefix) ||
      !suffix ||
      /[/\\]/.test(suffix)
    )
      throw new CalDavError('destination_refused')
    if (
      !credentials.username ||
      credentials.username.includes(':') ||
      !credentials.password ||
      credentials.username.length > 1024 ||
      credentials.password.length > 8192 ||
      !credentials.username.isWellFormed() ||
      !credentials.password.isWellFormed() ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reject Basic credential controls
      /[\u0000-\u001f\u007f-\u009f]/.test(credentials.username + credentials.password)
    )
      throw new CalDavError('unauthorized')
    if (Buffer.byteLength(body) > CALDAV_MAX_RESPONSE_BYTES)
      throw new CalDavError('invalid_response')
    const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
    if ((method !== 'GET' && etag === undefined) || (method === 'DELETE' && etag === null))
      throw new CalDavError('invalid_response')
    const headers =
      etag === null
        ? { ifNoneMatch: '*' as const }
        : etag === undefined
          ? {}
          : { ifMatch: strongEtag(etag) }
    if (signal.aborted) throw new CalDavError('timeout')
    const response = await new Promise<Awaited<ReturnType<CalDavTransport>>>((accept, reject) => {
      const abort = () => reject(new CalDavError('timeout'))
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve()
        .then(() =>
          transport(
            redactCalDavRequest({
              url: resource.href,
              method,
              body,
              authorization,
              depth: '0',
              contentType: 'text/calendar; charset=utf-8',
              ...headers,
              signal,
              privateTargets,
            } satisfies CalDavRequest),
          ),
        )
        .then(accept, (error: unknown) =>
          reject(new CalDavError(error instanceof CalDavError ? error.code : 'transport_failed')),
        )
        .finally(() => signal.removeEventListener('abort', abort))
    })
    if (Buffer.byteLength(response.body) > CALDAV_MAX_RESPONSE_BYTES)
      throw new CalDavError('invalid_response')
    // Mutating redirects are refused: identity and preconditions must remain pinned.
    if ([301, 302, 303, 307, 308].includes(response.status))
      throw new CalDavError('destination_refused')
    if (![200, 201, 204, 404, 412].includes(response.status))
      throw new CalDavError(
        response.status === 401
          ? 'unauthorized'
          : response.status === 403
            ? 'forbidden'
            : response.status === 429
              ? 'rate_limited'
              : 'unavailable',
      )
    return response
  }
  return {
    async get(credentials, input, signal) {
      const response = await request(credentials, input, 'GET', '', undefined, signal)
      if (response.status === 404) return null
      if (response.status !== 200 || !response.etag) throw new CalDavError('invalid_response')
      return { etag: strongEtag(response.etag), body: response.body }
    },
    async put(credentials, input, signal) {
      const response = await request(credentials, input, 'PUT', input.body, input.etag, signal)
      if (response.status === 412) return { conflict: true }
      if (response.status === 404) return { missing: true }
      return { etag: response.etag ? strongEtag(response.etag) : null }
    },
    async delete(credentials, input, signal) {
      const response = await request(credentials, input, 'DELETE', '', input.etag, signal)
      return response.status === 412 ? 'conflict' : response.status === 404 ? 'missing' : 'deleted'
    },
  }
}
