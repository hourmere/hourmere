import { describe, expect, it } from 'vitest'
import { checkSourceMutation, required } from './mutation-testing.ts'
import { fingerprint, parseImportPlan } from './plan.ts'
import { LIMITS, type ParseOptions, type SourceRow, type SourceSnapshot } from './types.ts'

const uid = '019a4321-1234-7000-8000-000000000001',
  org = '019a4321-1234-7000-8000-000000000002'
const options = (): ParseOptions => ({
  target: {
    users: [
      {
        id: uid,
        email: 'owner@example.com',
        emailVerified: true,
        personalOrganizationId: org,
        authorized: true,
      },
    ],
    occupiedHandles: [],
    occupiedSlugs: [],
    busy: [],
  },
  bookingDecisions: [
    { sourceBookingId: 30, sourceUserId: 1, singleHostAndAttendeeRolesConfirmed: true },
  ],
})
function snapshot(): SourceSnapshot {
  const event: SourceRow = {
    id: 10,
    userId: 1,
    teamId: null,
    profileId: null,
    parentId: null,
    schedulingType: null,
    title: 'Session',
    slug: 'session',
    description: 'Plain text',
    position: 0,
    length: 30,
    multipleDuration: [60, 30],
    slotInterval: null,
    beforeEventBuffer: 0,
    afterEventBuffer: 0,
    minimumBookingNotice: 120,
    hidden: true,
    disableGuests: false,
    offsetStart: 0,
    periodType: 'unlimited',
    periodDays: null,
    periodStartDate: null,
    periodEndDate: null,
    scheduleId: 20,
    bookingFields: [],
    locations: [
      { type: 'link', link: 'https://meet.example.com/join', displayLocationPublicly: true },
    ],
    price: 0,
  }
  return {
    sourceVersion: 'cal.diy-a5ee96f77edd',
    schemaFingerprint: 'a'.repeat(64),
    cutoff: '2026-11-01T00:00:00.000Z',
    extractedAt: '2026-11-01T00:00:00.000Z',
    selectedUserIds: [1],
    tables: {
      users: [
        {
          id: 1,
          email: 'owner@example.com',
          emailVerified: '2026-01-01T00:00:00.000Z',
          username: 'owner',
          timeZone: 'America/Los_Angeles',
          locale: 'en',
          bufferTime: 0,
          defaultScheduleId: 20,
        },
      ],
      EventType: [event],
      Host: [{ eventTypeId: 10, userId: 1, scheduleId: 20, groupId: null, memberId: null }],
      _user_eventtype: [{ A: 10, B: 1 }],
      Schedule: [{ id: 20, userId: 1, name: 'Hours', timeZone: 'America/Los_Angeles' }],
      Availability: [
        {
          id: 21,
          scheduleId: 20,
          userId: 1,
          eventTypeId: null,
          days: [0],
          date: null,
          startTime: '01:00:00',
          endTime: '03:00:00',
        },
        {
          id: 22,
          scheduleId: 20,
          userId: 1,
          eventTypeId: null,
          days: [],
          date: '2027-01-01',
          startTime: '00:00:00',
          endTime: '00:00:00',
        },
      ],
      Booking: [
        {
          id: 30,
          userId: 1,
          eventTypeId: 10,
          title: 'Existing meeting',
          startTime: '2026-11-02T08:30:00.123Z',
          endTime: '2026-11-02T09:17:00.456Z',
          status: 'accepted',
          location: 'https://meet.example.com/join?pwd=private',
          responses: { email: 'invitee@example.com' },
          paid: false,
          rescheduled: false,
        },
      ],
      Attendee: [
        {
          id: 40,
          bookingId: 30,
          name: 'Invitee',
          email: 'invitee@example.com',
          timeZone: 'UTC',
          locale: 'en',
        },
      ],
    },
  }
}
describe('bounded in-memory import plan', () => {
  it.each(['cal.diy-a5ee96f77edd', 'cal.com-v6.2.0'] as const)(
    'composes %s mappings without a target database connection',
    (version) => {
      const source = snapshot()
      source.sourceVersion = version
      const plan = parseImportPlan(source, options())
      expect(plan).toMatchObject({
        contractVersion: 1,
        mode: 'dry_run',
        writesPerformed: 0,
        targetVerification: 'operator_supplied_snapshot',
        summary: {
          matchedUsers: 1,
          draftEvents: 1,
          schedules: 1,
          localBusyBookings: 1,
          importBlockers: 0,
        },
      })
      expect(plan.events[0]).toMatchObject({
        isHidden: true,
        isActive: false,
        allowedDurationsMinutes: [60, 30],
        scheduleSourceId: 20,
        notifications: { reminders: [], followUps: [] },
      })
      expect(plan.schedules[0]?.overrides).toEqual([{ date: '2027-01-01', intervals: [] }])
      expect(plan.bookings[0]?.policy).toBe('local_only_read_only')
      expect(plan.problems.filter((p) => p.source.id === 'scope')).toHaveLength(7)
      expect(JSON.stringify(plan.problems)).not.toMatch(/invitee@example|pwd=private/)
    },
  )
  it('blocks source scope, target verification/authorization changes and existing slug collisions', () => {
    for (const field of ['emailVerified', 'authorized'] as const) {
      const o = options()
      required(o.target.users[0])[field] = false
      expect(parseImportPlan(snapshot(), o).users).toEqual([])
    }
    const source = snapshot()
    required(source.tables.users?.[0]).organizationId = 10
    expect(parseImportPlan(source, options()).users).toEqual([])
    const o = options()
    o.target.occupiedSlugs = [{ organizationId: org, slug: 'session' }]
    const plan = parseImportPlan(snapshot(), o)
    expect(plan.events).toEqual([])
    expect(plan.bookings).toEqual([])
    expect(plan.problems.map((p) => p.code)).toContain('event_slug_conflict')
  })
  it('fingerprints source and target context changes deterministically', () => {
    const a = snapshot(),
      b = snapshot(),
      o = options()
    expect(parseImportPlan(a, o).sourceFingerprint).toBe(parseImportPlan(b, o).sourceFingerprint)
    required(b.tables.Booking?.[0]).title = 'Changed'
    expect(parseImportPlan(a, o).sourceFingerprint).not.toBe(
      parseImportPlan(b, o).sourceFingerprint,
    )
    const changed = options()
    required(changed.target.users[0]).authorized = false
    expect(parseImportPlan(a, o).targetContextFingerprint).not.toBe(
      parseImportPlan(a, changed).targetContextFingerprint,
    )
  })
  it('refuses unrecognized baseline, non-UTC timestamps and invalid target context', () => {
    expect(() =>
      parseImportPlan({ ...snapshot(), sourceVersion: 'unknown' as never }, options()),
    ).toThrow('invalid')
    expect(() =>
      parseImportPlan({ ...snapshot(), cutoff: '2026-11-01T00:00:00-07:00' }, options()),
    ).toThrow('invalid')
    const o = options()
    o.target.busy = [{ targetUserId: uid, start: 'bad', end: 'bad' }]
    expect(() => parseImportPlan(snapshot(), o)).toThrow('invalid')
  })
  it('refuses count and byte limits before returning any partial plan', () => {
    expect(() =>
      parseImportPlan(
        {
          ...snapshot(),
          selectedUserIds: Array.from({ length: LIMITS.users + 1 }, (_, i) => i + 1),
        },
        options(),
      ),
    ).toThrow('limits')
    const source = snapshot()
    source.tables.Attendee = Array.from({ length: LIMITS.perTable + 1 }, () => ({ id: 1 }))
    expect(() => parseImportPlan(source, options())).toThrow('limits')
    source.tables.Attendee = [{ id: 1, name: 'x'.repeat(LIMITS.jsonBytes + 1) }]
    expect(() => parseImportPlan(source, options())).toThrow('limits')
  })
})

