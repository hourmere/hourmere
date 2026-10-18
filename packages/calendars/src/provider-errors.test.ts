import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createGoogleCalendarClient } from './google.ts'
import { createMicrosoftCalendarClient } from './microsoft.ts'

const config = {
  clientId: 'fake-client',
  clientSecret: 'fake-secret',
  publicUrl: 'http://localhost:5173',
}

describe.each([
  ['Google', createGoogleCalendarClient],
  ['Microsoft', createMicrosoftCalendarClient],
] as const)('%s OAuth token errors', (_provider, createClient) => {
  it.each([
    [400, 'invalid_grant', 'needs_reauth'],
    [401, 'invalid_grant', 'needs_reauth'],
    [400, 'invalid_client', 'provider_unavailable'],
    [401, 'invalid_client', 'provider_unavailable'],
    [400, 'unauthorized_client', 'provider_unavailable'],
    [401, 'unauthorized_client', 'provider_unavailable'],
    [400, 'invalid_request', 'provider_unavailable'],
    [403, 'invalid_grant', 'provider_unavailable'],
    [503, 'invalid_grant', 'provider_unavailable'],
    [
      400,
      'interaction_required',
      _provider === 'Microsoft' ? 'needs_reauth' : 'provider_unavailable',
    ],
    [
      401,
      'interaction_required',
      _provider === 'Microsoft' ? 'needs_reauth' : 'provider_unavailable',
    ],
    [400, 'consent_required', _provider === 'Microsoft' ? 'needs_reauth' : 'provider_unavailable'],
    [401, 'consent_required', _provider === 'Microsoft' ? 'needs_reauth' : 'provider_unavailable'],
    [503, 'interaction_required', 'provider_unavailable'],
    [503, 'consent_required', 'provider_unavailable'],
  ])('classifies HTTP %i %s as %s with a safe operator diagnostic', async (status, error, code) => {
    const client = createClient(config, async () =>
      Response.json(
        { error, error_description: 'private-provider-echo fake-secret fake-refresh' },
        { status },
      ),
    )
    const failure = await client
      .refresh('fake-refresh', AbortSignal.timeout(1000))
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code, status, oauthError: error })
    expect(String(failure)).toBe(`${_provider}CalendarError: ${code} (${error})`)
    expect(inspect(failure)).not.toMatch(/private-provider-echo|fake-secret|fake-refresh/)
    expect((failure as Error).cause).toBeUndefined()
  })

  it.each([
    ['unknown', { error: 'private-provider-echo' }],
    ['suffix', { error: 'invalid_grant private-provider-echo' }],
    ['object', { error: { code: 'invalid_grant' } }],
    ['description only', { error_description: 'invalid_grant private-provider-echo' }],
    [
      'oversized',
      { error: 'invalid_grant', error_description: 'private-provider-echo'.repeat(300) },
    ],
  ])('keeps unknown, malformed and oversized token errors retryable: %s', async (_kind, body) => {
    const client = createClient(config, async () => Response.json(body, { status: 400 }))
    const failure = await client
      .refresh('fake-refresh', AbortSignal.timeout(1000))
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'provider_unavailable', oauthError: undefined })
    expect(inspect(failure)).not.toContain('private-provider-echo')
  })

  it('keeps a resource 401 distinct from a token endpoint configuration failure', async () => {
    const client = createClient(config, async () =>
      Response.json(
        { error: 'invalid_client', error_description: 'private-provider-echo' },
        { status: 401 },
      ),
    )
    const failure = await client
      .calendars('fake-access', AbortSignal.timeout(1000))
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'needs_reauth', oauthError: undefined })
    expect(inspect(failure)).not.toMatch(/invalid_client|private-provider-echo/)
  })
})

describe('Google resource error classification', () => {
  for (const endpoint of ['calendar list', 'events'] as const) {
    it.each([
      [401, 'authError', 'needs_reauth'],
      [403, 'insufficientPermissions', 'permissions_missing'],
      [403, 'rateLimitExceeded', 'provider_unavailable'],
      [403, 'userRateLimitExceeded', 'provider_unavailable'],
      [403, 'quotaExceeded', 'provider_unavailable'],
      [429, 'rateLimitExceeded', 'provider_unavailable'],
      [503, 'backendError', 'provider_unavailable'],
    ])(
      `${endpoint} HTTP %i %s becomes %s without upstream details`,
      async (status, reason, code) => {
        const client = createGoogleCalendarClient(config, async () =>
          Response.json(
            { error: { errors: [{ reason }], message: 'private-provider-echo fake-access' } },
            { status },
          ),
        )
        const signal = AbortSignal.timeout(1000)
        const failure = await (endpoint === 'calendar list'
          ? client.calendars('fake-access', signal)
          : client.findEvent('fake-access', 'calendar', 'booking@hourmere', signal)
        ).catch((error: unknown) => error)
        expect(failure).toMatchObject({ code, status, oauthError: undefined })
        expect(inspect(failure)).not.toMatch(/private-provider-echo|fake-access/)
        expect((failure as Error).cause).toBeUndefined()
      },
    )
  }

  it('bounds resource error JSON before trusting a retryable usage-limit reason', async () => {
    const client = createGoogleCalendarClient(config, async () =>
      Response.json(
        {
          error: { errors: [{ reason: 'rateLimitExceeded' }] },
          ignored: 'x'.repeat(262_144),
        },
        { status: 403 },
      ),
    )
    await expect(client.calendars('fake-access', AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'permissions_missing',
      status: 403,
      oauthError: undefined,
    })
  })

  it('recognizes a retryable usage limit among other error reasons', async () => {
    const client = createGoogleCalendarClient(config, async () =>
      Response.json(
        { error: { errors: [{ reason: 'forbidden' }, { reason: 'quotaExceeded' }] } },
        { status: 403 },
      ),
    )
    await expect(client.calendars('fake-access', AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'provider_unavailable',
      status: 403,
    })
  })
})
