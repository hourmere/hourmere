import type { Db } from '@hourmere/db'
import { createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SCHEDULE_BODY_LIMIT, SCHEDULE_OVERRIDE_BODY_LIMIT } from './schedules.ts'
import {
  closedObjects,
  createTestApp,
  escapedJson,
  openApiDocument,
  productApp,
  responseAndRequestStrictness,
  type TestApp,
} from './test-app.ts'

const serverUrl = process.env.DATABASE_URL

const ROUTES = {
  '/api/v1/schedules': ['get', 'post'],
  '/api/v1/schedules/{id}': ['get', 'patch', 'delete'],
  '/api/v1/schedules/{id}/overrides': ['get'],
  '/api/v1/schedules/{id}/overrides/{date}': ['put', 'delete'],
}

describe('schedule routes in the OpenAPI document', () => {
  it('documents open responses and strict request bodies, down to the intervals', async () => {
    const doc = await openApiDocument(productApp({} as Db))
    expect(responseAndRequestStrictness(doc, Object.keys(ROUTES))).toEqual({
      closedResponses: [],
      openRequests: [],
    })
    const body = (path: string, method: string) => {
      const schema = doc.paths[path]?.[method]?.requestBody?.content?.['application/json']?.schema
      if (!schema) throw new Error(`no request body for ${method} ${path}`)
      return closedObjects(doc, schema)
    }
    expect(body('/api/v1/schedules', 'post')).toEqual(
      expect.arrayContaining(['$', '$.weeklyHours', '$.weeklyHours.monday[]']),
    )
    expect(body('/api/v1/schedules/{id}', 'patch')).toEqual(
      expect.arrayContaining(['$', '$.weeklyHours', '$.weeklyHours.sunday[]']),
    )
    expect(body('/api/v1/schedules/{id}/overrides/{date}', 'put')).toEqual(['$', '$.intervals[]'])
  })

  it('lists every route as authenticated', async () => {
    const { paths } = await openApiDocument(productApp({} as Db))
    for (const [path, methods] of Object.entries(ROUTES)) {
      expect(Object.keys(paths[path] ?? {})).toEqual(methods)
      for (const operation of Object.values(paths[path] ?? {})) {
        expect(operation.security).toEqual([{ apiKey: [] }, { session: [] }])
        expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(['401', '429']))
      }
    }
  })
})

