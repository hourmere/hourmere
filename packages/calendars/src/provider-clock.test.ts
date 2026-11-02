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
] as const)('%s token expiry clock', (_provider, createClient) => {
  it.each(['exchange', 'refresh'] as const)(
    'uses the current injected clock after each %s response',
    async (operation) => {
      let now = Date.parse('2000-01-01T12:00:00Z')
      const client = createClient(
        config,
        async () => {
          now += 30_000
          return Response.json({
            access_token: 'fake-access',
            refresh_token: 'fake-refresh',
            token_type: 'Bearer',
            expires_in: 3600,
          })
        },
        () => now,
      )
      const tokens = () => {
        const signal = AbortSignal.timeout(1000)
        return operation === 'exchange'
          ? client.exchange('fake-code', 'fake-verifier', signal)
          : client.refresh('fake-refresh', signal)
      }
      expect((await tokens()).expiresAt).toBe(now + 3_600_000)
      now += 4 * 3_600_000
      expect((await tokens()).expiresAt).toBe(now + 3_600_000)
    },
  )
})
