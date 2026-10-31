import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import {
  createPublicBooking,
  createPublicTeamBooking,
  type NotificationSettings,
} from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bookingNotifier, type NotificationDeps } from './index.ts'
import { deliverScheduledBookingEmail } from './scheduled.ts'

const NOW = Temporal.Instant.from('2026-11-01T00:00:00Z')
const START = Temporal.Instant.from('2026-11-04T09:00:00Z')
const END = START.add({ minutes: 30 })
const onlyInvitee = { host: false, invitee: true, guests: false }
const reminder: NotificationSettings = {
  reminders: [{ id: 'before', offsetMinutes: 1440, recipients: onlyInvitee }],
  followUps: [],
}
const followUp: NotificationSettings = {
  reminders: [],
  followUps: [{ id: 'after', offsetMinutes: 5, recipients: onlyInvitee }],
}
type Deliver = typeof deliverScheduledBookingEmail
type Replacement = readonly [string, string]
type OrganizerChange = 'unverified' | 'email' | 'member' | 'booking-host' | 'selected-identity'

/** Compile a separate source copy without changing the live implementation or module cache. */
async function moduleCopy<T>(
  filename: string,
  names: string[],
  replacements: Replacement[] = [],
  overrides: Record<string, unknown> = {},
): Promise<T> {
  const url = new URL(filename, import.meta.url)
  let source = readFileSync(url, 'utf8')
  for (const replacement of replacements) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  source = stripTypeScriptTypes(source)
  const dependencies: Record<string, unknown> = {}
  for (const item of [...source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm)]) {
    const specifier = item[2] as string
    const imported = await import(
      specifier.startsWith('.') ? new URL(specifier, url).href : specifier
    )
    for (const binding of (item[1] as string)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      const [name, local] = binding.split(/\s+as\s+/)
      dependencies[local ?? (name as string)] = imported[name as string]
    }
    source = source.replace(item[0], '')
  }
  Object.assign(dependencies, overrides)
  source = source.replace(/^export\s*\{[\s\S]*?\}\s*from '[^']+'\n/gm, '').replace(/\bexport /g, '')
  return new Function(...Object.keys(dependencies), `${source}; return { ${names.join(',')} }`)(
    ...Object.values(dependencies),
  ) as T
}
async function scheduledCopy(
  replacements: Replacement[] = [],
  overrides: Record<string, unknown> = {},
): Promise<Deliver> {
  return (
    await moduleCopy<{ deliverScheduledBookingEmail: Deliver }>(
      './scheduled.ts',
      ['deliverScheduledBookingEmail'],
      replacements,
      overrides,
    )
  ).deliverScheduledBookingEmail
}

