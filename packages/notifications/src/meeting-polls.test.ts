import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { type MailMessage, MailRejectedError } from '@hourmere/mail'
import { createFixtures, createTestUser, testContext, weekdays } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as ballots from '../../scheduling/src/meeting-poll-ballots.ts'
import * as results from '../../scheduling/src/meeting-poll-results.ts'
import * as voters from '../../scheduling/src/meeting-poll-voters.ts'
import * as polls from '../../scheduling/src/meeting-polls.ts'
import * as Delivery from './meeting-polls.ts'

const scheduling = { ...voters, ...polls, ...ballots, ...results }
const serverUrl = process.env.DATABASE_URL
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture row missing')
  return value
}
const SECRET = 'meeting-poll-mail-test-secret-0123456789'

async function sourceCopy(...replacements: [string, string][]): Promise<typeof Delivery> {
  const location = new URL('./meeting-polls.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  for (const [from, to] of replacements) {
    expect(source.includes(from), `mutation must match source: ${from}`).toBe(true)
    source = source.replaceAll(from, to)
  }
  source = source.replaceAll(
    "import('@hourmere/scheduling/meeting-poll-delivery')",
    `import('${pathToFileURL(createRequire(location).resolve('@hourmere/scheduling/meeting-poll-delivery')).href}')`,
  )
  const module = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('node:') ? specifier : specifier.startsWith('.') ? new URL(specifier, location).href : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(module).toString('base64')}`)
}

describe.skipIf(!serverUrl)('meeting poll durable credential mail', () => {
  let owned: TestDatabase
  let db: Db
  let fixtures: ReturnType<typeof createFixtures>
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_mail' })
    db = createDb(owned.pool)
    fixtures = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup() {
    const owner = await createTestUser(db)
    await db
      .insertInto('profiles')
      .values({ user_id: owner.id, handle: `poll-${randomUUID().slice(0, 8)}`, time_zone: 'UTC' })
      .execute()
    const principal = {
      kind: 'session' as const,
      sessionId: randomUUID(),
      user: owner.principal.user,
      organization: owner.principal.organization,
    }
    const ctx = { ...testContext(db, principal), meetingPollSecret: SECRET }
    await fixtures.schedule(owner.id, {
      timeZone: 'UTC',
      weeklyHours: {
        ...weekdays({ start: '00:00', end: '24:00' }),
        saturday: [{ start: '00:00', end: '24:00' }],
        sunday: [{ start: '00:00', end: '24:00' }],
      },
    })
    const eventTypeId = await fixtures.eventType(principal.organization.id, owner.id)
    const now = Temporal.Now.instant().round({ smallestUnit: 'millisecond', roundingMode: 'floor' })
    const deadline = now.round({ smallestUnit: 'hour', roundingMode: 'ceil' }).add({ hours: 24 })
    const created = await scheduling.createMeetingPoll(ctx, {
      eventTypeId,
      candidateStarts: [
        deadline.add({ hours: 25 }).toString(),
        deadline.add({ hours: 26 }).toString(),
      ],
      deadlineAt: deadline.toString(),
      displayTimeZone: 'UTC',
      admissionMode: 'public_link',
      idempotencyKey: randomUUID(),
    })
    const pollId = created.poll.id
    const messages: MailMessage[] = []
    const logs: string[] = []
    let current = now.add({ seconds: 1 })
    const deps: Delivery.MeetingPollEmailDeps = {
      db,
      meetingPollSecret: SECRET,
      secret: SECRET,
      publicUrl: 'https://poll.example.test',
      smtpConfigured: true,
      now: () => current,
      mailMaxPerHour: 0,
      mailRecipientMaxPerHour: 1000,
      mailRecipientMaxPerDay: 1000,
      mailer: {
        send: async (message) => {
          messages.push(message)
        },
      },
      log: (line) => logs.push(line),
    }
    const pub = { db, meetingPollSecret: SECRET, trustedIp: '192.0.2.10' }
    const voter = (email: string) =>
      db
        .selectFrom('meeting_poll_voters')
        .selectAll()
        .where('poll_id', '=', pollId)
        .where('email', '=', email)
        .executeTakeFirstOrThrow()
    const rows = () =>
      db
        .selectFrom('meeting_poll_deliveries')
        .selectAll()
        .where('poll_id', '=', pollId)
        .orderBy('generation')
        .orderBy('sequence')
        .execute()
    const credential = async (email: string) => {
      const v = await voter(email)
      const cap = await db
        .selectFrom('meeting_poll_capabilities')
        .selectAll()
        .where('voter_id', '=', v.id)
        .where('purpose', '!=', 'reminder_opt_out')
        .where('revoked_at', 'is', null)
        .where('consumed_at', 'is', null)
        .orderBy('generation', 'desc')
        .executeTakeFirstOrThrow()
      const opened = scheduling.openMeetingPollCredential(
        SECRET,
        {
          organizationId: principal.organization.id,
          pollId,
          voterId: v.id,
          generation: cap.generation,
        },
        cap.capability_ciphertext,
      )
      if (!opened) throw new Error('fixture credential missing')
      return { ...opened, cap, voter: v }
    }
    const enroll = (email = `${randomUUID()}@example.test`) =>
      scheduling
        .enrollMeetingPollVoter(pub, {
          publicToken: created.publicToken as string,
          name: 'Voter',
          email,
          timeZone: 'UTC',
        })
        .then(() => credential(email))
    const invite = (email = `${randomUUID()}@example.test`) =>
      scheduling
        .inviteMeetingPollVoters(ctx, {
          id: pollId,
          invitees: [{ name: 'Voter', email }],
          idempotencyKey: randomUUID(),
        })
        .then(() => credential(email))
    const recover = (email: string) => scheduling.recoverMeetingPollVoter(pub, { pollId, email })
    return {
      deps,
      advance: (milliseconds: number) => {
        current = current.add({ milliseconds })
      },
      ctx,
      pub,
      pollId,
      deadline,
      now,
      messages,
      logs,
      rows,
      credential,
      voter,
      enroll,
      invite,
      recover,
    }
  }

  const send = Delivery.deliverMeetingPollEmail

  it('delivers identical verification content to known and unknown accounts without exposing credentials in storage', async () => {
    const s = await setup()
    const known = await createTestUser(db)
    const a = await s.enroll(known.email)
    const b = await s.enroll()
    // Equalize timestamps so a minute boundary cannot affect the account-enumeration assertion.
    await db
      .updateTable('meeting_poll_capabilities')
      .set({ expires_at: a.cap.expires_at })
      .where('id', '=', b.cap.id)
      .execute()
    for (const row of await s.rows()) await send(s.deps, row)
    expect(s.messages).toHaveLength(2)
    const normalized = s.messages.map((message) => ({
      ...message,
      to: '',
      text: message.text.replaceAll(a.token, 'TOKEN').replaceAll(b.token, 'TOKEN'),
      html: message.html?.replaceAll(a.token, 'TOKEN').replaceAll(b.token, 'TOKEN'),
    }))
    expect(normalized[0]).toEqual(normalized[1])
    for (const credential of [a, b]) {
      expect(
        credential.cap.token_digest.equals(
          scheduling.meetingPollCapabilityDigest(credential.purpose, credential.token),
        ),
      ).toBe(true)
      expect(credential.cap.capability_ciphertext?.includes(Buffer.from(credential.token))).toBe(
        false,
      )
      expect(
        s.messages.some((message) => message.text.includes(`/poll/voter#${credential.token}`)),
      ).toBe(true)
    }
    expect(
      (await s.rows()).every((row) => row.state === 'sent' && row.capability_ciphertext === null),
    ).toBe(true)
    expect(s.messages.every((message) => message.sensitive && !message.attachments?.length)).toBe(
      true,
    )
  })

  it('recovers the same credential once under concurrent requests and preserves single-use verification', async () => {
    const s = await setup()
    const a = await s.enroll()
    await Promise.all(Array.from({ length: 6 }, () => s.recover(a.voter.email)))
    const rows = await s.rows()
    expect(rows).toHaveLength(2)
    for (const row of rows) await send(s.deps, row)
    expect(s.messages).toHaveLength(2)
    expect(s.messages.every((message) => message.text.includes(a.token))).toBe(true)
    await scheduling.verifyMeetingPollVoter(s.pub, { token: a.token })
    const before = await s.rows()
    await scheduling.verifyMeetingPollVoter(s.pub, { token: a.token })
    expect(await s.rows()).toHaveLength(before.length)
    expect(
      (
        await db
          .selectFrom('meeting_poll_capabilities')
          .select('consumed_at')
          .where('id', '=', a.cap.id)
          .executeTakeFirstOrThrow()
      ).consumed_at,
    ).not.toBeNull()
    const current = await s.credential(a.voter.email)
    expect(current.purpose).toBe('voting')
    expect(current.token === a.token).toBe(false)
    await send(s.deps, required(before.find((row) => row.generation === current.cap.generation)))
    expect(s.messages.at(-1)?.text.includes(current.token)).toBe(true)
  })

  it('retains invited voting credentials beyond one hour and recovers them unchanged', async () => {
    const s = await setup()
    const a = await s.invite()
    s.advance(2 * 3_600_000)
    await s.recover(a.voter.email)
    for (const row of await s.rows()) await send(s.deps, row)
    expect(s.messages).toHaveLength(2)
    expect(s.messages.every((message) => message.text.includes(a.token))).toBe(true)
    expect(a.voter.pending_expires_at).toBeNull()
    expect(a.cap.expires_at.getTime()).toBe(s.deadline.epochMilliseconds)
  })

  async function expiredScenario(sender: typeof send) {
    const s = await setup()
    await s.enroll()
    s.advance(3_600_001)
    await sender(s.deps, required((await s.rows())[0]))
    expect(s.messages).toHaveLength(0)
    expect((await s.rows())[0]).toMatchObject({ state: 'skipped', capability_ciphertext: null })
  }
  it('does not deliver public pending credentials after their original expiry', () =>
    expiredScenario(send))

  it('does not send invitations or recovery at the poll deadline', async () => {
    const s = await setup()
    const a = await s.invite()
    await s.recover(a.voter.email)
    s.advance(s.deadline.epochMilliseconds - s.now.epochMilliseconds)
    for (const row of await s.rows()) await send(s.deps, row)
    expect(s.messages).toHaveLength(0)
    expect(
      (await s.rows()).every(
        (row) => row.state === 'skipped' && row.capability_ciphertext === null,
      ),
    ).toBe(true)
  })

  it('rotates host resend generation atomically and suppresses old queued mail', async () => {
    const s = await setup()
    const a = await s.invite()
    const poll = await db
      .selectFrom('meeting_polls')
      .select('host_revision')
      .where('id', '=', s.pollId)
      .executeTakeFirstOrThrow()
    const input = {
      id: s.pollId,
      voterId: a.voter.id,
      expectedHostRevision: poll.host_revision,
      idempotencyKey: randomUUID(),
    }
    await scheduling.resendMeetingPollInvitation(s.ctx, input)
    await scheduling.resendMeetingPollInvitation(s.ctx, input)
    const current = await s.credential(a.voter.email)
    expect(current.token === a.token).toBe(false)
    expect(current.cap.generation).toBe(a.cap.generation + 1)
    expect(await s.rows()).toHaveLength(2)
    for (const row of await s.rows()) await send(s.deps, row)
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]?.text.includes(current.token)).toBe(true)
    expect(s.messages[0]?.text.includes(a.token)).toBe(false)
  })

  async function budgetScenario(sender: typeof send) {
    const s = await setup()
    const a = await s.invite()
    await s.recover(a.voter.email)
    s.deps.mailRecipientMaxPerHour = 1
    await Promise.all((await s.rows()).map((row) => sender(s.deps, row)))
    expect(s.messages).toHaveLength(1)
    expect((await s.rows()).map((row) => row.state).sort()).toEqual(['sent', 'suppressed'])
    s.advance(3_600_001)
    for (const row of await s.rows()) await sender(s.deps, row)
    expect(s.messages).toHaveLength(1)
  }
  it('enforces the shared recipient budget across concurrent deliveries and keeps suppression terminal', () =>
    budgetScenario(send))
  it('detects removal of the recipient budget in a source copy', async () => {
    const mutant = await sourceCopy([
      "if (suppressed) return finish(db, row, ready, 'suppressed', suppressed)",
      '',
    ])
    await expect(budgetScenario(mutant.deliverMeetingPollEmail)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('suppresses initial invitations after early close but permits lost-mail recovery', async () => {
    const s = await setup()
    const a = await s.invite()
    const poll = await db
      .selectFrom('meeting_polls')
      .select('host_revision')
      .where('id', '=', s.pollId)
      .executeTakeFirstOrThrow()
    await scheduling.closeMeetingPoll(s.ctx, {
      id: s.pollId,
      expectedHostRevision: poll.host_revision,
    })
    await s.recover(a.voter.email)
    for (const row of await s.rows()) await send(s.deps, row)
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]?.text.includes(a.token)).toBe(true)
    expect((await s.rows()).find((row) => row.kind === 'invitation')?.state).toBe('skipped')
    expect((await s.rows()).find((row) => row.kind === 'recovery')?.state).toBe('sent')
  })

  it('reserves the final shared instance slot under concurrent recipients', async () => {
    const s = await setup()
    await s.invite()
    await s.invite()
    const before = await db
      .selectFrom('notification_email_sends')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow()
    s.deps.mailMaxPerHour = Number(before.count) + 1
    await Promise.all((await s.rows()).map((row) => send(s.deps, row)))
    expect(s.messages).toHaveLength(1)
    expect((await s.rows()).map((row) => row.state).sort()).toEqual(['sent', 'suppressed'])
  })

  it('releases poll locks before SMTP and permanently skips rejected mail', async () => {
    const s = await setup()
    await s.invite()
    let acquired = false
    s.deps.mailer = {
      send: async () => {
        await db.transaction().execute(async (trx) => {
          await trx
            .selectFrom('meeting_polls')
            .select('id')
            .where('id', '=', s.pollId)
            .forUpdate()
            .noWait()
            .executeTakeFirstOrThrow()
          acquired = true
        })
        throw new MailRejectedError({ responseCode: 550, enhancedCode: '5.1.1', atRecipient: true })
      },
    }
    await send(s.deps, required((await s.rows())[0]))
    expect(acquired).toBe(true)
    expect((await s.rows())[0]).toMatchObject({
      state: 'skipped',
      attempts: 1,
      error_class: 'smtp_permanent',
      capability_ciphertext: null,
    })
  })

  it('deduplicates concurrent claims and sent receipts', async () => {
    const s = await setup()
    await s.invite()
    const row = required((await s.rows())[0])
    await Promise.all(Array.from({ length: 5 }, () => send(s.deps, row)))
    await send(s.deps, row)
    expect(s.messages).toHaveLength(1)
    expect((await s.rows())[0]).toMatchObject({
      state: 'sent',
      attempts: 1,
      lease_id: null,
      capability_ciphertext: null,
    })
  })

  it('honors live leases, reclaims expired leases without resetting attempts, and retires the fifth crash', async () => {
    const s = await setup()
    await s.invite()
    const row = required((await s.rows())[0])
    await db
      .updateTable('meeting_poll_deliveries')
      .set({
        state: 'processing',
        attempts: 4,
        lease_id: randomUUID(),
        lease_until: new Date(s.now.epochMilliseconds + 300_000),
      })
      .where('id', '=', row.id)
      .execute()
    await send(s.deps, row)
    expect(s.messages).toHaveLength(0)
    s.advance(300_001)
    await send(s.deps, row)
    expect(s.messages).toHaveLength(1)
    expect((await s.rows())[0]).toMatchObject({ state: 'sent', attempts: 5 })
    await db
      .updateTable('meeting_poll_deliveries')
      .set({
        state: 'processing',
        terminal_at: null,
        attempts: 5,
        lease_id: randomUUID(),
        lease_until: new Date(s.now.epochMilliseconds),
      })
      .where('id', '=', row.id)
      .execute()
    await send(s.deps, row)
    expect(s.messages).toHaveLength(1)
    expect((await s.rows())[0]).toMatchObject({
      state: 'skipped',
      attempts: 5,
      capability_ciphertext: null,
      error_class: 'attempts_exhausted',
    })
  })

  it('bounds SMTP retries to five and persists safe errors only', async () => {
    const s = await setup()
    const a = await s.invite()
    const row = required((await s.rows())[0])
    let attempts = 0
    s.deps.mailer = {
      send: async () => {
        attempts++
        throw new Error(`${a.token} ${a.voter.email}`)
      },
    }
    for (let attempt = 1; attempt <= 5; attempt++) {
      await send(s.deps, row)
      expect(attempts).toBe(attempt)
      await send(s.deps, row)
      expect(attempts).toBe(attempt)
      s.advance(60_000 * 2 ** (attempt - 1))
    }
    expect((await s.rows())[0]).toMatchObject({
      state: 'skipped',
      attempts: 5,
      capability_ciphertext: null,
      error_class: 'attempts_exhausted',
    })
    expect(s.logs.join(' ').includes(a.token)).toBe(false)
  })

  async function keyScenario(sender: typeof send) {
    const s = await setup()
    await s.invite()
    const before = await s.rows()
    await expect(
      sender(
        { ...s.deps, meetingPollSecret: 'another-meeting-poll-secret-0123456789' },
        required(before[0]),
      ),
    ).rejects.toThrow('meeting_poll_email_delivery_unavailable')
    expect(await s.rows()).toEqual(before)
    expect(s.messages).toHaveLength(0)
  }
  it('refuses a mismatched key before changing the outbox', () => keyScenario(send))
  it('detects removal of the key fence in source copies', async () => {
    const mutant = await sourceCopy(['await ensureMeetingPollKey(db, deps.meetingPollSecret)', ''])
    await expect(keyScenario(mutant.deliverMeetingPollEmail)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('suppresses withdrawn recipients and safely ignores cascaded deleted voters', async () => {
    const s = await setup()
    const a = await s.invite()
    const b = await s.invite()
    const rows = await s.rows()
    await scheduling.withdrawMeetingPollVoter(s.pub, {
      token: a.token,
      expectedBallotRevision: a.voter.ballot_revision,
    })
    const poll = await db
      .selectFrom('meeting_polls')
      .select('host_revision')
      .where('id', '=', s.pollId)
      .executeTakeFirstOrThrow()
    await scheduling.removeMeetingPollVoter(s.ctx, {
      id: s.pollId,
      voterId: b.voter.id,
      expectedHostRevision: poll.host_revision,
    })
    for (const row of rows) await send(s.deps, row)
    expect(s.messages).toHaveLength(0)
    expect((await s.rows()).every((row) => row.capability_ciphertext === null)).toBe(true)
  })

  it('records the unavoidable SMTP-accepted/receipt-failed duplicate window', async () => {
    const s = await setup()
    await s.invite()
    const row = required((await s.rows())[0])
    const interrupted = await sourceCopy([
      "if (!failure) return finish(db, work.row, at, 'sent', null)",
      "if (!failure) throw new Error('simulated_receipt_failure')",
    ])
    await expect(interrupted.deliverMeetingPollEmail(s.deps, row)).rejects.toThrow(
      'meeting_poll_email_delivery_unavailable',
    )
    expect(s.messages).toHaveLength(1)
    await send(s.deps, row)
    expect(s.messages).toHaveLength(1)
    s.advance(300_001)
    await send(s.deps, row)
    expect(s.messages).toHaveLength(2)
    expect(JSON.stringify(s.messages[0]) === JSON.stringify(s.messages[1])).toBe(true)
    expect((await s.rows())[0]).toMatchObject({
      state: 'sent',
      attempts: 2,
      capability_ciphertext: null,
    })
  })
})
