import { SSO_TRANSPORT_LIMITS, SsoTransportError, sendSsoRequest } from '@hourmere/outbound/sso'
import { exportJWK, generateKeyPair, type JWK, jwtVerify, SignJWT } from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fetchOidcDiscovery, OidcJwksCache } from './sso-oidc-jwks.ts'
import { jwksCacheMaximum, oidcMaximumKidBytes } from './sso-oidc-limits.ts'

vi.mock('@hourmere/outbound/sso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hourmere/outbound/sso')>()),
  sendSsoRequest: vi.fn<typeof sendSsoRequest>(),
}))

const issuer = 'https://oidc.example.com/teams/a'
const discoveryUrl = 'https://oidc.example.com/teams/a/.well-known/openid-configuration'
const jwksUrl = 'https://keys.example.com/teams/a'
const provider = { providerId: 'provider-a', issuer, jwksUrl }
const metadata = { issuer, jwks_uri: jwksUrl }
const response = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: Buffer.from(JSON.stringify(body)),
})

function harness() {
  const send = vi.fn<typeof sendSsoRequest>()
  let now = 0
  const cache = new OidcJwksCache({ privateTargets: [], send, now: () => now })
  return {
    send,
    cache,
    advance: (ms: number) => {
      now += ms
    },
  }
}

let first: JWK
let second: JWK
let oldToken: string
let newToken: string

beforeAll(async () => {
  const [a, b] = await Promise.all([generateKeyPair('RS256'), generateKeyPair('RS256')])
  first = { ...(await exportJWK(a.publicKey)), kid: 'first', use: 'sig', alg: 'RS256' }
  second = { ...(await exportJWK(b.publicKey)), kid: 'second' }
  oldToken = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).sign(a.privateKey)
  newToken = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).sign(b.privateKey)
})

describe('guarded OIDC discovery', () => {
  it('uses the configured location and the default SSO transport', async () => {
    const send = vi.mocked(sendSsoRequest)
    send.mockResolvedValueOnce(response({ ...metadata, x5u: 'https://untrusted.example.com/key' }))
    await expect(
      fetchOidcDiscovery({ issuer, discoveryUrl, jwksUrl }, { privateTargets: [] }),
    ).resolves.toEqual({ issuer, jwksUrl })
    expect(send).toHaveBeenCalledExactlyOnceWith({ privateTargets: [], url: discoveryUrl })
    send.mockReset()
  })

  it.each([
    { ...metadata, issuer: `${issuer}/` },
    { ...metadata, issuer: 'https://oidc.example.com/teams/b' },
    { ...metadata, issuer: undefined },
    { ...metadata, jwks_uri: 'https://127.0.0.1/keys' },
    { ...metadata, jwks_uri: 'http://keys.example.com/teams/a' },
    { ...metadata, jwks_uri: 'https://keys.example.com/teams/b' },
    { ...metadata, jwks_uri: undefined },
  ])('refuses mismatched or unsafe discovery metadata %#', async (body) => {
    const { send } = harness()
    send.mockResolvedValueOnce(response(body))
    await expect(
      fetchOidcDiscovery({ issuer, discoveryUrl, jwksUrl }, { privateTargets: [], send }),
    ).rejects.toThrow('invalid_discovery')
    expect(send).toHaveBeenCalledExactlyOnceWith({ privateTargets: [], url: discoveryUrl })
  })

  it('refuses an unsafe discovery location before the outbound request', async () => {
    const { send } = harness()
    await expect(
      fetchOidcDiscovery(
        { issuer, discoveryUrl: 'https://127.0.0.1/discovery' },
        { privateTargets: [], send },
      ),
    ).rejects.toThrow('invalid_discovery')
    expect(send).not.toHaveBeenCalled()
  })

  it('redacts an outbound failure', async () => {
    const { send } = harness()
    send.mockRejectedValueOnce(new SsoTransportError('connect_timeout'))
    const rejected = fetchOidcDiscovery({ issuer, discoveryUrl }, { privateTargets: [], send })
    await expect(rejected).rejects.toHaveProperty('code', 'invalid_discovery')
    await expect(rejected).rejects.not.toHaveProperty('cause')
  })
})

