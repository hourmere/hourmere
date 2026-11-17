import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { groupFixture, occupiedSlot } from '../../db/src/group-seats-fixtures.ts'
import { createFixtures } from '../../scheduling/src/testing.ts'
import { createCalDavCredentialRecord } from './caldav-credentials.ts'
import type { CalDavRequest, CalDavResponse } from './caldav-transport.ts'
import { createCalDavWriteClient } from './caldav-write-client.ts'
import { calDavBookingNotifier, writeCalDavBooking } from './caldav-writeback.ts'
import { calDavBookingJob } from './caldav-writeback-jobs.ts'
import { TEST_CALENDAR_KEY } from './testing.ts'

const now = () => Date.parse('2026-11-01T12:00:00Z')
const secret = 'synthetic-caldav-password'
function fakeServer() {
  const resources = new Map<string, { body: string; etag: string }>()
  const calls: { method: string; url: string; body: string; etag?: string; create?: string }[] = []
  let revision = 0
  const controls = {
    fail: false,
    hook: undefined as
      | ((request: CalDavRequest) => Promise<CalDavResponse | undefined>)
      | undefined,
  }
  const client = createCalDavWriteClient(async (request) => {
    const method = request.method ?? 'PROPFIND'
    calls.push({
      method,
      url: request.url,
      body: request.body,
      etag: request.ifMatch,
      create: request.ifNoneMatch,
    })
    if (controls.fail) return { status: 503, body: secret }
    const override = await controls.hook?.(request)
    if (override) return override
    const saved = resources.get(request.url)
    if (method === 'GET') return saved ? { status: 200, ...saved } : { status: 404, body: '' }
    if (method === 'PUT') {
      if (
        (request.ifNoneMatch === '*' && saved) ||
        (request.ifMatch && saved?.etag !== request.ifMatch)
      )
        return { status: saved || request.ifNoneMatch ? 412 : 404, body: '' }
      expect(request.ifMatch || request.ifNoneMatch).toBeTruthy()
      const value = { body: request.body, etag: `"${++revision}"` }
      resources.set(request.url, value)
      return { status: saved ? 204 : 201, body: '', etag: value.etag }
    }
    if (method === 'DELETE') {
      if (!saved) return { status: 404, body: '' }
      if (request.ifMatch !== saved.etag) return { status: 412, body: '' }
      resources.delete(request.url)
      return { status: 204, body: '' }
    }
    throw new Error('Unexpected synthetic DAV request')
  })
  return {
    client,
    resources,
    calls,
    controls,
    writes: () => calls.filter((c) => c.method === 'PUT' || c.method === 'DELETE'),
  }
}

