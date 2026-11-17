import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  type BookingNotifier,
  cancelPaymentHold,
  confirmPaymentHold,
  createPaymentHold,
  createPublicBooking,
  expirePaymentHolds,
} from '@hourmere/scheduling'
import { createNotificationSnapshot } from '@hourmere/scheduling/notification-settings'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { captureCreatedWorkflows, captureWorkflowCreation } from './capture.ts'
import { createWorkflowDefinition } from './creates.ts'
import { deleteWorkflowDefinition } from './deletes.ts'
import { updateWorkflowDefinition } from './updates.ts'

const NOW = Temporal.Instant.from('2030-01-07T08:00:00Z')
const START = NOW.add({ hours: 72 })
const secret = 'synthetic-workflow-capture-secret'
const quiet = JSON.stringify(createNotificationSnapshot({ reminders: [], followUps: [] }))

describe.skipIf(!process.env.DATABASE_URL)('workflow confirmed creation capture', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'workflow_capture',
    })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  const context = (user: TestUser) => ({ db, principal: user.principal })
  const define = (user: TestUser, extra: Record<string, unknown> = {}) =>
    createWorkflowDefinition(context(user), {
      owner: { kind: 'personal', id: user.id },
      idempotencyKey: randomUUID(),
      name: 'Preparation',
      scope: { type: 'all_event_types' },
      trigger: { type: 'booking.created', delayMinutes: 0 },
      actions: [{ type: 'email', recipients: ['booker'] }],
      enabled: true,
      ...extra,
    })
  async function setup() {
    const user = await createTestUser(db)
    const eventTypeId = await createFixtures(db).eventType(user.principal.organization.id, user.id)
    return { user, eventTypeId }
  }
  async function booking(
    user: TestUser,
    eventTypeId: string,
    extra: Record<string, unknown> = {},
    trx = db,
  ) {
    const row = await trx
      .insertInto('bookings')
      .values({
        organization_id: user.principal.organization.id,
        event_type_id: eventTypeId,
        start_at: START.toString(),
        end_at: START.add({ minutes: 30 }).toString(),
        title: 'Private meeting',
        source: 'web',
        notification_snapshot: quiet,
        ...extra,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await trx.insertInto('booking_hosts').values({ booking_id: row.id, user_id: user.id }).execute()
    await trx
      .insertInto('booking_attendees')
      .values({
        booking_id: row.id,
        name: 'Booker',
        email: 'booker@example.com',
        is_booker: true,
        time_zone: 'America/Los_Angeles',
      })
      .execute()
    return row.id
  }
  const capture = (id: string, now = NOW) =>
    db
      .transaction()
      .execute((trx) =>
        captureCreatedWorkflows(trx, { type: 'created', bookingId: id, start: START }, now, secret),
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

  it('rolls booking, enrollment, due run and recipient intents back together', async () => {
    const { user, eventTypeId } = await setup()
    await define(user)
    let id = ''
    await expect(
      db.transaction().execute(async (trx) => {
        id = await booking(user, eventTypeId, {}, trx)
        await captureCreatedWorkflows(
          trx,
          { type: 'created', bookingId: id, start: START },
          NOW,
          secret,
        )
        expect(
          await trx.selectFrom('workflow_runs').select('id').where('booking_id', '=', id).execute(),
        ).toHaveLength(1)
        throw new Error('Booking transaction aborted')
      }),
    ).rejects.toThrow('Booking transaction aborted')
    expect(await db.selectFrom('bookings').select('id').where('id', '=', id).execute()).toEqual([])
    expect(await enrollments(id)).toEqual([])
    expect(await runs(id)).toEqual([])
    expect(await claims(id)).toEqual([])
  })

  it('coalesces concurrent duplicate captures and keeps the original revision and due instant after editing', async () => {
    const { user, eventTypeId } = await setup()
    const workflow = await define(user)
    const id = await booking(user, eventTypeId)
    await Promise.all([capture(id), capture(id)])
    expect(await enrollments(id)).toHaveLength(1)
    expect(await runs(id)).toHaveLength(1)
    expect(await claims(id)).toHaveLength(1)
    const before = {
      enrollments: await enrollments(id),
      runs: await runs(id),
      claims: await claims(id),
    }
    await updateWorkflowDefinition(context(user), workflow.id, {
      expectedRevision: 1,
      trigger: { type: 'booking.created', delayMinutes: 30 },
    })
    await capture(id, NOW.add({ minutes: 10 }))
    expect({
      enrollments: await enrollments(id),
      runs: await runs(id),
      claims: await claims(id),
    }).toEqual(before)
    expect(before.enrollments[0]).toMatchObject({ revision: 1, occurrence: 'created' })
  })

  it.each([
    ['minimum_gap', '2030-01-07T09:30:00Z', 30],
    ['offset_not_future', '2030-01-07T08:30:00Z', 30],
  ] as const)(
    'records %s at capture, including strict equality',
    async (reason, start, offsetMinutes) => {
      const { user, eventTypeId } = await setup()
      const workflow = await define(user, { trigger: { type: 'before_start', offsetMinutes } })
      const id = await booking(user, eventTypeId, {
        start_at: start,
        end_at: Temporal.Instant.from(start).add({ minutes: 30 }).toString(),
      })
      await capture(id)
      expect(await runs(id)).toEqual([
        expect.objectContaining({
          state: 'skipped',
          skip_reason: reason,
          finished_at: expect.any(Date),
        }),
      ])
      expect(
        await db
          .selectFrom('workflow_run_history')
          .selectAll()
          .where('workflow_id', '=', workflow.id)
          .execute(),
      ).toEqual([expect.objectContaining({ outcome: 'skipped', reason })])
      expect(await claims(id)).toEqual([])
    },
  )

  it('uses elapsed UTC minutes across the autumn DST night, regardless of attendee and host zones', async () => {
    const { user, eventTypeId } = await setup()
    await define(user, { trigger: { type: 'before_start', offsetMinutes: 1440 } })
    const id = await booking(user, eventTypeId, {
      start_at: '2030-11-03T09:30:00Z',
      end_at: '2030-11-03T10:00:00Z',
    })
    await capture(id, Temporal.Instant.from('2030-11-01T00:00:00Z'))
    expect(await runs(id)).toEqual([
      expect.objectContaining({
        state: 'pending',
        due_at: new Date('2030-11-02T09:30:00Z'),
        expires_at: new Date('2030-11-02T10:30:00Z'),
      }),
    ])
  })

  it.each(['import', 'deleted event', 'disabled', 'deleted workflow'] as const)(
    'captures nothing for %s',
    async (kind) => {
      const { user, eventTypeId } = await setup()
      const workflow = await define(user, { enabled: kind !== 'disabled' })
      if (kind === 'deleted workflow')
        await deleteWorkflowDefinition(context(user), workflow.id, { expectedRevision: 1 })
      if (kind === 'deleted event')
        await db
          .updateTable('event_types')
          .set({ deleted_at: new Date() })
          .where('id', '=', eventTypeId)
          .execute()
      const id = await booking(
        user,
        eventTypeId,
        kind === 'import' ? { source: 'import', import_questions: '[]' } : {},
      )
      await capture(id)
      expect(await enrollments(id)).toEqual([])
      expect(await runs(id)).toEqual([])
    },
  )

  it('does not enroll foreign owners or a mismatching event-specific scope', async () => {
    const { user, eventTypeId } = await setup()
    const foreign = await createTestUser(db)
    await define(foreign)
    const otherEvent = await createFixtures(db).eventType(user.principal.organization.id, user.id)
    await define(user, { scope: { type: 'event_type', eventTypeId: otherEvent } })
    const id = await booking(user, eventTypeId)
    await capture(id)
    expect(await enrollments(id)).toEqual([])
  })

  it('captures only team workflows for team bookings, never the assigned host personal workflow', async () => {
    const user = await createTestUser(db)
    const team = await createTestTeam(db, [{ user, role: 'owner' }])
    const teamUser = { ...user, principal: team.as(user) }
    const eventTypeId = await createFixtures(db).eventType(team.id, null, {
      hosts: [{ userId: user.id }],
    })
    await define(user)
    const workflow = await define(teamUser, { owner: { kind: 'team', id: team.id } })
    const id = await booking(teamUser, eventTypeId)
    await capture(id)
    expect(await enrollments(id)).toEqual([
      expect.objectContaining({ workflow_id: workflow.id, organization_id: team.id }),
    ])
  })
  it('records only condition_false for a private condition mismatch', async () => {
    const { user, eventTypeId } = await setup()
    const workflow = await define(user, {
      conditions: [{ field: 'booking_source', operator: 'equals', value: 'api' }],
    })
    const id = await booking(user, eventTypeId)
    await capture(id)
    expect(await runs(id)).toEqual([
      expect.objectContaining({ state: 'skipped', skip_reason: 'condition_false' }),
    ])
    const history = await db
      .selectFrom('workflow_run_history')
      .selectAll()
      .where('workflow_id', '=', workflow.id)
      .execute()
    expect(history).toEqual([expect.objectContaining({ reason: 'condition_false' })])
    expect(JSON.stringify(history)).not.toContain('booker@example.com')
    expect(JSON.stringify(history)).not.toContain('booking_source')
  })

  it.each(['before_start', 'after_end'] as const)(
    'lets saved core %s intents win even after later event policy edits',
    async (type) => {
      const { user, eventTypeId } = await setup()
      await define(user, { trigger: { type, offsetMinutes: 120 } })
      const rule = {
        id: 'core',
        offsetMinutes: 120,
        recipients: { invitee: true, guests: false, host: false },
      }
      const snapshot = createNotificationSnapshot({
        reminders: type === 'before_start' ? [rule] : [],
        followUps: type === 'after_end' ? [rule] : [],
      })
      const id = await booking(user, eventTypeId, {
        notification_snapshot: JSON.stringify(snapshot),
      })
      await db
        .updateTable('event_types')
        .set({ notifications: JSON.stringify({ reminders: [], followUps: [] }) })
        .where('id', '=', eventTypeId)
        .execute()
      await capture(id)
      expect(await claims(id)).toEqual([
        expect.objectContaining({
          state: 'skipped',
          skip_reason: 'existing_notification',
          intent_kind: null,
        }),
      ])
    },
  )

  it('lets legacy reminders win and keeps distinct workflow offsets independent', async () => {
    const { user, eventTypeId } = await setup()
    await define(user, { trigger: { type: 'before_start', offsetMinutes: 1440 } })
    await define(user, { trigger: { type: 'before_start', offsetMinutes: 120 } })
    const id = await booking(user, eventTypeId, { notification_snapshot: null })
    await capture(id)
    expect((await claims(id)).map((c) => [c.state, c.skip_reason])).toEqual([
      ['skipped', 'existing_notification'],
      ['pending', null],
    ])
  })

  it('uses creation order then ID for shared workflow intents and normalizes duplicate recipient addresses', async () => {
    const { user, eventTypeId } = await setup()
    const first = await define(user, {
      trigger: { type: 'before_start', offsetMinutes: 120 },
      actions: [{ type: 'email', recipients: ['booker', 'guests'] }],
    })
    const second = await db.transaction().execute(async (trx) => {
      const original = await trx
        .selectFrom('workflow_definitions')
        .selectAll()
        .where('id', '=', first.id)
        .executeTakeFirstOrThrow()
      const revision = await trx
        .selectFrom('workflow_revisions')
        .selectAll()
        .where('workflow_id', '=', first.id)
        .executeTakeFirstOrThrow()
      const copy = await trx
        .insertInto('workflow_definitions')
        .values({
          organization_id: original.organization_id,
          owner_user_id: original.owner_user_id,
          enabled: true,
          created_at: sql`(SELECT created_at FROM workflow_definitions WHERE id=${first.id})`,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('workflow_revisions')
        .values({
          organization_id: original.organization_id,
          workflow_id: copy.id,
          revision: 1,
          definition: JSON.stringify(revision.definition),
        })
        .execute()
      return copy
    })
    const id = await booking(user, eventTypeId)
    await db
      .insertInto('booking_attendees')
      .values({
        booking_id: id,
        name: 'Same address',
        email: 'BOOKER@example.com',
        is_booker: false,
        time_zone: 'UTC',
      })
      .execute()
    await capture(id)
    const saved = await db
      .selectFrom('workflow_recipient_claims as c')
      .innerJoin('workflow_runs as r', 'r.id', 'c.run_id')
      .innerJoin('workflow_enrollments as e', 'e.id', 'r.enrollment_id')
      .select(['e.workflow_id', 'c.state', 'c.skip_reason'])
      .where('c.booking_id', '=', id)
      .orderBy('e.workflow_id')
      .execute()
    expect(saved).toEqual([
      { workflow_id: [first.id, second.id].sort()[0], state: 'pending', skip_reason: null },
      {
        workflow_id: [first.id, second.id].sort()[1],
        state: 'skipped',
        skip_reason: 'existing_notification',
      },
    ])
  })

  it('preserves microsecond creation precedence ahead of the ID tie-breaker', async () => {
    const { user, eventTypeId } = await setup()
    const first = await define(user, {
      trigger: { type: 'before_start', offsetMinutes: 120 },
      actions: [{ type: 'email', recipients: ['booker', 'guests'] }],
    })
    const second = await db.transaction().execute(async (trx) => {
      const original = await trx
        .selectFrom('workflow_definitions')
        .selectAll()
        .where('id', '=', first.id)
        .executeTakeFirstOrThrow()
      const revision = await trx
        .selectFrom('workflow_revisions')
        .selectAll()
        .where('workflow_id', '=', first.id)
        .executeTakeFirstOrThrow()
      const copy = await trx
        .insertInto('workflow_definitions')
        .values({
          organization_id: original.organization_id,
          owner_user_id: original.owner_user_id,
          enabled: true,
          created_at: sql`(SELECT created_at - interval '1 microsecond' FROM workflow_definitions WHERE id=${first.id})`,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('workflow_revisions')
        .values({
          organization_id: original.organization_id,
          workflow_id: copy.id,
          revision: 1,
          definition: JSON.stringify(revision.definition),
        })
        .execute()
      return copy
    })
    const id = await booking(user, eventTypeId)
    await db
      .insertInto('booking_attendees')
      .values({
        booking_id: id,
        name: 'Same address',
        email: 'BOOKER@example.com',
        is_booker: false,
        time_zone: 'UTC',
      })
      .execute()
    await capture(id)
    const saved = await db
      .selectFrom('workflow_recipient_claims as c')
      .innerJoin('workflow_runs as r', 'r.id', 'c.run_id')
      .innerJoin('workflow_enrollments as e', 'e.id', 'r.enrollment_id')
      .select(['e.workflow_id', 'c.state', 'c.skip_reason'])
      .where('c.booking_id', '=', id)
      .orderBy('e.workflow_id')
      .execute()
    expect(saved).toEqual([
      { workflow_id: first.id, state: 'skipped', skip_reason: 'existing_notification' },
      {
        workflow_id: second.id,
        state: 'pending',
        skip_reason: null,
      },
    ])
  })

  async function publicSetup() {
    const { user, eventTypeId } = await setup()
    const handle = `capture-${randomUUID().slice(0, 8)}`
    await db.insertInto('profiles').values({ user_id: user.id, handle, time_zone: 'UTC' }).execute()
    await createFixtures(db).schedule(user.id, { timeZone: 'UTC' })
    await db
      .updateTable('event_types')
      .set({ slug: 'capture' })
      .where('id', '=', eventTypeId)
      .execute()
    await define(user)
    const publicNow = Temporal.Now.instant()
    let day = publicNow.toZonedDateTimeISO('UTC').toPlainDate().add({ days: 3 })
    while (day.dayOfWeek > 5) day = day.add({ days: 1 })
    const publicStart = day.toZonedDateTime({ timeZone: 'UTC', plainTime: '12:00' }).toInstant()
    const notify: BookingNotifier = (trx, event, now) =>
      captureCreatedWorkflows(trx, event, now, secret)
    return {
      user,
      eventTypeId,
      ctx: { db, now: () => publicNow, notify, paidBookingsEnabled: true },
      input: {
        handle,
        slug: 'capture',
        start: publicStart,
        idempotencyKey: randomUUID(),
        invitee: { name: 'Booker', email: 'paid@example.com', timeZone: 'UTC' },
      },
    }
  }
  it('keeps production capture hard-off with live enabled definitions', async () => {
    const { user, eventTypeId } = await setup()
    await define(user)
    const id = await booking(user, eventTypeId)
    await db
      .transaction()
      .execute((trx) =>
        captureWorkflowCreation(trx, { type: 'created', bookingId: id, start: START }, NOW, secret),
      )
    expect(await enrollments(id)).toEqual([])
    expect(await runs(id)).toEqual([])
    expect(await claims(id)).toEqual([])
  })
  it('captures native public creation through the transactional created notifier', async () => {
    const { ctx, input } = await publicSetup()
    const created = await createPublicBooking(ctx, input)
    expect(await runs(created.booking.id)).toHaveLength(1)
  })
  it('keeps a native group booking silent', async () => {
    const { ctx, input, eventTypeId } = await publicSetup()
    await db
      .updateTable('event_types')
      .set({ booking_mode: 'group', group_capacity: 3 })
      .where('id', '=', eventTypeId)
      .execute()
    const created = await createPublicBooking(ctx, input)
    expect(await enrollments(created.booking.id)).toEqual([])
    expect(await runs(created.booking.id)).toEqual([])
  })
  it('captures paid confirmation once and never captures its pending hold', async () => {
    const { ctx, input } = await publicSetup()
    const hold = await createPaymentHold(ctx, input)
    expect(await runs(hold.id)).toEqual([])
    await capture(hold.id)
    expect(await runs(hold.id)).toEqual([])
    await confirmPaymentHold(ctx, hold.id, 'pi_synthetic_capture')
    await confirmPaymentHold(ctx, hold.id, 'pi_synthetic_capture')
    expect(await enrollments(hold.id)).toHaveLength(1)
    expect(await runs(hold.id)).toHaveLength(1)
  })
  it.each(['release', 'expire'] as const)(
    'never captures a hold that is %s, even on late confirmation',
    async (kind) => {
      const { ctx, input, user, eventTypeId } = await publicSetup()
      const hold =
        kind === 'release'
          ? await createPaymentHold(ctx, input)
          : {
              id: await booking(user, eventTypeId, {
                start_at: input.start.toString(),
                end_at: input.start.add({ minutes: 30 }).toString(),
                status: 'pending_payment',
                payment_hold_expires_at: sql`clock_timestamp()`,
              }),
            }
      if (kind === 'release') await cancelPaymentHold(ctx, hold.id)
      else await expirePaymentHolds({ db })
      const result = await confirmPaymentHold(
        { ...ctx, now: () => NOW.add({ hours: 1 }) },
        hold.id,
        `pi_synthetic_late_${kind}`,
      )
      expect(result.outcome).toBe('refund_required')
      expect(await enrollments(hold.id)).toEqual([])
      expect(await runs(hold.id)).toEqual([])
    },
  )

  it.each(['disable', 'delete'] as const)(
    'captures nothing after concurrent %s wins, with capture waiting on its lock',
    async (kind) => {
      const { user, eventTypeId } = await setup()
      const workflow = await define(user)
      const id = await booking(user, eventTypeId)
      let entered!: () => void, release!: () => void
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      const ctx = {
        ...context(user),
        audit: {
          record: async () => {
            entered()
            await wait
          },
        },
      }
      const leading =
        kind === 'disable'
          ? updateWorkflowDefinition(ctx, workflow.id, { expectedRevision: 1, enabled: false })
          : deleteWorkflowDefinition(ctx, workflow.id, { expectedRevision: 1 })
      await ready
      const contender = capture(id)
      try {
        let waiting = false
        for (let i = 0; i < 200; i++) {
          const result = await owned.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
          )
          if (result.rowCount) {
            waiting = true
            break
          }
          await setTimeout(10)
        }
        expect(waiting).toBe(true)
      } finally {
        release()
      }
      await leading
      await contender
      expect(await enrollments(id)).toEqual([])
      expect(await runs(id)).toEqual([])
    },
  )
  it.each(['coalescing', 'rollback'] as const)(
    'kills the %s source-copy mutation with a real assertion',
    async (protection) => {
      const source = new URL('./capture.ts', import.meta.url)
      const original = await readFile(source, 'utf8')
      const before =
        protection === 'coalescing'
          ? ".onConflict((oc) => oc.columns(['booking_id', 'occurrence', 'workflow_id']).doNothing())"
          : "if (!trx.isTransaction) throw new Error('Workflow capture needs the booking transaction')"
      expect(original).toContain(before)
      const changed = original.replace(
        before,
        protection === 'coalescing' ? '' : 'trx = globalThis.__workflowRollbackMutationDb',
      )
      const executable = stripTypeScriptTypes(changed).replace(
        /from '([^']+)'/g,
        (_, specifier: string) => {
          if (specifier.startsWith('node:')) return `from '${specifier}'`
          return `from '${specifier.startsWith('.') ? new URL(specifier, source).href : pathToFileURL(createRequire(source).resolve(specifier)).href}'`
        },
      )
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-capture-mutation-'))
      try {
        const copy = pathToFileURL(join(directory, 'mutation.mjs'))
        await writeFile(copy, executable, { mode: 0o600 })
        const mutated = (await import(/* @vite-ignore */ copy.href))
          .captureCreatedWorkflows as typeof captureCreatedWorkflows
        Object.assign(globalThis, { __workflowRollbackMutationDb: db })
        const check = async (operation: typeof captureCreatedWorkflows) => {
          const { user, eventTypeId } = await setup()
          await define(user)
          const id = await booking(user, eventTypeId)
          const invoke = (trx: Db) =>
            operation(trx, { type: 'created', bookingId: id, start: START }, NOW, secret)
          if (protection === 'coalescing') {
            await db.transaction().execute(invoke)
            await expect(db.transaction().execute(invoke)).resolves.toBeUndefined()
            expect(await runs(id)).toHaveLength(1)
          } else {
            await expect(
              db.transaction().execute(async (trx) => {
                await invoke(trx)
                throw new Error('abort capture transaction')
              }),
            ).rejects.toThrow('abort capture transaction')
            expect(await runs(id)).toEqual([])
            expect(await enrollments(id)).toEqual([])
          }
        }
        await check(captureCreatedWorkflows)
        await expect(check(mutated)).rejects.toMatchObject({ name: 'AssertionError' })
      } finally {
        Reflect.deleteProperty(globalThis, '__workflowRollbackMutationDb')
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
