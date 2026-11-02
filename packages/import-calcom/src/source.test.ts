import { randomBytes } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseImportPlan } from './plan.ts'
import { type ExtractOptions, extractSource, SourceRefusal } from './source.ts'
import { createSourceFixture } from './source-fixture.ts'
import type { SourceVersion, TargetUser } from './types.ts'

const versions: SourceVersion[] = ['cal.diy-a5ee96f77edd', 'cal.com-v6.2.0']
const target: TargetUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'owner@example.test',
  emailVerified: true,
  personalOrganizationId: '00000000-0000-4000-8000-000000000002',
  authorized: true,
}
const fixtures: Awaited<ReturnType<typeof createSourceFixture>>[] = []
function options(index = 0): ExtractOptions {
  const fixture = fixtures[index]
  if (!fixture) throw new Error('Fixture not initialized')
  return {
    connectionString: fixture.connectionString,
    sourceVersion: versions[index] as SourceVersion,
    selectedUserIds: [1],
    targetUsers: [target],
    utcTimestampsConfirmed: true,
    cutoff: '2040-12-31T23:59:59.999Z',
  }
}
const dbDescribe = process.env.DATABASE_URL ? describe : describe.skip

function traceSourcePayloads() {
  const query = pg.Client.prototype.query
  const trace = { bookingPreflights: 0, bookingPayloads: 0, availabilityOffsets: [] as number[] }
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    const sql = args[0]
    if (typeof sql === 'string') {
      if (sql.includes('FROM public."Booking" t WHERE')) {
        if (sql.includes('pg_catalog.row_to_json(projected)')) trace.bookingPreflights++
        if (sql.startsWith('SELECT projected.*')) trace.bookingPayloads++
      }
      if (
        sql.startsWith('SELECT projected.*') &&
        sql.includes('FROM public."Availability" t WHERE')
      ) {
        const params = args[1] as unknown[]
        trace.availabilityOffsets.push(Number(params.at(-1)))
        expect(params.at(-2)).toBe(100)
      }
    }
    return query.apply(this, args as never) as never
  } as never)
  return { trace, restore: () => spy.mockRestore() }
}

