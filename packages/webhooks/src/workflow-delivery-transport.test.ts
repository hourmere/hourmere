import { EventEmitter } from 'node:events'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { webhookSignature } from './crypto.ts'
import { deliverWorkflowWebhook, webhookDeliveryJob } from './delivery.ts'
import { parseWebhookPrivateTargets } from './private-targets.ts'
import { rotateWebhookSecret, updateWebhook } from './service.ts'
import { workflowDeliveryFixture } from './workflow-delivery-fixture.ts'

type FakeRequest = (
  url: URL,
  options: {
    headers: Readonly<Record<string, string>>
    lookup: (
      hostname: string,
      options: object,
      callback: (error: null, address: string, family: number) => void,
    ) => void
  },
  respond: (response: {
    statusCode: number
    headers: Record<string, string>
    destroy: () => void
  }) => void,
) => EventEmitter & { end(body: string): void }

const network = vi.hoisted(() => ({
  lookup: vi.fn(),
  http: vi.fn<FakeRequest>(),
  https: vi.fn<FakeRequest>(),
}))
vi.mock('node:dns/promises', async (original) => ({
  ...(await original<typeof import('node:dns/promises')>()),
  lookup: network.lookup,
}))
vi.mock('node:http', async (original) => ({
  ...(await original<typeof import('node:http')>()),
  request: network.http,
}))
vi.mock('node:https', async (original) => ({
  ...(await original<typeof import('node:https')>()),
  request: network.https,
}))

const publicAddress = { address: '8.8.8.8', family: 4 }
const privateAddress = { address: '192.168.1.10', family: 4 }
const privateTargets = parseWebhookPrivateTargets('n8n:5678')
const privateUrl = 'http://n8n:5678/receiver'
const serverUrl = process.env.DATABASE_URL

function replyWith(
  request: typeof network.https,
  statusCode: number,
  headers: Record<string, string> = {},
) {
  const received = vi.fn<(body: string) => void>()
  const destroy = vi.fn()
  request.mockImplementation((_url, _options, respond) =>
    Object.assign(new EventEmitter(), {
      end(body: string) {
        received(body)
        respond({ statusCode, headers, destroy })
      },
    }),
  )
  return { received, destroy }
}

type Fixture = Awaited<ReturnType<typeof workflowDeliveryFixture>>

