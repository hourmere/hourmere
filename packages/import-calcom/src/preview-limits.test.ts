import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createTestUser } from '../../scheduling/src/testing.ts'
import { applyExtractedImport } from './apply.ts'
import { checkSourceMutation, required } from './mutation-testing.ts'
import { fingerprint } from './plan.ts'
import {
  buildPreview,
  extractForPreview,
  registerImportSource,
  type SourceInput,
} from './preview.ts'
import { createSourceFixture } from './source-fixture.ts'
import { entityState, readTargetState } from './target.ts'

describe.skipIf(!process.env.DATABASE_URL)('import weekly and monthly limit previews', () => {
  let target: TestDatabase
  let source: Awaited<ReturnType<typeof createSourceFixture>>
  const users: string[] = []
  beforeAll(async () => {
    target = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'import_limits',
    })
    source = await createSourceFixture('cal.diy-a5ee96f77edd')
  }, 30_000)
  afterEach(async () => {
    await target.pool.query('DELETE FROM auth."user" WHERE id=ANY($1::uuid[])', [users.splice(0)])
  })
  afterAll(async () => {
    try {
      await source?.drop()
    } finally {
      await target?.drop()
    }
  }, 60_000)
  async function setup(
    times: string[],
    limits: Record<string, number> = { PER_WEEK: 1, PER_MONTH: 1 },
  ) {
    const user = await createTestUser(createDb(target.pool))
    users.push(user.id)
    await target.pool.query('UPDATE auth."user" SET email=$1 WHERE id=$2', [
      'owner@example.test',
      user.id,
    ])
    const input: SourceInput = {
      connectionString: source.connectionString,
      sourceId: '00000000-0000-4000-8000-000000000000',
      sourceVersion: 'cal.diy-a5ee96f77edd',
      selectedUserIds: [1],
      utcTimestampsConfirmed: true,
      authorization: {
        operatorUserId: user.id,
        operatorAuthorized: true,
        owners: [{ sourceUserId: 1, targetUserId: user.id, importPersonalData: true }],
      },
      bookingDecisions: times.map((_, i) => ({
        sourceBookingId: 1000 + i,
        sourceUserId: 1,
        singleHostAndAttendeeRolesConfirmed: true,
      })),
    }
    const snapshot = await extractForPreview(target.pool, input, '2040-01-01T00:00:00.000Z')
    required(snapshot.tables.EventType?.[0]).bookingLimits = limits
    required(snapshot.tables.Schedule?.[0]).timeZone = 'America/New_York'
    required(snapshot.tables.users?.[0]).timeZone = 'Asia/Tokyo'
    const booking = required(snapshot.tables.Booking?.[0])
    const attendee = required(snapshot.tables.Attendee?.[0])
    snapshot.tables.Booking = times.map((time, i) => {
      const start = Temporal.PlainDateTime.from(time)
        .toZonedDateTime('America/New_York')
        .toInstant()
      return {
        ...booking,
        id: 1000 + i,
        uid: `limits-${i}`,
        startTime: start.toString(),
        endTime: start.add({ minutes: 30 }).toString(),
      }
    })
    snapshot.tables.Attendee = times.map((_, i) => ({
      ...attendee,
      id: 2000 + i,
      bookingId: 1000 + i,
    }))
    input.sourceId = await registerImportSource(target.pool, snapshot, input.authorization)
    const { connectionString: _connectionString, ...options } = input
    const state = await readTargetState(
      target.pool,
      input.sourceId,
      input.authorization,
      snapshot.cutoff,
    )
    return {
      user,
      input,
      snapshot,
      state,
      options,
      preview: buildPreview(snapshot, state, options),
    }
  }
  it.each([
    ['Monday reset across spring DST', ['2041-03-10T23:00', '2041-03-11T00:00'], [1, 1], [2, 2]],
    ['same week across spring DST', ['2041-03-09T23:00', '2041-03-10T23:00'], [2, 2], [2, 2]],
    ['calendar month reset', ['2041-03-31T23:00', '2041-04-01T00:00'], [1, 1], [1, 1]],
    ['same week across fall DST', ['2041-11-02T23:00', '2041-11-03T23:00'], [2, 2], [2, 2]],
  ])('%s uses the host schedule zone', async (_label, times, weekly, monthly) => {
    const f = await setup(times as string[])
    expect(f.preview.blocked).toBe(false)
    for (const [period, counts] of [
      ['weekly', weekly],
      ['monthly', monthly],
    ] as const)
      for (const [i, count] of (counts as number[]).entries())
        expect(f.preview.impacts).toContainEqual({
          code: count > 1 ? `${period}_limit_exceeded` : `${period}_count`,
          sourceBookingId: 1000 + i,
          relatedId: 100,
          count,
          limit: 1,
        })
    const result = await applyExtractedImport(
      target.pool,
      f.preview,
      f.input,
      async () => f.snapshot,
    )
    expect(result.status).toBe('applied')
    expect(
      (
        await target.pool.query(
          'SELECT max_bookings_per_week,max_bookings_per_month FROM event_types WHERE owner_user_id=$1',
          [f.user.id],
        )
      ).rows,
    ).toEqual([{ max_bookings_per_week: 1, max_bookings_per_month: 1 }])
    expect(
      (
        await target.pool.query(
          'SELECT start_at FROM bookings WHERE organization_id=$1 ORDER BY start_at',
          [f.user.principal.organization.id],
        )
      ).rows.map((r) => new Date(r.start_at).toISOString()),
    ).toEqual(f.snapshot.tables.Booking?.map((b) => new Date(b.startTime as string).toISOString()))
    expect(
      (await applyExtractedImport(target.pool, f.preview, f.input, async () => f.snapshot)).status,
    ).toBe('noop')
  })
  it('preserves pre-weekly/monthly ledger hashes and replays unchanged legacy imports', async () => {
    const f = await setup(['2041-03-10T23:00'], {})
    const {
      maxBookingsPerWeek: _week,
      maxBookingsPerMonth: _month,
      ...legacyPayload
    } = required(f.preview.plan.events[0])
    const legacySourceHash = fingerprint({
      sourceFingerprint: f.preview.sourceFingerprint,
      kind: 'event_type',
      id: 100,
      payload: legacyPayload,
      decisions: f.options.bookingDecisions,
      resolutions: {},
    })
    const assertSource = (build: typeof buildPreview) =>
      expect(
        build(f.snapshot, f.state, f.options).entities.find((e) => e.kind === 'event_type')
          ?.sourceFingerprint,
      ).toBe(legacySourceHash)
    assertSource(buildPreview)
    expect(
      (await applyExtractedImport(target.pool, f.preview, f.input, async () => f.snapshot)).status,
    ).toBe('applied')
    const state = await readTargetState(
      target.pool,
      f.input.sourceId,
      f.input.authorization,
      f.snapshot.cutoff,
    )
    const event = required(state.events.find((e) => e.owner_user_id === f.user.id))
    const {
      max_bookings_per_week: _targetWeek,
      max_bookings_per_month: _targetMonth,
      ...legacyEvent
    } = event
    const ledger = required(state.items.find((i) => i.entity_kind === 'event_type'))
    expect(ledger.source_fingerprint).toBe(legacySourceHash)
    expect(ledger.target_fingerprint).toBe(fingerprint(legacyEvent))
    expect(
      (await applyExtractedImport(target.pool, f.preview, f.input, async () => f.snapshot)).status,
    ).toBe('noop')
    await checkSourceMutation(
      new URL('./preview.ts', import.meta.url),
      "!(['maxBookingsPerWeek', 'maxBookingsPerMonth'].includes(key) && value == null)",
      'true',
      (m) => m.buildPreview as typeof buildPreview,
      assertSource,
    )
    await checkSourceMutation(
      new URL('./target.ts', import.meta.url),
      "!(['max_bookings_per_week', 'max_bookings_per_month'].includes(key) && value == null)",
      'true',
      (m) => m.entityState as typeof entityState,
      (entity) =>
        expect(fingerprint(entity(state, 'event_type', event.id))).toBe(ledger.target_fingerprint),
    )
    for (const column of ['max_bookings_per_week', 'max_bookings_per_month']) {
      await target.pool.query(`UPDATE event_types SET ${column}=1 WHERE id=$1`, [event.id])
      const changed = await readTargetState(
        target.pool,
        f.input.sourceId,
        f.input.authorization,
        f.snapshot.cutoff,
      )
      expect(buildPreview(f.snapshot, changed, f.options).entities).toContainEqual(
        expect.objectContaining({
          kind: 'event_type',
          disposition: 'conflict',
          reason: 'target_changed',
        }),
      )
      expect(fingerprint(entityState(changed, 'event_type', event.id))).not.toBe(
        ledger.target_fingerprint,
      )
      await checkSourceMutation(
        new URL('./target.ts', import.meta.url),
        "['max_bookings_per_week', 'max_bookings_per_month'].includes(key) && value == null",
        "['max_bookings_per_week', 'max_bookings_per_month'].includes(key)",
        (m) => m.entityState as typeof entityState,
        (entity) =>
          expect(fingerprint(entity(changed, 'event_type', event.id))).not.toBe(
            ledger.target_fingerprint,
          ),
      )
      await target.pool.query(`UPDATE event_types SET ${column}=NULL WHERE id=$1`, [event.id])
    }
  })
  it('blocks incompatible source ceilings before any target write', async () => {
    const f = await setup(['2041-03-10T23:00'], { PER_WEEK: 3, PER_MONTH: 2 })
    expect(f.preview.blocked).toBe(true)
    expect(f.preview.losses.some((p) => p.code === 'event_limits_order')).toBe(true)
    expect(
      (await applyExtractedImport(target.pool, f.preview, f.input, async () => f.snapshot)).code,
    ).toBe('IMPORT_PREVIEW_BLOCKED')
    const { parseEvents } = await import('./events.ts')
    await checkSourceMutation(
      new URL('./events.ts', import.meta.url),
      'maxBookingsPerDay: maxBookingsPerDay ?? undefined, maxBookingsPerWeek: maxBookingsPerWeek ?? undefined, maxBookingsPerMonth: maxBookingsPerMonth ?? undefined,',
      'maxBookingsPerDay: maxBookingsPerDay ?? undefined,',
      (m) => m.parseEvents as typeof parseEvents,
      (parse) => {
        const problems: Parameters<typeof parse>[3] = []
        parse(
          f.snapshot,
          new Map(f.preview.plan.users.map((u) => [u.sourceId, u])),
          f.preview.plan.schedules,
          problems,
        )
        expect(problems.some((p) => p.code === 'event_limits_order')).toBe(true)
      },
    )
  })
  it('mutation-checks proposals from source weekly and monthly ceilings', async () => {
    const f = await setup(['2041-03-10T23:00'])
    const { parseEvents } = await import('./events.ts')
    for (const period of ['Week', 'Month']) {
      await checkSourceMutation(
        new URL('./events.ts', import.meta.url),
        `const maxBookingsPer${period} = proposedLimit('PER_${period.toUpperCase()}')`,
        `const maxBookingsPer${period} = null`,
        (m) => m.parseEvents as typeof parseEvents,
        (parse) => {
          const events = parse(
            f.snapshot,
            new Map(f.preview.plan.users.map((u) => [u.sourceId, u])),
            f.preview.plan.schedules,
            [],
          )
          expect(events[0]).toMatchObject({ maxBookingsPerWeek: 1, maxBookingsPerMonth: 1 })
        },
      )
    }
  })
  it('mutation-checks persistence of both proposed ceilings', async () => {
    for (const field of ['maxBookingsPerWeek', 'maxBookingsPerMonth']) {
      const f = await setup(['2041-03-10T23:00'])
      await checkSourceMutation(
        new URL('./apply.ts', import.meta.url),
        `e.${field},`,
        'null,',
        (m) => m.applyExtractedImport as typeof applyExtractedImport,
        async (apply) => {
          expect(
            (await apply(target.pool, f.preview, f.input, async () => f.snapshot)).status,
          ).toBe('applied')
          expect(
            (
              await target.pool.query(
                'SELECT max_bookings_per_week,max_bookings_per_month FROM event_types WHERE owner_user_id=$1',
                [f.user.id],
              )
            ).rows,
          ).toEqual([{ max_bookings_per_week: 1, max_bookings_per_month: 1 }])
        },
      )
      await target.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.user.id])
      users.splice(users.indexOf(f.user.id), 1)
    }
  })
  it('kills missing weekly/monthly counts and incorrect local boundaries', async () => {
    const f = await setup(['2041-03-10T23:00', '2041-03-11T00:00'])
    const assert = (build: typeof buildPreview) => {
      const preview = build(f.snapshot, f.state, f.options)
      expect(preview.impacts).toContainEqual({
        code: 'weekly_count',
        sourceBookingId: 1000,
        relatedId: 100,
        count: 1,
        limit: 1,
      })
      expect(preview.impacts).toContainEqual({
        code: 'monthly_limit_exceeded',
        sourceBookingId: 1000,
        relatedId: 100,
        count: 2,
        limit: 1,
      })
    }
    assert(buildPreview)
    for (const [before, after] of [
      ["['weekly', week, event.maxBookingsPerWeek]", "['weekly', week, null]"],
      ["['monthly', month, event.maxBookingsPerMonth]", "['monthly', month, null]"],
      ['days: date.dayOfWeek - 1', 'days: date.dayOfWeek % 7'],
      ['localDate(value).with({ day: 1 }).toString()', 'localDate(value).toString()'],
      [
        'const localDate = (value: string) => Temporal.Instant.from(value).toZonedDateTimeISO(zone).toPlainDate()',
        "const localDate = (value: string) => Temporal.Instant.from(value).toZonedDateTimeISO('UTC').toPlainDate()",
      ],
    ])
      await checkSourceMutation(
        new URL('./preview.ts', import.meta.url),
        before as string,
        after as string,
        (m) => m.buildPreview as typeof buildPreview,
        assert,
      )
  })
})
