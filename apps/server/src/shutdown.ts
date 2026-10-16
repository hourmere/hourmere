// Closing the HTTP server without waiting for kept-alive connections. server.close() stops
// accepting connections and closes the idle ones once; a connection busy with a request when
// it is called stays open afterwards, for the keep-alive timeout (125 s), and close() waits
// for it, past the time Docker gives a container to stop.
import { type Server, ServerResponse } from 'node:http'
import type { serve } from '@hono/node-server'

type FetchCallback = Parameters<typeof serve>[0]['fetch']

export interface ShutdownTiming {
  /** How often connections that have become idle are closed. */
  sweepMs: number
  /**
   * How long requests in progress get before their connections are cut. Running jobs get up
   * to 20 s after that (see @hourmere/jobs), which keeps the default within the 30 s that the
   * image and docker-compose.yml allow for stopping.
   */
  cutoffMs: number
}

export const DEFAULT_SHUTDOWN_TIMING: ShutdownTiming = { sweepMs: 250, cutoffMs: 10_000 }

/**
 * Wraps `fetch` so that once `closing()` is true, answers tell the client not to reuse the
 * connection (Connection: close), and Node closes it after the answer instead of keeping it
 * for the keep-alive timeout.
 */
export function closeConnectionsWhen(closing: () => boolean, fetch: FetchCallback): FetchCallback {
  return async (request, env) => {
    const response = await fetch(request, env)
    if (closing() && env.outgoing instanceof ServerResponse && !env.outgoing.headersSent) {
      env.outgoing.setHeader('Connection', 'close')
    }
    return response
  }
}

/**
 * server.close(), resolving once every connection is gone: connections that become idle
 * (e.g. after an answer whose headers went out before closing began, so without Connection:
 * close) are closed every sweepMs, and those still busy after cutoffMs (e.g. a client sending
 * slowly) are cut.
 */
export function closeServer(
  server: Server,
  { sweepMs, cutoffMs }: ShutdownTiming = DEFAULT_SHUTDOWN_TIMING,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const sweep = setInterval(() => server.closeIdleConnections(), sweepMs)
    const cutOff = setTimeout(() => server.closeAllConnections(), cutoffMs)
    server.close((err) => {
      clearInterval(sweep)
      clearTimeout(cutOff)
      if (err) reject(err)
      else resolve()
    })
  })
}
