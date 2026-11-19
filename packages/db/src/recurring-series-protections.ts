import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'
import { insertRecord, type Sql, transaction } from './group-seats-fixtures.ts'
import { reuseConnectionsAfterErrors } from './testing.ts'

const times = [
  { local: '2032-01-05T09:00:00+00:00', start: '2032-01-05T09:00Z', end: '2032-01-05T09:30Z' },
  { local: '2032-01-12T09:00:00+00:00', start: '2032-01-12T09:00Z', end: '2032-01-12T09:30Z' },
] as const

interface Tenant {
  organization: string
  event: string
}

async function accepted<T>(write: Promise<T>, description?: string): Promise<T> {
  await expect(write, description).resolves.not.toBeInstanceOf(Error)
  return write
}

async function createTenant(pool: pg.Pool): Promise<Tenant> {
  const result = await accepted(
    pool.query<{ id: string }>(
      `INSERT INTO auth.organization (name, slug, "createdAt")
       VALUES ('Recurring series team', $1, now()) RETURNING id`,
      [`series-${randomUUID()}`],
    ),
  )
  const id = result.rows[0]?.id as string
  const event = await accepted(
    insertRecord(pool, 'event_types', {
      organization_id: id,
      slug: 'consultation',
      title: 'Recurring consultation',
      duration_minutes: 30,
    }),
  )
  return { organization: id, event }
}

function insertBooking(
  sql: Sql,
  tenant: Tenant,
  timing: (typeof times)[number],
  overrides: Record<string, unknown> = {},
) {
  return insertRecord(sql, 'bookings', {
    organization_id: tenant.organization,
    event_type_id: tenant.event,
    start_at: timing.start,
    end_at: timing.end,
    title: 'Recurring consultation',
    source: 'web',
    ...overrides,
  })
}

function insertSeries(sql: Sql, tenant: Tenant, overrides: Record<string, unknown> = {}) {
  return insertRecord(sql, 'booking_series', {
    organization_id: tenant.organization,
    event_type_id: tenant.event,
    original_event_type_id: tenant.event,
    rule_pattern: 'weekly',
    time_zone: 'UTC',
    first_local_start: times[0].local,
    requested_count: 2,
    duration_minutes: 30,
    notification_snapshot: { invitee: true },
    host_policy_snapshot: { type: 'individual' },
    ...overrides,
  })
}

function insertOccurrence(
  sql: Sql,
  tenant: Tenant,
  series: string,
  root: string,
  timing: (typeof times)[number],
  overrides: Record<string, unknown> = {},
) {
  return insertRecord(sql, 'booking_series_occurrences', {
    organization_id: tenant.organization,
    series_id: series,
    ordinal: timing === times[0] ? 1 : 2,
    original_local_start: timing.local,
    start_at: timing.start,
    end_at: timing.end,
    root_booking_id: root,
    ...overrides,
  })
}

async function createSeries(
  pool: pg.Pool,
  tenant: Tenant,
  overrides: Record<string, unknown> = {},
) {
  return accepted(
    transaction(pool, async (sql) => {
      const series = await accepted(insertSeries(sql, tenant, overrides))
      const members = []
      for (const timing of times) {
        const root = randomUUID()
        const occurrence = await accepted(insertOccurrence(sql, tenant, series, root, timing))
        await accepted(
          insertBooking(sql, tenant, timing, { id: root, series_occurrence_id: occurrence }),
        )
        members.push({ root, occurrence })
      }
      const [first, second] = members
      if (!first || !second) throw new Error('The series fixture requires two members')
      return { series, first, second }
    }),
  )
}

