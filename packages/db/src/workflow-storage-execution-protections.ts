// Behavioural assertions for every protection in 0079_workflow_execution.sql. As for 0076
// (workflow-storage-protections.ts), the storage test runs them one by one on a migrated
// database, the constraint-coverage test drops each catalog object in turn and requires one of
// them to fail, and the mutation test applies each protection's source-copy mutants to the
// migration and requires its check to fail. Each check builds its own fixture and touches only
// its own rows, so one database serves every check.
import { randomBytes, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'
import { reuseConnectionsAfterErrors } from './testing.ts'
import {
  accepted,
  committed,
  type Expected,
  mutant,
  refused,
  revisionContent,
  rolledBack,
  untilBlocked,
  type WorkflowMutant,
} from './workflow-storage-protections.ts'

export const executionMigration = '0079_workflow_execution.sql'
export const executionTables = [
  'workflow_enrollments',
  'workflow_runs',
  'workflow_recipient_claims',
  'workflow_run_history',
  'workflow_mail_reservations',
] as const
/** Existing tables the migration adds objects to; their other objects belong to older files. */
export const executionExtendedTables = ['notification_email_sends', 'workflow_definitions'] as const

const check = (constraint: string): Expected => ({ code: '23514', constraint })
const foreignKey = (constraint: string): Expected => ({ code: '23503', constraint })
const unique = (constraint: string): Expected => ({ code: '23505', constraint })
const notNull = (column: string): Expected => ({ code: '23502', column })

type Connection = pg.Pool | pg.PoolClient
type Row = Record<string, unknown>

const hours = (count: number) => new Date(Date.now() + count * 3_600_000)
const digest = () => randomBytes(32)

/** Inserts `values` and returns the new row's key (`run_id` for history, else `id`). */
async function insert(db: Connection, table: string, values: Row): Promise<string> {
  const fields = Object.keys(values)
  const key = table === 'workflow_run_history' ? 'run_id' : 'id'
  const { rows } = await db.query<Record<string, string>>(
    `INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING ${key} AS key`,
    Object.values(values),
  )
  return rows[0]?.key as string
}

/** A workflow mail charge in the shared ledger. */
function charge(db: Connection, reservation: string | null, hash: Buffer | null = digest()) {
  return db.query(
    'INSERT INTO notification_email_sends (recipient_hash,sent_at,workflow_reservation_id) VALUES ($1,now(),$2)',
    [hash, reservation],
  )
}

/** Whether another session can lock the row, i.e. nobody holds a lock on it. */
async function unlocked(pool: pg.Pool, table: string, id: string) {
  const { rows } = await pool.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE SKIP LOCKED`, [
    id,
  ])
  return rows.length === 1
}

async function backendPid(db: pg.PoolClient) {
  return (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid as number
}

export async function executionFixture(database: pg.Pool) {
  // Checks expect many failed statements; keep one connection instead of one per failure.
  const pool = reuseConnectionsAfterErrors(database)
  const user = async (label: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO auth."user" (name,email,"emailVerified") VALUES ($1,$2,true) RETURNING id`,
        [`Synthetic workflow ${label}`, `${randomUUID()}@example.test`],
      )
    ).rows[0]?.id as string
  const organization = async (label: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO auth.organization (name,slug,"createdAt") VALUES ($1,$2,now()) RETURNING id`,
        [`Synthetic workflow ${label}`, randomUUID()],
      )
    ).rows[0]?.id as string
  const owner = await user('owner')
  const personal = await organization('personal')
  await pool.query('INSERT INTO personal_organizations (user_id,organization_id) VALUES ($1,$2)', [
    owner,
    personal,
  ])
  const team = await organization('team')
  const otherTeam = await organization('other team')

  /** A workflow of `organization` (the owner's when personal) with its first revision. */
  const workflow = (
    organization = team,
    trigger: Row = { type: 'before_start', offsetMinutes: 60 },
  ) =>
    accepted(
      committed(pool, async (db) => {
        const id = await insert(db, 'workflow_definitions', {
          organization_id: organization,
          owner_user_id: organization === personal ? owner : null,
          enabled: true,
        })
        await db.query(
          'INSERT INTO workflow_revisions (organization_id,workflow_id,revision,definition) VALUES ($1,$2,1,$3)',
          [organization, id, JSON.stringify(revisionContent({ trigger }))],
        )
        return id
      }),
      'create a workflow',
    )
  const booking = async (organization = team) =>
    accepted(
      pool
        .query<{ id: string }>(
          `INSERT INTO bookings (organization_id,start_at,end_at,title,source)
          VALUES ($1,now()+interval '2 days',now()+interval '2 days 30 minutes','Synthetic workflow booking','web')
          RETURNING id`,
          [organization],
        )
        .then(({ rows }) => rows[0]?.id as string),
      'create a booking',
    )

  const enrollmentRow = (
    of: { organization: string; booking: string; workflow: string },
    overrides: Row = {},
  ): Row => ({
    organization_id: of.organization,
    booking_id: of.booking,
    workflow_id: of.workflow,
    revision: 1,
    occurrence: 'created',
    trigger: 'before_start',
    ...overrides,
  })
  const runRow = (
    of: { organization: string; enrollment: string; booking: string },
    overrides: Row = {},
  ): Row => ({
    organization_id: of.organization,
    enrollment_id: of.enrollment,
    booking_id: of.booking,
    due_at: hours(24),
    expires_at: hours(25),
    ...overrides,
  })
  const claimRow = (
    of: { organization: string; run: string; booking: string },
    overrides: Row = {},
  ): Row => ({
    organization_id: of.organization,
    run_id: of.run,
    booking_id: of.booking,
    recipient: `attendee:${randomUUID()}`,
    recipient_hash: digest(),
    ...overrides,
  })
  const historyRow = (
    of: { organization: string; workflow: string },
    overrides: Row = {},
  ): Row => ({
    run_id: randomUUID(),
    organization_id: of.organization,
    workflow_id: of.workflow,
    revision: 1,
    trigger: 'before_start',
    due_at: hours(-2),
    finished_at: hours(-1),
    outcome: 'completed',
    ...overrides,
  })
  const reservationRow = (
    of: { organization: string; run: string; claim: string },
    overrides: Row = {},
  ): Row => ({
    organization_id: of.organization,
    run_id: of.run,
    claim_id: of.claim,
    reserved_at: new Date(),
    ...overrides,
  })

  /**
   * A captured booking, committed: a workflow, a booking, its enrollment, a pending run and one
   * pending recipient, as capture writes them in the booking's transaction.
   */
  const capture = async (organization = team) => {
    const workflowId = await workflow(organization)
    const bookingId = await booking(organization)
    return accepted(
      committed(pool, async (db) => {
        const of = { organization, booking: bookingId, workflow: workflowId }
        const enrollment = await insert(db, 'workflow_enrollments', enrollmentRow(of))
        const run = await insert(db, 'workflow_runs', runRow({ ...of, enrollment }))
        const claim = await insert(
          db,
          'workflow_recipient_claims',
          claimRow({ ...of, run }, { intent_kind: 'before_start', intent_offset_minutes: 60 }),
        )
        return { ...of, enrollment, run, claim }
      }),
      'capture a booking',
    )
  }

  const rows = async (table: string, where: string, params: unknown[]) =>
    (await pool.query<Row>(`SELECT * FROM ${table} WHERE ${where}`, params)).rows
  const one = async (table: string, id: string) =>
    (await rows(table, table === 'workflow_run_history' ? 'run_id=$1' : 'id=$1', [id]))[0]
  const tombstone = (id: string) =>
    accepted(
      pool.query('UPDATE workflow_definitions SET enabled=false,deleted_at=now() WHERE id=$1', [
        id,
      ]),
      'tombstone the workflow',
    )
  const finish = (
    table: 'workflow_runs' | 'workflow_recipient_claims',
    id: string,
    state: string,
  ) =>
    pool.query(
      `UPDATE ${table} SET state=$2,finished_at=now()${table === 'workflow_runs' ? ',claim_token=NULL,lease_until=NULL' : ',claim_token=NULL,next_attempt_at=NULL'} WHERE id=$1`,
      [id, state],
    )

  return {
    pool,
    newOrganization: organization,
    owner,
    personal,
    team,
    otherTeam,
    workflow,
    booking,
    enrollmentRow,
    runRow,
    claimRow,
    historyRow,
    reservationRow,
    capture,
    rows,
    one,
    tombstone,
    finish,
  }
}
export type ExecutionFixture = Awaited<ReturnType<typeof executionFixture>>

/**
 * Two sessions write the same unique key: the second waits for the first, which commits, and is
 * then refused with `expected`. Afterwards exactly one row holds the key.
 */
async function race(
  f: ExecutionFixture,
  label: string,
  first: (db: pg.PoolClient) => Promise<unknown>,
  second: (db: pg.PoolClient) => Promise<unknown>,
  expected: Expected,
  count: () => Promise<number>,
) {
  const a = await f.pool.connect()
  const b = await f.pool.connect()
  let racing: Promise<unknown> = Promise.resolve()
  let settled = false
  try {
    await a.query('BEGIN')
    await accepted(first(a), `${label}: the first writer`)
    const pid = await backendPid(b)
    await b.query('BEGIN')
    racing = second(b)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true
      })
    await untilBlocked(f.pool, pid, () => settled)
    await a.query('COMMIT')
    expect(await racing, `${label}: the second writer`).toMatchObject(expected)
  } finally {
    // Ends the first transaction if it is still open, so the second writer finishes.
    await a.query('ROLLBACK')
    await racing
    await b.query('ROLLBACK')
    a.release()
    b.release()
  }
  expect(await count(), `${label}: rows holding the key`).toBe(1)
}

/**
 * While another session holds the organization row, `write` waits for it before it locks
 * `parent`: a third session can still lock the parent row. Then the write goes through.
 */
async function organizationFirst(
  f: ExecutionFixture,
  organization: string,
  parent: { table: string; id: string },
  write: (db: pg.PoolClient) => Promise<unknown>,
) {
  const holder = await f.pool.connect()
  const writer = await f.pool.connect()
  let waiting: Promise<unknown> = Promise.resolve()
  let settled = false
  try {
    await holder.query('BEGIN')
    await holder.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [organization])
    await writer.query('BEGIN')
    const pid = await backendPid(writer)
    waiting = write(writer)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true
      })
    await untilBlocked(f.pool, pid, () => settled)
    expect(
      await unlocked(f.pool, parent.table, parent.id),
      `the ${parent.table} row is still free while the writer waits for the organization`,
    ).toBe(true)
    await holder.query('ROLLBACK')
    expect(await waiting, 'the waiting writer').toBeUndefined()
  } finally {
    await holder.query('ROLLBACK')
    await waiting
    await writer.query('ROLLBACK')
    holder.release()
    writer.release()
  }
}

/** `write`, in an open transaction, holds a lock on the organization; a control stays free. */
async function locksOrganization(
  f: ExecutionFixture,
  organization: string,
  write: (db: pg.PoolClient) => Promise<unknown>,
) {
  await rolledBack(f.pool, async (db) => {
    await accepted(write(db), 'the write')
    expect(
      await unlocked(f.pool, 'auth.organization', organization),
      'the organization is locked',
    ).toBe(false)
    expect(await unlocked(f.pool, 'auth.organization', f.otherTeam), 'the control is free').toBe(
      true,
    )
  })
}

/**
 * `deletion` waits while `holder` holds what it wrote, and goes through once it commits: the
 * two take turns on the definition row.
 */
async function takesTurns(
  f: ExecutionFixture,
  label: string,
  hold: (db: pg.PoolClient) => Promise<unknown>,
  deletion: (db: pg.PoolClient) => Promise<unknown>,
) {
  const holder = await f.pool.connect()
  const deleter = await f.pool.connect()
  let waiting: Promise<unknown> = Promise.resolve()
  let settled = false
  try {
    await holder.query('BEGIN')
    await accepted(hold(holder), `${label}: the capture`)
    const pid = await backendPid(deleter)
    await deleter.query('BEGIN')
    waiting = deletion(deleter)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true
      })
    await untilBlocked(f.pool, pid, () => settled)
    await holder.query('COMMIT')
    expect(await waiting, `${label}: the deletion`).toBeUndefined()
    await deleter.query('COMMIT')
  } finally {
    await holder.query('ROLLBACK')
    await waiting
    await deleter.query('ROLLBACK')
    holder.release()
    deleter.release()
  }
}

/**
 * Whether the plan of `sql` reads `index`, with sequential scans discouraged, and searches it by
 * each of `columns` (an index that only shares a leading column would still be read, filtered).
 */
async function planUses(
  f: ExecutionFixture,
  index: string,
  sql: string,
  params: unknown[],
  columns: string[] = [],
) {
  const plan = JSON.stringify(
    await rolledBack(f.pool, async (db) => {
      await db.query('SET LOCAL enable_seqscan=off')
      return (await db.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows[0]?.['QUERY PLAN']
    }),
  )
  const conditions = [...plan.matchAll(/"Index Cond":"([^"]*)"/g)].map(([, text]) => text)
  return (
    plan.includes(`"Index Name":"${index}"`) &&
    columns.every((column) => conditions.some((text) => text?.includes(`(${column} `)))
  )
}

export interface ExecutionProtection {
  /** Catalog objects (constraint, index, trigger, NOT NULL column) and trigger rules covered. */
  objects: string[]
  check: (f: ExecutionFixture) => Promise<void>
  mutants: WorkflowMutant[]
}

const skipReasons = [
  'condition_false',
  'existing_notification',
  'minimum_gap',
  'offset_not_future',
  'expired',
  'budget_suppressed',
  'render_limit',
  'workflow_disabled',
  'instance_disabled',
]

const requiredColumns: Record<(typeof executionTables)[number], string[]> = {
  workflow_enrollments: [
    'organization_id',
    'booking_id',
    'workflow_id',
    'revision',
    'occurrence',
    'trigger',
    'created_at',
  ],
  workflow_runs: [
    'organization_id',
    'enrollment_id',
    'booking_id',
    'due_at',
    'expires_at',
    'state',
    'created_at',
    'updated_at',
  ],
  workflow_recipient_claims: [
    'organization_id',
    'run_id',
    'booking_id',
    'recipient',
    'recipient_hash',
    'state',
    'attempts',
    'created_at',
    'updated_at',
  ],
  workflow_run_history: [
    'organization_id',
    'workflow_id',
    'revision',
    'trigger',
    'due_at',
    'finished_at',
    'outcome',
    'sent',
    'rejected',
    'delivery_unknown',
    'skipped',
  ],
  workflow_mail_reservations: ['organization_id', 'run_id', 'claim_id', 'reserved_at'],
}

/** A complete row of `table` whose references need not exist (NOT NULL is checked first). */
const looseRows: Record<(typeof executionTables)[number], () => Row> = {
  workflow_enrollments: () => ({
    organization_id: randomUUID(),
    booking_id: randomUUID(),
    workflow_id: randomUUID(),
    revision: 1,
    occurrence: 'created',
    trigger: 'before_start',
    created_at: new Date(),
  }),
  workflow_runs: () => ({
    organization_id: randomUUID(),
    enrollment_id: randomUUID(),
    booking_id: randomUUID(),
    due_at: hours(1),
    expires_at: hours(2),
    state: 'pending',
    created_at: new Date(),
    updated_at: new Date(),
  }),
  workflow_recipient_claims: () => ({
    organization_id: randomUUID(),
    run_id: randomUUID(),
    booking_id: randomUUID(),
    recipient: `host:${randomUUID()}`,
    recipient_hash: digest(),
    state: 'pending',
    attempts: 0,
    created_at: new Date(),
    updated_at: new Date(),
  }),
  workflow_run_history: () => ({
    run_id: randomUUID(),
    organization_id: randomUUID(),
    workflow_id: randomUUID(),
    revision: 1,
    trigger: 'after_end',
    due_at: hours(-2),
    finished_at: hours(-1),
    outcome: 'completed',
    sent: 0,
    rejected: 0,
    delivery_unknown: 0,
    skipped: 0,
  }),
  workflow_mail_reservations: () => ({
    organization_id: randomUUID(),
    run_id: randomUUID(),
    claim_id: randomUUID(),
    reserved_at: new Date(),
  }),
}

export const executionProtections: Record<string, ExecutionProtection> = {
  'required columns and defaults': {
    objects: Object.entries(requiredColumns).flatMap(([table, columns]) =>
      columns.map((column) => `${table}.${column}`),
    ),
    check: async (f) => {
      // The column refuses NULL even with every guard trigger out of the way.
      for (const [table, columns] of Object.entries(requiredColumns))
        for (const column of columns)
          await refused(
            f.pool,
            notNull(column),
            async (db) => {
              await db.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
              await insert(db, table, {
                ...looseRows[table as keyof typeof looseRows](),
                [column]: null,
              })
            },
            `${table}.${column}`,
          )
      // New rows: pending, with no attempt yet, zero counts, stamped now and with time-ordered
      // (version 7) IDs.
      const defaults = await rolledBack(f.pool, async (db) => {
        const of = {
          organization: f.team,
          booking: await f.booking(),
          workflow: await f.workflow(),
        }
        const enrollment = await accepted(
          insert(db, 'workflow_enrollments', f.enrollmentRow(of)),
          'enrollment',
        )
        const run = await accepted(
          insert(db, 'workflow_runs', f.runRow({ ...of, enrollment })),
          'run',
        )
        const claim = await accepted(
          insert(db, 'workflow_recipient_claims', f.claimRow({ ...of, run })),
          'claim',
        )
        const history = await accepted(
          insert(db, 'workflow_run_history', f.historyRow(of)),
          'history',
        )
        const reservation = await accepted(
          insert(db, 'workflow_mail_reservations', f.reservationRow({ ...of, run, claim })),
          'reservation',
        )
        const read = async (sql: string, id: string) => (await db.query(sql, [id])).rows[0]
        return {
          enrollment: await read(
            `SELECT created_at=now() AS now,substr(id::text,15,1) AS version FROM workflow_enrollments WHERE id=$1`,
            enrollment,
          ),
          run: await read(
            `SELECT state,created_at=now() AS created,updated_at=now() AS updated,substr(id::text,15,1) AS version
            FROM workflow_runs WHERE id=$1`,
            run,
          ),
          claim: await read(
            `SELECT state,attempts,created_at=now() AS created,updated_at=now() AS updated,substr(id::text,15,1) AS version
            FROM workflow_recipient_claims WHERE id=$1`,
            claim,
          ),
          history: await read(
            'SELECT sent,rejected,delivery_unknown,skipped FROM workflow_run_history WHERE run_id=$1',
            history,
          ),
          reservation: await read(
            'SELECT substr(id::text,15,1) AS version FROM workflow_mail_reservations WHERE id=$1',
            reservation,
          ),
        }
      })
      expect(defaults).toEqual({
        enrollment: { now: true, version: '7' },
        run: { state: 'pending', created: true, updated: true, version: '7' },
        claim: { state: 'pending', attempts: 0, created: true, updated: true, version: '7' },
        history: { sent: 0, rejected: 0, delivery_unknown: 0, skipped: 0 },
        reservation: { version: '7' },
      })
    },
    mutants: [
      mutant(
        'a run may have no due instant',
        '  due_at timestamptz NOT NULL,\n  expires_at',
        '  due_at timestamptz,\n  expires_at',
      ),
      mutant(
        'a recipient may have no address digest',
        '  recipient_hash bytea NOT NULL,',
        '  recipient_hash bytea,',
      ),
      mutant(
        'an enrollment may name no revision',
        '  revision integer NOT NULL,\n  occurrence',
        '  revision integer,\n  occurrence',
      ),
      mutant(
        'a reservation may have no time',
        '  reserved_at timestamptz NOT NULL,',
        '  reserved_at timestamptz,',
      ),
      mutant(
        'history may have no finish time',
        '  finished_at timestamptz NOT NULL,\n  outcome',
        '  finished_at timestamptz,\n  outcome',
      ),
      mutant(
        'a new run starts claimed',
        "  state text NOT NULL DEFAULT 'pending',\n  skip_reason text,\n  claim_token uuid,\n  lease_until",
        "  state text NOT NULL DEFAULT 'claimed',\n  skip_reason text,\n  claim_token uuid,\n  lease_until",
      ),
      mutant(
        'a new recipient starts with an attempt',
        '  attempts smallint NOT NULL DEFAULT 0,',
        '  attempts smallint NOT NULL DEFAULT 1,',
      ),
      mutant(
        'history counts a sent message by default',
        '  sent integer NOT NULL DEFAULT 0,',
        '  sent integer NOT NULL DEFAULT 1,',
      ),
      mutant(
        'run IDs are random instead of time-ordered',
        `CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),`,
        `CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),`,
      ),
    ],
  },

  enrollments: {
    objects: [
      'workflow_enrollments_pkey',
      'workflow_enrollments_identity',
      'workflow_enrollments_booking',
      'workflow_enrollments_occurrence',
      'workflow_enrollments_guard',
      'workflow_enrollments_live_workflow',
      'workflow_enrollments_revision',
      'workflow_enrollments_immutable',
      'workflow_enrollments_retained',
    ],
    check: async (f) => {
      const workflow = await f.workflow()
      const booking = await f.booking()
      const of = { organization: f.team, booking, workflow }
      const id = randomUUID()
      await accepted(insert(f.pool, 'workflow_enrollments', f.enrollmentRow(of, { id })))
      // An ID is unique on the instance.
      const other = { organization: f.team, booking: await f.booking(), workflow }
      await refused(f.pool, unique('workflow_enrollments_pkey'), (db) =>
        insert(db, 'workflow_enrollments', f.enrollmentRow(other, { id })),
      )
      // One capture of a workflow per booking and occurrence, even when two captures race.
      const raced = { organization: f.team, booking: await f.booking(), workflow }
      await race(
        f,
        'concurrent capture',
        (db) => insert(db, 'workflow_enrollments', f.enrollmentRow(raced)),
        (db) => insert(db, 'workflow_enrollments', f.enrollmentRow(raced)),
        unique('workflow_enrollments_identity'),
        async () => (await f.rows('workflow_enrollments', 'booking_id=$1', [raced.booking])).length,
      )
      // The same workflow on another booking, and at another occurrence of the same booking
      // (a later revision with a cancellation trigger), is another capture.
      await accepted(insert(f.pool, 'workflow_enrollments', f.enrollmentRow(other)))
      await accepted(
        f.pool.query(
          'INSERT INTO workflow_revisions (organization_id,workflow_id,revision,definition) VALUES ($1,$2,2,$3)',
          [
            f.team,
            workflow,
            JSON.stringify(
              revisionContent({ trigger: { type: 'booking.cancelled', delayMinutes: 0 } }),
            ),
          ],
        ),
      )
      await accepted(
        insert(
          f.pool,
          'workflow_enrollments',
          f.enrollmentRow(of, {
            revision: 2,
            occurrence: 'cancelled',
            trigger: 'booking.cancelled',
          }),
        ),
        'another occurrence',
      )

      // Only a live workflow of the booking's organization, at a stored revision whose trigger
      // the enrollment names.
      const live = check('workflow_enrollments_live_workflow')
      const fresh = { organization: f.team, booking: await f.booking(), workflow }
      await refused(
        f.pool,
        live,
        (db) =>
          insert(db, 'workflow_enrollments', f.enrollmentRow({ ...fresh, workflow: randomUUID() })),
        'an unknown workflow',
      )
      const foreign = await f.workflow(f.otherTeam)
      await refused(
        f.pool,
        live,
        (db) =>
          insert(db, 'workflow_enrollments', f.enrollmentRow({ ...fresh, workflow: foreign })),
        "another organization's workflow",
      )
      const deleted = await f.workflow()
      await f.tombstone(deleted)
      await refused(
        f.pool,
        live,
        (db) =>
          insert(db, 'workflow_enrollments', f.enrollmentRow({ ...fresh, workflow: deleted })),
        'a tombstoned workflow',
      )
      const revisionRule = check('workflow_enrollments_revision')
      await refused(
        f.pool,
        revisionRule,
        (db) => insert(db, 'workflow_enrollments', f.enrollmentRow(fresh, { revision: 3 })),
        'an unknown revision',
      )
      await refused(
        f.pool,
        revisionRule,
        (db) =>
          insert(
            db,
            'workflow_enrollments',
            f.enrollmentRow(fresh, { revision: 1, trigger: 'after_end' }),
          ),
        'another trigger than the revision has',
      )
      // Each occurrence takes only its own triggers.
      const occurrence = check('workflow_enrollments_occurrence')
      const triggers: [string, Row][] = [
        ['booking.created', { type: 'booking.created', delayMinutes: 0 }],
        ['booking.rescheduled', { type: 'booking.rescheduled', delayMinutes: 0 }],
        ['booking.cancelled', { type: 'booking.cancelled', delayMinutes: 0 }],
        ['before_start', { type: 'before_start', offsetMinutes: 60 }],
        ['after_end', { type: 'after_end', offsetMinutes: 60 }],
      ]
      const allowed: Record<string, string[]> = {
        created: ['booking.created', 'before_start', 'after_end'],
        rescheduled: ['booking.rescheduled'],
        cancelled: ['booking.cancelled'],
      }
      for (const [type, trigger] of triggers) {
        const target = {
          organization: f.team,
          booking: await f.booking(),
          workflow: await f.workflow(f.team, trigger),
        }
        for (const [name, types] of Object.entries(allowed)) {
          const write = (db: pg.PoolClient) =>
            insert(
              db,
              'workflow_enrollments',
              f.enrollmentRow(target, { occurrence: name, trigger: type }),
            )
          if (types.includes(type))
            await rolledBack(f.pool, (db) => accepted(write(db), `${name} with ${type}`))
          else await refused(f.pool, occurrence, write, `${name} with ${type}`)
        }
      }

      // The booking belongs to the same organization, and its deletion removes the enrollment.
      const reference = foreignKey('workflow_enrollments_booking')
      await refused(
        f.pool,
        reference,
        (db) =>
          insert(db, 'workflow_enrollments', f.enrollmentRow({ ...fresh, booking: randomUUID() })),
        'an unknown booking',
      )
      await refused(
        f.pool,
        reference,
        (db) =>
          insert(
            db,
            'workflow_enrollments',
            f.enrollmentRow({
              organization: f.otherTeam,
              booking: fresh.booking,
              workflow: foreign,
            }),
          ),
        "another organization's booking",
      )

      // Immutable, and removed only with the booking or organization.
      const captured = await f.capture()
      for (const assignment of [
        'revision=revision',
        "occurrence='cancelled',trigger='booking.cancelled'",
        `booking_id='${other.booking}'`,
        "created_at=created_at-interval '1 day'",
      ])
        await refused(
          f.pool,
          check('workflow_enrollments_immutable'),
          (db) =>
            db.query(`UPDATE workflow_enrollments SET ${assignment} WHERE id=$1`, [
              captured.enrollment,
            ]),
          assignment,
        )
      await refused(f.pool, check('workflow_enrollments_retained'), (db) =>
        db.query('DELETE FROM workflow_enrollments WHERE id=$1', [captured.enrollment]),
      )
      await accepted(f.pool.query('DELETE FROM bookings WHERE id=$1', [captured.booking]))
      expect(await f.one('workflow_enrollments', captured.enrollment)).toBeUndefined()
      expect(await f.one('workflow_runs', captured.run)).toBeUndefined()
      expect(await f.one('workflow_recipient_claims', captured.claim)).toBeUndefined()
      expect(await f.one('workflow_enrollments', id), 'other bookings keep theirs').toBeDefined()
    },
    mutants: [
      mutant(
        'enrollment IDs are not unique',
        `CREATE TABLE workflow_enrollments (
  id uuid PRIMARY KEY DEFAULT uuidv7(),`,
        `CREATE TABLE workflow_enrollments (
  id uuid NOT NULL DEFAULT uuidv7(),`,
      ),
      mutant(
        'a booking enrolls once per workflow whatever the occurrence',
        'UNIQUE (booking_id, occurrence, workflow_id)',
        'UNIQUE (booking_id, workflow_id)',
      ),
      mutant(
        'a workflow enrolls one booking per occurrence',
        'UNIQUE (booking_id, occurrence, workflow_id)',
        'UNIQUE (occurrence, workflow_id)',
      ),
      mutant(
        'a tombstoned workflow takes enrollments',
        `      WHERE organization_id = NEW.organization_id AND id = NEW.workflow_id
        AND deleted_at IS NULL FOR SHARE;`,
        `      WHERE organization_id = NEW.organization_id AND id = NEW.workflow_id
        FOR SHARE;`,
      ),
      mutant(
        "another organization's workflow takes enrollments",
        `      WHERE organization_id = NEW.organization_id AND id = NEW.workflow_id
        AND deleted_at IS NULL FOR SHARE;`,
        `      WHERE id = NEW.workflow_id
        AND deleted_at IS NULL FOR SHARE;`,
      ),
      mutant(
        'an enrollment may name another trigger than its revision',
        "          AND revision = NEW.revision AND definition->'trigger'->>'type' = NEW.trigger) THEN",
        '          AND revision = NEW.revision) THEN',
      ),
      mutant(
        'an enrollment may name an unknown revision',
        "          AND revision = NEW.revision AND definition->'trigger'->>'type' = NEW.trigger) THEN",
        "          AND definition->'trigger'->>'type' = NEW.trigger) THEN",
      ),
      mutant(
        'a creation captures cancellation triggers',
        "(occurrence = 'created' AND trigger IN ('booking.created', 'before_start', 'after_end'))",
        "(occurrence = 'created' AND trigger IN ('booking.created', 'booking.cancelled', 'before_start', 'after_end'))",
      ),
      mutant(
        'a reschedule captures timers',
        "(occurrence = 'rescheduled' AND trigger IN ('booking.rescheduled'))",
        "(occurrence = 'rescheduled' AND trigger IN ('booking.rescheduled', 'before_start'))",
      ),
      mutant(
        'a cancellation captures creation triggers',
        "(occurrence = 'cancelled' AND trigger IN ('booking.cancelled'))",
        "(occurrence = 'cancelled' AND trigger IN ('booking.cancelled', 'booking.created'))",
      ),
      mutant(
        'an enrollment may name a booking of another organization',
        `  CONSTRAINT workflow_enrollments_booking FOREIGN KEY (booking_id, organization_id)
    REFERENCES bookings (id, organization_id) ON DELETE CASCADE,`,
        `  CONSTRAINT workflow_enrollments_booking FOREIGN KEY (booking_id)
    REFERENCES bookings (id) ON DELETE CASCADE,`,
      ),
      mutant(
        'enrollments block their booking deletion',
        '    REFERENCES bookings (id, organization_id) ON DELETE CASCADE,',
        '    REFERENCES bookings (id, organization_id),',
      ),
      mutant(
        'enrollments can be rewritten',
        `  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'workflow enrollments are immutable'`,
        `  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
    RAISE EXCEPTION 'workflow enrollments are immutable'`,
      ),
      mutant(
        'enrollments can be deleted on their own',
        `  IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)
     AND EXISTS (SELECT FROM public.bookings WHERE id = OLD.booking_id) THEN`,
        '  IF false THEN',
      ),
    ],
  },

  'enrollment locks and lookups': {
    objects: ['workflow_enrollments_guard', 'workflow_enrollments_workflow'],
    check: async (f) => {
      const workflow = await f.workflow()
      // Bookings first: while a check holds the organization, nothing else may write in it.
      const bookings = [await f.booking(), await f.booking(), await f.booking(), await f.booking()]
      const write = (booking: string) => (db: pg.PoolClient) =>
        insert(
          db,
          'workflow_enrollments',
          f.enrollmentRow({ organization: f.team, booking, workflow }),
        )
      await locksOrganization(f, f.team, write(bookings[0] as string))
      // The organization first, then the definition, as other workflow writers lock them.
      await organizationFirst(
        f,
        f.team,
        { table: 'workflow_definitions', id: workflow },
        write(bookings[1] as string),
      )
      // A capture and the workflow's deletion take turns: the tombstone waits for the capture,
      // and a capture after the tombstone is refused.
      await takesTurns(f, 'capture first', write(bookings[2] as string), (db) =>
        db.query('UPDATE workflow_definitions SET enabled=false,deleted_at=now() WHERE id=$1', [
          workflow,
        ]),
      )
      await refused(
        f.pool,
        check('workflow_enrollments_live_workflow'),
        write(bookings[3] as string),
        'after deletion',
      )
      // A workflow's retirement and its purge check find its enrollments by index.
      expect(
        await planUses(
          f,
          'workflow_enrollments_workflow',
          'SELECT id FROM workflow_enrollments WHERE organization_id=$1 AND workflow_id=$2',
          [f.team, workflow],
          ['organization_id', 'workflow_id'],
        ),
      ).toBe(true)
    },
    mutants: [
      mutant(
        'an enrollment locks the definition before the organization',
        `  IF TG_OP = 'INSERT' THEN
    PERFORM FROM auth.organization WHERE id = NEW.organization_id FOR KEY SHARE;
    PERFORM FROM public.workflow_definitions`,
        `  IF TG_OP = 'INSERT' THEN
    PERFORM FROM public.workflow_definitions`,
      ),
      mutant(
        'enrollments of a workflow are not indexed',
        'ON workflow_enrollments (organization_id, workflow_id);',
        'ON workflow_enrollments (organization_id, created_at);',
      ),
      mutant(
        'a capture does not hold off the deletion of its workflow',
        `        AND deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a booking enrolls only in a live workflow'`,
        `        AND deleted_at IS NULL FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a booking enrolls only in a live workflow'`,
      ),
    ],
  },

  runs: {
    objects: [
      'workflow_runs_pkey',
      'workflow_runs_identity',
      'workflow_runs_enrollment',
      'workflow_runs_window',
      'workflow_runs_guard',
      'workflow_runs_live_workflow',
      'workflow_runs_initial_state',
      'workflow_runs_immutable',
      'workflow_runs_final',
      'workflow_runs_retained',
    ],
    check: async (f) => {
      const workflow = await f.workflow()
      const enroll = async () => {
        const of = { organization: f.team, booking: await f.booking(), workflow }
        return {
          ...of,
          enrollment: await accepted(insert(f.pool, 'workflow_enrollments', f.enrollmentRow(of))),
        }
      }
      const first = await enroll()
      const id = randomUUID()
      await accepted(insert(f.pool, 'workflow_runs', f.runRow(first, { id })))
      const second = await enroll()
      await refused(f.pool, unique('workflow_runs_pkey'), (db) =>
        insert(db, 'workflow_runs', f.runRow(second, { id })),
      )
      // One run per enrollment, even when two writers race.
      await race(
        f,
        'concurrent runs',
        (db) => insert(db, 'workflow_runs', f.runRow(second)),
        (db) => insert(db, 'workflow_runs', f.runRow(second)),
        unique('workflow_runs_identity'),
        async () => (await f.rows('workflow_runs', 'enrollment_id=$1', [second.enrollment])).length,
      )
      // A run belongs to its enrollment's booking and organization.
      const third = await enroll()
      const reference = foreignKey('workflow_runs_enrollment')
      await refused(
        f.pool,
        reference,
        (db) => insert(db, 'workflow_runs', f.runRow({ ...third, enrollment: randomUUID() })),
        'an unknown enrollment',
      )
      await refused(
        f.pool,
        reference,
        (db) => insert(db, 'workflow_runs', f.runRow({ ...third, booking: first.booking })),
        "another booking's enrollment",
      )
      // It expires after it is due.
      for (const [label, expires] of [
        ['at the due instant', hours(24)],
        ['before it', hours(23)],
      ] as const)
        await refused(
          f.pool,
          check('workflow_runs_window'),
          (db) =>
            insert(
              db,
              'workflow_runs',
              f.runRow(third, { due_at: hours(24), expires_at: expires }),
            ),
          label,
        )
      // It starts pending or skipped (capture records minimum_gap and offset_not_future).
      const initial = check('workflow_runs_initial_state')
      for (const state of ['claimed', 'completed', 'retired'])
        await refused(
          f.pool,
          initial,
          (db) =>
            insert(
              db,
              'workflow_runs',
              f.runRow(third, {
                state,
                finished_at: state === 'claimed' ? null : new Date(),
                claim_token: state === 'claimed' ? randomUUID() : null,
                lease_until: state === 'claimed' ? hours(1) : null,
              }),
            ),
          `a new ${state} run`,
        )
      await rolledBack(f.pool, (db) =>
        accepted(
          insert(
            db,
            'workflow_runs',
            f.runRow(third, {
              state: 'skipped',
              skip_reason: 'minimum_gap',
              finished_at: new Date(),
            }),
          ),
          'a run skipped at capture',
        ),
      )
      // Only for a live workflow: none after its tombstone.
      const live = check('workflow_runs_live_workflow')
      const tombstoned = await f.workflow()
      const late = { organization: f.team, booking: await f.booking(), workflow: tombstoned }
      const lateEnrollment = await accepted(
        insert(f.pool, 'workflow_enrollments', f.enrollmentRow(late)),
      )
      await f.tombstone(tombstoned)
      await refused(
        f.pool,
        live,
        (db) => insert(db, 'workflow_runs', f.runRow({ ...late, enrollment: lateEnrollment })),
        'a tombstoned workflow',
      )

      // Identity and timing never change; a finished run is final.
      const captured = await f.capture()
      const immutable = check('workflow_runs_immutable')
      for (const assignment of [
        "due_at=due_at+interval '1 minute'",
        "expires_at=expires_at+interval '1 minute'",
        `enrollment_id='${third.enrollment}',booking_id='${third.booking}'`,
        "created_at=created_at-interval '1 day'",
        `id='${randomUUID()}'`,
      ])
        await refused(
          f.pool,
          immutable,
          (db) => db.query(`UPDATE workflow_runs SET ${assignment} WHERE id=$1`, [captured.run]),
          assignment,
        )
      // A claim and its release are ordinary changes of an unfinished run.
      await accepted(
        f.pool.query(
          `UPDATE workflow_runs SET state='claimed',claim_token=$2,lease_until=now()+interval '5 minutes' WHERE id=$1`,
          [captured.run, randomUUID()],
        ),
        'claim',
      )
      await accepted(
        f.pool.query(
          `UPDATE workflow_runs SET state='pending',claim_token=NULL,lease_until=NULL WHERE id=$1`,
          [captured.run],
        ),
        'release',
      )
      const final = check('workflow_runs_final')
      for (const state of ['completed', 'retired']) {
        const done = await f.capture()
        await accepted(f.finish('workflow_runs', done.run, state), state)
        for (const assignment of [
          "state='pending',finished_at=NULL",
          `state='claimed',finished_at=NULL,claim_token='${randomUUID()}',lease_until=now()`,
          'finished_at=now()',
        ])
          await refused(
            f.pool,
            final,
            (db) => db.query(`UPDATE workflow_runs SET ${assignment} WHERE id=$1`, [done.run]),
            `${state}: ${assignment}`,
          )
      }
      const skipped = await f.capture()
      await accepted(
        f.pool.query(
          `UPDATE workflow_runs SET state='skipped',skip_reason='workflow_disabled',finished_at=now() WHERE id=$1`,
          [skipped.run],
        ),
      )
      await refused(
        f.pool,
        final,
        (db) =>
          db.query(
            "UPDATE workflow_runs SET state='pending',skip_reason=NULL,finished_at=NULL WHERE id=$1",
            [skipped.run],
          ),
        'skipped',
      )
      // Removed only with its enrollment (its booking) or organization.
      await refused(f.pool, check('workflow_runs_retained'), (db) =>
        db.query('DELETE FROM workflow_runs WHERE id=$1', [captured.run]),
      )
      await accepted(f.pool.query('DELETE FROM bookings WHERE id=$1', [captured.booking]))
      expect(await f.one('workflow_runs', captured.run)).toBeUndefined()
      expect(await f.one('workflow_runs', id), 'other runs stay').toBeDefined()
    },
    mutants: [
      mutant(
        'run IDs are not unique',
        `CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),`,
        `CREATE TABLE workflow_runs (
  id uuid NOT NULL DEFAULT uuidv7(),`,
      ),
      mutant(
        'an enrollment may have several runs',
        '  CONSTRAINT workflow_runs_identity UNIQUE (enrollment_id),\n',
      ),
      mutant(
        "a run may name another booking than its enrollment's",
        `  CONSTRAINT workflow_runs_enrollment FOREIGN KEY (organization_id, enrollment_id, booking_id)
    REFERENCES workflow_enrollments (organization_id, id, booking_id) ON DELETE CASCADE,`,
        `  CONSTRAINT workflow_runs_enrollment FOREIGN KEY (enrollment_id)
    REFERENCES workflow_enrollments (id) ON DELETE CASCADE,`,
      ),
      mutant(
        'runs block their booking deletion',
        '    REFERENCES workflow_enrollments (organization_id, id, booking_id) ON DELETE CASCADE,',
        '    REFERENCES workflow_enrollments (organization_id, id, booking_id),',
      ),
      mutant(
        'a run may expire when it is due',
        'CHECK (expires_at > due_at)',
        'CHECK (expires_at >= due_at)',
      ),
      mutant(
        'a tombstoned workflow takes runs',
        '      WHERE organization_id = NEW.organization_id AND id = workflow AND deleted_at IS NULL',
        '      WHERE organization_id = NEW.organization_id AND id = workflow',
      ),
      mutant(
        'a run may start claimed',
        "    IF NEW.state NOT IN ('pending', 'skipped') THEN\n      RAISE EXCEPTION 'a workflow run starts pending or skipped'",
        "    IF NEW.state NOT IN ('pending', 'skipped', 'claimed') THEN\n      RAISE EXCEPTION 'a workflow run starts pending or skipped'",
      ),
      mutant(
        'a run may start finished',
        "    IF NEW.state NOT IN ('pending', 'skipped') THEN\n      RAISE EXCEPTION 'a workflow run starts pending or skipped'",
        "    IF NEW.state NOT IN ('pending', 'skipped', 'completed', 'retired') THEN\n      RAISE EXCEPTION 'a workflow run starts pending or skipped'",
      ),
      ...[
        [
          'due instant',
          'NEW.due_at,\n         NEW.expires_at',
          'OLD.due_at,\n         NEW.expires_at',
        ],
        ['expiry', 'NEW.due_at,\n         NEW.expires_at', 'NEW.due_at,\n         OLD.expires_at'],
        [
          'enrollment',
          'ROW(NEW.id, NEW.organization_id, NEW.enrollment_id, NEW.booking_id,',
          'ROW(NEW.id, NEW.organization_id, OLD.enrollment_id, OLD.booking_id,',
        ],
        ['creation time', 'NEW.expires_at, NEW.created_at)', 'NEW.expires_at, OLD.created_at)'],
      ].map(([what, before, after]) =>
        mutant(`a run's ${what} is mutable`, before as string, after as string),
      ),
      mutant(
        'a retired run can return to pending',
        "  IF OLD.state IN ('completed', 'skipped', 'retired') THEN",
        "  IF OLD.state IN ('completed', 'skipped') THEN",
      ),
      mutant(
        'a skipped run can return to pending',
        "  IF OLD.state IN ('completed', 'skipped', 'retired') THEN",
        "  IF OLD.state IN ('completed', 'retired') THEN",
      ),
      mutant(
        'a completed run can run again',
        "  IF OLD.state IN ('completed', 'skipped', 'retired') THEN",
        "  IF OLD.state IN ('skipped', 'retired') THEN",
      ),
      mutant(
        'runs can be deleted on their own',
        `    IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)
       AND EXISTS (SELECT FROM public.workflow_enrollments WHERE id = OLD.enrollment_id) THEN`,
        '    IF false THEN',
      ),
    ],
  },

  'run states': {
    objects: ['workflow_runs_state', 'workflow_runs_updated_at'],
    check: async (f) => {
      const captured = await f.capture()
      const state = check('workflow_runs_state')
      const update = (assignment: string) => (db: pg.PoolClient) =>
        db.query(`UPDATE workflow_runs SET ${assignment} WHERE id=$1`, [captured.run])
      const token = randomUUID()
      const valid = [
        `state='claimed',claim_token='${token}',lease_until=now()`,
        "state='completed',finished_at=now()",
        "state='retired',finished_at=now()",
        ...skipReasons.map((reason) => `state='skipped',skip_reason='${reason}',finished_at=now()`),
      ]
      for (const assignment of valid)
        await rolledBack(f.pool, (db) => accepted(update(assignment)(db), assignment))
      const invalid = [
        'finished_at=now()',
        `claim_token='${token}'`,
        'lease_until=now()',
        "skip_reason='expired'",
        "state='claimed',lease_until=now()",
        `state='claimed',claim_token='${token}'`,
        `state='claimed',claim_token='${token}',lease_until=now(),finished_at=now()`,
        `state='claimed',claim_token='${token}',lease_until=now(),skip_reason='expired'`,
        "state='completed'",
        "state='completed',finished_at=now(),skip_reason='expired'",
        `state='completed',finished_at=now(),claim_token='${token}'`,
        "state='completed',finished_at=now(),lease_until=now()",
        "state='retired'",
        "state='retired',finished_at=now(),skip_reason='expired'",
        `state='retired',finished_at=now(),claim_token='${token}'`,
        "state='skipped',finished_at=now()",
        "state='skipped',skip_reason='expired'",
        "state='skipped',skip_reason='booking_cancelled',finished_at=now()",
        `state='skipped',skip_reason='expired',finished_at=now(),claim_token='${token}'`,
        "state='skipped',skip_reason='expired',finished_at=now(),lease_until=now()",
        "state='running'",
      ]
      for (const assignment of invalid) await refused(f.pool, state, update(assignment), assignment)
      // Every change stamps the update time; compared in the database, which keeps microseconds.
      const { rows } = await f.pool.query<{ later: boolean }>(
        `UPDATE workflow_runs SET state='claimed',claim_token=$2,lease_until=now()
        WHERE id=$1 RETURNING updated_at > created_at AS later`,
        [captured.run, token],
      )
      expect(rows[0]?.later, 'a claim stamps the update time').toBe(true)
    },
    mutants: [
      mutant(
        'a pending run may carry a finish time',
        'num_nonnulls(skip_reason, claim_token, lease_until, finished_at) = 0',
        'num_nonnulls(skip_reason, claim_token, lease_until) = 0',
      ),
      mutant(
        'a claim may lack its lease',
        '        claim_token IS NOT NULL AND lease_until IS NOT NULL\n        AND num_nonnulls(skip_reason, finished_at) = 0',
        '        claim_token IS NOT NULL\n        AND num_nonnulls(skip_reason, finished_at) = 0',
      ),
      mutant(
        'a claimed run may be finished',
        '        claim_token IS NOT NULL AND lease_until IS NOT NULL\n        AND num_nonnulls(skip_reason, finished_at) = 0',
        '        claim_token IS NOT NULL AND lease_until IS NOT NULL\n        AND num_nonnulls(skip_reason) = 0',
      ),
      mutant(
        'a completed run may keep its claim',
        "      WHEN state IN ('completed', 'retired') THEN\n        finished_at IS NOT NULL AND num_nonnulls(skip_reason, claim_token, lease_until) = 0",
        "      WHEN state IN ('completed', 'retired') THEN\n        finished_at IS NOT NULL AND num_nonnulls(skip_reason) = 0",
      ),
      mutant(
        'a completed run may lack its finish time',
        "      WHEN state IN ('completed', 'retired') THEN\n        finished_at IS NOT NULL AND",
        "      WHEN state IN ('completed', 'retired') THEN\n        true AND",
      ),
      mutant(
        'a skipped run may have no reason',
        `          'workflow_disabled', 'instance_disabled')
      ELSE false
    END
  ) IS TRUE)
);
-- Bounded due work`,
        `          'workflow_disabled', 'instance_disabled') OR skip_reason IS NULL
      ELSE false
    END
  ) IS TRUE)
);
-- Bounded due work`,
      ),
      mutant(
        'a skipped run may keep its claim',
        '        finished_at IS NOT NULL AND num_nonnulls(claim_token, lease_until) = 0\n        AND skip_reason IN',
        '        finished_at IS NOT NULL\n        AND skip_reason IN',
      ),
      mutant(
        'any other state',
        `      ELSE false
    END
  ) IS TRUE)
);
-- Bounded due work`,
        `      ELSE true
    END
  ) IS TRUE)
);
-- Bounded due work`,
      ),
      mutant(
        'updates keep the update time',
        'CREATE TRIGGER workflow_runs_updated_at BEFORE UPDATE',
        'CREATE TRIGGER workflow_runs_updated_at BEFORE INSERT',
      ),
    ],
  },

  'run locks and due work': {
    objects: ['workflow_runs_guard', 'workflow_runs_due'],
    check: async (f) => {
      const workflow = await f.workflow()
      const enrolled = async () => {
        const of = { organization: f.team, booking: await f.booking(), workflow }
        return {
          ...of,
          enrollment: await accepted(insert(f.pool, 'workflow_enrollments', f.enrollmentRow(of))),
        }
      }
      const runOf = (of: Awaited<ReturnType<typeof enrolled>>) => (db: pg.PoolClient) =>
        insert(db, 'workflow_runs', f.runRow(of))
      await locksOrganization(f, f.team, runOf(await enrolled()))
      await organizationFirst(
        f,
        f.team,
        { table: 'workflow_definitions', id: workflow },
        runOf(await enrolled()),
      )
      // A new run and the workflow's deletion take turns, as an enrollment and the deletion do.
      const pending = await enrolled()
      const deletion = (db: pg.PoolClient) =>
        db.query('UPDATE workflow_definitions SET enabled=false,deleted_at=now() WHERE id=$1', [
          workflow,
        ])
      const runLater = await enrolled()
      await takesTurns(f, 'run first', runOf(pending), deletion)
      await refused(f.pool, check('workflow_runs_live_workflow'), runOf(runLater), 'after deletion')

      // The dispatcher's and the repair's scan of unfinished runs, oldest due first, reads the
      // partial index; finished runs are not in it.
      const due = await planUses(
        f,
        'workflow_runs_due',
        "SELECT id FROM workflow_runs WHERE state IN ('pending','claimed') AND due_at <= $1 ORDER BY due_at,id LIMIT 50",
        [hours(1)],
      )
      expect(due, 'the due scan reads the index').toBe(true)
      const finished = await planUses(
        f,
        'workflow_runs_due',
        "SELECT id FROM workflow_runs WHERE state='completed' ORDER BY due_at,id LIMIT 50",
        [],
      )
      expect(finished, 'finished runs are outside the index').toBe(false)
    },
    mutants: [
      mutant(
        'a run locks the definition before the organization',
        `  IF TG_OP = 'INSERT' THEN
    PERFORM FROM auth.organization WHERE id = NEW.organization_id FOR KEY SHARE;
    SELECT workflow_id INTO workflow`,
        `  IF TG_OP = 'INSERT' THEN
    SELECT workflow_id INTO workflow`,
      ),
      mutant(
        'a new run does not hold off the deletion of its workflow',
        '      WHERE organization_id = NEW.organization_id AND id = workflow AND deleted_at IS NULL\n      FOR SHARE;',
        '      WHERE organization_id = NEW.organization_id AND id = workflow AND deleted_at IS NULL\n      FOR KEY SHARE;',
      ),
      mutant(
        'the due index holds finished runs',
        "ON workflow_runs (due_at, id) WHERE state IN ('pending', 'claimed');",
        'ON workflow_runs (due_at, id);',
      ),
      mutant(
        'the due index leaves claimed runs out',
        "ON workflow_runs (due_at, id) WHERE state IN ('pending', 'claimed');",
        "ON workflow_runs (due_at, id) WHERE state IN ('pending');",
      ),
    ],
  },
  'recipient claims': {
    objects: [
      'workflow_recipient_claims_pkey',
      'workflow_recipient_claims_identity',
      'workflow_recipient_claims_intent',
      'workflow_recipient_claims_run',
      'workflow_recipient_claims_recipient',
      'workflow_recipient_claims_intent_key',
      'workflow_recipient_claims_guard',
      'workflow_recipient_claims_open_run',
      'workflow_recipient_claims_initial_state',
      'workflow_recipient_claims_immutable',
      'workflow_recipient_claims_final',
      'workflow_recipient_claims_retained',
    ],
    check: async (f) => {
      const captured = await f.capture()
      const of = { organization: f.team, run: captured.run, booking: captured.booking }
      /** Another workflow's pending run on the same booking. */
      const runOn = async (booking: string) => {
        const workflow = await f.workflow()
        const at = { organization: f.team, booking, workflow }
        const enrollment = await accepted(
          insert(f.pool, 'workflow_enrollments', f.enrollmentRow(at)),
        )
        return {
          organization: f.team,
          booking,
          run: await accepted(insert(f.pool, 'workflow_runs', f.runRow({ ...at, enrollment }))),
        }
      }
      const id = randomUUID()
      await accepted(insert(f.pool, 'workflow_recipient_claims', f.claimRow(of, { id })))
      await refused(f.pool, unique('workflow_recipient_claims_pkey'), (db) =>
        insert(db, 'workflow_recipient_claims', f.claimRow(of, { id })),
      )
      // A run sends at most once to each address, whichever classes it came from, even when
      // two writers race.
      const hash = digest()
      await race(
        f,
        'concurrent recipients',
        (db) => insert(db, 'workflow_recipient_claims', f.claimRow(of, { recipient_hash: hash })),
        (db) =>
          insert(
            db,
            'workflow_recipient_claims',
            f.claimRow(of, { recipient: `host:${randomUUID()}`, recipient_hash: hash }),
          ),
        unique('workflow_recipient_claims_identity'),
        async () =>
          (
            await f.rows('workflow_recipient_claims', 'run_id=$1 AND recipient_hash=$2', [
              captured.run,
              hash,
            ])
          ).length,
      )
      // One workflow holds an intent (category, offset, address) on a booking; a loser keeps
      // no intent. Other offsets, categories and bookings are other intents.
      const intent = { intent_kind: 'before_start', intent_offset_minutes: 60 }
      const address = digest()
      const rival = await runOn(captured.booking)
      await race(
        f,
        'concurrent intents',
        (db) =>
          insert(
            db,
            'workflow_recipient_claims',
            f.claimRow(of, { ...intent, recipient_hash: address }),
          ),
        (db) =>
          insert(
            db,
            'workflow_recipient_claims',
            f.claimRow(rival, { ...intent, recipient_hash: address }),
          ),
        unique('workflow_recipient_claims_intent'),
        async () =>
          (
            await f.rows(
              'workflow_recipient_claims',
              'booking_id=$1 AND recipient_hash=$2 AND intent_kind IS NOT NULL',
              [captured.booking, address],
            )
          ).length,
      )
      await accepted(
        insert(
          f.pool,
          'workflow_recipient_claims',
          f.claimRow(rival, {
            recipient_hash: address,
            state: 'skipped',
            skip_reason: 'existing_notification',
            finished_at: new Date(),
          }),
        ),
        'the losing workflow keeps the address without the intent',
      )
      for (const [label, overrides] of [
        ['another offset', { intent_kind: 'before_start', intent_offset_minutes: 120 }],
        ['another category', { intent_kind: 'after_end', intent_offset_minutes: 60 }],
      ] as const) {
        const other = await runOn(captured.booking)
        await accepted(
          insert(
            f.pool,
            'workflow_recipient_claims',
            f.claimRow(other, { ...overrides, recipient_hash: address }),
          ),
          label,
        )
      }
      const elsewhere = await f.capture()
      await accepted(
        insert(
          f.pool,
          'workflow_recipient_claims',
          f.claimRow(
            { organization: f.team, run: elsewhere.run, booking: elsewhere.booking },
            { ...intent, recipient_hash: address },
          ),
        ),
        'another booking',
      )

      // A claim belongs to its run's booking and organization.
      const reference = foreignKey('workflow_recipient_claims_run')
      await refused(
        f.pool,
        reference,
        (db) => insert(db, 'workflow_recipient_claims', f.claimRow({ ...of, run: randomUUID() })),
        'an unknown run',
      )
      await refused(
        f.pool,
        reference,
        (db) =>
          insert(
            db,
            'workflow_recipient_claims',
            f.claimRow({ ...of, booking: elsewhere.booking }),
          ),
        "another booking's run",
      )
      // An attendee or host and a 32-byte digest.
      await rolledBack(f.pool, (db) =>
        accepted(
          insert(
            db,
            'workflow_recipient_claims',
            f.claimRow(of, { recipient: `host:${randomUUID()}` }),
          ),
          'a host',
        ),
      )
      for (const [label, overrides] of [
        ['a guest class', { recipient: `guest:${randomUUID()}` }],
        ['an address', { recipient: 'attendee:someone@example.test' }],
        [
          'an ID with an address after it',
          { recipient: `attendee:${randomUUID()} x@example.test` },
        ],
        ['a short digest', { recipient_hash: randomBytes(31) }],
        ['a long digest', { recipient_hash: randomBytes(33) }],
      ] as const)
        await refused(
          f.pool,
          check('workflow_recipient_claims_recipient'),
          (db) => insert(db, 'workflow_recipient_claims', f.claimRow(of, overrides)),
          label,
        )
      // An intent is a timer category with a timer offset, or nothing.
      for (const [label, overrides] of [
        ['the smallest offset', { intent_kind: 'before_start', intent_offset_minutes: 5 }],
        ['the largest offset', { intent_kind: 'after_end', intent_offset_minutes: 43200 }],
      ] as const)
        await rolledBack(f.pool, (db) =>
          accepted(insert(db, 'workflow_recipient_claims', f.claimRow(of, overrides)), label),
        )
      for (const [label, overrides] of [
        ['a category without an offset', { intent_kind: 'before_start' }],
        ['an offset without a category', { intent_offset_minutes: 60 }],
        ['an offset below 5', { intent_kind: 'before_start', intent_offset_minutes: 4 }],
        ['an offset above 43200', { intent_kind: 'after_end', intent_offset_minutes: 43201 }],
        ['a lifecycle category', { intent_kind: 'booking.created', intent_offset_minutes: 60 }],
      ] as const)
        await refused(
          f.pool,
          check('workflow_recipient_claims_intent_key'),
          (db) => insert(db, 'workflow_recipient_claims', f.claimRow(of, overrides)),
          label,
        )
      // Claimed only for an unfinished run, starting pending or skipped.
      await rolledBack(f.pool, async (db) => {
        await accepted(
          db.query(
            `UPDATE workflow_runs SET state='claimed',claim_token=$2,lease_until=now() WHERE id=$1`,
            [captured.run, randomUUID()],
          ),
        )
        await accepted(
          insert(db, 'workflow_recipient_claims', f.claimRow(of)),
          'a recipient of a claimed run',
        )
      })
      const initial = check('workflow_recipient_claims_initial_state')
      for (const [state, overrides] of [
        ['dispatching', { claim_token: randomUUID() }],
        ['sent', { finished_at: new Date() }],
        ['delivery_unknown', { finished_at: new Date() }],
      ] as const)
        await refused(
          f.pool,
          initial,
          (db) => insert(db, 'workflow_recipient_claims', f.claimRow(of, { state, ...overrides })),
          `a new ${state} recipient`,
        )
      const done = await f.capture()
      await accepted(f.finish('workflow_runs', done.run, 'completed'))
      await refused(
        f.pool,
        check('workflow_recipient_claims_open_run'),
        (db) =>
          insert(
            db,
            'workflow_recipient_claims',
            f.claimRow({ organization: f.team, run: done.run, booking: done.booking }),
          ),
        'a finished run',
      )

      // Identity and intent never change; a finished claim is final.
      const immutable = check('workflow_recipient_claims_immutable')
      for (const assignment of [
        `recipient='host:${randomUUID()}'`,
        `recipient_hash='\\x${digest().toString('hex')}'`,
        'intent_kind=NULL,intent_offset_minutes=NULL',
        `run_id='${rival.run}'`,
        "created_at=created_at-interval '1 day'",
        `id='${randomUUID()}'`,
      ])
        await refused(
          f.pool,
          immutable,
          (db) =>
            db.query(`UPDATE workflow_recipient_claims SET ${assignment} WHERE id=$1`, [
              captured.claim,
            ]),
          assignment,
        )
      // The marker, its reversal and a retry are ordinary changes of an unfinished claim.
      for (const assignment of [
        `state='dispatching',claim_token='${randomUUID()}'`,
        "state='pending',claim_token=NULL,attempts=attempts+1,next_attempt_at=now()",
      ])
        await accepted(
          f.pool.query(`UPDATE workflow_recipient_claims SET ${assignment} WHERE id=$1`, [
            captured.claim,
          ]),
          assignment,
        )
      const final = check('workflow_recipient_claims_final')
      for (const state of ['sent', 'rejected', 'delivery_unknown', 'skipped']) {
        const claim = await accepted(
          insert(f.pool, 'workflow_recipient_claims', f.claimRow(of)),
          state,
        )
        await accepted(
          f.pool.query(
            `UPDATE workflow_recipient_claims SET state=$2,finished_at=now(),next_attempt_at=NULL,
              skip_reason=CASE WHEN $2='skipped' THEN 'budget_suppressed' END WHERE id=$1`,
            [claim, state],
          ),
        )
        for (const assignment of [
          "state='pending',finished_at=NULL,skip_reason=NULL",
          `state='dispatching',finished_at=NULL,skip_reason=NULL,claim_token='${randomUUID()}'`,
          'attempts=attempts+1',
        ])
          await refused(
            f.pool,
            final,
            (db) =>
              db.query(`UPDATE workflow_recipient_claims SET ${assignment} WHERE id=$1`, [claim]),
            `${state}: ${assignment}`,
          )
      }
      // Removed only with its run (its booking) or organization.
      await refused(f.pool, check('workflow_recipient_claims_retained'), (db) =>
        db.query('DELETE FROM workflow_recipient_claims WHERE id=$1', [captured.claim]),
      )
      await accepted(f.pool.query('DELETE FROM bookings WHERE id=$1', [captured.booking]))
      expect(
        await f.rows('workflow_recipient_claims', 'booking_id=$1', [captured.booking]),
      ).toEqual([])
      expect(await f.one('workflow_recipient_claims', elsewhere.claim)).toBeDefined()
    },
    mutants: [
      mutant(
        'recipient claim IDs are not unique',
        `CREATE TABLE workflow_recipient_claims (
  id uuid PRIMARY KEY DEFAULT uuidv7(),`,
        `CREATE TABLE workflow_recipient_claims (
  id uuid NOT NULL DEFAULT uuidv7(),`,
      ),
      mutant(
        'a run may claim one address twice',
        'UNIQUE (organization_id, run_id, recipient_hash)',
        'UNIQUE (organization_id, run_id, recipient)',
      ),
      mutant(
        'an intent is held once per booking whatever its offset',
        'UNIQUE (booking_id, intent_kind, intent_offset_minutes, recipient_hash)',
        'UNIQUE (booking_id, intent_kind, recipient_hash)',
      ),
      mutant(
        'an intent is held once per booking whatever its category',
        'UNIQUE (booking_id, intent_kind, intent_offset_minutes, recipient_hash)',
        'UNIQUE (booking_id, intent_offset_minutes, recipient_hash)',
      ),
      mutant(
        'an intent is held once on the instance',
        'UNIQUE (booking_id, intent_kind, intent_offset_minutes, recipient_hash)',
        'UNIQUE (intent_kind, intent_offset_minutes, recipient_hash)',
      ),
      mutant(
        'several workflows may hold one intent',
        `  CONSTRAINT workflow_recipient_claims_intent
    UNIQUE (booking_id, intent_kind, intent_offset_minutes, recipient_hash),
`,
      ),
      mutant(
        "a claim may name another booking than its run's",
        `  CONSTRAINT workflow_recipient_claims_run FOREIGN KEY (organization_id, run_id, booking_id)
    REFERENCES workflow_runs (organization_id, id, booking_id) ON DELETE CASCADE,`,
        `  CONSTRAINT workflow_recipient_claims_run FOREIGN KEY (run_id)
    REFERENCES workflow_runs (id) ON DELETE CASCADE,`,
      ),
      mutant(
        'claims block their booking deletion',
        '    REFERENCES workflow_runs (organization_id, id, booking_id) ON DELETE CASCADE,',
        '    REFERENCES workflow_runs (organization_id, id, booking_id),',
      ),
      mutant(
        'any recipient class',
        "recipient ~ '^(attendee|host):[0-9a-f]",
        "recipient ~ '^[a-z]+:[0-9a-f]",
      ),
      mutant(
        'a recipient may be an address',
        "[0-9a-f]{12}$'\n    AND octet_length(recipient_hash) = 32",
        "[0-9a-f]{12}'\n    AND octet_length(recipient_hash) = 32",
      ),
      mutant(
        'a digest of any length',
        '    AND octet_length(recipient_hash) = 32\n',
        '    AND octet_length(recipient_hash) > 0\n',
      ),
      mutant(
        'an intent may lack its offset',
        '    (intent_kind IS NULL AND intent_offset_minutes IS NULL)',
        '    (intent_offset_minutes IS NULL)',
      ),
      mutant(
        'an intent offset below the smallest timer offset',
        '      AND intent_offset_minutes BETWEEN 5 AND 43200)',
        '      AND intent_offset_minutes BETWEEN 4 AND 43200)',
      ),
      mutant(
        'an intent offset above the largest offset',
        '      AND intent_offset_minutes BETWEEN 5 AND 43200)',
        '      AND intent_offset_minutes BETWEEN 5 AND 43201)',
      ),
      mutant(
        'a lifecycle intent',
        "    OR (intent_kind IN ('before_start', 'after_end')",
        "    OR (intent_kind IN ('before_start', 'after_end', 'booking.created')",
      ),
      mutant(
        'a finished run takes recipients',
        "    IF FOUND AND run_state NOT IN ('pending', 'claimed') THEN",
        '    IF false THEN',
      ),
      mutant(
        'a recipient may start dispatching',
        "    IF NEW.state NOT IN ('pending', 'skipped') THEN\n      RAISE EXCEPTION 'a recipient claim starts pending or skipped'",
        "    IF NEW.state NOT IN ('pending', 'skipped', 'dispatching') THEN\n      RAISE EXCEPTION 'a recipient claim starts pending or skipped'",
      ),
      ...[
        [
          'address digest',
          'NEW.recipient,\n         NEW.recipient_hash',
          'NEW.recipient,\n         OLD.recipient_hash',
        ],
        ['recipient', 'NEW.booking_id, NEW.recipient,', 'NEW.booking_id, OLD.recipient,'],
        [
          'intent',
          'NEW.intent_kind, NEW.intent_offset_minutes, NEW.created_at)',
          'OLD.intent_kind, OLD.intent_offset_minutes, NEW.created_at)',
        ],
        [
          'run',
          'ROW(NEW.id, NEW.organization_id, NEW.run_id, NEW.booking_id,',
          'ROW(NEW.id, NEW.organization_id, OLD.run_id, NEW.booking_id,',
        ],
      ].map(([what, before, after]) =>
        mutant(`a recipient's ${what} is mutable`, before as string, after as string),
      ),
      mutant(
        'a sent recipient can be sent again',
        "  IF OLD.state IN ('sent', 'rejected', 'delivery_unknown', 'skipped') THEN",
        "  IF OLD.state IN ('rejected', 'delivery_unknown', 'skipped') THEN",
      ),
      mutant(
        'an ambiguous attempt can be retried',
        "  IF OLD.state IN ('sent', 'rejected', 'delivery_unknown', 'skipped') THEN",
        "  IF OLD.state IN ('sent', 'rejected', 'skipped') THEN",
      ),
      mutant(
        'a skipped recipient can be revived',
        "  IF OLD.state IN ('sent', 'rejected', 'delivery_unknown', 'skipped') THEN",
        "  IF OLD.state IN ('sent', 'rejected', 'delivery_unknown') THEN",
      ),
      mutant(
        'claims can be deleted on their own',
        `    IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)
       AND EXISTS (SELECT FROM public.workflow_runs WHERE id = OLD.run_id) THEN`,
        '    IF false THEN',
      ),
    ],
  },

  'recipient claim states': {
    objects: ['workflow_recipient_claims_state', 'workflow_recipient_claims_updated_at'],
    check: async (f) => {
      const captured = await f.capture()
      const update = (assignment: string) => (db: pg.PoolClient) =>
        db.query(`UPDATE workflow_recipient_claims SET ${assignment} WHERE id=$1`, [captured.claim])
      const token = randomUUID()
      const valid = [
        `state='dispatching',claim_token='${token}'`,
        "next_attempt_at=now()+interval '1 minute',attempts=3",
        "state='sent',finished_at=now()",
        "state='rejected',finished_at=now()",
        "state='delivery_unknown',finished_at=now()",
        ...skipReasons.map((reason) => `state='skipped',skip_reason='${reason}',finished_at=now()`),
      ]
      for (const assignment of valid)
        await rolledBack(f.pool, (db) => accepted(update(assignment)(db), assignment))
      const invalid = [
        'attempts=-1',
        `claim_token='${token}'`,
        'finished_at=now()',
        "skip_reason='expired'",
        "state='dispatching'",
        `state='dispatching',claim_token='${token}',next_attempt_at=now()`,
        `state='dispatching',claim_token='${token}',finished_at=now()`,
        `state='dispatching',claim_token='${token}',skip_reason='expired'`,
        "state='sent'",
        `state='sent',finished_at=now(),claim_token='${token}'`,
        "state='rejected',finished_at=now(),next_attempt_at=now()",
        "state='delivery_unknown',finished_at=now(),skip_reason='expired'",
        "state='skipped',finished_at=now()",
        "state='skipped',skip_reason='expired'",
        "state='skipped',skip_reason='spam',finished_at=now()",
        `state='skipped',skip_reason='expired',finished_at=now(),claim_token='${token}'`,
        "state='skipped',skip_reason='expired',finished_at=now(),next_attempt_at=now()",
        "state='bounced',finished_at=now()",
      ]
      for (const assignment of invalid)
        await refused(
          f.pool,
          check('workflow_recipient_claims_state'),
          update(assignment),
          assignment,
        )
      const { rows } = await f.pool.query<{ later: boolean }>(
        `UPDATE workflow_recipient_claims SET attempts=1 WHERE id=$1
        RETURNING updated_at > created_at AS later`,
        [captured.claim],
      )
      expect(rows[0]?.later, 'a change stamps the update time').toBe(true)
    },
    mutants: [
      mutant('negative attempts', 'CHECK (attempts >= 0 AND (', 'CHECK (attempts >= -1 AND ('),
      mutant(
        'a pending recipient may hold a claim token',
        "WHEN state = 'pending' THEN num_nonnulls(skip_reason, claim_token, finished_at) = 0",
        "WHEN state = 'pending' THEN num_nonnulls(skip_reason, finished_at) = 0",
      ),
      mutant(
        'a marker without its claim token',
        '        claim_token IS NOT NULL AND num_nonnulls(skip_reason, next_attempt_at, finished_at) = 0',
        '        num_nonnulls(skip_reason, next_attempt_at, finished_at) = 0',
      ),
      mutant(
        'a marker with a scheduled retry',
        '        claim_token IS NOT NULL AND num_nonnulls(skip_reason, next_attempt_at, finished_at) = 0',
        '        claim_token IS NOT NULL AND num_nonnulls(skip_reason, finished_at) = 0',
      ),
      mutant(
        'a sent recipient may keep its claim token',
        "      WHEN state IN ('sent', 'rejected', 'delivery_unknown') THEN\n        finished_at IS NOT NULL AND num_nonnulls(skip_reason, claim_token, next_attempt_at) = 0",
        "      WHEN state IN ('sent', 'rejected', 'delivery_unknown') THEN\n        finished_at IS NOT NULL AND num_nonnulls(skip_reason, next_attempt_at) = 0",
      ),
      mutant(
        'a sent recipient may lack its finish time',
        "      WHEN state IN ('sent', 'rejected', 'delivery_unknown') THEN\n        finished_at IS NOT NULL AND",
        "      WHEN state IN ('sent', 'rejected', 'delivery_unknown') THEN\n        true AND",
      ),
      mutant(
        'a skipped recipient may keep a scheduled retry',
        '        finished_at IS NOT NULL AND num_nonnulls(claim_token, next_attempt_at) = 0\n        AND skip_reason IN',
        '        finished_at IS NOT NULL AND num_nonnulls(claim_token) = 0\n        AND skip_reason IN',
      ),
      mutant(
        'a recipient in any other state',
        `      ELSE false
    END
  ) IS TRUE)
);
CREATE TRIGGER workflow_recipient_claims_updated_at`,
        `      ELSE true
    END
  ) IS TRUE)
);
CREATE TRIGGER workflow_recipient_claims_updated_at`,
      ),
      mutant(
        'recipient updates keep the update time',
        'CREATE TRIGGER workflow_recipient_claims_updated_at BEFORE UPDATE',
        'CREATE TRIGGER workflow_recipient_claims_updated_at BEFORE INSERT',
      ),
    ],
  },

  'recipient claim locks': {
    objects: ['workflow_recipient_claims_guard'],
    check: async (f) => {
      const captured = await f.capture()
      const of = { organization: f.team, run: captured.run, booking: captured.booking }
      const write = (db: pg.PoolClient) => insert(db, 'workflow_recipient_claims', f.claimRow(of))
      await locksOrganization(f, f.team, write)
      await organizationFirst(f, f.team, { table: 'workflow_runs', id: captured.run }, write)
      // A new recipient and the run's retirement take turns on the run row.
      await takesTurns(f, 'recipient first', write, (db) =>
        db.query(`UPDATE workflow_runs SET state='retired',finished_at=now() WHERE id=$1`, [
          captured.run,
        ]),
      )
      await refused(f.pool, check('workflow_recipient_claims_open_run'), write, 'after retirement')
    },
    mutants: [
      mutant(
        'a recipient locks its run before the organization',
        `  IF TG_OP = 'INSERT' THEN
    PERFORM FROM auth.organization WHERE id = NEW.organization_id FOR KEY SHARE;
    SELECT state INTO run_state`,
        `  IF TG_OP = 'INSERT' THEN
    SELECT state INTO run_state`,
      ),
      mutant(
        'a new recipient does not hold off its run',
        '      WHERE organization_id = NEW.organization_id AND id = NEW.run_id FOR SHARE;',
        '      WHERE organization_id = NEW.organization_id AND id = NEW.run_id;',
      ),
    ],
  },

  'run history': {
    objects: [
      'workflow_run_history_pkey',
      'workflow_run_history_workflow',
      'workflow_run_history_trigger',
      'workflow_run_history_outcome',
      'workflow_run_history_guard',
      'workflow_run_history_immutable',
      'workflow_run_history_page',
      'workflow_run_history_retention',
    ],
    check: async (f) => {
      const workflow = await f.workflow()
      const of = { organization: f.team, workflow }
      const store = (overrides: Row) => (db: Connection) =>
        insert(db, 'workflow_run_history', f.historyRow(of, overrides))
      // One record per run: a replayed finish cannot add a second, even when two race.
      const run = randomUUID()
      await race(
        f,
        'concurrent history',
        store({ run_id: run }),
        store({ run_id: run, outcome: 'retired' }),
        unique('workflow_run_history_pkey'),
        async () => (await f.rows('workflow_run_history', 'run_id=$1', [run])).length,
      )
      // Of a workflow of its organization.
      const reference = foreignKey('workflow_run_history_workflow')
      await refused(f.pool, reference, store({ workflow_id: randomUUID() }), 'an unknown workflow')
      const foreign = await f.workflow(f.otherTeam)
      await refused(f.pool, reference, store({ workflow_id: foreign }), "another organization's")
      // Fixed triggers, outcomes and reasons, and counts.
      for (const trigger of [
        'booking.created',
        'booking.cancelled',
        'booking.rescheduled',
        'before_start',
        'after_end',
      ])
        await rolledBack(f.pool, (db) => accepted(store({ trigger })(db), trigger))
      await refused(
        f.pool,
        check('workflow_run_history_trigger'),
        store({ trigger: 'booking.attendee_no_show_changed' }),
        'an unknown trigger',
      )
      for (const overrides of [
        { outcome: 'retired' },
        { sent: 3, rejected: 1, delivery_unknown: 1, skipped: 2 },
        ...skipReasons.map((reason) => ({ outcome: 'skipped', reason })),
      ])
        await rolledBack(f.pool, (db) => accepted(store(overrides)(db), JSON.stringify(overrides)))
      const outcome = check('workflow_run_history_outcome')
      for (const overrides of [
        { revision: 0 },
        { sent: -1 },
        { rejected: -1 },
        { delivery_unknown: -1 },
        { skipped: -1 },
        { outcome: 'completed', reason: 'expired' },
        { outcome: 'retired', reason: 'expired' },
        { outcome: 'skipped' },
        { outcome: 'skipped', reason: 'smtp_refused' },
        { outcome: 'sent' },
      ])
        await refused(f.pool, outcome, store(overrides), JSON.stringify(overrides))
      // Immutable; retention deletes it, and it outlives the booking.
      const captured = await f.capture()
      await accepted(
        insert(
          f.pool,
          'workflow_run_history',
          f.historyRow(
            { organization: f.team, workflow: captured.workflow },
            { run_id: captured.run },
          ),
        ),
      )
      for (const assignment of ["outcome='retired'", 'finished_at=now()', 'sent=sent+1'])
        await refused(
          f.pool,
          check('workflow_run_history_immutable'),
          (db) =>
            db.query(`UPDATE workflow_run_history SET ${assignment} WHERE run_id=$1`, [
              captured.run,
            ]),
          assignment,
        )
      await accepted(f.pool.query('DELETE FROM bookings WHERE id=$1', [captured.booking]))
      expect(await f.one('workflow_run_history', captured.run), 'after the booking').toBeDefined()
      await accepted(
        f.pool.query('DELETE FROM workflow_run_history WHERE run_id=$1', [captured.run]),
        'retention',
      )
      // It goes with its workflow's purge.
      await f.tombstone(workflow)
      await accepted(f.pool.query('DELETE FROM workflow_definitions WHERE id=$1', [workflow]))
      expect(await f.rows('workflow_run_history', 'workflow_id=$1', [workflow])).toEqual([])
      // Written after the organization lock, before the definition's.
      const kept = await f.workflow()
      const write = (db: pg.PoolClient) =>
        insert(db, 'workflow_run_history', f.historyRow({ organization: f.team, workflow: kept }))
      await locksOrganization(f, f.team, write)
      await organizationFirst(f, f.team, { table: 'workflow_definitions', id: kept }, write)
      // A workflow's history page and the retention sweep read their indexes.
      expect(
        await planUses(
          f,
          'workflow_run_history_page',
          'SELECT run_id FROM workflow_run_history WHERE organization_id=$1 AND workflow_id=$2 ORDER BY finished_at DESC LIMIT 20',
          [f.team, kept],
          ['organization_id', 'workflow_id'],
        ),
        'history page',
      ).toBe(true)
      expect(
        await planUses(
          f,
          'workflow_run_history_retention',
          'SELECT run_id FROM workflow_run_history WHERE finished_at < $1',
          [hours(-720)],
        ),
        'retention sweep',
      ).toBe(true)
    },
    mutants: [
      mutant('history may repeat a run', '  run_id uuid PRIMARY KEY,', '  run_id uuid NOT NULL,'),
      mutant(
        "history may name another organization's workflow",
        `  CONSTRAINT workflow_run_history_workflow FOREIGN KEY (organization_id, workflow_id)
    REFERENCES workflow_definitions (organization_id, id) ON DELETE CASCADE,`,
        `  CONSTRAINT workflow_run_history_workflow FOREIGN KEY (workflow_id)
    REFERENCES workflow_definitions (id) ON DELETE CASCADE,`,
      ),
      mutant(
        'history blocks its workflow purge',
        '    REFERENCES workflow_definitions (organization_id, id) ON DELETE CASCADE,\n  CONSTRAINT workflow_run_history_trigger',
        '    REFERENCES workflow_definitions (organization_id, id),\n  CONSTRAINT workflow_run_history_trigger',
      ),
      mutant(
        'history of an unknown trigger',
        "CHECK (trigger IN ('booking.created',\n    'booking.cancelled',",
        "CHECK (trigger IS NOT NULL OR trigger IN ('booking.created',\n    'booking.cancelled',",
      ),
      mutant('a revision 0', '    revision >= 1\n', '    revision >= 0\n'),
      mutant(
        'negative counts',
        'least(sent, rejected, delivery_unknown, skipped) >= 0',
        'least(sent, rejected, delivery_unknown) >= 0',
      ),
      mutant(
        'a reason for a completed run',
        "    AND ((outcome IN ('completed', 'retired') AND reason IS NULL)",
        "    AND ((outcome IN ('completed', 'retired'))",
      ),
      mutant(
        'a skipped run without a reason',
        "      OR (outcome = 'skipped' AND reason IN ('condition_false', 'existing_notification',",
        "      OR (outcome = 'skipped' AND reason IS NULL OR reason IN ('condition_false', 'existing_notification',",
      ),
      mutant(
        'history can be rewritten',
        `  RAISE EXCEPTION 'workflow run history is immutable'`,
        `  RETURN NEW;
  RAISE EXCEPTION 'workflow run history is immutable'`,
      ),
      mutant(
        'history locks the definition before the organization',
        `  IF TG_OP = 'INSERT' THEN
    PERFORM FROM auth.organization WHERE id = NEW.organization_id FOR KEY SHARE;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'workflow run history is immutable'`,
        `  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'workflow run history is immutable'`,
      ),
      mutant(
        'the history page is not indexed by workflow',
        'ON workflow_run_history (organization_id, workflow_id, finished_at);',
        'ON workflow_run_history (organization_id, finished_at);',
      ),
      mutant(
        'the retention sweep is not indexed',
        'CREATE INDEX workflow_run_history_retention ON workflow_run_history (finished_at);',
        'CREATE INDEX workflow_run_history_retention ON workflow_run_history (finished_at) WHERE outcome = $$skipped$$;',
      ),
    ],
  },

  'mail reservations and the shared ledger': {
    objects: [
      'workflow_mail_reservations_pkey',
      'workflow_mail_reservations_organization_id_fkey',
      'workflow_mail_reservations_claim',
      'workflow_mail_reservations_owner',
      'workflow_mail_reservations_retention',
      'workflow_mail_reservations_guard',
      'workflow_mail_reservations_charged',
      'workflow_mail_reservations_immutable',
      'workflow_mail_reservations_restamp',
      'notification_email_sends_workflow_recipient',
      'notification_email_sends_workflow_reservation',
    ],
    check: async (f) => {
      const captured = await f.capture()
      const of = { organization: f.team, run: captured.run, claim: captured.claim }
      const reserve =
        (overrides: Row = {}) =>
        (db: Connection) =>
          insert(db, 'workflow_mail_reservations', f.reservationRow(of, overrides))
      const id = randomUUID()
      await accepted(reserve({ id, claim_id: randomUUID() })(f.pool))
      await refused(f.pool, unique('workflow_mail_reservations_pkey'), reserve({ id }))
      // One reservation per recipient claim, even when two admissions race …
      await race(
        f,
        'concurrent admissions',
        reserve(),
        reserve(),
        unique('workflow_mail_reservations_claim'),
        async () =>
          (await f.rows('workflow_mail_reservations', 'claim_id=$1', [captured.claim])).length,
      )
      const reservation = (
        await f.rows('workflow_mail_reservations', 'claim_id=$1', [captured.claim])
      )[0]?.id as string
      // … and one ledger charge per reservation; a retry restamps it instead of adding one.
      await race(
        f,
        'concurrent charges',
        (db) => charge(db, reservation),
        (db) => charge(db, reservation),
        unique('notification_email_sends_workflow_reservation'),
        async () =>
          (await f.rows('notification_email_sends', 'workflow_reservation_id=$1', [reservation]))
            .length,
      )
      // Core rows keep NULL, any number of them, a host's without a digest; a workflow charge
      // always counts against a recipient digest.
      await rolledBack(f.pool, async (db) => {
        for (const hash of [digest(), digest(), null, null])
          await accepted(charge(db, null, hash), 'a core charge')
      })
      await refused(
        f.pool,
        check('notification_email_sends_workflow_recipient'),
        (db) => charge(db, randomUUID(), null),
        'a workflow charge without a digest',
      )
      // The owner organization exists; its deletion removes its reservations but not the
      // charges in the shared ledger.
      await refused(
        f.pool,
        foreignKey('workflow_mail_reservations_organization_id_fkey'),
        reserve({ organization_id: randomUUID(), claim_id: randomUUID() }),
        'an unknown owner',
      )
      await locksOrganization(f, f.team, reserve({ claim_id: randomUUID() }))
      // Deleting the booking, its run or the workflow never removes a charge.
      await accepted(f.pool.query('DELETE FROM bookings WHERE id=$1', [captured.booking]))
      await f.tombstone(captured.workflow)
      await accepted(
        f.pool.query('DELETE FROM workflow_definitions WHERE id=$1', [captured.workflow]),
      )
      expect(await f.one('workflow_mail_reservations', reservation), 'reservation').toBeDefined()
      expect(
        await f.rows('notification_email_sends', 'workflow_reservation_id=$1', [reservation]),
        'charge',
      ).toHaveLength(1)
      // Owner, run and claim never change; the time moves only forward.
      for (const assignment of [
        `claim_id='${randomUUID()}'`,
        `run_id='${randomUUID()}'`,
        `organization_id='${f.otherTeam}'`,
        `id='${randomUUID()}'`,
      ])
        await refused(
          f.pool,
          check('workflow_mail_reservations_immutable'),
          (db) =>
            db.query(`UPDATE workflow_mail_reservations SET ${assignment} WHERE id=$1`, [
              reservation,
            ]),
          assignment,
        )
      await refused(f.pool, check('workflow_mail_reservations_restamp'), (db) =>
        db.query(
          "UPDATE workflow_mail_reservations SET reserved_at=reserved_at-interval '1 minute' WHERE id=$1",
          [reservation],
        ),
      )
      await accepted(
        f.pool.query(
          "UPDATE workflow_mail_reservations SET reserved_at=reserved_at+interval '1 minute' WHERE id=$1",
          [reservation],
        ),
        'a retry restamps forward',
      )
      // A reservation stays while its charge does; after the ledger's purge it can go.
      await refused(f.pool, check('workflow_mail_reservations_charged'), (db) =>
        db.query('DELETE FROM workflow_mail_reservations WHERE id=$1', [reservation]),
      )
      await accepted(
        f.pool.query('DELETE FROM notification_email_sends WHERE workflow_reservation_id=$1', [
          reservation,
        ]),
      )
      await accepted(
        f.pool.query('DELETE FROM workflow_mail_reservations WHERE id=$1', [reservation]),
      )
      // The owner's sliding-hour count and the cleanup sweep read their indexes.
      expect(
        await planUses(
          f,
          'workflow_mail_reservations_owner',
          'SELECT count(*) FROM workflow_mail_reservations WHERE organization_id=$1 AND reserved_at > $2',
          [f.team, hours(-1)],
        ),
        'owner count',
      ).toBe(true)
      expect(
        await planUses(
          f,
          'workflow_mail_reservations_retention',
          'SELECT id FROM workflow_mail_reservations WHERE reserved_at < $1',
          [hours(-48)],
        ),
        'cleanup sweep',
      ).toBe(true)
      // The organization's deletion removes its reservations; the ledger keeps the charge.
      const gone = await f.newOrganization('deleted team')
      const kept = randomUUID()
      await accepted(reserve({ organization_id: gone, claim_id: randomUUID(), id: kept })(f.pool))
      await accepted(charge(f.pool, kept))
      await accepted(f.pool.query('DELETE FROM auth.organization WHERE id=$1', [gone]))
      expect(await f.one('workflow_mail_reservations', kept)).toBeUndefined()
      expect(
        await f.rows('notification_email_sends', 'workflow_reservation_id=$1', [kept]),
      ).toHaveLength(1)
    },
    mutants: [
      mutant(
        'reservation IDs are not unique',
        `CREATE TABLE workflow_mail_reservations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),`,
        `CREATE TABLE workflow_mail_reservations (
  id uuid NOT NULL DEFAULT uuidv7(),`,
      ),
      mutant(
        'a claim may be reserved twice',
        '  CONSTRAINT workflow_mail_reservations_claim UNIQUE (claim_id)\n',
        '  CONSTRAINT workflow_mail_reservations_claim UNIQUE (claim_id, reserved_at)\n',
      ),
      mutant(
        'reservations block their owner deletion',
        `  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  claim_id`,
        `  organization_id uuid NOT NULL REFERENCES auth.organization (id),
  run_id uuid NOT NULL,
  claim_id`,
      ),
      mutant(
        'a reservation may be charged twice',
        'CREATE UNIQUE INDEX notification_email_sends_workflow_reservation',
        'CREATE INDEX notification_email_sends_workflow_reservation',
      ),
      mutant(
        'a workflow charge without a digest',
        'CHECK (workflow_reservation_id IS NULL OR recipient_hash IS NOT NULL);',
        'CHECK (workflow_reservation_id IS NULL OR recipient_hash IS NULL OR true);',
      ),
      mutant(
        'a charged reservation can be deleted',
        `       AND EXISTS (SELECT FROM public.notification_email_sends
         WHERE workflow_reservation_id = OLD.id) THEN`,
        '       AND false THEN',
      ),
      mutant(
        'a reservation can move to another claim',
        'IF ROW(NEW.id, NEW.organization_id, NEW.run_id, NEW.claim_id)',
        'IF ROW(NEW.id, NEW.organization_id, NEW.run_id, OLD.claim_id)',
      ),
      mutant(
        'a reservation can move to another owner',
        'IF ROW(NEW.id, NEW.organization_id, NEW.run_id, NEW.claim_id)',
        'IF ROW(NEW.id, OLD.organization_id, NEW.run_id, NEW.claim_id)',
      ),
      mutant(
        'a reservation can be restamped backwards',
        '  IF NEW.reserved_at < OLD.reserved_at THEN',
        "  IF NEW.reserved_at < OLD.reserved_at - interval '1 hour' THEN",
      ),
      mutant(
        'the owner count is not indexed',
        'ON workflow_mail_reservations (organization_id, reserved_at);',
        'ON workflow_mail_reservations (run_id, reserved_at);',
      ),
      mutant(
        'the cleanup sweep is not indexed',
        'CREATE INDEX workflow_mail_reservations_retention ON workflow_mail_reservations (reserved_at);',
        'CREATE INDEX workflow_mail_reservations_retention ON workflow_mail_reservations (claim_id);',
      ),
    ],
  },

  'deletion and retention cannot revive a dispatch': {
    objects: ['workflow_definitions_purge', 'workflow_definitions_unfinished_runs'],
    check: async (f) => {
      const unfinished = check('workflow_definitions_unfinished_runs')
      const purge = (workflow: string) => (db: Connection) =>
        db.query('DELETE FROM workflow_definitions WHERE id=$1', [workflow])
      // A tombstone: its retired run stays retired, and nothing new is captured for it.
      const deleted = await f.capture()
      await f.tombstone(deleted.workflow)
      await accepted(f.finish('workflow_runs', deleted.run, 'retired'))
      await refused(f.pool, check('workflow_runs_final'), (db) =>
        db.query("UPDATE workflow_runs SET state='pending',finished_at=NULL WHERE id=$1", [
          deleted.run,
        ]),
      )
      await refused(
        f.pool,
        check('workflow_enrollments_live_workflow'),
        async (db) =>
          insert(
            db,
            'workflow_enrollments',
            f.enrollmentRow({
              organization: f.team,
              booking: await f.booking(),
              workflow: deleted.workflow,
            }),
          ),
        'a capture after the tombstone',
      )
      // A purge waits until none of the workflow's runs is unfinished, claimed or pending; a
      // bystander's pending run does not hold it.
      const bystander = await f.capture()
      const purged = await f.capture()
      await accepted(
        insert(
          f.pool,
          'workflow_run_history',
          f.historyRow({ organization: f.team, workflow: purged.workflow }),
        ),
      )
      await accepted(
        f.pool.query(
          `UPDATE workflow_runs SET state='claimed',claim_token=$2,lease_until=now() WHERE id=$1`,
          [purged.run, randomUUID()],
        ),
      )
      await f.tombstone(purged.workflow)
      await refused(f.pool, unfinished, purge(purged.workflow), 'a claimed run')
      await accepted(
        f.pool.query(
          `UPDATE workflow_runs SET state='pending',claim_token=NULL,lease_until=NULL WHERE id=$1`,
          [purged.run],
        ),
      )
      await refused(f.pool, unfinished, purge(purged.workflow), 'a pending run')
      await accepted(f.finish('workflow_runs', purged.run, 'retired'))
      await accepted(purge(purged.workflow)(f.pool), 'the purge')
      // The purge removes the definition, its revisions and history, never the identity of
      // what the booking captured; capture and repair meet it and cannot dispatch again.
      expect(await f.rows('workflow_definitions', 'id=$1', [purged.workflow])).toEqual([])
      expect(await f.rows('workflow_revisions', 'workflow_id=$1', [purged.workflow])).toEqual([])
      expect(await f.rows('workflow_run_history', 'workflow_id=$1', [purged.workflow])).toEqual([])
      expect(await f.one('workflow_enrollments', purged.enrollment), 'enrollment').toBeDefined()
      expect(await f.one('workflow_runs', purged.run), 'run').toMatchObject({ state: 'retired' })
      expect(await f.one('workflow_recipient_claims', purged.claim), 'claim').toBeDefined()
      await refused(
        f.pool,
        check('workflow_enrollments_live_workflow'),
        (db) =>
          insert(
            db,
            'workflow_enrollments',
            f.enrollmentRow({
              organization: f.team,
              booking: purged.booking,
              workflow: purged.workflow,
            }),
          ),
        'a replayed capture after the purge',
      )
      await refused(
        f.pool,
        check('workflow_runs_live_workflow'),
        (db) =>
          insert(
            db,
            'workflow_runs',
            f.runRow({
              organization: f.team,
              enrollment: purged.enrollment,
              booking: purged.booking,
            }),
          ),
        'a repaired run after the purge',
      )
      await refused(f.pool, check('workflow_runs_final'), (db) =>
        db.query("UPDATE workflow_runs SET state='pending',finished_at=NULL WHERE id=$1", [
          purged.run,
        ]),
      )
      expect(await f.one('workflow_runs', bystander.run), 'bystander').toMatchObject({
        state: 'pending',
      })
      // The cleanup of a finished run removes its history; the run stays, final, and its
      // identity refuses a second run for the same capture.
      const cleaned = await f.capture()
      await accepted(f.finish('workflow_runs', cleaned.run, 'completed'))
      await accepted(
        insert(
          f.pool,
          'workflow_run_history',
          f.historyRow(
            { organization: f.team, workflow: cleaned.workflow },
            { run_id: cleaned.run },
          ),
        ),
      )
      await accepted(
        f.pool.query('DELETE FROM workflow_run_history WHERE run_id=$1', [cleaned.run]),
        'history retention',
      )
      await refused(f.pool, check('workflow_runs_retained'), (db) =>
        db.query('DELETE FROM workflow_runs WHERE id=$1', [cleaned.run]),
      )
      await refused(
        f.pool,
        unique('workflow_runs_identity'),
        (db) =>
          insert(
            db,
            'workflow_runs',
            f.runRow({
              organization: f.team,
              enrollment: cleaned.enrollment,
              booking: cleaned.booking,
            }),
          ),
        'a second run for the cleaned capture',
      )
      // With its organization or its personal owner a workflow goes even with unfinished runs;
      // without the personal marker, the owner's deletion leaves the organization's bookings.
      const personal = await f.capture(f.personal)
      await accepted(f.pool.query('DELETE FROM personal_organizations WHERE user_id=$1', [f.owner]))
      await accepted(f.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.owner]))
      expect(await f.rows('workflow_definitions', 'id=$1', [personal.workflow])).toEqual([])
      expect(await f.one('workflow_runs', personal.run), 'the run stays').toBeDefined()
      const team = await f.newOrganization('deleted team')
      const doomed = await f.capture(team)
      await accepted(f.pool.query('DELETE FROM auth.organization WHERE id=$1', [team]))
      for (const [table, key] of [
        ['workflow_enrollments', doomed.enrollment],
        ['workflow_runs', doomed.run],
        ['workflow_recipient_claims', doomed.claim],
      ] as const)
        expect(await f.one(table, key), table).toBeUndefined()
    },
    mutants: [
      mutant(
        'a workflow with a claimed run can be purged',
        "         AND r.state IN ('pending', 'claimed')) THEN",
        "         AND r.state IN ('pending')) THEN",
      ),
      mutant(
        'a workflow with a pending run can be purged',
        "         AND r.state IN ('pending', 'claimed')) THEN",
        "         AND r.state IN ('claimed')) THEN",
      ),
      mutant(
        "another workflow's runs hold a purge",
        '       WHERE e.organization_id = OLD.organization_id AND e.workflow_id = OLD.id',
        '       WHERE e.organization_id = OLD.organization_id',
      ),
      mutant(
        "a personal owner's deletion waits for unfinished runs",
        `     AND (OLD.owner_user_id IS NULL
       OR EXISTS (SELECT FROM auth."user" WHERE id = OLD.owner_user_id))
     AND EXISTS (SELECT FROM public.workflow_enrollments e`,
        `     AND EXISTS (SELECT FROM public.workflow_enrollments e`,
      ),
    ],
  },
}

/** Runs every protection on its own fixture; the error names the first failing check. */
export async function assertExecutionStorageProtections(pool: pg.Pool): Promise<void> {
  for (const [name, { check }] of Object.entries(executionProtections)) {
    try {
      await check(await executionFixture(pool))
    } catch (error) {
      if (error instanceof Error) error.message = `[${name}] ${error.message}`
      throw error
    }
  }
}