describe.skipIf(!process.env.DATABASE_URL)(
  'configured mail conference, claim and transport edge cases',
  () => {
    let owned: TestDatabase
    let db: Db
    let fixtures: Fixtures
    let now: Temporal.Instant
    let sent: MailMessage[]

    beforeAll(async () => {
      owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
        tag: 'scheduled_edges',
      })
      db = createDb(owned.pool)
      fixtures = createFixtures(db)
    })
    afterAll(async () => {
      await owned?.drop()
    })
    beforeEach(async () => {
      now = NOW
      sent = []
      vi.restoreAllMocks()
      await db.deleteFrom('notification_email_sends').execute()
    })
    const queue = { enqueue: async () => randomUUID() }
    const deps = (): NotificationDeps => ({
      db,
      now: () => now,
      secret: 'synthetic-edge-secret',
      publicUrl: 'https://hourmere.example',
      log: () => {},
      mailer: {
        send: async (message) => {
          sent.push(message)
        },
      },
    })

    async function booked(
      settings: NotificationSettings = reminder,
      sameMailbox = false,
      team = false,
    ) {
      let host = await fixtures.host({ timeZone: 'UTC' })
      if (team) {
        const organizationId = await fixtures.organization()
        await fixtures.member(host.userId, organizationId, 'member')
        const organization = await db
          .selectFrom('auth.organization')
          .select('slug')
          .where('id', '=', organizationId)
          .executeTakeFirstOrThrow()
        host = { ...host, organizationId, handle: organization.slug }
      }
      await fixtures.schedule(host.userId, { timeZone: 'UTC' })
      const user = await db
        .selectFrom('auth.user')
        .select(['name', 'email'])
        .where('id', '=', host.userId)
        .executeTakeFirstOrThrow()
      const eventTypeId = await fixtures.eventType(host.organizationId, team ? null : host.userId, {
        slug: 'edges',
        title: 'Planning',
        allowGuests: true,
        hosts: [{ userId: host.userId }],
      })
      await db
        .updateTable('event_types')
        .set({ notifications: JSON.stringify(settings) })
        .where('id', '=', eventTypeId)
        .execute()
      const ctx = { db, now: () => now, notify: bookingNotifier(queue) }
      const result = await (team ? createPublicTeamBooking : createPublicBooking)(ctx, {
        handle: host.handle,
        slug: 'edges',
        start: START,
        invitee: {
          name: 'Invitee',
          email: sameMailbox ? user.email : `invitee-${host.userId}@example.com`,
          timeZone: 'UTC',
        },
      })
      const message = await db
        .selectFrom('booking_scheduled_messages')
        .selectAll()
        .where('booking_id', '=', result.booking.id)
        .executeTakeFirstOrThrow()
      return { host, user, eventTypeId, ctx, result, message }
    }
    type Fixture = Awaited<ReturnType<typeof booked>>
    const current = (b: Fixture) =>
      db
        .selectFrom('booking_scheduled_messages')
        .selectAll()
        .where('id', '=', b.message.id)
        .executeTakeFirstOrThrow()
    const receipts = (b: Fixture) =>
      db
        .selectFrom('booking_notifications')
        .selectAll()
        .where('booking_id', '=', b.result.booking.id)
        .execute()
    const ledger = () => db.selectFrom('notification_email_sends').selectAll().execute()
    const atDue = (b: Fixture) => {
      now = Temporal.Instant.from(b.message.due_at.toISOString())
    }

    async function conference(b: Fixture, state: 'pending' | 'ready' | 'failed') {
      const url = 'https://zoom.us/j/123456789'
      await db
        .updateTable('bookings')
        .set({ location: JSON.stringify({ kind: 'zoom', autoCreate: true, url }) })
        .where('id', '=', b.result.booking.id)
        .execute()
      await db
        .insertInto('booking_conferences')
        .values({
          root_booking_id: b.result.booking.id,
          booking_id: b.result.booking.id,
          organization_id: b.host.organizationId,
          organizer_user_id: b.host.userId,
          invitation_organizer_name: b.user.name,
          invitation_organizer_email: b.user.email,
          provider: 'zoom',
          zoom_connection_id: randomUUID(),
          zoom_user_id: 'synthetic-organizer',
          state,
          revision: 1,
          applied_revision: state === 'ready' ? 1 : 0,
        })
        .execute()
    }

    async function verifyConferenceRecovery(
      kind: 'pending-revision' | 'pinned-organizer',
      deliver: Deliver = deliverScheduledBookingEmail,
    ) {
      const b = await booked()
      await conference(b, kind === 'pending-revision' ? 'pending' : 'ready')
      if (kind === 'pinned-organizer')
        await db
          .updateTable('auth.user')
          .set({ email: `changed-${randomUUID()}@example.com` })
          .where('id', '=', b.host.userId)
          .execute()
      atDue(b)
      await deliver(deps(), b.message.id)
      expect(sent).toHaveLength(0)
      expect(await receipts(b)).toHaveLength(0)
      expect(await current(b)).toMatchObject({
        state: 'pending',
        attempts: 1,
        error_code: 'recipient_retry',
      })
      expect((await current(b)).next_attempt_at.toISOString()).toBe(
        new Date(now.add({ minutes: 1 }).epochMilliseconds).toISOString(),
      )
      if (kind === 'pinned-organizer')
        await db
          .updateTable('auth.user')
          .set({ email: b.user.email })
          .where('id', '=', b.host.userId)
          .execute()
      else
        await db
          .updateTable('booking_conferences')
          .set({ state: 'ready', applied_revision: 1 })
          .where('booking_id', '=', b.result.booking.id)
          .execute()
      now = now.add({ minutes: 1 })
      await deliver(deps(), b.message.id)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.text).toContain('https://zoom.us/j/123456789')
      expect(await current(b)).toMatchObject({ state: 'completed', attempts: 2 })
      expect(await receipts(b)).toHaveLength(1)
    }

    it.each(['pending-revision', 'pinned-organizer'] as const)(
      'retries custom reminder %s and sends when current conference recovers before start',
      (kind) => verifyConferenceRecovery(kind),
    )

    async function verifyNeutralFollowUp(
      state: 'pending' | 'failed',
      deliver: Deliver = deliverScheduledBookingEmail,
    ) {
      const b = await booked(followUp)
      await conference(b, state)
      // The fixed conference identity is unavailable, while an eligible current host remains.
      await db
        .updateTable('auth.user')
        .set({ email: `changed-${randomUUID()}@example.com` })
        .where('id', '=', b.host.userId)
        .execute()
      atDue(b)
      await deliver(deps(), b.message.id)
      expect(sent).toHaveLength(1)
      expect(await current(b)).toMatchObject({ state: 'completed', attempts: 1 })
      expect(sent[0]?.subject).toBe('Scheduled meeting time ended: Planning')
      expect(sent[0]?.text).toContain('The scheduled time')
      expect(sent[0]?.text).not.toMatch(/zoom\.us|#token=|manage|attended|successfully/i)
      expect(sent[0]?.html).toContain('The scheduled time')
      expect(sent[0]?.html).not.toMatch(/zoom\.us|#token=/)
      expect(sent[0]?.attachments).toBeUndefined()
      const saved = await receipts(b)
      expect(saved).toHaveLength(1)
      expect(saved[0]).toMatchObject({
        kind: 'follow_up',
        message_key: 'after',
        manage_token_hash: null,
      })
    }
    it.each(['pending', 'failed'] as const)(
      'neutral follow-up ignores %s conference and unavailable pin, without join URL, management token or ICS',
      (state) => verifyNeutralFollowUp(state),
    )

    async function verifyFollowUpNote(deliver: Deliver = deliverScheduledBookingEmail) {
      const hostNote =
        '<b>Review & reply</b>\r\nhttps://notes.example.com\r\nBcc: literal body text'
      const b = await booked({
        reminders: [],
        followUps: [{ id: 'after', offsetMinutes: 5, recipients: onlyInvitee, hostNote }],
      })
      // Subsequent event edits must not change the immutable note selected at booking time.
      await db
        .updateTable('event_types')
        .set({ notifications: JSON.stringify(followUp) })
        .where('id', '=', b.eventTypeId)
        .execute()
      atDue(b)
      await deliver(deps(), b.message.id)
      expect(sent).toHaveLength(1)
      const email = sent[0]
      if (!email) throw new Error('Missing follow-up email')
      expect(email.text).toContain(hostNote.replaceAll('\r\n', '\n'))
      expect(email.html).toContain('&lt;b&gt;Review &amp; reply&lt;/b&gt;')
      expect(email.html).not.toContain('href="https://notes.example.com')
      expect(email.subject).not.toMatch(/Review|Bcc:|[\r\n]/)
      expect(email.attachments).toBeUndefined()
      expect((await receipts(b))[0]?.manage_token_hash).toBeNull()
      expect(await ledger()).toHaveLength(1)
      await deliver(deps(), b.message.id)
      expect(sent).toHaveLength(1)
      expect(await ledger()).toHaveLength(1)
    }
    it('renders the immutable follow-up note while retaining budget and idempotency', () =>
      verifyFollowUpNote())
    it('detects dropping the stored host note with a real assertion failure', async () => {
      const copy = await scheduledCopy([['hostNote: rule.hostNote,', 'hostNote: undefined,']])
      await expect(verifyFollowUpNote(copy)).rejects.toMatchObject({ name: 'AssertionError' })
    })

    it('uses the host locale and stored booker locale for follow-up copies', async () => {
      const b = await booked({
        reminders: [],
        followUps: [
          {
            id: 'after',
            offsetMinutes: 5,
            recipients: { host: true, invitee: true, guests: true },
            hostNote: 'Shared plain text',
          },
        ],
      })
      await db
        .updateTable('profiles')
        .set({ locale: 'de' })
        .where('user_id', '=', b.host.userId)
        .execute()
      await db
        .updateTable('booking_attendees')
        .set({ locale: 'zh-CN' })
        .where('booking_id', '=', b.result.booking.id)
        .execute()
      await db
        .insertInto('booking_attendees')
        .values({
          booking_id: b.result.booking.id,
          name: 'Guest',
          email: 'guest-locale@example.com',
          is_booker: false,
          time_zone: 'UTC',
          locale: 'fr',
        })
        .execute()
      atDue(b)
      await deliverScheduledBookingEmail(deps(), b.message.id)
      expect(sent).toHaveLength(3)
      expect(sent[0]?.html).toContain('<html lang="de">')
      expect(sent[1]?.html).toContain('<html lang="zh-CN">')
      expect(sent[2]?.html).toContain('<html lang="zh-CN">')
      expect(sent.every((email) => email.text.includes('Shared plain text'))).toBe(true)
      expect(sent[0]?.text).toContain(`/app/bookings/${b.result.booking.id}`)
      expect(sent.slice(1).every((email) => !email.text.includes('/app/bookings/'))).toBe(true)
      expect((await receipts(b)).every((receipt) => receipt.manage_token_hash === null)).toBe(true)
      expect(await ledger()).toHaveLength(3)
    })

    async function waitForBudgetLock() {
      for (let i = 0; i < 500; i++) {
        const { rows } = await owned.pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`,
        )
        if ((rows[0]?.count ?? 0) > 0) return
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error('Worker did not reach budget lock')
    }

    async function verifyBudgetFence(
      change: 'revision' | 'claim' | 'expiry' | 'organizer-reminder' | 'organizer-followup',
      deliver: Deliver = deliverScheduledBookingEmail,
      organizerChange: OrganizerChange = 'unverified',
    ) {
      const b = await booked(
        change === 'expiry' || change === 'organizer-followup' ? followUp : reminder,
        false,
        organizerChange === 'member',
      )
      if (change === 'revision') await conference(b, 'ready')
      if (organizerChange === 'booking-host')
        await fixtures.booking(
          b.host.organizationId,
          [b.host.userId],
          START.add({ hours: 2 }).toString(),
          END.add({ hours: 2 }).toString(),
        )
      if (organizerChange === 'selected-identity') {
        // Deterministically sort after the original so data.hosts[0] is the identity
        // that becomes unavailable while this different eligible host remains.
        const alternate = `ffffffff-ffff-4fff-bfff-${randomUUID().slice(-12)}`
        await db
          .insertInto('auth.user')
          .values({
            id: alternate,
            name: 'Alternate organizer',
            email: `${randomUUID()}@example.com`,
            emailVerified: true,
          })
          .execute()
        await fixtures.member(alternate, b.host.organizationId)
        await db
          .insertInto('booking_hosts')
          .values({ booking_id: b.result.booking.id, user_id: alternate })
          .execute()
      }
      atDue(b)
      const holder = await owned.pool.connect()
      await holder.query('SELECT pg_advisory_lock(1852798057,1835100524)')
      const pending = deliver(deps(), b.message.id)
      pending.catch(() => {})
      const successorClaim = randomUUID()
      try {
        await waitForBudgetLock()
        if (change === 'revision')
          await db
            .updateTable('booking_conferences')
            .set({ revision: 2, applied_revision: 2 })
            .where('booking_id', '=', b.result.booking.id)
            .execute()
        else if (change === 'claim')
          await db
            .updateTable('booking_scheduled_messages')
            .set({ claim_token: successorClaim })
            .where('id', '=', b.message.id)
            .execute()
        else if (change.startsWith('organizer-')) {
          if (organizerChange === 'unverified' || organizerChange === 'selected-identity')
            await db
              .updateTable('auth.user')
              .set({ emailVerified: false })
              .where('id', '=', b.host.userId)
              .execute()
          else if (organizerChange === 'email')
            await db
              .updateTable('auth.user')
              .set({ email: `changed-${randomUUID()}@example.com` })
              .where('id', '=', b.host.userId)
              .execute()
          else if (organizerChange === 'member')
            await db
              .deleteFrom('auth.member')
              .where('userId', '=', b.host.userId)
              .where('organizationId', '=', b.host.organizationId)
              .execute()
          else
            await db
              .deleteFrom('booking_hosts')
              .where('booking_id', '=', b.result.booking.id)
              .where('user_id', '=', b.host.userId)
              .execute()
        } else now = Temporal.Instant.from(b.message.expires_at.toISOString())
      } finally {
        await holder.query('SELECT pg_advisory_unlock(1852798057,1835100524)')
        holder.release()
      }
      await pending
      expect(sent).toHaveLength(0)
      expect(await receipts(b)).toHaveLength(0)
      expect(await ledger()).toHaveLength(0)
      const row = await current(b)
      if (change === 'revision')
        expect(row).toMatchObject({ state: 'pending', attempts: 1, error_code: 'recipient_retry' })
      else if (change === 'claim')
        expect(row).toMatchObject({ state: 'processing', attempts: 1, claim_token: successorClaim })
      else if (change.startsWith('organizer-'))
        expect(row).toMatchObject({ state: 'skipped', attempts: 1, skip_reason: 'no_organizer' })
      else
        expect(row).toMatchObject({
          state: 'skipped',
          attempts: 1,
          skip_reason: 'delivery_window_expired',
        })
    }
    it.each(['revision', 'claim', 'expiry'] as const)(
      'rereads %s after the budget wait and rolls back receipt plus budget debit',
      (change) => verifyBudgetFence(change),
    )
    for (const kind of ['organizer-reminder', 'organizer-followup'] as const) {
      it.each(['unverified', 'email', 'member', 'booking-host', 'selected-identity'] as const)(
        `rereads selected ${kind} %s after the budget wait`,
        (change) => verifyBudgetFence(kind, deliverScheduledBookingEmail, change),
      )
    }

    async function verifyMicrosecondAnchor(
      afterBudgetWait: boolean,
      deliver: Deliver = deliverScheduledBookingEmail,
    ) {
      const b = await booked()
      atDue(b)
      const changeAnchor = () =>
        owned.pool.query(`UPDATE bookings SET end_at=end_at+interval '1 microsecond' WHERE id=$1`, [
          b.result.booking.id,
        ])
      if (afterBudgetWait) {
        const holder = await owned.pool.connect()
        await holder.query('SELECT pg_advisory_lock(1852798057,1835100524)')
        const pending = deliver(deps(), b.message.id)
        pending.catch(() => {})
        try {
          await waitForBudgetLock()
          await changeAnchor()
        } finally {
          await holder.query('SELECT pg_advisory_unlock(1852798057,1835100524)')
          holder.release()
        }
        await pending
      } else {
        await changeAnchor()
        await deliver(deps(), b.message.id)
      }
      // pg's Date parser truncates this difference, so the safety comparison must
      // happen inside PostgreSQL using the full timestamp precision.
      const equality = await owned.pool.query<{ equal: boolean }>(
        `SELECT b.end_at=m.anchor_end_at AS equal FROM bookings b
          JOIN booking_scheduled_messages m ON m.booking_id=b.id WHERE m.id=$1`,
        [b.message.id],
      )
      expect(equality.rows[0]?.equal).toBe(false)
      const booking = await db
        .selectFrom('bookings')
        .select('end_at')
        .where('id', '=', b.result.booking.id)
        .executeTakeFirstOrThrow()
      expect(booking.end_at.getTime()).toBe(b.message.anchor_end_at.getTime())
      expect(await current(b)).toMatchObject({
        state: 'skipped',
        skip_reason: 'anchor_changed',
        attempts: afterBudgetWait ? 1 : 0,
      })
      expect(sent).toHaveLength(0)
      expect(await receipts(b)).toHaveLength(0)
      expect(await ledger()).toHaveLength(0)
    }

    it.each([false, true])(
      'compares exact microsecond booking anchors in PostgreSQL (after budget wait=%s)',
      (afterBudgetWait) => verifyMicrosecondAnchor(afterBudgetWait),
    )

    for (const afterBudgetWait of [false, true]) {
      it.each<[string, Replacement]>([
        [
          'SQL exact equality',
          [
            '(b.start_at=m.anchor_start_at AND b.end_at=m.anchor_end_at) AS anchors_match',
            'true AS anchors_match',
          ],
        ],
        [
          'anchor mismatch guard',
          ["if (!row.anchors_match) return 'anchor_changed'", "if (false) return 'anchor_changed'"],
        ],
      ])(
        `detects removal of %s for microsecond changes with a real assertion failure (after budget wait=${afterBudgetWait})`,
        async (_, replacement) => {
          const copy = await scheduledCopy([replacement])
          await expect(verifyMicrosecondAnchor(afterBudgetWait, copy)).rejects.toMatchObject({
            name: 'AssertionError',
          })
        },
      )
    }

    async function verifyTimeout(
      nearLease: boolean,
      deliver: Deliver = deliverScheduledBookingEmail,
    ) {
      const b = await booked()
      atDue(b)
      const controller = new AbortController()
      const observedTimeouts: number[] = []
      const timed = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
        observedTimeouts.push(milliseconds)
        return controller.signal
      })
      const realDateNow = Date.now()
      const fakeDateNow = realDateNow + 298_000
      const dateSpy = nearLease ? vi.spyOn(Date, 'now').mockReturnValue(fakeDateNow) : undefined
      let capturedLease: Date | null = null
      let observedAbort = false
      const config = deps()
      config.mailer = {
        send: async (_message, options) => {
          capturedLease = (await current(b)).lease_until
          await new Promise<void>((_resolve, reject) => {
            const signal = options?.signal
            expect(signal).toBeDefined()
            if (!signal) throw new Error('Missing SMTP abort signal')
            signal.addEventListener(
              'abort',
              () => {
                observedAbort = true
                reject(signal.reason)
              },
              { once: true },
            )
            controller.abort(new Error('synthetic SMTP deadline'))
          })
        },
      }
      try {
        await deliver(config, b.message.id)
        expect(observedAbort).toBe(true)
        expect(observedTimeouts).toHaveLength(1)
        const timeout = observedTimeouts[0] as number
        expect(timeout).toBeGreaterThan(0)
        expect(timeout).toBeLessThanOrEqual(60_000)
        if (nearLease) {
          expect(timeout).toBeLessThan(2_000)
          expect(timeout).toBeLessThanOrEqual(
            ((capturedLease as Date | null)?.getTime() as number) - fakeDateNow - 1_000,
          )
        } else expect(timeout).toBe(60_000)
        expect(await receipts(b)).toHaveLength(0)
        expect(await ledger()).toHaveLength(0)
        expect(await current(b)).toMatchObject({
          state: 'pending',
          attempts: 1,
          error_code: 'delivery_failed',
          claim_token: null,
          lease_until: null,
        })
      } finally {
        dateSpy?.mockRestore()
        timed.mockRestore()
      }
    }
    it.each([false, true])(
      'bounds SMTP AbortSignal to 60 seconds and remaining lease minus one second (near lease=%s), rolling back on abort',
      (nearLease) => verifyTimeout(nearLease),
    )

    async function verifyBackoff(deliver: Deliver = deliverScheduledBookingEmail) {
      const b = await booked()
      atDue(b)
      const transport = deps()
      const durable: { attempt: number; next: Date }[] = []
      transport.mailer = {
        send: async () => {
          const row = await current(b)
          durable.push({ attempt: row.attempts, next: row.next_attempt_at })
          throw new Error('synthetic transient transport failure')
        },
      }
      for (const [previous, delay] of [
        [0, 60_000],
        [1, 120_000],
        [6, 3_600_000],
        [7, 3_600_000],
      ] as const) {
        await db
          .updateTable('booking_scheduled_messages')
          .set({ attempts: previous, next_attempt_at: new Date(now.epochMilliseconds) })
          .where('id', '=', b.message.id)
          .execute()
        await deliver(transport, b.message.id)
        expect(await current(b)).toMatchObject({
          attempts: previous + 1,
          state: 'pending',
          error_code: 'delivery_failed',
        })
        const expected = new Date(now.epochMilliseconds + delay).toISOString()
        expect((await current(b)).next_attempt_at.toISOString()).toBe(expected)
        expect(
          durable.at(-1)?.next.toISOString(),
          'backoff must be durable before SMTP can crash',
        ).toBe(expected)
        expect(durable.at(-1)?.attempt).toBe(previous + 1)
      }
      expect(await receipts(b)).toHaveLength(0)
      expect(await ledger()).toHaveLength(0)
    }
    it('persists exact one-minute, two-minute and capped one-hour backoff before and after transport', () =>
      verifyBackoff())

    it('a crashed late attempt retains its one-hour backoff after the five-minute claim lease expires', async () => {
      const b = await booked()
      atDue(b)
      await db
        .updateTable('booking_scheduled_messages')
        .set({ attempts: 6 })
        .where('id', '=', b.message.id)
        .execute()
      const crash = await scheduledCopy([
        [
          'const failed = invalidConfiguration',
          "throw new Error('synthetic process stopped'); const failed = invalidConfiguration",
        ],
      ])
      const transport = deps()
      transport.mailer = {
        send: async () => {
          throw new Error('synthetic transport failure')
        },
      }
      await expect(crash(transport, b.message.id)).rejects.toThrow('synthetic process stopped')
      const crashed = await current(b)
      expect(crashed).toMatchObject({ state: 'processing', attempts: 7 })
      expect(crashed.next_attempt_at.toISOString()).toBe(
        new Date(now.add({ hours: 1 }).epochMilliseconds).toISOString(),
      )
      await db
        .updateTable('booking_scheduled_messages')
        .set({ lease_until: new Date(0) })
        .where('id', '=', b.message.id)
        .execute()
      now = now.add({ minutes: 5 })
      await deliverScheduledBookingEmail(deps(), b.message.id)
      expect(await current(b)).toMatchObject({ state: 'processing', attempts: 7 })
      expect(sent).toHaveLength(0)
      now = Temporal.Instant.from(crashed.next_attempt_at.toISOString())
      await deliverScheduledBookingEmail(deps(), b.message.id)
      expect(await current(b)).toMatchObject({ state: 'completed', attempts: 8 })
      expect(sent).toHaveLength(1)
    })

    async function verifyNoRecipients(deliver: Deliver = deliverScheduledBookingEmail) {
      const b = await booked({
        reminders: [
          {
            id: 'guests-only',
            offsetMinutes: 1440,
            recipients: { host: false, invitee: false, guests: true },
          },
        ],
        followUps: [],
      })
      atDue(b)
      await deliver(deps(), b.message.id)
      expect(await current(b)).toMatchObject({
        state: 'skipped',
        skip_reason: 'no_recipients',
        attempts: 1,
      })
      expect(sent).toHaveLength(0)
      expect(await receipts(b)).toHaveLength(0)
      expect(await ledger()).toHaveLength(0)
    }
    it('an absent selected recipient class skips without fabricating a recipient or debiting budget', () =>
      verifyNoRecipients())

    it('host and invitee sharing one mailbox retain separate role receipts and instance debits', async () => {
      const b = await booked(
        {
          reminders: [
            {
              id: 'both',
              offsetMinutes: 1440,
              recipients: { host: true, invitee: true, guests: false },
            },
          ],
          followUps: [],
        },
        true,
      )
      atDue(b)
      await deliverScheduledBookingEmail(deps(), b.message.id)
      expect(sent).toHaveLength(2)
      expect(sent.map((message) => message.to)).toEqual([b.user.email, b.user.email])
      const saved = await receipts(b)
      expect(saved).toHaveLength(2)
      expect(saved.filter((receipt) => receipt.recipient.startsWith('host:'))).toHaveLength(1)
      expect(saved.filter((receipt) => receipt.recipient.startsWith('attendee:'))).toHaveLength(1)
      expect(saved.filter((receipt) => receipt.manage_token_hash !== null)).toHaveLength(1)
      const budget = await ledger()
      expect(budget).toHaveLength(2)
      expect(budget.filter((entry) => entry.recipient_hash === null)).toHaveLength(1)
      expect(budget.filter((entry) => entry.recipient_hash !== null)).toHaveLength(1)
    })

    it('calendar busy-cache updates do not cancel a booking or alter configured message identities', async () => {
      const b = await booked()
      const before = await current(b)
      const cache = await fixtures.calendarBusy(b.host.userId, [[START.toString(), END.toString()]])
      await db
        .updateTable('calendar_busy')
        .set({ external_event_id: 'declined-upstream-event' })
        .where('calendar_id', '=', cache.calendarId)
        .execute()
      expect(await current(b)).toEqual(before)
      expect(
        (
          await db
            .selectFrom('bookings')
            .select('status')
            .where('id', '=', b.result.booking.id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('confirmed')
      atDue(b)
      await deliverScheduledBookingEmail(deps(), b.message.id)
      expect(sent).toHaveLength(1)
      expect((await current(b)).id).toBe(before.id)
    })

    it.each<[string, Replacement]>([
      [
        'conference readiness',
        [
          "if (!(await conferenceNotificationAllowed(db, row.booking_id, 'reminder', true)))",
          'if (false)',
        ],
      ],
      [
        'pinned organizer retry',
        ["if (!organizer && claim.kind === 'reminder' && data.automaticConference)", 'if (false)'],
      ],
    ])('detects broken %s with a real assertion failure', async (name, replacement) => {
      const copy = await scheduledCopy([replacement])
      await expect(
        verifyConferenceRecovery(
          name === 'conference readiness' ? 'pending-revision' : 'pinned-organizer',
          copy,
        ),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    })
    it.each(['organizer-reminder', 'organizer-followup'] as const)(
      'detects removal of the post-budget %s eligibility check with a real assertion failure',
      async (change) => {
        const copy = await scheduledCopy([['if (organizer) {', 'if (false) {']])
        await expect(verifyBudgetFence(change, copy)).rejects.toMatchObject({
          name: 'AssertionError',
        })
      },
    )
    const organizerMutations: [OrganizerChange, Replacement[]][] = [
      ['unverified', [[".where('u.emailVerified', '=', true)", '']]],
      ['email', [[".where('u.email', '=', organizer.email)", '']]],
      [
        'member',
        [
          [
            "join.onRef('m.userId', '=', 'u.id').onRef('m.organizationId', '=', 'b.organization_id')",
            "join.onRef('m.userId', '=', 'u.id')",
          ],
        ],
      ],
      ['booking-host', [[".where('bh.booking_id', '=', claim.booking_id)", '']]],
      [
        'selected-identity',
        [
          [".where('u.id', '=', organizer.id)", ''],
          [".where('u.email', '=', organizer.email)", ''],
        ],
      ],
    ]
    for (const kind of ['organizer-reminder', 'organizer-followup'] as const) {
      it.each(organizerMutations)(
        `detects broken ${kind} %s eligibility with a real assertion failure`,
        async (change, replacements) => {
          const copy = await scheduledCopy(replacements)
          await expect(verifyBudgetFence(kind, copy, change)).rejects.toMatchObject({
            name: 'AssertionError',
          })
        },
      )
    }
    it('detects coordinated removal of both post-budget conference revision fences with a real assertion failure', async () => {
      const exports = ['sendOnce', 'NotificationRetryError']
      const unmodified = await moduleCopy<Record<string, unknown>>('./index.ts', exports)
      await verifyBudgetFence('revision', await scheduledCopy([], unmodified))
      sent = []
      now = NOW
      const broken = await moduleCopy<Record<string, unknown>>('./index.ts', exports, [
        ['(current.conference_revision ?? undefined) !== key.conferenceRevision', 'false'],
      ])
      const copy = await scheduledCopy(
        [['(c?.revision ?? undefined) !== revision', 'false']],
        broken,
      )
      await expect(verifyBudgetFence('revision', copy)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    })
    it('detects applying reminder readiness to follow-ups with a real assertion failure', async () => {
      const copy = await scheduledCopy([["if (row.kind === 'reminder') {", 'if (true) {']])
      await expect(verifyNeutralFollowUp('failed', copy)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    })
    it('detects minting a management capability for follow-up with a real assertion failure', async () => {
      const copy = await scheduledCopy([
        ["links: a.isBooker && claim.kind === 'reminder'", 'links: a.isBooker'],
      ])
      await expect(verifyNeutralFollowUp('pending', copy)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    })
    it.each<[string, Replacement]>([
      ['claim identity', ['row.claim_token !== claim.token ||', '']],
      [
        'delivery stop time',
        ['if (Temporal.Instant.compare(now, instant(row.expires_at)) >= 0)', 'if (false)'],
      ],
    ])(
      'detects removal of post-budget %s with a real assertion failure',
      async (name, replacement) => {
        const copy = await scheduledCopy([replacement])
        await expect(
          verifyBudgetFence(name === 'claim identity' ? 'claim' : 'expiry', copy),
        ).rejects.toMatchObject({ name: 'AssertionError' })
      },
    )
    it.each<[string, Replacement]>([
      ['60-second cap', ['Math.min(60_000, remaining)', 'Math.min(120_000, remaining)']],
      [
        'lease margin',
        ['claim.lease.getTime() - Date.now() - 1000', 'claim.lease.getTime() - Date.now()'],
      ],
    ])('detects removal of SMTP %s with a real assertion failure', async (name, replacement) => {
      const copy = await scheduledCopy([replacement])
      await expect(verifyTimeout(name === 'lease margin', copy)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    })
    it.each<[string, Replacement]>([
      ['exponential backoff', ['60_000 * 2 ** (attempt - 1)', '60_000']],
      [
        'one-hour backoff cap',
        ['Math.min(60_000 * 2 ** (attempt - 1), 3_600_000)', '60_000 * 2 ** (attempt - 1)'],
      ],
      [
        'pre-SMTP durable backoff',
        [`,next_attempt_at=\${asDate(now.add({ milliseconds: RETRY_DELAY(attempt) }))}`, ''],
      ],
    ])('detects removal of %s with a real assertion failure', async (_, replacement) => {
      const copy = await scheduledCopy([replacement])
      await expect(verifyBackoff(copy)).rejects.toMatchObject({ name: 'AssertionError' })
    })
    it('detects treating absent recipients as completed with a real assertion failure', async () => {
      const copy = await scheduledCopy([
        ["if (!recipients.length) throw new ScheduledObsolete('no_recipients')", ''],
      ])
      await expect(verifyNoRecipients(copy)).rejects.toMatchObject({ name: 'AssertionError' })
    })
  },
)
