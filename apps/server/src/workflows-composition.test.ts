import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createAuth, createAuthPool } from '@hourmere/auth'
import { createDb } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { webhookSignature } from '@hourmere/webhooks'
import { describe, expect, it, vi } from 'vitest'
import { fakeSmtpServer } from '../../../packages/mail/src/smtp-testing.ts'
import { type RunningServer, startServer } from './server.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'http://localhost'
const subject = 'Workflow composition test'

describe.skipIf(!serverUrl)('workflow defaults across real server roles', () => {
  it('captures and delivers by default and honors the explicit emergency stop', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    const db = createDb(owned.pool)
    const smtp = fakeSmtpServer()
    const requests: { body: string; signatureValid: boolean }[] = []
    let signingSecret = ''
    const receiver = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        requests.push({
          body,
          signatureValid:
            request.headers['webhook-signature'] ===
            webhookSignature(signingSecret, String(request.headers['webhook-timestamp']), body),
        })
        response.writeHead(204).end()
      })
    })
    let web: RunningServer | undefined
    let worker: RunningServer | undefined
    try {
      await Promise.all([
        once(smtp.server.listen(0, '127.0.0.1'), 'listening'),
        once(receiver.listen(0, '127.0.0.1'), 'listening'),
      ])
      const smtpPort = (smtp.server.address() as { port: number }).port
      const target = `127.0.0.1:${(receiver.address() as { port: number }).port}`
      const secret = randomBytes(32).toString('base64')
      const host = await createTestUser(db)
      const organizationId = host.principal.organization.id
      const signup = { mode: 'closed', allowedDomains: [] } as const
      const authPool = createAuthPool(owned.url, signup)
      let apiKey: string
      try {
        const auth = createAuth({
          pool: authPool,
          db,
          baseURL: publicUrl,
          secret,
          signup,
          mailer: { send: async () => {} },
        })
        apiKey = (await auth.api.createApiKey({ body: { userId: host.id } })).key
      } finally {
        await authPool.end()
      }

      const env = {
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: secret,
        PORT: '0',
        PUBLIC_URL: publicUrl,
        SIGNUP: 'closed',
        SMTP_URL: `smtp://127.0.0.1:${smtpPort}`,
        MAIL_FROM: 'bookings@example.test',
        WEBHOOKS_ENABLED: 'true',
        WEBHOOK_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        WEBHOOK_PRIVATE_TARGETS: target,
      }
      const handle = 'workflow-composition'
      await db
        .insertInto('profiles')
        .values({ user_id: host.id, handle, time_zone: 'UTC' })
        .execute()
      const fixtures = createFixtures(db)
      await fixtures.schedule(host.id, { timeZone: 'UTC' })
      const eventTypeId = await fixtures.eventType(organizationId, host.id, { slug: 'intro' })
      let day = Temporal.Now.plainDateISO('UTC').add({ days: 7 })
      while (day.dayOfWeek > 5) day = day.add({ days: 1 })

      const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }
      const appUrl = (server: RunningServer) => `http://127.0.0.1:${server.port}/api/v1`
      const post = (url: string, body: unknown) =>
        fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
      const workflowEmails = () =>
        smtp.received.messages.filter((message) => message.includes(`Subject: ${subject}\r\n`))
      async function book(server: RunningServer, hour: number) {
        const start = day
          .toZonedDateTime({ timeZone: 'UTC', plainTime: { hour } })
          .toInstant()
          .toString()
        const response = await fetch(`${appUrl(server)}/public/${handle}/intro/bookings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            start,
            invitee: { name: 'Synthetic', email: `booker-${hour}@example.test`, timeZone: 'UTC' },
          }),
        })
        expect(response.status, `Public booking at ${hour}:00`).toBe(201)
        const { booking } = (await response.json()) as { booking: { id: string } }
        return booking.id
      }

      web = await startServer({ ...env, HOURMERE_ROLE: 'web' })
      const endpointResponse = await post(`${appUrl(web)}/webhooks`, {
        url: `http://${target}/workflow`,
        events: ['workflow.executed'],
      })
      expect(endpointResponse.status).toBe(201)
      const endpoint = (await endpointResponse.json()) as {
        secret: string
        webhook: { id: string }
      }
      signingSecret = endpoint.secret
      const definition = {
        owner: { kind: 'personal', id: host.id },
        scope: { type: 'event_type', eventTypeId },
        trigger: { type: 'booking.created', delayMinutes: 0 },
        enabled: true,
      }
      const workflowIds: string[] = []
      for (const [name, action] of [
        [
          'Booking email',
          {
            type: 'email',
            recipients: ['booker'],
            content: { en: { subject, body: 'Workflow email for a new booking.' } },
          },
        ],
        ['Booking webhook', { type: 'webhook', webhookId: endpoint.webhook.id }],
      ] as const) {
        const response = await post(`${appUrl(web)}/workflows`, {
          ...definition,
          idempotencyKey: randomUUID(),
          name,
          actions: [action],
        })
        expect(response.status, name).toBe(201)
        workflowIds.push(((await response.json()) as { id: string }).id)
      }
      await web.close()
      web = undefined

      const stoppedEnv = { ...env, WORKFLOWS_ENABLED: 'false' }
      web = await startServer({ ...stoppedEnv, HOURMERE_ROLE: 'web' })
      const stoppedInstance = await fetch(`${appUrl(web)}/instance`)
      expect(await stoppedInstance.json()).toMatchObject({ workflowsEnabled: false })
      // The booking matches definitions that are already enabled in storage.
      await book(web, 10)
      expect(await db.selectFrom('workflow_enrollments').select('id').execute()).toEqual([])
      expect(await db.selectFrom('workflow_runs').select('id').execute()).toEqual([])
      await web.close()
      web = undefined

      worker = await startServer({ ...stoppedEnv, HOURMERE_ROLE: 'worker' })
      const health = await fetch(`http://127.0.0.1:${worker.port}/api/health`)
      expect(health.status).toBe(200)
      await health.body?.cancel()
      expect(
        (await owned.pool.query("SELECT name FROM pgboss.schedule WHERE name LIKE 'workflow-%'"))
          .rows,
      ).toEqual([])
      expect(
        (await owned.pool.query("SELECT name FROM pgboss.job WHERE name LIKE 'workflow-%'")).rows,
      ).toEqual([])
      expect(
        (
          await owned.pool.query(
            "SELECT name FROM pgboss.queue WHERE name = 'workflow-retention-v1'",
          )
        ).rows,
      ).toEqual([])
      expect(workflowEmails()).toEqual([])
      expect(requests).toEqual([])
      await worker.close()
      worker = undefined

      web = await startServer({ ...env, HOURMERE_ROLE: 'web', WORKFLOWS_ENABLED: '' })
      const instance = await fetch(`${appUrl(web)}/instance`)
      expect(await instance.json()).toMatchObject({ workflowsEnabled: true })
      const bookingId = await book(web, 12)
      expect(
        await db.selectFrom('workflow_runs').select(['booking_id', 'state']).execute(),
      ).toEqual([
        { booking_id: bookingId, state: 'pending' },
        { booking_id: bookingId, state: 'pending' },
      ])
      expect(workflowEmails()).toEqual([])
      expect(requests).toEqual([])

      worker = await startServer({ ...env, HOURMERE_ROLE: 'worker' })
      await vi.waitFor(
        async () => {
          expect(
            (
              await owned.pool.query(
                "SELECT 1 FROM pgboss.job WHERE name = 'workflow-retention-v1' AND state = 'completed' LIMIT 1",
              )
            ).rowCount,
          ).toBe(1)
          expect(
            await db
              .selectFrom('webhook_deliveries')
              .select(['event_type', 'booking_id', 'status', 'attempts'])
              .execute(),
          ).toEqual([
            {
              event_type: 'workflow.executed',
              booking_id: bookingId,
              status: 'delivered',
              attempts: 1,
            },
          ])
          expect(await db.selectFrom('workflow_run_history').select('outcome').execute()).toEqual([
            { outcome: 'completed' },
            { outcome: 'completed' },
          ])
        },
        { timeout: 15_000, interval: 100 },
      )
      const [emailWorkflowId, webhookWorkflowId] = workflowIds
      const emails = workflowEmails()
      expect(emails).toHaveLength(1)
      expect(emails[0]).toContain('To: booker-12@example.test')
      expect(requests).toHaveLength(1)
      expect(requests[0]?.signatureValid).toBe(true)
      expect(JSON.parse(requests[0]?.body ?? '')).toMatchObject({
        type: 'workflow.executed',
        data: {
          bookingId,
          eventTypeId,
          organizationId,
          workflowId: webhookWorkflowId,
          workflowRevision: 1,
        },
      })

      for (const [workflowId, sent] of [
        [emailWorkflowId, 1],
        [webhookWorkflowId, 0],
      ] as const) {
        const history = await fetch(`${appUrl(web)}/workflows/${workflowId}/runs`, { headers })
        expect(history.status).toBe(200)
        expect(await history.json()).toMatchObject({
          data: [
            { workflowId, revision: 1, trigger: 'booking.created', outcome: 'completed', sent },
          ],
          nextCursor: null,
        })
      }
      expect(
        await db
          .selectFrom('audit_events')
          .select(['action', 'target_id', 'details'])
          .where('organization_id', '=', organizationId)
          .where('action', 'like', 'workflow.%')
          .execute(),
      ).toEqual(
        expect.arrayContaining(
          [
            ['workflow.created', emailWorkflowId],
            ['workflow.created', webhookWorkflowId],
            ['workflow.run_scheduled', emailWorkflowId],
            ['workflow.run_scheduled', webhookWorkflowId],
            ['workflow.email_sent', emailWorkflowId],
            ['workflow.webhook_completed', webhookWorkflowId],
          ].map(([action, target_id]) => ({
            action,
            target_id,
            details: { revision: 1, trigger: 'booking.created' },
          })),
        ),
      )
    } finally {
      try {
        await worker?.close()
      } finally {
        try {
          await web?.close()
        } finally {
          for (const socket of smtp.sockets) socket.destroy()
          await Promise.all([
            new Promise<void>((resolve) => smtp.server.close(() => resolve())),
            new Promise<void>((resolve) => receiver.close(() => resolve())),
            owned.drop(),
          ])
        }
      }
    }
  }, 40_000)
})