describe.skipIf(!process.env.DATABASE_URL)(
  'CalDAV booking writeback with synthetic DAV servers',
  () => {
    let database: TestDatabase, db: Db
    beforeAll(async () => {
      database = await createTestDatabase(process.env.DATABASE_URL as string)
      db = createDb(database.pool)
    })
    afterAll(async () => {
      await database?.drop()
    })
    async function connect(userId: string, style = 'nextcloud') {
      const path =
        style === 'icloud' ? '/123456/calendars/work/' : '/remote.php/dav/calendars/host/work/'
      const calendarUrl = `https://dav.example.com${path}`
      const record = createCalDavCredentialRecord(
        Buffer.from(TEST_CALENDAR_KEY, 'base64'),
        userId,
        {
          serverUrl: 'https://dav.example.com/',
          username: `synthetic-${userId}`,
          password: secret,
        },
      )
      await db.insertInto('calendar_connections').values(record).execute()
      const calendar = await db
        .insertInto('calendars')
        .values({
          connection_id: record.id,
          external_id: calendarUrl,
          name: 'Work',
          access_role: 'writer',
          check_conflicts: false,
          sync_state: { caldavDiscovery: { version: 1, available: true, color: null } },
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return { calendarId: calendar.id, connectionId: record.id, calendarUrl }
    }
    async function setup(style = 'nextcloud') {
      const f = createFixtures(db),
        host = await f.host()
      const destination = await connect(host.userId, style)
      await db
        .updateTable('profiles')
        .set({ destination_calendar_id: destination.calendarId })
        .where('user_id', '=', host.userId)
        .execute()
      const provider = fakeServer()
      const deps = { db, encryptionKey: TEST_CALENDAR_KEY, client: provider.client, now }
      const booking = async (start = '2026-11-02T10:00:00Z', end = '2026-11-02T10:30:00Z') =>
        f.booking(host.organizationId, [host.userId], start, end)
      const notify = (bookingId: string) =>
        db.transaction().execute((trx) =>
          calDavBookingNotifier({ enqueue: async () => null })(trx, {
            bookingId,
            type: 'created',
          }),
        )
      return { f, host, ...destination, provider, deps, booking, notify }
    }
    async function cancel(id: string) {
      await db
        .updateTable('bookings')
        .set({ status: 'cancelled', cancelled_at: new Date(now()) })
        .where('id', '=', id)
        .execute()
    }
    async function reschedule(s: Awaited<ReturnType<typeof setup>>, root: string) {
      await cancel(root)
      const next = await s.booking('2026-11-03T11:00:00Z', '2026-11-03T11:30:00Z')
      await db
        .updateTable('bookings')
        .set({ rescheduled_from_id: root })
        .where('id', '=', next)
        .execute()
      await s.notify(next)
      return next
    }
    it.each(['nextcloud', 'icloud'])(
      'creates, updates and deletes one stable resource with idempotent jobs (%s)',
      async (style) => {
        const s = await setup(style),
          root = await s.booking()
        await s.notify(root)
        const job = calDavBookingJob(s.deps)
        const run = { id: randomUUID(), attempt: 1, signal: new AbortController().signal }
        await job.handler({ bookingId: root }, run)
        await job.handler({ bookingId: root }, run)
        expect(s.provider.writes()).toHaveLength(1)
        const href = `${s.calendarUrl}${root}.ics`
        expect(s.provider.resources.size).toBe(1)
        expect(s.provider.resources.get(href)?.body).toContain(`UID:${root}\r\n`)
        expect(s.provider.resources.get(href)?.body).toContain('SEQUENCE:0\r\n')
        expect(s.provider.resources.get(href)?.body).not.toMatch(
          /ATTENDEE|invitee@example.com|METHOD:REQUEST/,
        )
        expect(s.provider.writes()[0]?.create).toBe('*')
        const originalEtag = s.provider.resources.get(href)?.etag
        const next = await reschedule(s, root)
        await db
          .updateTable('profiles')
          .set({ destination_calendar_id: null })
          .where('user_id', '=', s.host.userId)
          .execute()
        await job.handler({ bookingId: next }, run)
        await job.handler({ bookingId: root }, run)
        expect(s.provider.writes()).toHaveLength(2)
        expect(s.provider.writes()[1]).toMatchObject({ url: href, etag: originalEtag })
        expect(s.provider.resources.get(href)?.body).toContain('SEQUENCE:1\r\n')
        expect(s.provider.resources.get(href)?.body).toContain('DTSTART:20261103T110000Z')
        const updatedEtag = s.provider.resources.get(href)?.etag
        await cancel(next)
        await job.handler({ bookingId: root }, run)
        await job.handler({ bookingId: next }, run)
        expect(s.provider.resources.size).toBe(0)
        expect(s.provider.writes()).toHaveLength(3)
        expect(s.provider.writes()[2]).toMatchObject({
          method: 'DELETE',
          url: href,
          etag: updatedEtag,
        })
      },
    )
    it('preserves externally edited resources after update and delete precondition conflicts', async () => {
      for (const operation of ['update', 'delete']) {
        const s = await setup(),
          root = await s.booking()
        await s.notify(root)
        await writeCalDavBooking(s.deps, { bookingId: root })
        const href = `${s.calendarUrl}${root}.ics`
        const next = operation === 'update' ? await reschedule(s, root) : root
        if (operation === 'delete') await cancel(root)
        let raced = false
        s.provider.controls.hook = async (request) => {
          if (!raced && request.method === (operation === 'update' ? 'PUT' : 'DELETE')) {
            raced = true
            const saved = s.provider.resources.get(href)
            if (!saved) throw new Error('Missing synthetic resource')
            s.provider.resources.set(href, {
              body: saved.body.replace('SUMMARY:Fixture booking', 'SUMMARY:Host edited'),
              etag: '"external"',
            })
            return { status: 412, body: '' }
          }
        }
        await expect(writeCalDavBooking(s.deps, { bookingId: next })).rejects.toMatchObject({
          code: 'conflict',
        })
        expect(raced).toBe(true)
        expect(s.provider.resources.get(href)).toMatchObject({ etag: '"external"' })
        expect(s.provider.resources.get(href)?.body).toContain('Host edited')
        expect(s.provider.writes()).toHaveLength(2)
        expect(
          (
            await db
              .selectFrom('calendar_connections')
              .select('last_error')
              .where('id', '=', s.connectionId)
              .executeTakeFirstOrThrow()
          ).last_error,
        ).toBe('provider_unavailable')
      }
    })
    it('recognizes an already-applied update and deletion after a 412 without an unconditional retry', async () => {
      const s = await setup(),
        root = await s.booking()
      await s.notify(root)
      await writeCalDavBooking(s.deps, { bookingId: root })
      const next = await reschedule(s, root)
      let raced = false
      s.provider.controls.hook = async (request) => {
        if (request.method === 'PUT' && !raced) {
          raced = true
          s.provider.resources.set(request.url, { body: request.body, etag: '"applied"' })
          return { status: 412, body: '' }
        }
      }
      await writeCalDavBooking(s.deps, { bookingId: next })
      expect(s.provider.writes()).toHaveLength(2)
      await cancel(next)
      s.provider.controls.hook = async (request) => {
        if (request.method === 'DELETE') {
          s.provider.resources.delete(request.url)
          return { status: 412, body: '' }
        }
      }
      await writeCalDavBooking(s.deps, { bookingId: next })
      await writeCalDavBooking(s.deps, { bookingId: root })
      expect(s.provider.writes()).toHaveLength(3)
      expect(s.provider.resources.size).toBe(0)
    })
    it('serializes concurrent jobs for separate bookings on one connection', async () => {
      const s = await setup(),
        first = await s.booking(),
        second = await s.booking('2026-11-03T10:00:00Z', '2026-11-03T10:30:00Z')
      await s.notify(first)
      await s.notify(second)
      let active = 0,
        maximum = 0
      s.provider.controls.hook = async () => {
        active++
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 20))
        active--
      }
      await Promise.all([
        writeCalDavBooking(s.deps, { bookingId: first }),
        writeCalDavBooking(s.deps, { bookingId: second }),
      ])
      expect(maximum).toBe(1)
      expect(s.provider.resources.size).toBe(2)
    })
    it('recovers an acknowledged create whose response was lost without duplicating the event', async () => {
      const s = await setup(),
        root = await s.booking()
      await s.notify(root)
      let lost = false
      s.provider.controls.hook = async (request) => {
        if (request.method === 'PUT' && !lost) {
          lost = true
          s.provider.resources.set(request.url, { body: request.body, etag: '"lost"' })
          throw new Error(secret)
        }
      }
      await expect(writeCalDavBooking(s.deps, { bookingId: root })).rejects.toThrow()
      await writeCalDavBooking(s.deps, { bookingId: root })
      expect(s.provider.resources.size).toBe(1)
      expect(s.provider.writes()).toHaveLength(1)
      expect(
        await db
          .selectFrom('booking_calendar_events')
          .select('external_event_id')
          .where('booking_id', '=', root)
          .execute(),
      ).toEqual([{ external_event_id: `${s.calendarUrl}${root}.ics` }])
    })
    it('removes an owned create with a lost response when cancellation arrives before replay', async () => {
      const s = await setup(),
        root = await s.booking()
      await s.notify(root)
      let lost = false
      s.provider.controls.hook = async (request) => {
        if (request.method === 'PUT' && !lost) {
          lost = true
          s.provider.resources.set(request.url, { body: request.body, etag: '"lost"' })
          throw new Error(secret)
        }
      }
      await expect(writeCalDavBooking(s.deps, { bookingId: root })).rejects.toThrow()
      expect(s.provider.resources.size).toBe(1)
      expect(
        await db
          .selectFrom('booking_calendar_events')
          .selectAll()
          .where('booking_id', '=', root)
          .execute(),
      ).toEqual([])
      await cancel(root)
      await writeCalDavBooking(s.deps, { bookingId: root })
      await writeCalDavBooking(s.deps, { bookingId: root })
      expect(s.provider.resources.size).toBe(0)
      expect(s.provider.writes()).toHaveLength(2)
      expect(s.provider.writes()[1]).toMatchObject({ method: 'DELETE', etag: '"lost"' })
    })
    it('conditionally cancels an authenticated update whose success response was lost', async () => {
      const s = await setup(),
        root = await s.booking()
      await s.notify(root)
      await writeCalDavBooking(s.deps, { bookingId: root })
      const next = await reschedule(s, root)
      let lost = false
      s.provider.controls.hook = async (request) => {
        if (request.method === 'PUT' && !lost) {
          lost = true
          s.provider.resources.set(request.url, { body: request.body, etag: '"lost-update"' })
          throw new Error(secret)
        }
      }
      await expect(writeCalDavBooking(s.deps, { bookingId: next })).rejects.toThrow()
      await cancel(next)
      await writeCalDavBooking(s.deps, { bookingId: next })
      await writeCalDavBooking(s.deps, { bookingId: root })
      expect(s.provider.resources.size).toBe(0)
      expect(s.provider.writes()).toHaveLength(4)
      expect(s.provider.writes()[3]).toMatchObject({ method: 'DELETE', etag: '"lost-update"' })
    })
    it('updates a signed lost-create response to the latest successor without changing its resource', async () => {
      const s = await setup(),
        root = await s.booking()
      await s.notify(root)
      let lost = false
      s.provider.controls.hook = async (request) => {
        if (request.method === 'PUT' && !lost) {
          lost = true
          s.provider.resources.set(request.url, { body: request.body, etag: '"lost-create"' })
          throw new Error(secret)
        }
      }
      await expect(writeCalDavBooking(s.deps, { bookingId: root })).rejects.toThrow()
      const next = await reschedule(s, root)
      await writeCalDavBooking(s.deps, { bookingId: root })
      await writeCalDavBooking(s.deps, { bookingId: next })
      expect(s.provider.resources.size).toBe(1)
      expect(s.provider.writes()).toHaveLength(2)
      expect(s.provider.writes()[1]).toMatchObject({
        url: `${s.calendarUrl}${root}.ics`,
        etag: '"lost-create"',
      })
      expect(s.provider.resources.get(`${s.calendarUrl}${root}.ics`)?.body).toContain(
        'DTSTART:20261103T110000Z',
      )
    })
    it('rechecks cancellation committed during a provider write before returning', async () => {
      const s = await setup(),
        root = await s.booking()
      await s.notify(root)
      let cancelled = false
      s.provider.controls.hook = async (request) => {
        if (request.method === 'PUT' && !cancelled) {
          cancelled = true
          await cancel(root)
        }
      }
      await writeCalDavBooking(s.deps, { bookingId: root })
      expect(cancelled).toBe(true)
      expect(s.provider.resources.size).toBe(0)
      expect(s.provider.writes().map((request) => request.method)).toEqual(['PUT', 'DELETE'])
      await writeCalDavBooking(s.deps, { bookingId: root })
      expect(s.provider.writes()).toHaveLength(2)
    })
    it('reconciles a lost update response to a newer successor before replay', async () => {
      const s = await setup(),
        root = await s.booking()
      await s.notify(root)
      await writeCalDavBooking(s.deps, { bookingId: root })
      const next = await reschedule(s, root)
      let lost = false
      s.provider.controls.hook = async (request) => {
        if (request.method === 'PUT' && !lost) {
          lost = true
          s.provider.resources.set(request.url, { body: request.body, etag: '"lost-update"' })
          throw new Error(secret)
        }
      }
      await expect(writeCalDavBooking(s.deps, { bookingId: next })).rejects.toThrow()
      await cancel(next)
      const newest = await s.booking('2026-11-04T12:00:00Z', '2026-11-04T12:30:00Z')
      await db
        .updateTable('bookings')
        .set({ rescheduled_from_id: next })
        .where('id', '=', newest)
        .execute()
      await s.notify(newest)
      await writeCalDavBooking(s.deps, { bookingId: root })
      const appliedWrites = s.provider.writes().length
      await writeCalDavBooking(s.deps, { bookingId: newest })
      expect(s.provider.writes()).toHaveLength(appliedWrites)
      expect(s.provider.resources.size).toBe(1)
      const resource = s.provider.resources.get(`${s.calendarUrl}${root}.ics`)
      expect(resource?.body).toContain('DTSTART:20261104T120000Z')
      expect(resource?.body).toContain('SEQUENCE:2')
      expect(s.provider.writes().at(-1)).toMatchObject({
        method: 'PUT',
        url: `${s.calendarUrl}${root}.ics`,
        etag: '"lost-update"',
      })
      expect(
        await db
          .selectFrom('booking_calendar_events')
          .select('etag')
          .where('booking_id', '=', newest)
          .executeTakeFirstOrThrow(),
      ).toEqual({ etag: resource?.etag })
    })
    it('does not recreate an externally deleted update and accepts a known missing cancellation', async () => {
      const s = await setup(),
        root = await s.booking()
      await s.notify(root)
      await writeCalDavBooking(s.deps, { bookingId: root })
      const next = await reschedule(s, root)
      s.provider.resources.clear()
      await expect(writeCalDavBooking(s.deps, { bookingId: next })).rejects.toMatchObject({
        code: 'conflict',
      })
      expect(s.provider.writes()).toHaveLength(1)
      await cancel(next)
      await writeCalDavBooking(s.deps, { bookingId: next })
      await writeCalDavBooking(s.deps, { bookingId: root })
      expect(s.provider.resources.size).toBe(0)
      expect(s.provider.writes().map((request) => request.method)).toEqual(['PUT', 'DELETE'])
    })
    it('uses UTC instants across a DST fold and keeps invitee/contact data out of calendar copies', async () => {
      const s = await setup()
      const root = await s.booking('2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z')
      await s.notify(root)
      await writeCalDavBooking(s.deps, { bookingId: root })
      const body = [...s.provider.resources.values()][0]?.body
      expect(body).toContain('DTSTART:20261101T083000Z')
      expect(body).toContain('DTEND:20261101T093000Z')
      expect(body).not.toMatch(/TZID|VTIMEZONE|invitee@example.com|ATTENDEE/)
    })
    it('refuses foreign destination selection, forged targets and imported bookings before network access', async () => {
      const s = await setup(),
        other = await s.f.host()
      const foreign = await connect(other.userId)
      await db
        .updateTable('profiles')
        .set({ destination_calendar_id: foreign.calendarId })
        .where('user_id', '=', s.host.userId)
        .execute()
      const root = await s.booking()
      await s.notify(root)
      expect(
        await db
          .selectFrom('booking_calendar_targets')
          .selectAll()
          .where('root_booking_id', '=', root)
          .execute(),
      ).toEqual([])
      await db
        .insertInto('booking_calendar_targets')
        .values({ root_booking_id: root, user_id: s.host.userId, calendar_id: foreign.calendarId })
        .execute()
      await writeCalDavBooking(s.deps, { bookingId: root })
      const imported = await s.f.booking(
        s.host.organizationId,
        [s.host.userId],
        '2026-11-05T10:00:00Z',
        '2026-11-05T10:30:00Z',
        { source: 'import' },
      )
      await db
        .insertInto('booking_calendar_targets')
        .values({ root_booking_id: imported, user_id: s.host.userId, calendar_id: s.calendarId })
        .execute()
      await writeCalDavBooking(s.deps, { bookingId: imported })
      expect(s.provider.calls).toEqual([])
    })
    it('writes each collective host destination independently', async () => {
      const s = await setup(),
        other = await s.f.host()
      const destination = await connect(other.userId, 'icloud')
      await db
        .updateTable('profiles')
        .set({ destination_calendar_id: destination.calendarId })
        .where('user_id', '=', other.userId)
        .execute()
      const root = await s.f.booking(
        s.host.organizationId,
        [s.host.userId, other.userId],
        '2026-11-02T10:00:00Z',
        '2026-11-02T10:30:00Z',
      )
      await s.notify(root)
      await writeCalDavBooking(s.deps, { bookingId: root })
      expect(s.provider.resources.size).toBe(2)
      expect(
        await db
          .selectFrom('booking_calendar_events')
          .select('calendar_id')
          .where('booking_id', '=', root)
          .execute(),
      ).toHaveLength(2)
    })
    it('writes one private group slot resource and deletes only after its final seat leaves', async () => {
      const f = await groupFixture(database.pool),
        destination = await connect(f.host)
      const { slot, bookings } = await occupiedSlot(f, 2, {
        destination_calendar_id: destination.calendarId,
      })
      const provider = fakeServer(),
        deps = { db, encryptionKey: TEST_CALENDAR_KEY, client: provider.client, now }
      await writeCalDavBooking(deps, { groupSlotId: slot })
      await writeCalDavBooking(deps, { groupSlotId: slot })
      expect(provider.resources.size).toBe(1)
      expect(provider.writes()).toHaveLength(1)
      const body = [...provider.resources.values()][0]?.body
      expect(body).toContain(`UID:group-${slot}@hourmere`)
      expect(body).toContain('DESCRIPTION:2')
      for (const booking of bookings) expect(body).not.toContain(booking)
      const [firstSeat, lastSeat] = bookings
      if (!firstSeat || !lastSeat) throw new Error('Missing synthetic seats')
      await cancel(firstSeat)
      await writeCalDavBooking(deps, { groupSlotId: slot })
      expect([...provider.resources.values()][0]?.body).toContain('DESCRIPTION:1')
      await cancel(lastSeat)
      await writeCalDavBooking(deps, { groupSlotId: slot })
      await writeCalDavBooking(deps, { groupSlotId: slot })
      expect(provider.resources.size).toBe(0)
      expect(provider.writes()).toHaveLength(3)
    })
    it('retries transient failures through bounded durable jobs without logging credentials', async () => {
      const s = await setup(),
        root = await s.booking()
      await s.notify(root)
      s.provider.controls.fail = true
      const messages: unknown[] = []
      const job = calDavBookingJob(s.deps)
      expect(job.retry).toMatchObject({ limit: 5, backoff: true })
      const jobs = createJobs({
        connectionString: database.url,
        definitions: [job],
        work: true,
        migrate: true,
        maxConnections: 2,
        pollingIntervalSeconds: 0.5,
        log: (...args) => {
          messages.push(args)
        },
      })
      try {
        await jobs.start()
        const id = await jobs.enqueue(job.name, { bookingId: root }, { singletonKey: root })
        await vi.waitFor(
          async () => {
            const result = await database.pool.query(
              'SELECT state,retry_limit,retry_backoff,start_after>now() AS delayed FROM pgboss.job WHERE id=$1',
              [id],
            )
            expect(result.rows[0]).toMatchObject({
              state: 'retry',
              retry_limit: 5,
              retry_backoff: true,
              delayed: true,
            })
          },
          { timeout: 10000, interval: 50 },
        )
        s.provider.controls.fail = false
        await database.pool.query('UPDATE pgboss.job SET start_after=now() WHERE id=$1', [id])
        await vi.waitFor(
          async () => {
            const result = await database.pool.query(
              'SELECT state,retry_count FROM pgboss.job WHERE id=$1',
              [id],
            )
            expect(result.rows[0]).toMatchObject({ state: 'completed', retry_count: 1 })
          },
          { timeout: 10000, interval: 50 },
        )
        expect(s.provider.resources.size).toBe(1)
        expect(JSON.stringify(messages)).not.toContain(secret)
        expect(JSON.stringify(messages)).not.toContain(`synthetic-${s.host.userId}`)
      } finally {
        await jobs.stop()
      }
    }, 30000)
  },
)
