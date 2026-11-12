import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import type { Transform } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { isLoopbackAddress, isPublicAddress } from './addresses.ts'
import {
  answersPermitted,
  type DnsAnswer,
  isPublicHttpsUrl,
  MAX_DNS_ANSWERS,
  MAX_OUTBOUND_URL_BYTES,
  normalizedOutboundUrl,
  parseOutboundUrl,
  pinnedConnection,
  resolveAnswers,
  urlHostname,
  urlPort,
  validAnswers,
} from './destination.ts'
import type { PrivateTarget } from './private-targets.ts'
import {
  MAX_SSO_PRIVATE_TARGETS,
  type SsoPrivateTarget,
  ssoPrivateTargetFor,
} from './sso-private-targets.ts'

/**
 * The SSO transport profile's limits (docs/sso.md, "Transport limits"; the doc-fact test
 * imports this object). Times are milliseconds and sizes bytes.
 */
export const SSO_TRANSPORT_LIMITS = Object.freeze({
  /** DNS lookup, TCP connect and the TLS handshake, before the request is sent. */
  ssoConnectTimeout: 5_000,
  /** One absolute deadline for the whole exchange: connection, headers and the entire body. */
  ssoResponseTimeout: 10_000,
  /** Decoded body bytes; the bytes on the wire are capped at the same value. */
  ssoMaximumResponseBytes: 1_048_576,
  ssoMaximumHeaderBytes: 16_384,
  ssoMaximumUrlBytes: MAX_OUTBOUND_URL_BYTES,
  ssoMaximumDnsAnswers: MAX_DNS_ANSWERS,
  /** In-flight SSO requests per process; one more fails at once with `busy`. */
  ssoMaximumConcurrentRequests: 16,
  /** In-flight SSO requests per origin (scheme, host and port) per process. */
  ssoMaximumConcurrentRequestsPerOrigin: 4,
  ssoMaximumPrivateTargets: MAX_SSO_PRIVATE_TARGETS,
})

const LIMITS = SSO_TRANSPORT_LIMITS

export type SsoTransportFailure =
  | 'destination_refused'
  | 'dns_failed'
  | 'connect_timeout'
  | 'timeout'
  | 'aborted'
  | 'busy'
  | 'redirect_refused'
  | 'response_too_large'
  | 'unsupported_encoding'
  | 'transport_failed'

/**
 * The only error the profile throws. Its message is the code alone: no URL, header, request
 * or response body, resolver or TLS text, and no cause chain.
 */
export class SsoTransportError extends Error {
  readonly code: SsoTransportFailure
  constructor(code: SsoTransportFailure) {
    super(`SSO transport ${code}`)
    this.name = 'SsoTransportError'
    this.code = code
  }
}

export interface SsoRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Readonly<{ accept?: string; authorization?: string; 'content-type'?: string }>
  body?: string
  signal?: AbortSignal
  /**
   * The operator's parsed `SSO_PRIVATE_TARGETS`; empty routes nothing private and nothing on
   * a non-default port.
   */
  privateTargets: readonly SsoPrivateTarget[]
  /**
   * The separately acknowledged local trial: plain HTTP to a listed `localhost` or loopback
   * literal whose every answer is loopback. Nothing in production passes it.
   */
  loopbackHttpTrial?: boolean
}

export interface SsoResponse {
  readonly status: number
  readonly contentType: string | undefined
  readonly body: Buffer
}

function asPrivateTarget(target: SsoPrivateTarget): PrivateTarget {
  return { kind: 'host', host: target.host, portStart: target.port, portEnd: target.port }
}

/**
 * Syntax and scheme only: HTTPS to a public DNS name on the default port, or HTTPS to an
 * exact listed host:port. Plain HTTP only through the loopback trial. Every request resolves
 * and validates every DNS answer again (`ssoAnswersPermitted`).
 */
export function ssoUrl(
  value: unknown,
  privateTargets: readonly SsoPrivateTarget[],
  { loopbackHttpTrial = false }: { loopbackHttpTrial?: boolean } = {},
): string | undefined {
  const url = parseOutboundUrl(value)
  if (!url) return undefined
  const hostname = urlHostname(url)
  const listed = ssoPrivateTargetFor(hostname, urlPort(url), privateTargets) !== undefined
  if (url.protocol === 'http:') {
    if (!loopbackHttpTrial || !listed || (hostname !== 'localhost' && !isLoopbackAddress(hostname)))
      return undefined
  } else if (!listed && !isPublicHttpsUrl(url)) return undefined
  return normalizedOutboundUrl(url)
}

