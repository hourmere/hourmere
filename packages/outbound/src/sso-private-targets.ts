import { isIP } from 'node:net'
import { urlHostname } from './destination.ts'
import { isPrivateTargetAddress } from './private-targets.ts'

/**
 * One operator-trusted SSO destination: an exact host (a DNS name or an IP literal) on
 * exactly one port. There are no networks and no port ranges: a different port, or a
 * different host name that resolves to the same address, is not this target. A listed name
 * may resolve to ordinary private or loopback space, or to public space (an IdP served
 * publicly on a non-default port), but never to a mix of the two. HTTPS stays required,
 * except for the separately acknowledged loopback trial.
 */
export interface SsoPrivateTarget {
  readonly host: string
  readonly port: number
}

/** At most this many comma-separated entries, as for the webhook setting. */
export const MAX_SSO_PRIVATE_TARGETS = 32

/**
 * Parses `SSO_PRIVATE_TARGETS` once at startup, without DNS or echoing supplied values. An
 * entry is `host:port`, `IPv4:port` or `[IPv6]:port`; an IP literal must be ordinary private
 * or loopback space (never metadata, link-local or public). Hosts are normalized the way a
 * request URL's host is, so matching is exact string equality.
 */
export function parseSsoPrivateTargets(value?: string): readonly SsoPrivateTarget[] {
  const invalid = () => new Error('Invalid SSO_PRIVATE_TARGETS setting')
  if (value === undefined || value.trim() === '') return Object.freeze([])
  const entries = value.split(',')
  if (entries.length > MAX_SSO_PRIVATE_TARGETS) throw invalid()
  const targets = entries.map((entry): SsoPrivateTarget => {
    const match = /^(?:\[([^\]]+)\]|([^:[\]/]+)):([1-9]\d{0,4})$/.exec(entry.trim())
    if (!match) throw invalid()
    const port = Number(match[3])
    if (port > 65535) throw invalid()
    const bracketed = match[1]
    const plain = match[2] ?? ''
    if (bracketed !== undefined) {
      if (isIP(bracketed) !== 6 || !isPrivateTargetAddress(bracketed)) throw invalid()
    } else if (isIP(plain) === 4) {
      if (!isPrivateTargetAddress(plain)) throw invalid()
    } else if (
      plain.length > 253 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(plain) ||
      plain.split('.').some((label) => label.length > 63) ||
      // Numeric-looking legacy IPv4 spellings must never become trusted DNS names.
      /^[0-9.]+$/.test(plain) ||
      /^0x[0-9a-f]+$/i.test(plain)
    )
      throw invalid()
    let host: string
    try {
      host = urlHostname(new URL(`https://${bracketed === undefined ? plain : `[${bracketed}]`}/`))
    } catch {
      throw invalid()
    }
    if (bracketed === undefined && host !== plain.toLowerCase()) throw invalid()
    return Object.freeze({ host, port })
  })
  return Object.freeze(targets)
}

/** The target naming exactly this request host and port, if any. */
export function ssoPrivateTargetFor(
  hostname: string,
  port: number,
  targets: readonly SsoPrivateTarget[],
): SsoPrivateTarget | undefined {
  return targets.find((target) => target.host === hostname && target.port === port)
}