describe.skipIf(!serverUrl)('schedule routes', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp(serverUrl as string)
  })

  afterAll(async () => {
    await t?.drop()
  })

  const hours = { monday: [{ start: '09:00', end: '17:00' }], sunday: [] }
  const body = (overrides: Record<string, unknown> = {}) => ({
    name: 'Working hours',
    timeZone: 'Europe/Berlin',
    weeklyHours: hours,
    ...overrides,
  })
  const api = (user: TestUser) => t.as(user.principal)

  it('requires a caller', async () => {
    expect((await t.anonymous.get('/api/v1/schedules')).status).toBe(401)
    expect((await t.anonymous.post('/api/v1/schedules', body())).status).toBe(401)
  })

  it('creates, lists, reads, changes and deletes schedules', async () => {
    const user = await createTestUser(t.db)
    expect(await api(user).get('/api/v1/schedules')).toEqual({ status: 200, body: { data: [] } })

    const created = await api(user).post('/api/v1/schedules', body())
    expect(created.status).toBe(201)
    expect(created.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'Working hours',
      timeZone: 'Europe/Berlin',
      weeklyHours: hours,
      isDefault: true,
      createdAt: expect.stringMatching(/Z$/),
      updatedAt: expect.stringMatching(/Z$/),
    })
    const { id } = created.body as { id: string }
    const second = await api(user).post('/api/v1/schedules', body({ name: 'Evenings' }))
    expect(second.body).toMatchObject({ isDefault: false })
    const secondId = (second.body as { id: string }).id

    expect(await api(user).get('/api/v1/schedules')).toEqual({
      status: 200,
      body: { data: [created.body, second.body] },
    })
    expect(await api(user).get(`/api/v1/schedules/${id}`)).toEqual({
      status: 200,
      body: created.body,
    })

    const changed = await api(user).patch(`/api/v1/schedules/${secondId}`, { isDefault: true })
    expect(changed).toMatchObject({ status: 200, body: { id: secondId, isDefault: true } })
    expect(await api(user).patch(`/api/v1/schedules/${secondId}`, { isDefault: false })).toEqual({
      status: 409,
      body: { error: 'schedule_is_default', message: 'Make another schedule the default instead' },
    })
    expect((await api(user).delete(`/api/v1/schedules/${secondId}`)).body).toMatchObject({
      error: 'schedule_is_default',
    })
    expect(await api(user).delete(`/api/v1/schedules/${id}`)).toEqual({ status: 204, body: null })
    expect(await api(user).delete(`/api/v1/schedules/${secondId}`)).toEqual({
      status: 204,
      body: null,
    })
    expect(await api(user).get(`/api/v1/schedules/${id}`)).toEqual({
      status: 404,
      body: { error: 'schedule_not_found' },
    })
  })

  it("answers 404 for another user's schedule and for malformed ids", async () => {
    const [owner, other] = [await createTestUser(t.db), await createTestUser(t.db)]
    const { id } = (await api(owner).post('/api/v1/schedules', body())).body as { id: string }
    for (const res of [
      await api(other).get(`/api/v1/schedules/${id}`),
      await api(other).patch(`/api/v1/schedules/${id}`, { name: 'Mine' }),
      await api(other).delete(`/api/v1/schedules/${id}`),
      await api(other).get(`/api/v1/schedules/${id}/overrides`),
      await api(other).put(`/api/v1/schedules/${id}/overrides/2026-12-24`, { intervals: [] }),
      await api(owner).get('/api/v1/schedules/not-a-uuid'),
    ]) {
      expect(res).toEqual({ status: 404, body: { error: 'schedule_not_found' } })
    }
  })

  it.each<[string, Record<string, unknown>, string]>([
    [
      'overlapping hours',
      {
        weeklyHours: {
          monday: [
            { start: '09:00', end: '12:00' },
            { start: '11:00', end: '13:00' },
          ],
        },
      },
      'invalid_weekly_hours',
    ],
    [
      'a time past midnight',
      { weeklyHours: { monday: [{ start: '09:00', end: '25:00' }] } },
      'invalid_weekly_hours',
    ],
    ['an unknown time zone', { timeZone: 'Atlantis/Capital' }, 'invalid_time_zone'],
    ['a blank name', { name: ' ' }, 'invalid_schedule'],
    ['an unknown weekday', { weeklyHours: { mon: [] } }, 'invalid_request'],
    [
      'an interval with extra fields',
      { weeklyHours: { monday: [{ start: '09:00', end: '10:00', x: 1 }] } },
      'invalid_request',
    ],
    ['an unknown field', { default: true }, 'invalid_request'],
    ['a missing field', { weeklyHours: undefined }, 'invalid_request'],
  ])('refuses %s with 400', async (_, change, error) => {
    const user = await createTestUser(t.db)
    const res = await api(user).post('/api/v1/schedules', body(change))
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error, message: expect.any(String) })
  })

  it('names the offending interval in the message', async () => {
    const user = await createTestUser(t.db)
    const res = await api(user).post(
      '/api/v1/schedules',
      body({ weeklyHours: { friday: [{ start: '17:00', end: '09:00' }] } }),
    )
    expect(res).toEqual({
      status: 400,
      body: {
        error: 'invalid_weekly_hours',
        message: 'weeklyHours.friday[0].end (09:00) must be after start (17:00)',
      },
    })
  })

  it('sets, lists and removes date overrides', async () => {
    const user = await createTestUser(t.db)
    const { id } = (await api(user).post('/api/v1/schedules', body())).body as { id: string }
    const base = `/api/v1/schedules/${id}/overrides`
    expect(await api(user).put(`${base}/2026-12-24`, { intervals: [] })).toEqual({
      status: 201,
      body: { date: '2026-12-24', intervals: [] },
    })
    const hours = [{ start: '10:00', end: '14:00' }]
    expect(await api(user).put(`${base}/2026-12-24`, { intervals: hours })).toEqual({
      status: 200,
      body: { date: '2026-12-24', intervals: hours },
    })
    await api(user).put(`${base}/2026-12-31`, { intervals: [] })

    expect(await api(user).get(base)).toEqual({
      status: 200,
      body: {
        data: [
          { date: '2026-12-24', intervals: hours },
          { date: '2026-12-31', intervals: [] },
        ],
      },
    })
    expect(await api(user).get(`${base}?from=2026-12-25&to=2027-01-01`)).toEqual({
      status: 200,
      body: { data: [{ date: '2026-12-31', intervals: [] }] },
    })
    expect((await api(user).get(`${base}?from=2027-01-01&to=2026-01-01`)).body).toMatchObject({
      error: 'invalid_date_range',
    })
    expect((await api(user).get(`${base}?from=tomorrow`)).body).toMatchObject({
      error: 'invalid_date',
    })

    expect(await api(user).delete(`${base}/2026-12-24`)).toEqual({ status: 204, body: null })
    expect(await api(user).delete(`${base}/2026-12-24`)).toEqual({
      status: 404,
      body: { error: 'schedule_override_not_found' },
    })
  })

  it.each<[string, string, unknown, string]>([
    ['an impossible date', '2026-02-30', { intervals: [] }, 'invalid_date'],
    [
      'overlapping intervals',
      '2026-12-24',
      {
        intervals: [
          { start: '09:00', end: '12:00' },
          { start: '10:00', end: '11:00' },
        ],
      },
      'invalid_intervals',
    ],
    ['a body without intervals', '2026-12-24', {}, 'invalid_request'],
  ])('refuses an override with %s', async (_, date, payload, error) => {
    const user = await createTestUser(t.db)
    const { id } = (await api(user).post('/api/v1/schedules', body())).body as { id: string }
    const res = await api(user).put(`/api/v1/schedules/${id}/overrides/${date}`, payload)
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error })
  })
  it('accepts the largest legal weekly hours and override, fully escaped, within their body limits', async () => {
    const user = await createTestUser(t.db)
    const hhmm = (minute: number) =>
      `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
    // Every minute of the day as its own interval: the most intervals a day can hold.
    const minutes = Array.from({ length: 1440 }, (_, m) => ({ start: hhmm(m), end: hhmm(m + 1) }))
    const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    const weeklyHours = Object.fromEntries(weekdays.map((day) => [day, minutes]))
    const create = escapedJson({
      name: 'x'.repeat(100),
      timeZone: 'America/Argentina/Buenos_Aires',
      weeklyHours,
      isDefault: true,
    })
    expect(create.length).toBeGreaterThan(1_200_000)
    expect(create.length).toBeLessThan(SCHEDULE_BODY_LIMIT)
    const created = await api(user).raw('POST', '/api/v1/schedules', create)
    expect(created.status).toBe(201)
    const { id } = created.body as { id: string }
    const changed = await api(user).raw(
      'PATCH',
      `/api/v1/schedules/${id}`,
      escapedJson({ weeklyHours }),
    )
    expect(changed.status).toBe(200)

    const override = escapedJson({ intervals: minutes })
    expect(override.length).toBeGreaterThan(64 * 1024)
    expect(override.length).toBeLessThan(SCHEDULE_OVERRIDE_BODY_LIMIT)
    const put = await api(user).raw('PUT', `/api/v1/schedules/${id}/overrides/2026-12-24`, override)
    expect(put.status).toBe(201)

    const tooLarge = JSON.stringify(body({ name: 'x'.repeat(SCHEDULE_BODY_LIMIT) }))
    expect(await api(user).raw('POST', '/api/v1/schedules', tooLarge)).toEqual({
      status: 413,
      body: { error: 'payload_too_large' },
    })
  })
})
