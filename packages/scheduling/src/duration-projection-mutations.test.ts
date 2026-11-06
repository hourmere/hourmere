import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { validateEventTypeRules } from '@hourmere/core'
import type { Db } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import {
  eventTypeNotFound,
  type PublicEventType,
  type PublicEventTypeRecord,
} from './availability.ts'
import { EVENT_TYPE_LIMITS } from './event-types.ts'
import { engineValidation } from './internal.ts'
import {
  compatLocation,
  locationOptionsFromLegacy,
  validateLocationOptions,
} from './location-options.ts'
import type { getManagedBookingDetails } from './manage.ts'

type Change = readonly [string, string]

type DurationFields = { allowedDurationsMinutes: number[] }

function fieldNormalization(change?: Change) {
  const copy = source('event-types', 'function validFields(', 'function validSlug(', change)
  const identity = (value: unknown) => value
  const bindings = {
    validateEventTypeRules,
    engineValidation,
    EVENT_TYPE_LIMITS,
    validSlug: identity,
    validTitle: identity,
    validDescription: identity,
    validLocation: identity,
    validateLocationOptions: (value: unknown) => validateLocationOptions(value ?? null),
    compatLocation,
    validateSuccessRedirect: identity,
    validateQuestions: identity,
  }
  return new Function(...Object.keys(bindings), `${copy}; return validFields`)(
    ...Object.values(bindings),
  ) as (input: Record<string, unknown>) => DurationFields
}

function legacyFieldProjection(change?: Change) {
  const copy = source('event-types', 'function fieldsOf(', 'function columns(', change)
  return new Function(
    'parseQuestions',
    'compatLocation',
    'locationOptionsFromLegacy',
    `${copy}; return fieldsOf`,
  )(
    (value: unknown) => value,
    compatLocation,
    (value: Parameters<typeof locationOptionsFromLegacy>[0]) =>
      locationOptionsFromLegacy(value ?? null),
  ) as (input: Record<string, unknown>) => DurationFields
}

function verifyNormalization(normalize: ReturnType<typeof fieldNormalization>) {
  const allowedDurationsMinutes = [60, 30, 5]
  const fields = normalize({
    durationMinutes: 30,
    allowedDurationsMinutes,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    isActive: true,
    isHidden: false,
    allowGuests: false,
    position: 0,
  })
  expect(fields.allowedDurationsMinutes).toEqual([5, 30, 60])
  expect(allowedDurationsMinutes).toEqual([60, 30, 5])
}

function verifyLegacyProjection(project: ReturnType<typeof legacyFieldProjection>) {
  const allowed_durations_minutes = [60, 30, 5]
  expect(project({ allowed_durations_minutes }).allowedDurationsMinutes).toEqual([5, 30, 60])
  expect(allowed_durations_minutes).toEqual([60, 30, 5])
}

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
    allowedDurationsMinutes: [60, 30, 5],
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
    allowedDurationsMinutes: [5, 30, 60],
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
      allowed_durations_minutes: [60, 30, 5],
    }),
    execute: async () => [{ name: 'Ada', handle: 'ada' }],
  }
  const db = { selectFrom: () => query } as unknown as Db
  expect(await project({ db, now: () => Temporal.Now.instant() }, 'synthetic-token')).toMatchObject(
    {
      eventType: { durationMinutes: 30, allowedDurationsMinutes: [5, 30, 60] },
    },
  )
}

describe('public meeting length projection negative controls', () => {
  it('normalizes supplied and legacy meeting lengths without mutating them', () => {
    verifyNormalization(fieldNormalization())
    verifyLegacyProjection(legacyFieldProjection())
  })
  it('detects storing supplied meeting lengths unsorted', () => {
    expect(() =>
      verifyNormalization(
        fieldNormalization([
          'allowedDurationsMinutes: [...(allowedDurationsMinutes as number[])].sort((a, b) => a - b)',
          'allowedDurationsMinutes: [...(allowedDurationsMinutes as number[])]',
        ]),
      ),
    ).toThrowError(expect.objectContaining({ name: 'AssertionError' }))
  })
  it('detects returning legacy meeting lengths unsorted to the editor', () => {
    expect(() =>
      verifyLegacyProjection(
        legacyFieldProjection([
          'allowedDurationsMinutes: [...row.allowed_durations_minutes].sort((a, b) => a - b)',
          'allowedDurationsMinutes: row.allowed_durations_minutes',
        ]),
      ),
    ).toThrowError(expect.objectContaining({ name: 'AssertionError' }))
  })
  it('verifies the copied public and managed projections', async () => {
    verifyPublic(publicProjection())
    await verifyManaged(managedProjection())
  })
  it('detects hiding public meeting length choices', () => {
    expect(() =>
      verifyPublic(publicProjection(['et.allowedDurationsMinutes.length > 1', 'false'])),
    ).toThrowError(expect.objectContaining({ name: 'AssertionError' }))
  })
  it('detects leaving public meeting lengths unsorted', () => {
    expect(() =>
      verifyPublic(
        publicProjection([
          'allowedDurationsMinutes: [...et.allowedDurationsMinutes].sort((a, b) => a - b)',
          'allowedDurationsMinutes: [...et.allowedDurationsMinutes]',
        ]),
      ),
    ).toThrowError(expect.objectContaining({ name: 'AssertionError' }))
  })
  it('detects leaving managed meeting lengths unsorted', async () => {
    await expect(
      verifyManaged(
        managedProjection([
          'allowedDurationsMinutes: [...eventType.allowed_durations_minutes].sort((a, b) => a - b)',
          'allowedDurationsMinutes: [...eventType.allowed_durations_minutes]',
        ]),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects lexicographic sorting in every duration normalization path', async () => {
    const lexical: Change = ['.sort((a, b) => a - b)', '.sort()']
    for (const verify of [
      () => verifyNormalization(fieldNormalization(lexical)),
      () => verifyLegacyProjection(legacyFieldProjection(lexical)),
      () => verifyPublic(publicProjection(lexical)),
      () => verifyManaged(managedProjection(lexical)),
    ]) {
      await expect(Promise.resolve().then(verify)).rejects.toMatchObject({ name: 'AssertionError' })
    }
  })
  it('detects hiding the current managed meeting length choices', async () => {
    await expect(
      verifyManaged(managedProjection(['eventType.allowed_durations_minutes.length > 1', 'false'])),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
