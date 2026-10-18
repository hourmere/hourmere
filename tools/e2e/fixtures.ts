import { randomBytes } from 'node:crypto'
import { createServer as createHttpServer, type Server } from 'node:http'
import {
  createConnection,
  createServer as createProbe,
  type Server as SocketServer,
} from 'node:net'
import { fileURLToPath } from 'node:url'
import { test as base, expect, type FrameLocator, type Locator, type Page } from '@playwright/test'
import { type RunningServer, startServer } from '../../apps/server/src/server.ts'
import { createAuth, createAuthPool } from '../../packages/auth/src/index.ts'
import { createDb, createPool } from '../../packages/db/src/index.ts'
import { createTestDatabase } from '../../packages/db/src/testing.ts'
import { createFixtures } from '../../packages/scheduling/src/testing.ts'

async function listenLoopback(server: SocketServer): Promise<number> {
  while (true) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port')
    if (![3000, 3998].includes(address.port)) return address.port
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

interface FixtureApp {
  url: string
  parentUrl: string
  personalPath: string
  teamPath: string
  collectivePath: string
  roundRobinPath: string
  roundRobinState: (slug?: string) => Promise<{ sequence: string; assignedNames: string[] }>
  hostCounts: () => Promise<number[]>
  rows: () => Promise<{ source: string; status: string }[]>
  authorizeHost: (teamRole?: 'owner' | 'member') => Promise<void>
  bookingState: () => Promise<{
    total: number
    roots: number
    successors: number
    bookerLocales: (string | null)[]
    fingerprints: number
    originalFingerprintPreserved: boolean
  }>
}
export const test = base.extend<{ app: FixtureApp; suppressFailureDom: undefined }>({
  suppressFailureDom: [
    async ({ context }, use, testInfo) => {
      // Depending on context runs this teardown before its artifact finalization.
      void context
      try {
        await use(undefined)
      } finally {
        // Pinned Playwright attaches locator snapshots before its fallback-capture switch.
        // Keep the assertion, message and stack; discard only its private DOM diagnostic.
        for (const error of testInfo.errors) Reflect.deleteProperty(error, 'errorContext')
      }
    },
    { auto: true },
  ],
  app: async ({ context }, use) => {
    const bootstrap = process.env.HOURMERE_E2E_BOOTSTRAP_URL
    if (!bootstrap)
      throw new Error(
        'Set HOURMERE_E2E_BOOTSTRAP_URL for helper-owned throwaway databases; no DATABASE_URL fallback is used',
      )
    const owned = await createTestDatabase(bootstrap)
    let app: RunningServer | undefined, parent: Server | undefined
    let authPool: ReturnType<typeof createAuthPool> | undefined
    const ownedPorts: number[] = []
    try {
      const probe = createProbe()
      const port = await listenLoopback(probe)
      ownedPorts.push(port)
      await new Promise<void>((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
      )
      const url = `http://127.0.0.1:${port}`,
        db = createDb(owned.pool),
        f = createFixtures(db),
        host = await f.host({ handle: 'fixture-host', name: 'Fixture Host', timeZone: 'UTC' })
      await f.schedule(host.userId, { timeZone: 'UTC' })
      await f.eventType(host.organizationId, host.userId, {
        title: 'Fixture call',
        slug: 'call',
        allowGuests: false,
        minimumNoticeMinutes: 30,
      })
      const team = await f.organization('FixtureTeam')
      await f.member(host.userId, team, 'owner')
      await f.eventType(team, null, {
        title: 'Team fixture call',
        slug: 'call',
        allowGuests: false,
        minimumNoticeMinutes: 30,
        hosts: [{ userId: host.userId }],
      })
      const secondHost = await f.host({
        handle: null,
        name: 'Second Required Host',
        timeZone: 'UTC',
      })
      await f.schedule(secondHost.userId, { timeZone: 'UTC' })
      await f.member(secondHost.userId, team)
      const collectiveId = await f.eventType(team, null, {
        title: 'Collective fixture call',
        slug: 'collective',
        minimumNoticeMinutes: 30,
        hosts: [{ userId: host.userId }, { userId: secondHost.userId }],
      })
      await db
        .updateTable('event_types')
        .set({ scheduling_type: 'collective' })
        .where('id', '=', collectiveId)
        .execute()
      const roundId = await f.eventType(team, null, {
        title: 'Round-robin fixture call',
        slug: 'round',
        minimumNoticeMinutes: 30,
        hosts: [{ userId: host.userId }, { userId: secondHost.userId }],
      })
      await db
        .updateTable('event_types')
        .set({ scheduling_type: 'round_robin' })
        .where('id', '=', roundId)
        .execute()
      await db
        .insertInto('round_robin_state')
        .values({ event_type_id: roundId, enabled: true })
        .execute()
      parent = createHttpServer((request, response) => {
        const language = new URL(request.url ?? '/', 'http://localhost').searchParams.get(
          'language',
        )
        const languageAttribute =
          language === 'en' || language === 'zh-CN' ? ` data-hourmere-language="${language}"` : ''
        response.setHeader('Cache-Control', 'no-store')
        if (request.url === '/parent.js') {
          response.setHeader('Content-Type', 'application/javascript')
          response.end(
            `window.fixtureMessages=[];window.addEventListener('message',e=>{if(e.origin===${JSON.stringify(url)})window.fixtureMessages.push(e.data)});`,
          )
          return
        }
        const bookingPath =
          new URL(request.url ?? '/', 'http://localhost').pathname === '/collective'
            ? '/team/FixtureTeam/collective'
            : new URL(request.url ?? '/', 'http://localhost').pathname === '/round'
              ? '/team/FixtureTeam/round'
              : '/fixture-host/call'
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(
          `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture website</title><button type="button" data-hourmere-popup${languageAttribute} data-hourmere-url="${url}${bookingPath}">Book a meeting</button><div data-hourmere-inline${languageAttribute} data-hourmere-url="${url}${bookingPath}"></div><script src="/parent.js" defer></script><script src="${url}/hourmere-embed.js" defer></script>`,
        )
      })
      const parentPort = await listenLoopback(parent)
      ownedPorts.push(parentPort)
      const parentUrl = `http://127.0.0.1:${parentPort}`
      const authSecret = randomBytes(32).toString('base64')
      app = await startServer({
        DATABASE_URL: owned.url,
        PORT: String(port),
        PUBLIC_URL: url,
        BETTER_AUTH_SECRET: authSecret,
        SIGNUP: 'closed',
        HOURMERE_ROLE: 'web',
        EMBED_ALLOWED_ORIGINS: parentUrl,
        WEB_DIST:
          process.env.HOURMERE_E2E_WEB_DIST ??
          fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
      })
      let externalRequests = 0
      let authorization: string | undefined
      await context.route('**/*', async (route) => {
        const requestUrl = new URL(route.request().url())
        const origin = requestUrl.origin
        if (origin === url || origin === parentUrl)
          await route.continue({
            ...(authorization &&
              origin === url &&
              requestUrl.pathname.startsWith('/api/v1/') &&
              !requestUrl.pathname.startsWith('/api/v1/public/') &&
              !requestUrl.pathname.startsWith('/api/v1/bookings/manage') && {
                headers: { ...route.request().headers(), authorization },
              }),
          })
        else {
          externalRequests++
          await route.abort('blockedbyclient')
        }
      })
      const firstFingerprints = new Map<string, Buffer>()
      await use({
        url,
        parentUrl,
        personalPath: '/fixture-host/call',
        teamPath: '/team/FixtureTeam/call',
        collectivePath: '/team/FixtureTeam/collective',
        roundRobinPath: '/team/FixtureTeam/round',
        roundRobinState: async (slug = 'round') => {
          const state = await db
            .selectFrom('round_robin_state as r')
            .innerJoin('event_types as e', 'e.id', 'r.event_type_id')
            .select('r.next_sequence')
            .where('e.organization_id', '=', team)
            .where('e.slug', '=', slug)
            .executeTakeFirstOrThrow()
          const assigned = await db
            .selectFrom('bookings as b')
            .innerJoin('event_types as e', 'e.id', 'b.event_type_id')
            .innerJoin('booking_hosts as h', 'h.booking_id', 'b.id')
            .innerJoin('auth.user as u', 'u.id', 'h.user_id')
            .select('u.name')
            .where('e.organization_id', '=', team)
            .where('e.slug', '=', slug)
            .orderBy('b.created_at')
            .orderBy('b.id')
            .execute()
          return { sequence: state.next_sequence, assignedNames: assigned.map((h) => h.name) }
        },
        hostCounts: async () => {
          const bookings = await db
            .selectFrom('bookings')
            .select('id')
            .orderBy('created_at')
            .execute()
          return Promise.all(
            bookings.map(
              async (booking) =>
                (
                  await db
                    .selectFrom('booking_hosts')
                    .select('user_id')
                    .where('booking_id', '=', booking.id)
                    .execute()
                ).length,
            ),
          )
        },
        authorizeHost: async (teamRole) => {
          const signup = { mode: 'closed', allowedDomains: [] } as const
          authPool ??= createAuthPool(owned.url, signup)
          if (teamRole)
            await db
              .updateTable('auth.member')
              .set({ role: teamRole })
              .where('organizationId', '=', team)
              .where('userId', '=', host.userId)
              .execute()
          const auth = createAuth({
            pool: authPool,
            db,
            baseURL: url,
            secret: authSecret,
            signup,
            mailer: {
              send: async () => {
                throw new Error('No mail delivery in browser fixtures')
              },
            },
          })
          const key = await auth.api.createApiKey({
            body: {
              userId: host.userId,
              name: 'synthetic-browser-fixture',
              ...(teamRole && { metadata: { organizationId: team } }),
            },
          })
          // Keep the synthetic credential in this process; only owned product API calls receive it.
          authorization = `Bearer ${key.key}`
        },
        bookingState: async () => {
          const rows = await db
            .selectFrom('bookings')
            .select(['id', 'rescheduled_from_id', 'idempotency_fingerprint'])
            .execute()
          let originalFingerprintPreserved = true
          for (const row of rows) {
            if (!row.idempotency_fingerprint) continue
            const first = firstFingerprints.get(row.id)
            if (first) originalFingerprintPreserved &&= first.equals(row.idempotency_fingerprint)
            else firstFingerprints.set(row.id, Buffer.from(row.idempotency_fingerprint))
          }
          const attendees = await db
            .selectFrom('booking_attendees')
            .select('locale')
            .where('is_booker', '=', true)
            .execute()
          return {
            total: rows.length,
            roots: rows.filter((row) => row.rescheduled_from_id === null).length,
            successors: rows.filter((row) => row.rescheduled_from_id !== null).length,
            fingerprints: rows.filter((row) => row.idempotency_fingerprint !== null).length,
            originalFingerprintPreserved,
            bookerLocales: attendees.map((row) => row.locale),
          }
        },
        rows: () =>
          db.selectFrom('bookings').select(['source', 'status']).orderBy('created_at').execute(),
      })
      expect(externalRequests, 'No external browser request is permitted').toBe(0)
    } finally {
      try {
        try {
          if (parent?.listening) {
            parent.closeAllConnections()
            await new Promise<void>((resolve, reject) =>
              parent?.close((error) => (error ? reject(error) : resolve())),
            )
          }
        } finally {
          await app?.close()
        }
      } finally {
        try {
          await authPool?.end()
        } finally {
          await owned.drop()
          const verification = createPool(owned.url)
          try {
            let absent = false
            try {
              await verification.query('SELECT 1')
            } catch (error) {
              absent = (error as { code?: string }).code === '3D000'
            }
            expect(absent, 'The helper-owned database must no longer exist').toBe(true)
          } finally {
            await verification.end()
          }
          for (const port of ownedPorts) {
            const closed = await new Promise<boolean>((resolve) => {
              const socket = createConnection({ host: '127.0.0.1', port })
              socket.once('connect', () => {
                socket.destroy()
                resolve(false)
              })
              socket.once('error', (error) => {
                resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED')
              })
              socket.setTimeout(1000, () => {
                socket.destroy()
                resolve(false)
              })
            })
            expect(closed, 'The helper-owned listener must be closed').toBe(true)
          }
          console.log('Fixture cleanup verified: database absent and owned listeners closed')
        }
      }
    }
  },
})
export { expect }
export async function pickSlot(scope: Page | Locator | FrameLocator, page: Page) {
  for (let month = 0; month < 4; month++) {
    await expect(scope.locator('.calendar-month')).toBeVisible()
    await expect(scope.locator('.calendar-grid[aria-busy="true"]')).toHaveCount(0)
    const days = scope.locator('button.day-available')
    const cutoff = Temporal.Now.plainDateISO('UTC').add({ days: 2 }).toString()
    for (let index = 0; index < (await days.count()); index++) {
      const day = days.nth(index),
        date = await day.getAttribute('data-day')
      if (date && date >= cutoff) {
        await day.click()
        await scope.locator('.slots button').first().click()
        return
      }
    }
    const slots = page.waitForResponse((r) => r.url().includes('/slots') && r.status() === 200)
    await scope.getByRole('button', { name: /^(Next month|下个月)$/ }).click()
    await slots
  }
  throw new Error('No fixture availability within four months')
}
export async function fillInvitee(scope: Page | Locator | FrameLocator) {
  await scope.getByLabel(/^(Your name|你的姓名)$/, { exact: true }).fill('Fixture Invitee')
  await scope.getByLabel(/^(Email|邮箱)$/, { exact: true }).fill('fixture-invitee@hourmere.invalid')
}