/** Allows testing a statement separately from its deferred commit checks. */
async function rolledBack(pool: pg.Pool, check: (client: pg.PoolClient) => Promise<void>) {
  const client = await pool.connect()
  try {
    await accepted(client.query('BEGIN'))
    await check(client)
  } finally {
    try {
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  }
}

const checkViolation = { code: '23514' }
const foreignKeyViolation = { code: '23503' }
const uniqueViolation = { code: '23505' }
const cancelled = { status: 'cancelled', cancelled_at: times[0].start }

export async function assertSeriesScope(database: pg.Pool) {
  const pool = reuseConnectionsAfterErrors(database)
  const tenant = await createTenant(pool)
  const otherTenant = await createTenant(pool)
  const { series, first, second } = await createSeries(pool, tenant)

  await rolledBack(pool, async (sql) => {
    await expect(
      insertSeries(sql, tenant, {
        event_type_id: otherTenant.event,
        original_event_type_id: otherTenant.event,
      }),
      'series event must belong to its organization',
    ).rejects.toMatchObject(foreignKeyViolation)
  })
  await rolledBack(pool, async (sql) => {
    await expect(
      insertOccurrence(sql, otherTenant, series, randomUUID(), times[1], { ordinal: 3 }),
      'occurrence must belong to a series in its own organization',
    ).rejects.toMatchObject(foreignKeyViolation)
  })
  await expect(
    insertBooking(pool, otherTenant, times[0], {
      series_occurrence_id: first.occurrence,
      ...cancelled,
    }),
    'booking must belong to an occurrence in its own organization',
  ).rejects.toMatchObject(foreignKeyViolation)
  await expect(
    insertBooking(pool, tenant, times[0], {
      series_occurrence_id: first.occurrence,
      rescheduled_from_id: second.root,
      ...cancelled,
    }),
    'a series successor cannot reference a predecessor from another occurrence',
  ).rejects.toMatchObject(checkViolation)
  await expect(
    insertBooking(pool, tenant, times[0], { rescheduled_from_id: first.root }),
    'a series successor cannot omit the occurrence',
  ).rejects.toMatchObject({ ...checkViolation, constraint: 'bookings_series_predecessor_check' })

  const otherRoot = await accepted(insertBooking(pool, otherTenant, times[0]))
  const ordinaryRoot = await accepted(insertBooking(pool, tenant, times[0]))
  for (const [root, violation] of [
    [otherRoot, { ...foreignKeyViolation, constraint: 'booking_series_occurrences_root_fkey' }],
    [ordinaryRoot, { ...checkViolation, constraint: 'booking_series_root_ownership' }],
  ] as const) {
    await rolledBack(pool, async (sql) => {
      const draft = await accepted(insertSeries(sql, tenant))
      await accepted(insertOccurrence(sql, tenant, draft, root, times[0]))
      const secondRoot = randomUUID()
      const occurrence = await accepted(insertOccurrence(sql, tenant, draft, secondRoot, times[1]))
      await accepted(
        insertBooking(sql, tenant, times[1], { id: secondRoot, series_occurrence_id: occurrence }),
      )
      await expect(
        sql.query('COMMIT'),
        'roots must belong to their own occurrence',
      ).rejects.toMatchObject(violation)
    })
  }

  await rolledBack(pool, async (sql) => {
    await accepted(sql.query('DELETE FROM bookings WHERE id = $1', [first.root]))
    await accepted(insertBooking(sql, tenant, times[0], { id: first.root }))
    await expect(
      sql.query('COMMIT'),
      'a root cannot be replaced by an ordinary booking with the same ID',
    ).rejects.toMatchObject({ ...checkViolation, constraint: 'booking_series_root_ownership' })
  })

  await rolledBack(pool, async (sql) => {
    const draft = await accepted(insertSeries(sql, tenant))
    const root = randomUUID()
    const occurrence = await accepted(insertOccurrence(sql, tenant, draft, root, times[0]))
    await expect(
      sql.query(
        `INSERT INTO bookings
           (id, organization_id, event_type_id, start_at, end_at, title, source,
            rescheduled_from_id, series_occurrence_id)
         VALUES (uuidv7(), $1, $2, $3, $4, 'Ordinary successor', 'web', $5, NULL),
                ($5, $1, $2, $3, $4, 'Series root', 'web', NULL, $6)`,
        [tenant.organization, tenant.event, times[0].start, times[0].end, root, occurrence],
      ),
      'a successor cannot omit the occurrence when inserted before the root in the same statement',
    ).rejects.toMatchObject({ ...checkViolation, constraint: 'bookings_series_predecessor_check' })
  })
}

async function cancel(sql: Sql, id: string) {
  await accepted(
    sql.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [id]),
  )
}

export async function assertSeriesOrdinals(database: pg.Pool) {
  const pool = reuseConnectionsAfterErrors(database)
  const tenant = await createTenant(pool)
  const { series, first } = await createSeries(pool, tenant)

  await rolledBack(pool, async (sql) => {
    await expect(
      insertOccurrence(sql, tenant, series, randomUUID(), times[0]),
      'ordinals are unique within a series',
    ).rejects.toMatchObject(uniqueViolation)
  })
  await rolledBack(pool, async (sql) => {
    await expect(
      insertOccurrence(sql, tenant, series, first.root, times[1], { ordinal: 3 }),
      'a booking can root only one occurrence',
    ).rejects.toMatchObject(uniqueViolation)
  })
  const successor = await accepted(
    transaction(pool, async (sql) => {
      await cancel(sql, first.root)
      return accepted(
        insertBooking(sql, tenant, times[1], {
          series_occurrence_id: first.occurrence,
          rescheduled_from_id: first.root,
        }),
      )
    }),
  )
  await expect(
    insertBooking(pool, tenant, times[1], {
      series_occurrence_id: first.occurrence,
      rescheduled_from_id: first.root,
    }),
    'only one confirmed version can own an occurrence',
  ).rejects.toMatchObject(uniqueViolation)

  const history = await accepted(
    pool.query('SELECT id, status FROM bookings WHERE series_occurrence_id = $1 ORDER BY status', [
      first.occurrence,
    ]),
  )
  expect(history.rows).toEqual([
    { id: first.root, status: 'cancelled' },
    { id: successor, status: 'confirmed' },
  ])
}

