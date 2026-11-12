import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import {
  answersPermitted,
  isPublicHttpsUrl,
  normalizedOutboundUrl,
  parseOutboundUrl,
  pinnedConnection,
  privateTargetCandidates,
  resolveAnswers,
  urlHostname,
  urlPort,
  validAnswers,
} from '@hourmere/outbound'
import type { WebhookPrivateTarget } from './private-targets.ts'

// The address policy is shared with CalDAV and SSO through @hourmere/outbound.
export { isPublicAddress } from '@hourmere/outbound'

/** Syntax only. Every actual attempt resolves and validates every DNS candidate again. */
export function webhookUrl(
  value: unknown,
  privateTargets: readonly WebhookPrivateTarget[] = [],
): string | undefined {
  const url = parseOutboundUrl(value)
  if (!url) return undefined
  const privateCandidates = privateTargetCandidates(urlHostname(url), urlPort(url), privateTargets)
  if (!privateCandidates.length && !isPublicHttpsUrl(url)) return undefined
  return normalizedOutboundUrl(url)
}

export interface WebhookRequest {
  url: string
  body: string
  headers: Readonly<Record<string, string>>
  signal: AbortSignal
  privateTargets?: readonly WebhookPrivateTarget[]
}
export type WebhookTransport = (input: WebhookRequest) => Promise<number>

const refused = () => new Error('Webhook transport refused the destination')

/**
 * DNS, TCP, TLS and response headers share one absolute deadline. Validated addresses are
 * pinned to the socket; Host/SNI and certificate checks still use the original hostname.
 * No redirects, cookie jar, proxy environment, connection reuse or response-body logging.
 */
export const sendWebhook: WebhookTransport = async ({
  url: value,
  body,
  headers,
  signal,
  privateTargets = [],
}) => {
  const normalized = webhookUrl(value, privateTargets)
  if (!normalized) throw refused()
  const url = new URL(normalized)
  const hostname = urlHostname(url)
  const candidates = privateTargetCandidates(hostname, urlPort(url), privateTargets)
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  const addresses = await resolveAnswers(hostname, deadline, {
    stopped: () => new Error('Webhook transport stopped'),
    failed: () => new Error('Webhook DNS lookup failed'),
  })
  if (
    !validAnswers(addresses) ||
    !answersPermitted(addresses, { publicUrl: isPublicHttpsUrl(url), candidates })
  )
    throw refused()
  deadline.throwIfAborted()
  const selected = addresses[0]
  if (!selected) throw refused()
  return new Promise<number>((resolve, reject) => {
    const request = url.protocol === 'http:' ? httpRequest : httpsRequest
    const req = request(
      url,
      {
        ...pinnedConnection(hostname, selected),
        method: 'POST',
        signal: deadline,
        maxHeaderSize: 16_384,
        headers: {
          ...headers,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body).toString(),
          'user-agent': 'Hourmere-Webhooks/1',
        },
      },
      (res) => {
        // The status is the acknowledgement. Discard the body immediately, even for errors.
        res.destroy()
        resolve(res.statusCode ?? 500)
      },
    )
    req.once('error', () => reject(new Error('Webhook transport failed')))
    req.end(body)
  })
}
