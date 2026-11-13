// The workflow lock order (docs/data-model.md, "Workflow execution storage") as the SQL that
// the later steps' writers issue: every workflow writer locks the owner organization first
// (after any identity lock the existing order puts before it), before the shared mail-budget
// lock and before any definition or run row, and a writer that
// touches both definitions and runs locks the definition before its runs. Storage test support
// only: no production module imports it, and it holds no step's logic (which runs a deletion or
// a reschedule retires, what capture enrolls, budgets or authority). The lock-order test races
// each reversed order into a deadlock and each documented order to completion, and later steps
// reuse these statements and `interleave` for their own races.
import { setTimeout } from 'node:timers/promises'
import type pg from 'pg'

/**
 * Every workflow writer's first workflow lock: the owner organization, at the strength the
 * workflow foreign keys and guards take, before the mail budget and before any definition or
 * run row. Identity locks that the existing order puts before the organization (a personal
 * owner's user row, as `lockOrganization` takes it) still come first.
 */
export async function lockWorkflowOrganization(db: pg.PoolClient, organization: string) {
  await db.query('SELECT id FROM auth.organization WHERE id=$1 FOR KEY SHARE', [organization])
}

/**
 * The shared mail-budget lock, the statement of `lockNotificationEmailBudget`
 * (packages/notifications/src/mail-limits.ts); the lock-order test binds the two.
 */
export async function lockMailBudget(db: pg.PoolClient) {
  await db.query('SELECT pg_advisory_xact_lock(1852798057, 1835100524)')
}

/**
 * Team management as invitation creation takes it on main: the team row FOR UPDATE, and then
 * the mail-budget lock.
 */
export async function lockTeamForManagement(db: pg.PoolClient, team: string) {
  await db.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [team])
}

/**
 * A reschedule or cancellation, after the organization and before it retires or writes any
 * run: share-locks the live definitions among `workflows` that it may capture, in ID order.
 * Returns their IDs; a tombstoned or unknown definition is not captured.
 */
export async function shareLiveDefinitions(
  db: pg.PoolClient,
  organization: string,
  workflows: readonly string[],
) {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM workflow_definitions
    WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL
    ORDER BY id FOR SHARE`,
    [organization, workflows],
  )
  return rows.map(({ id }) => id)
}

/** A deletion's first write: the tombstone, which holds the definition until it commits. */
export async function tombstoneWorkflow(db: pg.PoolClient, organization: string, workflow: string) {
  await db.query(
    `UPDATE workflow_definitions SET enabled=false, deleted_at=now()
    WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL`,
    [organization, workflow],
  )
}

/** A deletion's second write, after its tombstone: retires the workflow's pending runs. */
export async function retireWorkflowRuns(
  db: pg.PoolClient,
  organization: string,
  workflow: string,
) {
  const { rowCount } = await db.query(
    `UPDATE workflow_runs SET state='retired', finished_at=now()
    WHERE organization_id=$1 AND state='pending' AND enrollment_id IN (
      SELECT id FROM workflow_enrollments WHERE organization_id=$1 AND workflow_id=$2)`,
    [organization, workflow],
  )
  return rowCount ?? 0
}

/** A reschedule or cancellation: retires the booking's pending runs. */
export async function retireBookingRuns(db: pg.PoolClient, organization: string, booking: string) {
  const { rowCount } = await db.query(
    `UPDATE workflow_runs SET state='retired', finished_at=now()
    WHERE organization_id=$1 AND booking_id=$2 AND state='pending'`,
    [organization, booking],
  )
  return rowCount ?? 0
}

/**
 * A capture: an enrollment of the booking at `revision` and its pending run due in a day, as a
 * reschedule carries a timer to its successor. Both guards share-lock the definition.
 */
export async function captureRun(
  db: pg.PoolClient,
  of: { organization: string; booking: string; workflow: string; revision: number },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO workflow_enrollments (organization_id,booking_id,workflow_id,revision,occurrence,trigger)
    VALUES ($1,$2,$3,$4,'created','before_start') RETURNING id`,
    [of.organization, of.booking, of.workflow, of.revision],
  )
  const enrollment = rows[0]?.id as string
  await db.query(
    `INSERT INTO workflow_runs (organization_id,enrollment_id,booking_id,due_at,expires_at)
    VALUES ($1,$2,$3,now()+interval '1 day',now()+interval '25 hours')`,
    [of.organization, enrollment, of.booking],
  )
  return enrollment
}