describe.skipIf(!serverUrl)('workflow webhook guarded transport', () => {
  let owned: TestDatabase
  let db: Db
  let jobs: ReturnType<typeof createJobs<ReturnType<typeof webhookDeliveryJob>[]>>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'workflow_http' })
    db = createDb(owned.pool)
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [webhookDeliveryJob({ db, enabled: true })],
      work: false,
      migrate: true,
      maxConnections: 2,
    })
    await jobs.start()
  })
  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      await owned?.drop()
    }
  })
  beforeEach(() => {
    vi.resetAllMocks()
  })

  const send = ({ settings, ctx, delivery }: Fixture, targets = settings.privateTargets) =>
    deliverWorkflowWebhook(
      { db, ...settings, now: ctx.now, privateTargets: targets },
      delivery.id,
      new AbortController().signal,
    )
  const savedDelivery = ({ delivery }: Fixture) =>
    db
      .selectFrom('webhook_deliveries')
      .select(['status', 'attempts', 'last_error', 'http_status'])
      .where('id', '=', delivery.id)
      .executeTakeFirstOrThrow()

  it('pins the public answer and refuses a rebound private answer at retry', async () => {
    const fixture = await workflowDeliveryFixture(db, jobs)
    network.lookup
      .mockResolvedValueOnce([publicAddress])
      .mockResolvedValueOnce([publicAddress, privateAddress])
    const { received } = replyWith(network.https, 503)

    await expect(send(fixture)).rejects.toThrow(/^Webhook delivery failed$/)
    const connection = network.https.mock.calls[0]
    expect(connection).toBeDefined()
    const pinned = vi.fn()
    if (connection) connection[1].lookup(connection[0].hostname, {}, pinned)
    expect(pinned).toHaveBeenCalledExactlyOnceWith(null, publicAddress.address, 4)
    expect(await savedDelivery(fixture)).toMatchObject({ status: 'pending', http_status: 503 })

    fixture.clock.now = fixture.clock.now.add({ minutes: 1 })
    await expect(send(fixture)).rejects.toThrow(/^Webhook delivery failed$/)
    expect(network.lookup).toHaveBeenCalledTimes(2)
    expect(network.https).toHaveBeenCalledOnce()
    expect(network.http).not.toHaveBeenCalled()
    expect(received).toHaveBeenCalledOnce()
    expect(await savedDelivery(fixture)).toEqual({
      status: 'pending',
      attempts: 2,
      last_error: 'transport_error',
      http_status: null,
    })
  })

  it('records a redirect as a failed attempt without opening another socket', async () => {
    const fixture = await workflowDeliveryFixture(db, jobs)
    network.lookup.mockResolvedValue([publicAddress])
    const { received, destroy } = replyWith(network.https, 302, { location: privateUrl })

    await expect(send(fixture)).rejects.toThrow(/^Webhook delivery failed$/)
    expect(network.lookup).toHaveBeenCalledOnce()
    expect(network.https).toHaveBeenCalledOnce()
    expect(network.http).not.toHaveBeenCalled()
    expect(received).toHaveBeenCalledOnce()
    expect(destroy).toHaveBeenCalledOnce()
    expect(await savedDelivery(fixture)).toEqual({
      status: 'pending',
      attempts: 1,
      last_error: 'http_error',
      http_status: 302,
    })
  })

  it('refuses a forbidden address even for an allowlisted private host', async () => {
    const fixture = await workflowDeliveryFixture(db, jobs, { url: privateUrl, privateTargets })
    network.lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])
    replyWith(network.http, 204)

    await expect(send(fixture)).rejects.toThrow(/^Webhook delivery failed$/)
    expect(network.lookup).toHaveBeenCalledOnce()
    expect(network.http).not.toHaveBeenCalled()
    expect(network.https).not.toHaveBeenCalled()
    expect(await savedDelivery(fixture)).toEqual({
      status: 'pending',
      attempts: 1,
      last_error: 'transport_error',
      http_status: null,
    })
  })

  it('rechecks current private-target policy on a previously permitted retry', async () => {
    const fixture = await workflowDeliveryFixture(db, jobs, { url: privateUrl, privateTargets })
    network.lookup.mockResolvedValue([privateAddress])
    const { received } = replyWith(network.http, 503)

    await expect(send(fixture)).rejects.toThrow(/^Webhook delivery failed$/)
    expect(await savedDelivery(fixture)).toMatchObject({ status: 'pending', http_status: 503 })

    fixture.clock.now = fixture.clock.now.add({ minutes: 1 })
    await expect(send(fixture, [])).rejects.toThrow(/^Webhook delivery failed$/)
    expect(network.lookup).toHaveBeenCalledOnce()
    expect(network.http).toHaveBeenCalledOnce()
    expect(network.https).not.toHaveBeenCalled()
    expect(received).toHaveBeenCalledOnce()
    expect(await savedDelivery(fixture)).toEqual({
      status: 'pending',
      attempts: 2,
      last_error: 'transport_error',
      http_status: null,
    })
  })

  it('expires a first attempt refused by policy before any DNS lookup', async () => {
    const fixture = await workflowDeliveryFixture(db, jobs, { url: privateUrl, privateTargets })
    await expect(send(fixture, [])).rejects.toThrow(/^Webhook delivery failed$/)
    expect(await savedDelivery(fixture)).toMatchObject({ status: 'pending', attempts: 1 })

    fixture.clock.now = fixture.clock.now.add({ hours: 1 })
    await send(fixture)
    expect(await savedDelivery(fixture)).toMatchObject({ status: 'skipped', last_error: 'expired' })
    expect(network.lookup).not.toHaveBeenCalled()
    expect(network.http).not.toHaveBeenCalled()
    expect(network.https).not.toHaveBeenCalled()
  })

  it.each(['pause', 'rotation'] as const)(
    'checks the endpoint after a concurrent %s commits during the delivery lock wait',
    async (operation) => {
      const fixture = await workflowDeliveryFixture(db, jobs)
      network.lookup.mockResolvedValue([publicAddress])
      const { ctx, delivery, settings, webhook } = fixture
      const { received } = replyWith(network.https, 204)
      const locked = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const writer = {
        ...ctx,
        authorizeOrganizationWrite: async () => {
          locked.resolve()
          await release.promise
        },
      }
      const change =
        operation === 'pause'
          ? updateWebhook(writer, webhook.id, { isActive: false })
          : rotateWebhookSecret(writer, settings, webhook.id)
      let pending: Promise<unknown> | undefined
      try {
        await Promise.race([locked.promise, change])
        pending = send(fixture)
        await expect
          .poll(
            async () => {
              const session = await owned.pool.query<{ blocked: boolean }>(`
            SELECT EXISTS (SELECT FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query ILIKE '%from "webhooks"%for share%') AS blocked
          `)
              return session.rows[0]?.blocked
            },
            { timeout: 3000 },
          )
          .toBe(true)
        expect(network.lookup).not.toHaveBeenCalled()
        expect(received).not.toHaveBeenCalled()
      } finally {
        release.resolve()
        await Promise.all([change, pending])
      }

      const changed = await change
      if (operation === 'pause') {
        expect(network.lookup).not.toHaveBeenCalled()
        expect(received).not.toHaveBeenCalled()
        expect(await savedDelivery(fixture)).toEqual({
          status: 'skipped',
          attempts: 0,
          last_error: 'disabled',
          http_status: null,
        })
        return
      }

      if (!('secret' in changed)) throw new Error('Expected a rotated signing key')
      expect(received).toHaveBeenCalledOnce()
      const headers = network.https.mock.calls[0]?.[1].headers
      const timestamp = headers?.['webhook-timestamp'] ?? ''
      expect(headers?.['webhook-id']).toBe(delivery.id)
      expect(
        headers?.['webhook-signature'] ===
          webhookSignature(changed.secret, timestamp, delivery.payload),
      ).toBe(true)
      expect(
        headers?.['webhook-signature'] ===
          webhookSignature(fixture.secret, timestamp, delivery.payload),
      ).toBe(false)
      expect(await savedDelivery(fixture)).toEqual({
        status: 'delivered',
        attempts: 1,
        last_error: null,
        http_status: 204,
      })
    },
  )
})
