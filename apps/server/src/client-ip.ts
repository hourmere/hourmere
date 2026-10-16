import { BlockList, isIP } from 'node:net'
import type { HttpBindings } from '@hono/node-server'
import { CLIENT_IP_HEADER } from '@hourmere/auth'
import { createMiddleware } from 'hono/factory'

declare module 'hono' {
  interface ContextVariableMap {
    /** The client's address: the TCP peer, or what trusted proxies say it is. */
    clientIp: string | undefined
  }
}

/** "::ffff:203.0.113.7" (IPv4 on a dual-stack socket) → "203.0.113.7"; invalid → undefined. */
function normalize(value: string): string | undefined {
  const v = value.trim()
  const ip = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v)?.[1] ?? v
  return isIP(ip) ? ip : undefined
}

/** An IP address or CIDR range, e.g. `10.0.0.5`, `172.16.0.0/12`, `fd00::/8`. */
export function isTrustedProxyEntry(entry: string): boolean {
  const [address = '', prefix, ...rest] = entry.split('/')
  const version = isIP(address)
  if (!version || rest.length) return false
  if (prefix === undefined) return true
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128)
}

/**
 * Returns the client address for a request that arrived from `peer` (the TCP peer). Only a
 * trusted proxy's X-Forwarded-For is believed: walking it from the right, the first address
 * that is not itself a trusted proxy is the client. Anything to its left was written by the
 * client and may be forged.
 */
export function createClientIpResolver(trustedProxies: readonly string[]) {
  const trusted = new BlockList()
  for (const entry of trustedProxies) {
    if (!isTrustedProxyEntry(entry)) throw new Error(`invalid trusted proxy: ${entry}`)
    const [address = '', prefix] = entry.split('/')
    const type = isIP(address) === 6 ? 'ipv6' : 'ipv4'
    if (prefix === undefined) trusted.addAddress(address, type)
    else trusted.addSubnet(address, Number(prefix), type)
  }
  const isTrusted = (ip: string) => trusted.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4')

  return (peer: string | undefined, forwardedFor: string | undefined): string | undefined => {
    const peerIp = peer === undefined ? undefined : normalize(peer)
    if (!peerIp || !forwardedFor || !isTrusted(peerIp)) return peerIp
    let client = peerIp
    const hops = forwardedFor.split(',')
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = normalize(hops[i] ?? '')
      // A malformed entry ends what can be believed; keep the last good hop.
      if (!hop) break
      client = hop
      if (!isTrusted(hop)) break
    }
    return client
  }
}

/** Sets `c.var.clientIp` from the socket of @hono/node-server and TRUSTED_PROXIES. */
export function clientIp(trustedProxies: readonly string[]) {
  const resolve = createClientIpResolver(trustedProxies)
  return createMiddleware<{ Bindings: Partial<HttpBindings> }>(async (c, next) => {
    // c.env is absent when the app is called without a socket (tests via app.request).
    c.set(
      'clientIp',
      resolve(c.env?.incoming?.socket.remoteAddress, c.req.header('x-forwarded-for')),
    )
    await next()
  })
}

/** Request headers for Better Auth: the client IP in CLIENT_IP_HEADER, never the caller's. */
export function withClientIpHeader(headers: Headers, ip: string | undefined): Headers {
  const out = new Headers(headers)
  out.delete(CLIENT_IP_HEADER)
  if (ip) out.set(CLIENT_IP_HEADER, ip)
  return out
}

/** A copy of `request` (body included) carrying withClientIpHeader's headers. */
export function withClientIp(request: Request, ip: string | undefined): Request {
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: withClientIpHeader(request.headers, ip),
    signal: request.signal,
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    init.body = request.body
    init.duplex = 'half'
  }
  return new Request(request.url, init)
}
