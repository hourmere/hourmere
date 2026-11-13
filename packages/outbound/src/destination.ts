import { lookup } from 'node:dns/promises'
import type { RequestOptions } from 'node:http'
import { isIP } from 'node:net'
import { isPublicAddress } from './addresses.ts'
import { type PrivateTarget, privateTargetContains } from './private-targets.ts'

/** A stored or requested destination URL never exceeds this many bytes. */
export const MAX_OUTBOUND_URL_BYTES = 2048
/** More DNS answers than this are refused before any socket opens. */
export const MAX_DNS_ANSWERS = 32

/**
 * Syntax shared by every outbound profile: a well-formed HTTP(S) URL of bounded length,
 * without whitespace, backslashes, controls, userinfo, a fragment or a trailing-dot host.
 * Destination policy (public or private, which scheme) is the caller's next check.
 */
export function parseOutboundUrl(value: unknown): URL | undefined {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.length > MAX_OUTBOUND_URL_BYTES ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject controls before URL parsing
    /[\s\\\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    return undefined
  return urlHostname(url).endsWith('.') ? undefined : url
}

/** The URL's normalized form, or undefined when it no longer fits the stored byte limit. */
export function normalizedOutboundUrl(url: URL): string | undefined {
  const normalized = url.toString()
  return Buffer.byteLength(normalized) <= MAX_OUTBOUND_URL_BYTES ? normalized : undefined
}

/** The hostname without IPv6 brackets. */
export function urlHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '')
}

/** The explicit port, or the scheme's default. */
export function urlPort(url: URL): number {
  return Number(url.port || (url.protocol === 'http:' ? 80 : 443))
}

/**
 * Public syntax: HTTPS on the default port to a dotted DNS name, never an IP literal, a
 * single label or a special-use suffix. Every DNS answer must still be public.
 */
export function isPublicHttpsUrl(url: URL): boolean {
  return !(
    url.protocol !== 'https:' ||
    url.port ||
    isIP(urlHostname(url)) ||
    !url.hostname.includes('.') ||
    url.hostname.endsWith('.') ||
    ['localhost', 'local', 'internal', 'test', 'invalid', 'example', 'onion'].some(
      (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
    )
  )
}

export interface DnsAnswer {
  readonly address: string
  readonly family: number
}

/**
 * Every DNS candidate of one attempt. IP literals are returned as they are, because Node
 * skips its lookup for them, so the literal itself is what gets validated. The lookup races
 * the signal; failures carry no resolver text.
 */
export async function resolveAnswers(
  hostname: string,
  signal: AbortSignal,
  failures: { stopped: () => Error; failed: () => Error },
): Promise<unknown> {
  const literalFamily = isIP(hostname)
  if (literalFamily) return [{ address: hostname, family: literalFamily }]
  return new Promise<unknown>((resolve, reject) => {
    signal.throwIfAborted()
    const aborted = () => reject(failures.stopped())
    signal.addEventListener('abort', aborted, { once: true })
    lookup(hostname, { all: true, verbatim: true })
      .then(resolve, () => reject(failures.failed()))
      .finally(() => signal.removeEventListener('abort', aborted))
  })
}

/** A non-empty, bounded list whose every address is a valid IP of its stated family. */
export function validAnswers(answers: unknown): answers is readonly DnsAnswer[] {
  return (
    Array.isArray(answers) &&
    answers.length > 0 &&
    answers.length <= MAX_DNS_ANSWERS &&
    answers.every(
      (answer) =>
        typeof answer === 'object' &&
        answer !== null &&
        isIP((answer as { address?: unknown }).address as string) ===
          (answer as { family?: unknown }).family,
    )
  )
}

/**
 * The answers may be used when one private target accepts every one of them, or, while no
 * exact-host target names this destination, when the URL has public syntax and every answer
 * is public. An exact-host target is authoritative: its host never falls back to public
 * routing. Mixed answers are refused either way.
 */
export function answersPermitted(
  answers: readonly DnsAnswer[],
  { publicUrl, candidates }: { publicUrl: boolean; candidates: readonly PrivateTarget[] },
): boolean {
  return (
    (!candidates.some((target) => target.kind === 'host') &&
      publicUrl &&
      answers.every(({ address }) => isPublicAddress(address))) ||
    candidates.some((target) =>
      answers.every(({ address }) => privateTargetContains(target, address)),
    )
  )
}

/**
 * Socket options that connect only to the validated address. Host, SNI and certificate
 * verification still use the original hostname. No agent: no connection reuse or proxy.
 */
export function pinnedConnection(hostname: string, selected: DnsAnswer) {
  const lookupPinned: NonNullable<RequestOptions['lookup']> = (_hostname, _options, callback) =>
    callback(null, selected.address, selected.family)
  return {
    agent: false as const,
    family: selected.family,
    rejectUnauthorized: true,
    servername: isIP(hostname) ? undefined : hostname,
    lookup: lookupPinned,
  }
}
