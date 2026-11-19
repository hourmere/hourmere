import { performance } from 'node:perf_hooks'
import {
  SSO_TRANSPORT_LIMITS,
  type SsoRequest,
  sendSsoRequest,
  ssoUrl,
} from '@hourmere/outbound/sso'
import { importJWK } from 'jose'
import { jwksCacheMaximum, oidcMaximumKidBytes } from './sso-oidc-limits.ts'

const MAXIMUM_CACHE_ENTRIES = 128
const MAXIMUM_KEYS = 32
const REFRESH_COOLDOWN_MS = 30_000

/** The provider and location come from trusted configuration or its exact-issuer discovery. */
export interface OidcJwksProvider {
  providerId: string
  issuer: string
  jwksUrl: string
}

type Transport = {
  privateTargets: SsoRequest['privateTargets']
  send?: typeof sendSsoRequest
}

type KeySet = {
  keys: ReadonlyMap<string, CryptoKey>
  expiresAt: number
}

type CacheEntry = {
  issuer: string
  url: string
  retryAt: number
  snapshot?: KeySet | undefined
  pending?: Promise<KeySet> | undefined
}

type DocumentFailure = 'invalid_discovery' | 'invalid_jwks' | 'jwks_unavailable' | 'unknown_kid'

class OidcDocumentError extends Error {
  readonly code: DocumentFailure
  constructor(code: DocumentFailure) {
    super(code)
    this.name = 'OidcDocumentError'
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function document(url: string, transport: Transport) {
  const response = await (transport.send ?? sendSsoRequest)({
    url,
    privateTargets: transport.privateTargets,
  })
  if (
    response.status !== 200 ||
    response.body.byteLength > SSO_TRANSPORT_LIMITS.ssoMaximumResponseBytes
  )
    throw new OidcDocumentError('jwks_unavailable')
  const parsed: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(response.body),
  )
  if (!isRecord(parsed)) throw new OidcDocumentError('invalid_jwks')
  return parsed
}

/** Fetches only the configured discovery location and binds its JWKS URI to the exact issuer. */
export async function fetchOidcDiscovery(
  config: {
    issuer: string
    discoveryUrl: string
    jwksUrl?: string | undefined
  },
  transport: Transport,
) {
  try {
    const issuerUrl = ssoUrl(config.issuer, transport.privateTargets)
    const discoveryUrl = ssoUrl(config.discoveryUrl, transport.privateTargets)
    if (!issuerUrl || issuerUrl.includes('?') || !discoveryUrl)
      throw new OidcDocumentError('invalid_discovery')
    const metadata = await document(discoveryUrl, transport)
    const jwksUrl = ssoUrl(metadata.jwks_uri, transport.privateTargets)
    if (
      metadata.issuer !== config.issuer ||
      !jwksUrl ||
      (config.jwksUrl !== undefined && ssoUrl(config.jwksUrl, transport.privateTargets) !== jwksUrl)
    )
      throw new OidcDocumentError('invalid_discovery')
    return {
      issuer: config.issuer,
      jwksUrl,
      ...(metadata.authorization_endpoint !== undefined && {
        authorizationEndpoint: ssoUrl(metadata.authorization_endpoint, transport.privateTargets),
      }),
      ...(metadata.token_endpoint !== undefined && {
        tokenEndpoint: ssoUrl(metadata.token_endpoint, transport.privateTargets),
      }),
    }
  } catch {
    // Never forward parsing errors, provider response text, or transport details.
    throw new OidcDocumentError('invalid_discovery')
  }
}

function validKid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.isWellFormed() &&
    Buffer.byteLength(value) <= oidcMaximumKidBytes
  )
}

function base64urlInteger(value: unknown, maximumBytes: number): value is string {
  if (typeof value !== 'string' || value.length > Math.ceil((maximumBytes * 4) / 3)) return false
  const bytes = Buffer.from(value, 'base64url')
  return (
    bytes.length > 0 &&
    bytes.length <= maximumBytes &&
    bytes[0] !== 0 &&
    bytes.toString('base64url') === value
  )
}

