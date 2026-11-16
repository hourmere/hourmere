import { randomUUID } from 'node:crypto'
import { createDb, type Database, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { Kysely, PostgresDialect } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { publicRoutes } from './routes/public.ts'

// When the conference resource pinned to an existing group occurrence becomes unusable, a
// mailbox that already holds a seat and a mailbox that does not must get the same answer
// through the same work: same status, same bytes, no write, and the same SQL statements.
// Otherwise anyone could learn, without booking, whether an address is enrolled.

const NOW = Temporal.Instant.from('2027-10-31T12:00:00Z')
const START = '2027-11-01T09:00:00Z'
const HOLDER = 'holder@example.test'
const STRANGER = 'stranger@example.test'
const ZOOM_SCOPES = [
  'user:read:user',
  'meeting:write:meeting',
  'meeting:read:meeting',
  'meeting:update:meeting',
  'meeting:delete:meeting',
]
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.events.owned',
]

type Variant = 'single' | 'legacy' | 'multi'

describe.skipIf(!process.env.DATABASE_URL)('group seat conference membership probe', () => {
  let owned: TestDatabase
  let db: Db
  let logged: Db
  let statements: string[] = []
  const notify = vi.fn()

  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
    // The application's own handle on the pool: it records every statement it executes.
    logged = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  function app(flags: { automaticZoom: boolean; automaticMeet: boolean }) {
    return createApp({
      publicUrl: 'http://localhost:3000',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      routes: [
        publicRoutes({
          db: logged,
          now: () => NOW,
          notify,
          ...flags,
          rateLimits: { book: { limit: 10_000, windowSeconds: 60 } },
        }),
      ],
    })
  }

  /** A capacity-3 occurrence with one seat held by HOLDER and its conference pinned. */
  async function occurrence(provider: 'zoom' | 'google_meet', variant: Variant = 'single') {
    const f = createFixtures(db)
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const eventId = await f.eventType(host.organizationId, host.userId, { slug: 'class' })
    let zoomConnectionId: string | null = null
    let googleConnectionId: string | null = null
    if (provider === 'zoom') {
      zoomConnectionId = (
        await db
          .insertInto('conference_connections')
          .values({
            user_id: host.userId,
            provider: 'zoom',
            mode: 'meetings',
            external_user_id: randomUUID(),
            status: 'active',
            credentials: Buffer.from('synthetic'),
            scopes: ZOOM_SCOPES,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
    } else {
      googleConnectionId = (
        await db
          .insertInto('calendar_connections')
          .values({
            user_id: host.userId,
            provider: 'google',
            external_account_id: `acct-${randomUUID()}`,
            credentials: Buffer.from('synthetic'),
            scopes: GOOGLE_SCOPES,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
      const calendar = await db
        .insertInto('calendars')
        .values({
          connection_id: googleConnectionId,
          external_id: `primary-${randomUUID()}`,
          name: 'Work',
          access_role: 'owner',
          supports_google_meet: true,
          // No conflict reads: this test is about the pinned write resource only.
          check_conflicts: false,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await db
        .updateTable('profiles')
        .set({ destination_calendar_id: calendar.id })
        .where('user_id', '=', host.userId)
        .execute()
    }
    const location = { kind: provider, autoCreate: true }
    await db
      .updateTable('event_types')
      .set({
        booking_mode: 'group',
        group_capacity: 3,
        location: JSON.stringify(location),
        zoom_connection_id: zoomConnectionId,
        locations:
          variant === 'legacy'
            ? null
            : JSON.stringify([
                { ...location, id: 'shared', isDefault: true },
                ...(variant === 'multi'
                  ? [{ id: 'office', kind: 'in_person', address: 'Other room' }]
                  : []),
              ]),
      })
      .where('id', '=', eventId)
      .execute()
    const flags = { automaticZoom: true, automaticMeet: true }
    const post = (email: string, client = app(flags)) =>
      client.request(`/api/v1/public/${host.handle}/class/bookings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          start: START,
          invitee: { name: 'Visitor', email, timeZone: 'UTC' },
        }),
      })
    const created = await post(HOLDER)
    expect(created.status, await created.clone().text()).toBe(201)
    const slot = await db
      .selectFrom('group_slot_conferences as c')
      .innerJoin('group_slots as s', 's.id', 'c.group_slot_id')
      .select(['c.group_slot_id', 'c.provider'])
      .where('s.original_event_type_id', '=', eventId)
      .executeTakeFirstOrThrow()
    expect(slot.provider).toBe(provider)
    return { host, eventId, post, zoomConnectionId, googleConnectionId, slot: slot.group_slot_id }
  }

  async function rows() {
    return {
      bookings: await db.selectFrom('bookings').select(['id', 'status']).orderBy('id').execute(),
      slots: await db.selectFrom('group_slots').selectAll().orderBy('id').execute(),
      attendees: await db.selectFrom('booking_attendees').select('id').orderBy('id').execute(),
      notifications: await db.selectFrom('booking_notifications').selectAll().execute(),
      conferences: await db.selectFrom('group_slot_conferences').selectAll().execute(),
      outbox: await db.selectFrom('booking_conference_notifications').selectAll().execute(),
      hosts: await db.selectFrom('booking_hosts').select('id').orderBy('id').execute(),
      messages: await db.selectFrom('group_slot_host_messages').selectAll().execute(),
    }
  }

  /** One request with only that request's statements, in order. */
  async function probe(post: (email: string) => Response | Promise<Response>, email: string) {
    statements = []
    const started = performance.now()
    const response = await post(email)
    const elapsed = performance.now() - started
    return { status: response.status, body: await response.text(), sql: statements, elapsed }
  }

  async function expectIndistinguishable(post: (email: string) => Response | Promise<Response>) {
    const before = await rows()
    const mailed = notify.mock.calls.length
    const holder = await probe(post, HOLDER)
    const stranger = await probe(post, STRANGER)
    expect(holder.status).toBe(409)
    expect(JSON.parse(holder.body)).toEqual({
      error: 'slot_unavailable',
      message: 'This time is not available',
    })
    expect(stranger.status).toBe(holder.status)
    expect(stranger.body).toBe(holder.body)
    // The same work: the holder's answer cannot come from the mailbox lookup while the
    // stranger's comes from a later check, and the stranger never inserts and rolls back.
    expect(stranger.sql).toEqual(holder.sql)
    for (const statement of [...holder.sql, ...stranger.sql])
      expect(statement).not.toMatch(/^\s*(insert|update|delete)\b/i)
    expect(holder.sql.some((s) => /group_booker_key/.test(s))).toBe(false)
    expect(await rows()).toEqual(before)
    expect(notify).toHaveBeenCalledTimes(mailed)
    return { holder, stranger }
  }

  it.each<Variant>(['single', 'legacy', 'multi'])(
    'answers a holder and a stranger alike when the pinned Zoom connection breaks (%s location)',
    async (variant) => {
      const o = await occurrence('zoom', variant)
      await db
        .updateTable('conference_connections')
        .set({ status: 'needs_reauth', credentials: null })
        .where('id', '=', o.zoomConnectionId as string)
        .execute()
      await expectIndistinguishable((email) => o.post(email))
    },
  )

  it('answers alike when the instance turns automatic Zoom off', async () => {
    const o = await occurrence('zoom', 'multi')
    const off = app({ automaticZoom: false, automaticMeet: true })
    await expectIndistinguishable((email) => o.post(email, off))
  })

  it('answers alike when the pinned Zoom organizer is no longer a verified member', async () => {
    const o = await occurrence('zoom')
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', o.host.userId)
      .execute()
    try {
      await expectIndistinguishable((email) => o.post(email))
    } finally {
      await db
        .updateTable('auth.user')
        .set({ emailVerified: true })
        .where('id', '=', o.host.userId)
        .execute()
    }
  })

  it('answers alike, without a tentative insert, when the pinned Meet calendar breaks', async () => {
    const o = await occurrence('google_meet')
    await db
      .updateTable('calendar_connections')
      .set({ status: 'needs_reauth' })
      .where('id', '=', o.googleConnectionId as string)
      .execute()
    await expectIndistinguishable((email) => o.post(email))
  })

  it('answers alike when the instance turns automatic Meet off', async () => {
    const o = await occurrence('google_meet')
    const off = app({ automaticZoom: true, automaticMeet: false })
    await expectIndistinguishable((email) => o.post(email, off))
  })

  /** An occurrence without an automatic conference, held by HOLDER. */
  async function plainOccurrence(location: Record<string, unknown>) {
    const f = createFixtures(db)
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const eventId = await f.eventType(host.organizationId, host.userId, { slug: 'class' })
    await db
      .updateTable('event_types')
      .set({ booking_mode: 'group', group_capacity: 3, location: JSON.stringify(location) })
      .where('id', '=', eventId)
      .execute()
    const client = app({ automaticZoom: true, automaticMeet: true })
    const post = (email: string) =>
      client.request(`/api/v1/public/${host.handle}/class/bookings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          start: START,
          invitee: { name: 'Visitor', email, timeZone: 'UTC' },
        }),
      })
    return { host, eventId, post }
  }

  it('answers alike when the notice cutoff has passed for an existing occurrence', async () => {
    const o = await plainOccurrence({ kind: 'link', url: 'https://example.test/class' })
    expect((await o.post(HOLDER)).status).toBe(201)
    await db
      .updateTable('event_types')
      .set({ minimum_notice_minutes: 7 * 24 * 60 })
      .where('id', '=', o.eventId)
      .execute()
    await expectIndistinguishable(o.post)
  })

  it('answers alike for an occurrence whose shared phone location would ask each invitee', async () => {
    // Public creation refuses such a snapshot; an older occurrence can still carry one.
    const o = await plainOccurrence({ kind: 'link', url: 'https://example.test/class' })
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      const slot = (
        await client.query<{ id: string }>(
          `INSERT INTO group_slots (organization_id,event_type_id,original_event_type_id,host_user_id,
             start_at,end_at,capacity,title,location)
           VALUES ($1,$2,$2,$3,$4,$5,3,'Class',$6) RETURNING id`,
          [
            o.host.organizationId,
            o.eventId,
            o.host.userId,
            START,
            Temporal.Instant.from(START).add({ minutes: 30 }).toString(),
            JSON.stringify({ kind: 'phone', askInvitee: true }),
          ],
        )
      ).rows[0]?.id
      await client.query('INSERT INTO booking_hosts (group_slot_id,user_id) VALUES ($1,$2)', [
        slot,
        o.host.userId,
      ])
      const seat = (
        await client.query<{ id: string }>(
          `INSERT INTO bookings (organization_id,event_type_id,group_slot_id,group_booker_key,
             required_host_user_ids,start_at,end_at,title,source)
           SELECT organization_id,event_type_id,id,$2,ARRAY[host_user_id],start_at,end_at,'Seat','web'
             FROM group_slots WHERE id=$1 RETURNING id`,
          [slot, HOLDER],
        )
      ).rows[0]?.id
      await client.query(
        `INSERT INTO booking_attendees (booking_id,name,email,time_zone,is_booker)
         VALUES ($1,'Holder',$2,'UTC',true)`,
        [seat, HOLDER],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    await expectIndistinguishable(o.post)
  })

  // A timing assessment, not a gate: wall-clock comparisons are too noisy for shared CI.
  // The guarantee is the identical statement list above. Run with GROUP_PROBE_TIMING=1.
  it.runIf(process.env.GROUP_PROBE_TIMING)('reports holder and stranger timing', async () => {
    const o = await occurrence('google_meet')
    await db
      .updateTable('calendar_connections')
      .set({ status: 'needs_reauth' })
      .where('id', '=', o.googleConnectionId as string)
      .execute()
    const samples: { holder: number[]; stranger: number[] } = { holder: [], stranger: [] }
    for (let round = 0; round < 15; round++) {
      // Alternate the order so warm-up and cache effects fall on both sides.
      const order = round % 2 ? [STRANGER, HOLDER] : [HOLDER, STRANGER]
      for (const email of order) {
        const result = await probe((e) => o.post(e), email)
        expect(result.status).toBe(409)
        samples[email === HOLDER ? 'holder' : 'stranger'].push(result.elapsed)
      }
    }
    const median = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number
    const holder = median(samples.holder)
    const stranger = median(samples.stranger)
    process.stdout.write(
      `${JSON.stringify({ holderMedianMs: holder, strangerMedianMs: stranger })}\n`,
    )
  })
})
