import type pg from 'pg'
import { expect } from 'vitest'
import {
  claimedDomainValues,
  domainName,
  pendingDomainValues,
  quote,
  ssoFixture,
} from './sso-storage-fixtures.ts'

/**
 * One active claim per domain over two real connections: concurrent claims of the same
 * name by two teams, and concurrent verification of two pending challenges. Commits its
 * fixture to the given (throwaway) database and uses at most four connections.
 */
export async function checkActiveClaimRace(pool: pg.Pool) {
  const setup = await pool.connect()
  const first = await pool.connect()
  const second = await pool.connect()
  try {
    await setup.query('BEGIN')
    const f = await ssoFixture(setup)
    await setup.query('COMMIT')
    const insertClaim = (db: pg.PoolClient, values: Record<string, unknown>) => {
      const fields = Object.keys(values)
      return db.query(
        `INSERT INTO sso_domains (${fields.map(quote).join(',')})
        VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`,
        Object.values(values),
      )
    }
    // Two teams claim the same name at once: the second writer waits for the first and
    // then fails, whichever commits.
    for (const outcome of ['COMMIT', 'ROLLBACK'] as const) {
      const name = domainName()
      await first.query('BEGIN')
      await second.query('BEGIN')
      await insertClaim(first, claimedDomainValues(f.team, name))
      const waiting = insertClaim(second, claimedDomainValues(f.otherTeam, name)).then(
        () => undefined,
        (error: unknown) => error,
      )
      const pending = Symbol('pending')
      expect(
        await Promise.race([
          waiting,
          new Promise((resolve) => setTimeout(() => resolve(pending), 300)),
        ]),
      ).toBe(pending)
      await first.query(outcome)
      const result = await waiting
      await second.query(result ? 'ROLLBACK' : 'COMMIT')
      if (outcome === 'COMMIT')
        expect(result).toMatchObject({ code: '23505', constraint: 'sso_domains_active_name' })
      else expect(result).toBeUndefined()
      const { rows } = await pool.query<{ organization_id: string }>(
        'SELECT organization_id FROM sso_domains WHERE name=$1 AND claimed_at IS NOT NULL',
        [name],
      )
      expect(rows.map(({ organization_id }) => organization_id)).toEqual([
        outcome === 'COMMIT' ? f.team : f.otherTeam,
      ])
    }
    // Two pending challenges verified at once: exactly one claim results.
    const name = domainName()
    const ids: string[] = []
    for (const organization of [f.team, f.otherTeam])
      ids.push(
        (
          await pool.query<{ id: string }>(
            `INSERT INTO sso_domains (organization_id,name,challenge_digest,challenge_expires_at)
            VALUES ($1,$2,$3,$4) RETURNING id`,
            Object.values(pendingDomainValues(organization, name)).slice(0, 4),
          )
        ).rows[0]?.id as string,
      )
    const verify = (db: pg.PoolClient, id: string | undefined) =>
      db
        .query(
          `UPDATE sso_domains SET claimed_at=now(), verified_at=now(),
            verification_expires_at=now() + interval '7 days' WHERE id=$1`,
          [id],
        )
        .then(
          () => db.query('COMMIT').then(() => undefined),
          async (error: unknown) => {
            await db.query('ROLLBACK')
            return error
          },
        )
    await first.query('BEGIN')
    await second.query('BEGIN')
    const outcomes = await Promise.all([verify(first, ids[0]), verify(second, ids[1])])
    expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(1)
    expect(outcomes.find((outcome) => outcome !== undefined)).toMatchObject({
      code: '23505',
      constraint: 'sso_domains_active_name',
    })
    const { rows } = await pool.query(
      'SELECT id FROM sso_domains WHERE name=$1 AND claimed_at IS NOT NULL',
      [name],
    )
    expect(rows).toHaveLength(1)
    expect(pool.totalCount).toBeLessThanOrEqual(4)
  } finally {
    for (const db of [first, second, setup]) {
      await db.query('ROLLBACK').catch(() => {})
      db.release()
    }
  }
}