/**
 * The DNS answer policy, applied on every request after `ssoUrl` admitted the URL, and
 * repeating its destination rules rather than relying on them:
 * - an unlisted host needs public HTTPS syntax and only public answers;
 * - an exact listed host:port is operator-trusted for either kind: every answer ordinary
 *   private or loopback space, or every answer public;
 * - answers that mix kinds, or include metadata, link-local, mapped or other reserved
 *   space, are refused;
 * - plain HTTP (the loopback trial) also needs every answer to be loopback, so public
 *   answers are only ever reached over HTTPS.
 */
export function ssoAnswersPermitted(
  answers: readonly DnsAnswer[],
  url: URL,
  target: SsoPrivateTarget | undefined,
): boolean {
  return (
    (answersPermitted(answers, {
      publicUrl: isPublicHttpsUrl(url),
      candidates: target ? [asPrivateTarget(target)] : [],
    }) ||
      (target !== undefined && answers.every(({ address }) => isPublicAddress(address)))) &&
    (url.protocol === 'https:' || answers.every(({ address }) => isLoopbackAddress(address)))
  )
}

let active = 0
const activeByOrigin = new Map<string, number>()

function acquire(origin: string): () => void {
  const current = activeByOrigin.get(origin) ?? 0
  if (
    active >= LIMITS.ssoMaximumConcurrentRequests ||
    current >= LIMITS.ssoMaximumConcurrentRequestsPerOrigin
  )
    throw new SsoTransportError('busy')
  active += 1
  activeByOrigin.set(origin, current + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    active -= 1
    const remaining = (activeByOrigin.get(origin) ?? 1) - 1
    if (remaining > 0) activeByOrigin.set(origin, remaining)
    else activeByOrigin.delete(origin)
  }
}

function decoderFor(encoding: string | undefined): Transform | null | undefined {
  const value = (encoding ?? '').trim().toLowerCase()
  if (value === '' || value === 'identity') return null
  if (value === 'gzip' || value === 'x-gzip') return createGunzip()
  // Brotli is refused: its decoder may allocate a window of up to 16 MiB before the first
  // decoded byte can be counted. deflate, stacked codings and anything unknown are refused
  // rather than guessed.
  return undefined
}

/**
 * Fetches one SSO document or token response: discovery, JWKS, token, UserInfo or SAML
 * metadata. It resolves the host, refuses the request unless every answer is allowed,
 * connects only to the validated address with TLS verifying the original hostname, never
 * follows a redirect, and bounds time, size, decompression and concurrency. It logs nothing.
 */
export async function sendSsoRequest(input: SsoRequest): Promise<SsoResponse> {
  const loopbackHttpTrial = input.loopbackHttpTrial === true
  const normalized = ssoUrl(input.url, input.privateTargets, { loopbackHttpTrial })
  if (!normalized) throw new SsoTransportError('destination_refused')
  const url = new URL(normalized)
  const hostname = urlHostname(url)
  const target = ssoPrivateTargetFor(hostname, urlPort(url), input.privateTargets)
  const release = acquire(url.origin)
  try {
    return await attempt(input, url, hostname, target)
  } catch (error) {
    // Only the profile's own error leaves it, whatever failed.
    throw error instanceof SsoTransportError ? error : new SsoTransportError('transport_failed')
  } finally {
    // Released on every path, so a failure can never keep a slot.
    release()
  }
}

async function attempt(
  input: SsoRequest,
  url: URL,
  hostname: string,
  target: SsoPrivateTarget | undefined,
): Promise<SsoResponse> {
  const connecting = new AbortController()
  const connectDeadline = AbortSignal.timeout(LIMITS.ssoConnectTimeout)
  const responseDeadline = AbortSignal.timeout(LIMITS.ssoResponseTimeout)
  const onConnectDeadline = () => connecting.abort()
  if (connectDeadline.aborted) connecting.abort()
  else connectDeadline.addEventListener('abort', onConnectDeadline, { once: true })
  const connected = () => connectDeadline.removeEventListener('abort', onConnectDeadline)
  const deadline = AbortSignal.any([
    responseDeadline,
    connecting.signal,
    ...(input.signal ? [input.signal] : []),
  ])
  const stopped = () =>
    new SsoTransportError(
      connecting.signal.aborted
        ? 'connect_timeout'
        : responseDeadline.aborted
          ? 'timeout'
          : 'aborted',
    )

  try {
    const answers = await resolveAnswers(hostname, deadline, {
      stopped,
      failed: () => new SsoTransportError('dns_failed'),
    })
    if (!validAnswers(answers) || !ssoAnswersPermitted(answers, url, target))
      throw new SsoTransportError('destination_refused')
    if (deadline.aborted) throw stopped()
    const selected = answers[0]
    if (!selected) throw new SsoTransportError('destination_refused')
    return await exchange(input, url, hostname, selected, deadline, connected, stopped)
  } catch (error) {
    if (error instanceof SsoTransportError) throw error
    throw deadline.aborted ? stopped() : new SsoTransportError('transport_failed')
  } finally {
    connected()
  }
}

