import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { interfaceLanguage } from '@hourmere/core/language'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { escapeHtml, icsAttachment, type MailMessage } from '@hourmere/mail'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  groupFixture,
  insertSeat,
  occupiedSlot,
  transaction,
} from '../../db/src/group-seats-fixtures.ts'
import { deliverGroupHostMail, enqueueGroupHostMail } from './group-host-mail.ts'
import type { NotificationDeps } from './index.ts'
import {
  lockNotificationEmailBudget,
  notificationEmailBudget,
  notificationRecipientHash,
} from './mail-limits.ts'

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture')
  return value
}

function sourceCopy(change?: [string, string], bindings: Record<string, unknown> = {}) {
  let source = readFileSync('packages/notifications/src/group-host-mail.ts', 'utf8')
  if (change) {
    expect(source).toContain(change[0])
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const deps = {
    sql,
    randomUUID,
    escapeHtml,
    icsAttachment,
    interfaceLanguage,
    lockNotificationEmailBudget,
    notificationEmailBudget,
    notificationRecipientHash,
    ...bindings,
  }
  return new Function(
    ...Object.keys(deps),
    `${source}; return {deliverGroupHostMail,enqueueGroupHostMail}`,
  )(...Object.values(deps)) as {
    deliverGroupHostMail: typeof deliverGroupHostMail
    enqueueGroupHostMail: typeof enqueueGroupHostMail
  }
}

describe.skipIf(!process.env.DATABASE_URL)('slot host communications', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function fixture(overrides: Record<string, unknown> = {}) {
    const f = await groupFixture(owned.pool)
    const now = Temporal.Instant.from(f.start).subtract({ hours: 48 })
    const occupied = await occupiedSlot(f, 2, {
      ...overrides,
      created_at: new Date(now.epochMilliseconds),
      host_notification_settings: JSON.stringify({
        version: 1,
        executionMode: 'configurable',
        notifications: {
          reminders: [
            {
              id: 'remind',
              offsetMinutes: 1440,
              recipients: { host: true, invitee: true, guests: false },
            },
          ],
          followUps: [
            {
              id: 'after',
              offsetMinutes: 60,
              recipients: { host: true, invitee: false, guests: false },
            },
          ],
        },
      }),
    })
    await db
      .insertInto('auth.member')
      .values({
        organizationId: f.organization,
        userId: f.host,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    const sent: MailMessage[] = []
    const deps: NotificationDeps = {
      db,
      secret: 'synthetic',
      publicUrl: 'https://example.test',
      now: () => now,
      mailMaxPerHour: 0,
      mailer: {
        senderEmail: 'sender@example.test',
        send: async (message) => {
          sent.push(message)
        },
      },
    }
    return { f, ...occupied, now, deps, sent }
  }
  async function rows(slot: string) {
    return (
      await sql<{
        id: string
        kind: string
        state: string
        attempts: number
      }>`SELECT id,kind,state,attempts FROM group_slot_host_messages WHERE group_slot_id=${slot} ORDER BY kind`.execute(
        db,
      )
    ).rows
  }
  it('keeps one immutable host schedule per slot and gives calendar only the shared UID', async () => {
    const f = await fixture()
    for (const booking of f.bookings) await enqueueGroupHostMail(db, booking, f.now)
    expect((await rows(f.slot)).map((r) => r.kind)).toEqual(['calendar', 'follow_up', 'reminder'])
    const calendar = must((await rows(f.slot)).find((r) => r.kind === 'calendar'))
    await deliverGroupHostMail(f.deps, calendar.id)
    await deliverGroupHostMail(f.deps, calendar.id)
    expect(f.sent).toHaveLength(1)
    const ics = f.sent[0]?.attachments?.[0]?.content ?? ''
    expect(ics).toContain(`UID:group-${f.slot}@hourmere`)
    for (const booking of f.bookings) expect(ics).not.toContain(booking)
    expect(ics.match(/ATTENDEE;/g)).toHaveLength(1)
    expect(ics).not.toContain('Invitee')
    f.deps.now = () => f.now.add({ hours: 24 })
    const reminder = must((await rows(f.slot)).find((r) => r.kind === 'reminder'))
    await Promise.all([
      deliverGroupHostMail(f.deps, reminder.id),
      deliverGroupHostMail(f.deps, reminder.id),
    ])
    expect(f.sent).toHaveLength(2)
    expect(f.sent[1]?.attachments).toBeUndefined()
  })
  it('survives the first seat cancellation and cancels host ICS only after the last exit', async () => {
    const f = await fixture()
    for (const booking of f.bookings) await enqueueGroupHostMail(db, booking, f.now)
    const calendar = must((await rows(f.slot)).find((r) => r.kind === 'calendar'))
    await deliverGroupHostMail(f.deps, calendar.id)
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: new Date(f.now.epochMilliseconds) })
      .where('id', '=', must(f.bookings[0]))
      .execute()
    await enqueueGroupHostMail(db, must(f.bookings[0]), f.now)
    await deliverGroupHostMail(f.deps, calendar.id)
    expect(f.sent[1]?.attachments?.[0]?.content).toContain('METHOD:REQUEST')
    expect((await rows(f.slot)).find((r) => r.kind === 'reminder')?.state).toBe('pending')
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: new Date(f.now.epochMilliseconds) })
      .where('id', '=', must(f.bookings[1]))
      .execute()
    await enqueueGroupHostMail(db, must(f.bookings[1]), f.now)
    await deliverGroupHostMail(f.deps, calendar.id)
    expect(f.sent[2]?.attachments?.[0]?.content).toContain('METHOD:CANCEL')
    expect(
      (await rows(f.slot)).filter((r) => r.kind !== 'calendar').every((r) => r.state === 'skipped'),
    ).toBe(true)
  })
  it('counts host mail in the shared instance budget and terminally suppresses it', async () => {
    const f = await fixture()
    await enqueueGroupHostMail(db, must(f.bookings[0]), f.now)
    await db
      .insertInto('notification_email_sends')
      .values({ recipient_hash: null, sent_at: new Date(f.now.epochMilliseconds) })
      .execute()
    f.deps.mailMaxPerHour = 1
    const calendar = must((await rows(f.slot)).find((r) => r.kind === 'calendar'))
    await deliverGroupHostMail(f.deps, calendar.id)
    expect(f.sent).toHaveLength(0)
    expect((await rows(f.slot)).find((r) => r.kind === 'calendar')?.state).toBe('suppressed')
  })
  it('does not reset delivered host reminders when another seat joins', async () => {
    const f = await fixture()
    await enqueueGroupHostMail(db, must(f.bookings[0]), f.now)
    f.deps.now = () => f.now.add({ hours: 24 })
    const reminder = must((await rows(f.slot)).find((r) => r.kind === 'reminder'))
    await deliverGroupHostMail(f.deps, reminder.id)
    const next = await transaction(owned.pool, (client) => insertSeat(client, f.f, f.slot))
    await enqueueGroupHostMail(db, next, must(f.deps.now)())
    expect((await rows(f.slot)).find((r) => r.kind === 'reminder')).toMatchObject({
      id: reminder.id,
      state: 'sent',
      attempts: 1,
    })
  })
  it('detects a source-copy mutation resetting first-slot host policy receipts', async () => {
    const f = await fixture()
    await enqueueGroupHostMail(db, must(f.bookings[0]), f.now)
    const reminder = must((await rows(f.slot)).find((r) => r.kind === 'reminder'))
    f.deps.now = () => f.now.add({ hours: 24 })
    await deliverGroupHostMail(f.deps, reminder.id)
    let source = readFileSync('packages/notifications/src/group-host-mail.ts', 'utf8')
    const before = 'ON CONFLICT(group_slot_id,kind,rule_id) DO NOTHING'
    expect(source).toContain(before)
    source = source.replace(
      before,
      "ON CONFLICT(group_slot_id,kind,rule_id) DO UPDATE SET state='pending',attempts=0",
    )
    source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
      /\bexport /g,
      '',
    )
    const mutate = new Function('sql', 'randomUUID', `${source}; return enqueueGroupHostMail`)(
      sql,
      randomUUID,
    ) as typeof enqueueGroupHostMail
    await mutate(db, must(f.bookings[1]), must(f.deps.now)())
    await expect(
      (async () => {
        expect((await rows(f.slot)).find((r) => r.kind === 'reminder')?.state).toBe('sent')
      })(),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  async function verifyBudget(deliver: typeof deliverGroupHostMail) {
    const f = await fixture()
    await enqueueGroupHostMail(db, must(f.bookings[0]), f.now)
    await db
      .insertInto('notification_email_sends')
      .values({ recipient_hash: null, sent_at: new Date(f.now.epochMilliseconds) })
      .execute()
    f.deps.mailMaxPerHour = 1
    await deliver(f.deps, must((await rows(f.slot)).find((r) => r.kind === 'calendar')).id)
    expect(f.sent).toHaveLength(0)
  }
  it('kills bypassing the shared host mail budget with a real assertion', async () => {
    await verifyBudget(sourceCopy().deliverGroupHostMail)
    await expect(
      verifyBudget(sourceCopy(['if (reason) {', 'if (false) {']).deliverGroupHostMail),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  async function verifyUid(deliver: typeof deliverGroupHostMail) {
    const f = await fixture()
    await enqueueGroupHostMail(db, must(f.bookings[0]), f.now)
    await deliver(f.deps, must((await rows(f.slot)).find((r) => r.kind === 'calendar')).id)
    expect(f.sent[0]?.attachments?.[0]?.content).toContain(`UID:group-${f.slot}@hourmere`)
  }
  it('kills replacing the shared calendar UID with a real assertion', async () => {
    await verifyUid(sourceCopy().deliverGroupHostMail)
    await expect(
      verifyUid(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-copy mutation
        sourceCopy(['uid: `group-${row.id}@hourmere`', 'uid: `seat-${row.id}@hourmere`'])
          .deliverGroupHostMail,
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('rechecks retired slot after waiting for the mail budget', async () => {
    const f = await fixture()
    await enqueueGroupHostMail(db, must(f.bookings[0]), f.now)
    f.deps.now = () => f.now.add({ hours: 24 })
    const reminder = must((await rows(f.slot)).find((r) => r.kind === 'reminder'))
    const copy = sourceCopy(undefined, {
      lockNotificationEmailBudget: async () => {
        await db
          .updateTable('bookings')
          .set({ status: 'cancelled', cancelled_at: new Date(f.now.epochMilliseconds) })
          .where('group_slot_id', '=', f.slot)
          .execute()
      },
    })
    await copy.deliverGroupHostMail(f.deps, reminder.id)
    expect(f.sent).toHaveLength(0)
    expect((await rows(f.slot)).find((r) => r.kind === 'reminder')?.state).toBe('skipped')
  })
  it('has a finite thirteen-attempt delivery budget', async () => {
    const f = await fixture()
    await enqueueGroupHostMail(db, must(f.bookings[0]), f.now)
    const calendar = must((await rows(f.slot)).find((r) => r.kind === 'calendar'))
    f.deps.mailer.send = async () => {
      throw new Error('synthetic failure')
    }
    for (let attempt = 0; attempt < 13; attempt++) {
      await sql`UPDATE group_slot_host_messages SET next_attempt_at=${new Date(f.now.epochMilliseconds)} WHERE id=${calendar.id}`.execute(
        db,
      )
      await deliverGroupHostMail(f.deps, calendar.id)
    }
    expect((await rows(f.slot)).find((r) => r.kind === 'calendar')).toMatchObject({
      attempts: 13,
      state: 'failed',
    })
  })
  async function verifyLogistics(deliver: typeof deliverGroupHostMail) {
    const f = await fixture({ location: { kind: 'google_meet', autoCreate: true } })
    await enqueueGroupHostMail(db, must(f.bookings[0]), f.now)
    f.deps.now = () => f.now.add({ hours: 24 })
    const reminder = must((await rows(f.slot)).find((r) => r.kind === 'reminder'))
    await deliver(f.deps, reminder.id)
    expect(f.sent).toHaveLength(0)
    expect((await rows(f.slot)).find((r) => r.kind === 'reminder')?.state).toBe('pending')
    const hostEmail = (
      await db
        .selectFrom('auth.user')
        .select('email')
        .where('id', '=', f.f.host)
        .executeTakeFirstOrThrow()
    ).email
    await sql`INSERT INTO group_slot_conferences(group_slot_id,organization_id,organizer_user_id,provider,invitation_organizer_name,invitation_organizer_email,state,revision,applied_revision,join_url)
      VALUES (${f.slot},${f.f.organization},${f.f.host},'google_meet','Host',${hostEmail},'ready',1,1,'https://meet.google.com/abc-defg-hij')`.execute(
      db,
    )
    await sql`UPDATE group_slot_host_messages SET next_attempt_at=${new Date(must(f.deps.now)().epochMilliseconds)} WHERE id=${reminder.id}`.execute(
      db,
    )
    await db
      .updateTable('auth.user')
      .set({ email: 'changed-host@example.test' })
      .where('id', '=', f.f.host)
      .execute()
    await deliver(f.deps, reminder.id)
    expect(f.sent).toHaveLength(0)
    await db.updateTable('auth.user').set({ email: hostEmail }).where('id', '=', f.f.host).execute()
    await sql`UPDATE group_slot_host_messages SET next_attempt_at=${new Date(must(f.deps.now)().epochMilliseconds)} WHERE id=${reminder.id}`.execute(
      db,
    )
    await deliver(f.deps, reminder.id)
    await deliver(f.deps, reminder.id)
    expect(f.sent).toHaveLength(1)
  }
  it('waits for current conference logistics and sends one ready reminder', () =>
    verifyLogistics(deliverGroupHostMail))
  it('kills ignoring pinned organizer identity with a real assertion', async () => {
    await expect(
      verifyLogistics(
        sourceCopy(['AND c.invitation_organizer_email=u.email', '']).deliverGroupHostMail,
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('keeps the configured provider target as the only host calendar copy', async () => {
    const f = await fixture({ destination_calendar_id: randomUUID() })
    await enqueueGroupHostMail(db, must(f.bookings[0]), f.now)
    const calendar = must((await rows(f.slot)).find((r) => r.kind === 'calendar'))
    await deliverGroupHostMail(f.deps, calendar.id)
    expect(f.sent).toHaveLength(0)
    expect((await rows(f.slot)).find((r) => r.kind === 'calendar')?.state).toBe('skipped')
  })
  it('uses full-width Chinese punctuation for host mail', async () => {
    const f = await fixture()
    await db
      .insertInto('profiles')
      .values({
        user_id: f.f.host,
        handle: `group-${randomUUID().slice(0, 8)}`,
        locale: 'zh-CN',
        time_zone: 'Asia/Shanghai',
      })
      .execute()
    await enqueueGroupHostMail(db, must(f.bookings[0]), f.now)
    await deliverGroupHostMail(
      f.deps,
      must((await rows(f.slot)).find((r) => r.kind === 'calendar')).id,
    )
    expect(f.sent[0]?.subject).toBe('团体活动更新：Group class')
    expect(f.sent[0]?.text).toContain('已预订席位：2。')
  })
  async function verifyLease(change?: [string, string]) {
    const f = await fixture()
    await enqueueGroupHostMail(db, must(f.bookings[0]), f.now)
    const calendar = must((await rows(f.slot)).find((r) => r.kind === 'calendar'))
    const copy = sourceCopy(change, {
      lockNotificationEmailBudget: async () => {
        await sql`UPDATE group_slot_host_messages SET lease_until=clock_timestamp()+interval '500 milliseconds' WHERE id=${calendar.id}`.execute(
          db,
        )
      },
    })
    await copy.deliverGroupHostMail(f.deps, calendar.id)
    expect(f.sent).toHaveLength(0)
    expect((await rows(f.slot)).find((r) => r.kind === 'calendar')?.state).toBe('pending')
  }
  it('refuses SMTP when a budget wait leaves less than the claim safety margin', () =>
    verifyLease())
  it('kills ignoring the remaining claim time with a real assertion', async () => {
    await expect(
      verifyLease(['row.lease_until.getTime() - row.wall_now.getTime() - 1_000', '60_000']),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
