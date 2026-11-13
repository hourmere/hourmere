// The two lock-order rules of docs/data-model.md ("Workflow execution storage") that the
// storage cannot enforce on its own, raced on two connections with the statements of
// workflow-storage-lock-order.ts. Each reversed order deadlocks (40P01): an admission that
// reaches the organization through its reservation's foreign key after the mail-budget lock,
// against invitation creation; and a reschedule that retires a run before it carries the
// timer, against the workflow's deletion. Each documented order completes instead: the second
// transaction waits for the first and both commit.
import { randomBytes, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lockNotificationEmailBudget } from '../../notifications/src/mail-limits.ts'
import type { Database } from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { executionFixture } from './workflow-storage-execution-protections.ts'
import {
  captureRun,
  chargeWorkflowMail,
  interleave,
  lockMailBudget,
  lockTeamForManagement,
  lockWorkflowOrganization,
  reserveWorkflowMail,
  retireBookingRuns,
  retireWorkflowRuns,
  type Step,
  shareLiveDefinitions,
  tombstoneWorkflow,
} from './workflow-storage-lock-order.ts'

const serverUrl = process.env.DATABASE_URL

/** Runs the production `lockNotificationEmailBudget` on a checked-out transaction. */
async function productionBudgetLock(client: pg.PoolClient) {
  // The adapter borrows that client and neither creates a pool nor releases its owner.
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: {
        options: {},
        connect: async () =>
          new Proxy(client, {
            get(target, property) {
              if (property === 'release') return () => {}
              const value = Reflect.get(target, property)
              return typeof value === 'function' ? value.bind(target) : value
            },
          }),
        end: async () => {},
      },
    }),
  })
  try {
    await lockNotificationEmailBudget(db)
  } finally {
    await db.destroy()
  }
}

describe.skipIf(!serverUrl)('workflow lock order', () => {
  let owned: TestDatabase

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'workflow_lock' })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('takes the same mail-budget lock as lockNotificationEmailBudget', async () => {
    const f = await executionFixture(owned.pool)
    const { outcome, waited } = await interleave(f.pool, [
      ['first', productionBudgetLock],
      ['second', lockMailBudget],
    ])
    expect(waited, 'the helper waits for the production lock').toEqual([1])
    expect(outcome).toEqual({ first: 'committed', second: 'committed' })
    expect(owned.pool.totalCount).toBeLessThanOrEqual(4)
  })

  it('locks the organization before the mail budget, so admission and invitation creation take turns', async () => {
    const f = await executionFixture(owned.pool)
    /**
     * A workflow admission (first) charges a captured recipient, while invitation creation
     * (second) locks the team for management and then asks for the budget lock.
     */
    const race = async (organizationFirst: boolean) => {
      const { run, claim } = await f.capture()
      const reservation = randomUUID()
      const steps: Step[] = [
        [
          'first',
          async (db) => {
            if (organizationFirst) await lockWorkflowOrganization(db, f.team)
            await lockMailBudget(db)
            await chargeWorkflowMail(db, reservation, randomBytes(32))
          },
        ],
        ['second', (db) => lockTeamForManagement(db, f.team)],
        [
          'first',
          (db) => reserveWorkflowMail(db, { reservation, organization: f.team, run, claim }),
        ],
        ['second', lockMailBudget],
      ]
      const result = await interleave(f.pool, steps)
      const charged = await f.rows('workflow_mail_reservations', 'id=$1', [reservation])
      const ledger = await f.rows('notification_email_sends', 'workflow_reservation_id=$1', [
        reservation,
      ])
      return { ...result, charges: [charged.length, ledger.length] }
    }

    // Budget, then the organization through the reservation's foreign key: a deadlock.
    const reversed = await race(false)
    // The reservation waits for the team; the outcome shows that the budget request closed the
    // cycle (whether the harness saw it wait depends on which side's deadlock check ran).
    expect(reversed.waited[0], 'the reservation waits for the team').toBe(2)
    expect(Object.values(reversed.outcome).sort(), 'one side is the deadlock victim').toEqual([
      '40P01',
      'committed',
    ])
    // The organization first: invitation creation waits for the admission, then both commit.
    const documented = await race(true)
    expect(documented.waited, 'invitation creation waits for the organization').toEqual([1])
    expect(documented.outcome).toEqual({ first: 'committed', second: 'committed' })
    expect(documented.charges, 'the reservation and its ledger row').toEqual([1, 1])
    expect(owned.pool.totalCount).toBeLessThanOrEqual(4)
  }, 30_000)

  it('locks a definition before its runs, so deletion and a reschedule take turns', async () => {
    const f = await executionFixture(owned.pool)
    /**
     * A reschedule (first) retires the predecessor's run and carries its timer to the
     * successor, while the workflow's deletion (second) tombstones it and retires its runs.
     */
    const race = async (definitionFirst: boolean) => {
      const predecessor = await f.capture()
      const successor = await f.booking()
      const { organization, workflow } = predecessor
      const steps: Step[] = [
        [
          'first',
          async (db) => {
            await lockWorkflowOrganization(db, organization)
            if (definitionFirst) await shareLiveDefinitions(db, organization, [workflow])
            await retireBookingRuns(db, organization, predecessor.booking)
          },
        ],
        [
          'second',
          async (db) => {
            await lockWorkflowOrganization(db, organization)
            await tombstoneWorkflow(db, organization, workflow)
          },
        ],
        [
          'first',
          (db) => captureRun(db, { organization, booking: successor, workflow, revision: 1 }),
        ],
        ['second', (db) => retireWorkflowRuns(db, organization, workflow)],
      ]
      const result = await interleave(f.pool, steps)
      const { rows: runs } = await f.pool.query<{ booking_id: string; state: string }>(
        `SELECT r.booking_id, r.state FROM workflow_runs r
        JOIN workflow_enrollments e ON e.id=r.enrollment_id
        WHERE e.workflow_id=$1 ORDER BY r.created_at, r.id`,
        [workflow],
      )
      const definition = await f.one('workflow_definitions', workflow)
      return {
        ...result,
        runs: runs.map(({ booking_id, state }) => [booking_id, state]),
        tombstoned: definition?.deleted_at instanceof Date,
        successor,
        predecessor: predecessor.booking,
      }
    }

    // A run, then the definition through the carried enrollment's guard: a deadlock.
    const reversed = await race(false)
    // The carried enrollment waits for the tombstone; the outcome shows that the deletion's
    // retirement closed the cycle.
    expect(reversed.waited[0], 'the carry waits for the tombstone').toBe(2)
    expect(Object.values(reversed.outcome).sort(), 'one side is the deadlock victim').toEqual([
      '40P01',
      'committed',
    ])
    // The definition first: the tombstone waits for the reschedule, then both commit, and the
    // deletion, which runs after it, also retires the run carried to the successor.
    const documented = await race(true)
    expect(documented.waited, 'the tombstone waits for the reschedule').toEqual([1])
    expect(documented.outcome).toEqual({ first: 'committed', second: 'committed' })
    expect(documented.tombstoned).toBe(true)
    expect(documented.runs).toEqual([
      [documented.predecessor, 'retired'],
      [documented.successor, 'retired'],
    ])
    expect(owned.pool.totalCount).toBeLessThanOrEqual(4)
  }, 30_000)
})
