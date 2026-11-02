import { createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import { createApp } from '../../apps/server/src/app.ts'
import { bookingRoutes } from '../../apps/server/src/routes/bookings.ts'
import { eventTypeRoutes } from '../../apps/server/src/routes/event-types.ts'
import { instanceRoutes } from '../../apps/server/src/routes/instance.ts'
import { profileRoutes } from '../../apps/server/src/routes/profile.ts'
import { publicRoutes } from '../../apps/server/src/routes/public.ts'
import { readinessRoutes } from '../../apps/server/src/routes/readiness.ts'
import { scheduleRoutes } from '../../apps/server/src/routes/schedules.ts'
import { createAuth, createAuthPool, createCallerResolver } from '../../packages/auth/src/index.ts'
import { createDb } from '../../packages/db/src/index.ts'
import { createTestDatabase } from '../../packages/db/src/testing.ts'
import { createJobs } from '../../packages/jobs/src/index.ts'
import type { MailMessage } from '../../packages/mail/src/index.ts'
import {
  bookingNotificationJob,
  bookingNotifier,
  scheduledBookingEmailJob,
} from '../../packages/notifications/src/index.ts'
import { createFixtures } from '../../packages/scheduling/src/testing.ts'
import { test as base, expect } from './fixtures.ts'
import { listenOwned, type OwnedListener } from './listeners.ts'

export const REMINDER_NOW = '2030-05-06T08:00:00Z'
export const REMINDER_NOTE = 'Please reply with any questions.\n谢谢！<b>Plain text</b> {name}'
export const REMINDER_INVITEE = 'reminder-invitee@hourmere.invalid'

export interface ScheduledMessageState {
  kind: string
  due: string
  queuedFor: string | null
  state: string
  attempts: number
}
interface ReminderApp {
  url: string
  editorPath: string
  bookingPath: string
  signIn: (locale: 'en' | 'zh-CN') => Promise<void>
  signOut: () => Promise<void>
  scheduled: (bookingId: string) => Promise<ScheduledMessageState[]>
  advance: (instant: string) => Promise<void>
  messages: () => readonly { at: string; message: MailMessage }[]
}

/**
 * The same private in-process mail sink used by the conference browser fixtures.
 * Route clocks and the production scheduled-email handler share one injected clock;
 * pg-boss retains real transactional jobs, without waiting days of wall time in CI.
 */
export const test = base.extend<{ reminderApp: ReminderApp }>({
  reminderApp: async ({ context }, use) => {
    const bootstrap = process.env.HOURMERE_E2E_BOOTSTRAP_URL
    if (!bootstrap) throw new Error('Reminder acceptance requires HOURMERE_E2E_BOOTSTRAP_URL')
    const owned = await createTestDatabase(bootstrap, undefined, { tag: 'reminder_e2e' })
    let listener: OwnedListener | undefined
    let authPool: ReturnType<typeof createAuthPool> | undefined
    let jobs: ReturnType<typeof createJobs> | undefined
    try {
      listener = await listenOwned(createServer())
      const { url, server } = listener
      const db = createDb(owned.pool)
      const f = createFixtures(db)
      const host = await f.host({ handle: 'reminder-host', name: 'Reminder Host', timeZone: 'UTC' })
      await db
        .updateTable('auth.user')
        .set({ email: 'reminder-host@hourmere.invalid' })
        .where('id', '=', host.userId)
        .execute()
      await f.schedule(host.userId, { timeZone: 'UTC' })
      const eventTypeId = await f.eventType(host.organizationId, host.userId, {
        slug: 'call',
        title: 'Reminder acceptance call',
        durationMinutes: 30,
      })
      let now = Temporal.Instant.from(REMINDER_NOW)
      const sent: { at: string; message: MailMessage }[] = []
      const secret = randomBytes(32).toString('base64')
      const mailer = {
        send: async (message: MailMessage) => {
          sent.push({ at: now.toString(), message })
        },
      }
      const deps = { db, mailer, publicUrl: url, secret, now: () => now, log: () => {} }
      const scheduledWorker = scheduledBookingEmailJob(deps)
      const queue = createJobs({
        connectionString: owned.url,
        definitions: [bookingNotificationJob(deps), scheduledWorker],
        work: false,
        migrate: true,
        maxConnections: 1,
        log: () => {},
      })
      jobs = queue
      await queue.start()
      const signup = { mode: 'closed', allowedDomains: [] } as const
      authPool = createAuthPool(owned.url, signup)
      const auth = createAuth({ pool: authPool, db, baseURL: url, secret, signup, mailer })
      const routeDeps = { db, now: () => now, notify: bookingNotifier(queue) }
      const app = createApp({
        publicUrl: url,
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        webDist:
          process.env.HOURMERE_E2E_WEB_DIST ??
          fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
        routes: [
          instanceRoutes({ publicUrl: url, socialProviders: {}, followUpHostNotesEnabled: true }),
          profileRoutes(routeDeps),
          scheduleRoutes(routeDeps),
          eventTypeRoutes({ ...routeDeps, followUpHostNotesEnabled: true }),
          readinessRoutes(routeDeps),
          publicRoutes(routeDeps),
          bookingRoutes(routeDeps),
        ],
      })
      server.on('request', getRequestListener(app.fetch, { hostname: '127.0.0.1' }))
      let externalRequests = 0
      await context.route('**/*', async (route) => {
        if (new URL(route.request().url()).origin === url) return route.continue()
        externalRequests++
        await route.abort('blockedbyclient')
      })
      await use({
        url,
        editorPath: `/app/event-types/${eventTypeId}`,
        bookingPath: '/reminder-host/call',
        signIn: async (locale) => {
          await db
            .updateTable('profiles')
            .set({ locale })
            .where('user_id', '=', host.userId)
            .execute()
          const token = randomBytes(24).toString('base64url')
          await db
            .insertInto('auth.session')
            .values({
              userId: host.userId,
              activeOrganizationId: host.organizationId,
              token,
              updatedAt: new Date(),
              expiresAt: new Date(Date.now() + 86_400_000),
            })
            .execute()
          await context.addCookies([
            {
              name: 'better-auth.session_token',
              value: encodeURIComponent(
                `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`,
              ),
              url,
              httpOnly: true,
              sameSite: 'Lax',
            },
          ])
        },
        signOut: () => context.clearCookies(),
        scheduled: async (bookingId) => {
          const result = await owned.pool.query<{
            kind: string
            due_at: Date
            start_after: Date | null
            state: string
            attempts: number
          }>(
            `SELECT m.kind,m.due_at,j.start_after,m.state,m.attempts
             FROM booking_scheduled_messages m LEFT JOIN pgboss.job j ON j.id=m.last_job_id
             WHERE m.booking_id=$1 ORDER BY m.due_at`,
            [bookingId],
          )
          return result.rows.map((row) => ({
            kind: row.kind,
            due: row.due_at.toISOString(),
            queuedFor: row.start_after?.toISOString() ?? null,
            state: row.state,
            attempts: row.attempts,
          }))
        },
        advance: async (instant) => {
          const next = Temporal.Instant.from(instant)
          if (Temporal.Instant.compare(next, now) < 0) throw new Error('Clock must move forward')
          now = next
          // Wake every persisted identity, even early or obsolete ones. Production guards
          // must suppress early mail and rescheduled predecessors without spending attempts.
          const rows = await db
            .selectFrom('booking_scheduled_messages')
            .select(['id', 'last_job_id'])
            .orderBy('due_at')
            .execute()
          for (const row of rows) {
            if (!row.last_job_id) throw new Error('A scheduled message must retain its queue job')
            await scheduledWorker.handler(
              { messageId: row.id },
              { id: row.last_job_id, attempt: 1, signal: new AbortController().signal },
            )
          }
        },
        messages: () => sent,
      })
      expect(externalRequests, 'No external browser requests').toBe(0)
    } finally {
      try {
        await listener?.close()
      } finally {
        try {
          await jobs?.stop()
        } finally {
          try {
            await authPool?.end()
          } finally {
            await owned.drop()
            await listener?.assertClosed()
          }
        }
      }
    }
  },
})
export { expect }
