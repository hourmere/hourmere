import { describe, expect, it } from 'vitest'
import { createMicrosoftCalendarClient, MICROSOFT_CALENDAR_SCOPES } from './microsoft.ts'
import { fakeMicrosoft } from './testing.ts'

const config = {
  clientId: 'fake-client',
  clientSecret: 'fake-secret',
  publicUrl: 'http://localhost:5173',
}
const signal = () => AbortSignal.timeout(1000)

describe('Microsoft OAuth and Graph response boundary', () => {
  it('requests only list access with PKCE and a distinct calendar callback', () => {
    const url = new URL(
      createMicrosoftCalendarClient(config).authorizationUrl('fake-state', 'fake-verifier'),
    )
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    )
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:5173/api/calendar/microsoft/callback',
    )
    expect(url.searchParams.get('scope')).toBe(MICROSOFT_CALENDAR_SCOPES.join(' '))
    expect(url.searchParams.get('scope')).not.toMatch(/Calendars.ReadWrite|User.Read/)
    expect(url.searchParams.get('response_mode')).toBe('query')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('client_secret')).toBeNull()
    expect(() => createMicrosoftCalendarClient(config).authorizationUrl('s', 'v', 'sync')).toThrow()
  })

  it('sends secrets only in a token POST body, retaining a deadline and forbidding redirects', async () => {
    const fake = fakeMicrosoft()
    const deadline = signal()
    fake.controls.token.scope = 'openid email https://graph.microsoft.com/Calendars.ReadBasic'
    const tokens = await fake.client.exchange('fake-code', 'fake-verifier', deadline)
    expect(tokens.scopes).toEqual(['openid', 'email', 'Calendars.ReadBasic'])
    expect(fake.calls[0]?.url.href).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    )
    expect(fake.calls[0]?.init).toMatchObject({
      method: 'POST',
      signal: deadline,
      redirect: 'error',
    })
    const body = new URLSearchParams(String(fake.calls[0]?.init.body))
    expect(body.get('code')).toBe('fake-code')
    expect(body.get('code_verifier')).toBe('fake-verifier')
    expect(body.get('client_secret')).toBe('fake-microsoft-secret')
  })

  it.each([
    () => new Response('private-provider-echo', { status: 400 }),
    () => new Response('private-provider-echo', { status: 503 }),
    () => new Response('private-provider-echo'),
    () => Response.json({ access_token: 'private-provider-echo', token_type: 'wrong' }),
    () => new Response('x'.repeat(262_145)),
  ])('never exposes upstream error bodies, invalid tokens or oversized JSON', async (response) => {
    const error = await createMicrosoftCalendarClient(config, async () => response())
      .exchange('fake-code', 'fake-verifier', signal())
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toMatch(/private-provider-echo|fake-code|fake-verifier|fake-secret/)
    expect((error as Error).cause).toBeUndefined()
  })

  it('lists every page and handles missing email as display metadata only', async () => {
    const fake = fakeMicrosoft()
    delete fake.controls.identity.email
    expect(await fake.client.identity('fake-access', signal())).toEqual({
      id: 'microsoft-account-1',
      email: null,
    })
    fake.controls.pages[0]!['@odata.nextLink'] =
      'https://graph.microsoft.com/v1.0/me/calendars?$skiptoken=1'
    fake.controls.pages.push({ value: [{ id: 'readonly', name: 'Read only', canEdit: false }] })
    const calendars = await fake.client.calendars('fake-access', signal())
    expect(calendars).toMatchObject([
      { id: 'microsoft-calendar-1', isPrimary: true, accessRole: 'writer', timeZone: null },
      { id: 'readonly', isPrimary: false, accessRole: 'reader' },
    ])
    expect(fake.calls.filter((c) => c.url.pathname.endsWith('/calendars'))).toHaveLength(2)
  })

  it.each([
    'https://attacker.example/v1.0/me/calendars',
    'http://graph.microsoft.com/v1.0/me/calendars',
    'https://graph.microsoft.com/v1.0/me/messages',
    'https://user:password@graph.microsoft.com/v1.0/me/calendars',
    'https://graph.microsoft.com/v1.0/me/calendars#fragment',
    '/v1.0/me/calendars',
  ])('rejects unsafe paging URLs without sending a token there: %s', async (link) => {
    const fake = fakeMicrosoft()
    fake.controls.pages[0]!['@odata.nextLink'] = link
    await expect(fake.client.calendars('fake-access', signal())).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect(fake.calls).toHaveLength(1)
  })

  it.each(['loop', 'duplicate', 'too_many', 'too_many_pages'])(
    'refuses incomplete or ambiguous calendar lists: %s',
    async (kind) => {
      const fake = fakeMicrosoft()
      if (kind === 'duplicate')
        fake.controls.pages[0]!.value = [
          { id: 'same', name: 'one' },
          { id: 'same', name: 'two' },
        ]
      else
        fake.controls.pages = Array.from(
          { length: kind === 'too_many' ? 9 : kind === 'too_many_pages' ? 21 : 2 },
          (_, page) => ({
            value: Array.from({ length: kind === 'too_many' ? 250 : 1 }, (_, i) => ({
              id: `${page}-${i}`,
              name: 'Calendar',
            })),
            '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/calendars?$skiptoken=${kind === 'loop' ? 1 : page + 1}`,
          }),
        )
      await expect(fake.client.calendars('fake-access', signal())).rejects.toMatchObject({
        code: 'provider_unavailable',
      })
    },
  )
})
