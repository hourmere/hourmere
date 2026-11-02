import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Db } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import {
  eventTypeNotFound,
  type PublicEventType,
  type PublicEventTypeRecord,
} from './availability.ts'
import type { getManagedBookingDetails } from './manage.ts'

type Change = readonly [string, string]

function source(file: string, start: string, end: string, change?: Change) {
  const original = readFileSync(`packages/scheduling/src/${file}.ts`, 'utf8')
  const offset = original.indexOf(start)
  expect(offset).toBeGreaterThan(-1)
  let copy = original.slice(offset, original.indexOf(end, offset))
  if (change) {
    expect(copy.includes(change[0]), 'mutation must match source').toBe(true)
    copy = copy.replace(...change)
  }
  return stripTypeScriptTypes(copy).replace(/\bexport /g, '')
}

function publicProjection(change?: Change) {
  const copy = source(
    'availability',
    'function publicEventType(',
    '/** One event type as the host',
    change,
  )
  return new Function('eventTypeNotFound', `${copy}; return publicEventType`)(
    eventTypeNotFound,
  ) as (event: PublicEventTypeRecord) => PublicEventType
}

function managedProjection(change?: Change): typeof getManagedBookingDetails {
  const copy = source(
    'manage',
    'export async function getManagedBookingDetails(',
    '/**\n * The times',
    change,
  )
  return new Function('getManagedBooking', `${copy}; return getManagedBookingDetails`)(
    async () => ({
      id: 'synthetic-booking',
      eventTypeId: 'synthetic-event',
    }),
  ) as typeof getManagedBookingDetails
}

function verifyPublic(project: ReturnType<typeof publicProjection>) {
  const event = {
    handle: 'ada',
    slug: 'call',
    title: 'Call',
    description: null,
    durationMinutes: 30,
    allowedDurationsMinutes: [15, 30, 60],
    questions: [],
    allowGuests: false,
    hostName: 'Ada',
    hostTimeZone: 'UTC',
    schedulingType: 'individual',
    hosts: [],
    location: null,
  } as unknown as PublicEventTypeRecord
  expect(project(event)).toMatchObject({
    durationMinutes: 30,
    allowedDurationsMinutes: [15, 30, 60],
  })
  expect(project({ ...event, allowedDurationsMinutes: [30] })).not.toHaveProperty(
    'allowedDurationsMinutes',
  )
}

async function verifyManaged(project: typeof getManagedBookingDetails) {
  const query = {
    select: () => query,
    innerJoin: () => query,
    leftJoin: () => query,
    where: () => query,
    orderBy: () => query,
    executeTakeFirst: async () => ({
      title: 'Call',
      duration_minutes: 30,
      allowed_durations_minutes: [15, 30, 60],
    }),
    execute: async () => [{ name: 'Ada', handle: 'ada' }],
  }
  const db = { selectFrom: () => query } as unknown as Db
  expect(await project({ db, now: () => Temporal.Now.instant() }, 'synthetic-token')).toMatchObject(
    {
      eventType: { durationMinutes: 30, allowedDurationsMinutes: [15, 30, 60] },
    },
  )
}

describe('public meeting length projection negative controls', () => {
  it('verifies the copied public and managed projections', async () => {
    verifyPublic(publicProjection())
    await verifyManaged(managedProjection())
  })
  it('detects hiding public meeting length choices', () => {
    expect(() =>
      verifyPublic(publicProjection(['et.allowedDurationsMinutes.length > 1', 'false'])),
    ).toThrowError(expect.objectContaining({ name: 'AssertionError' }))
  })
  it('detects hiding the current managed meeting length choices', async () => {
    await expect(
      verifyManaged(managedProjection(['eventType.allowed_durations_minutes.length > 1', 'false'])),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