function exchange(
  input: SsoRequest,
  url: URL,
  hostname: string,
  selected: { address: string; family: number },
  deadline: AbortSignal,
  connected: () => void,
  stopped: () => SsoTransportError,
): Promise<SsoResponse> {
  return new Promise<SsoResponse>((resolve, reject) => {
    let settled = false
    let response: IncomingMessage | undefined
    let decoder: Transform | null | undefined = null
    const finish = (outcome: SsoResponse | SsoTransportError) => {
      if (settled) return
      settled = true
      deadline.removeEventListener('abort', onAbort)
      if (outcome instanceof SsoTransportError) {
        decoder?.destroy()
        response?.destroy()
        req.destroy()
        reject(outcome)
      } else resolve(outcome)
    }
    const onAbort = () => finish(stopped())
    const failed = () =>
      finish(deadline.aborted ? stopped() : new SsoTransportError('transport_failed'))
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest
    const body = input.method === 'POST' ? (input.body ?? '') : undefined
    const req = send(
      url,
      {
        ...pinnedConnection(hostname, selected),
        method: input.method ?? 'GET',
        signal: deadline,
        maxHeaderSize: LIMITS.ssoMaximumHeaderBytes,
        headers: {
          accept: input.headers?.accept ?? 'application/json',
          ...(input.headers?.authorization !== undefined && {
            authorization: input.headers.authorization,
          }),
          ...(input.headers?.['content-type'] !== undefined && {
            'content-type': input.headers['content-type'],
          }),
          ...(body !== undefined && { 'content-length': Buffer.byteLength(body).toString() }),
          'accept-encoding': 'gzip',
          'user-agent': 'Hourmere-SSO/1',
        },
      },
      (res) => {
        response = res
        const status = res.statusCode ?? 0
        // Redirects are refused, never followed: a Location is never contacted.
        if (status >= 300 && status < 400) return finish(new SsoTransportError('redirect_refused'))
        if (status < 200 || status > 599) return failed()
        const declared = res.headers['content-length']
        if (declared !== undefined && Number(declared) > LIMITS.ssoMaximumResponseBytes)
          return finish(new SsoTransportError('response_too_large'))
        decoder = decoderFor(res.headers['content-encoding'])
        if (decoder === undefined) return finish(new SsoTransportError('unsupported_encoding'))
        const chunks: Buffer[] = []
        let wire = 0
        let decoded = 0
        const take = (chunk: Buffer) => {
          decoded += chunk.length
          if (decoded > LIMITS.ssoMaximumResponseBytes)
            return finish(new SsoTransportError('response_too_large'))
          chunks.push(chunk)
        }
        const complete = () =>
          finish({
            status,
            contentType: res.headers['content-type'],
            body: Buffer.concat(chunks),
          })
        const active = decoder
        if (active) {
          active.on('data', take)
          active.once('end', complete)
          active.once('error', failed)
        }
        res.on('data', (chunk: Buffer) => {
          if (settled) return
          wire += chunk.length
          if (wire > LIMITS.ssoMaximumResponseBytes)
            return finish(new SsoTransportError('response_too_large'))
          if (active) active.write(chunk)
          else take(chunk)
        })
        res.once('end', () => {
          if (!res.complete) return failed()
          if (active) active.end()
          else complete()
        })
        res.once('error', failed)
        res.once('close', () => {
          if (!res.complete) failed()
        })
      },
    )
    deadline.addEventListener('abort', onAbort, { once: true })
    req.once('socket', (socket: Socket) =>
      socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', connected),
    )
    req.once('error', failed)
    req.end(body)
  })
}
