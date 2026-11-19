import {
  base64url,
  CompactSign,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type JWTHeaderParameters,
  type JWTPayload,
  SignJWT,
} from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { OidcJwksCache } from './sso-oidc-jwks.ts'
import { verifyOidcIdToken } from './sso-oidc-verifier.ts'

const provider = {
  providerId: 'oidc-a',
  issuer: 'https://idp.example.com/tenant',
  jwksUrl: 'https://idp.example.com/jwks',
  clientId: 'hourmere-client',
}
const now = new Date('2026-06-12T12:00:00Z')
const time = now.getTime() / 1000
const nonce = 'a'.repeat(43)
const claims = {
  iss: provider.issuer,
  aud: provider.clientId,
  sub: 'Exact-Case Subject',
  exp: time + 60,
  iat: time,
  nonce,
  auth_time: time - 10,
}
const header = { alg: 'RS256', kid: 'signing-key' }
const rejected = 'SSO ID token rejected'

let signing: Awaited<ReturnType<typeof generateKeyPair>>
let keysBody: Buffer
beforeAll(async () => {
  signing = await generateKeyPair('RS256')
  const publicKey = await exportJWK(signing.publicKey)
  keysBody = Buffer.from(JSON.stringify({ keys: [{ ...publicKey, ...header }] }))
})

const sign = (patch: JWTPayload = {}, protectedHeader: JWTHeaderParameters = header) =>
  new SignJWT({ ...claims, ...patch }).setProtectedHeader(protectedHeader).sign(signing.privateKey)

function verifier(trustedAdditionalAudiences?: readonly string[]) {
  const send = vi.fn(async () => ({
    status: 200,
    contentType: 'application/json',
    body: keysBody,
  }))
  const cache = new OidcJwksCache({ privateTargets: [], send })
  return {
    send,
    verify: (token: unknown) =>
      verifyOidcIdToken(cache, { ...provider, trustedAdditionalAudiences }, token, nonce, now),
  }
}