describe('bounded OIDC key selection', () => {
  it('coalesces a rotated key refresh and replaces the whole snapshot', async () => {
    const { advance, cache, send } = harness()
    send.mockResolvedValueOnce(response({ keys: [first] }))
    const oldKey = await cache.keyFor(provider, 'first')
    await expect(jwtVerify(oldToken, oldKey)).resolves.toBeDefined()
    await expect(cache.keyFor(provider, 'first')).resolves.toBe(oldKey)
    await expect(cache.keyFor(provider, 'second')).rejects.toThrow('unknown_kid')
    expect(send).toHaveBeenCalledTimes(1)

    advance(30_000)
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof sendSsoRequest>>>()
    send.mockReturnValueOnce(pending.promise)
    const firstLookup = cache.keyFor(provider, 'second')
    const parallel = cache.keyFor(provider, 'second')
    const removed = expect(cache.keyFor(provider, 'first')).rejects.toThrow('unknown_kid')
    pending.resolve(response({ keys: [second] }))
    const newKey = await firstLookup
    await expect(parallel).resolves.toBe(newKey)
    await removed
    await expect(jwtVerify(newToken, newKey)).resolves.toBeDefined()
    await expect(cache.keyFor(provider, 'first')).rejects.toThrow('unknown_kid')
    expect(send.mock.calls).toEqual([
      [{ url: jwksUrl, privateTargets: [] }],
      [{ url: jwksUrl, privateTargets: [] }],
    ])
  })

  it('replaces a key reused under the same ID at exact cache expiry', async () => {
    const { advance, cache, send } = harness()
    send
      .mockResolvedValueOnce(response({ keys: [first] }))
      .mockResolvedValueOnce(response({ keys: [{ ...second, kid: 'first' }] }))
    const oldKey = await cache.keyFor(provider, 'first')
    advance(jwksCacheMaximum * 1000 - 1)
    await expect(cache.keyFor(provider, 'first')).resolves.toBe(oldKey)
    advance(1)
    const newKey = await cache.keyFor(provider, 'first')
    await expect(jwtVerify(newToken, newKey)).resolves.toBeDefined()
    await expect(jwtVerify(oldToken, newKey)).rejects.toHaveProperty(
      'code',
      'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    )
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('invalidates cached keys after a failed concurrent refresh', async () => {
    const { advance, cache, send } = harness()
    send.mockResolvedValueOnce(response({ keys: [first] }))
    await cache.keyFor(provider, 'first')
    advance(30_000)
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof sendSsoRequest>>>()
    send.mockReturnValueOnce(pending.promise)
    const unknown = cache.keyFor(provider, 'second')
    const known = cache.keyFor(provider, 'first')
    pending.reject(new SsoTransportError('timeout'))
    await expect(unknown).rejects.toThrow('jwks_unavailable')
    await expect(known).rejects.toThrow('jwks_unavailable')
    await expect(cache.keyFor(provider, 'first')).rejects.toThrow('jwks_unavailable')
    expect(send).toHaveBeenCalledTimes(2)

    advance(30_000)
    send.mockResolvedValueOnce(response({ keys: [first] }))
    await expect(cache.keyFor(provider, 'first')).resolves.toBeInstanceOf(CryptoKey)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('refuses expired keys during a JWKS outage and never exposes a response body', async () => {
    const { advance, cache, send } = harness()
    send
      .mockResolvedValueOnce(response({ keys: [first] }))
      .mockResolvedValueOnce(response({ error: 'provider failure body' }, 503))
    await cache.keyFor(provider, 'first')
    advance(jwksCacheMaximum * 1000)
    const rejected = cache.keyFor(provider, 'first')
    await expect(rejected).rejects.toHaveProperty('message', 'jwks_unavailable')
    await expect(rejected).rejects.not.toHaveProperty('cause')
    await expect(cache.keyFor(provider, 'first')).rejects.toThrow('jwks_unavailable')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('rejects duplicate key IDs even across algorithms and key types', async () => {
    const { cache, send } = harness()
    send.mockResolvedValueOnce(response({ keys: [first, { kty: 'EC', kid: 'first' }] }))
    await expect(cache.keyFor(provider, 'first')).rejects.toThrow('invalid_jwks')
  })

  it('ignores encryption or incompatible algorithm and key types and rejects their IDs', async () => {
    const { cache, send } = harness()
    send.mockResolvedValueOnce(
      response({
        keys: [
          first,
          { ...second, kid: 'rsa-encryption', use: 'enc' },
          { ...second, kid: 'rsa-encryption-ops', key_ops: ['encrypt'] },
          { ...second, kid: 'rsa-other-alg', alg: 'RS512' },
          { ...second, kid: 'wrong-key-type', kty: 'oct', alg: 'RS256' },
        ],
      }),
    )
    await expect(cache.keyFor(provider, 'first')).resolves.toBeInstanceOf(CryptoKey)
    for (const kid of ['rsa-encryption', 'rsa-encryption-ops', 'rsa-other-alg', 'wrong-key-type'])
      await expect(cache.keyFor(provider, kid)).rejects.toThrow('unknown_kid')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('refreshes a warm snapshot at most once for a series of unknown kids', async () => {
    const { advance, cache, send } = harness()
    send.mockResolvedValue(response({ keys: [first] }))
    await cache.keyFor(provider, 'first')
    advance(30_000)
    for (const kid of ['unknown-a', 'unknown-b', 'unknown-c'])
      await expect(cache.keyFor(provider, kid)).rejects.toThrow('unknown_kid')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('separates providers even when issuer, URI, and key ID agree', async () => {
    const { cache, send } = harness()
    send
      .mockResolvedValueOnce(response({ keys: [first] }))
      .mockResolvedValueOnce(response({ keys: [{ ...second, kid: 'first' }] }))
    const a = await cache.keyFor(provider, 'first')
    const b = await cache.keyFor({ ...provider, providerId: 'provider-b' }, 'first')
    await expect(jwtVerify(oldToken, a)).resolves.toBeDefined()
    await expect(jwtVerify(newToken, b)).resolves.toBeDefined()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('clears the snapshot when the exact issuer or guarded URI changes', async () => {
    const { advance, cache, send } = harness()
    const changedIssuer = { ...provider, issuer: `${issuer}/` }
    const changedUri = { ...changedIssuer, jwksUrl: 'https://keys.example.com/teams/b' }
    send.mockResolvedValue(response({ keys: [first] }))
    await cache.keyFor(provider, 'first')
    await expect(cache.keyFor(changedIssuer, 'first')).rejects.toThrow('jwks_unavailable')
    advance(30_000)
    await cache.keyFor(changedIssuer, 'first')
    advance(30_000)
    await cache.keyFor(changedUri, 'first')
    expect(send.mock.calls.map(([request]) => request.url)).toEqual([
      jwksUrl,
      jwksUrl,
      changedUri.jwksUrl,
    ])
  })

  it('bounds key count, document bytes and the requested kid', async () => {
    const { cache, send } = harness()
    await expect(cache.keyFor(provider, 'x'.repeat(oidcMaximumKidBytes + 1))).rejects.toThrow(
      'unknown_kid',
    )
    expect(send).not.toHaveBeenCalled()
    send.mockResolvedValueOnce(
      response({
        keys: Array.from({ length: 33 }, (_, i) => ({ ...first, kid: String(i) })),
      }),
    )
    await expect(cache.keyFor(provider, 'first')).rejects.toThrow('invalid_jwks')
    send.mockResolvedValueOnce(
      response({
        keys: [first],
        padding: 'x'.repeat(SSO_TRANSPORT_LIMITS.ssoMaximumResponseBytes),
      }),
    )
    await expect(cache.keyFor({ ...provider, providerId: 'provider-b' }, 'first')).rejects.toThrow(
      'jwks_unavailable',
    )
  })

  it('bounds retained cache entries without evicting in-flight requests or cooldowns', async () => {
    const { advance, cache, send } = harness()
    send.mockResolvedValue(response({ keys: [{ kty: 'EC', kid: 'ignored' }] }))
    for (let i = 0; i < 128; i++)
      await expect(cache.keyFor({ ...provider, providerId: String(i) }, 'first')).rejects.toThrow(
        'unknown_kid',
      )
    const extra = { ...provider, providerId: 'extra' }
    await expect(cache.keyFor(extra, 'first')).rejects.toThrow('jwks_unavailable')
    expect(send).toHaveBeenCalledTimes(128)
    advance(30_000)
    await expect(cache.keyFor(extra, 'first')).rejects.toThrow('unknown_kid')
    expect(send).toHaveBeenCalledTimes(129)
  })
})
