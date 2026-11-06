// Real booking transactions must progress while unrelated admission work is queued.
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { isIP } from 'node:net'
import { interfaceLanguage } from '@hourmere/core/language'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as availability from './availability.ts'
import { createPublicBooking } from './bookings.ts'
import { DomainError } from './errors.ts'
import { createFixtures, type Fixtures } from './testing.ts'
import { cleanText } from './text.ts'
import * as waitlist from './waitlist.ts'

const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const serverUrl = process.env.DATABASE_URL
const ADMISSION = 'await sql`SELECT pg_advisory_xact_lock(1752658796, 1633969261)`.execute(db)'

type Change = readonly [string, string]
/** Mutations run on isolated source copies, without changing imported production modules. */
function sourceCopy(changes: Change[] = [], overrides: Partial<typeof availability> = {}) {
  let source = readFileSync('packages/scheduling/src/waitlist.ts', 'utf8')
  for (const [before, after] of changes) {
    expect(source.includes(before), 'mutation must match its protection').toBe(true)
    source = source.replace(before, after)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = {
    createCipheriv: crypto.createCipheriv,
    createDecipheriv: crypto.createDecipheriv,
    createHash: crypto.createHash,
    createHmac: crypto.createHmac,
    hkdfSync: crypto.hkdfSync,
    randomBytes: crypto.randomBytes,
    randomUUID: crypto.randomUUID,
    isIP,
    interfaceLanguage,
    sql,
    z,
    ...availability,
    DomainError,
    cleanText,
    ...overrides,
  }
  return new Function(
    ...Object.keys(bindings),
    `${source}; return { joinWaitlist, resendWaitlistVerification, waitlistIpBucket }`,
  )(...Object.values(bindings)) as Pick<
    typeof waitlist,
    'joinWaitlist' | 'resendWaitlistVerification' | 'waitlistIpBucket'
  >
}

function assertBuckets(bucket: typeof waitlist.waitlistIpBucket) {
  for (const address of ['::ffff:192.0.2.1', '::ffff:c000:201', '0:0:0:0:0:ffff:c000:0201'])
    expect(bucket(address)).toBe('192.0.2.1')
  expect(bucket('::ffff:5.6.7.8')).toBe('5.6.7.8')
  expect(bucket('::ffff:0:0')).toBe('0.0.0.0')
  expect(bucket('::ffff:ffff:ffff')).toBe('255.255.255.255')
  expect(bucket('::1')).toBe('0:0:0:0::/64')
}
function assertZones(bucket: typeof waitlist.waitlistIpBucket) {
  expect(() => bucket('fe80::1%eth0')).not.toThrow()
  expect(bucket('fe80::1%eth0')).toBe(bucket('fe80::abcd%en1'))
  expect(bucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
  expect(bucket('::ffff:c000:201%en0')).toBe('192.0.2.1')
  for (const address of [undefined, '', 'invalid', 'fe80::zz%eth0', '192.0.2.1%eth0'])
    expect(bucket(address)).toBe('unknown')
}

describe('waitlist socket IP normalization', () => {
  it('shares mapped IPv4 aliases with IPv4 while keeping distinct IPv4 addresses separate', () => {
    assertBuckets(waitlist.waitlistIpBucket)
  })
  it('strips IPv6 zone identifiers and safely buckets invalid input', () => {
    assertZones(waitlist.waitlistIpBucket)
  })
  it('kills source-copy mutations removing mapped address or zone normalization', () => {
    expect(() =>
      assertBuckets(
        sourceCopy([['Number.parseInt(groups[5] as string, 16) === 0xffff', 'false']])
          .waitlistIpBucket,
      ),
    ).toThrow(/expected/i)
    expect(() =>
      assertZones(
        sourceCopy([["value?.includes(':') ? value.split('%', 1)[0] : value", 'value']])
          .waitlistIpBucket,
      ),
    ).toThrow(/expected/i)
  })
})

describe.skipIf(!serverUrl)('waitlist admission lock scope', { timeout: 20000 }, () => {
  let testDb: TestDatabase
  let db: Db
  let f: Fixtures
  let ctx: waitlist.WaitlistContext
  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string, undefined, { tag: 'waitlist_locks' })
    db = createDb(testDb.pool)
    f = createFixtures(db)
    ctx = {
      db,
      secret: 'synthetic-admission-lock-secret',
      publicUrl: 'https://booking.example.test',
      now: () => NOW,
    }
    await db.transaction().execute((trx) => waitlist.ensureWaitlistKey(trx, ctx.secret))
  })
  afterAll(async () => {
    await testDb?.drop()
  })
  beforeEach(async () => {
    await db.deleteFrom('waitlist_verification_requests').execute()
  })

  async function setup() {
    const host = await f.host()
    await f.schedule(host.userId)
    const eventId = await f.eventType(host.organizationId, host.userId, { slug: 'intro' })
    await db
      .updateTable('event_types')
      .set({ waitlist_enabled: true })
      .where('id', '=', eventId)
      .execute()
    const input = {
      handle: host.handle,
      slug: 'intro',
      email: `${crypto.randomUUID()}@example.test`,
      consent: true as const,
      // No offered slots after the host's working day; an ordinary earlier slot is free.
      preferredWindow: {
        start: '2026-11-02T18:00:00Z',
        end: '2026-11-02T20:00:00Z',
        timeZone: 'UTC',
      },
    }
    return { input }
  }

  async function assertBookingProgress(kind: 'join' | 'resend', service = waitlist) {
    const { input } = await setup()
    if (kind === 'resend') await waitlist.joinWaitlist(ctx, input)
    const blocker = await testDb.pool.connect()
    let admission: Promise<unknown> | undefined
    let booking: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock(1752658796, 1633969261)')
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid
      if (!blockerPid) throw new Error('Expected blocker backend')
      admission = (
        kind === 'join'
          ? service.joinWaitlist(ctx, input)
          : service.resendWaitlistVerification(ctx, input)
      ).catch((error: unknown) => error)
      // Observe the actual queued admission, not an arbitrary delay.
      let admissionPid = 0
      await expect
        .poll(
          async () => {
            const { rows } = await testDb.pool.query<{ pid: number }>(
              "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 1752658796 AND objid = 1633969261 AND NOT granted AND $1 = ANY(pg_blocking_pids(pid))",
              [blockerPid],
            )
            admissionPid = rows[0]?.pid ?? 0
            return admissionPid > 0
          },
          { timeout: 5000 },
        )
        .toBe(true)
      let bookingPid = 0
      let completed = false
      booking = db
        .connection()
        .execute(async (connection) => {
          bookingPid =
            (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(connection)).rows[0]
              ?.pid ?? 0
          const result = await createPublicBooking(
            { db: connection, now: () => NOW },
            {
              handle: input.handle,
              slug: input.slug,
              start: Temporal.Instant.from('2026-11-02T08:00:00Z'),
              invitee: { name: 'Booker', email: 'booker@example.test', timeZone: 'UTC' },
            },
          )
          completed = true
          return result
        })
        .catch((error: unknown) => error)
      let blockers: number[] = []
      await expect
        .poll(
          async () => {
            if (bookingPid) {
              const { rows } = await testDb.pool.query<{ blockers: number[] }>(
                'SELECT pg_blocking_pids($1) AS blockers',
                [bookingPid],
              )
              blockers = rows[0]?.blockers ?? []
            }
            return completed || blockers.length > 0
          },
          { timeout: 5000 },
        )
        .toBe(true)
      expect(
        blockers.includes(admissionPid),
        'ordinary booking must not wait for queued admission',
      ).toBe(false)
      expect(completed, 'ordinary booking commits while the admission fence remains held').toBe(
        true,
      )
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await Promise.all([admission, booking])
    }
  }

  it.each(['join', 'resend'] as const)(
    'lets the same-event booking commit while %s waits on unrelated admission',
    async (kind) => {
      await assertBookingProgress(kind)
    },
  )
  it.each(['join', 'resend'] as const)(
    'kills an exclusive event-lock mutation for %s using real booking lock waits',
    async (kind) => {
      const mutant = sourceCopy([
        ['if (lock) query = query.forShare()', 'if (lock) query = query.forUpdate()'],
      ])
      await expect(assertBookingProgress(kind, { ...waitlist, ...mutant })).rejects.toThrow(
        'ordinary booking must not wait',
      )
    },
  )
  it('computes availability before acquiring the global fence and kills early-lock mutation', async () => {
    const { input } = await setup()
    const overrides = {
      listPublicSlots: async (...args: Parameters<typeof availability.listPublicSlots>) => {
        const locks = await sql<{
          n: string
        }>`SELECT count(*) AS n FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND classid = 1752658796 AND objid = 1633969261 AND granted`.execute(
          args[0].db,
        )
        expect(Number(locks.rows[0]?.n), 'availability must run outside the admission fence').toBe(
          0,
        )
        return availability.listPublicSlots(...args)
      },
    }
    await sourceCopy([], overrides).joinWaitlist(ctx, input)
    const mutant = sourceCopy(
      [
        [
          'const checkedAt = await waitlistNow',
          `${ADMISSION}\n    const checkedAt = await waitlistNow`,
        ],
      ],
      overrides,
    )
    await expect(mutant.joinWaitlist(ctx, input)).rejects.toThrow('availability must run outside')
  })
})
