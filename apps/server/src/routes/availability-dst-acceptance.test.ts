// The editor's real copy operation, atomic REST save and public slot expansion share
// wall-clock hours; daylight saving changes their UTC offsets, not those hours.
import '@hono/zod-openapi'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { publicRoutes } from './public.ts'
import { scheduleRoutes } from './schedules.ts'
import { productApp } from './test-app.ts'

const serverUrl = process.env.DATABASE_URL
const zone = 'America/Los_Angeles'

type Day = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
type Draft = {
  name: string
  timeZone: string
  days: Record<
    Day,
    { available: boolean; intervals: { key: string; start: string; end: string }[] }
  >
}
// Load the real pure editor functions without importing its browser/i18n dependencies
// into the server TypeScript project. This follows the existing source-copy test pattern.
const editorSource = readFileSync(
  new URL('../../../web/src/pages/availability/weekly-hours.ts', import.meta.url),
  'utf8',
)
const editorBody = stripTypeScriptTypes(
  editorSource.replace(/^import[\s\S]*?from '[^']+'\n/gm, ''),
).replace(/^export /gm, '')
const { copyDay, newScheduleDraft, toScheduleBody } = new Function(
  `${editorBody}; return { copyDay, newScheduleDraft, toScheduleBody }`,
)() as {
  copyDay: (draft: Draft, source: Day, targets: Day[]) => Draft
  newScheduleDraft: (timeZone: string) => Draft
  toScheduleBody: (draft: Draft) => {
    name: string
    timeZone: string
    weeklyHours: Record<Day, { start: string; end: string }[]>
  }
}

describe.skipIf(!serverUrl)('copied availability across DST through REST', () => {
  let testDb: TestDatabase
  let db: Db

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
  })
  afterAll(async () => {
    await testDb?.drop()
  })

  it.each([
    { name: 'spring forward', saturday: '2027-03-13', sunday: '2027-03-14', utcHours: [17, 16] },
    { name: 'fall back', saturday: '2027-11-06', sunday: '2027-11-07', utcHours: [16, 17] },
  ])('keeps copied 09:00–10:00 hours over $name', async ({ saturday, sunday, utcHours }) => {
    const user = await createTestUser(db)
    const stranger = await createTestUser(db)
    const principals = new Map<string, Principal>([
      ['owner', user.principal],
      ['stranger', stranger.principal],
    ])
    const now = () => Temporal.Instant.from(`${saturday}T00:00:00Z`).subtract({ hours: 48 })
    const app = productApp(db, principals, [scheduleRoutes({ db }), publicRoutes({ db, now })])
    const send = (method: string, path: string, body?: unknown, caller = 'owner') =>
      app.request(path, {
        method,
        headers: { authorization: `Bearer ${caller}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })

    const draft = newScheduleDraft(zone)
    for (const day of Object.values(draft.days)) day.available = false
    draft.days.monday = {
      available: true,
      intervals: [{ key: 'source', start: '09:00', end: '10:00' }],
    }
    const created = await send('POST', '/api/v1/schedules', toScheduleBody(draft))
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    const path = `/api/v1/schedules/${id}/availability`
    const initial = await send('GET', path)
    const { version } = (await initial.json()) as { version: string }
    const copied = copyDay(draft, 'monday', ['saturday', 'sunday'])
    const input = {
      ...toScheduleBody(copied),
      overrides: [
        { date: Temporal.PlainDate.from(sunday).add({ days: 1 }).toString(), intervals: [] },
      ],
      expectedVersion: version,
    }
    // A different user's full-scope key cannot overwrite the snapshot.
    const denied = await send('PUT', path, input, 'stranger')
    expect(denied.status).toBe(404)
    expect(await denied.json()).toMatchObject({ error: 'schedule_not_found' })
    const untouched = await send('GET', path)
    expect(((await untouched.json()) as { version: string }).version).toBe(version)

    const saved = await send('PUT', path, input)
    expect(saved.status).toBe(200)
    const savedBody = await saved.json()
    expect(savedBody).toMatchObject({
      schedule: {
        timeZone: zone,
        weeklyHours: {
          monday: [{ start: '09:00', end: '10:00' }],
          saturday: [{ start: '09:00', end: '10:00' }],
          sunday: [{ start: '09:00', end: '10:00' }],
        },
      },
      overrides: input.overrides,
    })
    expect(await (await send('GET', path)).json()).toEqual(savedBody)

    const handle = `dst-${user.id}`
    await db.insertInto('profiles').values({ user_id: user.id, handle, time_zone: zone }).execute()
    await createFixtures(db).eventType(user.principal.organization.id, user.id, {
      slug: 'copied-hours',
      durationMinutes: 30,
    })
    for (const [index, date] of [saturday, sunday].entries()) {
      const start = Temporal.PlainDate.from(date).toZonedDateTime(zone).toInstant()
      const end = Temporal.PlainDate.from(date).add({ days: 1 }).toZonedDateTime(zone).toInstant()
      const query = new URLSearchParams({ start: start.toString(), end: end.toString() })
      const response = await app.request(`/api/v1/public/${handle}/copied-hours/slots?${query}`)
      expect(response.status).toBe(200)
      const { data } = (await response.json()) as { data: { start: string; end: string }[] }
      expect(data.map((slot) => Temporal.Instant.from(slot.start).toString())).toEqual([
        `${date}T${utcHours[index]}:00:00Z`,
        `${date}T${utcHours[index]}:30:00Z`,
      ])
      expect(
        data.map((slot) =>
          Temporal.Instant.from(slot.start).toZonedDateTimeISO(zone).toPlainTime().toString(),
        ),
      ).toEqual(['09:00:00', '09:30:00'])
      expect(
        Temporal.Instant.from(data[1]?.end ?? '')
          .toZonedDateTimeISO(zone)
          .toPlainTime()
          .toString(),
      ).toBe('10:00:00')
    }
  })
})
