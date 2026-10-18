import { describe, expect, it } from 'vitest'
import { createGoogleCalendarClient } from './google.ts'

const config = {
  clientId: 'fake-client',
  clientSecret: 'fake-secret',
  publicUrl: 'http://localhost:5173',
}
describe('Google response boundary', () => {
  it('requests a separate grant instead of inheriting scopes from another consent', () => {
    const url = new URL(
      createGoogleCalendarClient(config).authorizationUrl('fake-state', 'fake-verifier'),
    )
    expect(url.searchParams.get('include_granted_scopes')).toBe('false')
  })

  it('rejects oversized valid JSON before accepting an otherwise valid identity', async () => {
    const client = createGoogleCalendarClient(config, async () =>
      Response.json({
        sub: 'account-1',
        email: 'calendar@example.com',
        email_verified: true,
        ignored: 'x'.repeat(262_144),
      }),
    )
    await expect(client.identity('fake-access', AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
  })

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

describe('Google events response boundary', () => {
  const signal = () => AbortSignal.timeout(1000)
  const window = { start: '2026-10-18T00:00:00Z', end: '2026-10-19T00:00:00Z' }

  it('refuses an invalid events-page time zone even when its events are empty', async () => {
    const client = createGoogleCalendarClient(config, async () =>
      Response.json({ items: [], timeZone: 'not/a-zone', nextSyncToken: 'next' }),
    )
    await expect(client.events('fake-access', 'calendar', window, signal())).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
  })

  it('refuses multiple events sharing the booking UID', async () => {
    const client = createGoogleCalendarClient(config, async () =>
      Response.json({
        items: [
          { id: 'event-1', iCalUID: 'booking@hourmere' },
          { id: 'event-2', iCalUID: 'booking@hourmere' },
        ],
      }),
    )
    await expect(
      client.findEvent('fake-access', 'calendar', 'booking@hourmere', signal()),
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
  })

  it.each([{ recurringEventId: 'series-1' }, { recurrence: ['RRULE:FREQ=DAILY'] }])(
    'refuses a recurring event sharing the booking UID: %j',
    async (recurrence) => {
      const client = createGoogleCalendarClient(config, async () =>
        Response.json({ items: [{ id: 'event-1', iCalUID: 'booking@hourmere', ...recurrence }] }),
      )
      await expect(
        client.findEvent('fake-access', 'calendar', 'booking@hourmere', signal()),
      ).rejects.toMatchObject({ code: 'provider_unavailable' })
    },
  )
})
