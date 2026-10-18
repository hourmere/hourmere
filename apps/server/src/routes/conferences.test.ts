import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
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
})
