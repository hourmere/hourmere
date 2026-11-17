import { createHmac, randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { MEETING_POLL_LIMITS, meetingPollDerivedKey, waitlistIpBucket } from '@hourmere/scheduling'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { enforceMeetingPollRateLimit } from './meeting-poll-rate-limit.ts'

const serverUrl = process.env.DATABASE_URL
const {
  admissionRequestsPerWindow: admission,
  ballotRequestsPerWindow: ballot,
  readRequestsPerWindow: read,
} = MEETING_POLL_LIMITS

describe.skipIf(!serverUrl)('shared meeting poll transport budgets', () => {
  let database: TestDatabase
  beforeAll(async () => {
    database = await createTestDatabase(serverUrl as string)
  })
  afterAll(async () => {
    await database?.drop()
  })

  it('shares concurrent admission requests across independent adapters and keeps categories separate', async () => {
    const deps = { db: createDb(database.pool), meetingPollSecret: 'test-poll-request-secret' }
    const other = { ...deps, db: createDb(database.pool) }
    const outcomes = await Promise.allSettled(
      Array.from({ length: admission + 5 }, (_, i) =>
        enforceMeetingPollRateLimit(i % 2 ? deps : other, 'admission', '192.0.2.5'),
      ),
    )
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(admission)
    const refused = outcomes.filter((result) => result.status === 'rejected')
    expect(refused).toHaveLength(5)
    for (const result of refused)
      expect(result.reason).toMatchObject({
        code: 'rate_limited',
        retryAfterSeconds: expect.any(Number),
      })
    await expect(enforceMeetingPollRateLimit(deps, 'read', '192.0.2.5')).resolves.toBeUndefined()
    await expect(enforceMeetingPollRateLimit(deps, 'ballot', '192.0.2.5')).resolves.toBeUndefined()
    await expect(
      enforceMeetingPollRateLimit(deps, 'admission', '192.0.2.6'),
    ).resolves.toBeUndefined()
    const rows = await sql<{
      key_digest: Buffer
      hits: number
    }>`SELECT * FROM meeting_poll_request_limits`.execute(deps.db)
    expect(rows.rows.every((row) => row.key_digest.length === 32)).toBe(true)
    expect(rows.rows.some((row) => row.hits === admission + 1)).toBe(true)
    // Keyed with a dedicated HKDF subkey, never the raw installation secret.
    const expected = createHmac(
      'sha256',
      meetingPollDerivedKey(deps.meetingPollSecret, 'request/v1'),
    )
      .update(`admission\0${waitlistIpBucket('192.0.2.5')}`)
      .digest()
    expect(rows.rows.some((row) => row.key_digest.equals(expected))).toBe(true)
    await sql`UPDATE meeting_poll_request_limits SET reset_at = now() - interval '1 second'`.execute(
      deps.db,
    )
    await expect(
      enforceMeetingPollRateLimit(deps, 'admission', '192.0.2.5'),
    ).resolves.toBeUndefined()
  })

  it('detects a source-copy bypass of shared limits', async () => {
    const source = await readFile(new URL('./meeting-poll-rate-limit.ts', import.meta.url), 'utf8')
    const mutant = source.replace('row.hits > limit', 'row.hits > limit + 100')
    expect(mutant).not.toBe(source)
    const path = new URL(`./meeting-poll-rate-limit-${randomUUID()}.ts`, import.meta.url)
    try {
      await writeFile(path, mutant)
      const mutated = await import(path.href)
      const deps = { db: createDb(database.pool), meetingPollSecret: 'test-poll-request-secret' }
      for (let i = 0; i < admission; i++)
        await mutated.enforceMeetingPollRateLimit(deps, 'admission', '192.0.2.99')
      await expect(
        (async () => {
          await expect(
            mutated.enforceMeetingPollRateLimit(deps, 'admission', '192.0.2.99'),
          ).rejects.toMatchObject({ code: 'rate_limited' })
        })(),
      ).rejects.toThrow()
      await expect(
        enforceMeetingPollRateLimit(deps, 'admission', '192.0.2.99'),
      ).rejects.toMatchObject({ code: 'rate_limited' })
    } finally {
      await rm(path, { force: true })
    }
  })

  it('groups IPv6 aliases and applies read and ballot limits', async () => {
    const deps = { db: createDb(database.pool), meetingPollSecret: 'test-poll-request-secret' }
    for (let i = 0; i < ballot; i++)
      await enforceMeetingPollRateLimit(deps, 'ballot', `2001:db8:1:2::${i.toString(16)}`)
    await expect(
      enforceMeetingPollRateLimit(deps, 'ballot', '2001:0db8:0001:0002::ffff'),
    ).rejects.toMatchObject({ code: 'rate_limited' })
    for (let i = 0; i < read; i++) await enforceMeetingPollRateLimit(deps, 'read', '192.0.2.10')
    await expect(enforceMeetingPollRateLimit(deps, 'read', '192.0.2.10')).rejects.toMatchObject({
      code: 'rate_limited',
    })
  })
})
