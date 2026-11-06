import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { conferenceJoinUrl } from '@hourmere/scheduling/conference-url'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  groupFixture,
  insertSeat,
  insertSlot,
  transaction,
} from '../../db/src/group-seats-fixtures.ts'
import {
  automaticConference,
  automaticZoom,
  bookingConferenceViews,
  conferenceOrganizerAvailable,
  evaluateGoogleWriteDestination,
  releaseGroupSeatInvitations,
  requireMeetDestination,
  requireZoomConnection,
} from '../../scheduling/src/conferences.ts'
import { DomainError } from '../../scheduling/src/errors.ts'
import {
  cancelGroupSlotConference,
  prepareGroupSlotConference,
} from '../../scheduling/src/group-conferences.ts'
import { cleanText } from '../../scheduling/src/text.ts'
import { runConferenceProviderWork } from './conferences.ts'
import { encryptCredential } from './credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from './google.ts'
import { writeGroupSlotConference } from './group-conferences.ts'
import { groupSlotCalendarUid, writeGroupSlotCalendar } from './group-slot-events.ts'
import { type CalendarDeps, tokenAad } from './index.ts'
import { fakeGoogle, TEST_CALENDAR_KEY } from './testing.ts'

function prepareCopy(change?: readonly [string, string]): typeof prepareGroupSlotConference {
  const original = readFileSync(
    new URL('../../scheduling/src/group-conferences.ts', import.meta.url),
    'utf8',
  )
  let source = original.slice(
    original.indexOf('export async function prepareGroupSlotConference'),
    original.indexOf('/** Count-only exits'),
  )
  if (change) {
    expect(source).toContain(change[0])
    source = source.replace(...change)
  }
  const bindings = {
    automaticConference,
    automaticZoom,
    conferenceOrganizerAvailable,
    evaluateGoogleWriteDestination,
    requireMeetDestination,
    requireZoomConnection,
    releaseGroupSeatInvitations,
    DomainError,
    cleanText,
  }
  return new Function(
    ...Object.keys(bindings),
    `${stripTypeScriptTypes(source).replace(/\bexport /g, '')};return prepareGroupSlotConference`,
  )(...Object.values(bindings))
}
const serverUrl = process.env.DATABASE_URL
const now = Temporal.Instant.from('2031-12-30T10:00Z')
function workerCopy(change?: readonly [string, string]): typeof writeGroupSlotConference {
  const original = readFileSync(new URL('./group-conferences.ts', import.meta.url), 'utf8')
  let source = original.slice(original.indexOf('export async function writeGroupSlotConference'))
  if (change) {
    expect(source).toContain(change[0])
    source = source.replace(...change)
  }
  const bindings = {
    randomUUID,
    sql,
    conferenceJoinUrl,
    conferenceOrganizerAvailable,
    releaseGroupSeatInvitations,
    runConferenceProviderWork,
    groupSlotCalendarUid,
    writeGroupSlotCalendar,
    clock: (deps: CalendarDeps) => new Date((deps.now ?? Date.now)()),
  }
  return new Function(
    ...Object.keys(bindings),
    `${stripTypeScriptTypes(source).replace(/\bexport /g, '')}; return writeGroupSlotConference`,
  )(...Object.values(bindings))
}

