import { createHmac } from 'node:crypto'
import { createDb } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createConfiguredSmsInbound } from './sms.ts'

const url = 'https://example.test/api/sms/twilio'
const token = 'synthetic-auth-token'
const account = `AC${'1'.repeat(32)}`
describe.skipIf(!process.env.DATABASE_URL)('SMS inbound HTTP transport', () => {
  it('mounts configured callback, bounds bodies, rejects signatures and keeps logs private', async () => {
    const owned = await createTestDatabase(process.env.DATABASE_URL as string)
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const config = loadConfig({
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: 'a'.repeat(32),
        PUBLIC_URL: 'https://example.test',
        SMS_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: account,
        TWILIO_AUTH_TOKEN: token,
        TWILIO_FROM: '+14155550124',
        SMS_HASH_KEY: Buffer.alloc(32, 3).toString('base64'),
      })
      const app = createApp({
        publicUrl: config.PUBLIC_URL,
        checkDb: async () => {},
        resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
        authHandler: async () => new Response(),
        smsInbound: createConfiguredSmsInbound(config, createDb(owned.pool)),
      })
      const params = new URLSearchParams({
        AccountSid: account,
        From: '+14155550123',
        To: '+14155550124',
        MessageSid: `SM${'2'.repeat(32)}`,
        Body: 'STOP',
      })
      const signature = createHmac('sha1', token)
        .update(
          url +
            [...params.keys()]
              .sort()
              .map((k) => k + params.get(k))
              .join(''),
        )
        .digest('base64')
      const headers = {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      }
      expect((await app.request(url, { method: 'POST', headers, body: params })).status).toBe(200)
      expect(
        (
          await app.request(url, {
            method: 'POST',
            headers: { ...headers, 'x-twilio-signature': 'bad' },
            body: params,
          })
        ).status,
      ).toBe(403)
      expect(
        (await app.request(`${url}?From=%2B14155550123`, { method: 'POST', headers, body: params }))
          .status,
      ).toBe(400)
      expect(
        (await app.request(url, { method: 'POST', headers, body: 'x'.repeat(17000) })).status,
      ).toBe(413)
      const output = JSON.stringify(logs.mock.calls)
      for (const privateValue of ['14155550123', token, signature])
        expect(output).not.toContain(privateValue)
      expect((await owned.pool.query('SELECT * FROM sms_suppressions')).rows).toHaveLength(1)
      expect(
        createConfiguredSmsInbound(
          loadConfig({ DATABASE_URL: owned.url, BETTER_AUTH_SECRET: 'a'.repeat(32) }),
          createDb(owned.pool),
        ),
      ).toBeUndefined()
    } finally {
      logs.mockRestore()
      await owned.drop()
    }
  })
})
