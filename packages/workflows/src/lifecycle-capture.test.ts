import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  type BookingEvent,
  type BookingNotifier,
  cancelHostBooking,
  cancelManagedBooking,
  createPublicBooking,
  expireRescheduleRequest,
  requestReschedule,
  rescheduleHostBooking,
  rescheduleManagedBooking,
  setAttendeeNoShow,
} from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WorkflowAuditRecord } from './audit.ts'
import { captureBookingWorkflows } from './capture.ts'
import { createWorkflowDefinition } from './creates.ts'
import { deleteWorkflowDefinition } from './deletes.ts'
import { createRecordingWorkflowAudit, expectWorkflowAuditRedacted } from './testing.ts'
import { updateWorkflowDefinition } from './updates.ts'

const NOW = Temporal.Instant.from('2030-01-07T08:00:00Z')
const START = Temporal.Instant.from('2030-01-10T12:00:00Z')
const secret = 'synthetic-lifecycle-workflow-secret'
type Capture = typeof captureBookingWorkflows

function gate() {
  let enter!: () => void
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    enter = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { enter, release, ready, wait }
}

describe.skipIf(!process.env.DATABASE_URL)('workflow booking lifecycle capture', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'workflow_life',
    })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  const define = (
    user: TestUser,
    trigger: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    createWorkflowDefinition(
      { db, principal: user.principal },
      {
        owner: { kind: 'personal', id: user.id },
        idempotencyKey: randomUUID(),
        name: 'Lifecycle message',
        scope: { type: 'all_event_types' },
        trigger,
        actions: [{ type: 'email', recipients: ['booker'] }],
        enabled: true,
        ...extra,
      },
    )
  const runs = (id: string) =>
    db.selectFrom('workflow_runs').selectAll().where('booking_id', '=', id).orderBy('id').execute()
  const enrollments = (id: string) =>
    db
      .selectFrom('workflow_enrollments')
      .selectAll()
      .where('booking_id', '=', id)
      .orderBy('id')
      .execute()
  const claims = (id: string) =>
    db
      .selectFrom('workflow_recipient_claims')
      .selectAll()
      .where('booking_id', '=', id)
      .orderBy('id')
      .execute()
  const wakes = (id: string) =>
    db
      .selectFrom('booking_scheduled_messages')
      .selectAll()
      .where('booking_id', '=', id)
      .orderBy('id')
      .execute()
  const invoke = (event: BookingEvent, now = NOW, operation = captureBookingWorkflows) =>
    db.transaction().execute((trx) => operation(trx, event, now, secret))

  function expectLifecycleAudit(
    user: TestUser,
    records: WorkflowAuditRecord[],
    transitions: Pick<WorkflowAuditRecord, 'event' | 'workflowId' | 'trigger'>[],
  ) {
    expectWorkflowAuditRedacted(records, [secret, 'Booker', 'booker@example.com', user.email])
    const expected: WorkflowAuditRecord[] = transitions.map((transition) => ({
      ...transition,
      occurredAt: NOW,
      actor: { kind: 'background', job: 'capture' },
      owner: { kind: 'personal', organizationId: user.principal.organization.id, userId: user.id },
      revision: 1,
    }))
    const order = (a: WorkflowAuditRecord, b: WorkflowAuditRecord) =>
      a.event.localeCompare(b.event) || (a.workflowId ?? '').localeCompare(b.workflowId ?? '')
    expect(records.sort(order)).toEqual(expected.sort(order))
  }

  async function setup(operation: Capture = captureBookingWorkflows, at = NOW, start = START) {
    const user = await createTestUser(db)
    const handle = `lifecycle-${randomUUID().slice(0, 8)}`
    await db
      .insertInto('profiles')
      .values({ user_id: user.id, handle, time_zone: 'America/New_York' })
      .execute()
    const hours = [{ start: '00:00', end: '23:59' }]
    await createFixtures(db).schedule(user.id, {
      timeZone: 'UTC',
      weeklyHours: {
        monday: hours,
        tuesday: hours,
        wednesday: hours,
        thursday: hours,
        friday: hours,
        saturday: hours,
        sunday: hours,
      },
    })
    const eventTypeId = await createFixtures(db).eventType(
      user.principal.organization.id,
      user.id,
      { slug: 'lifecycle' },
    )
    await db
      .updateTable('event_types')
      .set({ notifications: JSON.stringify({ reminders: [], followUps: [] }) })
      .where('id', '=', eventTypeId)
      .execute()
    const clock = { now: at }
    const events: BookingEvent[] = []
    const notify: BookingNotifier = async (trx, event, now) => {
      events.push(event)
      await operation(trx, event, now, secret)
    }
    const pub = { db, now: () => clock.now, notify }
    const ctx = { ...pub, principal: user.principal }
    const create = () =>
      createPublicBooking(pub, {
        handle,
        slug: 'lifecycle',
        start,
        invitee: { name: 'Booker', email: 'booker@example.com', timeZone: 'America/New_York' },
      })
    return { user, eventTypeId, clock, events, pub, ctx, create, start }
  }

  async function cancellationCheck(operation: Capture) {
    const s = await setup(operation)
    const workflow = await define(s.user, { type: 'booking.cancelled', delayMinutes: 30 })
    const delayed = await define(s.user, { type: 'booking.created', delayMinutes: 60 })
    const timer = await define(s.user, { type: 'before_start', offsetMinutes: 30 })
    const created = await s.create()
    await updateWorkflowDefinition(s.ctx, delayed.id, { expectedRevision: 1, enabled: false })
    await cancelHostBooking(s.ctx, created.booking.id)
    const before = await runs(created.booking.id)
    expect(before.filter((r) => r.state === 'retired')).toHaveLength(2)
    expect(before.filter((r) => r.state === 'pending')).toHaveLength(1)
    const event = { type: 'cancelled' as const, bookingId: created.booking.id }
    await expect(
      Promise.all([
        invoke(event, NOW, operation),
        invoke(event, NOW.add({ minutes: 1 }), operation),
      ]),
    ).resolves.toEqual([undefined, undefined])
    expect(await runs(created.booking.id)).toEqual(before)
    const saved = await enrollments(created.booking.id)
    expect(saved.filter((e) => e.occurrence === 'cancelled')).toMatchObject([
      { workflow_id: workflow.id, revision: 1 },
    ])
    return { user: s.user, workflow, delayed, timer }
  }
  it('coalesces cancellation replay without retiring its delayed cancellation action', async () => {
    const audit = await createRecordingWorkflowAudit(db)
    const { user, workflow, delayed, timer } = await cancellationCheck((trx, event, now, secret) =>
      captureBookingWorkflows(trx, event, now, secret, audit.port),
    )
    expectLifecycleAudit(user, await audit.read(), [
      { event: 'workflow.run_scheduled', workflowId: delayed.id, trigger: 'booking.created' },
      { event: 'workflow.run_scheduled', workflowId: timer.id, trigger: 'before_start' },
      { event: 'workflow.run_cancelled', workflowId: delayed.id, trigger: 'booking.created' },
      { event: 'workflow.run_cancelled', workflowId: timer.id, trigger: 'before_start' },
      { event: 'workflow.run_scheduled', workflowId: workflow.id, trigger: 'booking.cancelled' },
    ])
  })

  async function successorCheck(operation: Capture) {
    const s = await setup(operation)
    const timer = await define(s.user, { type: 'before_start', offsetMinutes: 30 })
    const delayed = await define(s.user, { type: 'booking.created', delayMinutes: 60 })
    await define(s.user, { type: 'booking.cancelled', delayMinutes: 0 })
    const movedWorkflow = await define(s.user, { type: 'booking.rescheduled', delayMinutes: 20 })
    const original = await s.create()
    await updateWorkflowDefinition(s.ctx, timer.id, {
      expectedRevision: 1,
      trigger: { type: 'before_start', offsetMinutes: 90 },
    })
    const laterCreated = await define(s.user, { type: 'booking.created', delayMinutes: 0 })
    const moved = await rescheduleHostBooking(s.ctx, original.booking.id, {
      start: s.start.add({ hours: 2 }),
    })
    expect(s.events.map((e) => e.type)).toEqual(['created', 'rescheduled'])
    expect((await runs(original.booking.id)).map((r) => r.state)).toEqual(['retired', 'retired'])
    const successor = await enrollments(moved.booking.id)
    expect(successor).toHaveLength(2)
    expect(successor).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflow_id: timer.id,
          revision: 1,
          occurrence: 'created',
          trigger: 'before_start',
        }),
        expect.objectContaining({
          workflow_id: movedWorkflow.id,
          revision: 1,
          occurrence: 'rescheduled',
          trigger: 'booking.rescheduled',
        }),
      ]),
    )
    expect(successor.some((e) => [delayed.id, laterCreated.id].includes(e.workflow_id))).toBe(false)
    const due = (await runs(moved.booking.id)).find(
      (r) => r.enrollment_id === successor.find((e) => e.workflow_id === timer.id)?.id,
    )
    expect(due?.due_at.toISOString()).toBe(
      s.start.add({ hours: 2 }).subtract({ minutes: 30 }).toString({ fractionalSecondDigits: 3 }),
    )
    const before = await runs(moved.booking.id)
    await invoke(
      { type: 'rescheduled', bookingId: moved.booking.id, start: s.start.add({ hours: 2 }) },
      NOW,
      operation,
    )
    await invoke(
      { type: 'created', bookingId: moved.booking.id, start: s.start.add({ hours: 2 }) },
      NOW,
      operation,
    )
    await invoke({ type: 'cancelled', bookingId: original.booking.id }, NOW, operation)
    expect(await runs(moved.booking.id)).toEqual(before)
    expect(
      (await enrollments(original.booking.id)).some((e) => e.trigger === 'booking.cancelled'),
    ).toBe(false)
    return { s, original, moved, timer, delayed, movedWorkflow }
  }
  it('retains timer revisions and retires delayed created work without transferring it or firing created/cancelled', async () => {
    const audit = await createRecordingWorkflowAudit(db)
    const { s, timer, delayed, movedWorkflow } = await successorCheck((trx, event, now, secret) =>
      captureBookingWorkflows(trx, event, now, secret, audit.port),
    )
    expectLifecycleAudit(s.user, await audit.read(), [
      { event: 'workflow.run_scheduled', workflowId: timer.id, trigger: 'before_start' },
      { event: 'workflow.run_scheduled', workflowId: delayed.id, trigger: 'booking.created' },
      { event: 'workflow.run_cancelled', workflowId: timer.id, trigger: 'before_start' },
      { event: 'workflow.run_cancelled', workflowId: delayed.id, trigger: 'booking.created' },
      { event: 'workflow.run_scheduled', workflowId: timer.id, trigger: 'before_start' },
      {
        event: 'workflow.run_scheduled',
        workflowId: movedWorkflow.id,
        trigger: 'booking.rescheduled',
      },
    ])
  })

  it('recalculates timer instants on a DST-night successor across the repeated hour', async () => {
    const s = await setup(
      captureBookingWorkflows,
      Temporal.Instant.from('2030-11-02T00:00:00Z'),
      Temporal.Instant.from('2030-11-03T05:30:00Z'),
    )
    const timer = await define(s.user, { type: 'before_start', offsetMinutes: 30 })
    const original = await s.create()
    const moved = await rescheduleHostBooking(s.ctx, original.booking.id, {
      start: Temporal.Instant.from('2030-11-03T06:30:00Z'),
    })
    expect((await enrollments(moved.booking.id))[0]).toMatchObject({
      workflow_id: timer.id,
      revision: 1,
    })
    expect((await runs(moved.booking.id))[0]?.due_at.toISOString()).toBe('2030-11-03T06:00:00.000Z')
    expect((await runs(original.booking.id))[0]?.state).toBe('retired')
  })

  async function seedWake(id: string, organizationId: string, start = START) {
    await db
      .insertInto('booking_scheduled_messages')
      .values({
        booking_id: id,
        organization_id: organizationId,
        kind: 'reminder',
        rule_id: 'synthetic-reminder',
        anchor_start_at: start.toString(),
        anchor_end_at: start.add({ minutes: 30 }).toString(),
        due_at: start.subtract({ hours: 24 }).toString(),
        expires_at: start.toString(),
        next_attempt_at: start.subtract({ hours: 24 }).toString(),
      })
      .execute()
  }
  const snapshot = async (id: string) => ({
    runs: await runs(id),
    enrollments: await enrollments(id),
    claims: await claims(id),
    wakes: await wakes(id),
  })
  it('requests and request expiry create no occurrence and preserve pending runs and wakes byte for byte', async () => {
    const s = await setup()
    await define(s.user, { type: 'before_start', offsetMinutes: 30 })
    await define(s.user, { type: 'booking.created', delayMinutes: 60 })
    const original = await s.create()
    await seedWake(original.booking.id, s.user.principal.organization.id)
    const before = await snapshot(original.booking.id)
    const requested = await requestReschedule(s.ctx, original.booking.id, {
      idempotencyKey: randomUUID(),
    })
    const requestId = requested.pendingReschedule?.id
    expect(requestId).toBeDefined()
    expect(await snapshot(original.booking.id)).toEqual(before)
    s.clock.now = NOW.add({ hours: 49 })
    await expireRescheduleRequest(s.pub, requestId as string)
    expect(s.events.map((e) => e.type)).toEqual([
      'created',
      'reschedule_requested',
      'reschedule_request_expired',
    ])
    expect(await snapshot(original.booking.id)).toEqual(before)
  })

  it('marking and unmarking a no-show never notify workflows or alter pending runs and wakes', async () => {
    const s = await setup()
    await define(s.user, { type: 'after_end', offsetMinutes: 60 })
    const original = await s.create()
    await seedWake(original.booking.id, s.user.principal.organization.id)
    const attendee = await db
      .selectFrom('booking_attendees')
      .select('id')
      .where('booking_id', '=', original.booking.id)
      .executeTakeFirstOrThrow()
    const before = await snapshot(original.booking.id)
    s.clock.now = START.add({ minutes: 1 })
    await setAttendeeNoShow(s.ctx, original.booking.id, attendee.id, true)
    expect(await snapshot(original.booking.id)).toEqual(before)
    await setAttendeeNoShow(s.ctx, original.booking.id, attendee.id, false)
    expect(await snapshot(original.booking.id)).toEqual(before)
    expect(s.events.map((e) => e.type)).toEqual(['created'])
  })

  async function requestLink(id: string, requestId: string) {
    const token = randomBytes(32).toString('base64url')
    const attendee = await db
      .selectFrom('booking_attendees')
      .select('id')
      .where('booking_id', '=', id)
      .where('is_booker', '=', true)
      .executeTakeFirstOrThrow()
    await db
      .insertInto('booking_notifications')
      .values({
        booking_id: id,
        kind: 'reschedule_requested',
        message_key: requestId,
        recipient: `attendee:${attendee.id}`,
        manage_token_hash: createHash('sha256').update(token).digest(),
      })
      .execute()
    return token
  }
  it.each(['pick', 'cancel'] as const)(
    'a request %s captures the ordinary lifecycle occurrence',
    async (action) => {
      const s = await setup()
      await define(s.user, { type: 'before_start', offsetMinutes: 30 })
      await define(s.user, { type: 'booking.rescheduled', delayMinutes: 0 })
      await define(s.user, { type: 'booking.cancelled', delayMinutes: 0 })
      const original = await s.create()
      const requested = await requestReschedule(s.ctx, original.booking.id, {
        idempotencyKey: randomUUID(),
      })
      const requestId = requested.pendingReschedule?.id as string
      const token = await requestLink(original.booking.id, requestId)
      if (action === 'pick') {
        const moved = await rescheduleManagedBooking(s.pub, token, {
          start: START.add({ hours: 1 }),
          rescheduleRequestId: requestId,
        })
        expect((await enrollments(moved.booking.id)).map((e) => e.trigger).sort()).toEqual([
          'before_start',
          'booking.rescheduled',
        ])
        expect((await enrollments(original.booking.id)).map((e) => e.trigger)).toEqual([
          'before_start',
        ])
      } else {
        await cancelManagedBooking(s.pub, token, { rescheduleRequestId: requestId })
        expect((await enrollments(original.booking.id)).map((e) => e.trigger).sort()).toEqual([
          'before_start',
          'booking.cancelled',
        ])
      }
      expect(s.events.map((e) => e.type)).toEqual([
        'created',
        'reschedule_requested',
        action === 'pick' ? 'rescheduled' : 'cancelled',
      ])
      expect((await runs(original.booking.id)).find((r) => r.state === 'retired')).toBeDefined()
    },
  )

  it('keeps real group-seat reschedule and cancellation silent', async () => {
    const s = await setup()
    await define(s.user, { type: 'booking.cancelled', delayMinutes: 0 })
    await define(s.user, { type: 'booking.rescheduled', delayMinutes: 0 })
    await db
      .updateTable('event_types')
      .set({ booking_mode: 'group', group_capacity: 3 })
      .where('id', '=', s.eventTypeId)
      .execute()
    const original = await s.create()
    const moved = await rescheduleHostBooking(s.ctx, original.booking.id, {
      start: START.add({ hours: 1 }),
      idempotencyKey: randomUUID(),
    })
    await cancelHostBooking(s.ctx, moved.booking.id)
    expect(await enrollments(moved.booking.id)).toEqual([])
    expect(await runs(moved.booking.id)).toEqual([])
    expect(await enrollments(original.booking.id)).toEqual([])
    expect(await runs(original.booking.id)).toEqual([])
  })

  it('keeps imported cancellation and native-looking successors of imported bookings silent', async () => {
    const s = await setup()
    await define(s.user, { type: 'booking.cancelled', delayMinutes: 0 })
    await define(s.user, { type: 'booking.rescheduled', delayMinutes: 0 })
    const original = await db
      .insertInto('bookings')
      .values({
        organization_id: s.user.principal.organization.id,
        event_type_id: s.eventTypeId,
        title: 'Imported',
        source: 'import',
        import_questions: '[]',
        start_at: START.toString(),
        end_at: START.add({ minutes: 30 }).toString(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await invoke({ type: 'cancelled', bookingId: original.id })
    const intermediate = await db
      .insertInto('bookings')
      .values({
        organization_id: s.user.principal.organization.id,
        event_type_id: s.eventTypeId,
        title: 'Successor',
        status: 'cancelled',
        cancelled_at: NOW.toString(),
        source: 'web',
        rescheduled_from_id: original.id,
        start_at: START.add({ hours: 1 }).toString(),
        end_at: START.add({ minutes: 90 }).toString(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await invoke({ type: 'cancelled', bookingId: intermediate.id })
    const moved = await db
      .insertInto('bookings')
      .values({
        organization_id: s.user.principal.organization.id,
        event_type_id: s.eventTypeId,
        title: 'Later successor',
        source: 'web',
        rescheduled_from_id: intermediate.id,
        start_at: START.add({ hours: 2 }).toString(),
        end_at: START.add({ minutes: 150 }).toString(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await invoke({ type: 'rescheduled', bookingId: moved.id, start: START.add({ hours: 1 }) })
    expect(await enrollments(original.id)).toEqual([])
    expect(await enrollments(intermediate.id)).toEqual([])
    expect(await enrollments(moved.id)).toEqual([])
    expect(await runs(moved.id)).toEqual([])
  })

  async function waitForLock() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await owned.pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
      )
      if (result.rowCount) return
      await setTimeout(10)
    }
    throw new Error('Contender never waited for a lock')
  }

  async function deletionFirst(operation: Capture) {
    const s = await setup(operation)
    const timer = await define(s.user, { type: 'before_start', offsetMinutes: 30 })
    const original = await s.create()
    // Persist the booking change without capture so the contender starts at the lifecycle hook.
    const moved = await rescheduleHostBooking(
      { ...s.ctx, notify: undefined },
      original.booking.id,
      { start: START.add({ hours: 1 }) },
    )
    const pause = gate()
    const deletion = deleteWorkflowDefinition(
      {
        ...s.ctx,
        prepareOrganizationWrite: async (trx) => {
          await sql`SELECT id FROM auth.organization WHERE id=${s.user.principal.organization.id} FOR KEY SHARE`.execute(
            trx,
          )
          await trx
            .selectFrom('workflow_definitions')
            .select('id')
            .where('id', '=', timer.id)
            .forUpdate()
            .execute()
          pause.enter()
          await pause.wait
        },
      },
      timer.id,
      { expectedRevision: 1 },
    ).then(
      () => null,
      (error: unknown) => error,
    )
    await pause.ready
    const contender = invoke(
      { type: 'rescheduled', bookingId: moved.booking.id, start: START.add({ hours: 1 }) },
      NOW,
      operation,
    ).then(
      () => null,
      (error: unknown) => error,
    )
    try {
      await waitForLock()
    } finally {
      pause.release()
    }
    expect(await Promise.all([deletion, contender])).toEqual([null, null])
    expect((await runs(original.booking.id))[0]?.state).toBe('retired')
    expect(await runs(moved.booking.id)).toEqual([])
  }
  it('lets deletion finish while a reschedule contender waits for its definition before touching runs', async () => {
    await deletionFirst(captureBookingWorkflows)
  })

  it('lets reschedule commit first and deletion retire the carried timer without deadlock', async () => {
    const s = await setup()
    const timer = await define(s.user, { type: 'before_start', offsetMinutes: 30 })
    const original = await s.create()
    const pause = gate()
    const move = rescheduleHostBooking(
      {
        ...s.ctx,
        notify: async (trx, event, now) => {
          await captureBookingWorkflows(trx, event, now, secret)
          pause.enter()
          await pause.wait
        },
      },
      original.booking.id,
      { start: START.add({ hours: 1 }) },
    )
    await pause.ready
    const deletion = deleteWorkflowDefinition(s.ctx, timer.id, { expectedRevision: 1 })
    try {
      await waitForLock()
    } finally {
      pause.release()
    }
    const moved = await move
    await deletion
    expect((await runs(original.booking.id))[0]?.state).toBe('retired')
    expect((await runs(moved.booking.id))[0]?.state).toBe('retired')
  })
  it('captures only the booking owner scope without leaking foreign or personal workflows into a team', async () => {
    const s = await setup()
    const foreign = await createTestUser(db)
    const foreignWorkflow = await define(foreign, { type: 'booking.cancelled', delayMinutes: 0 })
    const personalWorkflow = await define(s.user, { type: 'booking.cancelled', delayMinutes: 0 })
    const team = await createTestTeam(db, [{ user: s.user, role: 'owner' }])
    const teamEvent = await createFixtures(db).eventType(team.id, null)
    const teamWorkflow = await createWorkflowDefinition(
      { db, principal: team.as(s.user) },
      {
        owner: { kind: 'team', id: team.id },
        idempotencyKey: randomUUID(),
        name: 'Team cancellation',
        scope: { type: 'all_event_types' },
        trigger: { type: 'booking.cancelled', delayMinutes: 0 },
        actions: [{ type: 'email', recipients: ['booker'] }],
        enabled: true,
      },
    )
    const teamBooking = await db
      .insertInto('bookings')
      .values({
        organization_id: team.id,
        event_type_id: teamEvent,
        title: 'Team meeting',
        source: 'web',
        status: 'cancelled',
        cancelled_at: NOW.toString(),
        start_at: START.toString(),
        end_at: START.add({ minutes: 30 }).toString(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('booking_hosts')
      .values({ booking_id: teamBooking.id, user_id: s.user.id })
      .execute()
    await invoke({ type: 'cancelled', bookingId: teamBooking.id })
    const saved = await enrollments(teamBooking.id)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ workflow_id: teamWorkflow.id, organization_id: team.id })
    expect(
      saved.some((e) => [foreignWorkflow.id, personalWorkflow.id].includes(e.workflow_id)),
    ).toBe(false)
  })

  it('captures retained timer and current reschedule revisions of the same workflow separately', async () => {
    const s = await setup()
    const workflow = await define(s.user, { type: 'before_start', offsetMinutes: 30 })
    const original = await s.create()
    await updateWorkflowDefinition(s.ctx, workflow.id, {
      expectedRevision: 1,
      trigger: { type: 'booking.rescheduled', delayMinutes: 15 },
    })
    const moved = await rescheduleHostBooking(s.ctx, original.booking.id, {
      start: START.add({ hours: 1 }),
    })
    expect(await enrollments(moved.booking.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflow_id: workflow.id,
          revision: 1,
          trigger: 'before_start',
          occurrence: 'created',
        }),
        expect.objectContaining({
          workflow_id: workflow.id,
          revision: 2,
          trigger: 'booking.rescheduled',
          occurrence: 'rescheduled',
        }),
      ]),
    )
    expect(await runs(moved.booking.id)).toHaveLength(2)
  })

  it.each(['coalescing', 'no transfer', 'lock order'] as const)(
    'kills the %s source-copy mutation with a real assertion',
    async (protection) => {
      const source = new URL('./capture.ts', import.meta.url)
      const original = await readFile(source, 'utf8')
      let changed = original
      const replace = (before: string, after: string) => {
        expect(changed).toContain(before)
        changed = changed.replace(before, after)
      }
      if (protection === 'coalescing') {
        replace(
          ".onConflict((oc) => oc.columns(['booking_id', 'occurrence', 'workflow_id']).doNothing())",
          '',
        )
      } else if (protection === 'no transfer') {
        replace(
          ".where('trigger', 'in', ['before_start', 'after_end'])",
          ".where('trigger', 'in', ['before_start', 'after_end', 'booking.created'])",
        )
        replace('? !timer\n', "? !timer && trigger !== 'booking.created'\n")
        replace(
          "occurrence: timer ? 'created' : event.type",
          "occurrence: retained || timer ? 'created' : event.type",
        )
      } else {
        replace('.forShare()', '')
      }
      const executable = stripTypeScriptTypes(changed).replace(
        /from '([^']+)'/g,
        (_, specifier: string) => {
          if (specifier.startsWith('node:')) return `from '${specifier}'`
          return `from '${specifier.startsWith('.') ? new URL(specifier, source).href : pathToFileURL(createRequire(source).resolve(specifier)).href}'`
        },
      )
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-lifecycle-mutation-'))
      try {
        const copy = pathToFileURL(join(directory, 'mutation.mjs'))
        await writeFile(copy, executable, { mode: 0o600 })
        const mutated = (await import(/* @vite-ignore */ copy.href))
          .captureBookingWorkflows as Capture
        const check =
          protection === 'coalescing'
            ? cancellationCheck
            : protection === 'no transfer'
              ? successorCheck
              : deletionFirst
        await check(captureBookingWorkflows)
        await expect(check(mutated)).rejects.toMatchObject({ name: 'AssertionError' })
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
