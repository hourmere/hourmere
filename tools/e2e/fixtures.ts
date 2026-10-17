import { randomBytes } from 'node:crypto'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createProbe, type Server as SocketServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { type RunningServer, startServer } from '../../apps/server/src/server.ts'
import { createDb } from '../../packages/db/src/index.ts'
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
  rows: () => Promise<{ source: string; status: string }[]>
}
export const test = base.extend<{ app: FixtureApp }>({
  app: async ({ context }, use) => {
    const bootstrap = process.env.HOURMERE_E2E_BOOTSTRAP_URL
    if (!bootstrap)
      throw new Error(
        'Set HOURMERE_E2E_BOOTSTRAP_URL for helper-owned throwaway databases; no DATABASE_URL fallback is used',
      )
    const owned = await createTestDatabase(bootstrap)
    let app: RunningServer | undefined, parent: Server | undefined
    try {
      const probe = createProbe()
      const port = await listenLoopback(probe)
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
      parent = createHttpServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store')
        if (request.url === '/parent.js') {
          response.setHeader('Content-Type', 'application/javascript')
          response.end(
            `window.fixtureMessages=[];window.addEventListener('message',e=>{if(e.origin===${JSON.stringify(url)})window.fixtureMessages.push(e.data)});`,
          )
          return
        }
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(
          `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture website</title><button type="button" data-hourmere-popup data-hourmere-url="${url}/fixture-host/call">Book a meeting</button><div data-hourmere-inline data-hourmere-url="${url}/fixture-host/call"></div><script src="/parent.js" defer></script><script src="${url}/hourmere-embed.js" defer></script>`,
        )
      })
      const parentUrl = `http://127.0.0.1:${await listenLoopback(parent)}`
      app = await startServer({
        DATABASE_URL: owned.url,
        PORT: String(port),
        PUBLIC_URL: url,
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        SIGNUP: 'closed',
        HOURMERE_ROLE: 'web',
        EMBED_ALLOWED_ORIGINS: parentUrl,
        WEB_DIST: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
      })
      let externalRequests = 0
      await context.route('**/*', async (route) => {
        const origin = new URL(route.request().url()).origin
        if (origin === url || origin === parentUrl) await route.continue()
        else {
          externalRequests++
          await route.abort('blockedbyclient')
        }
      })
      await use({
        url,
        parentUrl,
        personalPath: '/fixture-host/call',
        teamPath: '/team/FixtureTeam/call',
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
        await owned.drop()
      }
    }
  },
})
export { expect }
export async function pickSlot(scope: Page | Locator, page: Page) {
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
    await scope.getByRole('button', { name: 'Next month' }).click()
    await slots
  }
  throw new Error('No fixture availability within four months')
}
export async function fillInvitee(scope: Page | Locator) {
  await scope.getByLabel('Your name', { exact: true }).fill('Fixture Invitee')
  await scope.getByLabel('Email', { exact: true }).fill('fixture-invitee@hourmere.invalid')
}
