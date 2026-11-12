// The booking list's cancelled view and search on a throwaway database: host and team scope,
// LIKE escaping and input bounds, keyset stability under concurrent writes, and
// daylight-saving day filters combined with a search.
import { randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { containsPattern, type ListBookingsInput, MAX_SEARCH_LENGTH } from './booking-page.ts'
import { cancelHostBooking, listHostBookings } from './bookings.ts'
import type { ServiceContext } from './context.ts'
import { listTeamAdminBookings } from './team-bookings.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type Fixtures,
  type TestUser,
  testContext,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const instant = Temporal.Instant.from

interface Person {
  name: string
  email: string
}

describe('booking search patterns', () => {
  it('escapes every LIKE metacharacter, so the text only ever matches itself', () => {
    expect(containsPattern('Ada')).toBe('%Ada%')
    expect(containsPattern('100%')).toBe('%100\\%%')
    expect(containsPattern('a_b')).toBe('%a\\_b%')
    expect(containsPattern('back\\slash')).toBe('%back\\\\slash%')
    expect(containsPattern('%_\\')).toBe('%\\%\\_\\\\%')
  })
})

describe.skipIf(!serverUrl)('booking list cancelled view and search', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    f = createFixtures(db)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  /** A booking with its hosts, invitee and guests, as the application writes it. */
  async function book(
    organizationId: string,
    hosts: string[],
    start: string,
    {
      eventTypeId = null,
      status = 'confirmed',
      invitee = { name: 'Invitee', email: 'invitee@example.com' },
      guests = [],
      id: chosenId,
    }: {
      eventTypeId?: string | null
      status?: 'confirmed' | 'cancelled'
      invitee?: Person
      guests?: Person[]
      id?: string
    } = {},
  ): Promise<string> {
    return db.transaction().execute(async (trx) => {
      const { id } = await trx
        .insertInto('bookings')
        .values({
          ...(chosenId ? { id: chosenId } : {}),
          organization_id: organizationId,
          event_type_id: eventTypeId,
          status,
          cancelled_at: status === 'cancelled' ? new Date() : null,
          start_at: instant(start).toString(),
          end_at: instant(start).add({ minutes: 30 }).toString(),
          // A custom title that matches nothing: search never reads the stored title.
          title: 'stored-title-never-searched',
          manage_token_hash: randomBytes(32),
          source: 'api',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      for (const userId of hosts)
        await trx.insertInto('booking_hosts').values({ booking_id: id, user_id: userId }).execute()
      await trx
        .insertInto('booking_attendees')
        .values([
          { booking_id: id, ...invitee, time_zone: 'UTC', is_booker: true },
          ...guests.map((guest) => ({
            booking_id: id,
            ...guest,
            time_zone: 'UTC',
            is_booker: false,
          })),
        ])
        .execute()
      return id
    })
  }

  async function session(
    user: TestUser,
    organization: ServiceContext['principal']['organization'],
  ) {
    const { id } = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token: randomBytes(24).toString('base64url'),
        expiresAt: sql<Date>`clock_timestamp() + interval '1 hour'`,
        updatedAt: new Date(),
        activeOrganizationId: organization.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return testContext(db, { kind: 'session', sessionId: id, user, organization }, now)
  }

  /** Every page of a host list, in order, with the cursor carried between pages. */
  async function allPages(
    ctx: ServiceContext,
    input: ListBookingsInput,
    list: typeof listHostBookings | typeof listTeamAdminBookings = listHostBookings,
  ) {
    const ids: string[] = []
    let cursor: string | undefined
    for (let pages = 0; pages < 50; pages += 1) {
      const page = await list(ctx, { ...input, cursor })
      ids.push(...page.data.map((booking) => booking.id))
      if (!page.nextCursor) return ids
      cursor = page.nextCursor
    }
    throw new Error('Too many pages')
  }

  /** A host in their personal organization with a set of distinguishable bookings. */
  async function hostWithBookings() {
    const host = await f.host({ name: 'Searching Host' })
    const ctx = testContext(
      db,
      {
        kind: 'api_key',
        apiKeyScope: 'full',
        apiKeyId: randomUUID(),
        user: { id: host.userId, name: 'Searching Host', email: 'host@example.com' },
        organization: {
          id: host.organizationId,
          name: 'Personal',
          slug: `personal-${randomUUID()}`,
          personal: true,
        },
      },
      now,
    )
    const strategy = await f.eventType(host.organizationId, host.userId, {
      title: 'Quarterly Strategy Session',
    })
    const intro = await f.eventType(host.organizationId, host.userId, { title: 'Intro call' })
    const removed = await f.eventType(host.organizationId, host.userId, {
      title: 'Retired Workshop',
      deletedAt: '2026-10-01T00:00:00Z',
    })
    const ids = {
      ada: await book(host.organizationId, [host.userId], '2026-11-02T09:00Z', {
        eventTypeId: intro,
        invitee: { name: 'Ada Lovelace', email: 'countess@analytical.example' },
      }),
      grace: await book(host.organizationId, [host.userId], '2026-11-02T10:00Z', {
        eventTypeId: intro,
        invitee: { name: 'Grace Hopper', email: 'Grace.Hopper@Navy.example' },
        guests: [{ name: 'Ada Guest', email: 'guest-only@example.com' }],
      }),
      strategy: await book(host.organizationId, [host.userId], '2026-11-02T11:00Z', {
        eventTypeId: strategy,
        invitee: { name: 'Katherine Johnson', email: 'katherine@example.com' },
      }),
      cancelledAda: await book(host.organizationId, [host.userId], '2026-11-03T09:00Z', {
        eventTypeId: strategy,
        status: 'cancelled',
        invitee: { name: 'ADA KING', email: 'king@example.com' },
      }),
      cancelledOther: await book(host.organizationId, [host.userId], '2026-11-03T10:00Z', {
        eventTypeId: intro,
        status: 'cancelled',
        invitee: { name: 'Dorothy Vaughan', email: 'dorothy@example.com' },
      }),
      cancelledLate: await book(host.organizationId, [host.userId], '2026-11-04T09:00Z', {
        status: 'cancelled',
        invitee: { name: 'Mary Jackson', email: 'mary@example.com' },
      }),
      retired: await book(host.organizationId, [host.userId], '2026-11-05T09:00Z', {
        eventTypeId: removed,
        invitee: { name: 'Annie Easley', email: 'annie@example.com' },
      }),
      percent: await book(host.organizationId, [host.userId], '2026-11-06T09:00Z', {
        invitee: { name: '100% Club', email: 'club@example.com' },
      }),
      underscore: await book(host.organizationId, [host.userId], '2026-11-06T10:00Z', {
        invitee: { name: 'Under Score', email: 'under_score@example.com' },
      }),
      lookalike: await book(host.organizationId, [host.userId], '2026-11-06T11:00Z', {
        invitee: { name: '1000 Club', email: 'underXscore@example.com' },
      }),
      backslash: await book(host.organizationId, [host.userId], '2026-11-06T12:00Z', {
        invitee: { name: 'Back\\Slash', email: 'backslash@example.com' },
      }),
    }
    return { host, ctx, ids }
  }

  it('lists only cancelled bookings in the cancelled view, a stable page at a time', async () => {
    const { ctx, ids } = await hostWithBookings()
    const cancelled = [ids.cancelledAda, ids.cancelledOther, ids.cancelledLate]
    expect(await allPages(ctx, { status: 'cancelled', limit: 1 })).toEqual(cancelled)
    expect(await allPages(ctx, { status: 'cancelled', limit: 2, order: 'desc' })).toEqual(
      cancelled.toReversed(),
    )
    const first = await listHostBookings(ctx, { status: 'cancelled', limit: 2 })
    expect(first.data.map((booking) => booking.status)).toEqual(['cancelled', 'cancelled'])
    expect(first.nextCursor).toEqual(expect.any(String))
    // Confirmed bookings stay out of the cancelled view and in the confirmed one.
    const confirmed = await allPages(ctx, { status: 'confirmed' })
    expect(confirmed).toHaveLength(8)
    expect(confirmed.some((id) => cancelled.includes(id))).toBe(false)
  })

  it('searches the invitee name and email and the event type title, ignoring case', async () => {
    const { ctx, ids } = await hostWithBookings()
    const search = (q: string, input: ListBookingsInput = {}) =>
      allPages(ctx, { ...input, q, limit: 2 })
    // Invitee name, either case, in any view.
    expect(await search('ada')).toEqual([ids.ada, ids.cancelledAda])
    expect(await search('LOVELACE')).toEqual([ids.ada])
    expect(await search('ada', { status: 'cancelled' })).toEqual([ids.cancelledAda])
    expect(await search('ada', { status: 'confirmed' })).toEqual([ids.ada])
    // Invitee email, either case.
    expect(await search('grace.hopper@navy')).toEqual([ids.grace])
    expect(await search('ANALYTICAL.EXAMPLE')).toEqual([ids.ada])
    // The live event type's title, either case.
    expect(await search('strategy')).toEqual([ids.strategy, ids.cancelledAda])
    expect(await search('INTRO CALL', { status: 'cancelled' })).toEqual([ids.cancelledOther])
    // Guests, stored booking titles and deleted event titles are not searched.
    expect(await search('guest-only')).toEqual([])
    expect(await search('stored-title')).toEqual([])
    expect(await search('Retired Workshop')).toEqual([])
    expect(await search('Annie')).toEqual([ids.retired])
    // Surrounding space is trimmed; blank text is no search at all.
    expect(await search('  Katherine  ')).toEqual([ids.strategy])
    expect(await search('   ')).toEqual(await allPages(ctx, {}))
    expect(await search('')).toHaveLength(11)
    expect(await search('nobody matches this')).toEqual([])
  })

  it('treats %, _ and backslash in the search as plain characters', async () => {
    const { ctx, ids } = await hostWithBookings()
    const search = async (q: string) => (await listHostBookings(ctx, { q })).data.map((b) => b.id)
    expect(await search('%')).toEqual([ids.percent])
    expect(await search('100%')).toEqual([ids.percent])
    expect(await search('%%')).toEqual([])
    expect(await search('_')).toEqual([ids.underscore])
    expect(await search('under_score')).toEqual([ids.underscore])
    expect(await search('der_s')).toEqual([ids.underscore])
    expect(await search('\\')).toEqual([ids.backslash])
    expect(await search('back\\slash')).toEqual([ids.backslash])
    expect(await search('\\%')).toEqual([])
  })

  it('refuses a search longer than the bound or with control characters', async () => {
    const { ctx } = await hostWithBookings()
    const longest = 'a'.repeat(MAX_SEARCH_LENGTH)
    expect(MAX_SEARCH_LENGTH).toBe(100)
    await expect(listHostBookings(ctx, { q: longest })).resolves.toMatchObject({ data: [] })
    // The bound applies after trimming.
    await expect(listHostBookings(ctx, { q: `  ${longest}\t ` })).resolves.toMatchObject({
      data: [],
    })
    for (const q of [`${longest}a`, 'Ada\u0000', 'Ada\nLovelace', '\u007f'])
      await expect(listHostBookings(ctx, { q }), JSON.stringify(q)).rejects.toMatchObject({
        kind: 'invalid',
        code: 'invalid_search',
      })
  })

  it('never widens the caller scope: other organizations, teams and hosts stay out', async () => {
    const { host, ctx, ids } = await hostWithBookings()
    // The same invitee in another organization, and in a team the host belongs to.
    const stranger = await f.host({ name: 'Stranger' })
    await book(stranger.organizationId, [stranger.userId], '2026-11-02T09:00Z', {
      invitee: { name: 'Ada Lovelace', email: 'countess@analytical.example' },
    })
    const [owner, admin, member, other] = await Promise.all(
      ['Owner', 'Admin', 'Member', 'Other admin'].map((name) => createTestUser(db, name)),
    )
    if (!owner || !admin || !member || !other) throw new Error('Missing test users')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const otherTeam = await createTestTeam(db, [{ user: other, role: 'owner' }])
    await f.member(host.userId, team.id)
    const teamEvent = await f.eventType(team.id, null, {
      title: 'Ada team review',
      hosts: [{ userId: owner.id }],
    })
    const teamAda = await book(team.id, [owner.id], '2026-11-02T13:00Z', {
      eventTypeId: teamEvent,
      invitee: { name: 'Ada Lovelace', email: 'countess@analytical.example' },
    })
    const teamCancelled = await book(team.id, [owner.id], '2026-11-02T14:00Z', {
      status: 'cancelled',
      invitee: { name: 'Ada Byron', email: 'byron@example.com' },
    })
    const memberOwn = await book(team.id, [member.id], '2026-11-02T15:00Z', {
      invitee: { name: 'Plain', email: 'plain@example.com' },
    })
    await book(otherTeam.id, [other.id], '2026-11-02T13:00Z', {
      invitee: { name: 'Ada Lovelace', email: 'countess@analytical.example' },
    })

    // The host's own list: only their personal organization's bookings.
    expect(await allPages(ctx, { q: 'ada' })).toEqual([ids.ada, ids.cancelledAda])
    // The host acting in the team hosts nothing there, so a search finds nothing.
    const hostInTeam = testContext(
      db,
      { ...ctx.principal, organization: { ...team.as(owner).organization } },
      now,
    )
    expect(await allPages(hostInTeam, { q: 'ada' })).toEqual([])
    // An ordinary member sees only what they host, whatever they search for.
    const memberHost = testContext(db, team.as(member), now)
    expect(await allPages(memberHost, { q: 'ada' })).toEqual([])
    expect(await allPages(memberHost, { q: 'plain' })).toEqual([memberOwn])
    expect(await allPages(memberHost, { q: 'team review' })).toEqual([])
    // Team administrators search this team only, and cancelled bookings by status.
    const ownerTeam = await session(owner, team.as(owner).organization)
    const adminTeam = await session(admin, team.as(admin).organization)
    for (const teamCtx of [ownerTeam, adminTeam]) {
      expect(await allPages(teamCtx, { q: 'ada' }, listTeamAdminBookings)).toEqual([
        teamAda,
        teamCancelled,
      ])
      expect(
        await allPages(teamCtx, { q: 'ADA', status: 'cancelled' }, listTeamAdminBookings),
      ).toEqual([teamCancelled])
      expect(await allPages(teamCtx, { q: 'team review' }, listTeamAdminBookings)).toEqual([
        teamAda,
      ])
    }
    // A team member without team-management access is refused before any search runs.
    const memberTeam = await session(member, team.as(member).organization)
    await expect(listTeamAdminBookings(memberTeam, { q: 'ada' })).rejects.toMatchObject({
      code: 'team_management_access_denied',
    })
  })

  it('keeps search and cancelled pages stable while bookings are added and cancelled', async () => {
    const host = await f.host({ name: 'Busy Host' })
    const ctx = testContext(
      db,
      {
        kind: 'api_key',
        apiKeyScope: 'full',
        apiKeyId: randomUUID(),
        user: { id: host.userId, name: 'Busy Host', email: 'busy@example.com' },
        organization: {
          id: host.organizationId,
          name: 'Personal',
          slug: `busy-${randomUUID()}`,
          personal: true,
        },
      },
      now,
    )
    const ada = { name: 'Ada Lovelace', email: 'ada@example.com' }
    const seeded: string[] = []
    const confirmed: string[] = []
    // Confirmed meetings a day apart, and cancelled ones sharing a start time (ties by id).
    for (let day = 10; day < 16; day += 1) {
      const id = await book(host.organizationId, [host.userId], `2026-11-${day}T09:00Z`, {
        invitee: ada,
      })
      seeded.push(id)
      confirmed.push(id)
      for (let n = 0; n < 2; n += 1)
        seeded.push(
          await book(host.organizationId, [host.userId], `2026-11-${day}T12:00Z`, {
            status: 'cancelled',
            invitee: ada,
          }),
        )
    }
    expect(new Set(await allPages(ctx, { q: 'ada', limit: 100 }))).toEqual(new Set(seeded))

    for (const [round, order] of (['asc', 'desc'] as const).entries()) {
      const seen: string[] = []
      const starts = new Map<string, string>()
      const read = (data: { id: string; start: string }[]) => {
        for (const booking of data) {
          seen.push(booking.id)
          starts.set(booking.id, booking.start)
        }
      }
      const first = await listHostBookings(ctx, { q: 'ada', order, limit: 4 })
      read(first.data)
      const boundary = first.data.at(-1)
      if (!boundary || !first.nextCursor) throw new Error('Missing first page')
      // While the next page is read: matching bookings before, at and after the cursor, a
      // non-matching one, and a cancellation of a confirmed booking not yet seen.
      const unseen = confirmed.find((id) => !seen.includes(id))
      if (!unseen) throw new Error('Every confirmed booking is on the first page')
      confirmed.splice(confirmed.indexOf(unseen), 1)
      const [page] = await Promise.all([
        listHostBookings(ctx, { q: 'ada', order, limit: 4, cursor: first.nextCursor }),
        book(host.organizationId, [host.userId], `2026-11-0${round + 1}T09:00Z`, {
          invitee: ada,
        }),
        book(host.organizationId, [host.userId], boundary.start, {
          status: 'cancelled',
          invitee: ada,
        }),
        book(host.organizationId, [host.userId], `2026-11-2${round}T09:00Z`, { invitee: ada }),
        book(host.organizationId, [host.userId], `2026-11-2${round + 2}T09:00Z`, {
          invitee: { name: 'Someone Else', email: 'else@example.com' },
        }),
        cancelHostBooking(ctx, unseen),
      ])
      read(page.data)
      let cursor = page.nextCursor
      while (cursor) {
        const next = await listHostBookings(ctx, { q: 'ada', order, limit: 4, cursor })
        read(next.data)
        cursor = next.nextCursor
      }
      // No duplicates, every booking that existed before the first page exactly once, and
      // the order follows (start, id) in the requested direction.
      expect(new Set(seen).size).toBe(seen.length)
      for (const id of seeded) expect(seen.filter((s) => s === id)).toHaveLength(1)
      const sorted = seen.toSorted((a, b) => {
        const byStart = Date.parse(starts.get(a) ?? '') - Date.parse(starts.get(b) ?? '')
        return (byStart || (a < b ? -1 : a > b ? 1 : 0)) * (order === 'asc' ? 1 : -1)
      })
      expect(seen).toEqual(sorted)
    }

    // The cancelled view pages stay disjoint while more bookings are cancelled meanwhile.
    const confirmedLeft = confirmed.slice(0, 3)
    const cancelledBefore = await allPages(ctx, { status: 'cancelled', q: 'ada', limit: 100 })
    const firstCancelled = await listHostBookings(ctx, { status: 'cancelled', q: 'ada', limit: 5 })
    await Promise.all(confirmedLeft.map((id) => cancelHostBooking(ctx, id)))
    const cancelledSeen = firstCancelled.data.map((b) => b.id)
    let cancelledCursor = firstCancelled.nextCursor
    while (cancelledCursor) {
      const next = await listHostBookings(ctx, {
        status: 'cancelled',
        q: 'ada',
        limit: 5,
        cursor: cancelledCursor,
      })
      cancelledSeen.push(...next.data.map((b) => b.id))
      cancelledCursor = next.nextCursor
    }
    expect(new Set(cancelledSeen).size).toBe(cancelledSeen.length)
    for (const id of cancelledBefore) expect(cancelledSeen).toContain(id)
    const statuses = await db
      .selectFrom('bookings')
      .select('status')
      .where('id', 'in', cancelledSeen)
      .execute()
    expect(new Set(statuses.map((row) => row.status))).toEqual(new Set(['cancelled']))
  })

  it('orders bookings that start together by id on every page, in both directions', async () => {
    const host = await f.host({ name: 'Tied Host' })
    const ctx = testContext(
      db,
      {
        kind: 'api_key',
        apiKeyScope: 'full',
        apiKeyId: randomUUID(),
        user: { id: host.userId, name: 'Tied Host', email: 'tied@example.com' },
        organization: {
          id: host.organizationId,
          name: 'Personal',
          slug: `tied-${randomUUID()}`,
          personal: true,
        },
      },
      now,
    )
    // Cancelled bookings may share a start; insert them in descending id order, so storage
    // order and id order disagree.
    const ids = Array.from({ length: 7 }, () => randomUUID()).toSorted()
    for (const id of ids.toReversed())
      await book(host.organizationId, [host.userId], '2026-11-09T09:00Z', {
        id,
        status: 'cancelled',
        invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      })
    for (const input of [
      { status: 'cancelled' as const },
      { q: 'ada' },
      { status: 'cancelled' as const, q: 'lovelace' },
    ]) {
      expect(await allPages(ctx, { ...input, limit: 2 }), JSON.stringify(input)).toEqual(ids)
      expect(await allPages(ctx, { ...input, limit: 3, order: 'desc' })).toEqual(ids.toReversed())
    }
  })

  it.each([
    // Spring forward: the local day lasts 23 hours.
    ['America/New_York', '2026-03-08', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'],
    // Fall back: the local day lasts 25 hours.
    ['America/New_York', '2026-11-01', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'],
    // Europe moves a week earlier in autumn and at 01:00 UTC.
    ['Europe/Berlin', '2026-10-25', '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z'],
  ])(
    'combines a search with a local-day range across the %s change on %s',
    async (timeZone, day, fromUtc, toUtc) => {
      const host = await f.host({ name: 'Zone Host', timeZone })
      const ctx = testContext(
        db,
        {
          kind: 'api_key',
          apiKeyScope: 'full',
          apiKeyId: randomUUID(),
          user: { id: host.userId, name: 'Zone Host', email: 'zone@example.com' },
          organization: {
            id: host.organizationId,
            name: 'Personal',
            slug: `zone-${randomUUID()}`,
            personal: true,
          },
        },
        now,
      )
      // The local day's bounds come from the zone rules, not from 24 hours.
      const date = Temporal.PlainDate.from(day)
      const from = date.toZonedDateTime({ timeZone }).toInstant()
      const to = date.add({ days: 1 }).toZonedDateTime({ timeZone }).toInstant()
      expect([from.toString(), to.toString()]).toEqual([fromUtc, toUtc])
      const ada = { name: 'Ada Lovelace', email: 'ada@example.com' }
      const at = (offsetMinutes: number) => from.add({ minutes: offsetMinutes }).toString()
      const hours = to.since(from).total({ unit: 'minutes' })
      const before = await book(host.organizationId, [host.userId], at(-30), { invitee: ada })
      const firstMinute = await book(host.organizationId, [host.userId], at(0), { invitee: ada })
      // Around the change itself: 01:30 and 03:30 local on the spring day are 1 hour apart.
      const nearChange = await book(host.organizationId, [host.userId], at(6 * 60), {
        invitee: ada,
        status: 'cancelled',
      })
      const lastSlot = await book(host.organizationId, [host.userId], at(hours - 30), {
        invitee: ada,
      })
      await book(host.organizationId, [host.userId], at(hours - 15), {
        invitee: { name: 'Not Searched', email: 'nobody@example.com' },
        status: 'cancelled',
      })
      const nextDay = await book(host.organizationId, [host.userId], at(hours), { invitee: ada })
      const inDay = await allPages(ctx, { from, to, q: 'ada', limit: 1 })
      expect(inDay).toEqual([firstMinute, nearChange, lastSlot])
      expect(await allPages(ctx, { from, to, q: 'ADA', status: 'cancelled' })).toEqual([nearChange])
      expect(await allPages(ctx, { q: 'ada', to: from })).toEqual([before])
      expect(await allPages(ctx, { q: 'ada', from: to })).toEqual([nextDay])
    },
  )
})
