import { mkdtemp, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createTestUser } from '../../scheduling/src/testing.ts'
import { applyExtractedImport, applyImport } from './apply.ts'
import { runCli } from './cli.ts'
import { checkSourceMutation, required } from './mutation-testing.ts'
import { renderPreview } from './operator-cli.ts'
import { fingerprint } from './plan.ts'
import {
  buildPreview,
  extractForPreview,
  previewImport,
  projectedTargetWithinLimits,
  registerImportSource,
  type SourceInput,
} from './preview.ts'
import { createSourceFixture } from './source-fixture.ts'
import { readTargetState, validateAuthorization } from './target.ts'
import type { SourceVersion } from './types.ts'

describe.skipIf(!process.env.DATABASE_URL)('authorized target preview and atomic import', () => {
  let target: TestDatabase
  const users: string[] = []
  const sources = new Map<SourceVersion, Awaited<ReturnType<typeof createSourceFixture>>>()
  beforeAll(async () => {
    target = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'calcom_apply',
    })
    for (const version of ['cal.diy-a5ee96f77edd', 'cal.com-v6.2.0'] as const)
      sources.set(version, await createSourceFixture(version))
  }, 30_000)
  afterEach(async () => {
    await target.pool.query('DELETE FROM auth."user" WHERE id=ANY($1::uuid[])', [users.splice(0)])
  })
  afterAll(async () => {
    try {
      for (const s of sources.values()) await s.drop()
    } finally {
      await target?.drop()
    }
  }, 60_000)
  async function setup(version: SourceVersion = 'cal.diy-a5ee96f77edd') {
    const user = await createTestUser(createDb(target.pool))
    users.push(user.id)
    await target.pool.query('UPDATE auth."user" SET email=$1 WHERE id=$2', [
      'owner@example.test',
      user.id,
    ])
    const input: SourceInput = {
      connectionString: sources.get(version)?.connectionString as string,
      sourceId: '00000000-0000-4000-8000-000000000000',
      sourceVersion: version,
      selectedUserIds: [1],
      utcTimestampsConfirmed: true,
      authorization: {
        operatorUserId: user.id,
        operatorAuthorized: true,
        owners: [{ sourceUserId: 1, targetUserId: user.id, importPersonalData: true }],
      },
      bookingDecisions: [
        { sourceBookingId: 1000, sourceUserId: 1, singleHostAndAttendeeRolesConfirmed: true },
      ],
    }
    const snapshot = await extractForPreview(target.pool, input, '2040-01-01T00:00:00.000Z')
    input.sourceId = await registerImportSource(target.pool, snapshot, input.authorization)
    const { connectionString: _connectionString, ...options } = input
    const plan = buildPreview(
      snapshot,
      await readTargetState(target.pool, input.sourceId, input.authorization, snapshot.cutoff),
      options,
    )
    return { user, input, snapshot, plan }
  }
  async function repreview(f: Awaited<ReturnType<typeof setup>>, snapshot = f.snapshot) {
    const { connectionString: _connectionString, ...options } = f.input
    return buildPreview(
      snapshot,
      await readTargetState(target.pool, f.input.sourceId, f.input.authorization, snapshot.cutoff),
      options,
    )
  }
  const apply = (f: Awaited<ReturnType<typeof setup>>, snapshot = f.snapshot) =>
    applyExtractedImport(target.pool, f.plan, f.input, async () => snapshot)
  async function businessCounts(userId: string) {
    return (
      await target.pool.query(
        `SELECT
      (SELECT count(*)::int FROM profiles WHERE user_id=$1) AS profiles,
      (SELECT count(*)::int FROM schedules WHERE user_id=$1) AS schedules,
      (SELECT count(*)::int FROM event_types WHERE owner_user_id=$1) AS events,
      (SELECT count(*)::int FROM booking_hosts WHERE user_id=$1) AS bookings`,
        [userId],
      )
    ).rows[0]
  }
  const empty = { profiles: 0, schedules: 0, events: 0, bookings: 0 }

  it.each(['cal.diy-a5ee96f77edd', 'cal.com-v6.2.0'] as const)(
    'previews real target and imports %s once, with stable crosswalk and no jobs',
    async (version) => {
      const f = await setup(version)
      expect(f.plan.blocked).toBe(false)
      expect(f.plan.plan.bookings).toHaveLength(1)
      expect(await businessCounts(f.user.id)).toEqual(empty)
      expect(f.plan.writes).toContainEqual({ table: 'booking_attendees', rows: 1 })
      expect(f.plan.bookingTimes[0]?.startUtc).toBe('2041-01-01T10:00:00.123Z')
      expect(f.plan.bookingTimes[0]?.startLocal).toContain('America/New_York')
      expect(f.plan.impacts.some((i) => i.code === 'daily_count')).toBe(true)
      expect(f.plan.inactiveEventSourceIds).toEqual([100])
      expect(f.plan.counts.some((c) => c.disposition === 'excluded')).toBe(true)
      const first = await applyImport(target.pool, f.plan, f.input)
      expect(first).toMatchObject({ status: 'applied', committed: true, failures: [] })
      expect(await businessCounts(f.user.id)).toEqual({
        profiles: 1,
        schedules: 1,
        events: 1,
        bookings: 1,
      })
      const booking = (
        await target.pool.query(
          `SELECT b.*,h.active,lower(h.period) AS busy_start,upper(h.period) AS busy_end
      FROM bookings b JOIN booking_hosts h ON h.booking_id=b.id WHERE h.user_id=$1`,
          [f.user.id],
        )
      ).rows[0]
      expect(booking).toMatchObject({
        source: 'import',
        status: 'confirmed',
        manage_token_hash: null,
        rescheduled_from_id: null,
        ical_organizer_name: null,
        ical_organizer_email: null,
        active: true,
        notification_snapshot: {
          version: 1,
          executionMode: 'configurable',
          notifications: { reminders: [], followUps: [] },
        },
        import_questions: [],
      })
      expect(booking.start_at.toISOString()).toBe('2041-01-01T10:00:00.123Z')
      expect(booking.end_at.toISOString()).toBe('2041-01-01T10:45:00.789Z')
      expect(booking.busy_start).toEqual(booking.start_at)
      expect(booking.busy_end).toEqual(booking.end_at)
      const event = (
        await target.pool.query(
          'SELECT is_active,is_hidden,allowed_durations_minutes,notifications,success_redirect FROM event_types WHERE id=$1',
          [booking.event_type_id],
        )
      ).rows[0]
      expect(event).toEqual({
        is_active: false,
        is_hidden: false,
        allowed_durations_minutes: [30, 60],
        notifications: { reminders: [], followUps: [] },
        success_redirect: null,
      })
      for (const table of [
        'booking_notifications',
        'booking_scheduled_messages',
        'booking_calendar_targets',
        'booking_calendar_events',
        'booking_conferences',
        'booking_conference_mirrors',
        'booking_conference_notifications',
        'webhook_deliveries',
      ]) {
        expect(
          (await target.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n,
        ).toBe(0)
      }
      expect(
        (
          await target.pool.query(
            "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname='pgboss'",
          )
        ).rows[0]?.n,
      ).toBe(0)
      // Discarding the first response models a lost response after the committed transaction.
      const rerun = await applyImport(target.pool, f.plan, f.input)
      expect(rerun).toMatchObject({ status: 'noop', committed: true, created: [] })
      expect(await businessCounts(f.user.id)).toEqual({
        profiles: 1,
        schedules: 1,
        events: 1,
        bookings: 1,
      })
      const preview = await repreview(f)
      expect(preview.entities.every((e) => e.disposition === 'noop')).toBe(true)
      const crosswalk = (
        await target.pool.query(
          "SELECT question_crosswalk FROM import_items WHERE source_id=$1 AND entity_kind='event_type'",
          [f.input.sourceId],
        )
      ).rows[0]?.question_crosswalk
      expect(crosswalk).toEqual({ questions: f.plan.plan.events[0]?.questionCrosswalk })
    },
  )
  it('reads target snapshots without business or metadata writes during preview', async () => {
    const f = await setup()
    const before = (await target.pool.query('SELECT count(*)::int AS n FROM import_sources'))
      .rows[0]?.n
    const live = await previewImport(target.pool, f.input)
    expect(live.sourceId).toBe(f.input.sourceId)
    expect(live.plan.writesPerformed).toBe(0)
    expect(await businessCounts(f.user.id)).toEqual(empty)
    expect(
      (await target.pool.query('SELECT count(*)::int AS n FROM import_sources')).rows[0]?.n,
    ).toBe(before)
    expect(
      (
        await target.pool.query('SELECT count(*)::int AS n FROM import_items WHERE source_id=$1', [
          f.input.sourceId,
        ])
      ).rows[0]?.n,
    ).toBe(0)
  })
  it('serializes simultaneous applies of the same plan into one commit and one no-op', async () => {
    const f = await setup()
    const reports = await Promise.all([apply(f), apply(f)])
    expect(reports.map((r) => r.status).sort()).toEqual(['applied', 'noop'])
    expect(await businessCounts(f.user.id)).toEqual({
      profiles: 1,
      schedules: 1,
      events: 1,
      bookings: 1,
    })
  })
  it('rolls back every business row and mapping after a mid-apply database error, then retries', async () => {
    const f = await setup()
    await target.pool.query(`CREATE FUNCTION fail_import_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'private-driver-secret@example.test'; END $$;
      CREATE TRIGGER fail_import_test BEFORE INSERT ON booking_attendees FOR EACH ROW EXECUTE FUNCTION fail_import_test()`)
    try {
      const failed = await apply(f)
      expect(failed).toMatchObject({
        status: 'failed',
        committed: false,
        created: [],
        failures: [
          {
            code: 'IMPORT_APPLY_FAILED',
            stage: 'write_entities',
            entity: 'booking',
            sourceKey: '1000',
          },
        ],
      })
      expect(JSON.stringify(failed)).not.toContain('private-driver-secret')
      expect(await businessCounts(f.user.id)).toEqual(empty)
      expect(
        (
          await target.pool.query(
            'SELECT count(*)::int AS n FROM import_items WHERE source_id=$1',
            [f.input.sourceId],
          )
        ).rows[0]?.n,
      ).toBe(0)
    } finally {
      await target.pool.query(
        'DROP TRIGGER fail_import_test ON booking_attendees; DROP FUNCTION fail_import_test()',
      )
    }
    expect((await apply(f)).status).toBe('applied')
  })
  it('loses a backend connection mid-transaction without partial rows or duplicates', async () => {
    const f = await setup()
    // The test-owned trigger terminates only its own import backend after earlier inserts.
    await target.pool.query(`CREATE FUNCTION crash_import_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NEW; END $$;
      CREATE TRIGGER crash_import_test BEFORE INSERT ON booking_attendees FOR EACH ROW EXECUTE FUNCTION crash_import_test()`)
    try {
      expect((await apply(f)).status).toBe('failed')
      expect(await businessCounts(f.user.id)).toEqual(empty)
    } finally {
      await target.pool.query(
        'DROP TRIGGER crash_import_test ON booking_attendees; DROP FUNCTION crash_import_test()',
      )
    }
    expect((await apply(f)).status).toBe('applied')
    expect((await apply(f)).status).toBe('noop')
  })
  it.each([
    'source',
    'destination',
    'default_schedule',
    'verified',
    'ownership',
    'schema',
  ] as const)('rejects %s changes after preview', async (change) => {
    const f = await setup()
    const next = structuredClone(f.snapshot)
    if (change === 'source')
      next.tables.Booking?.forEach((b) => {
        b.title = 'Changed'
      })
    if (change === 'destination')
      await target.pool.query('INSERT INTO profiles(user_id,handle,time_zone) VALUES($1,$2,$3)', [
        f.user.id,
        'changed',
        'UTC',
      ])
    if (change === 'default_schedule')
      await target.pool.query(
        "INSERT INTO schedules(user_id,name,time_zone,weekly_hours,is_default) VALUES($1,'New default','UTC','{}',true)",
        [f.user.id],
      )
    if (change === 'verified')
      await target.pool.query('UPDATE auth."user" SET "emailVerified"=false WHERE id=$1', [
        f.user.id,
      ])
    if (change === 'ownership')
      await target.pool.query('DELETE FROM auth.member WHERE "userId"=$1', [f.user.id])
    if (change === 'schema')
      await target.pool.query(
        "INSERT INTO schema_migrations(name,checksum) VALUES('9999_synthetic.sql',$1)",
        ['f'.repeat(64)],
      )
    try {
      expect((await apply(f, next)).status).toBe('failed')
    } finally {
      if (change === 'schema')
        await target.pool.query("DELETE FROM schema_migrations WHERE name='9999_synthetic.sql'")
    }
    expect(
      (
        await target.pool.query('SELECT count(*)::int AS n FROM import_items WHERE source_id=$1', [
          f.input.sourceId,
        ])
      ).rows[0]?.n,
    ).toBe(0)
  })
  it('re-extracts the SELECT-only source and detects changed accepted status', async () => {
    const f = await setup(),
      source = sources.get(f.input.sourceVersion) as Awaited<ReturnType<typeof createSourceFixture>>
    await source.db.pool.query('UPDATE "Booking" SET status=\'cancelled\' WHERE id=1000')
    try {
      expect(await applyImport(target.pool, f.plan, f.input)).toMatchObject({
        status: 'failed',
        code: 'IMPORT_SOURCE_CHANGED',
      })
      expect(await businessCounts(f.user.id)).toEqual(empty)
    } finally {
      await source.db.pool.query('UPDATE "Booking" SET status=\'accepted\' WHERE id=1000')
    }
  })
  it('requires operator and every exact data-owner choice again at apply', async () => {
    const f = await setup()
    for (const mutate of [
      (p: SourceInput) => {
        p.authorization.operatorAuthorized = false as true
      },
      (p: SourceInput) => {
        required(p.authorization.owners[0]).importPersonalData = false as true
      },
      (p: SourceInput) => {
        p.authorization.owners = []
      },
    ]) {
      const changed = structuredClone(f.input)
      mutate(changed)
      expect(
        (await applyExtractedImport(target.pool, f.plan, changed, async () => f.snapshot)).status,
      ).toBe('failed')
    }
    expect(await businessCounts(f.user.id)).toEqual(empty)
  })
  it('rejects a modified plan even with unchanged source and target', async () => {
    const f = await setup()
    required(f.plan.plan.bookings[0]).title = 'Tampered'
    expect(await apply(f)).toMatchObject({ status: 'failed', code: 'IMPORT_PLAN_INVALID' })
    expect(await businessCounts(f.user.id)).toEqual(empty)
  })
  it('blocks target and same-batch overlaps and never reports blocked rows as imported', async () => {
    const f = await setup()
    const extra = structuredClone(f.snapshot.tables.Booking?.[0]) as Record<string, unknown>
    extra.id = 1001
    const next = structuredClone(f.snapshot)
    next.tables.Booking?.push(extra)
    next.tables.Attendee?.push({ ...next.tables.Attendee[0], id: 50, bookingId: 1001 })
    f.input.bookingDecisions.push({
      sourceBookingId: 1001,
      sourceUserId: 1,
      singleHostAndAttendeeRolesConfirmed: true,
    })
    const blocked = await repreview(f, next)
    expect(blocked.blocked).toBe(true)
    expect(blocked.plan.summary.localBusyBookings).toBe(0)
    expect(blocked.bookingTimes.every((b) => b.disposition === 'blocked')).toBe(true)
    expect(blocked.writes.every((w) => w.rows === 0)).toBe(true)
    expect(blocked.losses.some((p) => p.code === 'booking_batch_overlap')).toBe(true)
    const event = (
      await target.pool.query(
        `INSERT INTO event_types(organization_id,owner_user_id,slug,title,duration_minutes)
      VALUES($1,$2,'existing','Existing',30) RETURNING id`,
        [f.user.principal.organization.id, f.user.id],
      )
    ).rows[0]?.id
    const booking = (
      await target.pool.query(
        `INSERT INTO bookings(organization_id,event_type_id,title,start_at,end_at,source)
      VALUES($1,$2,'Existing','2041-01-01T10:00Z','2041-01-01T11:00Z','web') RETURNING id`,
        [f.user.principal.organization.id, event],
      )
    ).rows[0]?.id
    await target.pool.query(
      "INSERT INTO booking_hosts(booking_id,user_id,period,active) VALUES($1,$2,'empty',false)",
      [booking, f.user.id],
    )
    const targetBlocked = await repreview(f)
    expect(targetBlocked.losses.some((p) => p.code === 'booking_target_overlap')).toBe(true)
    expect(targetBlocked.blocked).toBe(true)
  })
  it('preserves existing handles/defaults and requires an explicit new slug on collision', async () => {
    const f = await setup()
    await target.pool.query(
      "INSERT INTO profiles(user_id,handle,time_zone,locale) VALUES($1,'kept','UTC','zh-CN')",
      [f.user.id],
    )
    await target.pool.query(
      "INSERT INTO event_types(organization_id,owner_user_id,slug,title,duration_minutes) VALUES($1,$2,'consultation','Existing',30)",
      [f.user.principal.organization.id, f.user.id],
    )
    expect((await repreview(f)).blocked).toBe(true)
    f.input.resolutions = { slugs: { 100: 'chosen' } }
    f.plan = await repreview(f)
    expect(f.plan.blocked).toBe(false)
    expect(f.plan.addresses).toContainEqual({
      kind: 'handle',
      sourceId: 1,
      old: 'owner',
      proposed: 'kept',
      action: 'preserve',
    })
    expect((await apply(f)).status).toBe('applied')
    expect(
      (
        await target.pool.query('SELECT handle,time_zone,locale FROM profiles WHERE user_id=$1', [
          f.user.id,
        ])
      ).rows[0],
    ).toEqual({ handle: 'kept', time_zone: 'UTC', locale: 'zh-CN' })
  })
  it.each(['booking', 'schedule', 'event_type', 'profile', 'user'] as const)(
    'retains minimal %s tombstones and never resurrects deleted targets',
    async (kind) => {
      const f = await setup()
      expect((await apply(f)).status).toBe('applied')
      const item = (
        await target.pool.query(
          'SELECT * FROM import_items WHERE source_id=$1 AND entity_kind=$2',
          [f.input.sourceId, kind],
        )
      ).rows[0]
      if (kind === 'event_type')
        await target.pool.query('UPDATE event_types SET deleted_at=now() WHERE id=$1', [
          item.target_id,
        ])
      else if (kind === 'profile')
        await target.pool.query('DELETE FROM profiles WHERE user_id=$1', [item.target_id])
      else if (kind === 'user')
        await target.pool.query('DELETE FROM auth."user" WHERE id=$1', [item.target_id])
      else
        await target.pool.query(
          `DELETE FROM ${kind === 'booking' ? 'bookings' : 'schedules'} WHERE id=$1`,
          [item.target_id],
        )
      const tombstone = (
        await target.pool.query(
          'SELECT * FROM import_items WHERE source_id=$1 AND entity_kind=$2',
          [f.input.sourceId, kind],
        )
      ).rows[0]
      expect(tombstone).toMatchObject({
        target_id: null,
        source_fingerprint: null,
        target_fingerprint: null,
        policy: null,
        question_crosswalk: {},
      })
      expect(tombstone.deleted_at).not.toBeNull()
      expect((await apply(f)).status).toBe('failed')
      if (kind !== 'user')
        expect((await repreview(f)).entities.some((e) => e.reason === 'target_deleted')).toBe(true)
    },
  )
  it('reports changed source and changed imported destination as conflicts without overwrite', async () => {
    const f = await setup()
    expect((await apply(f)).status).toBe('applied')
    const next = structuredClone(f.snapshot)
    required(next.tables.EventType?.[0]).title = 'Changed source'
    expect((await repreview(f, next)).entities.some((e) => e.reason === 'source_changed')).toBe(
      true,
    )
    await target.pool.query("UPDATE event_types SET title='Target edit' WHERE owner_user_id=$1", [
      f.user.id,
    ])
    expect((await repreview(f)).entities.some((e) => e.reason === 'target_changed')).toBe(true)
    expect((await apply(f)).status).toBe('failed')
    expect(
      (await target.pool.query('SELECT title FROM event_types WHERE owner_user_id=$1', [f.user.id]))
        .rows[0]?.title,
    ).toBe('Target edit')
  })
  it('masks emails in human output and exposes full email only in the authorized private report', async () => {
    const f = await setup()
    expect(renderPreview(f.plan)).not.toMatch(/owner@example|invitee@example/)
    expect(renderPreview(f.plan)).toContain('O***@***')
    expect(renderPreview(f.plan, 'zh-CN')).toContain('零外部副作用')
    expect(renderPreview(f.plan, 'en', true)).toContain('Owner@Example.test')
    expect(JSON.stringify(f.plan)).not.toMatch(
      /postgres:|NEVER_READ|"credentials":|oneTimePassword|meetingPassword/,
    )
  })
  it('runs the default preview and apply CLI with protected plan/report outputs and no credential logs', async () => {
    const f = await setup(),
      directory = await mkdtemp(join(tmpdir(), 'calcom-operator-'))
    const config = join(directory, 'config.json'),
      plan = join(directory, 'plan.json'),
      report = join(directory, 'report.txt')
    const { connectionString, ...options } = f.input
    const env = { CALCOM_IMPORT_SOURCE_URL: connectionString, CALCOM_IMPORT_TARGET_URL: target.url }
    const output: string[] = []
    try {
      await writeFile(config, JSON.stringify(options), { mode: 0o600 })
      expect(
        await runCli(['--config', config, '--out', plan, '--report', report], env, (s) =>
          output.push(s),
        ),
      ).toBe(0)
      expect((await stat(plan)).mode & 0o077).toBe(0)
      expect((await stat(report)).mode & 0o077).toBe(0)
      expect(await readFile(report, 'utf8')).toContain('Owner@Example.test')
      expect(output.join('\n')).not.toMatch(/Owner@Example.test|invitee@example.test|postgres:/)
      expect(
        await runCli(['apply', '--config', config, '--plan', plan], env, (s) => output.push(s)),
      ).toBe(0)
      expect(output.some((s) => s.includes('IMPORT_APPLIED'))).toBe(true)
      expect(
        await runCli(['apply', '--config', config, '--plan', plan], env, (s) => output.push(s)),
      ).toBe(0)
      expect(output.some((s) => s.includes('IMPORT_NOOP'))).toBe(true)
      expect(
        await runCli(['preview', '--config', config, '--out', plan], env, (s) => output.push(s)),
      ).toBe(1)
      expect(await readFile(plan, 'utf8')).not.toContain(connectionString)
    } finally {
      for (const file of [config, plan, report]) await unlink(file).catch(() => {})
      await rmdir(directory)
    }
  })
  it('explicitly excludes unresolved future bookings without silently importing their dependents', async () => {
    const f = await setup(),
      changed = structuredClone(f.snapshot)
    required(changed.tables.Booking?.[0]).status = 'pending'
    expect((await repreview(f, changed)).blocked).toBe(true)
    f.input.exclusions = { bookings: [1000], acknowledged: true }
    f.plan = await repreview(f, changed)
    expect(f.plan.blocked).toBe(false)
    expect(f.plan.manualExclusions).toEqual([{ table: 'Booking', sourceId: 1000 }])
    expect(f.plan.bookingTimes[0]?.disposition).toBe('excluded')
    expect((await apply(f, changed)).status).toBe('applied')
    expect((await businessCounts(f.user.id)).bookings).toBe(0)
  })
  it('supports separate owner batches using one persistent source namespace', async () => {
    const f = await setup(),
      source = required(sources.get(f.input.sourceVersion))
    expect((await apply(f)).status).toBe('applied')
    const other = await createTestUser(createDb(target.pool))
    users.push(other.id)
    await target.pool.query('UPDATE auth."user" SET email=$1 WHERE id=$2', [
      'other@example.test',
      other.id,
    ])
    await source.insert('Host', { eventTypeId: 200, userId: 2 })
    try {
      const next: SourceInput = {
        ...f.input,
        selectedUserIds: [2],
        authorization: {
          operatorUserId: other.id,
          operatorAuthorized: true,
          owners: [{ sourceUserId: 2, targetUserId: other.id, importPersonalData: true }],
        },
        bookingDecisions: [],
        exclusions: { bookings: [2000], acknowledged: true },
      }
      const snapshot = await extractForPreview(target.pool, next, f.snapshot.cutoff)
      const { connectionString: _connectionString, ...options } = next
      const plan = buildPreview(
        snapshot,
        await readTargetState(target.pool, next.sourceId, next.authorization, snapshot.cutoff),
        options,
      )
      expect(plan.blocked).toBe(false)
      expect(plan.entities.every((e) => e.sourceUserId === 2)).toBe(true)
      expect(
        (await applyExtractedImport(target.pool, plan, next, async () => snapshot)).status,
      ).toBe('applied')
      expect((await apply(f)).status).toBe('failed')
      f.plan = await repreview(f)
      expect(f.plan.entities.every((e) => e.disposition === 'noop')).toBe(true)
      expect((await apply(f)).status).toBe('noop')
    } finally {
      await source.db.pool.query('DELETE FROM "Host" WHERE "eventTypeId"=200 AND "userId"=2')
    }
  })
  async function expiredFixture(start: string) {
    const f = await setup(),
      snapshot = structuredClone(f.snapshot)
    snapshot.cutoff = '2020-01-01T00:00:00.000Z'
    const b = required(snapshot.tables.Booking?.[0])
    b.startTime = start
    b.endTime = Temporal.Instant.from(start)
      .add({ hours: 1 })
      .toString({ smallestUnit: 'millisecond' })
    f.snapshot = snapshot
    f.plan = await repreview(f, snapshot)
    expect(f.plan.blocked).toBe(false)
    return f
  }
  it('expires a plan when its nearest booking starts before apply', async () => {
    const f = await expiredFixture('2021-01-01T10:00:00.000Z')
    expect(await apply(f)).toMatchObject({ status: 'failed', code: 'IMPORT_PLAN_EXPIRED' })
    expect(await businessCounts(f.user.id)).toEqual(empty)
  })
  it('checks database wall time again after writes waited past the booking start', async () => {
    const now = (
      await target.pool.query<{ now: string }>(
        "SELECT to_char((clock_timestamp() + interval '1 second') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS now",
      )
    ).rows[0]?.now as string
    const f = await expiredFixture(now)
    await target.pool.query(
      `CREATE FUNCTION delay_import_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $$; CREATE TRIGGER delay_import_test BEFORE INSERT ON booking_attendees FOR EACH ROW EXECUTE FUNCTION delay_import_test()`,
    )
    try {
      expect(await apply(f)).toMatchObject({ status: 'failed', code: 'IMPORT_PLAN_EXPIRED' })
      expect(await businessCounts(f.user.id)).toEqual(empty)
    } finally {
      await target.pool.query(
        'DROP TRIGGER delay_import_test ON booking_attendees; DROP FUNCTION delay_import_test()',
      )
    }
  })
  it('keeps a committed lost-response replay a no-op after its start', async () => {
    const start = Temporal.Now.instant()
      .add({ seconds: 1 })
      .toString({ smallestUnit: 'millisecond' })
    const f = await expiredFixture(start)
    expect((await apply(f)).status).toBe('applied')
    await target.pool.query('SELECT pg_sleep(1.1)')
    expect((await apply(f)).status).toBe('noop')
  })
  it('reports existing own buffers and event-specific daily limits accurately', async () => {
    const f = await setup(),
      snapshot = structuredClone(f.snapshot)
    required(snapshot.tables.EventType?.[0]).bookingLimits = { PER_DAY: 1 }
    const org = f.user.principal.organization.id
    const event = (
      await target.pool.query(
        `INSERT INTO event_types(organization_id,owner_user_id,slug,title,duration_minutes,buffer_after_minutes)
      VALUES($1,$2,'other','Other',30,30) RETURNING id`,
        [org, f.user.id],
      )
    ).rows[0]?.id
    const id = (
      await target.pool.query(
        `INSERT INTO bookings(organization_id,event_type_id,title,start_at,end_at,source)
      VALUES($1,$2,'Other','2041-01-01T09:00Z','2041-01-01T09:45Z','web') RETURNING id`,
        [org, event],
      )
    ).rows[0]?.id
    await target.pool.query('INSERT INTO booking_hosts(booking_id,user_id) VALUES($1,$2)', [
      id,
      f.user.id,
    ])
    const preview = await repreview(f, snapshot)
    expect(preview.blocked).toBe(false)
    expect(preview.impacts).toContainEqual({
      code: 'buffer_impact',
      sourceBookingId: 1000,
      relatedId: id,
    })
    expect(preview.impacts).toContainEqual({
      code: 'daily_count',
      sourceBookingId: 1000,
      relatedId: 100,
      count: 1,
      limit: 1,
    })
    expect(preview.impacts.some((p) => p.code === 'daily_limit_exceeded')).toBe(false)
    const { connectionString: _connectionString, ...options } = f.input
    const state = await readTargetState(
      target.pool,
      f.input.sourceId,
      f.input.authorization,
      snapshot.cutoff,
    )
    for (const [before, after] of [
      ['r.after * 60000', '0'],
      ['r.sameEvent && day(r.start) === day(b.start)', 'day(r.start) === day(b.start)'],
    ] as const) {
      await checkSourceMutation(
        new URL('./preview.ts', import.meta.url),
        before,
        after,
        (m) => m.buildPreview as typeof buildPreview,
        (build) => {
          const result = build(snapshot, state, options)
          expect(result.impacts).toContainEqual({
            code: 'buffer_impact',
            sourceBookingId: 1000,
            relatedId: id,
          })
          expect(result.impacts).toContainEqual({
            code: 'daily_count',
            sourceBookingId: 1000,
            relatedId: 100,
            count: 1,
            limit: 1,
          })
        },
      )
    }
    const cutoff = structuredClone(snapshot)
    cutoff.cutoff = '2041-01-01T10:00:00.000Z'
    expect((await repreview(f, cutoff)).impacts).toContainEqual({
      code: 'buffer_impact',
      sourceBookingId: 1000,
      relatedId: id,
    })
    await checkSourceMutation(
      new URL('./target.ts', import.meta.url),
      "b.end_at+coalesce(et.buffer_after_minutes,0)*interval '1 minute'>$3::timestamptz",
      'b.end_at>$3::timestamptz',
      (m) => m.readTargetState as typeof readTargetState,
      async (read) => {
        const result = buildPreview(
          cutoff,
          await read(target.pool, f.input.sourceId, f.input.authorization, cutoff.cutoff),
          options,
        )
        expect(result.impacts).toContainEqual({
          code: 'buffer_impact',
          sourceBookingId: 1000,
          relatedId: id,
        })
      },
    )
  })
  it('binds each exact owner choice even when two authorized account emails match', async () => {
    const f = await setup(),
      other = await createTestUser(createDb(target.pool))
    users.push(other.id)
    await target.pool.query('UPDATE auth."user" SET email=$1 WHERE id=$2', [
      'other@example.test',
      other.id,
    ])
    const input: SourceInput = {
      ...f.input,
      selectedUserIds: [1, 2],
      authorization: {
        ...f.input.authorization,
        owners: [
          { sourceUserId: 1, targetUserId: other.id, importPersonalData: true },
          { sourceUserId: 2, targetUserId: f.user.id, importPersonalData: true },
        ],
      },
    }
    const snapshot = await extractForPreview(target.pool, input, f.snapshot.cutoff),
      state = await readTargetState(
        target.pool,
        input.sourceId,
        input.authorization,
        snapshot.cutoff,
      )
    const { connectionString: _connectionString, ...options } = input
    expect(() => buildPreview(snapshot, state, options)).toThrow('IMPORT_AUTHORIZATION_REQUIRED')
    await checkSourceMutation(
      new URL('./preview.ts', import.meta.url),
      'o.sourceUserId === u.sourceId && o.targetUserId === u.targetUserId',
      'true',
      (m) => m.buildPreview as typeof buildPreview,
      (build) => {
        expect(() => build(snapshot, state, options)).toThrow('IMPORT_AUTHORIZATION_REQUIRED')
      },
    )
  })
  it('source-copy console redaction also covers email-shaped old handles', async () => {
    const f = await setup()
    f.plan.addresses.push({
      kind: 'handle',
      sourceId: 1,
      old: 'private-old@example.test',
      proposed: 'owner',
      action: 'preserve',
    })
    expect(renderPreview(f.plan)).not.toContain('private-old@example.test')
    await checkSourceMutation(
      new URL('./operator-cli.ts', import.meta.url),
      'privateReport ? text :',
      'true ? text :',
      (m) => m.renderPreview as typeof renderPreview,
      (render) => {
        expect(render(f.plan)).not.toContain('private-old@example.test')
      },
    )
  })
  async function concurrentScheduleWrite(mutant = applyExtractedImport) {
    const f = await setup()
    const schedule = (
      await target.pool.query(
        "INSERT INTO schedules(user_id,name,time_zone,weekly_hours,is_default) VALUES($1,'Before','UTC','{}',true) RETURNING id",
        [f.user.id],
      )
    ).rows[0]?.id
    f.plan = await repreview(f)
    const writer = await target.pool.connect()
    let writerDone = false,
      blocked = false,
      pending: Promise<unknown> | undefined
    const proxy = new Proxy(target.pool, {
      get(pool, property) {
        if (property === 'connect')
          return async () => {
            const client = await pool.connect()
            return new Proxy(client, {
              get(connection, key) {
                if (key === 'query')
                  return async (text: unknown, ...values: unknown[]) => {
                    if (
                      typeof text === 'string' &&
                      text.includes('INSERT INTO booking_attendees')
                    ) {
                      pending = writer
                        .query("UPDATE schedules SET name='Concurrent change' WHERE id=$1", [
                          schedule,
                        ])
                        .then(() => {
                          writerDone = true
                        })
                      await setTimeout(75)
                      blocked = !writerDone
                    }
                    return (connection.query as (...args: unknown[]) => unknown)(text, ...values)
                  }
                const value = Reflect.get(connection, key)
                return typeof value === 'function' ? value.bind(connection) : value
              },
            })
          }
        const value = Reflect.get(pool, property)
        return typeof value === 'function' ? value.bind(pool) : value
      },
    })
    try {
      const report = await mutant(proxy, f.plan, f.input, async () => f.snapshot)
      await pending
      expect(report.status).toBe('applied')
      expect(blocked).toBe(true)
    } finally {
      await pending?.catch(() => {})
      writer.release()
      await target.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.user.id])
      users.splice(users.indexOf(f.user.id), 1)
    }
  }
  it('holds the target write barrier through every imported write', async () => {
    await concurrentScheduleWrite()
    await checkSourceMutation(
      new URL('./apply.ts', import.meta.url),
      'await client.query(`LOCK TABLE auth."user",auth.organization,auth.member, personal_organizations,profiles,schedules,schedule_overrides,event_types,event_type_hosts, bookings,booking_hosts,booking_attendees,import_sources,import_items,schema_migrations, waitlist_entries IN SHARE ROW EXCLUSIVE MODE`)',
      '{}',
      (m) => m.applyExtractedImport as typeof applyExtractedImport,
      concurrentScheduleWrite,
    )
  })
  it('refuses projected capacity before writes and permits a ledger larger than one source table', async () => {
    const f = await setup(),
      state = await readTargetState(
        target.pool,
        f.input.sourceId,
        f.input.authorization,
        f.snapshot.cutoff,
      )
    const large = {
      ...state,
      handles: Array.from({ length: 10_000 }, (_, i) => ({
        user_id: f.user.id,
        handle: `taken-${i}`,
      })),
    }
    expect(projectedTargetWithinLimits(large, f.plan.entities, f.plan.plan)).toBe(false)
    const { connectionString: _connectionString, ...options } = f.input
    expect(() => buildPreview(f.snapshot, large, options)).toThrow('IMPORT_TARGET_LIMIT')
    const ledger = {
      ...state,
      items: Array.from({ length: 10_001 }, () => ({}) as (typeof state.items)[number]),
    }
    expect(projectedTargetWithinLimits(ledger, [], f.plan.plan)).toBe(true)
    await checkSourceMutation(
      new URL('./preview.ts', import.meta.url),
      'if (!projectedTargetWithinLimits(state, entities, plan))',
      'if (false)',
      (m) => m.buildPreview as typeof buildPreview,
      (build) => {
        expect(() => build(f.snapshot, large, options)).toThrow('IMPORT_TARGET_LIMIT')
      },
    )
  })
  it('source-copy controls pin persistent mapping, tombstone and schema decisions', async () => {
    const tests: [string, string, 'source' | 'target' | 'deleted' | 'missing' | 'schema'][] = [
      ['item.source_fingerprint !== sourceHash', 'false', 'source'],
      ['item.target_fingerprint !== fingerprint(current)', 'false', 'target'],
      ['item.deleted_at || !current', 'false', 'deleted'],
      ['!expected.has(entityKey(i.entity_kind, i.source_primary_key))', 'false', 'missing'],
      ["throw new TargetRefusal('IMPORT_SCHEMA_CHANGED')", '{}', 'schema'],
    ]
    for (const [before, after, scenario] of tests) {
      const f = await setup()
      try {
        if (scenario !== 'schema') expect((await apply(f)).status).toBe('applied')
        const snapshot = structuredClone(f.snapshot)
        if (scenario === 'source') required(snapshot.tables.Booking?.[0]).title = 'Changed source'
        if (scenario === 'target')
          await target.pool.query("UPDATE event_types SET title='Edited' WHERE owner_user_id=$1", [
            f.user.id,
          ])
        if (scenario === 'deleted')
          await target.pool.query('DELETE FROM bookings WHERE organization_id=$1', [
            f.user.principal.organization.id,
          ])
        if (scenario === 'missing') snapshot.tables.Booking = []
        if (scenario === 'schema') snapshot.schemaFingerprint = 'b'.repeat(64)
        const state = await readTargetState(
          target.pool,
          f.input.sourceId,
          f.input.authorization,
          snapshot.cutoff,
        )
        const { connectionString: _connectionString, ...options } = f.input
        await checkSourceMutation(
          new URL('./preview.ts', import.meta.url),
          before,
          after,
          (m) => m.buildPreview as typeof buildPreview,
          (build) => {
            if (scenario === 'schema')
              expect(() => build(snapshot, state, options)).toThrow('IMPORT_SCHEMA_CHANGED')
            else
              expect(
                build(snapshot, state, options).entities.some(
                  (e) =>
                    e.reason ===
                    {
                      source: 'source_changed',
                      target: 'target_changed',
                      deleted: 'target_deleted',
                      missing: 'mapped_source_missing',
                    }[scenario],
                ),
              ).toBe(true)
          },
        )
      } finally {
        await target.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.user.id])
        users.splice(users.indexOf(f.user.id), 1)
      }
    }
  })
  it('source-copy controls pin explicit operator and owner choices', async () => {
    const f = await setup()
    for (const [before, mutate] of [
      [
        'a.operatorAuthorized === true',
        (a: typeof f.input.authorization) => {
          a.operatorAuthorized = false as true
        },
      ],
      [
        'o.importPersonalData === true',
        (a: typeof f.input.authorization) => {
          required(a.owners[0]).importPersonalData = false as true
        },
      ],
    ] as const) {
      const auth = structuredClone(f.input.authorization)
      mutate(auth)
      expect(validateAuthorization(auth)).toBe(false)
      await checkSourceMutation(
        new URL('./target.ts', import.meta.url),
        before,
        'true',
        (m) => m.validateAuthorization as typeof validateAuthorization,
        (valid) => {
          expect(valid(auth)).toBe(false)
        },
      )
    }
  })
  it('source-copy expiry guards fail real assertions before and after writes', async () => {
    for (const final of [false, true]) {
      const start = final
        ? Temporal.Now.instant().add({ seconds: 1 }).toString({ smallestUnit: 'millisecond' })
        : '2021-01-01T10:00:00.000Z'
      const f = await expiredFixture(start)
      if (final)
        await target.pool.query(
          `CREATE FUNCTION delay_import_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $$; CREATE TRIGGER delay_import_mutation BEFORE INSERT ON booking_attendees FOR EACH ROW EXECUTE FUNCTION delay_import_mutation()`,
        )
      try {
        await checkSourceMutation(
          new URL('./apply.ts', import.meta.url),
          final
            ? 'if (expired.rowCount)'
            : 'if (fresh.plan.bookings.some((b) => Temporal.Instant.compare(b.start, now) <= 0))',
          'if (false)',
          (m) => m.applyExtractedImport as typeof applyExtractedImport,
          async (mutant) => {
            const result = await mutant(target.pool, f.plan, f.input, async () => f.snapshot)
            expect(result).toMatchObject({
              status: 'failed',
              code: 'IMPORT_PLAN_EXPIRED',
              failures: [{ stage: final ? 'write_mappings' : 'verify_target' }],
            })
          },
        )
      } finally {
        if (final)
          await target.pool.query(
            'DROP TRIGGER delay_import_mutation ON booking_attendees; DROP FUNCTION delay_import_mutation()',
          )
        await target.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.user.id])
        users.splice(users.indexOf(f.user.id), 1)
      }
    }
  })
  it('source-copy controls prove source/target/authorization/plan/transaction/no-op guards', async () => {
    const source = new URL('./apply.ts', import.meta.url)
    const controls: [
      string,
      string,
      (f: Awaited<ReturnType<typeof setup>>, mutant: typeof applyExtractedImport) => Promise<void>,
    ][] = [
      [
        "throw new TargetRefusal('IMPORT_PLAN_INVALID')",
        '{}',
        async (f, mutant) => {
          required(f.plan.plan.bookings[0]).title = 'Changed'
          expect((await mutant(target.pool, f.plan, f.input, async () => f.snapshot)).code).toBe(
            'IMPORT_PLAN_INVALID',
          )
        },
      ],
      [
        "throw new TargetRefusal('IMPORT_SOURCE_CHANGED')",
        '{}',
        async (f, mutant) => {
          const changed = structuredClone(f.snapshot)
          required(changed.tables.Booking?.[0]).title = 'Changed'
          expect((await mutant(target.pool, f.plan, f.input, async () => changed)).code).toBe(
            'IMPORT_SOURCE_CHANGED',
          )
        },
      ],
      [
        'if (fresh.targetFingerprint !== saved.targetFingerprint)',
        'if (false)',
        async (f, mutant) => {
          await target.pool.query(
            "INSERT INTO profiles(user_id,handle,time_zone) VALUES($1,'target-change','UTC')",
            [f.user.id],
          )
          expect((await mutant(target.pool, f.plan, f.input, async () => f.snapshot)).code).toBe(
            'IMPORT_TARGET_CHANGED',
          )
        },
      ],
      [
        'if (saved.blocked)',
        'if (false)',
        async (f, mutant) => {
          f.plan.blocked = true
          const { planFingerprint: _hash, ...rest } = f.plan
          f.plan.planFingerprint = fingerprint(rest)
          expect((await mutant(target.pool, f.plan, f.input, async () => f.snapshot)).code).toBe(
            'IMPORT_PREVIEW_BLOCKED',
          )
        },
      ],
      [
        'allMappingsUnchanged(fresh, state)',
        'false',
        async (f, mutant) => {
          expect((await apply(f)).status).toBe('applied')
          expect((await mutant(target.pool, f.plan, f.input, async () => f.snapshot)).status).toBe(
            'noop',
          )
        },
      ],
      [
        "remember('schedule', s.sourceId, id, s.sourceUserId)",
        "remember('schedule', s.sourceId, id, s.sourceUserId); await client.query('COMMIT'); await client.query('BEGIN')",
        async (f, mutant) => {
          await target.pool.query(
            `CREATE FUNCTION fail_import_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER fail_import_mutation BEFORE INSERT ON booking_attendees FOR EACH ROW EXECUTE FUNCTION fail_import_mutation()`,
          )
          try {
            await mutant(target.pool, f.plan, f.input, async () => f.snapshot)
            expect(await businessCounts(f.user.id)).toEqual(empty)
          } finally {
            await target.pool.query(
              'DROP TRIGGER fail_import_mutation ON booking_attendees; DROP FUNCTION fail_import_mutation()',
            )
          }
        },
      ],
    ]
    for (const [before, after, assertion] of controls) {
      const f = await setup()
      try {
        await checkSourceMutation(
          source,
          before,
          after,
          (m) => m.applyExtractedImport as typeof applyExtractedImport,
          (mutant) => assertion(f, mutant),
        )
      } finally {
        await target.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.user.id])
        users.splice(users.indexOf(f.user.id), 1)
      }
    }
  }, 60_000)
})
