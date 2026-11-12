import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setAttendeeNoShow } from './no-show.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const START = '2026-11-01T09:30:00Z'
const AFTER = Temporal.Instant.from(START).add({ minutes: 1 })

describe.skipIf(!serverUrl)('attendee no-show audit events', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function setup(status: 'confirmed' | 'cancelled' = 'confirmed') {
    const host = await createTestUser(db, 'Private Host Name')
    const member = await createTestUser(db)
    const admin = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: host, role: 'member' },
      { user: member, role: 'member' },
      { user: admin, role: 'admin' },
    ])
    const bookingId = await createFixtures(db).booking(
      team.id,
      [host.id],
      START,
      '2026-11-01T10:00:00Z',
      { status },
    )
    const attendee = await db
      .updateTable('booking_attendees')
      .set({ name: 'Private Invitee Name', email: 'private-invitee@example.com' })
      .where('booking_id', '=', bookingId)
      .returning(['id', 'name', 'email'])
      .executeTakeFirstOrThrow()
    const ctx = { ...testContext(db, team.as(host), () => AFTER), requestId: randomUUID() }
    return { host, member, admin, team, bookingId, attendee, ctx }
  }
  type Setup = Awaited<ReturnType<typeof setup>>
  const events = async (bookingId: string) =>
    (
      await owned.pool.query(
        `SELECT * FROM audit_events WHERE action = 'booking.attendee_no_show_changed'
           AND target_id = $1 ORDER BY id`,
        [bookingId],
      )
    ).rows
  const marker = async (attendeeId: string) =>
    db
      .selectFrom('booking_attendees')
      .select(['no_show_marked_at', 'no_show_marked_by'])
      .where('id', '=', attendeeId)
      .executeTakeFirstOrThrow()
  const session = (s: Setup): Principal => ({
    ...s.team.as(s.admin),
    kind: 'session',
    sessionId: randomUUID(),
  })
  const oauth = (s: Setup): Principal => ({
    ...s.team.as(s.host),
    kind: 'oauth',
    oauthConsentId: randomUUID(),
    clientId: 'https://agent.example/metadata.json',
    scopes: ['mcp:tools'],
  })

  it('records each mark and unmark with the caller credential and only the attendee and state', async () => {
    const s = await setup()
    const admin = session(s)
    const agent = oauth(s)
    // The request may spell IDs in any case; the event keeps the stored IDs.
    await setAttendeeNoShow(s.ctx, s.bookingId.toUpperCase(), s.attendee.id.toUpperCase(), true)
    await setAttendeeNoShow({ ...s.ctx, principal: admin }, s.bookingId, s.attendee.id, false)
    await setAttendeeNoShow({ ...s.ctx, principal: agent }, s.bookingId, s.attendee.id, true)
    const rows = await events(s.bookingId)
    const common = {
      organization_id: s.team.id,
      target_type: 'booking',
      target_id: s.bookingId,
      request_id: s.ctx.requestId,
    }
    const key = s.ctx.principal.kind === 'api_key' ? s.ctx.principal.apiKeyId : ''
    expect(rows).toMatchObject([
      {
        ...common,
        actor_type: 'api_key',
        actor_id: key,
        credential_type: 'api_key',
        credential_id: key,
        credential_scope: 'full',
        oauth_client_id: null,
        oauth_grant_id: null,
        details: { attendeeId: s.attendee.id, noShow: 'marked' },
      },
      {
        ...common,
        actor_type: 'user',
        actor_id: s.admin.id,
        credential_type: 'session',
        credential_id: admin.kind === 'session' ? admin.sessionId : '',
        credential_scope: null,
        details: { attendeeId: s.attendee.id, noShow: 'unmarked' },
      },
      {
        ...common,
        actor_type: 'user',
        actor_id: s.host.id,
        credential_type: 'oauth',
        credential_id: null,
        oauth_client_id: 'https://agent.example/metadata.json',
        oauth_grant_id: agent.kind === 'oauth' ? agent.oauthConsentId : '',
        details: { attendeeId: s.attendee.id, noShow: 'marked' },
      },
    ])
    for (const row of rows)
      expect(Object.keys(row.details).sort()).toEqual(['attendeeId', 'noShow'])
    const serialized = JSON.stringify(rows)
    for (const personal of [
      s.attendee.name,
      s.attendee.email,
      'Private Host Name',
      s.host.email,
      s.admin.email,
    ])
      expect(serialized.includes(personal)).toBe(false)
  })

  it('records nothing for an exact replay, whoever repeats it', async () => {
    const s = await setup()
    await setAttendeeNoShow(s.ctx, s.bookingId, s.attendee.id, true)
    await setAttendeeNoShow(s.ctx, s.bookingId, s.attendee.id, true)
    await setAttendeeNoShow({ ...s.ctx, principal: session(s) }, s.bookingId, s.attendee.id, true)
    expect((await events(s.bookingId)).map((row) => row.details.noShow)).toEqual(['marked'])
    await setAttendeeNoShow(s.ctx, s.bookingId, s.attendee.id, false)
    await setAttendeeNoShow({ ...s.ctx, principal: oauth(s) }, s.bookingId, s.attendee.id, false)
    expect((await events(s.bookingId)).map((row) => row.details.noShow)).toEqual([
      'marked',
      'unmarked',
    ])
    // Concurrent identical marks serialize: one change, one event.
    await Promise.all(
      [s.ctx, s.ctx, { ...s.ctx, principal: session(s) }].map((ctx) =>
        setAttendeeNoShow(ctx, s.bookingId, s.attendee.id, true),
      ),
    )
    expect((await events(s.bookingId)).map((row) => row.details.noShow)).toEqual([
      'marked',
      'unmarked',
      'marked',
    ])
  })

  it('records nothing when the change rolls back or is refused', async () => {
    const s = await setup()
    // A failure after the event in the same transaction rolls back the event too.
    await expect(
      setAttendeeNoShow(
        {
          ...s.ctx,
          notifyAttendeeNoShow: async () => {
            throw new Error('capture unavailable')
          },
        },
        s.bookingId,
        s.attendee.id,
        true,
      ),
    ).rejects.toThrow('capture unavailable')
    expect(await marker(s.attendee.id)).toEqual({
      no_show_marked_at: null,
      no_show_marked_by: null,
    })
    // An event that cannot be written aborts the change.
    await owned.pool.query(`CREATE FUNCTION reject_no_show_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
      CREATE TRIGGER reject_no_show_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_no_show_audit()`)
    try {
      await expect(setAttendeeNoShow(s.ctx, s.bookingId, s.attendee.id, true)).rejects.toThrow(
        'audit unavailable',
      )
    } finally {
      await owned.pool.query(
        'DROP TRIGGER reject_no_show_audit ON audit_events; DROP FUNCTION reject_no_show_audit()',
      )
    }
    expect(await marker(s.attendee.id)).toEqual({
      no_show_marked_at: null,
      no_show_marked_by: null,
    })
    // Refusals: before the start, a member who is not a host, a cancelled booking.
    await expect(
      setAttendeeNoShow(
        { ...s.ctx, now: () => Temporal.Instant.from(START) },
        s.bookingId,
        s.attendee.id,
        true,
      ),
    ).rejects.toMatchObject({ code: 'booking_not_started' })
    await expect(
      setAttendeeNoShow(
        { ...s.ctx, principal: s.team.as(s.member) },
        s.bookingId,
        s.attendee.id,
        true,
      ),
    ).rejects.toMatchObject({ code: 'booking_not_found' })
    const cancelled = await setup('cancelled')
    await expect(
      setAttendeeNoShow(cancelled.ctx, cancelled.bookingId, cancelled.attendee.id, true),
    ).rejects.toMatchObject({ code: 'booking_cancelled' })
    expect(await events(s.bookingId)).toEqual([])
    expect(await events(cancelled.bookingId)).toEqual([])
  })
})
