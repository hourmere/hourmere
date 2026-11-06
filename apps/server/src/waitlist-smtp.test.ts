import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Db } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { publicRoutes } from './routes/public.ts'

async function routeCopy() {
  const url = new URL('./routes/public.ts', import.meta.url)
  const anchor =
    "if (!smtpConfigured) return c.json({ error: 'waitlist_smtp_not_configured' }, 409)"
  let source = readFileSync(url, 'utf8')
  expect(source).toContain(anchor)
  source = stripTypeScriptTypes(source.replace(anchor, '')).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, url).href : specifier.startsWith('node:') ? specifier : import.meta.resolve(specifier)}'`,
  )
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`))
    .publicRoutes as typeof publicRoutes
}
async function assertSmtp(routes: typeof publicRoutes) {
  const app = createApp({
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
    publicUrl: 'http://localhost',
    routes: [routes({ db: {} as Db, waitlistSecret: 'synthetic-secret', smtpConfigured: false })],
  })
  for (const prefix of ['/api/v1/public/host/intro', '/api/v1/public/teams/team/intro']) {
    for (const suffix of ['', '/resend']) {
      const response = await app.request(`${prefix}/waitlist${suffix}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'invitee@example.test',
          ...(!suffix && {
            consent: true,
            preferredWindow: {
              start: '2027-01-01T00:00:00Z',
              end: '2027-01-02T00:00:00Z',
              timeZone: 'UTC',
            },
          }),
        }),
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'waitlist_smtp_not_configured' })
    }
  }
}
describe('waitlist SMTP capability', () => {
  it('refuses personal and team join and resend without SMTP', async () => assertSmtp(publicRoutes))
  it('detects omission of the SMTP guard in a source copy', async () => {
    await expect(assertSmtp(await routeCopy())).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
