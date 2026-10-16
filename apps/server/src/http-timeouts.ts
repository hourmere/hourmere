import type { ServerOptions } from 'node:http'

/**
 * How long the HTTP server waits for a client, in milliseconds. Set from
 * HTTP_HEADERS_TIMEOUT, HTTP_REQUEST_TIMEOUT and HTTP_KEEP_ALIVE_TIMEOUT (seconds, see
 * config.ts), for every role.
 */
export interface HttpTimeouts {
  /**
   * To send a request's headers, from its first byte; on a kept-alive connection, from the
   * first byte of that request, so idling between requests does not count. Node's default is
   * 60 s.
   */
  headers: number
  /**
   * To send the whole request, headers and body; answering it may take longer. Node's default
   * is 300 s.
   */
  request: number
  /**
   * Before an idle connection is closed, between one request and the next. Node closes it a
   * second later (keepAliveTimeoutBuffer) than the Keep-Alive header it sends announces.
   */
  keepAlive: number
}

/**
 * Defaults. A client that keeps a connection busy by sending slowly ties up a socket and the
 * request's buffers, and with Node's defaults it may do so for minutes. 20 s is plenty for any
 * client's headers; 60 s for the whole request lets the largest body any route accepts (2 MB,
 * see docs/api-conventions.md) through at about 280 kbit/s.
 *
 * Keep-alive is long on purpose: a reverse proxy reuses idle connections to the app for as
 * long as its own idle timeout, and reusing one the app has just closed fails the request
 * (a 502). The app must therefore keep idle connections at least that long. 65 s covers the
 * common 60 s (nginx's upstream keepalive_timeout, cloud load balancers); proxies that keep
 * them longer by default (Traefik 90 s, Caddy 2 min) need HTTP_KEEP_ALIVE_TIMEOUT above that.
 * An idle connection costs a socket and little memory, and slow senders are bounded by the
 * headers and request timeouts, which keep-alive does not extend.
 */
export const DEFAULT_HTTP_TIMEOUTS: HttpTimeouts = {
  headers: 20_000,
  request: 60_000,
  keepAlive: 65_000,
}

/**
 * Options for node:http's createServer (passed through @hono/node-server's serve). A client
 * past the headers or request timeout is answered 408 and its connection closed. Node looks
 * for such clients only every connectionsCheckingInterval (30 s by default, which would let a
 * client run that much over); a quarter of the shorter timeout keeps the overshoot to a
 * quarter. Node requires headers ≤ request; config.ts checks that.
 */
export function httpServerOptions({ headers, request, keepAlive }: HttpTimeouts): ServerOptions {
  return {
    headersTimeout: headers,
    requestTimeout: request,
    keepAliveTimeout: keepAlive,
    connectionsCheckingInterval: Math.ceil(Math.min(headers, request) / 4),
  }
}
