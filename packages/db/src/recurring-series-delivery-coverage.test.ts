import { createHash, createHmac, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRecord } from './group-seats-fixtures.ts'
import { createSeries, createTenant } from './recurring-series-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import { createTestDatabase, reuseConnectionsAfterErrors, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0127_recurring_series_delivery.sql'
const fkViolation = { code: '23503' }
const uniqueViolation = { code: '23505' }
const checkViolation = { code: '23514' }
const seriesReceipts = 'booking_series_receipts'
const seriesNotifications = 'booking_series_notifications'
const seriesAdmissions = 'booking_series_admissions'
const sentAt = '2026-03-06T10:00:00Z'

function digest(value: string) {
  return createHash('sha256').update(value).digest()
}

const actorDigest = createHmac('sha256', 'test-admission-digest-key').update('192.0.2.27').digest()

async function accepted<T>(write: Promise<T>, description?: string): Promise<T> {
  await expect(write, description).resolves.not.toBeInstanceOf(Error)
  return write
}

async function fixture(pool: pg.Pool) {
  const tenant = await createTenant(pool)
  const { series, first, second } = await createSeries(pool, tenant)
  const ownership = { organization_id: tenant.organization, series_id: series }
  const recipient = randomUUID()
  return {
    ...tenant,
    series,
    first,
    second,
    receipt: {
      ...ownership,
      operation_kind: 'create',
      authority_scope: digest('creation scope'),
      idempotency_key: digest('creation key'),
      fingerprint: digest('creation fingerprint'),
      affected_occurrence_ids: [first.occurrence, second.occurrence],
      result_booking_ids: [first.root, second.root],
    },
    notification: {
      ...ownership,
      row_type: 'receipt',
      kind: 'confirmation',
      sequence: 1,
      recipient_role: 'booker',
      recipient_id: recipient,
      capability_scope: 'manage',
      manage_token_hash: digest(series),
      outcome: 'delivered',
      sent_at: sentAt,
      reported_ordinals: [1, 2],
      reported_link_states: ['pending', 'ready'],
    },
    outbox: {
      ...ownership,
      row_type: 'outbox',
      kind: 'confirmation',
      sequence: 1,
      due_at: sentAt,
      attempts: 0,
      outbox_state: 'pending',
    },
    link: {
      recipient_role: 'booker',
      recipient_id: recipient,
    },
    admission: {
      organization_id: tenant.organization,
      event_type_id: tenant.event,
      actor_digest: actorDigest,
    },
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
type Overrides = Record<string, unknown>

function writes(pool: pg.Pool, f: Fixture) {
  return {
    receipt: (values?: Overrides) =>
      insertRecord(pool, seriesReceipts, { ...f.receipt, ...values }),
    notification: (values?: Overrides) =>
      insertRecord(pool, seriesNotifications, { ...f.notification, ...values }),
    outbox: (values?: Overrides) =>
      insertRecord(pool, seriesNotifications, { ...f.outbox, ...values }),
    admission: (values?: Overrides) =>
      insertRecord(pool, seriesAdmissions, { ...f.admission, ...values }),
  }
}

async function assertUniqueness(pool: pg.Pool, f: Fixture, other: Fixture) {
  const { receipt, notification, outbox } = writes(pool, f)
  const receiptId = await accepted(receipt())
  await expect(
    receipt({ fingerprint: digest('changed request for original key') }),
    'a changed fingerprint must conflict on the same receipt key',
  ).rejects.toMatchObject(uniqueViolation)
  await accepted(receipt({ operation_kind: 'bulk_cancel' }))
  await accepted(receipt({ authority_scope: digest('another authority') }))
  await accepted(
    writes(pool, other).receipt({
      idempotency_key: f.receipt.idempotency_key,
    }),
  )
  await expect(
    receipt({ id: receiptId, idempotency_key: digest('unused receipt key') }),
    'receipt primary key',
  ).rejects.toMatchObject(uniqueViolation)

  const notificationId = await accepted(notification())
  const alternateDigest = digest('another manage digest')
  await expect(
    notification({ manage_token_hash: alternateDigest }),
    'a recipient receives one receipt per series action',
  ).rejects.toMatchObject(uniqueViolation)
  await expect(
    notification({ sequence: 2 }),
    'a manage digest identifies one notification',
  ).rejects.toMatchObject(uniqueViolation)
  await expect(
    notification({ id: notificationId, sequence: 2, manage_token_hash: alternateDigest }),
    'notification primary key',
  ).rejects.toMatchObject(uniqueViolation)
  await accepted(notification({ sequence: 2, manage_token_hash: alternateDigest }))
  await accepted(
    notification({
      recipient_role: 'guest',
      capability_scope: 'read',
      manage_token_hash: digest('guest read digest'),
    }),
  )

  await accepted(outbox())
  await expect(outbox(), 'one outbox row per aggregate action').rejects.toMatchObject(
    uniqueViolation,
  )
  await accepted(outbox({ kind: 'cancellation' }))
  const link = { ...f.link, kind: 'link_update' }
  await accepted(outbox({ ...link, sequence: 1, outbox_state: 'done' }))
  await expect(
    outbox({ ...link, sequence: 1, outbox_state: 'exhausted' }),
    'one persisted link update per series, recipient and sequence',
  ).rejects.toMatchObject(uniqueViolation)
  await accepted(outbox({ ...link, sequence: 2 }))
  await expect(
    outbox({ ...link, sequence: 3 }),
    'a recipient can have only one pending link update',
  ).rejects.toMatchObject(uniqueViolation)
  await accepted(outbox({ ...link, recipient_id: randomUUID(), sequence: 2 }))
}

async function assertOrganizationScope(pool: pg.Pool, f: Fixture, other: Fixture) {
  const { receipt, notification, outbox, admission } = writes(pool, f)
  await expect(
    receipt({
      series_id: other.series,
      affected_occurrence_ids: [],
      result_booking_ids: [],
    }),
    'receipt series must belong to its organization even for an action with an empty result',
  ).rejects.toMatchObject(fkViolation)
  await expect(
    notification({ series_id: other.series }),
    'notification receipt series must belong to its organization',
  ).rejects.toMatchObject(fkViolation)
  await expect(
    outbox({ series_id: other.series }),
    'notification outbox series must belong to its organization',
  ).rejects.toMatchObject(fkViolation)
  await expect(
    admission({ event_type_id: other.event }),
    'admission event must belong to its organization',
  ).rejects.toMatchObject(fkViolation)
  await expect(
    receipt({ affected_occurrence_ids: [other.first.occurrence, f.second.occurrence] }),
    'receipt occurrence must belong to its series',
  ).rejects.toMatchObject(checkViolation)
  await expect(
    receipt({ result_booking_ids: [other.first.root, f.second.root] }),
    'receipt booking must belong to its series',
  ).rejects.toMatchObject(checkViolation)
}

async function assertRejectedFields(
  write: (values: Overrides) => Promise<string>,
  invalid: ReadonlyArray<readonly [string, unknown]>,
) {
  for (const [field, value] of invalid) {
    await expect(write({ [field]: value }), field).rejects.toMatchObject(checkViolation)
  }
}

async function assertNotNull(
  write: (values: Overrides) => Promise<string>,
  columns: readonly string[],
) {
  for (const column of columns) {
    await expect(write({ [column]: null }), column).rejects.toMatchObject({
      code: '23502',
      column,
    })
  }
}

async function assertReceiptFields(pool: pg.Pool, f: Fixture) {
  const { receipt } = writes(pool, f)
  await assertRejectedFields(receipt, [
    ['operation_kind', 'reschedule'],
    ['authority_scope', Buffer.from('192.0.2.27')],
    ['idempotency_key', Buffer.from('raw-idempotency-key-test-marker')],
    ['fingerprint', Buffer.alloc(31)],
    ['affected_occurrence_ids', Array.from({ length: 13 }, () => f.first.occurrence)],
    ['result_booking_ids', Array.from({ length: 13 }, () => f.first.root)],
  ])
  await assertNotNull(receipt, [
    'organization_id',
    'series_id',
    'operation_kind',
    'authority_scope',
    'idempotency_key',
    'fingerprint',
    'affected_occurrence_ids',
    'result_booking_ids',
    'created_at',
  ])
  const id = await accepted(receipt())
  await expect(
    pool.query('UPDATE booking_series_receipts SET result_booking_ids = $2 WHERE id = $1', [
      id,
      [randomUUID()],
    ]),
    'changing a receipt result cannot link it to a different booking',
  ).rejects.toMatchObject(checkViolation)
}

async function assertNotificationFields(pool: pg.Pool, f: Fixture) {
  const { notification, outbox } = writes(pool, f)
  const noCapability = { capability_scope: null, manage_token_hash: null }
  const noReport = { sent_at: null, reported_ordinals: null, reported_link_states: null }
  const suppressed = {
    ...noReport,
    outcome: 'suppressed',
    suppression_reason: 'recipient_daily_limit',
  }
  await assertRejectedFields(notification, [
    ['row_type', 'mail'],
    ['kind', 'reminder'],
    ['sequence', 0],
    ['recipient_id', null],
    ['manage_token_hash', Buffer.from('raw-manage-token-test-marker')],
    ['sent_at', null],
    ['reported_ordinals', [0, 2]],
    ['reported_link_states', ['raw-link-test-marker', 'ready']],
    ['due_at', sentAt],
  ])
  await assertNotNull(notification, [
    'organization_id',
    'series_id',
    'row_type',
    'kind',
    'sequence',
  ])
  await assertRejectedFields(outbox, [
    ['due_at', null],
    ['attempts', -1],
    ['outbox_state', 'delivered'],
    ['outcome', 'delivered'],
    ['lease_until', sentAt],
  ])
  await expect(
    notification({ ...noCapability, recipient_role: 'observer' }),
    'recipient role must be booker, guest or host',
  ).rejects.toMatchObject(checkViolation)
  await expect(
    notification({ ...noCapability, ...noReport, outcome: 'pending' }),
    'a receipt records a terminal outcome',
  ).rejects.toMatchObject(checkViolation)
  await expect(
    notification({ recipient_role: 'guest', capability_scope: 'manage' }),
    'a guest notification cannot grant the booker capability',
  ).rejects.toMatchObject(checkViolation)
  await expect(
    notification(suppressed),
    'a suppressed notification cannot retain a manage digest',
  ).rejects.toMatchObject(checkViolation)
  await expect(
    notification({ ...suppressed, ...noCapability, suppression_reason: null }),
    'a suppressed notification records a budget reason',
  ).rejects.toMatchObject(checkViolation)
  await expect(
    notification({ ...suppressed, ...noCapability, suppression_reason: 'wrong_reason' }),
    'suppression reasons come from the mail budget',
  ).rejects.toMatchObject(checkViolation)
  await accepted(notification({ ...suppressed, ...noCapability }))
  await expect(
    outbox({ kind: 'link_update' }),
    'a link update outbox row must identify its recipient',
  ).rejects.toMatchObject(checkViolation)
  await expect(
    outbox(f.link),
    'an aggregate confirmation outbox row fans out to all recipients',
  ).rejects.toMatchObject(checkViolation)
}

async function assertAdmissionFields(pool: pg.Pool, f: Fixture) {
  const { admission } = writes(pool, f)
  const id = await accepted(admission())
  await accepted(admission())
  await expect(admission({ id }), 'admission primary key').rejects.toMatchObject(uniqueViolation)
  await assertRejectedFields(admission, [
    ['actor_digest', Buffer.from('192.0.2.27')],
    ['admitted_at', 'infinity'],
  ])
  await assertNotNull(admission, [
    'organization_id',
    'event_type_id',
    'actor_digest',
    'admitted_at',
  ])
}

async function assertIndexes(pool: pg.Pool) {
  const indexes = await accepted(
    pool.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN (
        'booking_series_admissions_actor', 'booking_series_admissions_age',
        'booking_series_notifications_due', 'booking_series_receipts_series'
      ) ORDER BY indexname
    `),
  )
  expect(indexes.rows).toEqual([
    {
      indexname: 'booking_series_admissions_actor',
      indexdef:
        'CREATE INDEX booking_series_admissions_actor ON public.booking_series_admissions USING btree (event_type_id, actor_digest, admitted_at)',
    },
    {
      indexname: 'booking_series_admissions_age',
      indexdef:
        'CREATE INDEX booking_series_admissions_age ON public.booking_series_admissions USING btree (admitted_at, id)',
    },
    {
      indexname: 'booking_series_notifications_due',
      indexdef:
        "CREATE INDEX booking_series_notifications_due ON public.booking_series_notifications USING btree (due_at, id) WHERE (outbox_state = 'pending'::text)",
    },
    {
      indexname: 'booking_series_receipts_series',
      indexdef:
        'CREATE INDEX booking_series_receipts_series ON public.booking_series_receipts USING btree (series_id)',
    },
  ])
}

async function assertRetention(pool: pg.Pool, f: Fixture) {
  const { receipt, notification, outbox, admission } = writes(pool, f)
  await accepted(receipt())
  await accepted(notification())
  await accepted(outbox())
  await accepted(admission())
  const counts = () =>
    pool.query(
      `SELECT (SELECT count(*)::int FROM booking_series_receipts WHERE organization_id = $1) AS receipts,
              (SELECT count(*)::int FROM booking_series_notifications WHERE organization_id = $1) AS notifications,
              (SELECT count(*)::int FROM booking_series_admissions WHERE organization_id = $1) AS admissions`,
      [f.organization],
    )
  await accepted(pool.query('DELETE FROM event_types WHERE id = $1', [f.event]))
  await expect(counts()).resolves.toMatchObject({
    rows: [{ receipts: 1, notifications: 2, admissions: 0 }],
  })
  await accepted(pool.query('DELETE FROM auth.organization WHERE id = $1', [f.organization]))
  await expect(counts()).resolves.toMatchObject({
    rows: [{ receipts: 0, notifications: 0, admissions: 0 }],
  })
}

async function assertDeliveryStorage(pool: pg.Pool) {
  const first = await fixture(pool)
  const second = await fixture(pool)
  await assertOrganizationScope(pool, first, second)
  await assertUniqueness(pool, first, second)
  const fieldFixture = await fixture(pool)
  await assertReceiptFields(pool, fieldFixture)
  await assertNotificationFields(pool, fieldFixture)
  await assertAdmissionFields(pool, fieldFixture)
  await assertIndexes(pool)
  await assertRetention(pool, await fixture(pool))
}

describe.skipIf(!serverUrl)('recurring series delivery storage', () => {
  let database: TestDatabase | undefined
  let pool: pg.Pool

  beforeAll(async () => {
    database = await createTestDatabase(serverUrl as string, undefined, { tag: 'series_delivery' })
    pool = reuseConnectionsAfterErrors(database.pool)
  })

  afterAll(async () => {
    await database?.drop()
  })

  it('deduplicates receipt keys and notification copies', async () => {
    await assertUniqueness(pool, await fixture(pool), await fixture(pool))
  })

  it('rejects cross-organization references', async () => {
    await assertOrganizationScope(pool, await fixture(pool), await fixture(pool))
  })
})

describe.skipIf(!serverUrl)('recurring series delivery constraint coverage', () => {
  it('fails a protection assertion when any 0127 object is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration,
      assertions: assertDeliveryStorage,
    })
    expect(report.problems).toEqual([])
    expect(report.results.filter(({ status }) => status === 'covered')).toHaveLength(
      report.objects.length,
    )
  }, 600_000)
})
