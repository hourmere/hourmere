import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs, defineJob } from '@hourmere/jobs'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  cleanupInvitationDeliveries,
  type InvitationDeliveryState,
  listPendingInvitationDeliveries,
} from './invitation-deliveries.ts'

const serverUrl = process.env.DATABASE_URL
const states: InvitationDeliveryState[] = [
  'queued',
  'sending',
  'smtp_accepted',
  'failed',
  'skipped',
]

describe.skipIf(!serverUrl)('invitation delivery storage queries', () => {
  let owned: TestDatabase
  let db: Db
  let organizationId: string
  let otherOrganizationId: string
  let inviterId: string

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  beforeEach(async () => {
    await db.deleteFrom('auth.organization').execute()
    await db.deleteFrom('auth.user').execute()
    const user = await db
      .insertInto('auth.user')
      .values({ name: 'Synthetic inviter', email: 'inviter@example.com', emailVerified: true })
      .returning('id')
      .executeTakeFirstOrThrow()
    inviterId = user.id
    const organizations = await db
      .insertInto('auth.organization')
      .values([
        { name: 'First team', slug: 'first-team', createdAt: new Date() },
        { name: 'Second team', slug: 'second-team', createdAt: new Date() },
      ])
      .returning('id')
      .execute()
    organizationId = organizations[0]?.id as string
    otherOrganizationId = organizations[1]?.id as string
  })

  async function invitation(
    options: { id?: string; status?: string; expiresDays?: number; organizationId?: string } = {},
  ) {
    const row = await db
      .insertInto('auth.invitation')
      .values({
        id: options.id ?? randomUUID(),
        inviterId,
        organizationId: options.organizationId ?? organizationId,
        email: 'invitee@example.com',
        role: 'member',
        status: options.status ?? 'pending',
        expiresAt: sql`clock_timestamp() + ${options.expiresDays ?? 1} * INTERVAL '1 day'`,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return row
  }

  async function delivery(
    invitationId: string,
    options: { state?: InvitationDeliveryState; updatedDays?: number; leaseDays?: number } = {},
  ) {
    const state = options.state ?? 'queued'
    const row = await db
      .insertInto('invitation_deliveries')
      .values({
        invitation_id: invitationId,
        state,
        attempts: state === 'sending' || state === 'smtp_accepted' ? 1 : 0,
        lease_id: state === 'sending' ? randomUUID() : null,
        lease_until:
          state === 'sending'
            ? sql`clock_timestamp() + ${options.leaseDays ?? 1} * INTERVAL '1 day'`
            : null,
        smtp_accepted_at: state === 'smtp_accepted' ? sql`clock_timestamp()` : null,
        last_error_code:
          state === 'failed'
            ? 'legacy_delivery_unknown'
            : state === 'skipped'
              ? 'invitation_ineligible'
              : null,
        last_job_id: randomUUID(),
        resend_request_id: randomUUID(),
        updated_at: sql`clock_timestamp() + ${options.updatedDays ?? 0} * INTERVAL '1 day'`,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return row
  }

  const deliveryIds = async () =>
    (await db.selectFrom('invitation_deliveries').select('invitation_id').execute())
      .map((row) => row.invitation_id)
      .sort()

  it('lists every delivery state and missing storage as unknown without exposing delivery internals', async () => {
    const expected = new Map<string, InvitationDeliveryState | 'unknown'>()
    for (const state of states) {
      const row = await invitation()
      await delivery(row.id, { state })
      expected.set(row.id, state)
    }
    const missing = await invitation()
    expected.set(missing.id, 'unknown')
    const rows = await listPendingInvitationDeliveries(db, organizationId)
    expect(rows).toHaveLength(6)
    expect(new Map(rows.map((row) => [row.id, row.delivery.state]))).toEqual(expected)
    for (const row of rows) {
      expect(row).toEqual({
        id: expect.any(String),
        organizationId,
        email: 'invitee@example.com',
        role: 'member',
        inviterId,
        createdAt: expect.any(Date),
        expiresAt: expect.any(Date),
        delivery: {
          state: expected.get(row.id),
          generation: row.id === missing.id ? null : 1,
          attempts:
            row.id === missing.id
              ? null
              : ['sending', 'smtp_accepted'].includes(row.delivery.state)
                ? 1
                : 0,
          dueAt: row.id === missing.id ? null : expect.any(Date),
          smtpAcceptedAt: row.delivery.state === 'smtp_accepted' ? expect.any(Date) : null,
          lastErrorCode:
            row.delivery.state === 'failed'
              ? 'legacy_delivery_unknown'
              : row.delivery.state === 'skipped'
                ? 'invitation_ineligible'
                : null,
          createdAt: row.id === missing.id ? null : expect.any(Date),
          updatedAt: row.id === missing.id ? null : expect.any(Date),
        },
      })
    }
  })

  it('scopes pending invitations by organization and current database expiry', async () => {
    const visible = await invitation()
    await invitation({ organizationId: otherOrganizationId })
    for (const status of ['accepted', 'canceled', 'rejected', 'unknown']) {
      await invitation({ status })
    }
    await invitation({ expiresDays: -1 })
    await invitation({ expiresDays: 0 })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2100-01-01T00:00:00Z'))
      expect(
        (await listPendingInvitationDeliveries(db, organizationId)).map((row) => row.id),
      ).toEqual([visible.id])
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses elapsed database time inside a transaction when an invitation expires', async () => {
    const row = await invitation()
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('auth.invitation')
        .set({ expiresAt: sql`clock_timestamp() + INTERVAL '100 milliseconds'` })
        .where('id', '=', row.id)
        .execute()
      await sql`SELECT pg_sleep(0.15)`.execute(trx)
      expect(await listPendingInvitationDeliveries(trx, organizationId)).toEqual([])
    })
  })

  it('paginates by invitation id without losing missing delivery rows', async () => {
    const ids = [1, 2, 3].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`)
    for (const id of ids) await invitation({ id })
    await delivery(ids[0] as string)
    const first = await listPendingInvitationDeliveries(db, organizationId, { limit: 2 })
    expect(first.map((row) => row.id)).toEqual(ids.slice(0, 2))
    const next = await listPendingInvitationDeliveries(db, organizationId, {
      afterId: first[1]?.id,
      limit: 2,
    })
    expect(next.map((row) => row.id)).toEqual(ids.slice(2))
  })

  it.each([0, -1, 101, 1.5, Number.NaN])('rejects an unbounded batch limit %s', async (limit) => {
    await expect(listPendingInvitationDeliveries(db, organizationId, { limit })).rejects.toThrow(
      RangeError,
    )
    await expect(cleanupInvitationDeliveries(db, limit)).rejects.toThrow(RangeError)
  })

  it('retains all pending unexpired tombstones and deletes only old terminal or expired records', async () => {
    const retained: string[] = []
    for (const state of states) {
      const row = await invitation()
      await delivery(row.id, { state, updatedDays: -10, leaseDays: -9 })
      retained.push(row.id)
    }
    const removed: string[] = []
    for (const status of ['pending', 'accepted', 'canceled', 'rejected']) {
      const row = await invitation({ status, expiresDays: -10 })
      await delivery(row.id, { updatedDays: -10 })
      removed.push(row.id)
    }
    for (const fixture of [
      { status: 'unknown', expiresDays: -10, updatedDays: -10 },
      { status: 'accepted', expiresDays: -6, updatedDays: -10 },
      { status: 'canceled', expiresDays: -10, updatedDays: -6 },
      { status: 'rejected', expiresDays: 1, updatedDays: -10 },
    ]) {
      const row = await invitation(fixture)
      await delivery(row.id, fixture)
      retained.push(row.id)
    }
    expect(await cleanupInvitationDeliveries(db)).toBe(removed.length)
    expect(await deliveryIds()).toEqual(retained.sort())
    expect((await db.selectFrom('auth.invitation').select('id').execute()).length).toBe(
      retained.length + removed.length,
    )
  })

  it('retains a live lease and can remove an expired lease after both seven-day ages', async () => {
    const live = await invitation({ expiresDays: -10 })
    const expired = await invitation({ expiresDays: -10 })
    await delivery(live.id, { state: 'sending', updatedDays: -10 })
    await delivery(expired.id, { state: 'sending', updatedDays: -10, leaseDays: -1 })
    expect(await cleanupInvitationDeliveries(db)).toBe(1)
    expect(await deliveryIds()).toEqual([live.id])
  })

  it('caps cleanup to one hundred rows by default and respects smaller batches', async () => {
    const rows = await db
      .insertInto('auth.invitation')
      .values(
        Array.from({ length: 103 }, () => ({
          inviterId,
          organizationId,
          email: 'invitee@example.com',
          role: 'member',
          status: 'canceled',
          expiresAt: sql<Date>`clock_timestamp() - INTERVAL '10 days'`,
        })),
      )
      .returning('id')
      .execute()
    await db
      .insertInto('invitation_deliveries')
      .values(
        rows.map((row) => ({
          invitation_id: row.id,
          state: 'queued',
          updated_at: sql<Date>`clock_timestamp() - INTERVAL '10 days'`,
        })),
      )
      .execute()
    expect(await cleanupInvitationDeliveries(db)).toBe(100)
    expect(await deliveryIds()).toHaveLength(3)
    expect(await cleanupInvitationDeliveries(db, 2)).toBe(2)
    expect(await cleanupInvitationDeliveries(db)).toBe(1)
    expect(await deliveryIds()).toEqual([])
  })

  it('rolls back the entire cleanup batch if its transaction cannot commit', async () => {
    const rows = await Promise.all([
      invitation({ expiresDays: -10 }),
      invitation({ status: 'accepted', expiresDays: -10 }),
    ])
    for (const row of rows) await delivery(row.id, { updatedDays: -10 })
    await owned.pool.query(`
      CREATE FUNCTION test_fail_invitation_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic cleanup commit failure'; END $$`)
    await owned.pool.query(`
      CREATE CONSTRAINT TRIGGER test_fail_invitation_cleanup
      AFTER DELETE ON public.invitation_deliveries DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION test_fail_invitation_cleanup()`)
    try {
      await expect(cleanupInvitationDeliveries(db)).rejects.toThrow(
        'synthetic cleanup commit failure',
      )
      expect(await deliveryIds()).toEqual(rows.map((row) => row.id).sort())
    } finally {
      await owned.pool.query(
        'DROP TRIGGER IF EXISTS test_fail_invitation_cleanup ON public.invitation_deliveries',
      )
      await owned.pool.query('DROP FUNCTION IF EXISTS test_fail_invitation_cleanup()')
    }
  })

  it('skips an invitation being renewed and retains its record after renewal commits', async () => {
    const row = await invitation({ expiresDays: -10 })
    await delivery(row.id, { updatedDays: -10 })
    const renewal = await owned.pool.connect()
    let cleanup: Promise<number> | undefined
    try {
      await renewal.query('BEGIN')
      await renewal.query(
        'UPDATE auth.invitation SET "expiresAt" = clock_timestamp() + INTERVAL \'1 day\' WHERE id = $1',
        [row.id],
      )
      cleanup = cleanupInvitationDeliveries(db)
      const completed = await Promise.race([
        cleanup,
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 1000)),
      ])
      expect(completed).toBe(0)
      expect(await deliveryIds()).toEqual([row.id])
      await renewal.query('COMMIT')
      expect(await cleanupInvitationDeliveries(db)).toBe(0)
      expect(await deliveryIds()).toEqual([row.id])
    } finally {
      await renewal.query('ROLLBACK')
      await cleanup
      renewal.release()
    }
  })

  it('skips a delivery being updated and retains its freshly updated tombstone', async () => {
    const row = await invitation({ expiresDays: -10 })
    await delivery(row.id, { updatedDays: -10 })
    const writer = await owned.pool.connect()
    let cleanup: Promise<number> | undefined
    try {
      await writer.query('BEGIN')
      await writer.query(
        'UPDATE public.invitation_deliveries SET updated_at = clock_timestamp() WHERE invitation_id = $1',
        [row.id],
      )
      cleanup = cleanupInvitationDeliveries(db)
      const completed = await Promise.race([
        cleanup,
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 1000)),
      ])
      expect(completed).toBe(0)
      await writer.query('COMMIT')
      expect(await cleanupInvitationDeliveries(db)).toBe(0)
      expect(await deliveryIds()).toEqual([row.id])
    } finally {
      await writer.query('ROLLBACK')
      await cleanup
      writer.release()
    }
  })

  it('rechecks delivery age after candidate selection and taking both locks', async () => {
    const row = await invitation({ expiresDays: -10 })
    await delivery(row.id, { updatedDays: -10 })
    let changed = false
    const interleaved = db.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        if (!changed && result.rows[0]?.id === row.id) {
          changed = true
          // A delivery completion can update the row after invitation candidate selection.
          await owned.pool.query(
            'UPDATE public.invitation_deliveries SET updated_at = clock_timestamp() WHERE invitation_id = $1',
            [row.id],
          )
        }
        return result
      },
    })
    expect(await cleanupInvitationDeliveries(interleaved)).toBe(0)
    expect(changed).toBe(true)
    expect(await deliveryIds()).toEqual([row.id])
  })

  it('holds the invitation lock until the cleanup transaction commits', async () => {
    const row = await invitation({ expiresDays: -10 })
    await delivery(row.id, { updatedDays: -10 })
    let writing: Promise<unknown> | undefined
    let checked = false
    const interleaved = db.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        if (!checked && result.rows[0]?.id === row.id) {
          checked = true
          writing = owned.pool.query(
            'UPDATE auth.invitation SET "expiresAt" = clock_timestamp() + INTERVAL \'1 day\' WHERE id = $1',
            [row.id],
          )
          const completed = await Promise.race([
            writing.then(() => 'renewed'),
            new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 100)),
          ])
          expect(completed).toBe('blocked')
        }
        return result
      },
    })
    try {
      expect(await cleanupInvitationDeliveries(interleaved)).toBe(1)
      expect(checked).toBe(true)
    } finally {
      // The cleanup must commit or roll back before waiting for the blocked writer.
      await writing
    }
    expect(await deliveryIds()).toEqual([])
    expect(
      (
        await db
          .selectFrom('auth.invitation')
          .select('expiresAt')
          .where('id', '=', row.id)
          .executeTakeFirstOrThrow()
      ).expiresAt.getTime(),
    ).toBeGreaterThan(Date.now())
  })

  it('keeps a retry key to one pending queue job and one record, with transactional rollback', async () => {
    // Test-only transaction fixture: no production queue, sender or resend protocol is installed.
    const job = defineJob({
      name: 'test-invitation-storage',
      payload: z.strictObject({ invitationId: z.uuid(), generation: z.int().min(1).max(32) }),
      policy: 'exclusive',
      retry: { limit: 0 },
      handler: async () => {},
    })
    const jobs = createJobs({
      connectionString: owned.url,
      definitions: [job],
      work: false,
      migrate: true,
      maxConnections: 2,
      log: () => {},
    })
    try {
      await jobs.start()
      const row = await invitation()
      const singletonKey = `invitation-email:v1:${row.id}:1`
      const create = () =>
        db.transaction().execute(async (trx) => {
          const inserted = await trx
            .insertInto('invitation_deliveries')
            .values({ invitation_id: row.id, state: 'queued' })
            .onConflict((conflict) => conflict.column('invitation_id').doNothing())
            .returning('invitation_id')
            .executeTakeFirst()
          if (inserted) {
            const jobId = await jobs.enqueue(
              job.name,
              { invitationId: row.id, generation: 1 },
              {
                singletonKey,
                transaction: trx,
              },
            )
            if (!jobId) throw new Error('test fixture duplicate enqueue must roll back')
            await trx
              .updateTable('invitation_deliveries')
              .set({ last_job_id: jobId })
              .where('invitation_id', '=', row.id)
              .execute()
          }
          return trx
            .selectFrom('invitation_deliveries')
            .selectAll()
            .where('invitation_id', '=', row.id)
            .executeTakeFirstOrThrow()
        })
      const results = await Promise.all([create(), create()])
      expect(results[0]?.last_job_id).toEqual(results[1]?.last_job_id)
      expect(results[0]?.last_job_id).toEqual(expect.any(String))
      expect(await deliveryIds()).toEqual([row.id])
      expect(
        await jobs.enqueue(job.name, { invitationId: row.id, generation: 1 }, { singletonKey }),
      ).toBeNull()
      const queueRows = async () =>
        (
          await owned.pool.query<{ id: string; state: string }>(
            'SELECT id, state FROM pgboss.job WHERE name = $1',
            [job.name],
          )
        ).rows
      expect(await queueRows()).toEqual([{ id: results[0]?.last_job_id, state: 'created' }])
      const rollback = await invitation()
      await expect(
        db.transaction().execute(async (trx) => {
          await trx
            .insertInto('invitation_deliveries')
            .values({ invitation_id: rollback.id, state: 'queued' })
            .execute()
          expect(
            await jobs.enqueue(
              job.name,
              { invitationId: rollback.id, generation: 1 },
              {
                singletonKey: `invitation-email:v1:${rollback.id}:1`,
                transaction: trx,
              },
            ),
          ).toEqual(expect.any(String))
          throw new Error('synthetic record and job rollback')
        }),
      ).rejects.toThrow('synthetic record and job rollback')
      expect(await deliveryIds()).toEqual([row.id])
      expect(await queueRows()).toEqual([{ id: results[0]?.last_job_id, state: 'created' }])
    } finally {
      await jobs.stop()
    }
  })
})
