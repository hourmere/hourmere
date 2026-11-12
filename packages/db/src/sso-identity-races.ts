// Uniqueness under concurrent writers over two real connections: one live link per
// (organization, provider, issuer, subject), and one consumption per replay key. Each check
// commits its fixture to the given (throwaway) database and uses at most three connections.
import type pg from 'pg'
import { expect } from 'vitest'
import { identityFixture, linkValues, replayValues } from './sso-identity-fixtures.ts'
import { at, insert, oidcProviderValues, quote } from './sso-storage-fixtures.ts'

type Values = Record<string, unknown>

function insertRow(db: pg.PoolClient, table: string, values: Values) {
  const fields = Object.keys(values)
  return db.query(
    `INSERT INTO ${quote(table)} (${fields.map(quote).join(',')})
    VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(values),
  )
}

const settle = (query: Promise<unknown>) =>
  query.then(
    () => undefined,
    (error: unknown) => error,
  )

/**
 * The first writer holds the key; the second waits for it, then fails if the first commits
 * and succeeds if it rolls back. Afterwards, two writers commit at once: exactly one wins.
 */
async function race(
  pool: pg.Pool,
  table: string,
  values: (round: number, writer: 0 | 1) => Values,
  constraint: string,
  winners: (round: number) => Promise<unknown[]>,
) {
  const first = await pool.connect()
  const second = await pool.connect().catch((error: unknown) => {
    first.release()
    throw error
  })
  try {
    let round = 0
    for (const outcome of ['COMMIT', 'ROLLBACK'] as const) {
      await first.query('BEGIN')
      await second.query('BEGIN')
      await insertRow(first, table, values(round, 0))
      const waiting = settle(insertRow(second, table, values(round, 1)))
      const pending = Symbol('pending')
      expect(
        await Promise.race([
          waiting,
          new Promise((resolve) => setTimeout(() => resolve(pending), 300)),
        ]),
        'the second writer waits for the first',
      ).toBe(pending)
      await first.query(outcome)
      const result = await waiting
      await second.query(result ? 'ROLLBACK' : 'COMMIT')
      if (outcome === 'COMMIT')
        expect(result, 'the second writer is refused').toMatchObject({ code: '23505', constraint })
      else expect(result).toBeUndefined()
      expect(await winners(round)).toEqual([outcome === 'COMMIT' ? 0 : 1])
      round++
    }
    // Both writers at once, each committing its own transaction.
    const write = async (db: pg.PoolClient, writer: 0 | 1) => {
      await db.query('BEGIN')
      const error = await settle(insertRow(db, table, values(round, writer)))
      await db.query(error ? 'ROLLBACK' : 'COMMIT')
      return error
    }
    const outcomes = await Promise.all([write(first, 0), write(second, 1)])
    expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(1)
    expect(outcomes.find((outcome) => outcome !== undefined)).toMatchObject({
      code: '23505',
      constraint,
    })
    expect(await winners(round)).toHaveLength(1)
  } finally {
    for (const db of [first, second]) {
      await db.query('ROLLBACK').catch(() => {})
      db.release()
    }
  }
}

/** Two people link the same IdP subject of one provider at once: one live link results. */
export async function checkLinkIdentityRace(pool: pg.Pool) {
  const setup = await pool.connect()
  let released = false
  try {
    await setup.query('BEGIN')
    const f = await identityFixture(setup)
    // A provider per round, so each round's people start without a link there.
    const providers: Record<string, unknown>[] = []
    for (let round = 0; round < 3; round++)
      providers.push(
        await insert(setup, 'sso_providers', { ...oidcProviderValues(f.team), enabled: true }),
      )
    await setup.query('COMMIT')
    setup.release()
    released = true
    const people = [f.admin, f.owner] as const
    const subject = (round: number) => `race-subject-${f.team}-${round}`
    await race(
      pool,
      'sso_identity_links',
      (round, writer) => ({
        ...linkValues(f, people[writer], providers[round]),
        subject: subject(round),
      }),
      'sso_identity_links_live_identity',
      async (round) =>
        (
          await pool.query<{ user_id: string }>(
            `SELECT user_id FROM sso_identity_links
            WHERE organization_id=$1 AND provider_id=$2 AND issuer=$3 AND subject=$4 AND retired_at IS NULL`,
            [f.team, providers[round]?.id, providers[round]?.issuer, subject(round)],
          )
        ).rows.map(({ user_id }) => people.indexOf(user_id as (typeof people)[number])),
    )
  } finally {
    if (!released) {
      await setup.query('ROLLBACK').catch(() => {})
      setup.release()
    }
  }
}

/** Two callbacks consume the same SAML assertion ID at once: one consumption results. */
export async function checkReplayRace(pool: pg.Pool) {
  const setup = await pool.connect()
  let released = false
  try {
    await setup.query('BEGIN')
    const f = await identityFixture(setup)
    await setup.query('COMMIT')
    setup.release()
    released = true
    const keys = [0, 1, 2].map(() => replayValues(f).key_digest as string)
    // Each writer records its own retention, which tells the winner apart.
    const retains = [at(600), at(601)]
    await race(
      pool,
      'sso_replay_cache',
      (round, writer) => ({
        ...replayValues(f),
        key_digest: keys[round],
        retain_until: retains[writer],
      }),
      'sso_replay_cache_pkey',
      async (round) =>
        (
          await pool.query<{ retain_until: Date }>(
            `SELECT retain_until FROM sso_replay_cache
            WHERE provider_id=$1 AND kind='saml_assertion' AND key_digest=$2`,
            [f.provider.id, keys[round]],
          )
        ).rows.map(({ retain_until }) =>
          retains.findIndex(
            (retain) => new Date(retain as string).getTime() === retain_until.getTime(),
          ),
        ),
    )
  } finally {
    if (!released) {
      await setup.query('ROLLBACK').catch(() => {})
      setup.release()
    }
  }
}
