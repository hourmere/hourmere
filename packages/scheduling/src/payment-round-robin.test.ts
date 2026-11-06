import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listPublicTeamSlots } from './availability.ts'
import { createPublicTeamBooking, insertBooking } from './bookings.ts'
import { activateRoundRobin, createEventType } from './event-types.ts'
import { notificationSnapshot } from './notification-settings.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

async function copy(
  file: string,
  exports: string,
  before: string,
  after: string,
): Promise<Record<string, unknown>> {
  const url = new URL(file, import.meta.url)
  let source = readFileSync(url, 'utf8')
  expect(source.includes(before)).toBe(true)
  source = stripTypeScriptTypes(source.replace(before, after))
  const bindings: Record<string, unknown> = {}
  for (const match of [...source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm)]) {
    const specifier = match[2] as string
    const imported = await import(
      specifier.startsWith('.') ? new URL(specifier, url).href : specifier
    )
    for (const binding of (match[1] as string)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      const [name, local] = binding.split(/\s+as\s+/)
      bindings[local ?? (name as string)] = imported[name as string]
    }
    source = source.replace(match[0], '')
  }
  source = source.replace(/^export \{[^}]*\} from '[^']+'\n/gm, '')
  return new Function(
    ...Object.keys(bindings),
    `${source.replace(/\bexport /g, '')}; return { ${exports} }`,
  )(...Object.values(bindings))
}

describe.skipIf(!process.env.DATABASE_URL)('round-robin payment hold admission', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function admission(api = createPublicTeamBooking) {
    const users = [await createTestUser(db), await createTestUser(db)]
    const owner = users[0]
    if (!owner) throw new Error('Missing owner')
    const team = await createTestTeam(
      db,
      users.map((user, i) => ({ user, role: i === 0 ? 'owner' : 'member' })),
    )
    const ctx = testContext(db, team.as(owner))
    const f = createFixtures(db)
    for (const user of users) await f.schedule(user.id, { timeZone: 'UTC' })
    const event = await createEventType(ctx, {
      slug: 'round',
      title: 'Round robin',
      durationMinutes: 30,
      schedulingType: 'round_robin',
      hosts: users.map((u) => ({ userId: u.id })),
    })
    await activateRoundRobin(ctx, event.id)
    let date = Temporal.Now.plainDateISO('UTC').add({ days: 3 })
    while (date.dayOfWeek !== 1) date = date.add({ days: 1 })
    const start = date.toZonedDateTime({ timeZone: 'UTC', plainTime: '12:00' }).toInstant()
    const end = start.add({ minutes: 30 })
    const { rows } = await owned.pool.query<{ deadline: string }>(
      "SELECT (clock_timestamp()-interval '1 minute')::text AS deadline",
    )
    if (!rows[0]) throw new Error('Missing DB clock')
    const deadline = Temporal.Instant.from(rows[0].deadline).toString()
    const holds = []
    for (const user of users) {
      holds.push(
        await db.transaction().execute((trx) =>
          insertBooking(trx, {
            organizationId: ctx.principal.organization.id,
            eventTypeId: null,
            start,
            end,
            title: 'Overdue hold',
            location: null,
            responses: {},
            source: 'web',
            apiKeyId: null,
            hostUserIds: [user.id],
            hostsUseDefaultSchedule: false,
            attendees: [],
            notificationSnapshot: notificationSnapshot(null),
            manageTokenHash: null,
            paymentHoldExpiresAt: deadline,
          }),
        ),
      )
    }
    const page = { handle: ctx.principal.organization.slug, slug: event.slug }
    const pub = { db, now: () => Temporal.Now.instant() }
    const offered = await listPublicTeamSlots(pub, { ...page, start, end })
    expect(offered).toHaveLength(1)
    await expect(
      api(pub, {
        ...page,
        start,
        invitee: { name: 'Synthetic', email: 'rr@example.com', timeZone: 'UTC' },
      }),
    ).resolves.toHaveProperty('booking.id')
    expect(
      await db
        .selectFrom('bookings')
        .select('status')
        .where(
          'id',
          'in',
          holds.map((h) => h.id),
        )
        .execute(),
    ).toEqual([{ status: 'expired' }, { status: 'expired' }])
  }
  it('releases every candidate overdue hold before round-robin admission without a worker', async () => {
    await admission()
  })
  it('detects omission of round-robin admission cleanup in an isolated source copy', async () => {
    const mutant = await copy(
      './bookings.ts',
      'createPublicTeamBooking',
      'await expirePaymentHolds({ db: trx, hostUserId })',
      '',
    )
    await expect(
      admission(mutant.createPublicTeamBooking as typeof createPublicTeamBooking),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
