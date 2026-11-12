// Migration 0079 (workflow execution storage) adds `workflow_reservation_id` to the shared mail
// ledger that every core sender writes and counts. Existing rows keep NULL, and the core count
// queries here (mail-limits.ts) are unchanged: on the same rows they return the same instance,
// booking-recipient and sign-in counts and purge the same rows before and after the upgrade. A
// workflow charge then counts in the shared instance hour and in no core recipient window.
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, type Db, runMigrations } from '@hourmere/db'
import { createTestDatabaseTemplate, type TestDatabase } from '@hourmere/db/testing'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import {
  invitationRecipientHash,
  notificationEmailBudget,
  notificationRecipientHash,
  purgeNotificationEmailSends,
  signInEmailBudget,
  signInRecipientHash,
} from './mail-limits.ts'

const serverUrl = process.env.DATABASE_URL
const migrations = fileURLToPath(new URL('../../db/migrations/', import.meta.url))
const upgrade = '0079_workflow_execution.sql'
const SECRET = 'synthetic-workflow-ledger-secret'
const EMAIL = 'ada@example.test'
const HOUR = 3_600_000
const unlimited = 1_000_000

/**
 * The counts the core queries see, read through the unchanged budget functions: the smallest cap
 * that a count reaches is the count itself.
 */
async function coreCounts(db: Db, now: Date) {
  const reached = async (suppressed: (cap: number) => Promise<boolean>) => {
    for (let cap = 1; cap <= 50; cap++) if (!(await suppressed(cap))) return cap - 1
    throw new Error('count above the probe range')
  }
  const booking = notificationRecipientHash(EMAIL, SECRET)
  const signIn = signInRecipientHash(EMAIL, SECRET)
  return {
    instanceHour: await reached(async (cap) =>
      Boolean(
        await notificationEmailBudget(
          db,
          {
            mailMaxPerHour: cap,
            mailRecipientMaxPerHour: unlimited,
            mailRecipientMaxPerDay: unlimited,
          },
          booking,
          true,
          now,
        ),
      ),
    ),
    bookingHour: await reached(
      async (cap) =>
        (await notificationEmailBudget(
          db,
          { mailMaxPerHour: 0, mailRecipientMaxPerHour: cap, mailRecipientMaxPerDay: unlimited },
          booking,
          true,
          now,
        )) === 'recipient_hourly_limit',
    ),
    bookingDay: await reached(
      async (cap) =>
        (await notificationEmailBudget(
          db,
          { mailMaxPerHour: 0, mailRecipientMaxPerHour: unlimited, mailRecipientMaxPerDay: cap },
          booking,
          true,
          now,
        )) === 'recipient_daily_limit',
    ),
    signInHour: await reached(
      async (cap) =>
        (await signInEmailBudget(
          db,
          { mailMaxPerHour: 0, signInMailMaxPerHour: cap, signInMailMaxPerDay: unlimited },
          signIn,
          now,
        )) === 'recipient_hourly_limit',
    ),
  }
}

async function ledger(pool: pg.Pool) {
  return (
    await pool.query(
      `SELECT encode(recipient_hash,'hex') AS hash,sent_at,xmin::text,ctid::text
      FROM notification_email_sends ORDER BY sent_at,hash`,
    )
  ).rows
}

