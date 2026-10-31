import { EVENT_TYPE_RULE_BOUNDS, getAvailableSlots } from '@hourmere/core'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createEventType,
  deleteEventType,
  type EventType,
  type EventTypeInput,
  getEventType,
  listEventTypes,
  updateEventType,
} from './event-types.ts'
import { createSchedule, deleteSchedule } from './schedules.ts'
import {
  createTestTeam,
  createTestUser,
  domainError,
  type TestTeam,
  type TestUser,
  testContext,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('event type service', () => {
  let testDb: TestDatabase
  let db: Db

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  const personal = (user: TestUser) => testContext(db, user.principal)
  const inTeam = (team: TestTeam, user: TestUser) => testContext(db, team.as(user))
  const input = (overrides: Partial<EventTypeInput> = {}): EventTypeInput => ({
    slug: 'intro',
    title: 'Intro call',
    durationMinutes: 30,
    ...overrides,
  })
  const schedule = (user: TestUser) =>
    createSchedule(personal(user), { name: 'Hours', timeZone: 'UTC', weeklyHours: {} })
  const hosts = (eventTypeId: string) =>
    db
      .selectFrom('event_type_hosts')
      .select(['user_id', 'schedule_id'])
      .where('event_type_id', '=', eventTypeId)
      .execute()

  describe('duration options', () => {
    it('persists options and edits the default without changing the list', async () => {
      const user = await createTestUser(db)
      const ctx = personal(user)
      const created = await createEventType(ctx, input({ allowedDurationsMinutes: [15, 30, 60] }))
      expect(created.allowedDurationsMinutes).toEqual([15, 30, 60])
      expect((await getEventType(ctx, created.id)).allowedDurationsMinutes).toEqual([15, 30, 60])
      expect((await listEventTypes(ctx))[0]?.allowedDurationsMinutes).toEqual([15, 30, 60])
      const changed = await updateEventType(ctx, created.id, { durationMinutes: 60 })
      expect(changed.durationMinutes).toBe(60)
      expect(changed.allowedDurationsMinutes).toEqual([15, 30, 60])
      await expect(updateEventType(ctx, created.id, { durationMinutes: 45 })).rejects.toMatchObject(
        { code: 'invalid_event_type' },
      )
      expect((await getEventType(ctx, created.id)).durationMinutes).toBe(60)
      const replaced = await updateEventType(ctx, created.id, {
        durationMinutes: 45,
        allowedDurationsMinutes: [45, 90],
      })
      expect(replaced.allowedDurationsMinutes).toEqual([45, 90])
      const metadata = await updateEventType(ctx, created.id, { title: 'Renamed' })
      expect(metadata.allowedDurationsMinutes).toEqual([45, 90])
    })

    it('keeps legacy creation and duration-only edits as singleton options', async () => {
      const user = await createTestUser(db)
      const ctx = personal(user)
      const created = await createEventType(ctx, input())
      expect(created.allowedDurationsMinutes).toEqual([30])
      await expect(
        updateEventType(ctx, created.id, { durationMinutes: 45 }),
      ).resolves.toMatchObject({ durationMinutes: 45, allowedDurationsMinutes: [45] })
      const bounds = await createEventType(
        ctx,
        input({ slug: 'bounds', durationMinutes: 1, allowedDurationsMinutes: [1, 1440] }),
      )
      expect(bounds.allowedDurationsMinutes).toEqual([1, 1440])
    })

    it.each(
      [
        [],
        [15, 60],
        [30, 30],
        [0, 30],
        [30, 1441],
        [30, 15.5],
        Array.from({ length: 13 }, (_, i) => i + 30),
        null,
        '30',
        [30, undefined],
      ].map((value) => [value]),
    )('rejects invalid duration options %j before writing', async (allowedDurationsMinutes) => {
      const user = await createTestUser(db)
      const ctx = personal(user)
      const bad = { allowedDurationsMinutes } as unknown as Partial<EventTypeInput>
      await expect(createEventType(ctx, input(bad))).rejects.toMatchObject({
        code: 'invalid_event_type',
      })
      expect(await listEventTypes(ctx)).toEqual([])
      const created = await createEventType(ctx, input())
      await expect(updateEventType(ctx, created.id, bad)).rejects.toMatchObject({
        code: 'invalid_event_type',
      })
      expect((await getEventType(ctx, created.id)).allowedDurationsMinutes).toEqual([30])
    })
  })

  describe('in a personal organization', () => {
    it('creates an event type on the personal page with defaults, hosted by the user', async () => {
      const user = await createTestUser(db)
      const created = await createEventType(personal(user), input())
      expect(created).toEqual({
        id: expect.any(String),
        organizationId: user.principal.organization.id,
        ownerUserId: user.id,
        slug: 'intro',
        title: 'Intro call',
        description: null,
        durationMinutes: 30,
        allowedDurationsMinutes: [30],
        slotStepMinutes: null,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minimumNoticeMinutes: 0,
        bookingWindowDays: null,
        maxBookingsPerDay: null,
        schedulingType: 'individual',
        roundRobinActive: false,
        conferenceOrganizer: null,
        hosts: [{ userId: user.id }],
        location: null,
        questions: [],
        isActive: true,
        isHidden: false,
        allowGuests: false,
        position: 0,
        scheduleId: null,
        createdAt: expect.stringMatching(/Z$/),
        updatedAt: expect.stringMatching(/Z$/),
      } satisfies EventType)
      expect(await hosts(created.id)).toEqual([{ user_id: user.id, schedule_id: null }])
      expect(await getEventType(personal(user), created.id)).toEqual(created)
      expect(await listEventTypes(personal(user))).toEqual([created])
    })

    it('stores every field', async () => {
      const user = await createTestUser(db)
      const { id: scheduleId } = await schedule(user)
      const full = {
        slug: 'deep-dive',
        title: '  Deep dive  ',
        description: '  Bring questions.  ',
        durationMinutes: 90,
        slotStepMinutes: 15,
        bufferBeforeMinutes: 5,
        bufferAfterMinutes: 10,
        minimumNoticeMinutes: 1440,
        bookingWindowDays: 60,
        maxBookingsPerDay: 3,
        location: { kind: 'in_person', address: ' 1 Main St ' },
        questions: [
          { id: 'company', label: 'Company', type: 'short_text', required: true },
          { id: 'topic', label: 'Topic', type: 'select', required: false, options: ['A', ' B '] },
          { id: 'notes', label: 'Notes', type: 'long_text' },
          { id: 'tools', label: 'Tools', type: 'multi_select', options: ['Git', 'Jira'] },
          { id: 'phone', label: 'Phone', type: 'phone' },
          { id: 'terms', label: 'I agree', type: 'checkbox', required: true },
        ],
        isActive: false,
        position: 7,
        scheduleId,
      } as EventTypeInput
      const created = await createEventType(personal(user), full)
      expect(created).toMatchObject({
        slug: 'deep-dive',
        title: 'Deep dive',
        description: 'Bring questions.',
        durationMinutes: 90,
        slotStepMinutes: 15,
        bufferBeforeMinutes: 5,
        bufferAfterMinutes: 10,
        minimumNoticeMinutes: 1440,
        bookingWindowDays: 60,
        maxBookingsPerDay: 3,
        location: { kind: 'in_person', address: '1 Main St' },
        questions: [
          { id: 'company', label: 'Company', type: 'short_text', required: true },
          { id: 'topic', label: 'Topic', type: 'select', required: false, options: ['A', 'B'] },
          { id: 'notes', label: 'Notes', type: 'long_text', required: false },
          {
            id: 'tools',
            label: 'Tools',
            type: 'multi_select',
            required: false,
            options: ['Git', 'Jira'],
          },
          { id: 'phone', label: 'Phone', type: 'phone', required: false },
          { id: 'terms', label: 'I agree', type: 'checkbox', required: true },
        ],
        isActive: false,
        position: 7,
        scheduleId,
      })
      expect(await getEventType(personal(user), created.id)).toEqual(created)
    })

    it('accepts each kind of location', async () => {
      const user = await createTestUser(db)
      const locations = [
        { kind: 'google_meet' },
        { kind: 'zoom' },
        { kind: 'phone', number: '+14155550123' },
        { kind: 'in_person', address: 'Room 4' },
        { kind: 'link', url: 'https://example.com/room' },
      ] as const
      for (const [i, location] of locations.entries()) {
        const created = await createEventType(personal(user), input({ slug: `l${i}`, location }))
        expect(created.location).toEqual(location)
      }
    })

    it('stores a link trimmed and as parsed (normalized)', async () => {
      const user = await createTestUser(db)
      const created = await createEventType(
        personal(user),
        input({ location: { kind: 'link', url: '  https://Example.COM/room?q=1  ' } }),
      )
      const parsed = { kind: 'link', url: 'https://example.com/room?q=1' }
      expect(created.location).toEqual(parsed)
      const row = await db
        .selectFrom('event_types')
        .select('location')
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow()
      expect(row.location).toEqual(parsed)
    })

    it.each([
      ['line breaks', 'https://example.com/ro\r\nom'],
      ['a tab', 'https://example.com/\troom'],
      ['NUL', 'https://example.com/\u0000'],
      ['a C1 control', 'https://example.com/\u0085'],
      ['a line separator', 'https://example.com/a\u2028b'],
      ['a lone surrogate', 'https://example.com/\ud800'],
    ])('refuses a link with %s, which the parser would drop or encode', async (_, url) => {
      const user = await createTestUser(db)
      const error = await domainError(() =>
        createEventType(personal(user), input({ location: { kind: 'link', url } })),
      )
      expect(error.code).toBe('invalid_location')
    })

    it('bounds links at 2000 characters, as given and as parsed', async () => {
      const user = await createTestUser(db)
      const prefix = 'https://example.com/'
      const url = (length: number) => `${prefix}${'a'.repeat(length - prefix.length)}`
      const longest = await createEventType(
        personal(user),
        input({ slug: 'longest', location: { kind: 'link', url: url(2000) } }),
      )
      expect(longest.location).toEqual({ kind: 'link', url: url(2000) })
      // 2000 characters as given, but each space becomes %20 when parsed.
      const growing = `${prefix}${' x'.repeat(990)}`
      expect(growing).toHaveLength(2000)
      for (const tooLong of [url(2001), growing]) {
        const error = await domainError(() =>
          createEventType(
            personal(user),
            input({ slug: 'long', location: { kind: 'link', url: tooLong } }),
          ),
        )
        expect(error.code).toBe('invalid_location')
      }
    })

    it('keeps tabs and line breaks in a description', async () => {
      const user = await createTestUser(db)
      const created = await createEventType(
        personal(user),
        input({ description: '  Agenda:\n\t1. Intro\r\n\t2. Questions  ' }),
      )
      expect(created.description).toBe('Agenda:\n\t1. Intro\r\n\t2. Questions')
    })

    it('lists by position, then creation', async () => {
      const user = await createTestUser(db)
      await createEventType(personal(user), input({ slug: 'c', position: 2 }))
      await createEventType(personal(user), input({ slug: 'a', position: 1 }))
      await createEventType(personal(user), input({ slug: 'b', position: 1 }))
      expect((await listEventTypes(personal(user))).map((e) => e.slug)).toEqual(['a', 'b', 'c'])
    })

    it('keeps slugs unique per personal page', async () => {
      const [a, b] = [await createTestUser(db), await createTestUser(db)]
      const first = await createEventType(personal(a), input())
      const error = await domainError(() => createEventType(personal(a), input({ title: 'Again' })))
      expect(error.kind).toBe('conflict')
      expect(error.code).toBe('slug_taken')
      expect(error.cause).toMatchObject({ code: '23505', constraint: 'event_types_personal_slug' })
      expect(await listEventTypes(personal(a))).toEqual([first])
      // Another user's page is another namespace.
      await createEventType(personal(b), input())

      const other = await createEventType(personal(a), input({ slug: 'other' }))
      const renamed = await domainError(() =>
        updateEventType(personal(a), other.id, { slug: 'intro' }),
      )
      expect(renamed.code).toBe('slug_taken')
    })

    it("treats another user's event types as missing", async () => {
      const [owner, other] = [await createTestUser(db), await createTestUser(db)]
      const created = await createEventType(personal(owner), input())
      expect(await listEventTypes(personal(other))).toEqual([])
      for (const attempt of [
        () => getEventType(personal(other), created.id),
        () => updateEventType(personal(other), created.id, { title: 'Mine' }),
        () => deleteEventType(personal(other), created.id),
      ]) {
        const error = await domainError(attempt)
        expect(error.kind).toBe('not_found')
        expect(error.code).toBe('event_type_not_found')
      }
      expect(await getEventType(personal(owner), created.id)).toEqual(created)
      expect((await domainError(() => getEventType(personal(owner), 'nope'))).code).toBe(
        'event_type_not_found',
      )
    })
  })

  describe('updating', () => {
    it('changes only the given fields and clears nullable ones with null', async () => {
      const user = await createTestUser(db)
      const created = await createEventType(
        personal(user),
        input({
          description: 'Hi',
          slotStepMinutes: 15,
          bookingWindowDays: 30,
          maxBookingsPerDay: 4,
          location: { kind: 'zoom' },
        }),
      )
      const updated = await updateEventType(personal(user), created.id, {
        title: 'Renamed',
        description: null,
        slotStepMinutes: null,
        bookingWindowDays: null,
        maxBookingsPerDay: null,
        location: null,
      })
      expect(updated).toEqual({
        ...created,
        title: 'Renamed',
        description: null,
        slotStepMinutes: null,
        bookingWindowDays: null,
        maxBookingsPerDay: null,
        location: null,
        updatedAt: expect.any(String),
      })
      expect(await updateEventType(personal(user), created.id, {})).toEqual(updated)
      const blank = await updateEventType(personal(user), created.id, { description: '   ' })
      expect(blank.description).toBeNull()
    })

    it('sets the host schedule to one of the host’s schedules, and back to the default', async () => {
      const user = await createTestUser(db)
      const created = await createEventType(personal(user), input())
      const { id: scheduleId } = await schedule(user)
      const withSchedule = await updateEventType(personal(user), created.id, { scheduleId })
      expect(withSchedule.scheduleId).toBe(scheduleId)
      expect(await hosts(created.id)).toEqual([{ user_id: user.id, schedule_id: scheduleId }])
      const back = await updateEventType(personal(user), created.id, { scheduleId: null })
      expect(back.scheduleId).toBeNull()
    })

    it('moves updatedAt when only the host schedule changes', async () => {
      // Read in microseconds: the API's milliseconds can tie between two quick requests.
      const updatedAt = async (id: string) => {
        const { rows } = await testDb.pool.query<{ us: string }>(
          'SELECT (extract(epoch FROM updated_at) * 1000000)::bigint::text AS us FROM event_types WHERE id = $1',
          [id],
        )
        return BigInt(rows[0]?.us ?? '0')
      }
      const user = await createTestUser(db)
      const created = await createEventType(personal(user), input())
      const { id: scheduleId } = await schedule(user)
      const before = await updatedAt(created.id)
      const updated = await updateEventType(personal(user), created.id, { scheduleId })
      expect(await updatedAt(created.id)).toBeGreaterThan(before)
      expect(updated.updatedAt >= created.updatedAt).toBe(true)
      expect(updated).toEqual({ ...created, scheduleId, updatedAt: updated.updatedAt })
    })

    it('falls back to the default schedule when the host deletes the schedule', async () => {
      const user = await createTestUser(db)
      await schedule(user) // the default
      const { id: scheduleId } = await schedule(user)
      const created = await createEventType(personal(user), input({ scheduleId }))
      await deleteSchedule(personal(user), scheduleId)
      expect((await getEventType(personal(user), created.id)).scheduleId).toBeNull()
    })

    it("refuses another user's schedule, keeping the database error as the cause", async () => {
      const [user, other] = [await createTestUser(db), await createTestUser(db)]
      const { id: theirs } = await schedule(other)
      const created = await domainError(() =>
        createEventType(personal(user), input({ scheduleId: theirs })),
      )
      expect(created.kind).toBe('invalid')
      expect(created.code).toBe('invalid_schedule_id')
      expect(created.detail).not.toContain(theirs)
      expect(created.cause).toMatchObject({
        code: '23503',
        constraint: 'event_type_hosts_schedule_id_user_id_fkey',
      })
      // The whole creation rolled back.
      expect(await listEventTypes(personal(user))).toEqual([])

      const eventType = await createEventType(personal(user), input())
      const updated = await domainError(() =>
        updateEventType(personal(user), eventType.id, { scheduleId: theirs, title: 'X' }),
      )
      expect(updated.code).toBe('invalid_schedule_id')
      expect(await getEventType(personal(user), eventType.id)).toEqual(eventType)

      const malformed = await domainError(() =>
        updateEventType(personal(user), eventType.id, { scheduleId: 'nope' }),
      )
      expect(malformed.code).toBe('invalid_schedule_id')
      expect(malformed.kind).toBe('invalid')
    })
  })

  describe('deleting', () => {
    it('marks the event type deleted, hides it and frees its slug', async () => {
      const user = await createTestUser(db)
      const now = Temporal.Instant.from('2026-10-16T12:00:00Z')
      const ctx = testContext(db, user.principal, () => now)
      const created = await createEventType(ctx, input())
      await deleteEventType(ctx, created.id)

      const row = await db
        .selectFrom('event_types')
        .select('deleted_at')
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow()
      expect(row.deleted_at?.toISOString()).toBe('2026-10-16T12:00:00.000Z')
      expect(await hosts(created.id)).toHaveLength(1)

      expect(await listEventTypes(ctx)).toEqual([])
      for (const attempt of [
        () => getEventType(ctx, created.id),
        () => updateEventType(ctx, created.id, { title: 'Back' }),
        () => deleteEventType(ctx, created.id),
      ]) {
        expect((await domainError(attempt)).code).toBe('event_type_not_found')
      }
      const again = await createEventType(ctx, input())
      expect(again.id).not.toBe(created.id)
    })
  })

  describe('in a team', () => {
    let owner: TestUser
    let admin: TestUser
    let member: TestUser
    let multi: TestUser
    let outsider: TestUser
    let team: TestTeam

    beforeAll(async () => {
      owner = await createTestUser(db, 'Owner')
      admin = await createTestUser(db, 'Admin')
      member = await createTestUser(db, 'Member')
      multi = await createTestUser(db, 'Member and admin')
      outsider = await createTestUser(db, 'Outsider')
      team = await createTestTeam(db, [
        { user: owner, role: 'owner' },
        { user: admin, role: 'admin' },
        { user: member, role: 'member' },
        { user: multi, role: 'member,admin' },
      ])
    })

    it('lets owners and admins create team event types, hosted by the creator', async () => {
      const created = await createEventType(inTeam(team, admin), input({ slug: 'team-intro' }))
      expect(created).toMatchObject({
        organizationId: team.id,
        ownerUserId: null,
        schedulingType: 'individual',
      })
      expect(await hosts(created.id)).toEqual([{ user_id: admin.id, schedule_id: null }])
      await createEventType(inTeam(team, owner), input({ slug: 'team-owner' }))
      await createEventType(inTeam(team, multi), input({ slug: 'team-multi' }))
    })

    it('refuses members', async () => {
      const error = await domainError(() =>
        createEventType(inTeam(team, member), input({ slug: 'team-member' })),
      )
      expect(error.kind).toBe('forbidden')
      expect(error.code).toBe('insufficient_role')
    })

    it('lets members read but not change team event types', async () => {
      const created = await createEventType(inTeam(team, owner), input({ slug: 'team-read' }))
      expect(await getEventType(inTeam(team, member), created.id)).toEqual(created)
      expect((await listEventTypes(inTeam(team, member))).map((e) => e.id)).toContain(created.id)
      for (const attempt of [
        () => updateEventType(inTeam(team, member), created.id, { title: 'Nope' }),
        () => deleteEventType(inTeam(team, member), created.id),
      ]) {
        const error = await domainError(attempt)
        expect(error.kind).toBe('forbidden')
        expect(error.code).toBe('insufficient_role')
      }
      const updated = await updateEventType(inTeam(team, admin), created.id, { title: 'Yes' })
      expect(updated.title).toBe('Yes')
      await deleteEventType(inTeam(team, multi), created.id)
    })

    it('keeps team slugs unique per team, apart from personal pages', async () => {
      await createEventType(inTeam(team, owner), input({ slug: 'shared' }))
      const error = await domainError(() =>
        createEventType(inTeam(team, admin), input({ slug: 'shared' })),
      )
      expect(error.code).toBe('slug_taken')
      expect(error.cause).toMatchObject({ constraint: 'event_types_team_slug' })
      await createEventType(personal(owner), input({ slug: 'shared' }))
    })

    it('keeps team and personal event types apart', async () => {
      const teamType = await createEventType(inTeam(team, owner), input({ slug: 'apart' }))
      const own = await createEventType(personal(member), input({ slug: 'apart' }))
      expect((await listEventTypes(personal(owner))).map((e) => e.id)).not.toContain(teamType.id)
      expect((await listEventTypes(inTeam(team, member))).map((e) => e.id)).not.toContain(own.id)
      expect((await domainError(() => getEventType(inTeam(team, member), own.id))).code).toBe(
        'event_type_not_found',
      )
      expect((await domainError(() => getEventType(personal(owner), teamType.id))).code).toBe(
        'event_type_not_found',
      )
    })

    it("hides team event types from other organizations' members", async () => {
      const created = await createEventType(inTeam(team, owner), input({ slug: 'private' }))
      expect(await listEventTypes(personal(outsider))).toEqual([])
      for (const attempt of [
        () => getEventType(personal(outsider), created.id),
        () => updateEventType(personal(outsider), created.id, { title: 'X' }),
        () => deleteEventType(personal(outsider), created.id),
      ]) {
        expect((await domainError(attempt)).code).toBe('event_type_not_found')
      }
    })

    it("shows a member's own event type in the team to them alone", async () => {
      // Not creatable through the API yet, but allowed by the schema.
      const { id } = await db
        .insertInto('event_types')
        .values({
          organization_id: team.id,
          owner_user_id: member.id,
          slug: 'members-own',
          title: 'Own',
          duration_minutes: 30,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      expect((await getEventType(inTeam(team, member), id)).ownerUserId).toBe(member.id)
      const renamed = await updateEventType(inTeam(team, member), id, { title: 'Mine' })
      expect(renamed.title).toBe('Mine')
      expect((await listEventTypes(inTeam(team, admin))).map((e) => e.id)).not.toContain(id)
      expect((await domainError(() => getEventType(inTeam(team, owner), id))).code).toBe(
        'event_type_not_found',
      )
    })

    it("sets the schedule from the host's schedules, not the editor's", async () => {
      const created = await createEventType(inTeam(team, admin), input({ slug: 'host-schedule' }))
      const { id: ownersSchedule } = await schedule(owner)
      const error = await domainError(() =>
        updateEventType(inTeam(team, owner), created.id, { scheduleId: ownersSchedule }),
      )
      expect(error.code).toBe('invalid_schedule_id')
      const { id: adminsSchedule } = await schedule(admin)
      const updated = await updateEventType(inTeam(team, owner), created.id, {
        scheduleId: adminsSchedule,
      })
      expect(updated.scheduleId).toBe(adminsSchedule)
    })
  })

  describe('validation', () => {
    const rules = Object.entries(EVENT_TYPE_RULE_BOUNDS) as [
      keyof typeof EVENT_TYPE_RULE_BOUNDS,
      { min: number; max: number },
    ][]

    it.each(rules)('enforces the bounds of %s on create and update', async (rule, { min, max }) => {
      const user = await createTestUser(db)
      const atMin = await createEventType(personal(user), input({ slug: 'min', [rule]: min }))
      expect(atMin[rule]).toBe(min)
      const atMax = await createEventType(personal(user), input({ slug: 'max', [rule]: max }))
      expect(atMax[rule]).toBe(max)
      for (const value of [min - 1, max + 1, 1.5]) {
        const error = await domainError(() =>
          createEventType(personal(user), input({ slug: 'bad', [rule]: value })),
        )
        expect(error.code).toBe('invalid_event_type')
        expect(error.detail).toMatch(new RegExp(`^${rule} must be a whole number from ${min}`))
        const update = await domainError(() =>
          updateEventType(personal(user), atMin.id, { [rule]: value }),
        )
        expect(update.code).toBe('invalid_event_type')
      }
    })

    it('stores only rules the availability engine accepts', async () => {
      const user = await createTestUser(db)
      const max = Object.fromEntries(rules.map(([rule, { max }]) => [rule, max]))
      const stored = await createEventType(personal(user), input(max))
      const now = Temporal.Instant.from('2026-10-19T00:00:00Z')
      expect(() =>
        getAvailableSlots({
          schedule: {
            timeZone: 'UTC',
            weeklyHours: { monday: [{ start: '00:00', end: '24:00' }] },
          },
          eventType: {
            durationMinutes: stored.durationMinutes,
            slotStepMinutes: stored.slotStepMinutes ?? undefined,
            bufferBeforeMinutes: stored.bufferBeforeMinutes,
            bufferAfterMinutes: stored.bufferAfterMinutes,
            minimumNoticeMinutes: stored.minimumNoticeMinutes,
            bookingWindowDays: stored.bookingWindowDays ?? undefined,
            maxBookingsPerDay: stored.maxBookingsPerDay ?? undefined,
          },
          rangeStart: now,
          rangeEnd: now.add({ hours: 24 * 30 }),
          now,
        }),
      ).not.toThrow()
    })

    it.each<[string, Record<string, unknown>, string]>([
      ['a missing duration', { durationMinutes: undefined }, 'invalid_event_type'],
      ['a null buffer', { bufferBeforeMinutes: null }, 'invalid_event_type'],
      ['an uppercase slug', { slug: 'Intro' }, 'invalid_slug'],
      ['a slug with a trailing hyphen', { slug: 'intro-' }, 'invalid_slug'],
      ['a 65-character slug', { slug: 'a'.repeat(65) }, 'invalid_slug'],
      ['a blank title', { title: '   ' }, 'invalid_event_type'],
      ['a long title', { title: 'x'.repeat(201) }, 'invalid_event_type'],
      ['a long description', { description: 'x'.repeat(5001) }, 'invalid_event_type'],
      ['a title with a line break', { title: 'Intro\ncall' }, 'invalid_event_type'],
      ['a title with a control character', { title: 'Intro\u0007' }, 'invalid_event_type'],
      ['a description with NUL', { description: 'Hi\u0000' }, 'invalid_event_type'],
      ['a description with a lone surrogate', { description: 'Hi \ud800' }, 'invalid_event_type'],
      [
        'an address with a line break',
        { location: { kind: 'in_person', address: '1 Main St\nSpringfield' } },
        'invalid_location',
      ],
      [
        'a question label with a line break',
        { questions: [{ id: 'a', label: 'A\nB', type: 'short_text' }] },
        'invalid_questions',
      ],
      [
        '__proto__ as a question id',
        { questions: [{ id: '__proto__', label: 'A', type: 'short_text' }] },
        'invalid_questions',
      ],
      ['a non-boolean isActive', { isActive: 'yes' }, 'invalid_event_type'],
      ['a fractional position', { position: 1.5 }, 'invalid_event_type'],
      ['a position beyond a Postgres integer', { position: 2 ** 31 }, 'invalid_event_type'],
      ['an unknown location kind', { location: { kind: 'teams' } }, 'invalid_location'],
      ['a location without a kind', { location: {} }, 'invalid_location'],
      ['a phone location without a number', { location: { kind: 'phone' } }, 'invalid_location'],
      [
        'a phone number not in E.164',
        { location: { kind: 'phone', number: '(415) 555-0123' } },
        'invalid_location',
      ],
      ['an empty address', { location: { kind: 'in_person', address: ' ' } }, 'invalid_location'],
      [
        'a javascript: link',
        { location: { kind: 'link', url: 'javascript:alert(1)' } },
        'invalid_location',
      ],
      ['a relative link', { location: { kind: 'link', url: '/room' } }, 'invalid_location'],
      [
        'a location with extra fields',
        { location: { kind: 'zoom', url: 'https://zoom.us/j/1' } },
        'invalid_location',
      ],
      ['questions that are not a list', { questions: {} }, 'invalid_questions'],
      [
        'too many questions',
        {
          questions: Array.from({ length: 21 }, (_, i) => ({
            id: `q${i}`,
            label: 'Q',
            type: 'short_text',
          })),
        },
        'invalid_questions',
      ],
      [
        'repeated question ids',
        {
          questions: [
            { id: 'a', label: 'A', type: 'short_text' },
            { id: 'a', label: 'B', type: 'short_text' },
          ],
        },
        'invalid_questions',
      ],
      [
        'a question id with spaces',
        { questions: [{ id: 'a b', label: 'A', type: 'short_text' }] },
        'invalid_questions',
      ],
      [
        'an unknown question type',
        { questions: [{ id: 'a', label: 'A', type: 'date' }] },
        'invalid_questions',
      ],
      [
        'a blank label',
        { questions: [{ id: 'a', label: ' ', type: 'short_text' }] },
        'invalid_questions',
      ],
      [
        'a select without options',
        { questions: [{ id: 'a', label: 'A', type: 'select' }] },
        'invalid_questions',
      ],
      [
        'a multi_select without options',
        { questions: [{ id: 'a', label: 'A', type: 'multi_select', options: [] }] },
        'invalid_questions',
      ],
      [
        'options on a checkbox',
        { questions: [{ id: 'a', label: 'A', type: 'checkbox', options: ['x'] }] },
        'invalid_questions',
      ],
      [
        'repeated options',
        { questions: [{ id: 'a', label: 'A', type: 'select', options: ['x', ' x'] }] },
        'invalid_questions',
      ],
      [
        'options on a text question',
        { questions: [{ id: 'a', label: 'A', type: 'short_text', options: ['x'] }] },
        'invalid_questions',
      ],
      [
        'a non-boolean required',
        { questions: [{ id: 'a', label: 'A', type: 'short_text', required: 'yes' }] },
        'invalid_questions',
      ],
      [
        'a question with extra fields',
        { questions: [{ id: 'a', label: 'A', type: 'short_text', placeholder: 'x' }] },
        'invalid_questions',
      ],
    ])('refuses %s', async (_, change, code) => {
      const user = await createTestUser(db)
      const error = await domainError(() =>
        createEventType(personal(user), { ...input(), ...change } as EventTypeInput),
      )
      expect(error.kind).toBe('invalid')
      expect(error.code).toBe(code)
      expect(await listEventTypes(personal(user))).toEqual([])
    })
  })
})