export async function assertSeriesCompleteness(pool: pg.Pool) {
  const tenant = await createTenant(pool)
  for (const changeId of [false, true]) {
    await rolledBack(pool, async (sql) => {
      const id = await accepted(insertSeries(sql, tenant))
      if (changeId)
        await accepted(sql.query('UPDATE booking_series SET id = uuidv7() WHERE id = $1', [id]))
      await expect(
        sql.query('COMMIT'),
        'an incomplete series must fail at commit',
      ).rejects.toMatchObject({
        ...checkViolation,
        constraint: 'booking_series_occurrence_count',
      })
    })
  }

  const { first } = await createSeries(pool, tenant)
  await rolledBack(pool, async (sql) => {
    await accepted(sql.query('DELETE FROM bookings WHERE id = $1', [first.root]))
    await accepted(
      sql.query('DELETE FROM booking_series_occurrences WHERE id = $1', [first.occurrence]),
    )
    await expect(
      sql.query('COMMIT'),
      'an existing series cannot lose an occurrence',
    ).rejects.toMatchObject({
      ...checkViolation,
      constraint: 'booking_series_occurrence_count',
    })
  })
}

async function eventRecurrence(pool: pg.Pool, tenant: Tenant) {
  const recurrence = {
    timeZone: 'America/New_York',
    allowedPatterns: ['weekly'],
    maxOccurrences: 12,
  }
  const update = (value: unknown) =>
    pool.query('UPDATE event_types SET recurrence = $2 WHERE id = $1 RETURNING recurrence', [
      tenant.event,
      JSON.stringify(value),
    ])
  const defaults = await accepted(
    pool.query('SELECT recurrence, recurrence_revision FROM event_types WHERE id = $1', [
      tenant.event,
    ]),
  )
  expect(defaults.rows).toEqual([{ recurrence: null, recurrence_revision: '0' }])
  const valid = await accepted(update(recurrence))
  expect(valid.rows).toEqual([{ recurrence }])

  for (const invalid of [
    null,
    [],
    {},
    { ...recurrence, timeZone: '' },
    { ...recurrence, allowedPatterns: [] },
    { ...recurrence, allowedPatterns: ['weekly', 'weekly'] },
    { ...recurrence, allowedPatterns: ['daily'] },
    { ...recurrence, maxOccurrences: 1 },
    { ...recurrence, maxOccurrences: 13 },
    { ...recurrence, maxOccurrences: 2.5 },
    { ...recurrence, unexpected: true },
  ]) {
    await expect(update(invalid), JSON.stringify(invalid)).rejects.toMatchObject({
      ...checkViolation,
      constraint: 'event_types_recurrence_check',
    })
  }
  await expect(
    pool.query('UPDATE event_types SET recurrence_revision = -1 WHERE id = $1', [tenant.event]),
  ).rejects.toMatchObject({
    ...checkViolation,
    constraint: 'event_types_recurrence_revision_check',
  })
  await expect(
    pool.query('UPDATE event_types SET recurrence_revision = NULL WHERE id = $1', [tenant.event]),
  ).rejects.toMatchObject({ code: '23502', column: 'recurrence_revision' })
}

