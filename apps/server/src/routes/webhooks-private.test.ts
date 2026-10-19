import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import {
  deliverWebhook,
  parseWebhookPrivateTargets,
  type WebhookSettings,
  webhookBookingNotifier,
} from '@hourmere/webhooks'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { productApp } from './test-app.ts'
import { webhookRoutes } from './webhooks.ts'

const network = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }))
const serverUrl = process.env.DATABASE_URL
const key = Buffer.alloc(32, 7).toString('base64')
const now = Temporal.Instant.from('2026-11-01T12:00:00Z')

describe.skipIf(!serverUrl)('private webhook configuration and signed HTTP delivery', () => {
  let owned: TestDatabase
  let db: Db
  let server: Server
  let port: number
  let requests: number
  let receive: (req: IncomingMessage, res: ServerResponse) => void
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  beforeEach(async () => {
    requests = 0
    network.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    receive = (_req, res) => res.writeHead(204).end()
    server = createServer((req, res) => {
      requests += 1
      receive(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing owned loopback port')
    port = address.port
  })
  afterEach(async () => {
    server?.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    vi.resetAllMocks()
  })
  async function client(entries = '') {
    const user = await createTestUser(db)
    const settings: WebhookSettings = {
      enabled: true,
      encryptionKey: key,
      privateTargets: parseWebhookPrivateTargets(entries),
    }
    const principals = new Map<string, Principal>([['hm_private_fixture', user.principal]])
    const app = (current = settings) =>
      productApp(db, principals, [webhookRoutes({ db, ...current })])
    const request = (
      method: string,
      path: string,
      body: unknown,
      current: WebhookSettings = settings,
    ) =>
      app(current).request(`/api/v1/webhooks${path}`, {
        method,
        headers: {
          authorization: 'Bearer hm_private_fixture',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    return { user, settings, request }
  }
  const create = (url: string) => ({ url, events: ['booking.created'] })

  it('returns identical creation refusals regardless of internal DNS success or failure', async () => {
    const { request } = await client(`n8n:${port}`)
    const refusals: unknown[] = []
    for (const dns of [
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '8.8.8.8', family: 4 }],
      new Error('synthetic private resolver detail'),
    ]) {
      if (dns instanceof Error) network.lookup.mockRejectedValue(dns)
      else network.lookup.mockResolvedValue(dns)
      const response = await request('POST', '', create(`http://unlisted:${port}/hook`))
      expect(response.status).toBe(400)
      refusals.push(await response.json())
    }
    expect(refusals).toEqual(
      Array(3).fill({
        error: 'invalid_webhook',
        message: 'Webhook destination is not allowed on this instance',
      }),
    )
    expect(network.lookup).not.toHaveBeenCalled()
    expect(requests).toBe(0)
  })

  it('creates and updates an exact trusted hostname without revealing DNS existence', async () => {
    const { request } = await client(`n8n:${port},absent:${port}`)
    network.lookup.mockRejectedValue(new Error('synthetic host does not exist'))
    for (const hostname of ['n8n', 'absent']) {
      const created = await request('POST', '', create(`http://${hostname}:${port}/hook`))
      expect(created.status).toBe(201)
      const { webhook } = (await created.json()) as { webhook: { id: string } }
      const updated = await request('PATCH', `/${webhook.id}`, { events: ['booking.cancelled'] })
      expect(updated.status).toBe(200)
    }
    expect(network.lookup).not.toHaveBeenCalled()
    expect(requests).toBe(0)
  })

  it('rechecks the saved destination on update after operator revocation without DNS', async () => {
    const { request } = await client(`n8n:${port},absent:${port}`)
    const errors: unknown[] = []
    for (const hostname of ['n8n', 'absent']) {
      const created = await request('POST', '', create(`http://${hostname}:${port}/hook`))
      expect(created.status).toBe(201)
      const { webhook } = (await created.json()) as { webhook: { id: string } }
      if (hostname === 'absent') network.lookup.mockRejectedValue(new Error('not found'))
      const updated = await request(
        'PATCH',
        `/${webhook.id}`,
        { isActive: true },
        {
          enabled: true,
          encryptionKey: key,
        },
      )
      expect(updated.status).toBe(400)
      errors.push(await updated.json())
    }
    expect(errors[0]).toEqual(errors[1])
    expect(network.lookup).not.toHaveBeenCalled()
  })

  async function captured(entries: string, url: string) {
    const data = await client(entries)
    const response = await data.request('POST', '', create(url))
    expect(response.status).toBe(201)
    const { webhook, secret } = (await response.json()) as {
      webhook: { id: string }
      secret: string
    }
    const bookingId = await createFixtures(db).booking(
      data.user.principal.organization.id,
      [data.user.id],
      '2026-11-03T09:00Z',
      '2026-11-03T09:30Z',
    )
    await db
      .transaction()
      .execute((trx) =>
        webhookBookingNotifier({ enqueue: async () => null }, data.settings)(
          trx,
          { type: 'created', bookingId, start: Temporal.Instant.from('2026-11-03T09:00Z') },
          now,
        ),
      )
    const delivery = await db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('webhook_id', '=', webhook.id)
      .executeTakeFirstOrThrow()
    return { ...data, delivery, secret }
  }

  it('delivers a captured booking over real allowlisted HTTP with the unchanged HMAC headers', async () => {
    const data = await captured(`n8n:${port}`, `http://n8n:${port}/hook?version=1`)
    let signed = false
    let metadata = false
    receive = (req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
      })
      req.on('end', () => {
        const timestamp = req.headers['webhook-timestamp']
        const expected = `v1=${createHmac('sha256', data.secret).update(`${timestamp}.${body}`).digest('hex')}`
        signed = req.headers['webhook-signature'] === expected
        metadata =
          req.method === 'POST' &&
          req.url === '/hook?version=1' &&
          req.headers.host === `n8n:${port}` &&
          req.headers['webhook-id'] === data.delivery.id &&
          req.headers['webhook-event-id'] === data.delivery.event_id &&
          timestamp === String(Math.floor(now.epochMilliseconds / 1000)) &&
          req.headers['content-type'] === 'application/json' &&
          body === data.delivery.payload
        res.writeHead(204).end()
      })
    }
    await expect(
      deliverWebhook(
        { db, ...data.settings, now: () => now },
        data.delivery.id,
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()
    expect(signed).toBe(true)
    expect(metadata).toBe(true)
    expect(requests).toBe(1)
    const stored = await db
      .selectFrom('webhook_deliveries')
      .select(['status', 'attempts'])
      .where('id', '=', data.delivery.id)
      .executeTakeFirstOrThrow()
    expect(stored).toEqual({ status: 'delivered', attempts: 1 })
  })

  it('refuses a previously captured private endpoint when the delivery setting is removed', async () => {
    const data = await captured(`127.0.0.1:${port}`, `http://127.0.0.1:${port}/hook`)
    await expect(
      deliverWebhook(
        { db, enabled: true, encryptionKey: key, now: () => now },
        data.delivery.id,
        new AbortController().signal,
      ),
    ).rejects.toThrow('Webhook delivery failed')
    expect(requests).toBe(0)
    const stored = await db
      .selectFrom('webhook_deliveries')
      .select(['status', 'last_error', 'attempts'])
      .where('id', '=', data.delivery.id)
      .executeTakeFirstOrThrow()
    expect(stored).toEqual({ status: 'pending', last_error: 'transport_error', attempts: 1 })
  })

  it('records redirects as failure and never visits the redirect target', async () => {
    const data = await captured(`n8n:${port}`, `http://n8n:${port}/hook`)
    receive = (_req, res) =>
      res.writeHead(302, { location: `http://127.0.0.1:${port}/redirected` }).end()
    await expect(
      deliverWebhook(
        { db, ...data.settings, now: () => now },
        data.delivery.id,
        new AbortController().signal,
      ),
    ).rejects.toThrow('Webhook delivery failed')
    expect(requests).toBe(1)
    const stored = await db
      .selectFrom('webhook_deliveries')
      .select(['status', 'last_error', 'http_status'])
      .where('id', '=', data.delivery.id)
      .executeTakeFirstOrThrow()
    expect(stored).toEqual({ status: 'pending', last_error: 'http_error', http_status: 302 })
  })
})