it('reports a commercial host-group event using its audited text identifier', () => {
  const source = snapshot()
  source.tables.HostGroup = [{ id: 'cuid_host_group', eventTypeId: 10 }]
  const plan = parseImportPlan(source, options())
  expect(plan.events).toEqual([])
  expect(plan.problems.map((p) => p.code)).toContain('event_host_shape')
})

it('hashes non-ASCII keys with deterministic binary ordering', () => {
  expect(fingerprint({ ä: 1, a: 2, Z: 3 })).toBe(
    '0f86bdcea33f31ccc3237da328699dcbb57705f5da759d78bd13ef494165baf1',
  )
})

it('kills table-specific identifier and input-limit source-copy mutations', async () => {
  const { checkSourceMutation } = await import('./mutation-testing.ts')
  const source = new URL('./plan.ts', import.meta.url)
  const select = (m: Record<string, unknown>) => m.parseImportPlan as typeof parseImportPlan
  const grouped = snapshot()
  grouped.tables.HostGroup = [{ id: 'cuid_host_group', eventTypeId: 10 }]
  await checkSourceMutation(source, "table === 'HostGroup'", 'false', select, (run) =>
    expect(() => run(grouped, options())).not.toThrow(),
  )
  const many = snapshot()
  many.tables.Attendee = Array.from({ length: LIMITS.perTable + 1 }, () => ({ id: 1 }))
  await checkSourceMutation(source, 'entries.length > LIMITS.perTable', 'false', select, (run) =>
    expect(() => run(many, options())).toThrow('limits'),
  )
  const big = snapshot()
  big.tables.Attendee = [{ id: 1, name: 'x'.repeat(LIMITS.jsonBytes + 1) }]
  await checkSourceMutation(
    source,
    'Buffer.byteLength(JSON.stringify(row)) > LIMITS.jsonBytes',
    'false',
    select,
    (run) => expect(() => run(big, options())).toThrow('limits'),
  )
})