/** An admission's ledger row, after the budget lock: the charge that names its reservation. */
export async function chargeWorkflowMail(
  db: pg.PoolClient,
  reservation: string,
  recipientHash: Buffer,
) {
  await db.query(
    'INSERT INTO notification_email_sends (recipient_hash,sent_at,workflow_reservation_id) VALUES ($1,now(),$2)',
    [recipientHash, reservation],
  )
}

/**
 * An admission's reservation of one recipient claim. Its foreign key share-locks the owner
 * organization, so a transaction that has not locked the organization first takes that lock
 * here, after the budget lock.
 */
export async function reserveWorkflowMail(
  db: pg.PoolClient,
  of: { reservation: string; organization: string; run: string; claim: string },
) {
  await db.query(
    `INSERT INTO workflow_mail_reservations (id,organization_id,run_id,claim_id,reserved_at)
    VALUES ($1,$2,$3,$4,now())`,
    [of.reservation, of.organization, of.run, of.claim],
  )
}

export type Side = 'first' | 'second'
/** One step of a schedule: the statements one side runs in its open transaction. */
export type Step = readonly [side: Side, run: (db: pg.PoolClient) => Promise<unknown>]
export interface Interleaving {
  /** How each side's transaction ended: `committed`, or the SQLSTATE that rolled it back. */
  outcome: Record<Side, string>
  /** The schedule indexes of the steps that waited for a lock. */
  waited: number[]
}

/**
 * Runs two transactions through `steps` on two connections. Each step starts once the previous
 * step of the schedule has finished or waits for a lock; a side runs its own steps in order, so
 * a step behind a waiting one of its side queues. An error ends its side's transaction (its
 * later steps are skipped); after the schedule each side that is still open commits. A
 * deadlock therefore ends one side with `40P01` and lets the other commit.
 */
export async function interleave(pool: pg.Pool, steps: readonly Step[]): Promise<Interleaving> {
  const open = async () => {
    const client = await pool.connect()
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
      ?.pid as number
    await client.query('BEGIN')
    return { client, pid, chain: Promise.resolve(), ended: undefined as string | undefined }
  }
  const first = await open()
  const second = await open().catch(async (error: unknown) => {
    await first.client.query('ROLLBACK').catch(() => {})
    first.client.release()
    throw error
  })
  const sides = { first, second }
  const end = async (side: (typeof sides)[Side], error: unknown) => {
    side.ended = (error as { code?: string }).code ?? String(error)
    await side.client.query('ROLLBACK')
  }
  const waited: number[] = []
  try {
    for (const [index, [name, run]] of steps.entries()) {
      const side = sides[name]
      let started = false
      let settled = false
      side.chain = side.chain.then(async () => {
        if (side.ended) return
        started = true
        await run(side.client).catch((error: unknown) => end(side, error))
      })
      const done = () => {
        settled = true
      }
      side.chain.then(done, done)
      for (let attempt = 0; !settled; attempt++) {
        if (attempt > 1000) throw new Error(`step ${index} neither finished nor waited`)
        if (started) {
          const { rows } = await pool.query<{ wait: string | null }>(
            'SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid=$1',
            [side.pid],
          )
          if (rows[0]?.wait === 'Lock' && !settled) {
            waited.push(index)
            break
          }
        } else if (attempt > 0) break // Queued behind a waiting step of its side.
        await setTimeout(10)
      }
    }
    for (const side of Object.values(sides))
      side.chain = side.chain.then(async () => {
        if (!side.ended) await side.client.query('COMMIT').catch((error) => end(side, error))
      })
    await Promise.all(Object.values(sides).map(({ chain }) => chain))
    return {
      outcome: {
        first: sides.first.ended ?? 'committed',
        second: sides.second.ended ?? 'committed',
      },
      waited,
    }
  } finally {
    // Steps still queued are skipped. Both roll back at once: a side that waits for the other
    // finishes once the other rolls back; then each chain settles before its client goes back.
    for (const side of Object.values(sides)) side.ended ??= 'aborted'
    await Promise.all(
      Object.values(sides).map(({ client }) => client.query('ROLLBACK').catch(() => {})),
    )
    await Promise.all(Object.values(sides).map(({ chain }) => chain.catch(() => {})))
    for (const { client } of Object.values(sides)) client.release()
  }
}
