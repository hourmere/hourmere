import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { getManagedBooking } from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { NotificationDeps } from './index.ts'
import {
  rescheduleRequestExpiryJob,
  sendRescheduleRequestNotification,
} from './reschedule-request.ts'

const NOW = Temporal.Instant.from('2026-11-01T12:00Z')
describe.skipIf(!process.env.DATABASE_URL)('reschedule request delivery and expiry', () => {
  let fixture: TestDatabase
  let db: Db
  let sent: MailMessage[]
  let deps: NotificationDeps
  beforeAll(async () => {
    fixture = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(fixture.pool)
  })
  afterAll(async () => {
    await fixture?.drop()
  })
  beforeEach(async () => {
    sent = []
    deps = {
      db,
      secret: 'fixture-only-secret',
      publicUrl: 'https://example.test',
      now: () => NOW,
      mailer: {
        send: async (message) => {
          sent.push(message)
        },
      },
    }
    await db.deleteFrom('notification_email_sends').execute()
    await sql`DELETE FROM booking_reschedule_requests`.execute(db)
  })
  async function setup(state = 'pending') {
    const f = createFixtures(db)
    const host = await f.host()
    const bookingId = await f.booking(
      host.organizationId,
      [host.userId],
      NOW.add({ hours: 72 }).toString(),
      NOW.add({ hours: 73 }).toString(),
    )
    const requestId = randomUUID()
    await sql`INSERT INTO booking_reschedule_requests(id,booking_id,idempotency_key,note,state,created_at,expires_at,resolved_at) VALUES (${requestId}::uuid,${bookingId}::uuid,${randomUUID()}::uuid,'Private note',${state},${new Date(NOW.epochMilliseconds)},${new Date(NOW.add({ hours: 48 }).epochMilliseconds)},${state === 'pending' ? null : new Date(NOW.epochMilliseconds)})`.execute(
      db,
    )
    return { bookingId, requestId, kind: 'reschedule_requested' as const }
  }
  it('delivers once under 20 concurrent replays and issues a usable manage link', async () => {
    const notice = await setup()
    await Promise.all(
      Array.from({ length: 20 }, () => sendRescheduleRequestNotification(deps, notice)),
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]?.subject).not.toContain('Private note')
    expect(sent[0]?.text).toContain('Private note')
    const token = sent[0]?.text.match(/#token=([^&]+)&action=reschedule/)?.[1]
    expect(token).toBeTruthy()
    expect((await getManagedBooking({ db, now: () => NOW }, token as string)).id).toBe(
      notice.bookingId,
    )
  })
  it.each(['replaced', 'picked', 'cancelled', 'expired'])(
    'suppresses obsolete %s requests',
    async (state) => {
      await sendRescheduleRequestNotification(deps, await setup(state))
      expect(sent).toHaveLength(0)
    },
  )
  it('detects a removed supersession guard with a source-copy assertion', async () => {
    const deliver = (await sourceCopy(
      new URL('./reschedule-request.ts', import.meta.url),
      'sendRescheduleRequestNotification',
      [["request.state === (expired ? 'expired' : 'pending')", 'true']],
    )) as typeof sendRescheduleRequestNotification
    const notice = await setup('replaced')
    await deliver(deps, notice)
    expect(() => expect(sent).toHaveLength(0)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('respects recipient budget and never issues a suppressed capability', async () => {
    const notice = await setup()
    await sendRescheduleRequestNotification({ ...deps, mailRecipientMaxPerHour: 0 }, notice)
    expect(sent).toHaveLength(0)
    const receipt = await db
      .selectFrom('booking_notifications')
      .selectAll()
      .where('booking_id', '=', notice.bookingId)
      .executeTakeFirstOrThrow()
    expect(receipt.outcome).toBe('suppressed')
    expect(receipt.manage_token_hash).toBeNull()
  })
  it('expires once, preserves the original booking and sends host-only notice', async () => {
    const notice = await setup()
    const late = NOW.add({ hours: 49 })
    const events: unknown[] = []
    const job = rescheduleRequestExpiryJob({
      db,
      now: () => late,
      notify: async (_trx, event) => {
        events.push(event)
      },
    })
    const run = { id: randomUUID(), attempt: 1, signal: new AbortController().signal }
    await job.handler({}, run)
    await job.handler({}, run)
    expect(events).toEqual([
      {
        type: 'reschedule_request_expired',
        bookingId: notice.bookingId,
        requestId: notice.requestId,
      },
    ])
    expect(
      (
        await db
          .selectFrom('bookings')
          .select('status')
          .where('id', '=', notice.bookingId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('confirmed')
    await sendRescheduleRequestNotification(
      { ...deps, now: () => late },
      { ...notice, kind: 'reschedule_request_expired' },
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).not.toBe('invitee@example.com')
    expect(sent[0]?.text).toContain('original booking remains')
    expect(sent[0]?.text).not.toMatch(/Private note|token=/)
  })
})

async function sourceCopy(url: URL, exported: string, replacements: [string, string][]) {
  let source = readFileSync(url, 'utf8')
  for (const [before, after] of replacements) {
    expect(source.includes(before)).toBe(true)
    source = source.replace(before, after)
  }
  source = stripTypeScriptTypes(source)
  const dependencies: Record<string, unknown> = {}
  for (const item of [...source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm)]) {
    const specifier = item[2] as string
    const imported = await import(
      specifier.startsWith('.') ? new URL(specifier, url).href : specifier
    )
    for (const binding of (item[1] as string)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      const [name, local] = binding.split(/\s+as\s+/)
      dependencies[local ?? (name as string)] = imported[name as string]
    }
    source = source.replace(item[0], '')
  }
  source = source.replace(/\bexport /g, '')
  return new Function(...Object.keys(dependencies), `${source}; return ${exported}`)(
    ...Object.values(dependencies),
  )
}
