// Install Zod's OpenAPI extensions before loading the product route schemas.
import '@hono/zod-openapi'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import { DomainError } from '@hourmere/scheduling'
import { sql } from 'kysely'
import { createApp } from '../../apps/server/src/app.ts'
import { productRoutes } from '../../apps/server/src/server.ts'
import { createAuth, createAuthPool, createCallerResolver } from '../../packages/auth/src/index.ts'
import {
  conferenceBookingNotifier,
  writeBookingConference,
} from '../../packages/calendars/src/conferences.ts'
import { conferenceEncryptionKey } from '../../packages/conferences/src/credentials.ts'
import { fakeZoom, TEST_CONFERENCE_KEY } from '../../packages/conferences/src/testing.ts'
import { credentials } from '../../packages/conferences/src/tokens.ts'
import { createZoomConferenceWork } from '../../packages/conferences/src/worker.ts'
import { zoomScopes } from '../../packages/conferences/src/zoom.ts'
import { createDb, type Db } from '../../packages/db/src/index.ts'
import { createTestDatabase } from '../../packages/db/src/testing.ts'
import type { EnqueueOptions } from '../../packages/jobs/src/index.ts'
import type { MailMessage } from '../../packages/mail/src/index.ts'
import {
  DEPARTURE_HANDOFF_EMAIL_JOB,
  deliverDepartureHandoffEmail,
} from '../../packages/notifications/src/departure-handoff.ts'
import {
  BOOKING_NOTIFICATION_JOB,
  BookingNotificationPayload,
  bookingNotifier,
  sendBookingNotification,
} from '../../packages/notifications/src/index.ts'
import { createPublicTeamBooking } from '../../packages/scheduling/src/bookings.ts'
import type { BookingNotifier } from '../../packages/scheduling/src/context.ts'
import {
  createHandoffTestFixture,
  handoffTestRecords,
  handoffTestSession,
} from '../../packages/scheduling/src/departure-handoff-apply-test-fixture.ts'
import { createDepartureHandoffProposal } from '../../packages/scheduling/src/departure-handoff-proposals.ts'
import { test as base, expect } from './fixtures.ts'
import { listenOwned, type OwnedListener } from './listeners.ts'

interface HandoffApp {
  url: string
  teamId: string
  sourceId: string
  sourcePath: string
  emails: { booker: string; guest: string; departing: string; candidate: string }
  signIn: (as?: 'owner' | 'candidate', locale?: 'en' | 'zh-CN') => Promise<void>
  offer: (state?: 'approved' | 'pending') => Promise<void>
  participantLinks: () => Promise<{ booker: URL; guest: URL }>
  participantDecisions: () => Promise<{ booker: string | null; guest: string | null }>
  expireOffer: () => void
  occupySlot: () => Promise<void>
  failEnqueue: (fail: boolean) => void
  result: () => Promise<{
    source: string
    bookingCount: number
    replacementId: string | undefined
    replacementConfirmed: boolean
    notificationCount: number
  }>
  loseProviderResponse: (replacementId: string) => Promise<void>
  reconcileProvider: (replacementId: string) => Promise<void>
  providerState: () => { newCreates: number; newMeetings: number; oldMeetings: number }
  mail: (
    bookingId: string,
    kind: 'cancelled' | 'confirmed' | 'conference_failed',
    reject?: boolean,
  ) => Promise<void>
  mailState: () => {
    to: string
    method: string | undefined
    uid: string | undefined
    sequence: string | undefined
    hasZoomLink: boolean
  }[]
}

const booker = 'booker@example.test'
const guest = 'guest@example.test'