describe('OIDC ID-token verification', () => {
  it('returns the exact issuer, subject and signed authentication time', async () => {
    const { verify } = verifier(['other'])
    await expect(verify(await sign())).resolves.toEqual({
      issuer: provider.issuer,
      subject: claims.sub,
      authTime: claims.auth_time,
    })
    await expect(verify(await sign({ auth_time: undefined }))).resolves.toMatchObject({
      authTime: undefined,
    })
    await expect(
      verify(await sign({ aud: [provider.clientId, 'other'], azp: provider.clientId })),
    ).resolves.toMatchObject({ subject: claims.sub })
  })

  it.each(['iss', 'aud', 'sub', 'exp', 'iat', 'nonce'])('requires %s', async (claim) => {
    await expect(verifier().verify(await sign({ [claim]: undefined }))).rejects.toThrow(rejected)
  })

  it.each([
    ['issuer mix-up with the same signing key', { iss: 'https://idp.example.com/other' }],
    ['issuer trailing slash', { iss: `${provider.issuer}/` }],
    ['wrong audience', { aud: 'other' }],
    ['empty audience', { aud: [] }],
    ['invalid audience type', { aud: [provider.clientId, 1], azp: provider.clientId }],
    ['blank second audience', { aud: [provider.clientId, ''], azp: provider.clientId }],
    ['duplicate audience', { aud: [provider.clientId, provider.clientId], azp: provider.clientId }],
    [
      'untrusted additional audience',
      { aud: [provider.clientId, 'untrusted'], azp: provider.clientId },
    ],
    ['missing azp', { aud: [provider.clientId, 'other'] }],
    ['wrong azp with multiple audiences', { aud: [provider.clientId, 'other'], azp: 'other' }],
    ['wrong azp with one audience', { azp: 'other' }],
    ['non-string azp', { azp: null }],
    ['empty subject', { sub: '' }],
    ['blank subject', { sub: '   ' }],
    ['non-string subject', { sub: 1 }],
    ['oversized subject', { sub: 'x'.repeat(256) }],
    ['non-ASCII subject', { sub: '用户' }],
    ['non-numeric iat', { iat: `${time}` }],
    ['non-numeric exp', { exp: `${time}` }],
    ['non-numeric nbf', { nbf: `${time}` }],
    ['non-numeric auth_time', { auth_time: `${time}` }],
    ['null auth_time', { auth_time: null }],
    ['wrong nonce', { nonce: 'b'.repeat(43) }],
    ['non-string nonce', { nonce: [nonce] }],
  ] as const)('rejects %s', async (_description, patch) => {
    // Use compact JWS to sign malformed claim types rejected by the JWT builder.
    const token = await new CompactSign(Buffer.from(JSON.stringify({ ...claims, ...patch })))
      .setProtectedHeader(header)
      .sign(signing.privateKey)
    await expect(verifier(['other']).verify(token)).rejects.toThrow(rejected)
  })

  it.each(['exp', 'auth_time'])('rejects non-finite signed %s', async (claim) => {
    const raw = JSON.stringify({ ...claims, [claim]: 'overflow' }).replace('"overflow"', '1e999')
    const token = await new CompactSign(Buffer.from(raw))
      .setProtectedHeader(header)
      .sign(signing.privateKey)
    await expect(verifier().verify(token)).rejects.toThrow(rejected)
  })

  it.each([
    ['future iat', { iat: time + 30 }, { iat: time + 31 }],
    ['future auth_time', { auth_time: time + 30 }, { auth_time: time + 31 }],
    ['future nbf', { nbf: time + 30 }, { nbf: time + 31 }],
    ['expiry', { exp: time - 29, iat: time - 60 }, { exp: time - 30, iat: time - 60 }],
    ['token age', { iat: time - 630 }, { iat: time - 631 }],
  ] as const)('applies the 30-second tolerance once to %s', async (_name, inside, outside) => {
    const { verify } = verifier()
    await expect(verify(await sign(inside))).resolves.toMatchObject({ subject: claims.sub })
    await expect(verify(await sign(outside))).rejects.toThrow(rejected)
  })

  it('requires a bounded compact token and a signing key ID', async () => {
    const { send, verify } = verifier()
    for (const token of [undefined, '', 'x'.repeat(65_537), 'not.a.jwt'])
      await expect(verify(token)).rejects.toThrow(rejected)
    for (const kid of [undefined, '', ' ', 'x'.repeat(257)])
      await expect(verify(await sign({}, { alg: 'RS256', kid }))).rejects.toThrow(rejected)
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses missing alg, none, HMAC using the RSA public key, and other signing algorithms', async () => {
    const { send, verify } = verifier()
    const payload = base64url.encode(JSON.stringify(claims))
    const hmacKey = Buffer.from(await exportSPKI(signing.publicKey))
    const hmac = await new SignJWT(claims)
      .setProtectedHeader({ ...header, alg: 'HS256' })
      .sign(hmacKey)
    const ec = await generateKeyPair('ES256')
    const es256 = await new SignJWT(claims)
      .setProtectedHeader({ ...header, alg: 'ES256' })
      .sign(ec.privateKey)
    for (const token of [
      `${base64url.encode(JSON.stringify({ kid: header.kid }))}.${payload}.`,
      `${base64url.encode(JSON.stringify({ ...header, alg: 'none' }))}.${payload}.`,
      hmac,
      es256,
    ])
      await expect(verify(token)).rejects.toThrow(rejected)
    expect(send).not.toHaveBeenCalled()
  })

  it('ignores header key URLs and refuses tampering with signed auth_time', async () => {
    const { send, verify } = verifier()
    const token = await sign(
      {},
      {
        ...header,
        jku: 'https://token-header.example.com/jwks',
        x5u: 'https://token-header.example.com/cert',
      },
    )
    await expect(verify(token)).resolves.toMatchObject({ authTime: claims.auth_time })
    const [protectedHeader, , signature] = token.split('.')
    const tampered = base64url.encode(JSON.stringify({ ...claims, auth_time: time }))
    await expect(verify(`${protectedHeader}.${tampered}.${signature}`)).rejects.toThrow(rejected)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ url: provider.jwksUrl }))
  })
})
