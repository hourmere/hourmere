import type { Context, Next } from 'hono'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { matchedRoutes } from 'hono/route'
import type { MiddlewareHandler } from 'hono/types'

/** Body limit for /api requests whose route declares none. Sign-in requests are a few KB. */
export const DEFAULT_BODY_LIMIT = 64 * 1024

const DECLARED = Symbol('body limit')

/**
 * Declares a route's body limit, for a route whose largest legal request exceeds the
 * default; list it in the route's `middleware`. The limit must be at least that request with
 * every string at its maximum length and every character escaped as \uXXXX (6 bytes, what
 * e.g. Python's json.dumps sends by default). The middleware itself does nothing: the
 * app-wide limit enforces the figure, because it wraps the body before anything reads it.
 */
export function routeBodyLimit(maxBytes: number): MiddlewareHandler {
  const declaration: MiddlewareHandler = async (_c, next) => {
    await next()
  }
  return Object.assign(declaration, { [DECLARED]: maxBytes })
}

/** A check run on a request body while it is read; it throws an HTTPException to refuse it. */
export interface BodyCheck {
  /** Sees each chunk as it is read. */
  chunk?: (bytes: Uint8Array) => void
  /** Runs once the whole body has been read. */
  end?: () => void
}

/**
 * Methods whose requests are passed on untouched: GET, HEAD and TRACE carry no body, and
 * fetch's Request refuses to be built with TRACE, TRACK or CONNECT, so rebuilding one would
 * turn the request into a 500.
 */
const PASSED_THROUGH = new Set(['GET', 'HEAD', 'TRACE', 'TRACK', 'CONNECT'])

/**
 * Runs the rest of the request (`next`) with a body that `check` sees while it is read.
 * Nothing is read on check's behalf: a chunk passes through only when a reader asks for it,
 * so a request answered without reading its body (e.g. 401, 429) leaves it unread. Even the
 * original body stream is left alone until then: on @hono/node-server, merely creating it
 * starts reading the socket, and the server then cannot skip the unread body after the
 * answer, so it closes the connection instead of keeping it alive.
 *
 * When check refuses, reading the body fails with check's HTTPException, and the request is
 * answered with that exception (by the app's error handler) whatever the reader made of the
 * failure: a route's validator turns any failed read into 400 "Malformed JSON", Better Auth
 * may answer with an error of its own. The reader's response is discarded, its headers too;
 * headers set earlier with c.header() (e.g. the caller's Set-Cookie) stay.
 *
 * So the check decides only once the body has been read. Readers must therefore read (and
 * validate) the body before doing anything with side effects, and must not swallow a failed
 * read and carry on: whatever they did before or after it stands, only the response changes.
 */
export async function checkBodyAsRead(c: Context, next: Next, check: BodyCheck): Promise<void> {
  const original = c.req.raw
  if (PASSED_THROUGH.has(original.method)) return next()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let refusal: unknown
  const checked = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (!reader) {
          const body = original.body
          if (!body) {
            controller.close()
            return
          }
          reader = body.getReader()
        }
        const { done, value } = await reader.read()
        try {
          if (done) {
            check.end?.()
            controller.close()
          } else {
            check.chunk?.(value)
            controller.enqueue(value)
          }
        } catch (err) {
          refusal = err
          controller.error(err)
        }
      },
      cancel: (reason) => reader?.cancel(reason),
    },
    // No read-ahead: pull runs only when a reader is waiting for a chunk.
    { highWaterMark: 0 },
  )
  // A new request rather than new Request(original, …), which would open the original body.
  const init: RequestInit & { duplex: 'half' } = {
    method: original.method,
    headers: original.headers,
    signal: original.signal,
    body: checked,
    duplex: 'half',
  }
  c.req.raw = new Request(original.url, init)
  await next()
  if (refusal !== undefined) {
    // Drop the reader's answer, headers included, so the refusal's response replaces it; a
    // streamed one is cancelled. finalized goes back so the error handler can set headers.
    c.res.body?.cancel().catch(() => {})
    c.res = undefined
    c.finalized = false
    throw refusal
  }
}

/**
 * The /api body limit: the matched route's declared limit (routeBodyLimit), else
 * DEFAULT_BODY_LIMIT. Larger bodies get 413 `payload_too_large` (an HTTPException, which the
 * app's error handler answers in the documented shape). A Content-Length over the limit is
 * refused at once; any other body is counted while it is read (checkBodyAsRead), which also
 * caps a body longer than its Content-Length. So the size check comes first, yet nothing
 * reads the body before the middleware and route that do: rate limits and authentication
 * refuse a client without reading what it sends.
 */
export function apiBodyLimit(): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    // These carry no body to read, whatever their headers say.
    if (PASSED_THROUGH.has(c.req.method)) return next()
    let maxSize = DEFAULT_BODY_LIMIT
    for (const { handler } of matchedRoutes(c)) {
      const declared = (handler as { [DECLARED]?: number })[DECLARED]
      if (declared !== undefined) maxSize = declared
    }
    const headers = c.req.raw.headers
    // Transfer-Encoding overrides Content-Length (RFC 9112); a missing one parses as NaN.
    const declaredSize = Number.parseInt(headers.get('content-length') ?? '', 10)
    if (!headers.has('transfer-encoding') && declaredSize > maxSize) throw new HTTPException(413)
    let size = 0
    return checkBodyAsRead(c, next, {
      chunk(bytes) {
        size += bytes.byteLength
        if (size > maxSize) throw new HTTPException(413)
      },
    })
  })
}
