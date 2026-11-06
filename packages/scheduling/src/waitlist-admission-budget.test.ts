import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { isIP } from 'node:net'
import { interfaceLanguage } from '@hourmere/core/language'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { type KyselyPlugin, sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as availability from './availability.ts'
import { DomainError } from './errors.ts'
import { createFixtures } from './testing.ts'
import { cleanText } from './text.ts'
import * as waitlist from './waitlist.ts'
import * as policy from './waitlist-policy.ts'

const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
type Service = Pick<typeof waitlist, 'joinWaitlist' | 'resendWaitlistVerification'>
type Change = readonly [string, string]
function sourceCopy(change: Change): Service {
  let source = readFileSync(new URL('waitlist.ts', import.meta.url), 'utf8')
  expect(source.includes(change[0]), 'mutation must match its protection').toBe(true)
  source = stripTypeScriptTypes(
    source.replace(...change).replace(/^import[\s\S]*?from '[^']+'\n/gm, ''),
  ).replace(/\bexport /g, '')
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
    ...policy,
    DomainError,
    cleanText,
  }
  return new Function(
    ...Object.keys(bindings),
    `${source}; return { joinWaitlist, resendWaitlistVerification }`,
  )(...Object.values(bindings)) as Service
}

function queryShape(node: object) {
  return JSON.stringify(node, (key, value) => {
    if (key === 'value') return '[bound]'
    if (value?.kind === 'PrimitiveValueListNode')
      return { ...value, values: value.values.map(() => '[bound]') }
    return value
  })
}

