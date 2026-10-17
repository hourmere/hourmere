import { describe, expect, it } from 'vitest'
import { createGoogleCalendarClient } from './google.ts'

const config = {
  clientId: 'fake-client',
  clientSecret: 'fake-secret',
  publicUrl: 'http://localhost:5173',
}
describe('Google response boundary', () => {
  it.each([
    () => new Response('fake-secret-echo', { status: 400 }),
    () => new Response('fake-secret-echo', { status: 503 }),
    () => new Response('not-json-fake-secret'),
    () => Response.json({ access_token: 'fake-secret', token_type: 'wrong' }),
    () => new Response('x'.repeat(262_145)),
  ])(
    'never exposes an upstream error body, malformed token or oversized response',
    async (response) => {
      const client = createGoogleCalendarClient(config, async () => response())
      const error = await client
        .exchange('fake-code', 'fake-verifier', AbortSignal.timeout(1000))
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toMatch(/fake-secret|fake-code|fake-verifier|not-json/)
      expect((error as Error).cause).toBeUndefined()
    },
  )

  it('sends credentials in the token POST body, with a deadline and no redirect following', async () => {
    let seen: RequestInit | undefined
    let endpoint = ''
    const signal = AbortSignal.timeout(1000)
    const client = createGoogleCalendarClient(config, async (input, init) => {
      endpoint = String(input)
      seen = init
      return new Response(null, { status: 503 })
    })
    await expect(client.exchange('fake-code', 'fake-verifier', signal)).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect(endpoint).toBe('https://oauth2.googleapis.com/token')
    expect(seen).toMatchObject({ method: 'POST', signal, redirect: 'error' })
    expect(new URLSearchParams(String(seen?.body)).get('code_verifier')).toBe('fake-verifier')
  })
})
