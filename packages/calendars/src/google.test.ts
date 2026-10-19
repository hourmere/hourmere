import { describe, expect, it } from 'vitest'
import { createGoogleCalendarClient } from './google.ts'

const config = {
  clientId: 'fake-client',
  clientSecret: 'fake-secret',
  publicUrl: 'http://localhost:5173',
}
describe('Google response boundary', () => {
  it.each([
    {
      access: 'list' as const,
      scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'],
    },
    {
      access: 'sync' as const,
      scopes: [
        'openid',
        'email',
        'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
        'https://www.googleapis.com/auth/calendar.events.readonly',
        'https://www.googleapis.com/auth/calendar.events.owned',
      ],
    },
  ])(
    'preserves the independent $access grant and offline calendar authorization',
    ({ access, scopes }) => {
      const url = new URL(
        createGoogleCalendarClient(config).authorizationUrl('fake-state', 'fake-verifier', access),
      )
      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
      expect(url.searchParams.get('scope')?.split(/\s+/).sort()).toEqual([...scopes].sort())
      expect(url.searchParams.get('include_granted_scopes')).toBe('false')
      expect(url.searchParams.get('access_type')).toBe('offline')
      expect(url.searchParams.get('prompt')).toBe('consent')
      expect(url.searchParams.get('client_id')).toBe(config.clientId)
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:5173/api/calendar/google/callback',
      )
      expect(url.searchParams.get('response_type')).toBe('code')
      expect(url.searchParams.get('state')).toBe('fake-state')
      expect(url.searchParams.get('code_challenge')).toBe(
        'ulA2Yl9LlxIZqoV-8flS7dbAIUnmr3XfT6kZBh5rsyQ',
      )
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    },
  )

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
