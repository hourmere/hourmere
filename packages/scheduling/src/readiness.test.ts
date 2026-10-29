import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Principal } from '@hourmere/auth'
import { validateTimeZone, validateWeeklyHours } from '@hourmere/core'
import { createDb, type Db, type Json } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { type KyselyPlugin, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { assertCachedCalendarSync, servedHandle } from './availability.ts'
import { checkedCatalogPage } from './catalog-page.ts'
import {
  automaticMeet,
  automaticZoom,
  evaluateGoogleWriteDestination,
  evaluateZoomConnection,
  meetOrganizer,
} from './conferences.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { eligibleHostIds, hasValidHostShape } from './hosts.ts'
import { isUuid } from './internal.ts'
import { getSelfReadiness, getTeamReadiness } from './readiness.ts'
import { createFixtures, createTestTeam, createTestUser, type TestUser } from './testing.ts'
import { cleanText } from './text.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T12:00:00Z')
const signalIds = [
  'default_schedule',
  'effective_event_schedule',
  'host_eligibility',
  'round_robin_activation',
  'conflict_calendar_selection',
  'selected_calendar_sync',
  'optional_conference_dependency',
  'slot_observation',
]
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Missing readiness test fixture')
  return value
}
const signal = <T extends { signals: { id: string; state: string }[] }>(readiness: T, id: string) =>
  required(readiness.signals.find((value) => value.id === id))

function queryPlugin(onQuery: (node: unknown) => void): KyselyPlugin {
  return {
    transformQuery(args) {
      onQuery(args.node)
      return args.node
    },
    async transformResult(args) {
      return args.result
    },
  }
}

type ReadinessModule = {
  getSelfReadiness: typeof getSelfReadiness
  getTeamReadiness: typeof getTeamReadiness
}
type Mutation = readonly [string, string]

/** Evaluate an in-memory source copy; a negative control never changes repository files. */
function sourceCopy(mutation?: Mutation): ReadinessModule {
  let source = readFileSync('packages/scheduling/src/readiness.ts', 'utf8')
  if (mutation) {
    expect(source.includes(mutation[0]), 'mutation must match source').toBe(true)
    source = source.replace(...mutation)
  }
  const script = stripTypeScriptTypes(
    source.replace(/^import[\s\S]*?from '[^']+'\n/gm, ''),
  ).replace(/\bexport /g, '')
  const bindings = {
    validateTimeZone,
    validateWeeklyHours,
    sql,
    z,
    assertCachedCalendarSync,
    servedHandle,
    checkedCatalogPage,
    automaticMeet,
    automaticZoom,
    evaluateGoogleWriteDestination,
    evaluateZoomConnection,
    meetOrganizer,
    DomainError,
    eligibleHostIds,
    hasValidHostShape,
    isUuid,
    cleanText,
  }
  return new Function(
    ...Object.keys(bindings),
    `${script}; return { getSelfReadiness, getTeamReadiness }`,
  )(...Object.values(bindings)) as ReadinessModule
}

