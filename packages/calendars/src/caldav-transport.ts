import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
import { isPublicAddress, webhookUrl } from '@hourmere/webhooks/outbound-guard'
import {
  privateTargetCandidates,
  privateTargetContains,
  type WebhookPrivateTarget,
} from '@hourmere/webhooks/private-targets'

import { redactCalDavField } from './caldav-redaction.ts'

export type CalDavPrivateTarget = WebhookPrivateTarget
export const CALDAV_MAX_RESPONSE_BYTES = 1_048_576
export class CalDavError extends Error {
  readonly code:
    | 'destination_refused'
    | 'transport_failed'
    | 'timeout'
    | 'invalid_response'
    | 'unauthorized'
    | 'forbidden'
    | 'rate_limited'
    | 'unavailable'
  constructor(code: CalDavError['code']) {
    super(`CalDAV ${code}`)
    this.code = code
  }
}
export interface CalDavRequest {
  url: string
  body: string
  authorization: string
  depth: '0' | '1'
  signal: AbortSignal
  privateTargets: readonly CalDavPrivateTarget[]
}
export function redactCalDavRequest(input: CalDavRequest): CalDavRequest {
  return redactCalDavField(input, 'authorization')
}
export interface CalDavResponse {
  status: number
  body: string
  location?: string
}
export type CalDavTransport = (input: CalDavRequest) => Promise<CalDavResponse>
export function calDavUrl(
  value: string,
  privateTargets: readonly CalDavPrivateTarget[] = [],
): string {
  const normalized = webhookUrl(value, privateTargets)
  if (!normalized || new URL(normalized).protocol !== 'https:' || normalized.includes('?'))
    throw new CalDavError('destination_refused')
  return normalized
}
/** No redirects/proxies; validate every DNS answer and pin the selected address to TLS. */
export const sendCalDav: CalDavTransport = async (input) => {
  const url = new URL(calDavUrl(input.url, input.privateTargets))
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const candidates = privateTargetCandidates(
    hostname,
    Number(url.port || 443),
    input.privateTargets,
  )
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10_000)])
  try {
    const family = isIP(hostname)
    const addresses = family
      ? [{ address: hostname, family }]
      : await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
          signal.throwIfAborted()
          const abort = () => reject(new CalDavError('timeout'))
          signal.addEventListener('abort', abort, { once: true })
          lookup(hostname, { all: true, verbatim: true })
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort))
        })
    if (
      !addresses.length ||
      addresses.length > 32 ||
      addresses.some((a) => isIP(a.address) !== a.family) ||
      !(
        (!candidates.some((c) => c.kind === 'host') &&
          webhookUrl(input.url) !== undefined &&
          addresses.every((a) => isPublicAddress(a.address))) ||
        candidates.some((c) => addresses.every((a) => privateTargetContains(c, a.address)))
      )
    )
      throw new CalDavError('destination_refused')
    signal.throwIfAborted()
    const selected = addresses[0]
    if (!selected) throw new CalDavError('destination_refused')
    return await new Promise<CalDavResponse>((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'PROPFIND',
          agent: false,
          signal,
          family: selected.family,
          rejectUnauthorized: true,
          servername: family ? undefined : hostname,
          maxHeaderSize: 16_384,
          lookup: (_hostname, _options, callback) =>
            callback(null, selected.address, selected.family),
          headers: {
            authorization: input.authorization,
            depth: input.depth,
            'content-type': 'application/xml; charset=utf-8',
            'content-length': Buffer.byteLength(input.body).toString(),
            'user-agent': 'Hourmere-CalDAV/1',
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > CALDAV_MAX_RESPONSE_BYTES) {
              res.destroy()
              reject(new CalDavError('invalid_response'))
              return
            }
            chunks.push(chunk)
          })
          res.once('error', () => reject(new CalDavError('transport_failed')))
          res.once('aborted', () => reject(new CalDavError('transport_failed')))
          res.once('end', () =>
            resolve({
              status: res.statusCode ?? 500,
              body: Buffer.concat(chunks).toString('utf8'),
              location: res.headers.location,
            }),
          )
        },
      )
      req.once('error', () => reject(new CalDavError('transport_failed')))
      req.end(input.body)
    })
  } catch (error) {
    if (signal.aborted) throw new CalDavError('timeout')
    if (error instanceof CalDavError) throw error
    throw new CalDavError('transport_failed')
  }
}