dbDescribe('read-only Cal.com source extraction', () => {
  beforeAll(async () => {
    for (const version of versions) fixtures.push(await createSourceFixture(version))
  }, 60_000)
  afterAll(async () => {
    for (const fixture of fixtures) await fixture.drop()
  }, 60_000)
  it.each([0, 1])(
    'extracts audited baseline %s with column-only SELECT permissions and no source changes',
    async (index) => {
      const fixture = fixtures[index] as (typeof fixtures)[number]
      const before = await fixture.db.pool.query(`SELECT (SELECT count(*) FROM users)::int AS users,
      (SELECT count(*) FROM "Booking")::int AS bookings,(SELECT count(*) FROM "Attendee")::int AS attendees`)
      await expect(
        fixture.restricted.query('UPDATE users SET name=$1 WHERE id=1', ['forbidden']),
      ).rejects.toMatchObject({ code: '42501' })
      await expect(
        fixture.restricted.query('INSERT INTO "Team"(id) VALUES (999)'),
      ).rejects.toMatchObject({ code: '42501' })
      await expect(
        fixture.restricted.query('CREATE TABLE "ForbiddenWrite"(id int)'),
      ).rejects.toMatchObject({ code: '42501' })
      await expect(
        fixture.restricted.query('CREATE TEMP TABLE "ForbiddenTemp"(id int)'),
      ).rejects.toMatchObject({ code: '42501' })
      await expect(
        fixture.restricted.query('SELECT "twoFactorSecret" FROM users'),
      ).rejects.toMatchObject({ code: '42501' })
      await expect(fixture.restricted.query('SELECT key FROM "Credential"')).rejects.toMatchObject({
        code: '42501',
      })
      const snapshot = await extractSource(options(index))
      expect(snapshot.sourceVersion).toBe(versions[index])
      expect(snapshot.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect(snapshot.tables.users?.map((row) => row.id)).toEqual([1])
      expect(snapshot.tables.EventType?.map((row) => row.id)).toEqual([100])
      expect(snapshot.tables.Booking?.map((row) => row.id)).toEqual([1000])
      expect(snapshot.tables.Attendee?.map((row) => row.id)).toEqual([1])
      expect(snapshot.tables.Booking?.[0]).toMatchObject({
        startTime: '2041-01-01T10:00:00.123Z',
        endTime: '2041-01-01T10:45:00.789Z',
        status: 'accepted',
        hasSuccessor: false,
        hasPayment: false,
        hasSeats: false,
      })
      expect(snapshot.tables.Availability?.[0]).toMatchObject({
        startTime: '09:00:59.125',
        endTime: '23:59:00',
      })
      expect(snapshot.tables.Availability?.[1]?.date).toBe('2041-01-01')
      expect(snapshot.tables.EventType?.[0]?.multipleDuration).toEqual([30, 60])
      const serialized = JSON.stringify(snapshot)
      expect(serialized.includes('NEVER_READ')).toBe(false)
      expect(snapshot.tables.EventType?.[0]).not.toHaveProperty('metadata')
      expect(snapshot.tables.Booking?.[0]).not.toHaveProperty('uid')
      expect(snapshot.tables.Booking?.[0]).not.toHaveProperty('fromReschedule')
      expect(snapshot.tables.Booking?.[0]).not.toHaveProperty('oneTimePassword')
      const after = await fixture.db.pool.query(`SELECT (SELECT count(*) FROM users)::int AS users,
      (SELECT count(*) FROM "Booking")::int AS bookings,(SELECT count(*) FROM "Attendee")::int AS attendees`)
      expect(after.rows).toEqual(before.rows)
      const connections = await fixture.db.pool.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='hourmere_calcom_dry_run' AND datname=current_database()",
      )
      expect(connections.rows[0]?.count).toBe(0)
    },
  )
  it.each([0, 1])(
    'parses real baseline %s extraction into a local-only in-memory plan',
    async (index) => {
      const snapshot = await extractSource(options(index))
      const plan = parseImportPlan(snapshot, {
        target: { users: [target], occupiedHandles: [], occupiedSlugs: [], busy: [] },
        bookingDecisions: [
          { sourceBookingId: 1000, sourceUserId: 1, singleHostAndAttendeeRolesConfirmed: true },
        ],
      })
      expect(plan).toMatchObject({
        mode: 'dry_run',
        writesPerformed: 0,
        summary: {
          matchedUsers: 1,
          draftEvents: 1,
          schedules: 1,
          localBusyBookings: 1,
          importBlockers: 0,
        },
      })
      expect(plan.events[0]).toMatchObject({
        sourceId: 100,
        isActive: false,
        allowedDurationsMinutes: [30, 60],
        scheduleSourceId: 10,
      })
      expect(plan.schedules[0]?.weeklyHours.monday).toEqual([{ start: '09:00', end: '24:00' }])
      expect(plan.schedules[0]?.overrides).toEqual([{ date: '2041-01-01', intervals: [] }])
      expect(plan.bookings[0]).toMatchObject({
        sourceId: 1000,
        policy: 'local_only_read_only',
        start: '2041-01-01T10:00:00.123Z',
        end: '2041-01-01T10:45:00.789Z',
      })
      expect(JSON.stringify(plan).includes('NEVER_READ')).toBe(false)
      expect(JSON.stringify(plan).includes('Other owner')).toBe(false)
      expect(JSON.stringify(plan.problems).includes('invitee@example.test')).toBe(false)
    },
  )
  it('never extracts dependencies of unmatched, unauthorized, unverified or ambiguous identities', async () => {
    for (const targets of [
      [],
      [{ ...target, emailVerified: false }],
      [{ ...target, authorized: false }],
      [{ ...target, personalOrganizationId: null }],
      [target, { ...target, id: '00000000-0000-4000-8000-000000000003' }],
    ]) {
      const snapshot = await extractSource({ ...options(), targetUsers: targets })
      expect(Object.keys(snapshot.tables)).toEqual(['users'])
      expect(Object.keys(snapshot.tables.users?.[0] ?? {}).sort()).toEqual([
        'email',
        'emailVerified',
        'id',
      ])
    }
  })
  it('projects dates independently of the source role DateStyle', async () => {
    const fixture = fixtures[0] as (typeof fixtures)[number]
    await fixture.db.pool.query(`ALTER ROLE ${fixture.role} SET datestyle='SQL, DMY'`)
    try {
      expect((await extractSource(options())).tables.Availability?.[1]?.date).toBe('2041-01-01')
    } finally {
      await fixture.db.pool.query(`ALTER ROLE ${fixture.role} RESET datestyle`)
    }
  })
  it('suppresses host capabilities and non-active or unaudited reference URLs', async () => {
    const fixture = fixtures[0] as (typeof fixtures)[number]
    const unsafe = 'https://zoom.us/s/123456789?zak=NEVER_READ_HOST_SECRET'
    await fixture.db.pool.query('UPDATE "Booking" SET location=NULL WHERE id=1000')
    await fixture.insert('BookingReference', {
      id: 1,
      bookingId: 1000,
      type: 'zoom_video',
      deleted: null,
      meetingUrl: 'https://zoom.us/j/123456789?pwd=private-join-passcode',
    })
    await fixture.insert('BookingReference', {
      id: 2,
      bookingId: 1000,
      type: 'unknown_provider',
      deleted: null,
      meetingUrl: 'https://private.example.test/NEVER_READ_UNKNOWN_PROVIDER',
    })
    await fixture.insert('BookingReference', {
      id: 3,
      bookingId: 1000,
      type: 'zoom_video',
      deleted: false,
      meetingUrl: 'https://zoom.us/j/123456789?pwd=NEVER_READ_DELETED_STATE',
    })
    await fixture.insert('BookingReference', {
      id: 4,
      bookingId: 1000,
      type: 'zoom_video',
      deleted: null,
      meetingUrl: unsafe,
    })
    try {
      const snapshot = await extractSource(options())
      expect(
        snapshot.tables.BookingReference?.filter((row) => row.meetingUrl !== null),
      ).toHaveLength(1)
      expect(JSON.stringify(snapshot).includes('NEVER_READ')).toBe(false)
      await fixture.db.pool.query('UPDATE "Booking" SET location=$1 WHERE id=1000', [unsafe])
      await fixture.db.pool.query('UPDATE "EventType" SET locations=$1 WHERE id=100', [
        JSON.stringify([{ type: 'link', link: unsafe, displayLocationPublicly: true }]),
      ])
      const masked = await extractSource(options())
      expect(masked.tables.Booking?.[0]).toMatchObject({ location: null, unsafeLocation: true })
      expect(masked.tables.EventType?.[0]).toMatchObject({ unsafeLocation: true })
      expect(JSON.stringify(masked).includes('NEVER_READ')).toBe(false)
    } finally {
      await fixture.db.pool.query('DELETE FROM "BookingReference" WHERE "bookingId"=1000')
      await fixture.db.pool.query('UPDATE "Booking" SET location=$1 WHERE id=1000', [
        'https://meet.example.test/join',
      ])
      await fixture.db.pool.query('UPDATE "EventType" SET locations=NULL WHERE id=100')
    }
  })
  it('reads attendees only for strictly future accepted source bookings', async () => {
    const fixture = fixtures[0] as (typeof fixtures)[number]
    for (const [id, status, start] of [
      [1100, 'accepted', options().cutoff],
      [1101, 'pending', '2041-01-01T00:00:00.000Z'],
      [1102, 'rejected', '2041-01-01T00:00:00.000Z'],
    ] as const) {
      await fixture.insert('Booking', {
        id,
        userId: 1,
        eventTypeId: 100,
        title: 'Boundary booking',
        uid: `boundary-${id}`,
        status,
        startTime: start,
        endTime: '2041-01-01T01:00:00.000Z',
      })
      await fixture.insert('Attendee', {
        id,
        bookingId: id,
        name: 'Boundary attendee',
        email: `boundary-${id}@example.test`,
        timeZone: 'UTC',
        locale: 'en',
      })
    }
    try {
      const snapshot = await extractSource(options())
      expect(snapshot.tables.Booking).toHaveLength(4)
      expect(snapshot.tables.Attendee?.map((row) => row.id)).toEqual([1])
    } finally {
      await fixture.db.pool.query('DELETE FROM "Attendee" WHERE id=ANY($1::int[])', [
        [1100, 1101, 1102],
      ])
      await fixture.db.pool.query('DELETE FROM "Booking" WHERE id=ANY($1::int[])', [
        [1100, 1101, 1102],
      ])
    }
  })
  it('refuses source ownership and write grants before reading application data', async () => {
    const fixture = fixtures[0] as (typeof fixtures)[number]
    await expect(
      extractSource({ ...options(), connectionString: fixture.db.url }),
    ).rejects.toMatchObject({ code: 'SOURCE_ROLE_UNSAFE' })
    await fixture.db.pool.query(`GRANT UPDATE(title) ON "Booking" TO ${fixture.role}`)
    try {
      await expect(extractSource(options())).rejects.toMatchObject({ code: 'SOURCE_ROLE_UNSAFE' })
    } finally {
      await fixture.db.pool.query(`REVOKE UPDATE(title) ON "Booking" FROM ${fixture.role}`)
    }
  })
  it('refuses inherited role power and extra column SELECT grants', async () => {
    const fixture = fixtures[0] as (typeof fixtures)[number]
    await fixture.db.pool.query(`ALTER ROLE ${fixture.role} INHERIT`)
    try {
      await expect(extractSource(options())).rejects.toMatchObject({ code: 'SOURCE_ROLE_UNSAFE' })
    } finally {
      await fixture.db.pool.query(`ALTER ROLE ${fixture.role} NOINHERIT`)
    }
    await fixture.db.pool.query(`GRANT SELECT("twoFactorSecret") ON users TO ${fixture.role}`)
    try {
      await expect(extractSource(options())).rejects.toMatchObject({ code: 'SOURCE_ROLE_UNSAFE' })
    } finally {
      await fixture.db.pool.query(`REVOKE SELECT("twoFactorSecret") ON users FROM ${fixture.role}`)
    }
  })
  it('refuses a different baseline declaration and extra unaudited columns', async () => {
    await expect(
      extractSource({ ...options(), sourceVersion: 'cal.com-v6.2.0' }),
    ).rejects.toMatchObject({ code: 'SOURCE_SCHEMA_UNKNOWN' })
    const fixture = fixtures[0] as (typeof fixtures)[number]
    await fixture.db.pool.query('ALTER TABLE "EventType" ADD COLUMN "unknownFutureBehavior" jsonb')
    try {
      await expect(extractSource(options())).rejects.toMatchObject({
        code: 'SOURCE_SCHEMA_UNKNOWN',
      })
    } finally {
      await fixture.db.pool.query('ALTER TABLE "EventType" DROP COLUMN "unknownFutureBehavior"')
    }
  })
  it('refuses unknown scalar types and missing host relationships', async () => {
    const fixture = fixtures[0] as (typeof fixtures)[number]
    await fixture.db.pool.query('ALTER TABLE "EventType" ALTER COLUMN length TYPE text')
    try {
      await expect(extractSource(options())).rejects.toMatchObject({
        code: 'SOURCE_SCHEMA_UNKNOWN',
      })
    } finally {
      await fixture.db.pool.query(
        'ALTER TABLE "EventType" ALTER COLUMN length TYPE int USING length::int',
      )
    }
    const constraint = await fixture.db.pool.query(
      "SELECT conname FROM pg_constraint WHERE conrelid='public.\"Host\"'::regclass AND confrelid='public.users'::regclass",
    )
    const name = constraint.rows[0]?.conname as string
    if (!/^fixture_fk_\d+$/.test(name)) throw new Error('Fixture constraint missing')
    await fixture.db.pool.query(`ALTER TABLE "Host" DROP CONSTRAINT ${name}`)
    try {
      await expect(extractSource(options())).rejects.toMatchObject({
        code: 'SOURCE_SCHEMA_UNKNOWN',
      })
    } finally {
      await fixture.db.pool.query(
        `ALTER TABLE "Host" ADD CONSTRAINT ${name} FOREIGN KEY("userId") REFERENCES users(id)`,
      )
    }
  })
  it('refuses changed nullability and additional foreign-key relationships', async () => {
    const fixture = fixtures[0] as (typeof fixtures)[number]
    await fixture.db.pool.query(`UPDATE "EventType" SET "timeZone"='UTC'`)
    await fixture.db.pool.query('ALTER TABLE "EventType" ALTER COLUMN "timeZone" SET NOT NULL')
    try {
      await expect(extractSource(options())).rejects.toMatchObject({
        code: 'SOURCE_SCHEMA_UNKNOWN',
      })
    } finally {
      await fixture.db.pool.query('ALTER TABLE "EventType" ALTER COLUMN "timeZone" DROP NOT NULL')
      await fixture.db.pool.query('UPDATE "EventType" SET "timeZone"=NULL')
    }
    await fixture.db.pool.query(
      'ALTER TABLE "EventType" ADD CONSTRAINT unaudited_fk FOREIGN KEY(length) REFERENCES "Team"(id) NOT VALID',
    )
    try {
      await expect(extractSource(options())).rejects.toMatchObject({
        code: 'SOURCE_SCHEMA_UNKNOWN',
      })
    } finally {
      await fixture.db.pool.query('ALTER TABLE "EventType" DROP CONSTRAINT unaudited_fk')
    }
  })
  it('refuses an unknown database enum label even when no row uses it', async () => {
    const fixture = await createSourceFixture(versions[0] as SourceVersion)
    try {
      await fixture.db.pool.query('ALTER TYPE "BookingStatus" ADD VALUE \'unknown_status\'')
      await expect(
        extractSource({ ...options(), connectionString: fixture.connectionString }),
      ).rejects.toMatchObject({ code: 'SOURCE_SCHEMA_UNKNOWN' })
    } finally {
      await fixture.drop()
    }
  })
  it('requires explicit UTC timestamp confirmation and a bounded exact selection', async () => {
    await expect(
      extractSource({ ...options(), utcTimestampsConfirmed: false as never }),
    ).rejects.toMatchObject({ code: 'SOURCE_UTC_UNCONFIRMED' })
    for (const selectedUserIds of [[], [1, 1], [1.2], Array.from({ length: 26 }, (_, i) => i + 1)])
      await expect(extractSource({ ...options(), selectedUserIds })).rejects.toMatchObject({
        code: 'SOURCE_SELECTION_INVALID',
      })
    await expect(
      extractSource({ ...options(), cutoff: '2041-01-01 12:00:00' }),
    ).rejects.toMatchObject({ code: 'SOURCE_SELECTION_INVALID' })
  })
  it('checks actual transaction read-only, timezone and isolation settings', async () => {
    const original = pg.Client.prototype.query
    for (const [key, value, code] of [
      ['readOnly', 'off', 'SOURCE_NOT_READ_ONLY'],
      ['timezone', 'America/New_York', 'SOURCE_TIMEZONE_NOT_UTC'],
      ['isolation', 'read committed', 'SOURCE_ISOLATION_UNSAFE'],
    ] as const) {
      const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (
        this: pg.Client,
        ...args: unknown[]
      ) {
        if (
          typeof args[0] === 'string' &&
          args[0].includes("current_setting('transaction_read_only')")
        )
          return Promise.resolve({
            rows: [{ readOnly: 'on', timezone: 'UTC', isolation: 'repeatable read', [key]: value }],
          }) as never
        return original.apply(this, args as never) as never
      } as never)
      try {
        await expect(extractSource(options())).rejects.toMatchObject({ code })
      } finally {
        spy.mockRestore()
      }
    }
  })
  it('projects payment and lineage flags without their payloads and refuses unknown app shape', async () => {
    const fixture = fixtures[0] as (typeof fixtures)[number]
    await fixture.db.pool.query('UPDATE "Booking" SET "fromReschedule"=$1 WHERE id=2000', [
      'NEVER_READ_CANCELLATION_CAPABILITY',
    ])
    await fixture.insert('Payment', { bookingId: 1000 })
    await fixture.insert('BookingSeat', { bookingId: 1000, attendeeId: 1 })
    try {
      const snapshot = await extractSource(options())
      expect(snapshot.tables.Booking?.[0]).toMatchObject({
        hasSuccessor: true,
        successorIds: [2000],
        hasPayment: true,
        hasSeats: true,
      })
      expect(JSON.stringify(snapshot).includes('NEVER_READ')).toBe(false)
      await fixture.db.pool.query('UPDATE "EventType" SET metadata=$1 WHERE id=100', [
        JSON.stringify({
          apps: { stripe: { enabled: true, price: 1, clientSecret: 'NEVER_READ_PAYMENT_SECRET' } },
        }),
      ])
      expect((await extractSource(options())).tables.EventType?.[0]?.paymentConfigured).toBe(true)
      await fixture.db.pool.query('UPDATE "EventType" SET metadata=$1 WHERE id=100', [
        JSON.stringify({ apps: { unrecognized: { secret: 'NEVER_READ_PAYMENT_SECRET' } } }),
      ])
      await expect(extractSource(options())).rejects.toMatchObject({
        code: 'SOURCE_PAYMENT_SHAPE_UNKNOWN',
      })
    } finally {
      await fixture.db.pool.query('DELETE FROM "Payment" WHERE "bookingId"=1000')
      await fixture.db.pool.query('DELETE FROM "BookingSeat" WHERE "bookingId"=1000')
      await fixture.db.pool.query('UPDATE "Booking" SET "fromReschedule"=NULL WHERE id=2000')
      await fixture.db.pool.query('UPDATE "EventType" SET metadata=$1 WHERE id=100', [
        JSON.stringify({
          multipleDuration: [30, 60],
          arbitraryProviderSecret: 'NEVER_READ_PROVIDER_SECRET',
        }),
      ])
    }
  })
  it('checks aggregate byte limits before returning any selected payload', async () => {
    const fixture = fixtures[0] as (typeof fixtures)[number]
    await fixture.db.pool.query(`INSERT INTO "Booking"
      SELECT (pg_catalog.jsonb_populate_record(NULL::"Booking",pg_catalog.to_jsonb(b)||
        pg_catalog.jsonb_build_object('id',g,'uid','aggregate-'||g,
          'responses',pg_catalog.jsonb_build_object('notes',pg_catalog.repeat('x',980000))))).*
      FROM "Booking" b CROSS JOIN pg_catalog.generate_series(3000,3034) g WHERE b.id=1000`)
    const { trace, restore } = traceSourcePayloads()
    try {
      await expect(extractSource(options())).rejects.toMatchObject({
        code: 'SOURCE_LIMIT_EXCEEDED',
      })
      expect(trace.bookingPreflights).toBe(1)
      expect(trace.bookingPayloads).toBe(0)
    } finally {
      restore()
      await fixture.db.pool.query('DELETE FROM "Booking" WHERE id BETWEEN 3000 AND 3034')
    }
  })
  it('extracts approved table payloads in bounded deterministic pages', async () => {
    const fixture = fixtures[0] as (typeof fixtures)[number]
    await fixture.db.pool.query(`INSERT INTO "Availability"(id,"scheduleId",days,"startTime","endTime")
      SELECT g,10,ARRAY[2],'10:00'::time,'11:00'::time FROM pg_catalog.generate_series(3000,3210) g`)
    const { trace, restore } = traceSourcePayloads()
    try {
      const snapshot = await extractSource(options())
      expect(snapshot.tables.Availability).toHaveLength(213)
      expect(snapshot.tables.Availability?.map((row) => row.id)).toEqual([
        1,
        2,
        ...Array.from({ length: 211 }, (_, i) => i + 3000),
      ])
      expect(trace.availabilityOffsets).toEqual([0, 100, 200])
    } finally {
      restore()
      await fixture.db.pool.query('DELETE FROM "Availability" WHERE id BETWEEN 3000 AND 3210')
    }
  })
  it('refuses oversized JSON and closes the source snapshot on failure', async () => {
    const fixture = fixtures[0] as (typeof fixtures)[number]
    await fixture.db.pool.query('UPDATE "Booking" SET responses=$1 WHERE id=1000', [
      JSON.stringify({ notes: 'x'.repeat(1_000_001) }),
    ])
    const { trace, restore } = traceSourcePayloads()
    try {
      await expect(extractSource(options())).rejects.toMatchObject({
        code: 'SOURCE_LIMIT_EXCEEDED',
      })
      expect(trace.bookingPreflights).toBe(1)
      expect(trace.bookingPayloads).toBe(0)
    } finally {
      restore()
      await fixture.db.pool.query('UPDATE "Booking" SET responses=$1 WHERE id=1000', [
        JSON.stringify({ email: 'invitee@example.test' }),
      ])
    }
    const count = await fixture.db.pool.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='hourmere_calcom_dry_run' AND datname=current_database()",
    )
    expect(count.rows[0]?.count).toBe(0)
  })
  it('detects source-copy mutations of read-only, schema, allowlist, identity, limits and secret protections', async () => {
    const fixture = fixtures[0] as (typeof fixtures)[number]
    const original = await readFile(new URL('./source.ts', import.meta.url), 'utf8')
    type Extractor = typeof extractSource
    const mutation = async (
      before: string,
      after: string,
      assertion: (run: Extractor) => Promise<void>,
    ) => {
      expect(original.includes(before)).toBe(true)
      await assertion(extractSource)
      const copy = new URL(
        `./source-copy-${process.pid}-${randomBytes(6).toString('hex')}.ts`,
        import.meta.url,
      )
      await writeFile(copy, original.replace(before, after), { mode: 0o600 })
      try {
        const module = await import(/* @vite-ignore */ pathToFileURL(copy.pathname).href)
        expect(typeof module.extractSource).toBe('function')
        let realAssertionFailed = false
        try {
          await assertion(module.extractSource as Extractor)
        } catch (error) {
          // A failed assertion is the negative control; unrelated execution errors are failures.
          if (error instanceof Error && error.name === 'AssertionError') realAssertionFailed = true
          else throw error
        }
        expect(realAssertionFailed).toBe(true)
      } finally {
        await unlink(copy)
      }
    }
    await mutation(
      'await assertRestrictedRole(client)',
      '/* role preflight removed */',
      async (run) => {
        await expect(run({ ...options(), connectionString: fixture.db.url })).rejects.toMatchObject(
          { code: 'SOURCE_ROLE_UNSAFE' },
        )
      },
    )
    await fixture.db.pool.query(`GRANT SELECT("twoFactorSecret") ON users TO ${fixture.role}`)
    try {
      await mutation('(row.readable && !allowed)', 'false', async (run) => {
        await expect(run(options())).rejects.toMatchObject({ code: 'SOURCE_ROLE_UNSAFE' })
      })
    } finally {
      await fixture.db.pool.query(`REVOKE SELECT("twoFactorSecret") ON users FROM ${fixture.role}`)
    }
    await mutation(
      'const EVENT_METADATA = `',
      'const EVENT_METADATA = ` t.metadata AS metadata,',
      async (run) => {
        expect(JSON.stringify(await run(options())).includes('NEVER_READ')).toBe(false)
      },
    )
    await mutation(
      'const matched = matchIdentityRows(identities, options.targetUsers)',
      'const matched = identities.map(row => row.id as number)',
      async (run) => {
        expect(Object.keys((await run({ ...options(), targetUsers: [] })).tables)).toEqual([
          'users',
        ])
      },
    )
    await fixture.db.pool.query('ALTER TABLE "EventType" ALTER COLUMN length TYPE text')
    try {
      await mutation(
        'await detectSchema(client, options.sourceVersion)',
        "'a'.repeat(64)",
        async (run) => {
          await expect(run(options())).rejects.toMatchObject({ code: 'SOURCE_SCHEMA_UNKNOWN' })
        },
      )
    } finally {
      await fixture.db.pool.query(
        'ALTER TABLE "EventType" ALTER COLUMN length TYPE int USING length::int',
      )
    }
    for (const [key, value, condition, code] of [
      ['readOnly', 'off', "settings.rows[0]?.readOnly !== 'on'", 'SOURCE_NOT_READ_ONLY'],
      [
        'timezone',
        'America/New_York',
        "settings.rows[0]?.timezone !== 'UTC'",
        'SOURCE_TIMEZONE_NOT_UTC',
      ],
      [
        'isolation',
        'read committed',
        "settings.rows[0]?.isolation !== 'repeatable read'",
        'SOURCE_ISOLATION_UNSAFE',
      ],
    ] as const) {
      const query = pg.Client.prototype.query
      const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (
        this: pg.Client,
        ...args: unknown[]
      ) {
        if (
          typeof args[0] === 'string' &&
          args[0].includes("current_setting('transaction_read_only')")
        )
          return Promise.resolve({
            rows: [{ readOnly: 'on', timezone: 'UTC', isolation: 'repeatable read', [key]: value }],
          }) as never
        return query.apply(this, args as never) as never
      } as never)
      try {
        await mutation(condition, 'false', async (run) => {
          await expect(run(options())).rejects.toMatchObject({ code })
        })
      } finally {
        spy.mockRestore()
      }
    }
    await mutation('options.utcTimestampsConfirmed !== true', 'false', async (run) => {
      await expect(
        run({ ...options(), utcTimestampsConfirmed: false as never }),
      ).rejects.toMatchObject({ code: 'SOURCE_UTC_UNCONFIRMED' })
    })
    await fixture.db.pool.query('UPDATE "Booking" SET responses=$1 WHERE id=1000', [
      JSON.stringify({ notes: 'x'.repeat(1_000_001) }),
    ])
    try {
      await mutation('projectedMaxBytes > LIMITS.jsonBytes', 'false', async (run) => {
        const { trace, restore } = traceSourcePayloads()
        try {
          await expect(run(options())).rejects.toMatchObject({ code: 'SOURCE_LIMIT_EXCEEDED' })
          expect(trace.bookingPayloads).toBe(0)
        } finally {
          restore()
        }
      })
    } finally {
      await fixture.db.pool.query('UPDATE "Booking" SET responses=$1 WHERE id=1000', [
        JSON.stringify({ email: 'invitee@example.test' }),
      ])
    }
    const unsafe = 'https://zoom.us/s/123456789?zak=NEVER_READ_HOST_SECRET'
    await fixture.db.pool.query('UPDATE "Booking" SET location=$1 WHERE id=1000', [unsafe])
    await fixture.db.pool.query('UPDATE "EventType" SET locations=$1 WHERE id=100', [
      JSON.stringify([{ type: 'link', link: unsafe, displayLocationPublicly: true }]),
    ])
    try {
      for (const condition of ['!safeMeetingUrl(row.location)', '!safeMeetingUrl(link)']) {
        await mutation(condition, 'false', async (run) => {
          expect(JSON.stringify(await run(options())).includes('NEVER_READ')).toBe(false)
        })
      }
    } finally {
      await fixture.db.pool.query('UPDATE "Booking" SET location=$1 WHERE id=1000', [
        'https://meet.example.test/join',
      ])
      await fixture.db.pool.query('UPDATE "EventType" SET locations=NULL WHERE id=100')
    }
    await fixture.db.pool.query('UPDATE "Booking" SET location=NULL WHERE id=1000')
    await fixture.insert('BookingReference', {
      id: 99,
      bookingId: 1000,
      type: 'unknown_provider',
      deleted: null,
      meetingUrl: 'https://private.example.test/NEVER_READ_UNKNOWN_PROVIDER',
    })
    try {
      await mutation(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Match literal interpolation in a source-copy mutation.
        "${alias}.deleted IS NULL AND ${alias}.type IN ('zoom_video','google_video','google_calendar','daily_video','office365_video','office365_calendar')",
        'true',
        async (run) => {
          expect(JSON.stringify(await run(options())).includes('NEVER_READ')).toBe(false)
        },
      )
    } finally {
      await fixture.db.pool.query('DELETE FROM "BookingReference" WHERE id=99')
      await fixture.db.pool.query('UPDATE "Booking" SET location=$1 WHERE id=1000', [
        'https://meet.example.test/join',
      ])
    }
    const secretUrl = new URL(fixture.connectionString)
    secretUrl.username = 'SOURCE_SECRET_DO_NOT_DISCLOSE'
    await mutation(
      'if (error instanceof SourceRefusal) throw error',
      'throw error',
      async (run) => {
        let caught: unknown
        try {
          await run({ ...options(), connectionString: secretUrl.toString() })
        } catch (error) {
          caught = error
        }
        expect(caught).toBeTruthy()
        expect(String(caught).includes('SOURCE_SECRET_DO_NOT_DISCLOSE')).toBe(false)
      },
    )
  }, 30_000)
  it('does not disclose secrets or driver details through errors or logs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const secret = 'SOURCE_SECRET_DO_NOT_DISCLOSE'
    try {
      for (const connectionString of [
        `postgres://operator:${secret}@127.0.0.1:1/private_source`,
        `postgres://operator:${secret}@localhost/source?options=${secret}`,
      ]) {
        let caught: unknown
        try {
          await extractSource({ ...options(), connectionString })
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(SourceRefusal)
        expect(String(caught).includes(secret)).toBe(false)
        expect(JSON.stringify(caught).includes(secret)).toBe(false)
        expect((caught as Error).cause).toBeUndefined()
      }
      expect(log).not.toHaveBeenCalled()
      expect(errorLog).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
      errorLog.mockRestore()
    }
  })
})