async function seriesFields(pool: pg.Pool, tenant: Tenant) {
  for (const [check, field, value] of [
    ['rule_version_check', 'rule_version', 0],
    ['rule_check', 'rule_pattern', 'daily'],
    ['rule_check', 'rule_pattern', 'monthly_weekday'],
    ['rule_check', 'rule_ordinal', 1],
    ['time_zone_check', 'time_zone', ' '],
    ['first_local_start_check', 'first_local_start', 'infinity'],
    ['requested_count_check', 'requested_count', 1],
    ['requested_count_check', 'requested_count', 13],
    ['duration_minutes_check', 'duration_minutes', 0],
    ['notification_snapshot_check', 'notification_snapshot', '[]'],
    ['host_policy_snapshot_check', 'host_policy_snapshot', '[]'],
    ['manage_token_hash_check', 'manage_token_hash', Buffer.alloc(31)],
    ['revision_check', 'revision', 0],
    ['original_event_check', 'original_event_type_id', randomUUID()],
  ] as const) {
    await rolledBack(pool, async (sql) => {
      await expect(insertSeries(sql, tenant, { [field]: value }), field).rejects.toMatchObject({
        ...checkViolation,
        constraint: `booking_series_${check}`,
      })
    })
  }

  await rolledBack(pool, async (sql) => {
    await accepted(
      insertSeries(sql, tenant, {
        rule_pattern: 'monthly_weekday',
        rule_ordinal: -1,
        rule_weekday: 1,
      }),
    )
  })

  const digest = Buffer.alloc(32, 1)
  const { series } = await createSeries(pool, tenant, { manage_token_hash: digest })
  const row = await accepted(
    pool.query(
      `SELECT uuid_extract_version(id) AS version, rule_version, revision,
              created_at IS NOT NULL AND updated_at = created_at AS timestamps
       FROM booking_series WHERE id = $1`,
      [series],
    ),
  )
  expect(row.rows).toEqual([{ version: 7, rule_version: 1, revision: '1', timestamps: true }])
  await rolledBack(pool, async (sql) => {
    await expect(insertSeries(sql, tenant, { manage_token_hash: digest })).rejects.toMatchObject({
      ...uniqueViolation,
      constraint: 'booking_series_manage_token_hash_key',
    })
  })

  const otherTenant = await createTenant(pool)
  await rolledBack(pool, async (sql) => {
    await expect(insertSeries(sql, otherTenant, { id: series })).rejects.toMatchObject({
      ...uniqueViolation,
      constraint: 'booking_series_pkey',
    })
  })

  for (const column of [
    'organization_id',
    'original_event_type_id',
    'rule_version',
    'rule_pattern',
    'time_zone',
    'first_local_start',
    'requested_count',
    'duration_minutes',
    'notification_snapshot',
    'host_policy_snapshot',
    'revision',
    'created_at',
    'updated_at',
  ]) {
    await rolledBack(pool, async (sql) => {
      await expect(insertSeries(sql, tenant, { [column]: null }), column).rejects.toMatchObject({
        code: '23502',
        column,
      })
    })
  }

  await rolledBack(pool, async (sql) => {
    const missing = { ...tenant, organization: randomUUID() }
    await expect(insertSeries(sql, missing, { event_type_id: null })).rejects.toMatchObject({
      ...foreignKeyViolation,
      constraint: 'booking_series_organization_id_fkey',
    })
  })
}

async function occurrenceFields(pool: pg.Pool, tenant: Tenant) {
  const { series, first } = await createSeries(pool, tenant)
  for (const [check, overrides] of [
    ['ordinal_check', { ordinal: 0 }],
    ['ordinal_check', { ordinal: 13 }],
    ['original_local_start_check', { original_local_start: 'infinity' }],
    ['interval_check', { start_at: '-infinity' }],
    ['interval_check', { end_at: 'infinity' }],
    ['interval_check', { end_at: times[0].start }],
  ] as const) {
    await rolledBack(pool, async (sql) => {
      await expect(
        insertOccurrence(sql, tenant, series, randomUUID(), times[0], { ordinal: 3, ...overrides }),
      ).rejects.toMatchObject({
        ...checkViolation,
        constraint: `booking_series_occurrences_${check}`,
      })
    })
  }
  for (const column of [
    'organization_id',
    'series_id',
    'ordinal',
    'original_local_start',
    'start_at',
    'end_at',
    'root_booking_id',
  ]) {
    await rolledBack(pool, async (sql) => {
      await expect(
        insertOccurrence(sql, tenant, series, randomUUID(), times[0], {
          ordinal: 3,
          [column]: null,
        }),
        column,
      ).rejects.toMatchObject({ code: '23502', column })
    })
  }

  const otherTenant = await createTenant(pool)
  const sibling = await createSeries(pool, otherTenant)
  await rolledBack(pool, async (sql) => {
    await expect(
      insertOccurrence(sql, otherTenant, sibling.series, randomUUID(), times[0], {
        id: first.occurrence,
        ordinal: 3,
      }),
    ).rejects.toMatchObject({ ...uniqueViolation, constraint: 'booking_series_occurrences_pkey' })
  })
}

