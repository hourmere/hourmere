import { randomBytes, randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listPublicTeamSlots } from './availability.ts'
import type { ServiceContext } from './context.ts'
import { activateRoundRobin, createEventType } from './event-types.ts'
import {
  listRoutingContinuationSlots,
  type RoutingContinuationContext,
  resolveRoutingContinuation,
} from './routing-continuation.ts'
import type { RoutingQuestion, RoutingTarget } from './routing-form-config.ts'
import {
  archiveRoutingForm,
  createRoutingForm,
  publishRoutingForm,
  submitRoutingForm,
  updateRoutingForm,
} from './routing-form-service.ts'
import { routingTokenDigest } from './routing-receipt-crypto.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = Temporal.Instant.from('2030-10-07T08:00:00Z')
const routingSecret = randomBytes(32).toString('base64url')
const range = {
  start: Temporal.Instant.from('2030-10-07T09:00:00Z'),
  end: Temporal.Instant.from('2030-10-07T11:00:00Z'),
}

describe.skipIf(!serverUrl)('routing continuation reads', () => {
  let owned: TestDatabase
  let db: Db
  let fixtures: ReturnType<typeof createFixtures>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'routing_continue' })
    db = createDb(owned.pool)
    fixtures = createFixtures(db)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  function publicContext(at = now): RoutingContinuationContext {
    return { db, now: () => at, receiptNow: () => at, routingFormsEnabled: true, routingSecret }
  }

  function sessionContext({ user, organization }: Principal): ServiceContext {
    return testContext(
      db,
      { kind: 'session', sessionId: randomUUID(), user, organization },
      () => now,
    )
  }

  async function personalOwner() {
    const owner = await createTestUser(db, 'Synthetic personal owner')
    await db
      .insertInto('profiles')
      .values({ user_id: owner.id, handle: `p-${owner.id}`, time_zone: 'UTC' })
      .execute()
    return owner
  }

  async function issue(
    ctx: ServiceContext,
    fallback: Extract<RoutingTarget, { kind: 'event' }>,
    questions: RoutingQuestion[] = [],
    answers: Record<string, string> = {},
  ) {
    const { id: formId } = await createRoutingForm(ctx, {
      slug: `form-${randomUUID()}`,
      title: 'Synthetic form',
      questions,
      fallback,
    })
    const publication = await publishRoutingForm(ctx, formId, { expectedRevision: 1 })
    const form = await updateRoutingForm(ctx, formId, {
      expectedRevision: publication.form.draftRevision,
      enabled: true,
    })
    const outcome = await submitRoutingForm(
      { db, routingFormsEnabled: true, routingSecret, now: () => now },
      { organizationId: ctx.principal.organization.id, formId },
      { versionId: publication.version.id, answers },
    )
    if (outcome.kind !== 'continuation') throw new Error('Expected a fixture continuation')
    return { form, ...outcome }
  }

  function receipt(routeToken: string) {
    return db
      .selectFrom('routing_receipts')
      .selectAll()
      .where('token_hash', '=', routingTokenDigest(routingSecret, 'continuation', routeToken))
      .executeTakeFirstOrThrow()
  }

  it('projects a hidden target, revalidates mappings, and keeps the receipt pinned after publication', async () => {
    const owner = await personalOwner()
    const ctx = sessionContext(owner.principal)
    const questions = [
      { id: 'interest', type: 'select', label: 'Interest', required: true, options: ['A', 'B'] },
      { id: 'notes', type: 'long_text', label: 'Notes', required: false },
    ]
    const eventTypeId = await fixtures.eventType(ctx.principal.organization.id, owner.id, {
      slug: 'private-hidden-target',
      title: 'Original title',
      questions,
      location: { kind: 'link', url: 'https://private.example.test/meeting' },
    })
    await db
      .updateTable('event_types')
      .set({ is_hidden: true })
      .where('id', '=', eventTypeId)
      .execute()
    const nameId = randomUUID()
    const emailId = randomUUID()
    const interestId = randomUUID()
    const notesId = randomUUID()
    const unmappedId = randomUUID()
    const optionA = randomUUID()
    const optionB = randomUUID()
    const { form, routeToken, expiresAt } = await issue(
      ctx,
      {
        kind: 'event',
        eventTypeId,
        mappings: [
          { questionId: nameId, destination: { kind: 'inviteeName' } },
          { questionId: emailId, destination: { kind: 'inviteeEmail' } },
          { questionId: notesId, destination: { kind: 'question', questionId: 'notes' } },
          {
            questionId: interestId,
            destination: { kind: 'question', questionId: 'interest' },
            options: { [optionA]: 'A', [optionB]: 'B' },
          },
        ],
      },
      [
        { id: nameId, label: 'Name', type: 'short_text', required: true },
        { id: emailId, label: 'Email', type: 'email', required: true },
        { id: notesId, label: 'Notes', type: 'short_text', required: false },
        { id: unmappedId, label: 'Unmapped', type: 'short_text', required: false },
        {
          id: interestId,
          label: 'Interest',
          type: 'select',
          required: true,
          options: [
            { id: optionA, label: 'Alpha' },
            { id: optionB, label: 'Beta' },
          ],
        },
      ],
      {
        [nameId]: ' Synthetic invitee ',
        [emailId]: 'invitee@example.test',
        [notesId]: 'Synthetic mapped text',
        [unmappedId]: 'Synthetic unrelated answer',
        [interestId]: optionA,
      },
    )
    const expected = {
      eventType: {
        title: 'Original title',
        description: null,
        durationMinutes: 30,
        questions,
        location: { kind: 'link' },
        locations: [{ id: 'legacy', kind: 'link' }],
        allowGuests: false,
        smsRemindersEnabled: false,
        host: { name: 'Synthetic personal owner', timeZone: 'UTC' },
      },
      prefill: {
        inviteeName: 'Synthetic invitee',
        inviteeEmail: 'invitee@example.test',
        responses: { interest: 'A', notes: 'Synthetic mapped text' },
      },
      expiresAt,
    }
    expect(await resolveRoutingContinuation(publicContext(), routeToken)).toEqual(expected)

    const edit = await updateRoutingForm(ctx, form.id, {
      expectedRevision: form.draftRevision,
      fallback: { kind: 'message', message: 'The new publication does not route.' },
    })
    await publishRoutingForm(ctx, form.id, { expectedRevision: edit.draftRevision })
    const currentQuestions = [
      {
        id: 'interest',
        type: 'select',
        label: 'Updated interest',
        required: true,
        options: ['A', 'C'],
      },
    ]
    await db
      .updateTable('event_types')
      .set({
        title: 'Current title',
        duration_minutes: 45,
        allowed_durations_minutes: [30, 45],
        questions: JSON.stringify(currentQuestions),
      })
      .where('id', '=', eventTypeId)
      .execute()

    expect(await resolveRoutingContinuation(publicContext(), routeToken)).toEqual({
      ...expected,
      eventType: {
        ...expected.eventType,
        title: 'Current title',
        durationMinutes: 45,
        allowedDurationsMinutes: [30, 45],
        questions: currentQuestions,
      },
      prefill: { ...expected.prefill, responses: {} },
    })

    await db.updateTable('auth.user').set({ name: '' }).where('id', '=', owner.id).execute()
    expect(
      (await resolveRoutingContinuation(publicContext(), routeToken)).eventType.host,
    ).toBeUndefined()
  })

  it('reads ordinary round-robin availability repeatedly without extending the receipt or assigning hosts', async () => {
    const owner = await createTestUser(db, 'Synthetic team owner')
    const member = await createTestUser(db, 'Synthetic team host')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const ctx = sessionContext(team.as(owner))
    await fixtures.schedule(owner.id, {
      timeZone: 'UTC',
      weeklyHours: { monday: [{ start: '09:00', end: '10:00' }] },
    })
    await fixtures.schedule(member.id, {
      timeZone: 'UTC',
      weeklyHours: { monday: [{ start: '10:00', end: '11:00' }] },
    })
    const event = await createEventType(ctx, {
      slug: 'pool',
      title: 'Synthetic round robin',
      durationMinutes: 30,
      schedulingType: 'round_robin',
      hosts: [{ userId: owner.id }, { userId: member.id }],
    })
    await activateRoundRobin(ctx, event.id)
    const { routeToken } = await issue(ctx, { kind: 'event', eventTypeId: event.id, mappings: [] })
    const data = { ...range, routeToken }
    const direct = await listPublicTeamSlots(publicContext(), {
      ...range,
      handle: ctx.principal.organization.slug,
      slug: event.slug,
    })
    expect(direct).toHaveLength(4)

    const assignment = async () => ({
      pool: await db
        .selectFrom('round_robin_state')
        .selectAll()
        .where('event_type_id', '=', event.id)
        .executeTakeFirstOrThrow(),
      hosts: await db
        .selectFrom('event_type_hosts')
        .select(['user_id', 'last_assigned_sequence'])
        .where('event_type_id', '=', event.id)
        .orderBy('user_id')
        .execute(),
    })
    const before = { receipt: await receipt(routeToken), assignment: await assignment() }
    const absoluteExpiry = now.add({ minutes: 30 })
    const initial = await resolveRoutingContinuation(publicContext(), routeToken)
    expect(initial.expiresAt).toBe('2030-10-07T08:30:00Z')
    expect(initial.eventType.host).toBeUndefined()
    expect(await listRoutingContinuationSlots(publicContext(), data)).toEqual(direct)
    const stillValid = publicContext(absoluteExpiry.subtract({ milliseconds: 1 }))
    expect(await resolveRoutingContinuation(stillValid, routeToken)).toEqual(initial)
    expect(await listRoutingContinuationSlots(stillValid, data)).toEqual(direct)
    await expect(
      resolveRoutingContinuation(publicContext(absoluteExpiry), routeToken),
    ).rejects.toMatchObject({
      code: 'routing_unavailable',
    })
    await expect(
      listRoutingContinuationSlots(publicContext(absoluteExpiry), data),
    ).rejects.toMatchObject({
      code: 'routing_unavailable',
    })
    expect({ receipt: await receipt(routeToken), assignment: await assignment() }).toEqual(before)
  })

  it('returns the same neutral failure for guessed tokens and unavailable bound targets or forms', async () => {
    const owner = await personalOwner()
    const ctx = sessionContext(owner.principal)
    const eventTypeId = await fixtures.eventType(ctx.principal.organization.id, owner.id)
    const { form, routeToken } = await issue(ctx, { kind: 'event', eventTypeId, mappings: [] })
    const unavailable = {
      kind: 'conflict',
      code: 'routing_unavailable',
      message: 'routing_unavailable',
    }
    async function cannotRead(token: string) {
      await expect(resolveRoutingContinuation(publicContext(), token)).rejects.toMatchObject(
        unavailable,
      )
      await expect(
        listRoutingContinuationSlots(publicContext(), { ...range, routeToken: token }),
      ).rejects.toMatchObject(unavailable)
    }
    await cannotRead('malformed')
    await cannotRead('a'.repeat(43))
    await expect(resolveRoutingContinuation(publicContext(), routeToken)).resolves.toMatchObject({
      eventType: { title: 'Intro call' },
    })

    await db
      .updateTable('event_types')
      .set({ is_active: false })
      .where('id', '=', eventTypeId)
      .execute()
    await cannotRead(routeToken)
    await db
      .updateTable('event_types')
      .set({ is_active: true, questions: JSON.stringify([{ id: 'broken' }]) })
      .where('id', '=', eventTypeId)
      .execute()
    await cannotRead(routeToken)
    await db
      .updateTable('event_types')
      .set({ questions: '[]' })
      .where('id', '=', eventTypeId)
      .execute()

    const disabled = await updateRoutingForm(ctx, form.id, {
      expectedRevision: form.draftRevision,
      enabled: false,
    })
    await cannotRead(routeToken)
    await archiveRoutingForm(ctx, form.id, { expectedRevision: disabled.draftRevision })
    await cannotRead(routeToken)
  })
})
