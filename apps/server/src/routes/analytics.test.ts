import type { Db } from '@hourmere/db'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, openApiDocument, productApp, type TestApp } from './test-app.ts'

const query = '?startDate=2026-10-01&endDate=2026-10-03&timeZone=UTC'
describe('booking activity OpenAPI', () => {
  it('documents authenticated count-only reports', async () => {
    const { paths } = await openApiDocument(productApp({} as Db))
    expect(paths['/api/v1/analytics/bookings']?.get?.security).toEqual([
      { apiKey: [] },
      { session: [] },
    ])
  })
})
describe.skipIf(!process.env.DATABASE_URL)('booking activity REST', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await createTestApp(process.env.DATABASE_URL as string)
  })
  afterAll(async () => {
    await t?.drop()
  })
  it('requires authentication and returns no private fields', async () => {
    expect((await t.anonymous.get(`/api/v1/analytics/bookings${query}`)).status).toBe(401)
    const user = await createTestUser(t.db)
    const result = await t.as(user.principal).get(`/api/v1/analytics/bookings${query}`)
    expect(result.status).toBe(200)
    expect(Object.keys(result.body as object).sort()).toEqual([
      'data',
      'endDate',
      'startDate',
      'timeZone',
      'totals',
    ])
    expect(JSON.stringify(result.body)).not.toMatch(
      /attendee|email|responses|manageToken|source|title|cancelReason/,
    )
  })
  it('denies ordinary team members and rejects unbounded/extra query parameters', async () => {
    const user = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [{ user, role: 'member' }])
    expect((await t.as(team.as(user)).get(`/api/v1/analytics/bookings${query}`)).status).toBe(403)
    for (const suffix of [
      '',
      '?startDate=2026-10-01',
      `${query}&organizationId=${team.id}`,
      query.replace('2026-10-03', '2027-01-01'),
      query.replace('UTC', '%2B01%3A00'),
    ]) {
      expect((await t.as(user.principal).get(`/api/v1/analytics/bookings${suffix}`)).status).toBe(
        400,
      )
    }
  })
})
