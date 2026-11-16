// Migration 0090 creates audit_log_settings. These checks pass on the migration as written and
// fail when any object it creates is dropped (audit-log-retention-coverage.test.ts) or lost by
// an upgrade (audit-log-retention-migration.test.ts). Every check runs in a rolled-back
// transaction, so nothing it writes outlives it.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'
import { attempts } from './meeting-poll-protections.ts'

const organization = (id: string) =>
  `INSERT INTO auth.organization (id, name, slug, "createdAt")
   VALUES ('${id}', 'Retention fixture', 'retention-${id}', now())`

/** Throws when a retention choice could be duplicated, orphaned, malformed or unstamped. */
export async function assertAuditLogRetentionProtections(pool: pg.Pool): Promise<void> {
  const id = randomUUID()
  const missing = randomUUID()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(organization(id))
    // Stamped by default; removed with its organization.
    await expect(
      client.query(
        `INSERT INTO audit_log_settings (organization_id, retention, retention_days)
         VALUES ($1, 'days', 30) RETURNING updated_at = now() AS stamped`,
        [id],
      ),
    ).resolves.toMatchObject({ rows: [{ stamped: true }] })
    await client.query('DELETE FROM auth.organization WHERE id = $1', [id])
    await expect(
      client.query('SELECT count(*)::int AS n FROM audit_log_settings WHERE organization_id = $1', [
        id,
      ]),
    ).resolves.toMatchObject({ rows: [{ n: 0 }] })
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }

  const insert = (values: string) => ({
    sql: `INSERT INTO audit_log_settings (organization_id, retention, retention_days) VALUES ${values}`,
  })
  const [
    forever,
    days,
    longest,
    second,
    orphan,
    foreverDays,
    noDays,
    short,
    long,
    unknown,
    absent,
    unstamped,
  ] = await attempts(
    pool,
    [
      insert(`('${id}', 'forever', NULL)`),
      insert(`('${id}', 'days', 30)`),
      insert(`('${id}', 'days', 3650)`),
      insert(`('${id}', 'forever', NULL), ('${id}', 'days', 60)`),
      insert(`('${missing}', 'forever', NULL)`),
      insert(`('${id}', 'forever', 30)`),
      insert(`('${id}', 'days', NULL)`),
      insert(`('${id}', 'days', 29)`),
      insert(`('${id}', 'days', 3651)`),
      insert(`('${id}', 'instance', NULL)`),
      insert(`('${id}', NULL, NULL)`),
      {
        sql: `INSERT INTO audit_log_settings (organization_id, retention, updated_at)
                VALUES ('${id}', 'forever', NULL)`,
      },
    ],
    organization(id),
  )
  // Plain values: a dropped object turns an expected rejection into an acceptance.
  const outcome = (error: pg.DatabaseError | undefined) =>
    error ? [error.code, error.code === '23502' ? error.column : error.constraint] : ['accepted']
  expect(
    Object.fromEntries(
      Object.entries({
        forever,
        days,
        longest,
        second,
        orphan,
        foreverDays,
        noDays,
        short,
        long,
        unknown,
        absent,
        unstamped,
      }).map(([name, error]) => [name, outcome(error)]),
    ),
  ).toEqual({
    forever: ['accepted'],
    days: ['accepted'],
    longest: ['accepted'],
    second: ['23505', 'audit_log_settings_pkey'],
    orphan: ['23503', 'audit_log_settings_organization_id_fkey'],
    foreverDays: ['23514', 'audit_log_settings_retention'],
    noDays: ['23514', 'audit_log_settings_retention'],
    short: ['23514', 'audit_log_settings_retention'],
    long: ['23514', 'audit_log_settings_retention'],
    unknown: ['23514', 'audit_log_settings_retention'],
    absent: ['23502', 'retention'],
    unstamped: ['23502', 'updated_at'],
  })
}
