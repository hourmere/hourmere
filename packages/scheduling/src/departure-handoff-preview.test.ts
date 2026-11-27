import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import {
  checkTeamManagementAccess,
  ssoHardOff,
  TeamManagementError,
  teamSsoAccess,
  withScimResources,
} from '@hourmere/auth'
import { createDb, type Database, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { expectKilled, guardCopy } from '../../../scripts/source-copy-guard.ts'
import { findSlots, selectDurationMinutes } from './availability.ts'
import { createPublicTeamBooking } from './bookings.ts'
import type { ServiceContext } from './context.ts'
import { getDepartureHandoffEligibility } from './departure-handoff-eligibility.ts'
import { getDepartureHandoffLocation } from './departure-handoff-location.ts'
import { previewDepartureHandoff } from './departure-handoff-preview.ts'
import { DomainError } from './errors.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
  weekdays,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const instant = Temporal.Instant.from
const now = () => instant('2026-11-01T16:00:00Z')
const start = instant('2026-11-02T17:00:00Z')
const end = start.add({ minutes: 30 })
const denied = { kind: 'forbidden', code: 'team_management_access_denied' }

type Preview = typeof previewDepartureHandoff

function sourceCopy(allowMemberRead = false): Preview {
  let source = readFileSync(new URL('./departure-handoff-preview.ts', import.meta.url), 'utf8')
  if (allowMemberRead) {
    const authority = 'allowPersonal: false,\n      }).catch'
    expect(source).toContain(authority)
    source = source.replace(authority, 'allowPersonal: false,\n      }, true).catch')
  }
  const bindings = {
    checkTeamManagementAccess,
    ssoHardOff,
    TeamManagementError,
    teamSsoAccess,
    withScimResources,
    findSlots,
    selectDurationMinutes,
    getDepartureHandoffEligibility,
    getDepartureHandoffLocation,
    DomainError,
  }
  const code = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  return guardCopy(
    new Function(...Object.keys(bindings), `${code}\nreturn previewDepartureHandoff`)(
      ...Object.values(bindings),
    ) as Preview,
  )
}

describe.skipIf(!serverUrl)('internal departure handoff preview', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function session(
    user: TestUser,
    organization: ServiceContext['principal']['organization'],
  ): Promise<ServiceContext> {
    const { id } = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token: randomUUID(),
        expiresAt: sql<Date>`clock_timestamp() + interval '1 hour'`,
        activeOrganizationId: organization.id,
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { db, now, principal: { kind: 'session', user, organization, sessionId: id } }
  }

  async function setup() {
    const owner = await createTestUser(db, 'Team owner')
    const departing = await createTestUser(db, 'Departing host')
    const candidate = await createTestUser(db, 'Replacement host')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: departing, role: 'member' },
      { user: candidate, role: 'member' },
    ])
    const fixtures = createFixtures(db)
    await fixtures.schedule(departing.id, { timeZone: 'America/Los_Angeles' })
    await fixtures.schedule(candidate.id, { weeklyHours: {} })
    const scheduleId = await fixtures.schedule(candidate.id, {
      timeZone: 'America/Los_Angeles',
      isDefault: false,
      weeklyHours: weekdays({ start: '09:00', end: '17:00' }),
    })
    const eventTypeId = await fixtures.eventType(team.id, null, {
      slug: 'handoff',
      hosts: [{ userId: departing.id }],
      questions: [{ id: 'notes', label: 'Notes', type: 'short_text' }],
    })
    const organization = team.as(owner).organization
    const { booking } = await createPublicTeamBooking(
      { db, now },
      {
        handle: organization.slug,
        slug: 'handoff',
        start,
        invitee: { name: 'Private Booker', email: 'private@example.com', timeZone: 'UTC' },
        responses: { notes: 'Private answer' },
      },
    )
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('event_type_hosts').where('event_type_id', '=', eventTypeId).execute()
      await trx
        .insertInto('event_type_hosts')
        .values({ event_type_id: eventTypeId, user_id: candidate.id, schedule_id: scheduleId })
        .execute()
    })
    const ctx = await session(owner, organization)
    const input = { teamId: team.id, bookingId: booking.id, departingUserId: departing.id }
    return { owner, departing, candidate, team, eventTypeId, input, ctx, fixtures, scheduleId }
  }

  it('offers the exact source time on the replacement’s per-event schedule after departure', async () => {
    const { candidate, departing, team, eventTypeId, input, ctx } = await setup()
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', departing.id)
      .execute()
    const notify = vi.fn()

    expect(await previewDepartureHandoff({ ...ctx, notify }, input)).toStrictEqual({
      bookingId: input.bookingId,
      eventTypeId,
      candidateUserId: candidate.id,
      evaluatedAt: now().toString(),
      start: start.toString(),
      end: end.toString(),
      locationKind: null,
      availability: 'available',
    })
    expect(notify).not.toHaveBeenCalled()
    expect(
      await db
        .selectFrom('bookings')
        .select(['id', 'status', 'required_host_user_ids', 'rescheduled_from_id'])
        .where('organization_id', '=', team.id)
        .execute(),
    ).toEqual([
      {
        id: input.bookingId,
        status: 'confirmed',
        required_host_user_ids: [departing.id],
        rescheduled_from_id: null,
      },
    ])
  })

  it('requires Microsoft calendars to be enabled when previewing a Teams location', async () => {
    const { candidate, eventTypeId, input, ctx, fixtures } = await setup()
    const { calendarId } = await fixtures.calendarBusy(candidate.id, [], { checkConflicts: false })
    await db
      .updateTable('calendar_connections')
      .set({ scopes: ['Calendars.ReadWrite'] })
      .where('user_id', '=', candidate.id)
      .execute()
    await db
      .updateTable('calendars')
      .set({ access_role: 'owner' })
      .where('id', '=', calendarId)
      .execute()
    await db
      .insertInto('profiles')
      .values({
        user_id: candidate.id,
        handle: `teams-${candidate.id.slice(-24)}`,
        time_zone: 'UTC',
        destination_calendar_id: calendarId,
      })
      .execute()
    await db
      .updateTable('event_types')
      .set({ locations: JSON.stringify([{ id: 'teams', kind: 'microsoft_teams' }]) })
      .where('id', '=', eventTypeId)
      .execute()

    await expect(
      previewDepartureHandoff({ ...ctx, microsoftCalendarEnabled: false }, input),
    ).rejects.toMatchObject({ kind: 'conflict', code: 'location_unavailable' })
    await expect(
      previewDepartureHandoff({ ...ctx, microsoftCalendarEnabled: true }, input),
    ).resolves.toMatchObject({ locationKind: 'microsoft_teams', availability: 'available' })
  })

  it('ignores an exact mapped source copy and keeps an unrelated busy event at the same time', async () => {
    const { candidate, input, ctx, fixtures } = await setup()
    const { calendarId, externalEventIds } = await fixtures.calendarBusy(
      candidate.id,
      [[start.toString(), end.toString()]],
      { now: now() },
    )
    const [externalEventId] = externalEventIds
    if (!externalEventId) throw new Error('Missing calendar fixture')
    await db
      .insertInto('booking_calendar_events')
      .values({
        booking_id: input.bookingId,
        calendar_id: calendarId,
        external_event_id: externalEventId,
      })
      .execute()
    const offered = await previewDepartureHandoff(ctx, input)
    expect(offered.availability).toBe('available')

    await db
      .insertInto('calendar_busy')
      .values({
        calendar_id: calendarId,
        external_event_id: 'unrelated-private-event',
        period: `[${start},${end})`,
      })
      .execute()
    expect(await previewDepartureHandoff(ctx, input)).toStrictEqual({
      ...offered,
      availability: 'unavailable',
    })
  })

  it('evaluates the original start on the current event slot grid', async () => {
    const { input, ctx, scheduleId } = await setup()
    await db
      .updateTable('schedules')
      .set({ weekly_hours: JSON.stringify(weekdays({ start: '08:45', end: '17:00' })) })
      .where('id', '=', scheduleId)
      .execute()

    expect((await previewDepartureHandoff(ctx, input)).availability).toBe('unavailable')
    const nextGridStart = start.add({ minutes: 15 })
    expect(
      (await previewDepartureHandoff(ctx, { ...input, start: nextGridStart })).availability,
    ).toBe('available')
  })

  it('runs the preview in a PostgreSQL read-only repeatable-read transaction', async () => {
    const { input, ctx } = await setup()
    const statements: string[] = []
    const loggedDb = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })

    expect((await previewDepartureHandoff({ ...ctx, db: loggedDb }, input)).availability).toBe(
      'available',
    )
    expect(statements[0]).toBe('start transaction isolation level repeatable read read only')
    expect(statements.at(-1)).toBe('commit')
  })

  it('uses current working hours, booking notice, limits, and local bookings in other spaces', async () => {
    const { candidate, eventTypeId, input, ctx, fixtures, scheduleId, team } = await setup()
    const available = (extra = {}) => previewDepartureHandoff(ctx, { ...input, ...extra })
    await db
      .updateTable('event_types')
      .set({ minimum_notice_minutes: 26 * 60, max_bookings_per_day: 1 })
      .where('id', '=', eventTypeId)
      .execute()
    expect((await available()).availability).toBe('unavailable')
    const proposedStart = start.add({ hours: 1 })
    expect((await available({ start: proposedStart })).availability).toBe('available')

    await fixtures.booking(team.id, [candidate.id], '2026-11-02T19:00Z', '2026-11-02T19:30Z', {
      eventTypeId,
    })
    expect((await available({ start: proposedStart })).availability).toBe('unavailable')
    const nextDay = proposedStart.add({ hours: 24 })
    expect((await available({ start: nextDay })).availability).toBe('available')
    await fixtures.booking(
      candidate.principal.organization.id,
      [candidate.id],
      nextDay.toString(),
      nextDay.add({ minutes: 30 }).toString(),
    )
    expect((await available({ start: nextDay })).availability).toBe('unavailable')

    const laterThatDay = nextDay.add({ hours: 1 })
    expect((await available({ start: laterThatDay })).availability).toBe('available')
    await db
      .insertInto('schedule_overrides')
      .values({ schedule_id: scheduleId, date: '2026-11-03', intervals: '[]' })
      .execute()
    expect((await available({ start: laterThatDay })).availability).toBe('unavailable')
  })

  it('reports unusable calendar snapshots as unknown without exposing calendar facts', async () => {
    const { candidate, input, ctx, fixtures } = await setup()
    await fixtures.calendarBusy(candidate.id, [], { now: now().subtract({ minutes: 11 }) })
    await expect(previewDepartureHandoff(ctx, input)).rejects.toMatchObject({
      kind: 'conflict',
      code: 'calendar_sync_unavailable',
      message: 'The host calendar is temporarily unavailable. Try again shortly.',
    })
  })

  it('requires a live manager session before disclosing a booking and scopes missing IDs uniformly', async () => {
    const { owner, candidate, team, input, ctx } = await setup()
    const member = await session(candidate, team.as(candidate).organization)
    const rejectMember = async (preview: Preview) => {
      await expect(preview(member, input)).rejects.toMatchObject(denied)
    }
    await rejectMember(previewDepartureHandoff)
    await rejectMember(sourceCopy())
    await expectKilled(sourceCopy(true), rejectMember)

    await expect(
      previewDepartureHandoff({ ...ctx, principal: team.as(owner) }, input),
    ).rejects.toMatchObject(denied)
    const anotherTeam = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    const anotherContext = await session(owner, anotherTeam.as(owner).organization)
    for (const bookingId of [input.bookingId, randomUUID()]) {
      await expect(
        previewDepartureHandoff(anotherContext, { ...input, teamId: anotherTeam.id, bookingId }),
      ).rejects.toMatchObject({ kind: 'not_found', code: 'booking_not_found' })
    }

    if (ctx.principal.kind !== 'session') throw new Error('Missing session fixture')
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: anotherTeam.id })
      .where('id', '=', ctx.principal.sessionId)
      .execute()
    await expect(previewDepartureHandoff(ctx, input)).rejects.toMatchObject({
      kind: 'conflict',
      code: 'organization_context_changed',
    })
    await db
      .updateTable('auth.session')
      .set({ expiresAt: sql<Date>`clock_timestamp() - interval '1 hour'` })
      .where('id', '=', ctx.principal.sessionId)
      .execute()
    await expect(previewDepartureHandoff(ctx, input)).rejects.toMatchObject(denied)
  })

  it('requires current SSO proof when the team enforces SSO', async () => {
    const { team, input, ctx } = await setup()
    await db
      .insertInto('sso_policies')
      .values({ organization_id: team.id, require_sso: true })
      .execute()
    await expect(
      previewDepartureHandoff(ctx, input, { ssoOidcEnabled: true, ssoSamlEnabled: false }),
    ).rejects.toMatchObject({ kind: 'forbidden', code: 'sso_required' })
  })

  it('excludes a suspended replacement in a managed team when SCIM resources are enabled', async () => {
    const { candidate, team, input, ctx, fixtures } = await setup()
    await fixtures.suspendManagedChildMembership(team.id, candidate.id)
    await expect(
      previewDepartureHandoff(ctx, input, {
        ssoOidcEnabled: false,
        ssoSamlEnabled: false,
        scimResourcesEnabled: true,
      }),
    ).rejects.toMatchObject({ kind: 'conflict', code: 'handoff_candidate_ineligible' })
  })
})
