import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import {
  privateTargetCandidates,
  privateTargetContains,
  type WebhookPrivateTarget,
} from './private-targets.ts'

// Conservative special-purpose policy, including globally reachable anycast entries.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.175.48.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['2620:4f:8000::', 48],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  blocked.addSubnet(network, prefix, 'ipv6')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4
    ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

/** Syntax only. Every actual attempt resolves and validates every DNS candidate again. */
export function webhookUrl(
  value: unknown,
  privateTargets: readonly WebhookPrivateTarget[] = [],
): string | undefined {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.length > 2048 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject controls before URL parsing
    /[\s\\\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      return undefined
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    if (hostname.endsWith('.')) return undefined
    const privateCandidates = privateTargetCandidates(
      hostname,
      Number(url.port || (url.protocol === 'http:' ? 80 : 443)),
      privateTargets,
    )
    if (!privateCandidates.length && !publicWebhookUrl(url)) return undefined
    const normalized = url.toString()
    return Buffer.byteLength(normalized) <= 2048 ? normalized : undefined
  } catch {
    return undefined
  }
}

function publicWebhookUrl(url: URL): boolean {
  return !(
    url.protocol !== 'https:' ||
    url.port ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    !url.hostname.includes('.') ||
    url.hostname.endsWith('.') ||
    ['localhost', 'local', 'internal', 'test', 'invalid', 'example', 'onion'].some(
      (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
    )
  )
}

export interface WebhookRequest {
  url: string
  body: string
  headers: Readonly<Record<string, string>>
  signal: AbortSignal
  privateTargets?: readonly WebhookPrivateTarget[]
}
export type WebhookTransport = (input: WebhookRequest) => Promise<number>

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
  if (!normalized) throw new Error('Webhook transport refused the destination')
  const url = new URL(normalized)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const candidates = privateTargetCandidates(
    hostname,
    Number(url.port || (url.protocol === 'http:' ? 80 : 443)),
    privateTargets,
  )
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  // Node skips lookup for IP literals, so validate the actual socket address directly.
  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
        deadline.throwIfAborted()
        const aborted = () => reject(new Error('Webhook transport stopped'))
        deadline.addEventListener('abort', aborted, { once: true })
        lookup(hostname, { all: true, verbatim: true })
          .then(resolve, () => reject(new Error('Webhook DNS lookup failed')))
          .finally(() => deadline.removeEventListener('abort', aborted))
      })
  if (
    !Array.isArray(addresses) ||
    !addresses.length ||
    addresses.length > 32 ||
    addresses.some(({ address, family }) => isIP(address) !== family) ||
    !(
      (!candidates.some((target) => target.kind === 'host') &&
        publicWebhookUrl(url) &&
        addresses.every(({ address }) => isPublicAddress(address))) ||
      candidates.some((target) =>
        addresses.every(({ address }) => privateTargetContains(target, address)),
      )
    )
  )
    throw new Error('Webhook transport refused the destination')
  deadline.throwIfAborted()
  const selected = addresses[0]
  if (!selected) throw new Error('Webhook transport refused the destination')
  return new Promise<number>((resolve, reject) => {
    const request = url.protocol === 'http:' ? httpRequest : httpsRequest
    const req = request(
      url,
      {
        method: 'POST',
        agent: false,
        signal: deadline,
        family: selected.family,
        maxHeaderSize: 16_384,
        rejectUnauthorized: true,
        servername: literalFamily ? undefined : hostname,
        lookup: (_hostname, _options, callback) =>
          callback(null, selected.address, selected.family),
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