export const test = base.extend<{
  handoff: HandoffApp
  handoffZoom: boolean
}>({
  handoffZoom: [false, { option: true }],
  handoff: async ({ context, handoffZoom }, use) => {
    const bootstrap = process.env.HOURMERE_E2E_BOOTSTRAP_URL
    if (!bootstrap) throw new Error('HOURMERE_E2E_BOOTSTRAP_URL must bootstrap the test database')
    const owned = await createTestDatabase(bootstrap)
    let listener: OwnedListener | undefined
    let authPool: ReturnType<typeof createAuthPool> | undefined
    try {
      listener = await listenOwned(createServer())
      const { server, url } = listener
      const db = createDb(owned.pool)
      const baseNow = Temporal.Now.instant()
      let current = baseNow
      const now = () => current
      let day = current.toZonedDateTimeISO('America/Los_Angeles').toPlainDate().add({ days: 2 })
      while (day.dayOfWeek > 5) day = day.add({ days: 1 })
      const start = day
        .toZonedDateTime({ timeZone: 'America/Los_Angeles', plainTime: '09:00' })
        .toInstant()

      const oldProvider = fakeZoom(url)
      const newProvider = fakeZoom(url)
      const oldIdentity = 'synthetic-departing-zoom'
      const newIdentity = 'synthetic-replacement-zoom'
      oldProvider.controls.identity.id = oldIdentity
      newProvider.controls.identity.id = newIdentity
      const work = (provider: typeof newProvider) => ({
        db,
        zoomConferenceWork: createZoomConferenceWork(
          {
            db,
            zoom: {
              client: provider.client,
              encryptionKey: TEST_CONFERENCE_KEY,
              meetingsEnabled: true,
            },
          },
          provider.meetings,
        ),
      })
      async function pinZoom(eventTypeId: string, userId: string, identity: string) {
        const id = randomUUID()
        const scopes = zoomScopes('meetings')
        await db
          .insertInto('conference_connections')
          .values({
            id,
            user_id: userId,
            provider: 'zoom',
            mode: 'meetings',
            external_user_id: identity,
            status: 'active',
            scopes,
            credentials: credentials(
              conferenceEncryptionKey(TEST_CONFERENCE_KEY),
              userId,
              id,
              identity,
              {
                accessToken: 'synthetic-access',
                refreshToken: 'synthetic-refresh',
                expiresAt: baseNow.add({ hours: 1 }).epochMilliseconds,
                scopes,
              },
              'meetings',
            ),
          })
          .execute()
        await db
          .updateTable('event_types')
          .set({
            location: JSON.stringify({ kind: 'zoom', autoCreate: true }),
            zoom_connection_id: id,
          })
          .where('id', '=', eventTypeId)
          .execute()
      }
      const storage = handoffTestRecords(db)
      const fixture = await createHandoffTestFixture(db, {
        now,
        start,
        ...(handoffZoom && {
          sourceContext: { automaticZoom: true },
          applyContext: { automaticZoom: true },
          configureSource: ({ eventTypeId, departing }) =>
            pinZoom(eventTypeId, departing.id, oldIdentity),
          configureTarget: ({ eventTypeId, candidate }) =>
            pinZoom(eventTypeId, candidate.id, newIdentity),
        }),
      })
      const { booking, candidate, ctx, departing, input, owner, team } = fixture
      if (handoffZoom) await writeBookingConference(work(oldProvider), booking.id)

      await sql`CREATE TABLE e2e_handoff_jobs (
        name text NOT NULL,
        singleton_key text NOT NULL,
        payload jsonb NOT NULL,
        PRIMARY KEY (name, singleton_key)
      )`.execute(db)
      let failEnqueue = false
      const queue = {
        async enqueue(name: string, payload: unknown, options?: EnqueueOptions) {
          const trx = options?.transaction as Db | undefined
          if (!trx?.isTransaction || !options?.singletonKey)
            throw new Error('Expected a transactional booking job')
          // Fail after the source cancellation has already queued its work in this transaction.
          if (failEnqueue && (payload as { kind?: string }).kind === 'confirmed')
            throw new DomainError('unavailable', 'booking_notification_queue_unavailable')
          await sql`INSERT INTO e2e_handoff_jobs (name, singleton_key, payload)
            VALUES (${name}, ${options.singletonKey}, ${JSON.stringify(payload)}::jsonb)
            ON CONFLICT DO NOTHING`.execute(trx)
          return null
        },
      }
      const notifyConference = conferenceBookingNotifier(queue)
      const notifyEmail = bookingNotifier(queue)
      const notify: BookingNotifier = async (trx, event, at) => {
        await notifyConference(trx, event)
        await notifyEmail(trx, event, at)
      }
      const signup = { mode: 'closed', allowedDomains: [] } as const
      const secret = randomBytes(32).toString('base64')
      authPool = createAuthPool(owned.url, signup)
      const auth = createAuth({
        pool: authPool,
        db,
        baseURL: url,
        secret,
        signup,
        mailer: {
          send: async () => {
            throw new Error('Sign-in mail is disabled in this fixture')
          },
        },
      })
      const app = createApp({
        publicUrl: url,
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        webDist:
          process.env.HOURMERE_E2E_WEB_DIST ??
          fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
        routes: productRoutes({
          db,
          invitationMailLimits: { secret },
          publicUrl: url,
          socialProviders: {},
          notify,
          automaticZoom: handoffZoom,
          departureHandoffs: { store: storage.store, now },
        }),
      })
      server.on('request', getRequestListener(app.fetch, { hostname: '127.0.0.1' }))
      let external = 0
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin === url) return route.continue()
        external++
        return route.abort('blockedbyclient')
      })

      const sent: MailMessage[] = []
      await use({
        url,
        teamId: team.id,
        sourceId: booking.id,
        sourcePath: `/app/bookings/${booking.id}`,
        emails: { booker, guest, departing: departing.email, candidate: candidate.email },
        async signIn(as = 'owner', locale = 'en') {
          const actor = as === 'candidate' ? candidate : owner
          const session =
            as === 'candidate'
              ? await handoffTestSession(db, actor, team.as(actor).organization)
              : ctx.principal
          await db
            .insertInto('profiles')
            .values({ user_id: actor.id, handle: `handoff-${as}`, time_zone: 'UTC', locale })
            .onConflict((oc) => oc.column('user_id').doUpdateSet({ locale }))
            .execute()
          const { token } = await db
            .selectFrom('auth.session')
            .select('token')
            .where('id', '=', session.sessionId)
            .executeTakeFirstOrThrow()
          const value = encodeURIComponent(
            `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`,
          )
          await context.addCookies([
            { name: 'better-auth.session_token', value, url, httpOnly: true, sameSite: 'Lax' },
          ])
        },
        async offer(state = 'approved') {
          await storage.offer(
            ctx,
            input,
            { departingUserId: departing.id, start: start.toString() },
            (offer) => ({
              ...offer,
              expiresAt: baseNow.add({ hours: 1 }).toString(),
              approvals:
                state === 'pending'
                  ? offer.approvals.filter((approval) => approval.recipientKey !== guest)
                  : offer.approvals,
            }),
          )
        },
        async participantLinks() {
          await createDepartureHandoffProposal(
            ctx,
            {
              teamId: team.id,
              expectedOrganizationId: team.id,
              bookingId: booking.id,
              departingUserId: departing.id,
            },
            async (trx, recipientId) => {
              const jobId = randomUUID()
              await sql`INSERT INTO e2e_handoff_jobs (name, singleton_key, payload)
                VALUES (${DEPARTURE_HANDOFF_EMAIL_JOB}, ${jobId}, ${JSON.stringify({ recipientId })}::jsonb)`.execute(
                trx,
              )
              return jobId
            },
          )
          const jobs = await sql<{ job_id: string; recipient_id: string }>`
            SELECT singleton_key AS job_id, payload->>'recipientId' AS recipient_id
            FROM e2e_handoff_jobs WHERE name = ${DEPARTURE_HANDOFF_EMAIL_JOB}
          `.execute(db)
          const links = new Map<string, URL>()
          for (const { job_id, recipient_id } of jobs.rows) {
            await deliverDepartureHandoffEmail(
              {
                db,
                publicUrl: url,
                secret,
                now,
                mailer: {
                  async send() {
                    throw new Error('Expected a single sensitive SMTP attempt')
                  },
                  async sendWorkflowAttempt(message) {
                    const href = message.text.match(/https?:\/\/\S+/)?.[0]
                    if (!href || !message.sensitive)
                      throw new Error('Missing sensitive participant link')
                    links.set(message.to, new URL(href))
                    return 'sent'
                  },
                },
              },
              { recipientId: recipient_id },
              { id: job_id, signal: new AbortController().signal },
            )
          }
          const bookerLink = links.get(booker)
          const guestLink = links.get(guest)
          if (!bookerLink || !guestLink) throw new Error('Expected both participant emails')
          return { booker: bookerLink, guest: guestLink }
        },
        async participantDecisions() {
          const decisions = await db
            .selectFrom('departure_handoff_recipients')
            .select(['recipient_key', 'decision'])
            .where('source_booking_id', '=', booking.id)
            .execute()
          const byMailbox = new Map(decisions.map((row) => [row.recipient_key, row.decision]))
          if (!byMailbox.has(booker) || !byMailbox.has(guest))
            throw new Error('Missing participant records')
          return { booker: byMailbox.get(booker) ?? null, guest: byMailbox.get(guest) ?? null }
        },
        expireOffer() {
          current = baseNow.add({ hours: 2 })
        },
        async occupySlot() {
          await createPublicTeamBooking(
            { db, now, automaticZoom: handoffZoom },
            {
              handle: ctx.principal.organization.slug,
              slug: 'handoff',
              start,
              invitee: {
                name: 'Competing attendee',
                email: 'competing@example.test',
                timeZone: 'UTC',
              },
            },
          )
        },
        failEnqueue(fail) {
          failEnqueue = fail
        },
        async result() {
          const entries = await db
            .selectFrom('bookings')
            .select(['id', 'status', 'rescheduled_from_id'])
            .where('organization_id', '=', team.id)
            .execute()
          const [receipt] = await storage.receipts(input)
          const replacement = entries.find((row) => row.id === receipt?.replacementBookingId)
          const {
            rows: [jobs],
          } = await sql<{ count: number }>`SELECT count(*)::integer AS count
            FROM e2e_handoff_jobs WHERE payload->>'kind' IN ('cancelled', 'confirmed')`.execute(db)
          return {
            source: entries.find((row) => row.id === booking.id)?.status ?? 'missing',
            bookingCount: entries.length,
            replacementId: receipt?.replacementBookingId,
            replacementConfirmed:
              replacement?.status === 'confirmed' && replacement.rescheduled_from_id === null,
            notificationCount: jobs?.count ?? 0,
          }
        },
        async loseProviderResponse(replacementId) {
          newProvider.controls.meetingHook = async (_target, init) => {
            if (init.method !== 'POST') throw new Error('Expected one synthetic Zoom create')
            newProvider.controls.storedMeetings.set('81234567900', JSON.parse(String(init.body)))
            throw new TypeError('Synthetic acknowledged-lost Zoom response')
          }
          await writeBookingConference(work(newProvider), replacementId)
          newProvider.controls.meetingHook = undefined
        },
        async reconcileProvider(replacementId) {
          await writeBookingConference(work(oldProvider), booking.id)
          await writeBookingConference(work(newProvider), replacementId)
        },
        providerState: () => ({
          newCreates: newProvider.calls.filter(({ init }) => init.method === 'POST').length,
          newMeetings: newProvider.controls.storedMeetings.size,
          oldMeetings: oldProvider.controls.storedMeetings.size,
        }),
        async mail(bookingId, kind, reject = false) {
          const { rows } = await sql<{ payload: unknown }>`SELECT payload FROM e2e_handoff_jobs
            WHERE name=${BOOKING_NOTIFICATION_JOB} AND singleton_key=${`${bookingId}:${kind}`}`.execute(
            db,
          )
          const job = BookingNotificationPayload.safeParse(rows[0]?.payload)
          await sendBookingNotification(
            {
              db,
              publicUrl: url,
              secret,
              now,
              mailer: {
                send: async (message) => {
                  if (reject && message.to === booker)
                    throw new Error('Synthetic mail service unavailable')
                  sent.push(message)
                },
              },
            },
            bookingId,
            kind,
            { handoff: job.success && 'handoff' in job.data ? job.data.handoff : undefined },
          )
        },
        mailState: () =>
          sent.map((message) => {
            const calendar = message.attachments?.[0]?.content ?? ''
            return {
              to: message.to,
              method: /^METHOD:(\w+)/m.exec(calendar)?.[1],
              uid: /^UID:([^\r\n]+)/m.exec(calendar)?.[1],
              sequence: /^SEQUENCE:(\d+)/m.exec(calendar)?.[1],
              hasZoomLink: `${message.text}\n${message.html ?? ''}`.includes(
                'https://us02web.zoom.us/j/',
              ),
            }
          }),
      })
      expect(external).toBe(0)
    } finally {
      try {
        await listener?.close()
      } finally {
        try {
          await authPool?.end()
        } finally {
          await owned.drop()
        }
      }
    }
  },
})

export { expect } from './fixtures.ts'