describe.skipIf(!process.env.DATABASE_URL)(
  'waitlist mailbox-independent admission accounting',
  () => {
    let owned: TestDatabase
    let db: Db
    let clock = NOW
    let ip = 0
    const context = (database = db): waitlist.WaitlistContext => ({
      db: database,
      secret: 'synthetic-waitlist-budget-secret',
      publicUrl: 'https://booking.example.test',
      trustedIp: `192.0.2.${++ip}`,
      now: () => clock,
    })
    beforeAll(async () => {
      owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
        tag: 'waitlist_budget',
      })
      db = createDb(owned.pool)
      await db.transaction().execute((trx) => waitlist.ensureWaitlistKey(trx, context().secret))
    })
    afterAll(async () => {
      await owned?.drop()
    })
    beforeEach(async () => {
      clock = NOW
      ip = 0
      await db.deleteFrom('waitlist_entries').execute()
      await db.deleteFrom('waitlist_verification_requests').execute()
    })
    async function setup() {
      const fixtures = createFixtures(db)
      const host = await fixtures.host({ timeZone: 'UTC' })
      const eventId = await fixtures.eventType(host.organizationId, host.userId, { slug: 'full' })
      await db
        .updateTable('event_types')
        .set({ waitlist_enabled: true })
        .where('id', '=', eventId)
        .execute()
      const input = {
        handle: host.handle,
        slug: 'full',
        email: `${crypto.randomUUID()}@example.test`,
        consent: true as const,
        preferredWindow: {
          start: '2026-11-02T00:00:00Z',
          end: '2026-11-03T00:00:00Z',
          timeZone: 'UTC',
        },
      }
      await waitlist.joinWaitlist(context(), input)
      const request = await db
        .selectFrom('waitlist_verification_requests')
        .selectAll()
        .executeTakeFirstOrThrow()
      return { input, eventId, request }
    }
    async function issue(
      service: Service,
      kind: 'join' | 'resend',
      input: waitlist.JoinWaitlistInput,
    ) {
      return kind === 'join'
        ? service.joinWaitlist(context(), input)
        : service.resendWaitlistVerification(context(), input)
    }
    const suppressedCases = [
      'pending entry',
      'active entry',
      'notified entry',
      'unknown recipient',
      'mailbox cap',
      'event hourly cap',
      'event daily cap',
      'entry capacity',
    ] as const
    async function assertSuppressedAccounting(
      kind: 'join' | 'resend',
      reason: (typeof suppressedCases)[number],
      service: Service = waitlist,
    ) {
      const f = await setup()
      if (reason === 'active entry' || reason === 'notified entry')
        await db
          .updateTable('waitlist_entries')
          .set({
            status: reason === 'active entry' ? 'active' : 'notified',
            verified_at: new Date(NOW.epochMilliseconds),
          })
          .where('event_type_id', '=', f.eventId)
          .execute()
      if (reason === 'unknown recipient' || reason.endsWith('cap') || reason === 'entry capacity')
        f.input.email = `${crypto.randomUUID()}@example.test`
      if (reason === 'mailbox cap') {
        clock = NOW.add({ minutes: 15 })
        // Two admitted generations reach the mailbox cap. The next request is silent.
        f.input.email = (
          await db.selectFrom('waitlist_entries').select('email').executeTakeFirstOrThrow()
        ).email as string
        await waitlist.resendWaitlistVerification(context(), f.input)
        clock = NOW.add({ minutes: 30 })
      }
      if (reason === 'event hourly cap' || reason === 'event daily cap') {
        const count = reason === 'event hourly cap' ? 19 : 99
        if (reason === 'event daily cap')
          await db
            .updateTable('waitlist_verification_requests')
            .set({ requested_at: new Date(NOW.epochMilliseconds - 2 * 3_600_000) })
            .execute()
        await db
          .insertInto('waitlist_verification_requests')
          .values(
            Array.from({ length: count }, () => ({
              event_type_id: f.eventId,
              email_hash: Buffer.alloc(32, 1),
              ip_hash: Buffer.alloc(32, 2),
              generation_id: crypto.randomUUID(),
              requested_at: new Date(
                NOW.epochMilliseconds - (reason === 'event daily cap' ? 2 * 3_600_000 : 0),
              ),
            })),
          )
          .execute()
      }
      if (reason === 'entry capacity') {
        const entry = await db.selectFrom('waitlist_entries').selectAll().executeTakeFirstOrThrow()
        await db
          .insertInto('waitlist_entries')
          .values(
            Array.from({ length: 99 }, () => {
              const email = `${crypto.randomUUID()}@example.test`
              return {
                ...entry,
                id: crypto.randomUUID(),
                email,
                recipient_hash: waitlist.waitlistRecipientHash(email, context().secret),
              }
            }),
          )
          .execute()
      }
      // Unknown recipients can join normally; for the silent join case, use a full event.
      if (reason === 'unknown recipient' && kind === 'join')
        await db
          .insertInto('waitlist_verification_requests')
          .values(
            Array.from({ length: 19 }, () => ({
              event_type_id: f.eventId,
              email_hash: Buffer.alloc(32, 1),
              ip_hash: Buffer.alloc(32, 2),
              generation_id: crypto.randomUUID(),
              requested_at: new Date(NOW.epochMilliseconds),
            })),
          )
          .execute()
      const before = await db.selectFrom('waitlist_verification_requests').selectAll().execute()
      const mailBefore = await db.selectFrom('waitlist_verification_outbox').selectAll().execute()
      if (kind === 'join' && reason === 'entry capacity')
        await expect(issue(service, kind, f.input)).rejects.toMatchObject({ code: 'waitlist_full' })
      else expect(await issue(service, kind, f.input)).toEqual({ accepted: true })
      const after = await db.selectFrom('waitlist_verification_requests').selectAll().execute()
      expect(after, `${kind} ${reason} must debit IP and event`).toHaveLength(before.length + 1)
      expect(
        after
          .filter((row) => !before.some((previous) => previous.id === row.id))
          .map((row) => row.event_type_id),
        'suppressed requests must debit the requested event',
      ).toEqual([f.eventId])
      expect(
        after.filter((row) => row.email_hash.equals(f.request.email_hash)),
        'silent requests must not debit mailbox allowance',
      ).toHaveLength(before.filter((row) => row.email_hash.equals(f.request.email_hash)).length)
      expect(await db.selectFrom('waitlist_verification_outbox').selectAll().execute()).toEqual(
        mailBefore,
      )
    }
    for (const kind of ['join', 'resend'] as const)
      it.each(suppressedCases)(
        `counts unmailed ${kind} requests for %s without debiting mail`,
        (reason) => assertSuppressedAccounting(kind, reason),
      )

    it('kills a source-copy capacity rejection that rolls back durable accounting', async () => {
      await expect(
        assertSuppressedAccounting(
          'join',
          'entry capacity',
          sourceCopy([
            "if (Number(count.n) >= 100) return 'full' as const",
            "if (Number(count.n) >= 100) throw new DomainError('conflict', 'waitlist_full')",
          ]),
        ),
      ).rejects.toThrow(/must debit IP and event/)
    })

    it.each(['join', 'resend'] as const)(
      'kills a source-copy bypass of durable accounting for silent %s',
      async (kind) => {
        const source = readFileSync(new URL('waitlist.ts', import.meta.url), 'utf8')
        const start = source.indexOf(
          "  await db\n    .insertInto('waitlist_verification_requests')",
        )
        const end = source.indexOf('\n  return {', start)
        expect(start).toBeGreaterThan(0)
        await expect(
          assertSuppressedAccounting(
            kind,
            'pending entry',
            sourceCopy([source.slice(start, end), '']),
          ),
        ).rejects.toThrow(/must debit IP and event/)
      },
    )
    it.each(['join', 'resend'] as const)(
      'kills a source-copy mailbox debit for silent %s',
      async (kind) => {
        await expect(
          assertSuppressedAccounting(
            kind,
            'pending entry',
            sourceCopy([
              "      email_hash: admissionHash(requestId, secret, 'request'),",
              '      email_hash: emailHash,',
            ]),
          ),
        ).rejects.toThrow(/must not debit mailbox allowance/)
      },
    )

    async function assertEventProbe(kind: 'join' | 'resend', service: Service = waitlist) {
      const f = await setup()
      for (let index = 0; index < 19; index++) await issue(service, kind, f.input)
      expect(
        await service.joinWaitlist(context(), {
          ...f.input,
          email: `${crypto.randomUUID()}@example.test`,
        }),
      ).toEqual({ accepted: true })
      expect(
        await db
          .selectFrom('waitlist_entries')
          .select('id')
          .where('event_type_id', '=', f.eventId)
          .execute(),
        'silent requests must consume the event allowance',
      ).toHaveLength(1)
    }
    it.each(['join', 'resend'] as const)(
      'counts repeated silent %s requests against the event cap',
      (kind) => assertEventProbe(kind),
    )
    it.each(['join', 'resend'] as const)(
      'kills a source-copy event-accounting bypass for silent %s',
      async (kind) => {
        await expect(
          assertEventProbe(
            kind,
            sourceCopy(['      event_type_id: eventId,', '      event_type_id: randomUUID(),']),
          ),
        ).rejects.toThrow(/must consume the event allowance/)
      },
    )

    async function assertIpProbe(kind: 'join' | 'resend', service: Service = waitlist) {
      const f = await setup()
      const ctx = context()
      const outcomes: string[] = []
      for (let index = 0; index < 6; index++) {
        const input = {
          ...f.input,
          email: index === 0 ? f.input.email : `${crypto.randomUUID()}@example.test`,
        }
        try {
          await (index === 0 && kind === 'resend'
            ? service.resendWaitlistVerification(ctx, input)
            : service.joinWaitlist(ctx, input))
          outcomes.push('accepted')
        } catch (error) {
          expect(error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 3600 })
          outcomes.push('rate_limited')
        }
      }
      expect(outcomes, 'every well-formed request must debit its IP').toEqual([
        'accepted',
        'accepted',
        'accepted',
        'accepted',
        'accepted',
        'rate_limited',
      ])
    }
    it.each(['join', 'resend'] as const)('counts the target %s before five fresh joins', (kind) =>
      assertIpProbe(kind),
    )
    it.each(['join', 'resend'] as const)(
      'kills a source-copy IP-accounting bypass for target %s',
      async (kind) => {
        await expect(
          assertIpProbe(
            kind,
            sourceCopy(['      ip_hash: ipHash,', '      ip_hash: randomBytes(32),']),
          ),
        ).rejects.toThrow(/must debit its IP/)
      },
    )

    async function assertCommonQueryOrder(service: Service = waitlist) {
      const f = await setup()
      const statements: string[] = []
      const plugin: KyselyPlugin = {
        transformQuery({ node }) {
          statements.push(queryShape(node))
          return node
        },
        async transformResult({ result }) {
          return result
        },
      }
      const monitored = db.withPlugin(plugin)
      const candidate = { ...f.input, email: `${crypto.randomUUID()}@example.test` }
      await service.joinWaitlist(context(monitored), candidate)
      const fresh = statements.splice(0)
      await service.joinWaitlist(context(monitored), candidate)
      expect(statements.at(-1), 'same DB work order includes the live-entry aggregate').toContain(
        '"duplicate"',
      )
      expect(
        fresh.slice(0, statements.length),
        'same DB work order before mailbox branching',
      ).toEqual(statements)
    }
    it('performs the same common DB work before branching for new and existing mailboxes', () =>
      assertCommonQueryOrder())
    it('kills a source-copy early duplicate lookup that skips the common admission aggregate', async () => {
      const mutant = sourceCopy([
        '    const count = await db',
        `    if (await db.selectFrom('waitlist_entries').select('id').where('event_type_id', '=', et.id).where('recipient_hash', '=', recipientHash).where('status', 'in', LIVE).executeTakeFirst()) return accepted()
    const count = await db`,
      ])
      await expect(assertCommonQueryOrder(mutant)).rejects.toThrow(/same DB work order/)
    })

    async function assertResendQueryOrder(service: Service = waitlist) {
      const f = await setup()
      const statements: string[] = []
      const plugin: KyselyPlugin = {
        transformQuery({ node }) {
          statements.push(queryShape(node))
          return node
        },
        async transformResult({ result }) {
          return result
        },
      }
      const monitored = db.withPlugin(plugin)
      await service.resendWaitlistVerification(context(monitored), f.input)
      const existing = statements.splice(0)
      await service.resendWaitlistVerification(context(monitored), {
        ...f.input,
        email: `${crypto.randomUUID()}@example.test`,
      })
      expect(statements, 'same resend DB work order for pending and absent mailboxes').toEqual(
        existing,
      )
    }
    it('performs the same resend lookups for pending and absent mailboxes', () =>
      assertResendQueryOrder())
    it('kills a source-copy early absent-recipient return that skips the resend outbox lookup', async () => {
      await expect(
        assertResendQueryOrder(
          sourceCopy([
            '    const previous = await db',
            '    if (!entry) return accepted()\n    const previous = await db',
          ]),
        ),
      ).rejects.toThrow(/same resend DB work order/)
    })
  },
)
