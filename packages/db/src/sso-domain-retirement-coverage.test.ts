import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import {
  insert,
  insertRefused,
  lapsedDomainValues,
  ssoFixture,
  updateRefused,
} from './sso-storage-fixtures.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

export async function assertRetirementProtections(pool: pg.Pool) {
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    const f = await ssoFixture(db)
    const domain = await insert(db, 'sso_domains', lapsedDomainValues(f.team))
    const values = {
      domain_id: domain.id,
      generation: 1,
      old_organization_id: f.team,
      requesting_organization_id: f.otherTeam,
      challenge_digest: 'a'.repeat(64),
      created_at: '2026-01-01T00:00:00Z',
      expires_at: '2026-01-02T00:00:00Z',
    }
    for (const column of Object.keys(values))
      await insertRefused(
        db,
        'sso_domain_retirements',
        { ...values, [column]: null },
        { code: '23502' },
      )
    for (const changed of [
      { generation: 0 },
      { challenge_digest: 'invalid' },
      { requesting_organization_id: f.team },
      { expires_at: values.created_at },
      { proved_at: values.created_at },
    ])
      await insertRefused(
        db,
        'sso_domain_retirements',
        { ...values, ...changed },
        { code: '23514' },
      )
    for (const changed of [
      { domain_id: randomUUID() },
      { old_organization_id: f.otherTeam, requesting_organization_id: f.team },
      { requesting_organization_id: randomUUID() },
    ])
      await insertRefused(
        db,
        'sso_domain_retirements',
        { ...values, ...changed },
        { code: '23503' },
      )
    const row = await insert(db, 'sso_domain_retirements', values)
    await updateRefused(
      db,
      'sso_domain_retirements',
      { id: row.id },
      { challenge_digest: 'b'.repeat(64) },
      { code: '23514' },
    )
    const notice = { retirement_id: row.id, user_id: f.owner }
    await insert(db, 'sso_domain_retirement_notifications', notice)
    await insertRefused(db, 'sso_domain_retirement_notifications', notice, { code: '23505' })
    await insertRefused(
      db,
      'sso_domain_retirement_notifications',
      { ...notice, retirement_id: randomUUID() },
      { code: '23503' },
    )
    await insertRefused(
      db,
      'sso_domain_retirement_notifications',
      { ...notice, user_id: randomUUID() },
      { code: '23503' },
    )
  } finally {
    await db.query('ROLLBACK')
    db.release()
  }
}

describe.skipIf(!process.env.DATABASE_URL)('domain retirement constraint coverage', () => {
  it('covers every new protection', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: process.env.DATABASE_URL as string,
      migration: '0117_sso_domain_retirement.sql',
      assertions: assertRetirementProtections,
      concurrency: 2,
      allowList: {
        'constraint public.sso_domain_retirements.sso_domain_retirements_pkey':
          'Notification foreign keys require this target primary key; PostgreSQL cannot drop it alone.',
      },
    })
    expect(report.problems).toEqual([])
  }, 600_000)
})