async function rsaVerificationKey(key: Record<string, unknown>): Promise<CryptoKey | undefined> {
  if (
    key.kty !== 'RSA' ||
    (key.alg !== undefined && key.alg !== 'RS256') ||
    (key.use !== undefined && key.use !== 'sig') ||
    (key.key_ops !== undefined &&
      (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== 'verify'))
  )
    return undefined
  // Only import bounded, public RSA parameters. Other members cannot influence key selection
  // or trigger a fetch.
  if (key.d !== undefined || !base64urlInteger(key.n, 1024) || !base64urlInteger(key.e, 4))
    throw new OidcDocumentError('invalid_jwks')
  const exponent = Buffer.from(key.e, 'base64url')
  const exponentValue = exponent.readUIntBE(0, exponent.length)
  if (exponentValue < 3 || exponentValue % 2 !== 1) throw new OidcDocumentError('invalid_jwks')
  const imported = await importJWK({ kty: 'RSA', n: key.n, e: key.e }, 'RS256')
  if (
    !(imported instanceof CryptoKey) ||
    !('modulusLength' in imported.algorithm) ||
    typeof imported.algorithm.modulusLength !== 'number' ||
    imported.algorithm.modulusLength < 2048
  )
    throw new OidcDocumentError('invalid_jwks')
  return imported
}

async function loadKeys(
  url: string,
  transport: Transport,
): Promise<ReadonlyMap<string, CryptoKey>> {
  try {
    const { keys } = await document(url, transport)
    if (!Array.isArray(keys) || !keys.length || keys.length > MAXIMUM_KEYS)
      throw new OidcDocumentError('invalid_jwks')
    const seen = new Set<string>()
    const imported = new Map<string, CryptoKey>()
    for (const key of keys as unknown[]) {
      if (!isRecord(key) || typeof key.kty !== 'string') throw new OidcDocumentError('invalid_jwks')
      if (key.kid === undefined) continue
      if (!validKid(key.kid) || seen.has(key.kid)) throw new OidcDocumentError('invalid_jwks')
      seen.add(key.kid)
      const value = await rsaVerificationKey(key)
      if (value) imported.set(key.kid, value)
    }
    return imported
  } catch (error) {
    if (error instanceof OidcDocumentError) throw error
    throw new OidcDocumentError('jwks_unavailable')
  }
}

/** One cache per verifier process, partitioned by provider and its exact issuer and JWKS URI. */
export class OidcJwksCache {
  readonly #entries = new Map<string, CacheEntry>()
  readonly #transport: Transport
  readonly #now: () => number

  constructor(options: Transport & { now?: () => number }) {
    this.#transport = options
    this.#now = options.now ?? (() => performance.now())
  }

  #entry(provider: OidcJwksProvider, url: string, now: number): CacheEntry {
    const prior = this.#entries.get(provider.providerId)
    if (prior?.issuer === provider.issuer && prior.url === url) {
      // Map order tracks use for eviction.
      this.#entries.delete(provider.providerId)
      this.#entries.set(provider.providerId, prior)
      return prior
    }
    if (prior?.pending) throw new OidcDocumentError('jwks_unavailable')
    if (!prior && this.#entries.size === MAXIMUM_CACHE_ENTRIES) {
      // Keep in-flight entries and their cooldowns even under pressure.
      const evictable = [...this.#entries].find(
        ([, entry]) => !entry.pending && entry.retryAt <= now,
      )
      if (!evictable) throw new OidcDocumentError('jwks_unavailable')
      this.#entries.delete(evictable[0])
    }
    const entry = { issuer: provider.issuer, url, retryAt: prior?.retryAt ?? now }
    this.#entries.delete(provider.providerId)
    this.#entries.set(provider.providerId, entry)
    return entry
  }

  #refresh(entry: CacheEntry): Promise<KeySet> {
    // Once we try to refresh, the old snapshot cannot outlive failure or race the refresh.
    entry.snapshot = undefined
    entry.pending = loadKeys(entry.url, this.#transport)
      .then((keys) => {
        const snapshot = { keys, expiresAt: this.#now() + jwksCacheMaximum * 1000 }
        entry.snapshot = snapshot
        return snapshot
      })
      .finally(() => {
        entry.retryAt = this.#now() + REFRESH_COOLDOWN_MS
        entry.pending = undefined
      })
    return entry.pending
  }

  async keyFor(provider: OidcJwksProvider, kid: string): Promise<CryptoKey> {
    if (!validKid(kid)) throw new OidcDocumentError('unknown_kid')
    const url = ssoUrl(provider.jwksUrl, this.#transport.privateTargets)
    if (!url) throw new OidcDocumentError('invalid_jwks')
    const now = this.#now()
    const entry = this.#entry(provider, url, now)
    let snapshot = entry.snapshot
    if (entry.pending) snapshot = await entry.pending
    else if (!snapshot || snapshot.expiresAt <= now || !snapshot.keys.has(kid)) {
      if (entry.retryAt <= now) snapshot = await this.#refresh(entry)
      else if (!snapshot || snapshot.expiresAt <= now)
        throw new OidcDocumentError('jwks_unavailable')
    }
    const key = snapshot.keys.get(kid)
    if (!key) throw new OidcDocumentError('unknown_kid')
    return key
  }
}
