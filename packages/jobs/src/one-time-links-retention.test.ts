import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as Retention from './one-time-links-retention.ts'

const databaseUrl = process.env.DATABASE_URL
type RetentionModule = typeof Retention

/** The mutations execute source copies without changing files used by parallel agents. */
async function sourceCopy(before: string, after: string): Promise<RetentionModule> {
  const location = new URL('./one-time-links-retention.ts', import.meta.url)
  const original = readFileSync(location, 'utf8')
  expect(original.includes(before), 'mutation matches a retention protection').toBe(true)
  const source = stripTypeScriptTypes(original.replace(before, after)).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

describe.skipIf(!databaseUrl)('one-time link retention (real Postgres)', () => {
  let owned: TestDatabase, db: Db
  let userId: string, organizationId: string, eventTypeId: string
  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'link_retention' })
    db = createDb(owned.pool)
    userId = (
      await db
        .insertInto('auth.user')
        .values({
          name: 'Retention host',
          email: `${randomUUID()}@example.test`,
          emailVerified: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    organizationId = (
      await db
        .insertInto('auth.organization')
        .values({
          name: 'Retention team',
          slug: `retention-${randomUUID()}`,
          createdAt: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    eventTypeId = (
      await db
        .insertInto('event_types')
        .values({
          organization_id: organizationId,
          owner_user_id: null,
          slug: 'retention',
          title: 'Retention fixture',
          duration_minutes: 30,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
  })
  beforeEach(async () => {
    await db.deleteFrom('one_time_booking_links').execute()
    await db.deleteFrom('bookings').execute()
  })
  afterAll(async () => {
    await owned?.drop()
  })

  type LinkFixture = {
    state?: 'active' | 'expired' | 'revoked'
    expiredDaysAgo?: number
    revokedDaysAgo?: number
  }
  async function links(options: LinkFixture = {}, count = 1) {
    const result = await owned.pool.query<{ id: string }>(
      `INSERT INTO one_time_booking_links
        (organization_id,event_type_id,creator_user_id,token_hash,state,
         expires_at,revoked_at,prefill_name,prefill_email)
       SELECT $1,$2,$3,encode(sha256(uuidv7()::text::bytea),'hex'),$4,
         clock_timestamp() - $5::double precision * INTERVAL '1 day',
         clock_timestamp() - $6::double precision * INTERVAL '1 day',
         'Invitee prefill','invitee@example.test'
       FROM generate_series(1,$7::integer) RETURNING id`,
      [
        organizationId,
        eventTypeId,
        userId,
        options.state ?? 'active',
        options.expiredDaysAgo ?? null,
        options.revokedDaysAgo ?? null,
        count,
      ],
    )
    return result.rows.map(({ id }) => id)
  }

  const run = (module = Retention, signal = new AbortController().signal) =>
    module.oneTimeBookingLinksRetentionJob(db).handler({}, { id: randomUUID(), attempt: 1, signal })
  const remaining = async () =>
    (await db.selectFrom('one_time_booking_links').select('id').execute())
      .map(({ id }) => id)
      .sort()

  async function usedHistoricalLink() {
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      const booking = await client.query<{ id: string }>(
        `INSERT INTO bookings
          (organization_id,event_type_id,title,start_at,end_at,manage_token_hash,source)
         VALUES ($1,$2,'Historical booking',clock_timestamp()-INTERVAL '180 days',
           clock_timestamp()-INTERVAL '180 days'+INTERVAL '30 minutes',$3,'web') RETURNING id`,
        [organizationId, eventTypeId, createHash('sha256').update(randomUUID()).digest()],
      )
      // Model a link genuinely consumed 180 days ago. Today's issuance guard correctly
      // refuses consumption after expiry, so bypass only that guard while seeding history.
      await client.query(
        'ALTER TABLE one_time_booking_links DISABLE TRIGGER one_time_booking_links_guard',
      )
      const link = await client.query<{ id: string }>(
        `INSERT INTO one_time_booking_links
          (organization_id,event_type_id,creator_user_id,token_hash,state,booking_id,
           expires_at,used_at,created_at,prefill_name,prefill_email)
         VALUES ($1,$2,$3,encode(sha256(uuidv7()::text::bytea),'hex'),'used',$4,
           clock_timestamp()-INTERVAL '179 days',clock_timestamp()-INTERVAL '180 days',
           clock_timestamp()-INTERVAL '181 days','Used invitee','used@example.test') RETURNING id`,
        [organizationId, eventTypeId, userId, booking.rows[0]?.id],
      )
      await client.query(
        'ALTER TABLE one_time_booking_links ENABLE TRIGGER one_time_booking_links_guard',
      )
      await client.query('COMMIT')
      return link.rows[0]?.id as string
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async function verifyRetention(module = Retention) {
    const kept = [
      ...(await links()),
      ...(await links({ expiredDaysAgo: -10 })),
      ...(await links({ expiredDaysAgo: 89 })),
      ...(await links({ state: 'expired', expiredDaysAgo: 89 })),
      ...(await links({ state: 'revoked', expiredDaysAgo: 180, revokedDaysAgo: 1 })),
      ...(await links({ state: 'revoked', revokedDaysAgo: 89 })),
      await usedHistoricalLink(),
    ].sort()
    await links({ expiredDaysAgo: 91 })
    await links({ state: 'expired', expiredDaysAgo: 91 })
    await links({ state: 'revoked', revokedDaysAgo: 91 })
    await run(module)
    expect(
      await remaining(),
      'cleanup deletes only unused links that ended over 90 days ago',
    ).toEqual(kept)
    await run(module)
    expect(await remaining(), 'repeated cleanup preserves retained links').toEqual(kept)
    expect(await db.selectFrom('bookings').select('id').execute()).toHaveLength(1)
  }

  it('retains used, live, nonexpiring and recently ended links, and is idempotent', async () => {
    await verifyRetention()
  })

  async function verifyBatch(module = Retention) {
    await links({ expiredDaysAgo: 91 }, 501)
    await links({ state: 'revoked', revokedDaysAgo: 91 }, 501)
    await run(module)
    expect(
      (await remaining()).length,
      'one dispatch deletes at most 500 links across both states',
    ).toBe(502)
  }

  it('deletes one combined batch of 500 rows and drains the backlog on later dispatches', async () => {
    await verifyBatch()
    await run()
    expect(await remaining()).toHaveLength(2)
    await run()
    expect(await remaining()).toHaveLength(0)
    await run()
    expect(await remaining()).toHaveLength(0)
  })

  async function verifySkipLocked(module = Retention) {
    const locked = await links({ expiredDaysAgo: 91 })
    const other = await links({ state: 'revoked', revokedDaysAgo: 91 })
    const blocker = await owned.pool.connect()
    let cleanup: Promise<void> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM one_time_booking_links WHERE id=$1 FOR UPDATE', locked)
      cleanup = run(module)
      const completed = await Promise.race([
        cleanup.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
      ])
      expect(completed, 'cleanup skips foreground row locks instead of waiting').toBe(true)
      expect(await remaining()).toEqual(locked)
      expect((await remaining()).includes(other[0] as string)).toBe(false)
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await cleanup
    }
  }

  it('skips locked links so foreground operations and other workers can finish', async () => {
    await verifySkipLocked()
    await run()
    expect(await remaining()).toHaveLength(0)
  })

  it('does no work after shutdown has aborted a dispatch', async () => {
    const retained = await links({ expiredDaysAgo: 91 })
    await run(Retention, AbortSignal.abort())
    expect(await remaining()).toEqual(retained)
  })

  it.each([
    [
      'expiry grace',
      "expires_at <= statement_timestamp() - INTERVAL '90 days'",
      'expires_at <= statement_timestamp()',
    ],
    [
      'revocation grace',
      "revoked_at <= statement_timestamp() - INTERVAL '90 days'",
      'revoked_at <= statement_timestamp()',
    ],
    ['used evidence', "state IN ('active', 'expired')", "state IN ('active', 'expired', 'used')"],
    [
      'nonexpiring links',
      "AND expires_at <= statement_timestamp() - INTERVAL '90 days'",
      "AND (expires_at IS NULL OR expires_at <= statement_timestamp() - INTERVAL '90 days')",
    ],
    [
      'revocation clock',
      "AND revoked_at <= statement_timestamp() - INTERVAL '90 days'",
      "AND expires_at <= statement_timestamp() - INTERVAL '90 days'",
    ],
    ['expired deletion', "state IN ('active', 'expired')", "state = 'active' AND false"],
    ['revoked deletion', "WHERE state = 'revoked'", "WHERE state = 'revoked' AND false"],
  ])('detects source-copy removal of %s', async (_, before, after) => {
    const copy = await sourceCopy(before, after)
    await expect(verifyRetention(copy)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('cleanup deletes only unused links'),
    })
  })

  it('detects source-copy removal of the combined batch cap', async () => {
    const copy = await sourceCopy(
      'SELECT id FROM ended ORDER BY ended_at, id LIMIT 500',
      'SELECT id FROM ended ORDER BY ended_at, id LIMIT 1000',
    )
    await expect(verifyBatch(copy)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('at most 500 links across both states'),
    })
  })

  it('detects source-copy removal of skip-locked protection', async () => {
    const copy = await sourceCopy('LIMIT 500 FOR UPDATE SKIP LOCKED', 'LIMIT 500 FOR UPDATE')
    await expect(verifySkipLocked(copy)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('cleanup skips foreground row locks'),
    })
  })

  it('detects source-copy removal of shutdown protection', async () => {
    const copy = await sourceCopy('if (signal.aborted) return', 'if (false) return')
    const kept = await links({ expiredDaysAgo: 91 })
    const verify = async () => {
      await run(copy, AbortSignal.abort())
      expect(await remaining(), 'aborted dispatch preserves every row').toEqual(kept)
    }
    await expect(verify()).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('aborted dispatch preserves every row'),
    })
  })
})
