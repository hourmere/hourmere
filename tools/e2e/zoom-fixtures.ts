import { createHmac, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { createConnection, createServer as createProbe } from 'node:net'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from '../../apps/server/src/app.ts'
import { productRoutes } from '../../apps/server/src/server.ts'
import { closeServer } from '../../apps/server/src/shutdown.ts'
import { createAuth, createAuthPool, createCallerResolver } from '../../packages/auth/src/index.ts'
import { fakeZoom, TEST_CONFERENCE_KEY } from '../../packages/conferences/src/testing.ts'
import { createDb, createPool } from '../../packages/db/src/index.ts'
import { createTestDatabase } from '../../packages/db/src/testing.ts'
import { createFixtures } from '../../packages/scheduling/src/testing.ts'
import { test as base, expect } from './fixtures.ts'

interface ZoomApp {
  url: string
  setScopeFailure: () => void
  restoreScope: () => void
  disconnectForeign: () => Promise<number>
  apiKeyListStatus: () => Promise<number>
  state: () => Promise<{
    connections: number
    active: number
    disconnected: number
    secrets: number
    attempts: number
    calendars: number
    identityLiteral: boolean
    meetingConnections: number
    identityConnections: number
  }>
}
export const test = base.extend<{
  zoomApp: ZoomApp
  zoomEnabled: boolean
  zoomMeetingsEnabled: boolean
}>({
  zoomEnabled: [true, { option: true }],
  zoomMeetingsEnabled: [false, { option: true }],
  zoomApp: async ({ context, zoomEnabled, zoomMeetingsEnabled }, use) => {
    const bootstrap = process.env.HOURMERE_E2E_BOOTSTRAP_URL
    if (!bootstrap)
      throw new Error('HOURMERE_E2E_BOOTSTRAP_URL must bootstrap helper-owned scratch databases')
    const owned = await createTestDatabase(bootstrap)
    let server: Server | undefined,
      authPool: ReturnType<typeof createAuthPool> | undefined,
      port: number | undefined,
      externalRequests = 0,
      mailCalls = 0
    try {
      const probe = createProbe()
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', resolve)
      })
      const address = probe.address()
      if (!address || typeof address === 'string' || [3000, 3998].includes(address.port))
        throw new Error('Invalid owned listener')
      port = address.port
      await new Promise<void>((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
      )
      const url = `http://127.0.0.1:${port}`,
        db = createDb(owned.pool),
        f = createFixtures(db)
      const host = await f.host({
        handle: 'zoom-fixture',
        name: 'Synthetic Zoom Host',
        timeZone: 'UTC',
      })
      await f.schedule(host.userId, { timeZone: 'UTC' })
      await f.eventType(host.organizationId, host.userId, { slug: 'call', title: 'Synthetic call' })
      const other = await f.host({ handle: null, name: 'Synthetic Other Host' })
      const signup = { mode: 'closed', allowedDomains: [] } as const,
        secret = randomBytes(32).toString('base64')
      authPool = createAuthPool(owned.url, signup)
      const auth = createAuth({
        pool: authPool,
        db,
        baseURL: url,
        secret,
        signup,
        mailer: {
          send: async () => {
            mailCalls++
            throw new Error('No mail delivery in Zoom fixtures')
          },
        },
      })
      async function session(userId: string, organizationId: string) {
        const token = randomBytes(24).toString('base64url')
        await db
          .insertInto('auth.session')
          .values({
            userId,
            activeOrganizationId: organizationId,
            token,
            updatedAt: new Date(),
            expiresAt: new Date(Date.now() + 3600000),
          })
          .execute()
        return encodeURIComponent(
          `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`,
        )
      }
      const cookie = await session(host.userId, host.organizationId),
        otherCookie = await session(other.userId, other.organizationId),
        provider = fakeZoom(url)
      const app = createApp({
        publicUrl: url,
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        webDist: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
        routes: productRoutes({
          db,
          publicUrl: url,
          socialProviders: {},
          ...(zoomEnabled && {
            zoomConference: {
              client: provider.client,
              encryptionKey: TEST_CONFERENCE_KEY,
              meetingsEnabled: zoomMeetingsEnabled,
            },
          }),
        }),
      })
      server = await new Promise<Server>((resolve, reject) => {
        const running = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () =>
          resolve(running as Server),
        )
        running.once('error', reject)
      })
      await context.addCookies([
        { name: 'better-auth.session_token', value: cookie, url, httpOnly: true, sameSite: 'Lax' },
      ])
      await context.route('**/*', async (route) => {
        const target = new URL(route.request().url())
        if (target.origin === url) return route.continue()
        if (target.origin === 'https://zoom.us' && target.pathname === '/oauth/authorize') {
          provider.controls.token.scope = target.searchParams.get('scope')
          const callback = new URL('/api/conference/zoom/callback', url)
          callback.search = new URLSearchParams({
            state: target.searchParams.get('state') ?? '',
            code: 'synthetic-browser-code',
          }).toString()
          return route.fulfill({
            status: 302,
            headers: {
              Location: callback.href,
              'Referrer-Policy': 'no-referrer',
              'Cache-Control': 'no-store',
            },
            body: '',
          })
        }
        externalRequests++
        await route.abort('blockedbyclient')
      })
      await use({
        url,
        setScopeFailure: () => {
          provider.controls.token.scope = 'user:read:user meeting:write:meeting'
          provider.controls.token.refresh_token = 'synthetic-rotated-browser-token'
        },
        restoreScope: () => {
          provider.controls.token.scope = 'user:read:user'
        },
        disconnectForeign: async () => {
          const row = await db
            .selectFrom('conference_connections')
            .select('id')
            .where('user_id', '=', host.userId)
            .executeTakeFirstOrThrow()
          const response = await app.request(`/api/v1/conference-connections/${row.id}`, {
            method: 'DELETE',
            headers: {
              cookie: `better-auth.session_token=${otherCookie}`,
              origin: url,
              'content-type': 'application/json',
            },
            body: '{}',
          })
          return response.status
        },
        apiKeyListStatus: async () => {
          const key = await auth.api.createApiKey({
            body: { userId: host.userId, name: 'synthetic-conference-isolation' },
          })
          const response = await app.request('/api/v1/conference-connections', {
            headers: { authorization: `Bearer ${key.key}` },
          })
          return response.status
        },
        state: async () => {
          const rows = await db
            .selectFrom('conference_connections')
            .select(['status', 'credentials', 'display_name', 'mode'])
            .where('user_id', '=', host.userId)
            .execute()
          return {
            connections: rows.length,
            active: rows.filter((r) => r.status === 'active').length,
            disconnected: rows.filter((r) => r.status === 'disconnected').length,
            secrets: rows.filter((r) => r.credentials !== null).length,
            attempts: (
              await db.selectFrom('conference_oauth_states').select('state_hash').execute()
            ).length,
            calendars: (await db.selectFrom('calendar_connections').select('id').execute()).length,
            identityLiteral: rows.every((r) => r.display_name === 'Settings'),
            meetingConnections: rows.filter(
              (r) => r.mode === 'meetings' && r.status !== 'disconnected',
            ).length,
            identityConnections: rows.filter(
              (r) => r.mode === 'identity' && r.status !== 'disconnected',
            ).length,
          }
        },
      })
      expect(
        externalRequests,
        'Only owned loopback requests and an intercepted OAuth navigation are allowed',
      ).toBe(0)
      expect(mailCalls, 'Conference identity does not send mail').toBe(0)
    } finally {
      try {
        if (server) await closeServer(server)
      } finally {
        try {
          await authPool?.end()
        } finally {
          await owned.drop()
          const check = createPool(owned.url)
          try {
            let absent = false
            try {
              await check.query('SELECT 1')
            } catch (error) {
              absent = (error as { code?: string }).code === '3D000'
            }
            expect(absent, 'Owned Zoom database must be absent').toBe(true)
          } finally {
            await check.end()
          }
          if (port) {
            const listenerPort = port
            const closed = await new Promise<boolean>((resolve) => {
              const socket = createConnection({ host: '127.0.0.1', port: listenerPort })
              socket.once('connect', () => {
                socket.destroy()
                resolve(false)
              })
              socket.once('error', (error) =>
                resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'),
              )
              socket.setTimeout(1000, () => {
                socket.destroy()
                resolve(false)
              })
            })
            expect(closed, 'Owned Zoom listener must be closed').toBe(true)
          }
          console.log('Zoom fixture cleanup verified: database absent, owned listener closed')
        }
      }
    }
  },
})
export { expect }