describe.skipIf(!serverUrl)('slot-owned automatic conferences', () => {
  let owned: TestDatabase, db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'group_conf' })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function fixture(zoom = false) {
    const f = await groupFixture(owned.pool)
    await db
      .insertInto('auth.member')
      .values({
        organizationId: f.organization,
        userId: f.host,
        role: 'owner',
        createdAt: new Date(now.epochMilliseconds),
      })
      .execute()
    const account = `test-${f.host}`
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: f.host,
        provider: 'google',
        external_account_id: account,
        scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
        credentials: encryptCredential(
          Buffer.from(TEST_CALENDAR_KEY, 'base64'),
          tokenAad(f.host, account),
          JSON.stringify({
            accessToken: 'fake',
            refreshToken: 'fake',
            expiresAt: now.epochMilliseconds + 86_400_000,
          }),
        ),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const calendar = await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: 'private-calendar',
        name: 'Calendar',
        access_role: 'owner',
        supports_google_meet: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('profiles')
      .values({
        user_id: f.host,
        time_zone: 'UTC',
        handle: `h-${f.host}`,
        destination_calendar_id: calendar.id,
      })
      .execute()
    const zoomConnection = zoom
      ? await db
          .insertInto('conference_connections')
          .values({
            user_id: f.host,
            provider: 'zoom',
            external_user_id: `zoom-${f.host}`,
            mode: 'meetings',
            status: 'active',
            credentials: Buffer.from('synthetic'),
            scopes: [
              'user:read:user',
              'meeting:write:meeting',
              'meeting:read:meeting',
              'meeting:update:meeting',
              'meeting:delete:meeting',
            ],
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      : undefined
    const occupied = await transaction(owned.pool, async (client) => {
      const option = { id: 'legacy', kind: zoom ? 'zoom' : 'google_meet', autoCreate: true }
      const slot = await insertSlot(client, f, {
        destination_calendar_id: calendar.id,
        location: { kind: zoom ? 'zoom' : 'google_meet', autoCreate: true },
        zoom_connection_id: zoomConnection?.id ?? null,
        location_option: option,
      })
      await client.query('INSERT INTO booking_hosts(group_slot_id,user_id) VALUES ($1,$2)', [
        slot,
        f.host,
      ])
      const bookings = []
      for (let i = 0; i < 2; i++)
        bookings.push(await insertSeat(client, f, slot, undefined, { location_option: option }))
      return { slot, bookings }
    })
    // SQL fixture deliberately supplies the shared choice on each seat.
    const provider = fakeGoogle(() => now.epochMilliseconds)
    provider.controls.conferencePollsBeforeReady = 0
    const deps: CalendarDeps = {
      db,
      now: () => now.epochMilliseconds,
      google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
    }
    const ctx = { db, now: () => now, automaticMeet: true, automaticZoom: true }
    await db.transaction().execute((trx) => prepareGroupSlotConference(ctx, trx, occupied.slot))
    return { f, ...occupied, provider, deps, ctx, calendar }
  }
  it('creates one private shared Meet and preserves it through a join and non-final cancellation', async () => {
    const { f, slot, bookings, provider, deps, ctx } = await fixture()
    await writeGroupSlotConference(deps, slot)
    await writeGroupSlotConference(deps, slot)
    const intent = await db
      .selectFrom('group_slot_conferences')
      .selectAll()
      .where('group_slot_id', '=', slot)
      .executeTakeFirstOrThrow()
    expect(intent.state).toBe('ready')
    expect(provider.controls.storedEvents.size).toBe(1)
    const event = [...provider.controls.storedEvents.values()][0]
    expect(event?.iCalUID).toBe(groupSlotCalendarUid(slot))
    expect(event?.attendees).toBeUndefined()
    expect(event?.description).toBe('2')
    const views = await bookingConferenceViews(db, bookings)
    for (const id of bookings)
      expect(views.get(id)?.location).toEqual({
        kind: 'google_meet',
        autoCreate: true,
        url: 'https://meet.google.com/abc-defg-hij',
      })
    await transaction(owned.pool, (client) =>
      insertSeat(client, f, slot, 'third@example.test', {
        location_option: { id: 'legacy', kind: 'google_meet', autoCreate: true },
      }),
    )
    await db.transaction().execute((trx) => prepareGroupSlotConference(ctx, trx, slot))
    expect(
      await db
        .selectFrom('booking_conference_notifications')
        .selectAll()
        .where('kind', '=', 'confirmed')
        .execute(),
    ).toHaveLength(3)
    await owned.pool.query(
      "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1",
      [bookings[0]],
    )
    await db.transaction().execute((trx) => cancelGroupSlotConference(trx, slot, now))
    const after = await db
      .selectFrom('group_slot_conferences')
      .selectAll()
      .where('group_slot_id', '=', slot)
      .executeTakeFirstOrThrow()
    expect(after).toEqual(intent)
    expect(
      (await bookingConferenceViews(db, [bookings[0] as string])).get(bookings[0] as string)
        ?.location,
    ).toEqual({ kind: 'google_meet', autoCreate: true })
    expect(provider.controls.storedEvents.size).toBe(1)
  })
  it('retirement cleans the old generation and never publishes its late create URL', async () => {
    const { slot, bookings, deps, provider } = await fixture()
    const original = provider.client.importEvent
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    provider.client.importEvent = async (...args) => {
      const result = await original(...args)
      entered()
      await wait
      return result
    }
    const writing = writeGroupSlotConference(deps, slot)
    await started
    await owned.pool.query(
      "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=ANY($1::uuid[])",
      [bookings],
    )
    await db.transaction().execute((trx) => cancelGroupSlotConference(trx, slot, now))
    release()
    await writing
    let intent = await db
      .selectFrom('group_slot_conferences')
      .selectAll()
      .where('group_slot_id', '=', slot)
      .executeTakeFirstOrThrow()
    expect(intent.join_url).toBeNull()
    expect(intent.state).toBe('pending')
    expect(intent.external_event_id).toBeTruthy()
    await writeGroupSlotConference(deps, slot)
    intent = await db
      .selectFrom('group_slot_conferences')
      .selectAll()
      .where('group_slot_id', '=', slot)
      .executeTakeFirstOrThrow()
    expect(intent.join_url).toBeNull()
    expect([...provider.controls.storedEvents.values()][0]?.status).toBe('cancelled')
    expect(
      await db
        .selectFrom('booking_conference_notifications')
        .selectAll()
        .where('booking_id', 'in', bookings)
        .execute(),
    ).toEqual([])
  })
  async function staleProbe(work: typeof writeGroupSlotConference, retire: boolean | 'expired') {
    const { slot, bookings, deps, provider } = await fixture()
    const original = provider.client.importEvent
    let release!: () => void, entered!: () => void
    const wait = new Promise<void>((r) => {
        release = r
      }),
      started = new Promise<void>((r) => {
        entered = r
      })
    provider.client.importEvent = async (...args) => {
      const result = await original(...args)
      entered()
      await wait
      return result
    }
    const writing = work(deps, slot)
    await started
    if (retire === true) {
      await owned.pool.query(
        "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=ANY($1::uuid[])",
        [bookings],
      )
      await db.transaction().execute((trx) => cancelGroupSlotConference(trx, slot, now))
    } else if (retire === 'expired') deps.now = () => now.epochMilliseconds + 121_000
    else
      await db
        .updateTable('group_slot_conferences')
        .set({ lease_id: randomUUID() })
        .where('group_slot_id', '=', slot)
        .execute()
    release()
    await writing
    const intent = await db
      .selectFrom('group_slot_conferences')
      .selectAll()
      .where('group_slot_id', '=', slot)
      .executeTakeFirstOrThrow()
    expect(intent.state).toBe('pending')
    expect(intent.join_url).toBeNull()
  }
  it.each([false, true, 'expired'] as const)(
    'detects stale completion after retirement=%s and restores source',
    async (retire) => {
      const source = readFileSync(new URL('./group-conferences.ts', import.meta.url), 'utf8')
      const guard =
        retire === 'expired'
          ? 'current.lease_id !== c.lease || !current.lease_until || current.lease_until <= clock(deps)'
          : retire
            ? (source.match(
                /current.revision !== c.revision \|\|[\s\S]*?slot.state !== c.slot.state/,
              )?.[0] as string)
            : 'current.lease_id !== c.lease'
      await staleProbe(workerCopy(), retire)
      await expect(staleProbe(workerCopy([guard, 'false']), retire)).rejects.toMatchObject({
        name: 'AssertionError',
      })
      await staleProbe(workerCopy(), retire)
    },
  )
  it('bounds provider attempts including expired leases, with a source-copy negative control', async () => {
    const check = async (work: typeof writeGroupSlotConference) => {
      const { slot, bookings, deps, provider } = await fixture()
      await db
        .updateTable('group_slot_conferences')
        .set({
          attempts: 12,
          lease_id: randomUUID(),
          lease_until: new Date(now.epochMilliseconds - 1),
        })
        .where('group_slot_id', '=', slot)
        .execute()
      await work(deps, slot)
      const intent = await db
        .selectFrom('group_slot_conferences')
        .selectAll()
        .where('group_slot_id', '=', slot)
        .executeTakeFirstOrThrow()
      expect(intent.state).toBe('failed')
      expect(intent.attempts).toBe(12)
      expect(provider.controls.storedEvents.size).toBe(0)
      expect(
        await db
          .selectFrom('booking_conference_notifications')
          .select('booking_id')
          .where('booking_id', 'in', bookings)
          .where('kind', '=', 'conference_failed')
          .execute(),
      ).toHaveLength(2)
    }
    await check(workerCopy())
    await expect(check(workerCopy(['if (c.attempts >= 12)', 'if (false)']))).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await check(workerCopy())
  })
  it('coalesces a join during provider creation without changing readiness', async () => {
    const { slot, f, deps, provider } = await fixture()
    const original = provider.client.importEvent
    let release!: () => void, entered!: () => void
    const wait = new Promise<void>((r) => {
        release = r
      }),
      started = new Promise<void>((r) => {
        entered = r
      })
    provider.client.importEvent = async (...args) => {
      const result = await original(...args)
      entered()
      await wait
      return result
    }
    const writing = writeGroupSlotConference(deps, slot)
    await started
    await transaction(owned.pool, (c) =>
      insertSeat(c, f, slot, 'late@example.test', {
        location_option: { id: 'legacy', kind: 'google_meet', autoCreate: true },
      }),
    )
    release()
    await writing
    const intent = await db
      .selectFrom('group_slot_conferences')
      .selectAll()
      .where('group_slot_id', '=', slot)
      .executeTakeFirstOrThrow()
    expect(intent.state).toBe('ready')
    expect(intent.revision).toBe(1)
    expect([...provider.controls.storedEvents.values()][0]?.description).toBe('3')
    expect(provider.controls.storedEvents.size).toBe(1)
  })
  it('uses one shared Zoom identity and cleans it only after the final seat leaves', async () => {
    const { slot, bookings, deps, provider } = await fixture(true)
    const calls: { create: boolean; status: string }[] = []
    deps.zoomConferenceWork = async (work) => {
      calls.push({ create: work.create, status: work.booking.status })
      return work.booking.status === 'cancelled'
        ? { cancelled: true }
        : { meetingId: '12345678901', url: 'https://zoom.us/j/12345678901' }
    }
    await writeGroupSlotConference(deps, slot)
    expect(calls).toEqual([{ create: true, status: 'confirmed' }])
    expect(provider.controls.storedEvents.size).toBe(1)
    await owned.pool.query(
      "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1",
      [bookings[0]],
    )
    await db.transaction().execute((trx) => cancelGroupSlotConference(trx, slot, now))
    await writeGroupSlotConference(deps, slot)
    expect(calls).toHaveLength(1)
    await owned.pool.query(
      "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1",
      [bookings[1]],
    )
    await db.transaction().execute((trx) => cancelGroupSlotConference(trx, slot, now))
    await writeGroupSlotConference(deps, slot)
    expect(calls).toEqual([
      { create: true, status: 'confirmed' },
      { create: false, status: 'cancelled' },
    ])
    expect(
      (
        await db
          .selectFrom('group_slot_conferences')
          .select('join_url')
          .where('group_slot_id', '=', slot)
          .executeTakeFirstOrThrow()
      ).join_url,
    ).toBeNull()
  })
  it('does not blindly repeat an ambiguous Zoom creation', async () => {
    const { slot, deps } = await fixture(true)
    let calls = 0
    deps.zoomConferenceWork = async () => {
      calls++
      return { error: 'ambiguous_create' }
    }
    await writeGroupSlotConference(deps, slot)
    await writeGroupSlotConference(deps, slot)
    const intent = await db
      .selectFrom('group_slot_conferences')
      .selectAll()
      .where('group_slot_id', '=', slot)
      .executeTakeFirstOrThrow()
    expect(intent.state).toBe('failed')
    expect(intent.error_code).toBe('ambiguous_create')
    expect(intent.create_started).toBe(true)
    expect(calls).toBe(1)
  })
  it('detects breaking survivor readiness on a non-final cancellation', async () => {
    const original = readFileSync(
      new URL('../../scheduling/src/group-conferences.ts', import.meta.url),
      'utf8',
    )
    const source = original.slice(
      original.indexOf('export async function cancelGroupSlotConference'),
      original.indexOf('/** Release only active seat versions'),
    )
    const compile = (broken: boolean): typeof cancelGroupSlotConference =>
      new Function(
        `${stripTypeScriptTypes(broken ? source.replace("if (slot.state === 'open') return", '').replace(".where('revision', '<',", ".where('revision', '<=',") : source).replace(/\bexport /g, '')};return cancelGroupSlotConference`,
      )()
    const check = async (cancel: typeof cancelGroupSlotConference) => {
      const { slot, bookings, deps } = await fixture()
      await writeGroupSlotConference(deps, slot)
      await owned.pool.query(
        "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1",
        [bookings[0]],
      )
      await db.transaction().execute((trx) => cancel(trx, slot, now))
      expect(
        (
          await db
            .selectFrom('group_slot_conferences')
            .select('state')
            .where('group_slot_id', '=', slot)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('ready')
    }
    await check(compile(false))
    await expect(check(compile(true))).rejects.toMatchObject({ name: 'AssertionError' })
    await check(compile(false))
  })
  it('detects a cancelled-seat join URL leak through the protected projection', async () => {
    const original = readFileSync(
      new URL('../../scheduling/src/conferences.ts', import.meta.url),
      'utf8',
    )
    const source = original.slice(
      original.indexOf('export async function bookingConferenceViews'),
      original.indexOf('/** Only resolved data'),
    )
    const compile = (broken: boolean): typeof bookingConferenceViews =>
      new Function(
        'sql',
        `${stripTypeScriptTypes(broken ? source.replace("b.status='confirmed' AND gs.state='open' AND", '') : source).replace(/\bexport /g, '')};return bookingConferenceViews`,
      )(sql)
    const check = async (read: typeof bookingConferenceViews) => {
      const { slot, bookings, deps } = await fixture()
      await writeGroupSlotConference(deps, slot)
      await owned.pool.query(
        "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1",
        [bookings[0]],
      )
      const view = (await read(db, [bookings[0] as string])).get(bookings[0] as string)
      expect(JSON.stringify(view?.location)).not.toContain('https://meet.google.com/')
    }
    await check(compile(false))
    await expect(check(compile(true))).rejects.toMatchObject({ name: 'AssertionError' })
    await check(compile(false))
  })
  it('requeues bounded terminal cleanup after a late Zoom creation identity arrives', async () => {
    const { slot, bookings, deps } = await fixture(true)
    let release!: () => void, entered!: () => void
    const wait = new Promise<void>((r) => {
        release = r
      }),
      started = new Promise<void>((r) => {
        entered = r
      })
    let canClean = false
    deps.zoomConferenceWork = async (work) => {
      if (work.create) {
        entered()
        await wait
        return { meetingId: '12345678901', url: 'https://zoom.us/j/12345678901' }
      }
      return canClean ? { cancelled: true } : { error: 'ambiguous_create' }
    }
    const old = writeGroupSlotConference(deps, slot)
    await started
    await owned.pool.query(
      "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=ANY($1::uuid[])",
      [bookings],
    )
    await db.transaction().execute((trx) => cancelGroupSlotConference(trx, slot, now))
    await db
      .updateTable('group_slot_conferences')
      .set({ lease_until: new Date(now.epochMilliseconds - 1) })
      .where('group_slot_id', '=', slot)
      .execute()
    await writeGroupSlotConference(deps, slot)
    expect(
      (
        await db
          .selectFrom('group_slot_conferences')
          .select('state')
          .where('group_slot_id', '=', slot)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('failed')
    release()
    await old
    let intent = await db
      .selectFrom('group_slot_conferences')
      .selectAll()
      .where('group_slot_id', '=', slot)
      .executeTakeFirstOrThrow()
    expect(intent.state).toBe('pending')
    expect(intent.attempts).toBe(1)
    expect(intent.join_url).toBeNull()
    canClean = true
    await writeGroupSlotConference(deps, slot)
    intent = await db
      .selectFrom('group_slot_conferences')
      .selectAll()
      .where('group_slot_id', '=', slot)
      .executeTakeFirstOrThrow()
    expect(intent.state).toBe('ready')
    expect(intent.attempts).toBe(2)
    expect(intent.join_url).toBeNull()
  })
  it('validates the pinned provider and organizer on later joins without following a new default', async () => {
    const { slot, f, ctx, deps, calendar } = await fixture()
    await writeGroupSlotConference(deps, slot)
    await db
      .updateTable('profiles')
      .set({ destination_calendar_id: null })
      .where('user_id', '=', f.host)
      .execute()
    await db.transaction().execute((trx) => prepareGroupSlotConference(ctx, trx, slot))
    const connection = await db
      .selectFrom('calendars')
      .select('connection_id')
      .where('id', '=', calendar.id)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('calendar_connections')
      .set({ status: 'needs_reauth' })
      .where('id', '=', connection.connection_id)
      .execute()
    await expect(
      db.transaction().execute((trx) => prepareGroupSlotConference(ctx, trx, slot)),
    ).rejects.toMatchObject({ code: 'slot_unavailable' })
    await db
      .updateTable('calendar_connections')
      .set({ status: 'active' })
      .where('id', '=', connection.connection_id)
      .execute()
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', f.host)
      .execute()
    await expect(
      db.transaction().execute((trx) => prepareGroupSlotConference(ctx, trx, slot)),
    ).rejects.toMatchObject({ code: 'slot_unavailable' })
    expect(
      (
        await db
          .selectFrom('group_slot_conferences')
          .select('state')
          .where('group_slot_id', '=', slot)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('ready')
  })
  it.each(['provider', 'organizer'])(
    'detects skipping pinned %s eligibility on joins',
    async (mode) => {
      const source = readFileSync(
        new URL('../../scheduling/src/group-conferences.ts', import.meta.url),
        'utf8',
      )
      const guard =
        mode === 'organizer'
          ? '!(await conferenceOrganizerAvailable(trx, existing))'
          : (source.match(/!ctx.automaticMeet \|\|[\s\S]*?\)\.eligible/)?.[0] as string)
      const check = async (prepare: typeof prepareGroupSlotConference) => {
        const { slot, f, ctx, calendar } = await fixture()
        if (mode === 'organizer')
          await db
            .updateTable('auth.user')
            .set({ emailVerified: false })
            .where('id', '=', f.host)
            .execute()
        else
          await db
            .updateTable('calendars')
            .set({ access_role: 'reader' })
            .where('id', '=', calendar.id)
            .execute()
        await expect(
          db.transaction().execute((trx) => prepare(ctx, trx, slot)),
        ).rejects.toMatchObject({ code: 'slot_unavailable' })
      }
      await check(prepareCopy())
      await expect(check(prepareCopy([guard, 'false']))).rejects.toMatchObject({
        name: 'AssertionError',
      })
      await check(prepareCopy())
    },
  )
})
