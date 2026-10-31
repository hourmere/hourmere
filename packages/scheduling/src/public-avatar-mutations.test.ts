import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { publicAvatarImage } from '@hourmere/core/public-avatar'
import type { Db } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import {
  type findPublicEventType,
  type getPublicHost,
  parseLocation,
  servedHandle,
} from './availability.ts'
import { DomainError } from './errors.ts'
import { parseQuestions } from './questions.ts'

function sourceCopy<T>(name: string, end: string, replacement?: [string, string]): T {
  const original = readFileSync('packages/scheduling/src/availability.ts', 'utf8')
  const start = original.indexOf(`export async function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  let source = original.slice(start, original.indexOf(end, start))
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  source = stripTypeScriptTypes(source).replace(/\bexport /g, '')
  return new Function(
    'servedHandle',
    'SLUG',
    'parseLocation',
    'parseQuestions',
    'publicAvatarImage',
    'DomainError',
    `${source}; return ${name}`,
  )(
    servedHandle,
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
    parseLocation,
    parseQuestions,
    publicAvatarImage,
    DomainError,
  ) as T
}

function database(image: string): Db {
  const row = {
    id: 'event-id',
    organization_id: 'organization-id',
    user_id: 'user-id',
    name: 'Ada Lovelace',
    image,
    handle: 'ada',
    slug: 'intro',
    title: 'Intro call',
    description: null,
    duration_minutes: 30,
    slot_step_minutes: null,
    minimum_notice_minutes: 0,
    booking_window_days: null,
    location: null,
    zoom_connection_id: null,
    questions: [],
    allow_guests: false,
    time_zone: 'UTC',
  }
  const query = {
    innerJoin: () => query,
    select: () => query,
    where: () => query,
    orderBy: () => query,
    executeTakeFirst: async () => row,
    execute: async () => [],
  }
  return { selectFrom: () => query } as unknown as Db
}

const eventCopy = (replacement?: [string, string]) =>
  sourceCopy<typeof findPublicEventType>(
    'findPublicEventType',
    '\n/**\n * A team link',
    replacement,
  )
const hostCopy = (replacement?: [string, string]) =>
  sourceCopy<typeof getPublicHost>('getPublicHost', '\nexport interface SlotView', replacement)

async function verifyEvent(copy: typeof findPublicEventType) {
  expect(await copy(database('/assets/host.png'), 'ada', 'intro')).toHaveProperty(
    'hostImage',
    '/assets/host.png',
  )
  expect(await copy(database('https://avatar/host.png'), 'ada', 'intro')).not.toHaveProperty(
    'hostImage',
  )
}

async function verifyHost(copy: typeof getPublicHost) {
  const now = () => Temporal.Instant.from('2026-11-01T00:00:00Z')
  expect(await copy({ db: database('/assets/host.png'), now }, { handle: 'ada' })).toHaveProperty(
    'host.image',
    '/assets/host.png',
  )
  expect(
    await copy({ db: database('https://avatar/host.png'), now }, { handle: 'ada' }),
  ).not.toHaveProperty('host.image')
}

describe('personal public avatar projection negative controls', () => {
  it('verifies the copied event and host projections', async () => {
    await verifyEvent(eventCopy())
    await verifyHost(hostCopy())
  })

  it('detects bypassing the image filter for a personal event', async () => {
    const mutated = eventCopy(['publicAvatarImage(row.image)', 'row.image'])
    await expect(verifyEvent(mutated)).rejects.toThrowError()
  })

  it('detects bypassing the image filter for a host profile', async () => {
    const mutated = hostCopy(['publicAvatarImage(profile.image)', 'profile.image'])
    await expect(verifyHost(mutated)).rejects.toThrowError()
  })
})
