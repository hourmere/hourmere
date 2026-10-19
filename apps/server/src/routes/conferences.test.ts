import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

describe.skipIf(!process.env.DATABASE_URL)('conference protected REST', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await createTestApp(process.env.DATABASE_URL as string)
  })
  afterAll(async () => {
    await t?.drop()
  })
  it('exposes only bounded status on authorized booking details and denies retry to others', async () => {
    const user = await createTestUser(t.db),
      other = await createTestUser(t.db)
    const f = createFixtures(t.db)
    const id = await f.booking(
      user.principal.organization.id,
      [user.id],
      '2030-01-01T10:00:00Z',
      '2030-01-01T10:30:00Z',
      {},
    )
    await t.db
      .updateTable('bookings')
      .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true }) })
      .where('id', '=', id)
      .execute()
    await t.db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: id,
        booking_id: id,
        organization_id: user.principal.organization.id,
        organizer_user_id: user.id,
        state: 'failed',
        error_code: 'ambiguous_create',
        create_started: true,
      })
      .execute()
    expect((await t.anonymous.get(`/api/v1/bookings/${id}`)).status).toBe(401)
    expect((await t.as(other.principal).get(`/api/v1/bookings/${id}`)).status).toBe(404)
    const response = await t.as(user.principal).get(`/api/v1/bookings/${id}`)
    expect(response.status).toBe(200)
    expect((response.body as { conference: unknown }).conference).toEqual({
      provider: 'google_meet',
      status: 'failed',
      errorCode: 'ambiguous_create',
    })
    expect(JSON.stringify(response.body)).not.toMatch(
      /requestId|lease|connectionId|calendarId|externalEventId/,
    )
    expect((await t.anonymous.post(`/api/v1/bookings/${id}/conference/retry`, {})).status).toBe(401)
    expect(
      (await t.anonymous.post(`/api/v1/bookings/${id}/conference/retry`, undefined)).status,
    ).toBe(401)
    expect(
      (await t.as(other.principal).post(`/api/v1/bookings/${id}/conference/retry`, {})).status,
    ).toBe(404)
    expect(
      (
        await t
          .as(user.principal)
          .post(`/api/v1/bookings/${id}/conference/retry`, { forceCreate: true })
      ).status,
    ).toBe(400)
    expect(
      (await t.as(user.principal).post(`/api/v1/bookings/${id}/conference/retry`, undefined))
        .status,
    ).toBe(400)
    expect(
      (await t.as(user.principal).raw('POST', `/api/v1/bookings/${id}/conference/retry`, ''))
        .status,
    ).toBe(400)
    expect(
      (await t.as(user.principal).post(`/api/v1/bookings/${id}/conference/retry`, [])).status,
    ).toBe(400)
    expect(
      (await t.as(user.principal).post(`/api/v1/bookings/${id}/conference/retry`, {})).status,
    ).toBe(204)
    const intent = await t.db
      .selectFrom('booking_conferences')
      .selectAll()
      .where('root_booking_id', '=', id)
      .executeTakeFirstOrThrow()
    expect(intent.state).toBe('pending')
    expect(intent.create_started).toBe(true)
  })
  it('preserves pending timeout separately from provider failure on protected reads', async () => {
    const user = await createTestUser(t.db)
    const id = await createFixtures(t.db).booking(
      user.principal.organization.id,
      [user.id],
      '2030-01-01T10:00:00Z',
      '2030-01-01T10:30:00Z',
      {},
    )
    const token = randomBytes(32).toString('base64url')
    await t.db
      .updateTable('bookings')
      .set({
        location: JSON.stringify({ kind: 'google_meet', autoCreate: true }),
        manage_token_hash: createHash('sha256').update(token).digest(),
      })
      .where('id', '=', id)
      .execute()
    await t.db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: id,
        booking_id: id,
        organization_id: user.principal.organization.id,
        organizer_user_id: user.id,
        state: 'failed',
        error_code: 'conference_pending_timeout',
      })
      .execute()
    const host = t.as(user.principal)
    for (const errorCode of ['conference_pending_timeout', 'provider_unavailable']) {
      await t.db
        .updateTable('booking_conferences')
        .set({ error_code: errorCode })
        .where('root_booking_id', '=', id)
        .execute()
      const detail = await host.get(`/api/v1/bookings/${id}`)
      const list = await host.get('/api/v1/bookings')
      const managed = await t.app.request('/api/v1/bookings/manage', {
        headers: { 'X-Manage-Token': token },
      })
      expect([detail.status, list.status, managed.status]).toEqual([200, 200, 200])
      const views = [
        detail.body,
        (list.body as { data: unknown[] }).data.find(
          (booking) => (booking as { id: string }).id === id,
        ),
        await managed.json(),
      ]
      for (const view of views) {
        expect((view as { conference: unknown }).conference).toEqual({
          provider: 'google_meet',
          status: 'failed',
          errorCode,
        })
        expect(JSON.stringify(view)).not.toMatch(
          /requestId|lease|connectionId|calendarId|externalEventId/,
        )
      }
    }
  })
  it('REST exposes only my pinned copy and enforces strict retry plus fresh membership/verification', async () => {
    const [owner, organizer, outsider] = await Promise.all(
      ['Copy host', 'Organizer', 'Outside'].map((name) => createTestUser(t.db, name)),
    )
    if (!owner || !organizer || !outsider) throw Error('Synthetic users missing')
    const team = await createTestTeam(t.db, [
        { user: owner, role: 'owner' },
        { user: organizer, role: 'member' },
      ]),
      f = createFixtures(t.db)
    const id = await f.booking(
      team.id,
      [owner.id, organizer.id],
      '2030-11-04T09:00:00Z',
      '2030-11-04T09:30:00Z',
      {},
    )
    await t.db
      .updateTable('bookings')
      .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true }) })
      .where('id', '=', id)
      .execute()
    await t.db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: id,
        booking_id: id,
        organization_id: team.id,
        organizer_user_id: organizer.id,
        invitation_organizer_name: organizer.name,
        invitation_organizer_email: organizer.email,
        state: 'failed',
        error_code: 'provider_unavailable',
      })
      .execute()
    await t.db
      .insertInto('booking_conference_mirrors')
      .values({
        root_booking_id: id,
        user_id: owner.id,
        calendar_id: randomUUID(),
        connection_id: randomUUID(),
        state: 'failed',
        error_code: 'ambiguous_create',
        create_started: true,
      })
      .execute()
    const mine = t.as(team.as(owner)),
      other = t.as(team.as(organizer)),
      path = `/api/v1/bookings/${id}/calendar-copy/retry`
    const view = (await mine.get(`/api/v1/bookings/${id}`)).body as Record<string, unknown>
    expect(view.calendarCopy).toEqual({
      status: 'failed',
      errorCode: 'ambiguous_create',
      canRetry: true,
    })
    expect(view.conferenceCanRetry).toBe(false)
    const organizerView = (await other.get(`/api/v1/bookings/${id}`)).body as Record<
      string,
      unknown
    >
    expect(organizerView).not.toHaveProperty('calendarCopy')
    expect(organizerView.conferenceCanRetry).toBe(true)
    expect(JSON.stringify(view)).not.toMatch(
      /invitation_organizer|operation_id|calendar_id|connection_id|lease_id|external_event_id/,
    )
    expect((await t.anonymous.post(path, {})).status).toBe(401)
    expect((await t.as(outsider.principal).post(path, {})).status).toBe(404)
    expect((await other.post(path, {})).status).toBe(404)
    for (const body of [undefined, [], { forceCreate: true }])
      expect((await mine.post(path, body)).status).toBe(400)
    expect((await mine.raw('POST', path, '')).status).toBe(400)
    await t.db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', owner.id)
      .execute()
    expect((await mine.post(path, {})).status).toBe(404)
    await f.member(owner.id, team.id, 'owner')
    await t.db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', owner.id)
      .execute()
    expect((await mine.post(path, {})).status).toBe(404)
    await t.db
      .updateTable('auth.user')
      .set({ emailVerified: true })
      .where('id', '=', owner.id)
      .execute()
    expect((await mine.post(path, {})).status).toBe(204)
    const row = await t.db
      .selectFrom('booking_conference_mirrors')
      .selectAll()
      .where('root_booking_id', '=', id)
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({ state: 'pending', create_started: true, error_code: null })
  })
})
