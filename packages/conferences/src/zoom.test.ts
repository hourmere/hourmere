import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  conferenceAad,
  conferenceEncryptionKey,
  decryptConferenceCredential,
  encryptConferenceCredential,
} from './credentials.ts'
import { fakeZoom, TEST_CONFERENCE_KEY } from './testing.ts'
import { createZoomClient, ZOOM_SCOPE } from './zoom.ts'

const signal = () => AbortSignal.timeout(1000)
describe('Zoom confidential OAuth transport and separate encryption', () => {
  it('uses advanced minimal scopes, S256 and the fixed callback without secret/verifier URL values', () => {
    const p = fakeZoom(),
      url = new URL(p.client.authorizationUrl('synthetic-state', 'synthetic-verifier'))
    expect(url.origin + url.pathname).toBe('https://zoom.us/oauth/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:5173/api/conference/zoom/callback',
    )
    expect(url.searchParams.get('scope')).toBe(ZOOM_SCOPE)
    expect(url.searchParams.has('optional_scope')).toBe(true)
    expect(url.searchParams.get('optional_scope')).toBe('')
    expect(url.searchParams.has('include_granted_scopes')).toBe(false)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update('synthetic-verifier').digest('base64url'),
    )
    expect(url.href).not.toContain('synthetic-secret')
    expect(url.href).not.toContain('synthetic-verifier')
  })
  it('uses Basic plus confidential PKCE fields, accepts bearer casing, and ignores arbitrary api_url', async () => {
    const p = fakeZoom()
    p.controls.token.token_type = 'Bearer'
    p.controls.token.api_url = 'https://untrusted.invalid'
    const tokens = await p.client.exchange('synthetic-code', 'synthetic-verifier', signal())
    const call = p.calls[0]
    expect(call?.url).toBe('https://zoom.us/oauth/token')
    expect(call?.init.redirect).toBe('error')
    expect(new Headers(call?.init.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('synthetic-client:synthetic-secret').toString('base64')}`,
    )
    const body = new URLSearchParams(String(call?.init.body))
    expect(body.get('code_verifier')).toBe('synthetic-verifier')
    expect(body.get('client_secret')).toBe('synthetic-secret')
    expect(body.get('redirect_uri')).toBe('http://localhost:5173/api/conference/zoom/callback')
    expect((await p.client.identity(tokens.accessToken, signal())).name).toBe('Settings')
    expect(p.calls[1]?.url).toBe('https://api.zoom.us/v2/users/me')
    await p.client.refresh(tokens.refreshToken, signal())
    expect(new URLSearchParams(String(p.calls[2]?.init.body)).get('grant_type')).toBe(
      'refresh_token',
    )
    expect(
      p.calls.every(
        (c) =>
          !c.url.includes('synthetic-secret') &&
          !c.url.includes('synthetic-code') &&
          !c.url.includes(tokens.accessToken),
      ),
    ).toBe(true)
  })
  it.each([
    undefined,
    '',
    'user:read:user meeting:write:meeting',
    'user:read:admin',
    'user:read:user user:read:user',
  ])('fails closed for a missing or nonminimal returned scope: %s', async (scope) => {
    const p = fakeZoom()
    if (scope === undefined) delete p.controls.token.scope
    else p.controls.token.scope = scope
    await expect(p.client.exchange('code', 'verifier', signal())).rejects.toThrow()
  })
  it.each(['mac', '', undefined])('refuses a non-bearer token type: %s', async (type) => {
    const p = fakeZoom()
    p.controls.token.token_type = type
    await expect(p.client.refresh('refresh', signal())).rejects.toThrow('provider_unavailable')
  })
  it.each([400, 401, 403, 429, 500])(
    'returns safe errors without upstream bodies or causes for HTTP %s',
    async (status) => {
      const p = fakeZoom()
      p.controls.tokenStatus = status
      p.controls.token = { error: 'synthetic-sensitive-provider-error' }
      try {
        await p.client.refresh('refresh', signal())
        throw new Error('Expected rejection')
      } catch (error) {
        expect(String(error)).not.toContain('synthetic-sensitive')
        expect((error as Error).cause).toBeUndefined()
        expect(String(error)).toMatch(/needs_reauth|permissions_missing|provider_unavailable/)
      }
    },
  )
  it('bounds response size and rejects malformed JSON/identity and redirects', async () => {
    const p = fakeZoom()
    p.controls.tokenHook = async () => new Response('x'.repeat(32769))
    await expect(p.client.refresh('refresh', signal())).rejects.toThrow('provider_unavailable')
    p.controls.tokenHook = async () => new Response('{')
    await expect(p.client.refresh('refresh', signal())).rejects.toThrow('provider_unavailable')
    p.controls.identity.id = '../not-an-id'
    await expect(p.client.identity('access', signal())).rejects.toThrow('provider_unavailable')
    p.controls.tokenHook = async () =>
      new Response(null, { status: 302, headers: { Location: 'https://untrusted.invalid' } })
    await expect(p.client.refresh('refresh', signal())).rejects.toThrow('provider_unavailable')
  })
  it('enforces deadlines even when fetch or a stream ignores the signal', async () => {
    const stuck: typeof fetch = () => new Promise(() => {})
    const client = createZoomClient(
      { clientId: 'client', clientSecret: 'secret', publicUrl: 'http://localhost:5173' },
      stuck,
    )
    await expect(client.refresh('refresh', AbortSignal.timeout(20))).rejects.toThrow(
      'provider_unavailable',
    )
    const p = fakeZoom()
    let cancelled = false
    p.controls.tokenHook = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
      )
    await expect(p.client.refresh('refresh', AbortSignal.timeout(20))).rejects.toThrow(
      'provider_unavailable',
    )
    await vi.waitFor(() => expect(cancelled).toBe(true))
  })
  it('does not invoke a request for an already-aborted operation', async () => {
    const p = fakeZoom()
    await expect(p.client.refresh('refresh', AbortSignal.abort())).rejects.toThrow(
      'provider_unavailable',
    )
    expect(p.calls).toHaveLength(0)
  })
  it('binds randomized ciphertext to purpose, owner, record and provider identity', () => {
    const key = conferenceEncryptionKey(TEST_CONFERENCE_KEY),
      aad = conferenceAad('connection-tokens', 'owner', 'record', 'identity')
    const a = encryptConferenceCredential(key, aad, 'synthetic-refresh'),
      b = encryptConferenceCredential(key, aad, 'synthetic-refresh')
    expect(a.equals(b)).toBe(false)
    expect(a.includes(Buffer.from('synthetic-refresh'))).toBe(false)
    expect(decryptConferenceCredential(key, aad, a)).toBe('synthetic-refresh')
    for (const other of [
      conferenceAad('oauth-state', 'owner', 'record', 'identity'),
      conferenceAad('connection-tokens', 'other', 'record', 'identity'),
      conferenceAad('connection-tokens', 'owner', 'other', 'identity'),
      conferenceAad('connection-tokens', 'owner', 'record', 'other'),
      aad.replace('zoom', 'google'),
    ])
      expect(() => decryptConferenceCredential(key, other, a)).toThrow('could not be decrypted')
    const corrupt = Buffer.from(a)
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 1
    expect(() => decryptConferenceCredential(key, aad, corrupt)).toThrow()
    expect(() => decryptConferenceCredential(Buffer.alloc(32, 20), aad, a)).toThrow()
    expect(() => conferenceEncryptionKey('not-a-key')).toThrow()
    expect(() => conferenceEncryptionKey(TEST_CONFERENCE_KEY.replace(/=$/, ''))).toThrow()
  })
})
