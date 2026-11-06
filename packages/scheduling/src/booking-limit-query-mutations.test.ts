import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertCachedCalendarSync,
  type buildAvailabilityInput,
  selectDurationMinutes,
  toInstant,
} from './availability.ts'
import { DomainError } from './errors.ts'
import { createFixtures, type Fixtures } from './testing.ts'

type Build = typeof buildAvailabilityInput
type Change = readonly [string, string]
const serverUrl = process.env.DATABASE_URL
const now = Temporal.Instant.from('2026-01-01T00:00Z')
const later = (a: Temporal.Instant, b: Temporal.Instant) =>
  Temporal.Instant.compare(a, b) >= 0 ? a : b
const earlier = (a: Temporal.Instant, b: Temporal.Instant) =>
  Temporal.Instant.compare(a, b) <= 0 ? a : b

/** Compile the real query and date helper, preserving its real PostgreSQL dependencies. */
function sourceCopy(change?: Change): Build {
  const original = readFileSync(new URL('./availability.ts', import.meta.url), 'utf8')
  const start = original.indexOf('export async function buildAvailabilityInput(')
  const end = original.indexOf('/**\n * The slots one host', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  let source = original.slice(start, end)
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source).replace(/\bexport /g, '')
  const bindings = {
    sql,
    selectDurationMinutes,
    toInstant,
    assertCachedCalendarSync,
    eventTypeNotFound: () => new DomainError('not_found', 'event_type_not_found'),
    earlier,
    later,
  }
  return new Function(...Object.keys(bindings), `${source}; return buildAvailabilityInput`)(
    ...Object.values(bindings),
  ) as Build
}

const controls: {
  name: string
  period: 'week' | 'month'
  timeZone: string
  booked: string
  candidate: string
  now?: string
  change: Change
}[] = [
  {
    name: 'complete local week query',
    period: 'week',
    timeZone: 'Pacific/Kiritimati',
    booked: '2026-12-28T00:00',
    candidate: '2027-01-03T23:00',
    change: ['if (eventType.max_bookings_per_week !== null)', 'if (false)'],
  },
  {
    name: 'complete local month query',
    period: 'month',
    timeZone: 'Pacific/Kiritimati',
    booked: '2026-12-01T00:00',
    candidate: '2026-12-31T23:00',
    change: ['if (eventType.max_bookings_per_month !== null)', 'if (false)'],
  },
  {
    name: 'upper padding at a historical midnight rollback',
    period: 'month',
    timeZone: 'America/St_Johns',
    booked: '2009-11-01T03:00Z',
    candidate: '2009-10-15T12:00',
    now: '2009-10-01T00:00Z',
    change: ['period.end.add({ hours: 24 })', 'period.end'],
  },
  {
    name: 'full target week end',
    period: 'week',
    timeZone: 'America/New_York',
    booked: '2027-03-14T23:00',
    candidate: '2027-03-08T12:00',
    change: [
      '.add({ days: 8 - lastDate.dayOfWeek })',
      '.subtract({ days: lastDate.dayOfWeek - 1 })',
    ],
  },
  {
    name: 'full leap-month end',
    period: 'month',
    timeZone: 'America/New_York',
    booked: '2028-02-29T23:00',
    candidate: '2028-02-01T12:00',
    change: ['.add({ months: 1 })', '.add({ months: 0 })'],
  },
]

describe.skipIf(!serverUrl)('booking limit query source-copy mutation controls', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'limit_query' })
    db = createDb(owned.pool)
    f = createFixtures(db)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function probe(copy: Build, control: (typeof controls)[number]) {
    const { timeZone } = control
    const local = (value: string) =>
      Temporal.PlainDateTime.from(value).toZonedDateTime(timeZone).toInstant()
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      ...(control.period === 'week' ? { maxBookingsPerWeek: 1 } : { maxBookingsPerMonth: 1 }),
    })
    const booked = control.booked.endsWith('Z')
      ? Temporal.Instant.from(control.booked)
      : local(control.booked)
    await f.booking(
      host.organizationId,
      [host.userId],
      booked.toString(),
      booked.add({ minutes: 30 }).toString(),
      { eventTypeId },
    )
    const rangeStart = local(control.candidate)
    const input = await copy(db, {
      eventTypeId,
      hostUserId: host.userId,
      rangeStart,
      rangeEnd: rangeStart.add({ minutes: 30 }),
      now: control.now ? Temporal.Instant.from(control.now) : now,
    })
    expect(input?.bookings?.some((booking) => booking.start.equals(booked))).toBe(true)
  }

  it('sees all target-period bookings with the unmodified source copy', async () => {
    const copy = sourceCopy()
    for (const control of controls) await probe(copy, control)
  })

  it.each(controls)('detects removal of $name', async (control) => {
    const copy = sourceCopy(control.change)
    await expect(probe(copy, control)).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