describe.skipIf(!serverUrl)('booking readiness from current cached facts (real Postgres)', () => {
  let owned: TestDatabase, db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function session(user: TestUser, principal = user.principal): Promise<ServiceContext> {
    const row = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token: randomUUID(),
        activeOrganizationId: principal.organization.id,
        updatedAt: new Date(),
        expiresAt: new Date('2027-11-01T12:00:00Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return {
      db,
      now,
      principal: {
        kind: 'session',
        sessionId: row.id,
        user: principal.user,
        organization: principal.organization,
      },
    }
  }

  async function profile(user: TestUser) {
    await db
      .insertInto('profiles')
      .values({
        user_id: user.id,
        handle: `ready-${randomUUID().replaceAll('-', '').slice(0, 24)}`,
        time_zone: 'UTC',
      })
      .execute()
  }

  async function personal(defaultSchedule = true) {
    const user = await createTestUser(db)
    await profile(user)
    const f = createFixtures(db)
    const scheduleId = defaultSchedule ? await f.schedule(user.id, { timeZone: 'UTC' }) : null
    const eventTypeId = await f.eventType(user.principal.organization.id, user.id)
    return { user, f, scheduleId, eventTypeId, ctx: await session(user) }
  }

  async function team(mode: 'individual' | 'collective' | 'round_robin' = 'collective', count = 2) {
    const users: TestUser[] = []
    const f = createFixtures(db)
    const schedules: string[] = []
    for (let index = 0; index < count; index++) {
      const user = await createTestUser(db, `Readiness host ${index + 1}`)
      users.push(user)
      await profile(user)
      schedules.push(await f.schedule(user.id, { timeZone: 'UTC' }))
    }
    const owner = required(users[0])
    const organization = await createTestTeam(
      db,
      users.map((user, index) => ({ user, role: index === 0 ? 'owner' : 'member' })),
    )
    const eventTypeId = await f.eventType(organization.id, null, {
      hosts: (mode === 'individual' ? users.slice(0, 1) : users).map((user) => ({
        userId: user.id,
      })),
    })
    await db
      .updateTable('event_types')
      .set({ scheduling_type: mode })
      .where('id', '=', eventTypeId)
      .execute()
    if (mode === 'round_robin')
      await db
        .insertInto('round_robin_state')
        .values({ event_type_id: eventTypeId, enabled: true })
        .execute()
    const ctx = await session(owner, organization.as(owner))
    return {
      users,
      owner,
      f,
      schedules,
      organization,
      eventTypeId,
      ctx,
      read: (readDb = db, features: { automaticMeet?: boolean; automaticZoom?: boolean } = {}) =>
        getTeamReadiness({ db: readDb, now, organizationId: organization.id, ...features }),
    }
  }

  async function calendar(
    userId: string,
    options: {
      provider?: string
      selected?: boolean
      status?: string
      syncedAt?: Date | null
      syncState?: Json | null
      syncError?: string | null
      lastError?: string | null
      scopes?: string[]
      accessRole?: string
      supportsMeet?: boolean
    } = {},
  ) {
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: userId,
        provider: options.provider ?? 'google',
        external_account_id: randomUUID(),
        account_email: `private-account-${randomUUID()}@example.com`,
        credentials: Buffer.from('synthetic-never-used-credential-canary'),
        status: options.status ?? 'active',
        last_error: options.lastError ?? null,
        scopes: options.scopes ?? [],
      })
      .returning(['id', 'account_email'])
      .executeTakeFirstOrThrow()
    const result = await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: randomUUID(),
        name: `Private calendar ${randomUUID()}`,
        time_zone: 'UTC',
        check_conflicts: options.selected ?? true,
        last_synced_at:
          options.syncedAt === undefined ? new Date(now().epochMilliseconds) : options.syncedAt,
        sync_state:
          options.syncState === undefined
            ? {
                version: 2,
                timeZone: 'UTC',
                start: '2026-10-01T00:00:00Z',
                end: '2026-12-01T00:00:00Z',
                token: 'synthetic-private-sync-cursor-canary',
              }
            : options.syncState,
        sync_error: options.syncError ?? null,
        access_role: options.accessRole ?? 'owner',
        supports_google_meet: options.supportsMeet ?? false,
      })
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow()
    return { ...result, connectionId: connection.id, accountEmail: connection.account_email }
  }

  const eventSummary = async (
    setup: Awaited<ReturnType<typeof team>>,
    readDb = db,
    features: { automaticMeet?: boolean; automaticZoom?: boolean } = {},
  ) =>
    required(
      (await setup.read(readDb, features)).eventTypes.data.find(
        (row) => row.eventTypeId === setup.eventTypeId,
      ),
    )
  const selfEvent = async (setup: Awaited<ReturnType<typeof personal>>, readDb = db) =>
    required(
      (await getSelfReadiness({ ...setup.ctx, db: readDb })).eventTypes.data.find(
        (row) => row.subject.id === setup.eventTypeId,
      ),
    )

  async function meetCalendar(userId: string) {
    return calendar(userId, {
      selected: false,
      scopes: [
        'https://www.googleapis.com/auth/calendar.events.owned',
        'https://www.googleapis.com/auth/calendar.events.readonly',
      ],
      supportsMeet: true,
    })
  }

  async function zoomConnection(
    userId: string,
    status: 'active' | 'refreshing' | 'needs_reauth' = 'active',
  ) {
    return db
      .insertInto('conference_connections')
      .values({
        user_id: userId,
        provider: 'zoom',
        external_user_id: `synthetic-${randomUUID()}`,
        mode: 'meetings',
        status,
        credentials: status === 'active' ? Buffer.from('synthetic-unused-zoom-credentials') : null,
        operation_id: status === 'refreshing' ? randomUUID() : null,
        scopes: [
          'user:read:user',
          'meeting:write:meeting',
          'meeting:read:meeting',
          'meeting:update:meeting',
          'meeting:delete:meeting',
        ],
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  }

  it('passes basic checks without external calendars and keeps slot observation outside completeness', async () => {
    const s = await personal()
    const result = await getSelfReadiness(s.ctx)
    for (const item of [result.member, required(result.eventTypes.data[0])]) {
      expect(item.signals.map((value) => value.id).sort()).toEqual([...signalIds].sort())
      expect(item).toMatchObject({
        audience: 'self_detail',
        scope: 'configuration_and_cached_sync',
        summary: 'checks_passed',
        completeness: 'complete',
        evaluatedAt: now().toString(),
        availability: 'not_checked',
      })
      expect(signal(item, 'conflict_calendar_selection').state).toBe('not_applicable')
      expect(signal(item, 'selected_calendar_sync').state).toBe('not_applicable')
      expect(signal(item, 'slot_observation')).toMatchObject({
        state: 'not_checked',
        checkedAt: null,
      })
    }
    expect(result.member).toMatchObject({
      enablement: 'not_applicable',
      activation: 'not_applicable',
    })
    expect(result.member.details.calendars).toEqual([])
  })

  it('keeps enablement, hidden visibility and configuration independent and excludes deleted events', async () => {
    const s = await personal()
    await db
      .updateTable('event_types')
      .set({ is_hidden: true })
      .where('id', '=', s.eventTypeId)
      .execute()
    expect(await selfEvent(s)).toMatchObject({ enablement: 'enabled', summary: 'checks_passed' })
    await db
      .updateTable('event_types')
      .set({ is_active: false })
      .where('id', '=', s.eventTypeId)
      .execute()
    expect(await selfEvent(s)).toMatchObject({ enablement: 'disabled', summary: 'disabled' })
    await db.deleteFrom('schedules').where('user_id', '=', s.user.id).execute()
    const disabled = await selfEvent(s)
    expect(disabled.summary).toBe('disabled')
    expect(signal(disabled, 'effective_event_schedule').state).toBe('configuration_blocker')
    await db
      .updateTable('event_types')
      .set({ deleted_at: new Date() })
      .where('id', '=', s.eventTypeId)
      .execute()
    expect((await getSelfReadiness(s.ctx)).eventTypes.data).toEqual([])
  })

  it('returns private self configuration once while retaining empty event detail fields', async () => {
    const s = await personal()
    const ownCalendar = await calendar(s.user.id)
    await s.f.eventType(s.user.principal.organization.id, s.user.id)
    const verify = async ({ getSelfReadiness: read }: ReadinessModule) => {
      const result = await read(s.ctx)
      expect(result.member.details.schedules.map((row) => row.id)).toEqual([s.scheduleId])
      expect(result.member.details.calendars.map((row) => row.id)).toEqual([ownCalendar.id])
      expect(result.eventTypes.data).toHaveLength(2)
      for (const event of result.eventTypes.data)
        expect(event.details).toEqual({ schedules: [], calendars: [] })
    }
    await verify({ getSelfReadiness, getTeamReadiness })
    for (const field of ['schedules', 'calendars'] as const) {
      const source = `subject.kind === 'member' && facts.${field}.ok`
      await rejectsMutation([source, `facts.${field}.ok`], verify)
    }
  })

  it('omits the redundant enablement signal and uses the actual event axis', async () => {
    const s = await personal()
    const verify = async ({ getSelfReadiness: read }: ReadinessModule) => {
      for (const active of [true, false]) {
        await db
          .updateTable('event_types')
          .set({ is_active: active, is_hidden: true })
          .where('id', '=', s.eventTypeId)
          .execute()
        const event = required((await read(s.ctx)).eventTypes.data[0])
        expect(event.enablement).toBe(active ? 'enabled' : 'disabled')
        expect(event.signals.map((row) => row.id)).not.toContain('event_enablement')
      }
    }
    await verify({ getSelfReadiness, getTeamReadiness })
    await rejectsMutation([".filter((id) => id !== 'event_enablement')", ''], verify)
  })

  it.each([
    ['missing successful time', { syncedAt: null }, 'sync_not_ready'],
    ['missing snapshot', { syncState: null }, 'sync_not_ready'],
    [
      'explicit sync error and missing success',
      { syncedAt: null, syncState: null, syncError: 'permissions_missing' },
      'calendar_attention_required',
    ],
    [
      'reauth and missing success',
      { syncedAt: null, syncState: null, status: 'needs_reauth' },
      'calendar_attention_required',
    ],
  ] as const)('returns one actionable sync reason for %s', async (_name, options, reason) => {
    const s = await personal()
    await calendar(s.user.id, options)
    const verify = async ({ getSelfReadiness: read }: ReadinessModule) => {
      const result = await read(s.ctx)
      for (const item of [result.member, required(result.eventTypes.data[0])]) {
        const issues = item.signals.filter((row) => row.id === 'selected_calendar_sync')
        expect(issues).toHaveLength(1)
        expect(issues[0]).toMatchObject({
          state: 'dependency_unavailable',
          reasonCode: reason,
          fixKind: 'self_calendars',
        })
        expect(item.signals.filter((row) => row.reasonCode === reason)).toHaveLength(1)
        expect(item.signals.map((row) => row.reasonCode)).not.toContain(
          reason === 'sync_not_ready' ? 'calendar_attention_required' : 'sync_not_ready',
        )
      }
    }
    await verify({ getSelfReadiness, getTeamReadiness })
    await rejectsMutation(
      reason === 'sync_not_ready'
        ? ["? 'sync_not_ready'", "? 'calendar_attention_required'"]
        : [
            "selected.some((c) => c.provider === 'google' && (c.status !== 'active' || c.sync_error))",
            'false',
          ],
      verify,
    )
  })

  it('keeps missing or explicitly failed sync behind one coarse team issue', async () => {
    const s = await team('individual', 1)
    const ownCalendar = await calendar(s.owner.id, { syncedAt: null, syncState: null })
    for (const syncError of [null, 'permissions_missing']) {
      await db
        .updateTable('calendars')
        .set({ sync_error: syncError })
        .where('id', '=', ownCalendar.id)
        .execute()
      const result = await s.read()
      for (const item of [...result.members.data, ...result.eventTypes.data]) {
        expect(item.reasonCodes).toEqual(['calendar_attention_required'])
        expect(item.fixKinds).toEqual(['ask_member'])
      }
      expect(JSON.stringify(result)).not.toContain('sync_not_ready')
    }
  })

  it.each([
    ['unverified', false, 'unverified-name-canary', 'Team member'],
    ['empty', true, '   ', 'Team member'],
    ['control', true, 'unsafe\nname-canary', 'Team member'],
    ['too long', true, 'x'.repeat(201), 'Team member'],
    ['safe', true, '  Verified member  ', 'Verified member'],
  ] as const)(
    'uses only a verified display-safe team member name (%s)',
    async (kind, verified, name, expected) => {
      const s = await team()
      const target = required(s.users[1])
      await db
        .updateTable('auth.user')
        .set({ name, emailVerified: verified })
        .where('id', '=', target.id)
        .execute()
      const { id: memberId } = await db
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', s.organization.id)
        .where('userId', '=', target.id)
        .executeTakeFirstOrThrow()
      const verify = async ({ getTeamReadiness: read }: ReadinessModule) => {
        const result = await read({ db, now, organizationId: s.organization.id })
        expect(
          required(result.members.data.find((row) => row.memberId === memberId)).displayName,
        ).toBe(expected)
      }
      await verify({ getSelfReadiness, getTeamReadiness })
      if (kind === 'unverified') await rejectsMutation(['member.emailVerified && ', ''], verify)
      else if (kind !== 'empty')
        await rejectsMutation(['cleanText(member.name, { max: 200 })', 'member.name'], verify)
    },
  )

  async function rejectsMutation(
    mutation: Mutation,
    verify: (module: ReadinessModule) => Promise<void>,
  ) {
    await verify(sourceCopy())
    await expect(verify(sourceCopy(mutation))).rejects.toMatchObject({ name: 'AssertionError' })
    await verify(sourceCopy())
  }

  it('distinguishes member default schedule gaps from a valid individual custom schedule', async () => {
    const s = await personal(false)
    const custom = await s.f.schedule(s.user.id, { isDefault: false, timeZone: 'UTC' })
    await db
      .updateTable('event_type_hosts')
      .set({ schedule_id: custom })
      .where('event_type_id', '=', s.eventTypeId)
      .execute()
    const result = await getSelfReadiness(s.ctx)
    expect(result.member.summary).toBe('configuration_blocked')
    expect(signal(result.member, 'default_schedule').state).toBe('configuration_blocker')
    const event = required(result.eventTypes.data[0])
    expect(event.summary).toBe('checks_passed')
    expect(signal(event, 'effective_event_schedule').state).toBe('satisfied')
    await db.deleteFrom('schedules').where('id', '=', custom).execute()
    expect((await selfEvent(s)).summary).toBe('configuration_blocked')
  })

  it('falls back to the current default after a custom schedule is deleted', async () => {
    const s = await personal()
    const custom = await s.f.schedule(s.user.id, { isDefault: false, timeZone: 'UTC' })
    await db
      .updateTable('event_type_hosts')
      .set({ schedule_id: custom })
      .where('event_type_id', '=', s.eventTypeId)
      .execute()
    await db.deleteFrom('schedules').where('id', '=', custom).execute()
    expect(await selfEvent(s)).toMatchObject({ summary: 'checks_passed', completeness: 'complete' })
  })

  it('accepts empty working hours, closed overrides and restrictive booking windows as configuration', async () => {
    const s = await personal()
    await db
      .updateTable('schedules')
      .set({ weekly_hours: '{}' })
      .where('id', '=', required(s.scheduleId))
      .execute()
    await db
      .insertInto('schedule_overrides')
      .values({ schedule_id: required(s.scheduleId), date: '2026-11-02', intervals: '[]' })
      .execute()
    await db
      .updateTable('event_types')
      .set({ minimum_notice_minutes: 10080, booking_window_days: 1, max_bookings_per_day: 1 })
      .where('id', '=', s.eventTypeId)
      .execute()
    expect(await selfEvent(s)).toMatchObject({
      summary: 'checks_passed',
      availability: 'not_checked',
    })
  })

  it('reports a missing personal public profile as a known host configuration gap', async () => {
    const s = await personal()
    await db.deleteFrom('profiles').where('user_id', '=', s.user.id).execute()
    const result = await selfEvent(s)
    expect(result.summary).toBe('configuration_blocked')
    expect(signal(result, 'host_eligibility').state).toBe('configuration_blocker')
  })

  it('requires every collective host default schedule', async () => {
    const s = await team()
    await db.deleteFrom('schedules').where('id', '=', required(s.schedules[1])).execute()
    expect(await eventSummary(s)).toMatchObject({
      summary: 'configuration_blocked',
      reasonCodes: expect.arrayContaining(['default_schedule_required']),
    })
  })

  it.each(['removed', 'unverified'] as const)(
    'requires every collective host to remain eligible (%s)',
    async (change) => {
      const s = await team()
      const host = required(s.users[1])
      if (change === 'removed')
        await db
          .deleteFrom('auth.member')
          .where('organizationId', '=', s.organization.id)
          .where('userId', '=', host.id)
          .execute()
      else
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', host.id)
          .execute()
      expect(await eventSummary(s)).toMatchObject({
        summary: 'configuration_blocked',
        reasonCodes: expect.arrayContaining(['host_configuration_required']),
      })
      if (change === 'removed') {
        const serialized = JSON.stringify(await s.read())
        expect(serialized).not.toContain(host.name)
        expect(serialized).not.toContain(host.id)
      }
    },
  )

  it.each(['individual', 'collective'] as const)(
    'does not expose departed %s host private configuration through event reasons',
    async (mode) => {
      const s = await team(mode)
      const departed = required(s.users[1])
      const departedMember = await db
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', s.organization.id)
        .where('userId', '=', departed.id)
        .executeTakeFirstOrThrow()
      if (mode === 'individual')
        await db
          .updateTable('event_type_hosts')
          .set({ user_id: departed.id })
          .where('event_type_id', '=', s.eventTypeId)
          .execute()
      const currentDestination = await meetCalendar(s.owner.id)
      await db
        .updateTable('profiles')
        .set({ destination_calendar_id: currentDestination.id })
        .where('user_id', '=', s.owner.id)
        .execute()
      await db
        .updateTable('event_types')
        .set({
          location: JSON.stringify({ kind: 'google_meet', autoCreate: true }),
          conference_organizer_user_id: mode === 'collective' ? s.owner.id : null,
        })
        .where('id', '=', s.eventTypeId)
        .execute()
      await db.deleteFrom('schedules').where('user_id', '=', departed.id).execute()
      const privateCalendar = await calendar(departed.id, {
        status: 'needs_reauth',
        syncError: 'provider_unavailable',
        syncedAt: null,
        syncState: null,
      })
      await db
        .deleteFrom('auth.member')
        .where('organizationId', '=', s.organization.id)
        .where('userId', '=', departed.id)
        .execute()
      const result = await s.read(db, { automaticMeet: true })
      const event = required(
        result.eventTypes.data.find((row) => row.eventTypeId === s.eventTypeId),
      )
      expect(event).toMatchObject({
        summary: 'configuration_blocked',
        completeness: 'complete',
        reasonCodes: ['host_configuration_required'],
        fixKinds: ['edit_event'],
      })
      expect(result.members.data.map((row) => row.memberId)).not.toContain(departedMember.id)
      expect(JSON.stringify(result)).not.toContain(departed.name)
      expect(JSON.stringify(result)).not.toContain(privateCalendar.id)
      expect(JSON.stringify(result)).not.toContain(privateCalendar.name)
    },
  )

  it('keeps RR activation independent and retains legacy custom schedule blockers', async () => {
    const s = await team('round_robin')
    await db.deleteFrom('round_robin_state').where('event_type_id', '=', s.eventTypeId).execute()
    await db
      .updateTable('event_type_hosts')
      .set({ schedule_id: required(s.schedules[0]) })
      .where('event_type_id', '=', s.eventTypeId)
      .where('user_id', '=', s.owner.id)
      .execute()
    expect(await eventSummary(s)).toMatchObject({
      enablement: 'enabled',
      activation: 'inactive',
      summary: 'needs_activation',
      reasonCodes: expect.arrayContaining(['activation_required', 'host_configuration_required']),
    })
    expect(
      await db
        .selectFrom('round_robin_state')
        .selectAll()
        .where('event_type_id', '=', s.eventTypeId)
        .execute(),
    ).toEqual([])
  })

  it('retains a failed RR activation read alongside legacy custom schedule configuration', async () => {
    const s = await team('round_robin')
    await db
      .updateTable('event_type_hosts')
      .set({ schedule_id: required(s.schedules[0]) })
      .where('event_type_id', '=', s.eventTypeId)
      .where('user_id', '=', s.owner.id)
      .execute()
    const failedDb = db.withPlugin(
      queryPlugin((node) => {
        if (JSON.stringify(node).includes('"name":"round_robin_state"'))
          throw new Error('synthetic-activation-load-failure')
      }),
    )
    expect(await eventSummary(s, failedDb)).toMatchObject({
      activation: 'check_failed',
      summary: 'check_failed',
      completeness: 'partial',
      reasonCodes: expect.arrayContaining(['check_failed', 'host_configuration_required']),
      fixKinds: expect.arrayContaining(['retry_summary']),
    })
  })

  it('keeps an unknown RR candidate failure ahead of a legacy custom schedule blocker', async () => {
    const s = await team('round_robin')
    await db
      .updateTable('event_type_hosts')
      .set({ schedule_id: required(s.schedules[0]) })
      .where('event_type_id', '=', s.eventTypeId)
      .where('user_id', '=', s.owner.id)
      .execute()
    await db
      .updateTable('schedules')
      .set({ weekly_hours: '{"monday":[{"start":"invalid","end":"17:00"}]}' })
      .where('id', '=', required(s.schedules[1]))
      .execute()
    expect(await eventSummary(s)).toMatchObject({
      activation: 'active',
      summary: 'check_failed',
      completeness: 'partial',
      reasonCodes: expect.arrayContaining(['check_failed', 'host_configuration_required']),
      fixKinds: expect.arrayContaining(['retry_summary']),
    })
  })

  it.each(['removed', 'unverified', 'no_default', 'sync_unavailable'] as const)(
    'reports a partial RR pool with one healthy candidate and one %s candidate',
    async (change) => {
      const s = await team('round_robin')
      const host = required(s.users[1])
      if (change === 'removed')
        await db
          .deleteFrom('auth.member')
          .where('organizationId', '=', s.organization.id)
          .where('userId', '=', host.id)
          .execute()
      else if (change === 'unverified')
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', host.id)
          .execute()
      else if (change === 'no_default')
        await db.deleteFrom('schedules').where('user_id', '=', host.id).execute()
      else await calendar(host.id, { syncError: 'provider_unavailable' })
      expect(await eventSummary(s)).toMatchObject({
        activation: 'active',
        summary: 'partial_pool',
        completeness: 'complete',
      })
    },
  )

  it('blocks an RR pool with no currently eligible hosts', async () => {
    const s = await team('round_robin')
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where(
        'id',
        'in',
        s.users.map((user) => user.id),
      )
      .execute()
    expect(await eventSummary(s)).toMatchObject({
      summary: 'configuration_blocked',
      reasonCodes: expect.arrayContaining(['host_configuration_required']),
    })
  })

  it('distinguishes RR all-missing schedules from an unavailable dependency without a passing candidate', async () => {
    const s = await team('round_robin')
    await db.deleteFrom('schedules').where('user_id', '=', required(s.users[1]).id).execute()
    await calendar(s.owner.id, { syncedAt: null, syncState: null })
    expect((await eventSummary(s)).summary).toBe('dependency_unavailable')
    await db.deleteFrom('schedules').where('user_id', '=', s.owner.id).execute()
    await db
      .updateTable('calendars')
      .set({ check_conflicts: false })
      .where(
        'connection_id',
        'in',
        db.selectFrom('calendar_connections').select('id').where('user_id', '=', s.owner.id),
      )
      .execute()
    expect((await eventSummary(s)).summary).toBe('configuration_blocked')
  })

  it('ignores failed unselected calendars for basic conflict health', async () => {
    const s = await personal()
    await calendar(s.user.id, {
      selected: false,
      status: 'needs_reauth',
      syncedAt: null,
      syncState: null,
      syncError: 'permissions_missing',
    })
    const result = await selfEvent(s)
    expect(result.summary).toBe('checks_passed')
    expect(signal(result, 'selected_calendar_sync').state).toBe('not_applicable')
  })

  it.each([
    ['missing successful sync', { syncedAt: null }],
    ['missing snapshot', { syncState: null }],
    ['stale snapshot', { syncedAt: new Date(now().epochMilliseconds - 600001) }],
    ['future snapshot', { syncedAt: new Date(now().epochMilliseconds + 60001) }],
    ['sync error', { syncError: 'provider_unavailable' }],
    ['reauth needed', { status: 'needs_reauth' }],
    [
      'old cursor version',
      {
        syncState: {
          version: 1,
          timeZone: 'UTC',
          start: '2026-10-01T00:00Z',
          end: '2026-12-01T00:00Z',
        },
      },
    ],
    [
      'wrong cursor zone',
      {
        syncState: {
          version: 2,
          timeZone: 'Europe/Berlin',
          start: '2026-10-01T00:00Z',
          end: '2026-12-01T00:00Z',
        },
      },
    ],
    [
      'unparseable cursor bounds',
      { syncState: { version: 2, timeZone: 'UTC', start: 'bad-bound', end: '2026-12-01T00:00Z' } },
    ],
    [
      'non-string cursor bounds',
      { syncState: { version: 2, timeZone: 'UTC', start: 123, end: '2026-12-01T00:00Z' } },
    ],
  ] as const)('uses the existing selected calendar guard for %s', async (_name, options) => {
    const s = await personal()
    await calendar(s.user.id, options)
    const result = await selfEvent(s)
    expect(result.summary).toBe('dependency_unavailable')
    expect(signal(result, 'selected_calendar_sync').state).toBe('dependency_unavailable')
    expect(result.completeness).toBe('complete')
  })

  it.each([-600000, 60000])(
    'accepts the existing cached-sync boundary at %s milliseconds',
    async (offset) => {
      const s = await personal()
      await calendar(s.user.id, { syncedAt: new Date(now().epochMilliseconds + offset) })
      expect((await selfEvent(s)).summary).toBe('checks_passed')
    },
  )

  it('does not confuse retained calendar writeback errors with healthy busy sync', async () => {
    const s = await personal()
    await calendar(s.user.id, { lastError: 'permissions_missing' })
    expect((await selfEvent(s)).summary).toBe('checks_passed')
  })

  it('keeps raw provider errors out of self details while preserving dependency failure', async () => {
    const s = await personal()
    await calendar(s.user.id, { syncError: 'provider_unavailable' })
    const unsafeFacts = db.withPlugin({
      transformQuery(args) {
        return args.node
      },
      async transformResult(args) {
        return {
          ...args.result,
          rows: args.result.rows.map((row) =>
            Object.hasOwn(row, 'sync_error')
              ? { ...row, sync_error: 'synthetic-raw-provider-response-canary' }
              : row,
          ),
        }
      },
    })
    const result = (await getSelfReadiness({ ...s.ctx, db: unsafeFacts })).member
    expect(result.summary).toBe('dependency_unavailable')
    expect(result.details.calendars).toHaveLength(1)
    expect(required(result.details.calendars[0]).syncError).toBeNull()
    expect(JSON.stringify(result)).not.toContain('synthetic-raw-provider-response-canary')
    for (const schedule of result.details.schedules)
      expect(Object.keys(schedule).sort()).toEqual(['id', 'isDefault', 'name', 'timeZone'])
    for (const calendar of result.details.calendars)
      expect(Object.keys(calendar).sort()).toEqual([
        'accountEmail',
        'checkConflicts',
        'id',
        'lastSyncedAt',
        'name',
        'provider',
        'status',
        'syncError',
      ])
  })

  it('leaves unsupported selected providers unchecked and does not claim conflict protection', async () => {
    const s = await personal()
    await calendar(s.user.id, { provider: 'microsoft' })
    const result = await selfEvent(s)
    expect(result).toMatchObject({ summary: 'not_checked', completeness: 'partial' })
    expect(signal(result, 'selected_calendar_sync').state).toBe('not_checked')
    expect(JSON.stringify(result.signals)).toContain('unsupported')
  })

  it.each(['google_meet', 'zoom'] as const)(
    'checks explicitly selected optional %s dependencies',
    async (kind) => {
      const s = await personal()
      await db
        .updateTable('event_types')
        .set({ location: JSON.stringify({ kind, autoCreate: true }) })
        .where('id', '=', s.eventTypeId)
        .execute()
      const result = await selfEvent(s)
      expect(result.summary).toBe('configuration_blocked')
      expect(signal(result, 'optional_conference_dependency').state).toBe('configuration_blocker')
    },
  )

  it.each(['profile_destination', 'event_override', 'no_host_row'] as const)(
    'accepts enabled automatic Meet with a healthy personal %s',
    async (source) => {
      const s = await personal()
      s.ctx.automaticMeet = true
      const destination = await meetCalendar(s.user.id)
      await db
        .updateTable('event_types')
        .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true }) })
        .where('id', '=', s.eventTypeId)
        .execute()
      if (source === 'event_override')
        await db
          .updateTable('event_type_hosts')
          .set({ destination_calendar_id: destination.id })
          .where('event_type_id', '=', s.eventTypeId)
          .execute()
      else
        await db
          .updateTable('profiles')
          .set({ destination_calendar_id: destination.id })
          .where('user_id', '=', s.user.id)
          .execute()
      if (source === 'no_host_row')
        await db.deleteFrom('event_type_hosts').where('event_type_id', '=', s.eventTypeId).execute()
      const result = await selfEvent(s)
      expect(result).toMatchObject({ summary: 'checks_passed', completeness: 'complete' })
      expect(signal(result, 'optional_conference_dependency').state).toBe('satisfied')
    },
  )

  it.each(['missing', 'needs_reauth', 'writer', 'unsupported', 'missing_scopes'] as const)(
    'blocks enabled automatic Meet with a %s destination',
    async (problem) => {
      const s = await personal()
      s.ctx.automaticMeet = true
      await db
        .updateTable('event_types')
        .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true }) })
        .where('id', '=', s.eventTypeId)
        .execute()
      if (problem !== 'missing') {
        const destination = await meetCalendar(s.user.id)
        await db
          .updateTable('profiles')
          .set({ destination_calendar_id: destination.id })
          .where('user_id', '=', s.user.id)
          .execute()
        if (problem === 'needs_reauth')
          await db
            .updateTable('calendar_connections')
            .set({ status: 'needs_reauth' })
            .where('id', '=', destination.connectionId)
            .execute()
        if (problem === 'writer')
          await db
            .updateTable('calendars')
            .set({ access_role: 'writer' })
            .where('id', '=', destination.id)
            .execute()
        if (problem === 'unsupported')
          await db
            .updateTable('calendars')
            .set({ supports_google_meet: false })
            .where('id', '=', destination.id)
            .execute()
        if (problem === 'missing_scopes')
          await db
            .updateTable('calendar_connections')
            .set({ scopes: [] })
            .where('id', '=', destination.connectionId)
            .execute()
      }
      const result = await selfEvent(s)
      expect(result.summary).toBe('configuration_blocked')
      expect(signal(result, 'selected_calendar_sync').state).toBe('not_applicable')
      expect(signal(result, 'optional_conference_dependency').state).toBe('configuration_blocker')
    },
  )

  it('resolves the configured collective Meet organizer without requiring every host to have a destination', async () => {
    const s = await team()
    const organizer = required(s.users[1])
    const destination = await meetCalendar(organizer.id)
    await db
      .updateTable('profiles')
      .set({ destination_calendar_id: destination.id })
      .where('user_id', '=', organizer.id)
      .execute()
    await db
      .updateTable('event_types')
      .set({
        location: JSON.stringify({ kind: 'google_meet', autoCreate: true }),
        conference_organizer_user_id: organizer.id,
      })
      .where('id', '=', s.eventTypeId)
      .execute()
    expect(await eventSummary(s, db, { automaticMeet: true })).toMatchObject({
      summary: 'checks_passed',
      completeness: 'complete',
    })
    await db
      .updateTable('event_types')
      .set({ conference_organizer_user_id: s.owner.id })
      .where('id', '=', s.eventTypeId)
      .execute()
    expect(await eventSummary(s, db, { automaticMeet: true })).toMatchObject({
      summary: 'configuration_blocked',
      reasonCodes: expect.arrayContaining(['optional_feature_attention_required']),
    })
  })

  it('reports a partial RR Meet pool when only one candidate has an eligible destination', async () => {
    const s = await team('round_robin')
    const destination = await meetCalendar(s.owner.id)
    await db
      .updateTable('profiles')
      .set({ destination_calendar_id: destination.id })
      .where('user_id', '=', s.owner.id)
      .execute()
    await db
      .updateTable('event_types')
      .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true }) })
      .where('id', '=', s.eventTypeId)
      .execute()
    expect(await eventSummary(s, db, { automaticMeet: true })).toMatchObject({
      summary: 'partial_pool',
      completeness: 'complete',
      reasonCodes: expect.arrayContaining(['optional_feature_attention_required']),
    })
    await db
      .updateTable('profiles')
      .set({ destination_calendar_id: null })
      .where('user_id', '=', s.owner.id)
      .execute()
    expect((await eventSummary(s, db, { automaticMeet: true })).summary).toBe(
      'configuration_blocked',
    )
  })

  it.each(['active', 'refreshing', 'no_host_row'] as const)(
    'accepts the actual pinned personal Zoom account when %s',
    async (state) => {
      const s = await personal()
      s.ctx.automaticZoom = true
      const connection = await zoomConnection(
        s.user.id,
        state === 'refreshing' ? 'refreshing' : 'active',
      )
      await db
        .updateTable('event_types')
        .set({
          location: JSON.stringify({ kind: 'zoom', autoCreate: true }),
          zoom_connection_id: connection.id,
        })
        .where('id', '=', s.eventTypeId)
        .execute()
      if (state === 'no_host_row')
        await db.deleteFrom('event_type_hosts').where('event_type_id', '=', s.eventTypeId).execute()
      const result = await selfEvent(s)
      expect(result).toMatchObject({ summary: 'checks_passed', completeness: 'complete' })
      expect(signal(result, 'optional_conference_dependency').state).toBe('satisfied')
    },
  )

  it.each(['missing', 'wrong_owner', 'needs_reauth'] as const)(
    'blocks an enabled team Zoom event with a %s pinned account',
    async (problem) => {
      const s = await team('individual', 2)
      const connectionId =
        problem === 'missing'
          ? randomUUID()
          : (
              await zoomConnection(
                problem === 'wrong_owner' ? required(s.users[1]).id : s.owner.id,
                problem === 'needs_reauth' ? 'needs_reauth' : 'active',
              )
            ).id
      await db
        .updateTable('event_types')
        .set({
          location: JSON.stringify({ kind: 'zoom', autoCreate: true }),
          zoom_connection_id: connectionId,
        })
        .where('id', '=', s.eventTypeId)
        .execute()
      expect(await eventSummary(s, db, { automaticZoom: true })).toMatchObject({
        summary: 'configuration_blocked',
        reasonCodes: expect.arrayContaining(['optional_feature_attention_required']),
      })
    },
  )

  it.each([
    ['google_meet', 'profiles'],
    ['google_meet', 'calendars'],
    ['zoom', 'conference_connections'],
  ] as const)(
    'fails an enabled %s check when its %s dependency cannot load',
    async (kind, tableName) => {
      const s = await personal()
      s.ctx.automaticMeet = true
      s.ctx.automaticZoom = true
      const connection = kind === 'zoom' ? await zoomConnection(s.user.id) : null
      if (kind === 'google_meet') {
        const destination = await meetCalendar(s.user.id)
        await db
          .updateTable('profiles')
          .set({ destination_calendar_id: destination.id })
          .where('user_id', '=', s.user.id)
          .execute()
      }
      await db
        .updateTable('event_types')
        .set({
          location: JSON.stringify({ kind, autoCreate: true }),
          zoom_connection_id: connection?.id ?? null,
        })
        .where('id', '=', s.eventTypeId)
        .execute()
      const failedDb = db.withPlugin(
        queryPlugin((node) => {
          if (JSON.stringify(node).includes(`"name":"${tableName}"`))
            throw new Error('synthetic-private-conference-load-failure')
        }),
      )
      const result = await selfEvent(s, failedDb)
      expect(result).toMatchObject({ summary: 'check_failed', completeness: 'partial' })
      expect(signal(result, 'optional_conference_dependency').state).toBe('check_failed')
      expect(JSON.stringify(result)).not.toContain('synthetic-private-conference-load-failure')
    },
  )

  it.each(['schedules', 'calendars', 'round_robin_state'] as const)(
    'does not turn a failed %s dependency load into a healthy RR pool',
    async (tableName) => {
      const s = await team('round_robin')
      const failedDb = db.withPlugin(
        queryPlugin((node) => {
          if (JSON.stringify(node).includes(`"name":"${tableName}"`))
            throw new Error('synthetic-private-database-error-canary')
        }),
      )
      const result = await eventSummary(s, failedDb)
      expect(result).toMatchObject({
        summary: 'check_failed',
        completeness: 'partial',
        reasonCodes: expect.arrayContaining(['check_failed']),
        fixKinds: expect.arrayContaining(['retry_summary']),
      })
      expect(JSON.stringify(result)).not.toContain('synthetic-private-database-error-canary')
    },
  )

  it('treats malformed schedule data as a failed check even when another RR candidate passes', async () => {
    const s = await team('round_robin')
    await db
      .updateTable('schedules')
      .set({ weekly_hours: '{"monday":[{"start":"bad","end":"17:00"}]}' })
      .where('id', '=', required(s.schedules[1]))
      .execute()
    expect(await eventSummary(s)).toMatchObject({
      summary: 'check_failed',
      completeness: 'partial',
    })
  })

  it.each(['collective', 'round_robin'] as const)(
    'retains partial completeness when %s candidates have both a known schedule gap and a failed schedule check',
    async (mode) => {
      const s = await team(mode, 3)
      await db.deleteFrom('schedules').where('id', '=', required(s.schedules[0])).execute()
      await db
        .updateTable('schedules')
        .set({ weekly_hours: '{"monday":[{"start":"invalid","end":"17:00"}]}' })
        .where('id', '=', required(s.schedules[1]))
        .execute()
      expect(await eventSummary(s)).toMatchObject({
        summary: mode === 'round_robin' ? 'check_failed' : 'configuration_blocked',
        completeness: 'partial',
        reasonCodes: expect.arrayContaining(['default_schedule_required', 'check_failed']),
        fixKinds: expect.arrayContaining(['retry_summary']),
      })
    },
  )

  it.each([false, true])(
    'continues independent required checks after the personal profile load fails (automatic Meet %s)',
    async (meet) => {
      const s = await personal()
      s.ctx.automaticMeet = meet
      if (meet)
        await db
          .updateTable('event_types')
          .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true }) })
          .where('id', '=', s.eventTypeId)
          .execute()
      await calendar(s.user.id)
      const failedDb = db.withPlugin(
        queryPlugin((node) => {
          if (JSON.stringify(node).includes('"name":"profiles"'))
            throw new Error('synthetic-private-profile-load-error')
        }),
      )
      const result = await selfEvent(s, failedDb)
      expect(result).toMatchObject({ summary: 'check_failed', completeness: 'partial' })
      expect(signal(result, 'host_eligibility').state).toBe('check_failed')
      expect(signal(result, 'effective_event_schedule').state).toBe('satisfied')
      expect(signal(result, 'conflict_calendar_selection').state).toBe('satisfied')
      expect(signal(result, 'selected_calendar_sync').state).toBe('satisfied')
      expect(signal(result, 'optional_conference_dependency').state).toBe(
        meet ? 'check_failed' : 'not_applicable',
      )
      expect(JSON.stringify(result)).not.toContain('synthetic-private-profile-load-error')
    },
  )

  it('returns only explicit private detail fields to self and only coarse allowlisted fields to team admins', async () => {
    const s = await team()
    const ownCalendar = await calendar(s.owner.id)
    const privateHost = required(s.users[1])
    const otherCalendar = await calendar(privateHost.id, { syncError: 'provider_unavailable' })
    const scheduleName = `Private schedule ${randomUUID()}`
    await db
      .updateTable('schedules')
      .set({ name: scheduleName })
      .where('id', '=', required(s.schedules[1]))
      .execute()
    const eventTitle = `Private event title ${randomUUID()}`
    await db
      .updateTable('event_types')
      .set({ title: eventTitle })
      .where('id', '=', s.eventTypeId)
      .execute()
    await db
      .insertInto('calendar_busy')
      .values({
        calendar_id: otherCalendar.id,
        external_event_id: 'synthetic-private-external-event-canary',
        period: '[2026-11-02T09:00Z,2026-11-02T10:00Z)',
      })
      .execute()

    const own = await getSelfReadiness(s.ctx)
    const ownSerialized = JSON.stringify(own)
    expect(ownSerialized).toContain(ownCalendar.name)
    expect(ownSerialized).toContain(required(ownCalendar.accountEmail))
    for (const canary of [
      otherCalendar.name,
      otherCalendar.id,
      required(otherCalendar.accountEmail),
      scheduleName,
      required(s.schedules[1]),
      'synthetic-private-sync-cursor-canary',
      'synthetic-never-used-credential-canary',
      'synthetic-private-external-event-canary',
    ])
      expect(ownSerialized).not.toContain(canary)
    const result = await s.read()
    const serialized = JSON.stringify(result)
    for (const canary of [
      ownCalendar.name,
      ownCalendar.id,
      required(ownCalendar.accountEmail),
      otherCalendar.name,
      otherCalendar.id,
      required(otherCalendar.accountEmail),
      scheduleName,
      required(s.schedules[1]),
      eventTitle,
      'provider_unavailable',
      '2026-11-02T09:00',
      '2026-10-01',
      'synthetic-private',
    ])
      expect(serialized).not.toContain(canary)
    const memberKeys = [
      'memberId',
      'displayName',
      'summary',
      'completeness',
      'evaluatedAt',
      'reasonCodes',
      'fixKinds',
    ].sort()
    const eventKeys = [
      'eventTypeId',
      'enablement',
      'activation',
      'summary',
      'completeness',
      'evaluatedAt',
      'reasonCodes',
      'fixKinds',
    ].sort()
    for (const member of result.members.data) expect(Object.keys(member).sort()).toEqual(memberKeys)
    for (const event of result.eventTypes.data) expect(Object.keys(event).sort()).toEqual(eventKeys)
    expect(required(result.eventTypes.data[0]).reasonCodes).toContain('calendar_attention_required')
    expect(required(result.eventTypes.data[0]).fixKinds).toContain('ask_member')
  })

  it('refuses API keys, stale sessions, unverified identities and removed self membership', async () => {
    const s = await team()
    await expect(
      getSelfReadiness({ ...s.ctx, principal: s.organization.as(s.owner) }),
    ).rejects.toMatchObject({ kind: 'forbidden' })
    const principal = s.ctx.principal
    if (principal.kind !== 'session') throw new Error('Expected fixture session')
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date('2020-01-01') })
      .where('id', '=', principal.sessionId)
      .execute()
    await expect(getSelfReadiness(s.ctx)).rejects.toMatchObject({ kind: 'forbidden' })
    const fresh = await session(s.owner, s.organization.as(s.owner))
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', s.owner.id)
      .execute()
    await expect(getSelfReadiness(fresh)).rejects.toMatchObject({ kind: 'forbidden' })
    await db
      .updateTable('auth.user')
      .set({ emailVerified: true })
      .where('id', '=', s.owner.id)
      .execute()
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', s.organization.id)
      .where('userId', '=', s.owner.id)
      .execute()
    await expect(getSelfReadiness(fresh)).rejects.toMatchObject({ kind: 'forbidden' })
  })

  it('reauthorizes a previously resolved self context after switching organization', async () => {
    const s = await personal()
    const organization = await createTestTeam(db, [{ user: s.user, role: 'member' }])
    const principal = s.ctx.principal
    if (principal.kind !== 'session') throw new Error('Expected fixture session')
    const teamContext = {
      ...s.ctx,
      principal: { ...principal, organization: organization.as(s.user).organization },
    }
    const verify = async ({ getSelfReadiness: read }: ReadinessModule) => {
      await db
        .updateTable('auth.session')
        .set({ activeOrganizationId: s.user.principal.organization.id })
        .where('id', '=', principal.sessionId)
        .execute()
      expect((await read(s.ctx)).member.subject.organizationId).toBe(
        s.user.principal.organization.id,
      )
      await db
        .updateTable('auth.session')
        .set({ activeOrganizationId: organization.id })
        .where('id', '=', principal.sessionId)
        .execute()
      await expect(read(s.ctx)).rejects.toMatchObject({
        kind: 'forbidden',
        code: 'readiness_access_denied',
      })
      const switched = await read(teamContext)
      expect(switched.member.subject.organizationId).toBe(organization.id)
      expect(switched.eventTypes.data).toEqual([])
    }
    await verify({ getSelfReadiness, getTeamReadiness })
    await rejectsMutation(
      [
        "eb.fn.coalesce('activeMember.organizationId', 'personal.organization_id')",
        "'m.organizationId'",
      ],
      verify,
    )
  })

  it('matches the session personal fallback after active team removal or no active organization', async () => {
    const s = await personal()
    const organization = await createTestTeam(db, [{ user: s.user, role: 'member' }])
    const principal = s.ctx.principal
    if (principal.kind !== 'session') throw new Error('Expected fixture session')
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', organization.id)
      .where('userId', '=', s.user.id)
      .execute()
    for (const activeOrganizationId of [organization.id, null]) {
      await db
        .updateTable('auth.session')
        .set({ activeOrganizationId })
        .where('id', '=', principal.sessionId)
        .execute()
      const result = await getSelfReadiness(s.ctx)
      expect(result.member.subject.organizationId).toBe(s.user.principal.organization.id)
      expect(result.eventTypes.data.map((row) => row.subject.id)).toEqual([s.eventTypeId])
      await expect(
        getSelfReadiness({
          ...s.ctx,
          principal: { ...principal, organization: organization.as(s.user).organization },
        }),
      ).rejects.toMatchObject({ kind: 'forbidden', code: 'readiness_access_denied' })
    }
  })

  it('uses the same member evaluation for self detail and team minimal summary', async () => {
    const s = await team()
    const member = required(s.users[1])
    await db.deleteFrom('schedules').where('user_id', '=', member.id).execute()
    await calendar(member.id, { syncError: 'provider_unavailable' })
    const self = await getSelfReadiness(await session(member, s.organization.as(member)))
    const memberId = required(
      await db
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', s.organization.id)
        .where('userId', '=', member.id)
        .executeTakeFirst(),
    ).id
    expect(self.member.subject).toEqual({
      kind: 'member',
      id: memberId,
      organizationId: s.organization.id,
    })
    expect(self.eventTypes.data).toEqual([])
    const summary = required((await s.read()).members.data.find((row) => row.memberId === memberId))
    expect(summary).toMatchObject({
      summary: self.member.summary,
      completeness: self.member.completeness,
      evaluatedAt: self.member.evaluatedAt,
    })
    expect(summary.reasonCodes).toEqual(
      expect.arrayContaining(['default_schedule_required', 'calendar_attention_required']),
    )
  })

  it('rejects a forged self team context without exposing whether the other organization exists', async () => {
    const s = await team()
    const other = await team()
    const forged = (organizationId: string): Principal => ({
      ...s.ctx.principal,
      organization: { ...s.ctx.principal.organization, id: organizationId },
    })
    const deny = async (organizationId: string) =>
      getSelfReadiness({ ...s.ctx, principal: forged(organizationId) }).then(
        () => 'unexpected_success',
        (error: unknown) => ({
          kind: (error as { kind?: string }).kind,
          code: (error as { code?: string }).code,
        }),
      )
    const existing = await deny(other.organization.id)
    expect(existing).toMatchObject({ kind: 'forbidden' })
    expect(await deny(randomUUID())).toEqual(existing)
  })

  it('pages members and events independently without classifying omitted members as missing hosts', async () => {
    const s = await team('collective', 3)
    const extraEvents = await Promise.all(
      Array.from({ length: 4 }, () =>
        s.f.eventType(s.organization.id, null, { hosts: [{ userId: s.owner.id }] }),
      ),
    )
    const allMembers: string[] = [],
      allEvents: string[] = []
    let memberCursor: string | undefined, eventTypeCursor: string | undefined
    do {
      const result = await getTeamReadiness(
        { db, now, organizationId: s.organization.id },
        { limit: 1, memberCursor, eventTypeCursor },
      )
      allMembers.push(...result.members.data.map((row) => row.memberId))
      allEvents.push(...result.eventTypes.data.map((row) => row.eventTypeId))
      for (const event of result.eventTypes.data) expect(event.summary).toBe('checks_passed')
      memberCursor = result.members.nextCursor ?? undefined
      eventTypeCursor = result.eventTypes.nextCursor ?? undefined
      if (!memberCursor) break
    } while (memberCursor)
    expect(new Set(allMembers).size).toBe(3)
    while (eventTypeCursor) {
      const result = await getTeamReadiness(
        { db, now, organizationId: s.organization.id },
        { limit: 1, eventTypeCursor },
      )
      allEvents.push(...result.eventTypes.data.map((row) => row.eventTypeId))
      eventTypeCursor = result.eventTypes.nextCursor ?? undefined
    }
    expect(new Set(allEvents)).toEqual(new Set([s.eventTypeId, ...extraEvents]))
    expect(allEvents).toHaveLength(5)
  })

  it('pages self events and keeps query count constant as the event list grows', async () => {
    const s = await personal()
    s.ctx.automaticZoom = true
    const connection = await zoomConnection(s.user.id)
    await db
      .updateTable('event_types')
      .set({
        location: JSON.stringify({ kind: 'zoom', autoCreate: true }),
        zoom_connection_id: connection.id,
      })
      .where('id', '=', s.eventTypeId)
      .execute()
    async function measuredRead() {
      let count = 0
      const counted = db.withPlugin(
        queryPlugin(() => {
          count++
        }),
      )
      const result = await getSelfReadiness({ ...s.ctx, db: counted }, { limit: 100 })
      return { result, count }
    }
    const small = await measuredRead()
    const ids = [s.eventTypeId]
    for (let index = 0; index < 24; index++) {
      const id = await s.f.eventType(s.user.principal.organization.id, s.user.id, {
        location: { kind: 'zoom', autoCreate: true },
      })
      await db
        .updateTable('event_types')
        .set({ zoom_connection_id: connection.id })
        .where('id', '=', id)
        .execute()
      ids.push(id)
    }
    const large = await measuredRead()
    expect(large.result.eventTypes.data).toHaveLength(25)
    for (const event of large.result.eventTypes.data) expect(event.summary).toBe('checks_passed')
    expect(large.count).toBe(small.count)
    expect(large.count).toBeLessThanOrEqual(20)
    const paged: string[] = []
    let eventTypeCursor: string | undefined
    do {
      const result = await getSelfReadiness(s.ctx, { limit: 7, eventTypeCursor })
      paged.push(...result.eventTypes.data.map((row) => row.subject.id))
      eventTypeCursor = result.eventTypes.nextCursor ?? undefined
    } while (eventTypeCursor)
    expect(paged).toHaveLength(ids.length)
    expect(new Set(paged)).toEqual(new Set(ids))
  })

  it('keeps query count bounded as event and member lists grow', async () => {
    const s = await team('individual', 1)
    const ownerDestination = await meetCalendar(s.owner.id)
    await db
      .updateTable('profiles')
      .set({ destination_calendar_id: ownerDestination.id })
      .where('user_id', '=', s.owner.id)
      .execute()
    await db
      .updateTable('event_types')
      .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true }) })
      .where('id', '=', s.eventTypeId)
      .execute()
    async function measuredRead() {
      let count = 0
      const counted = db.withPlugin(
        queryPlugin(() => {
          count++
        }),
      )
      const result = await getTeamReadiness(
        { db: counted, now, organizationId: s.organization.id, automaticMeet: true },
        { limit: 100 },
      )
      return { result, count }
    }
    const small = await measuredRead()
    for (let index = 0; index < 24; index++) {
      const user = await createTestUser(db)
      await s.f.member(user.id, s.organization.id)
      await profile(user)
      await s.f.schedule(user.id, { timeZone: 'UTC' })
      const destination = await meetCalendar(user.id)
      await db
        .updateTable('profiles')
        .set({ destination_calendar_id: destination.id })
        .where('user_id', '=', user.id)
        .execute()
      await s.f.eventType(s.organization.id, null, {
        hosts: [{ userId: user.id }],
        location: { kind: 'google_meet', autoCreate: true },
      })
    }
    const large = await measuredRead()
    expect(large.result.members.data).toHaveLength(25)
    expect(large.result.eventTypes.data).toHaveLength(25)
    for (const event of large.result.eventTypes.data) expect(event.summary).toBe('checks_passed')
    expect(large.count).toBeLessThanOrEqual(small.count + 2)
    expect(large.count).toBeLessThanOrEqual(20)
    expect(owned.pool.totalCount).toBeLessThanOrEqual(10)
  })
})