async function seriesLifecycle(pool: pg.Pool, tenant: Tenant) {
  const { series, first } = await createSeries(pool, tenant)
  await expect(
    pool.query(
      'UPDATE booking_series SET event_type_id = NULL, original_event_type_id = $2 WHERE id = $1',
      [series, randomUUID()],
    ),
  ).rejects.toMatchObject({
    ...checkViolation,
    constraint: 'booking_series_original_event_immutable',
  })
  await expect(
    pool.query('UPDATE booking_series_occurrences SET ordinal = 3 WHERE id = $1', [
      first.occurrence,
    ]),
  ).rejects.toMatchObject({ ...checkViolation, constraint: 'booking_series_occurrences_immutable' })
  await expect(
    pool.query('UPDATE bookings SET series_occurrence_id = NULL WHERE id = $1', [first.root]),
  ).rejects.toMatchObject({ ...checkViolation, constraint: 'bookings_series_membership_immutable' })
  await expect(
    insertBooking(pool, tenant, times[0], {
      ...cancelled,
      series_occurrence_id: first.occurrence,
    }),
  ).rejects.toMatchObject({ ...checkViolation, constraint: 'bookings_series_root_check' })
  await expect(
    insertBooking(pool, tenant, times[0], {
      series_occurrence_id: first.occurrence,
      rescheduled_from_id: first.root,
      status: 'pending_payment',
      payment_hold_expires_at: times[0].start,
    }),
  ).rejects.toMatchObject({ ...checkViolation, constraint: 'bookings_series_member_check' })

  const freshness = await accepted(
    pool.query(
      `UPDATE booking_series SET revision = revision + 1, updated_at = '2000-01-01T00:00Z'
       WHERE id = $1 RETURNING revision, updated_at > '2000-01-01T00:00Z' AS refreshed`,
      [series],
    ),
  )
  expect(freshness.rows).toEqual([{ revision: '2', refreshed: true }])

  await accepted(
    transaction(pool, async (sql) => {
      await cancel(sql, first.root)
      await accepted(
        insertBooking(sql, tenant, times[1], {
          series_occurrence_id: first.occurrence,
          rescheduled_from_id: first.root,
        }),
      )
    }),
  )
  await accepted(pool.query('DELETE FROM event_types WHERE id = $1', [tenant.event]))
  const retained = await accepted(
    pool.query(
      `SELECT s.event_type_id, s.original_event_type_id, b.event_type_id AS booking_event_type_id
       FROM booking_series s JOIN booking_series_occurrences o ON o.series_id = s.id
       JOIN bookings b ON b.id = o.root_booking_id WHERE s.id = $1 ORDER BY o.ordinal`,
      [series],
    ),
  )
  expect(retained.rows).toEqual(
    Array.from({ length: 2 }, () => ({
      event_type_id: null,
      original_event_type_id: tenant.event,
      booking_event_type_id: null,
    })),
  )
  await accepted(pool.query('DELETE FROM auth.organization WHERE id = $1', [tenant.organization]))
  const remaining = await accepted(
    pool.query(
      `SELECT (SELECT count(*)::int FROM booking_series WHERE organization_id = $1) AS series,
              (SELECT count(*)::int FROM booking_series_occurrences WHERE organization_id = $1) AS occurrences,
              (SELECT count(*)::int FROM bookings WHERE organization_id = $1) AS bookings`,
      [tenant.organization],
    ),
  )
  expect(remaining.rows).toEqual([{ series: 0, occurrences: 0, bookings: 0 }])
}

async function supportingIndexes(pool: pg.Pool) {
  const indexes = await accepted(
    pool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND
       indexname IN ('booking_series_event_type', 'bookings_series_occurrence') ORDER BY indexname`,
    ),
  )
  expect(indexes.rows).toEqual([
    {
      indexname: 'booking_series_event_type',
      indexdef:
        'CREATE INDEX booking_series_event_type ON public.booking_series USING btree (event_type_id) WHERE (event_type_id IS NOT NULL)',
    },
    {
      indexname: 'bookings_series_occurrence',
      indexdef:
        'CREATE INDEX bookings_series_occurrence ON public.bookings USING btree (series_occurrence_id) WHERE (series_occurrence_id IS NOT NULL)',
    },
  ])
}

export async function assertRecurringSeriesProtections(pool: pg.Pool) {
  await assertSeriesScope(pool)
  await assertSeriesOrdinals(pool)
  await assertSeriesCompleteness(pool)
  const tenant = await createTenant(pool)
  await eventRecurrence(pool, tenant)
  await seriesFields(pool, tenant)
  await occurrenceFields(pool, tenant)
  await seriesLifecycle(pool, tenant)
  await supportingIndexes(pool)
}
