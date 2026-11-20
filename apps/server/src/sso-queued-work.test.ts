import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parse } from '@babel/parser'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  deliverMeetingPollEmail,
  type InvitationEmailRequest,
  invitationEmailJob,
} from '@hourmere/notifications'
import { createFixtures, testContext, weekdays } from '@hourmere/scheduling/testing'
import {
  createSlackDestination,
  testSlackDestination,
  type WebhookQueue,
  webhookDeliveryJob,
} from '@hourmere/webhooks'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type IdentityFixture,
  identityFixture,
  link,
  proofValues,
} from '../../../packages/db/src/sso-identity-fixtures.ts'
import { insert } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { inviteMeetingPollVoters } from '../../../packages/scheduling/src/meeting-poll-voters.ts'
import { createMeetingPoll } from '../../../packages/scheduling/src/meeting-polls.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 8).toString('base64') }
const capabilities = { ssoOidcEnabled: true, ssoSamlEnabled: false }
const run = { id: randomUUID(), signal: new AbortController().signal, attempt: 1 }

describe.skipIf(!serverUrl)('SSO proof on queued team actions', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'sso_queued_work' })
    db = createDb(owned.pool)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function seededTeam() {
    const client = await owned.pool.connect()
    let fixture: IdentityFixture
    try {
      fixture = await identityFixture(client)
      const ownerLink = await link(fixture, fixture.owner)
      await insert(client, 'sso_browser_proofs', {
        ...proofValues(fixture, ownerLink),
        member_id: fixture.ownerMember,
      })
    } finally {
      client.release()
    }
    const user = await db
      .selectFrom('auth.user')
      .select(['id', 'name', 'email'])
      .where('id', '=', fixture.owner)
      .executeTakeFirstOrThrow()
    const organization = await db
      .selectFrom('auth.organization')
      .select(['id', 'name', 'slug'])
      .where('id', '=', fixture.team)
      .executeTakeFirstOrThrow()
    const actor = { userId: user.id, sessionId: fixture.sessions[user.id] as string }
    const principal: Principal = {
      kind: 'session',
      sessionId: actor.sessionId,
      user,
      organization: { ...organization, personal: false },
    }
    return { actor, ctx: testContext(db, principal), organizationId: organization.id }
  }

  const enforce = (organizationId: string) =>
    db
      .insertInto('sso_policies')
      .values({ organization_id: organizationId, require_sso: true })
      .execute()

  const revoke = (sessionId: string) =>
    db.deleteFrom('auth.session').where('id', '=', sessionId).execute()

  it('rechecks the exact Slack sample session on each webhook delivery attempt', async () => {
    const team = await seededTeam()
    const transport = vi.fn(async () => 204)
    const job = webhookDeliveryJob({ db, ...settings, transport, ssoCapabilities: capabilities })
    const hardOff = webhookDeliveryJob({ db, ...settings, transport })
    const destination = await createSlackDestination(team.ctx, settings, {
      url: 'https://hooks.slack.com/services/TTEST/BTEST/synthetic',
      events: ['booking.created'],
    })
    const captured: Parameters<WebhookQueue['enqueue']>[1][] = []
    const queue: WebhookQueue = {
      async enqueue(_name, payload) {
        captured.push(payload)
        return randomUUID()
      },
    }
    const sample = async (protectedTeam: boolean) => {
      const { deliveryId } = await testSlackDestination(
        team.ctx,
        { ...settings, ssoCapabilities: capabilities },
        destination.id,
        queue,
      )
      const payload = job.payload.parse(captured.pop())
      expect(payload).toEqual({ deliveryId, ...(protectedTeam && { actor: team.actor }) })
      return payload
    }
    const first = await sample(false)
    await hardOff.handler(first, run)
    await enforce(team.organizationId)
    // Trusted calls also go through the transaction proof check before a delivery exists.
    await expect(
      testSlackDestination(team.ctx, settings, destination.id, queue),
    ).rejects.toMatchObject({ code: 'sso_required' })
    expect(captured).toEqual([])
    const stored = await sample(true)
    await hardOff.handler(stored, run)
    const legacy = await sample(true)
    await job.handler({ deliveryId: legacy.deliveryId }, run)
    const live = await sample(true)
    await job.handler(live, run)
    const revoked = await sample(true)
    await revoke(team.actor.sessionId)
    await job.handler(revoked, run)
    const rows = await db
      .selectFrom('webhook_deliveries')
      .select(['status', 'attempts', 'last_error'])
      .where('webhook_id', '=', destination.id)
      .orderBy('id')
      .execute()
    const delivered = { status: 'delivered', attempts: 1, last_error: null }
    const skipped = { status: 'skipped', attempts: 0, last_error: 'disabled' }
    expect(transport).toHaveBeenCalledTimes(2)
    expect(rows).toEqual([delivered, skipped, skipped, delivered, skipped])
  })

  it('requires the authorizing invitation session immediately before an SMTP attempt', async () => {
    const team = await seededTeam()
    const send = vi.fn(async () => {})
    const job = invitationEmailJob({
      db,
      ssoCapabilities: capabilities,
      smtpConfigured: true,
      secret: 'synthetic-invitation-queue-test-secret',
      publicUrl,
      mailer: { send },
      log: () => {},
    })
    if (!job.handler) throw new Error('Missing invitation email handler')
    const queue = async (actor?: InvitationEmailRequest['actor']) => {
      const invitation = await db
        .insertInto('auth.invitation')
        .values({
          organizationId: team.organizationId,
          inviterId: team.actor.userId,
          role: 'member',
          email: `${randomUUID()}@example.test`,
          status: 'pending',
          expiresAt: sql`clock_timestamp() + interval '1 hour'`,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await db
        .insertInto('invitation_deliveries')
        .values({
          invitation_id: invitation.id,
          state: 'queued',
          authorized_by_user_id: team.actor.userId,
        })
        .execute()
      return job.payload.parse({ invitationId: invitation.id, generation: 1, actor })
    }
    const allowed = await queue()
    await job.handler(allowed, run)
    const legacy = await queue()
    await enforce(team.organizationId)
    await job.handler(legacy, run)
    const live = await queue(team.actor)
    await job.handler(live, run)
    const revoked = await queue(team.actor)
    await revoke(team.actor.sessionId)
    await job.handler(revoked, run)
    const payloads = [allowed, legacy, live, revoked]
    const rows = await Promise.all(
      payloads.map(({ invitationId }) =>
        db
          .selectFrom('invitation_deliveries')
          .select(['state', 'attempts'])
          .where('invitation_id', '=', invitationId)
          .executeTakeFirstOrThrow(),
      ),
    )
    const delivered = { state: 'smtp_accepted', attempts: 1 }
    const skipped = { state: 'skipped', attempts: 0 }
    expect(send).toHaveBeenCalledTimes(2)
    expect(rows).toEqual([delivered, skipped, delivered, skipped])
  })

  it('binds host poll invitation mail to the sealed outbox session through delivery', async () => {
    const team = await seededTeam()
    const fixtures = createFixtures(db)
    const hours = [{ start: '00:00', end: '24:00' }]
    await fixtures.schedule(team.actor.userId, {
      timeZone: 'UTC',
      weeklyHours: { ...weekdays(...hours), saturday: hours, sunday: hours },
    })
    const eventTypeId = await fixtures.eventType(team.organizationId, null, {
      hosts: [{ userId: team.actor.userId }],
    })
    const secret = 'synthetic-poll-queue-test-secret-at-least-32-bytes'
    const ctx = { ...team.ctx, meetingPollSecret: secret }
    const deadline = Temporal.Now.instant()
      .add({ hours: 24 })
      .round({ smallestUnit: 'hour', roundingMode: 'ceil' })
    const { poll } = await createMeetingPoll(ctx, {
      eventTypeId,
      admissionMode: 'public_link',
      displayTimeZone: 'UTC',
      deadlineAt: deadline.toString(),
      candidateStarts: [
        deadline.add({ hours: 25 }).toString(),
        deadline.add({ hours: 26 }).toString(),
      ],
      idempotencyKey: randomUUID(),
    })
    await inviteMeetingPollVoters(ctx, {
      id: poll.id,
      invitees: [
        { name: 'One', email: 'first@example.test' },
        { name: 'Two', email: 'second@example.test' },
      ],
      idempotencyKey: randomUUID(),
    })
    await enforce(team.organizationId)
    const delivery = (email: string) =>
      db
        .selectFrom('meeting_poll_deliveries as mail')
        .innerJoin('meeting_poll_voters as voter', 'voter.id', 'mail.voter_id')
        .select([
          'mail.id',
          'mail.state',
          'mail.attempts',
          'mail.error_class',
          'mail.capability_ciphertext',
        ])
        .where('mail.poll_id', '=', poll.id)
        .where('voter.email', '=', email)
        .executeTakeFirstOrThrow()
    const send = vi.fn(async () => {})
    const deps = {
      db,
      ssoCapabilities: capabilities,
      smtpConfigured: true,
      secret,
      meetingPollSecret: secret,
      publicUrl,
      mailer: { send },
    }
    await deliverMeetingPollEmail(deps, await delivery('first@example.test'))
    await revoke(team.actor.sessionId)
    await deliverMeetingPollEmail(deps, await delivery('second@example.test'))
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ to: 'first@example.test' }),
      expect.anything(),
    )
    expect(await delivery('first@example.test')).toMatchObject({
      state: 'sent',
      attempts: 1,
      capability_ciphertext: null,
    })
    expect(await delivery('second@example.test')).toMatchObject({
      state: 'skipped',
      attempts: 0,
      error_class: 'sso_required',
      capability_ciphertext: null,
    })
  })
})

