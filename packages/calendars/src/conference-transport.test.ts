import { describe, expect, it } from 'vitest'
import { createGoogleCalendarClient } from './google.ts'
import { googleMeetUrl } from './google-events.ts'

const config = {
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-secret',
  publicUrl: 'http://localhost:5173',
}
describe('conference transport boundaries', () => {
  it.each(['.', '..', 'a/b', '%2e%2e', 'a?query', 'a#fragment', 'a'.repeat(1025)])(
    'rejects non-segment external event IDs before any request',
    async (id) => {
      let calls = 0
      const client = createGoogleCalendarClient(config, async () => {
        calls++
        return Response.json({})
      })
      await expect(
        client.getConferenceEvent('synthetic-token', 'calendar', id, AbortSignal.timeout(1000)),
      ).rejects.toMatchObject({ code: 'provider_unavailable' })
      expect(calls).toBe(0)
    },
  )
  it.each([
    'http://meet.google.com/abc-defg-hij',
    'https://meet.google.com.evil.example/abc-defg-hij',
    'https://meet.google.com/abc-defg-hij?auth=secret',
    'https://user@meet.google.com/abc-defg-hij',
    'https://meet.google.com/../abc-defg-hij',
    'javascript:alert(1)',
    'https://meet.google.com/abc-defg-hij#secret',
  ])('refuses untrusted or credential-bearing join links', (value) => {
    expect(googleMeetUrl(value)).toBeUndefined()
  })
  it('accepts only the expected HTTPS video entry point form', () => {
    expect(googleMeetUrl('https://meet.google.com/abc-defg-hij')).toBe(
      'https://meet.google.com/abc-defg-hij',
    )
  })
  it('keeps fixed host, bounded fields, no redirect and no body echo on provider rejection', async () => {
    let seen: URL | undefined, init: RequestInit | undefined
    const client = createGoogleCalendarClient(config, async (input, options) => {
      seen = new URL(String(input))
      init = options
      return new Response('private-upstream-meeting-data', { status: 403 })
    })
    const error = await client
      .getConferenceEvent(
        'synthetic-token',
        'calendar@example.com',
        'safe-id',
        AbortSignal.timeout(1000),
      )
      .catch((e) => e)
    expect(seen?.origin).toBe('https://www.googleapis.com')
    expect(seen?.searchParams.get('fields')).toContain('conferenceData')
    expect(seen?.searchParams.get('fields')).not.toMatch(/description|attendees|summary/)
    expect(init?.redirect).toBe('error')
    expect(String(error)).not.toContain('private-upstream')
    expect(error).toMatchObject({ code: 'permissions_missing' })
  })
})