it('reports large historical and terminal aggregates without consuming booking row limits', () => {
  const source = snapshot()
  source.bookingExclusionCounts = [{ sourceUserId: 1, pastOrStarted: 15000, terminal: 12000 }]
  const plan = parseImportPlan(source, options())
  expect(plan.bookings).toHaveLength(1)
  expect(plan.bookingExclusionCounts).toEqual(source.bookingExclusionCounts)
  expect(plan.summary.excludedBookings).toBe(27000)
  expect(plan.problems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'booking_past_excluded_count',
        severity: 'excluded',
        source: { table: 'Booking', id: 'user:1' },
      }),
      expect.objectContaining({ code: 'booking_terminal_excluded_count', severity: 'excluded' }),
    ]),
  )
  expect(plan.sourceFingerprint).not.toBe(parseImportPlan(snapshot(), options()).sourceFingerprint)
})

it.each([
  null,
  [{ sourceUserId: 2, pastOrStarted: 1, terminal: 0 }],
  [{ sourceUserId: 1, pastOrStarted: -1, terminal: 0 }],
  [{ sourceUserId: 1, pastOrStarted: 1.5, terminal: 0 }],
  [{ sourceUserId: 1, pastOrStarted: 1, terminal: 'secret' }],
  [{ sourceUserId: 1, pastOrStarted: Number.MAX_SAFE_INTEGER, terminal: 1 }],
  [
    { sourceUserId: 1, pastOrStarted: 1, terminal: 0 },
    { sourceUserId: 1, pastOrStarted: 1, terminal: 0 },
  ],
])('refuses malformed aggregate exclusion counts %#', (counts) => {
  const source = snapshot()
  source.bookingExclusionCounts = counts as never
  expect(() => parseImportPlan(source, options())).toThrow('invalid')
})

it('kills aggregate validation, reporting, total and fingerprint source-copy mutations', async () => {
  const source = new URL('./plan.ts', import.meta.url)
  const select = (m: Record<string, unknown>) => m.parseImportPlan as typeof parseImportPlan
  const invalid = snapshot()
  invalid.bookingExclusionCounts = [{ sourceUserId: 1, pastOrStarted: -1, terminal: 0 }]
  await checkSourceMutation(source, 'entry.pastOrStarted < 0', 'false', select, (run) =>
    expect(() => run(invalid, options())).toThrow('invalid'),
  )
  const data = snapshot()
  data.bookingExclusionCounts = [{ sourceUserId: 1, pastOrStarted: 15000, terminal: 12000 }]
  await checkSourceMutation(source, 'if (entry.pastOrStarted > 0)', 'if (false)', select, (run) =>
    expect(run(data, options()).problems.map((p) => p.code)).toContain(
      'booking_past_excluded_count',
    ),
  )
  await checkSourceMutation(source, 'if (entry.terminal > 0)', 'if (false)', select, (run) =>
    expect(run(data, options()).problems.map((p) => p.code)).toContain(
      'booking_terminal_excluded_count',
    ),
  )
  await checkSourceMutation(
    source,
    'excludedBookings: exclusionCounts.reduce((sum, entry) => sum + entry.pastOrStarted + entry.terminal, 0)',
    'excludedBookings: 0',
    select,
    (run) => expect(run(data, options()).summary.excludedBookings).toBe(27000),
  )
  await checkSourceMutation(source, 'bookingExclusionCounts: exclusionCounts,', '', select, (run) =>
    expect(run(data, options()).sourceFingerprint).not.toBe(
      run(snapshot(), options()).sourceFingerprint,
    ),
  )
})

it('does not count a reported optional system answer loss as an excluded booking', async () => {
  const source = snapshot()
  required(source.tables.Booking?.[0]).responses = {
    email: 'invitee@example.com',
    rescheduleReason: 'private answer',
  }
  const plan = parseImportPlan(source, options())
  expect(plan.bookings).toHaveLength(1)
  expect(plan.problems.map((p) => p.code)).toContain('booking_system_answer_excluded')
  expect(plan.summary.excludedBookings).toBe(0)
  await checkSourceMutation(
    new URL('./plan.ts', import.meta.url),
    "['booking_not_future', 'booking_terminal_excluded', 'booking_nonleaf_excluded',].includes(p.code)",
    'true',
    (m) => m.parseImportPlan as typeof parseImportPlan,
    (run) => expect(run(source, options()).summary.excludedBookings).toBe(0),
  )
})