describe.skipIf(!serverUrl)('the shared mail ledger across the workflow execution upgrade', () => {
  it('keeps existing rows NULL and the core counts and purge unchanged, and counts workflow charges only in the instance hour', async () => {
    const predecessors = await mkdtemp(join(tmpdir(), 'hourmere-workflow-ledger-'))
    const now = new Date()
    const ago = (hours: number) => new Date(now.getTime() - hours * HOUR)
    const copies: TestDatabase[] = []
    let template: Awaited<ReturnType<typeof createTestDatabaseTemplate>> | undefined
    try {
      const files = (await readdir(migrations))
        .filter((file) => file.endsWith('.sql') && file < upgrade)
        .sort()
      expect(files).toContain('0040_notification_mail_limits.sql')
      for (const file of files) await copyFile(join(migrations, file), join(predecessors, file))
      // Booking, sign-in, invitation and host rows inside and outside every window.
      const rows: [Buffer | null, Date][] = [
        ...[0.1, 0.5, 0.9, 5, 23, 30, 60].map((hours): [Buffer, Date] => [
          notificationRecipientHash(EMAIL, SECRET),
          ago(hours),
        ]),
        ...[0.2, 0.7, 25].map((hours): [Buffer, Date] => [
          signInRecipientHash(EMAIL, SECRET),
          ago(hours),
        ]),
        [invitationRecipientHash(EMAIL, SECRET), ago(0.3)],
        [notificationRecipientHash('grace@example.test', SECRET), ago(0.4)],
        [null, ago(0.6)],
        [null, ago(50)],
      ]
      template = await createTestDatabaseTemplate(
        serverUrl as string,
        async (pool) => {
          await runMigrations(pool, predecessors)
          for (const [hash, sentAt] of rows)
            await pool.query(
              'INSERT INTO notification_email_sends (recipient_hash,sent_at) VALUES ($1,$2)',
              [hash, sentAt],
            )
        },
        { tag: 'wf_ledger' },
      )
      const before = await template.clone(predecessors, { tag: 'wf_ledger' })
      copies.push(before)
      const after = await template.clone(undefined, { tag: 'wf_ledger' })
      copies.push(after)
      expect(
        (
          await after.pool.query<{ name: string }>(
            'SELECT name FROM schema_migrations WHERE name=$1',
            [upgrade],
          )
        ).rows,
      ).toHaveLength(1)
      expect(
        (
          await before.pool.query(
            "SELECT FROM information_schema.columns WHERE column_name='workflow_reservation_id'",
          )
        ).rows,
      ).toEqual([])

      // Every existing row is unchanged, down to its tuple, and has no workflow reservation.
      expect(await ledger(after.pool)).toEqual(await ledger(before.pool))
      expect(
        (
          await after.pool.query<{ total: number; workflow: number }>(
            'SELECT count(*)::int AS total,count(workflow_reservation_id)::int AS workflow FROM notification_email_sends',
          )
        ).rows[0],
      ).toEqual({ total: rows.length, workflow: 0 })
      const beforeDb = createDb(before.pool)
      const afterDb = createDb(after.pool)
      const counts = await coreCounts(beforeDb, now)
      expect(counts).toEqual({ instanceHour: 8, bookingHour: 3, bookingDay: 5, signInHour: 2 })
      expect(await coreCounts(afterDb, now)).toEqual(counts)

      // A workflow charge (its own purpose digest) counts in the instance hour only.
      const workflowHash = createHash('sha256').update(`workflow\0${EMAIL}`).digest()
      for (const hours of [0.15, 0.25])
        await after.pool.query(
          'INSERT INTO notification_email_sends (recipient_hash,sent_at,workflow_reservation_id) VALUES ($1,$2,$3)',
          [workflowHash, ago(hours), randomUUID()],
        )
      expect(await coreCounts(afterDb, now)).toEqual({
        ...counts,
        instanceHour: counts.instanceHour + 2,
      })

      // The two-day purge removes the same core rows, and a workflow charge by the same rule.
      await after.pool.query(
        'INSERT INTO notification_email_sends (recipient_hash,sent_at,workflow_reservation_id) VALUES ($1,$2,$3)',
        [workflowHash, ago(49), randomUUID()],
      )
      const purgedBefore = await purgeNotificationEmailSends(beforeDb, now)
      const purgedAfter = await purgeNotificationEmailSends(afterDb, now)
      expect(purgedBefore.numDeletedRows).toBe(2n)
      expect(purgedAfter.numDeletedRows).toBe(3n)
      expect(
        (
          await after.pool.query(
            'SELECT count(*)::int AS left FROM notification_email_sends WHERE workflow_reservation_id IS NULL',
          )
        ).rows[0],
      ).toEqual({ left: rows.length - 2 })
      expect(before.pool.totalCount).toBeLessThanOrEqual(2)
      expect(after.pool.totalCount).toBeLessThanOrEqual(2)
    } finally {
      for (const copy of copies) await copy.drop()
      await template?.drop()
      await rm(predecessors, { recursive: true, force: true })
    }
  }, 120_000)
})