it('classifies every production worker by its source of authority', () => {
  const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
  const tree = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  const start = tree.program.body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id?.name === 'start',
  )
  if (start?.type !== 'FunctionDeclaration')
    throw new Error('Missing production server composition')
  const jobs = start.body.body
    .flatMap((node) => (node.type === 'VariableDeclaration' ? node.declarations : []))
    .find((node) => node.id.type === 'Identifier' && node.id.name === 'jobs')?.init
  const options = jobs?.type === 'CallExpression' ? jobs.arguments[0] : undefined
  const definitions =
    options?.type === 'ObjectExpression'
      ? options.properties.find(
          (node) =>
            node.type === 'ObjectProperty' &&
            node.key.type === 'Identifier' &&
            node.key.name === 'definitions',
        )
      : undefined
  if (definitions?.type !== 'ObjectProperty') throw new Error('Missing production job definitions')
  function workerNames(node: unknown): string[] {
    const value = node as {
      type: string
      elements?: unknown[]
      argument?: unknown
      consequent?: unknown
      alternate?: unknown
      callee?: { type: string; name?: string }
    }
    if (value.type === 'ArrayExpression') return (value.elements ?? []).flatMap(workerNames)
    if (value.type === 'SpreadElement') return workerNames(value.argument)
    if (value.type === 'ConditionalExpression')
      return [...workerNames(value.consequent), ...workerNames(value.alternate)]
    if (value.type === 'CallExpression' && value.callee?.type === 'Identifier' && value.callee.name)
      return [value.callee.name]
    throw new Error(`Unclassified production job definition syntax: ${value.type}`)
  }

  const authenticated = ['invitationEmailJob', 'meetingPollEmailJob', 'webhookDeliveryJob']
  const lifecycle = [
    'bookingCalendarJob',
    'bookingCalendarRecoveryJob',
    'bookingConferenceJob',
    'bookingNotificationJob',
    'calDavBookingJob',
    'calDavRecoveryJob',
    'conferenceDispatchJob',
    'conferenceMirrorDispatchJob',
    'conferenceNotificationDispatchJob',
    'configuredSmsJobs',
    'groupHostMailJob',
    'rescheduleRequestExpiryJob',
    'scheduledBookingEmailJob',
    'scheduledBookingEmailRepairJob',
    'seriesNotificationDispatchJob',
    'waitlistEmailJob',
    'waitlistMaintenanceJobs',
  ]
  const system = [
    'auditLogRetentionJob',
    'calDavDispatchJob',
    'calDavSyncJob',
    'calendarDispatchJob',
    'calendarSyncJob',
    'invitationEmailRepairJob',
    'mailboxProofJobs',
    'mcpOAuthCleanupJob',
    'meetingPollCapabilityExpiryJob',
    'meetingPollCleanupJob',
    'notificationEmailCleanupJob',
    'oneTimeBookingLinksRetentionJob',
    'paymentHoldsExpiryJob',
    'routingRetentionJob',
    'signInEmailJobs',
    'ssoDomainRecheckJob',
    'ssoLinkRemovalEmailJob',
    'webhookCleanupJob',
  ]
  expect(workerNames(definitions.value).sort()).toEqual(
    [...authenticated, ...lifecycle, ...system].sort(),
  )
})
