import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createEventType } from '@hourmere/scheduling'
import {
  createTestTeam,
  createTestUser,
  type TestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createWorkflowDefinition } from './creates.ts'
import { updateWorkflow, updateWorkflowDefinition, type WorkflowUpdateContext } from './updates.ts'

const serverUrl = process.env.DATABASE_URL
const input = (user: TestUser, extra: Record<string, unknown> = {}) => ({
  owner: { kind: 'personal', id: user.id },
  idempotencyKey: randomUUID(),
  name: 'Prepare',
  scope: { type: 'all_event_types' },
  trigger: { type: 'booking.created' },
  actions: [{ type: 'email', recipients: ['booker'] }],
  ...extra,
})
describe('workflow update hard-off', () => {
  it('refuses before reading context or input', async () => {
    const ctx = new Proxy(
      {},
      {
        get() {
          throw new Error('context read')
        },
      },
    ) as WorkflowUpdateContext
    await expect(updateWorkflow(ctx, 'invalid', null)).rejects.toMatchObject({
      code: 'workflows_disabled',
    })
  })
})
describe.skipIf(!serverUrl)('workflow updates', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'workflow_update' })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  const context = (user: TestUser): WorkflowUpdateContext => ({ db, principal: user.principal })
  it('appends immutable revisions, rejects stale edits, and emits transactional update and toggle events', async () => {
    const user = await createTestUser(db),
      ctx = context(user)
    const first = await createWorkflowDefinition(
      ctx,
      input(user, {
        enabled: true,
        conditions: [{ field: 'booking_source', operator: 'equals', value: 'web' }],
      }),
    )
    const audit = { record: vi.fn(async () => {}) }
    const edited = await updateWorkflowDefinition({ ...ctx, audit }, first.id, {
      expectedRevision: 1,
      name: ' Edited ',
    })
    expect(edited).toMatchObject({
      name: 'Edited',
      revision: 2,
      enabled: true,
      conditions: first.conditions,
    })
    expect(
      audit.record.mock.calls.map(
        (call) => (call as unknown as [unknown, { event: string }])[1].event,
      ),
    ).toEqual(['workflow.updated'])
    await expect(
      updateWorkflowDefinition(ctx, first.id, { expectedRevision: 1, name: 'Stale' }),
    ).rejects.toMatchObject({ code: 'workflow_revision_conflict' })
    const revisions = await db
      .selectFrom('workflow_revisions')
      .select(['revision', 'definition'])
      .where('workflow_id', '=', first.id)
      .orderBy('revision')
      .execute()
    expect(revisions).toHaveLength(2)
    expect(revisions[0]?.definition).toMatchObject({ name: 'Prepare' })
    expect(revisions[1]?.definition).toMatchObject({ name: 'Edited' })
    await expect(
      updateWorkflowDefinition(
        {
          ...ctx,
          audit: {
            record: async () => {
              throw new Error('audit unavailable')
            },
          },
        },
        first.id,
        { expectedRevision: 2, name: 'Rollback' },
      ),
    ).rejects.toThrow('audit unavailable')
    expect(
      await db
        .selectFrom('workflow_revisions')
        .select('revision')
        .where('workflow_id', '=', first.id)
        .execute(),
    ).toHaveLength(2)
  })
  it('changes only the definition row on toggles and never rewrites captured execution or enrollment rows on edits', async () => {
    const user = await createTestUser(db),
      ctx = context(user),
      org = user.principal.organization.id
    const first = await createWorkflowDefinition(ctx, input(user, { enabled: true }))
    const booking = await db
      .insertInto('bookings')
      .values({
        organization_id: org,
        start_at: new Date('2030-01-01T12:00Z'),
        end_at: new Date('2030-01-01T12:30Z'),
        title: 'Call',
        source: 'web',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const enrollment = await db
      .insertInto('workflow_enrollments')
      .values({
        organization_id: org,
        workflow_id: first.id,
        revision: 1,
        booking_id: booking.id,
        occurrence: 'created',
        trigger: 'booking.created',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('workflow_runs')
      .values({
        organization_id: org,
        enrollment_id: enrollment.id,
        booking_id: booking.id,
        due_at: new Date('2030-01-01T11:00Z'),
        expires_at: new Date('2030-01-01T12:00Z'),
      })
      .execute()
    const snapshot = () =>
      Promise.all(
        (
          [
            'workflow_enrollments',
            'workflow_runs',
            'workflow_recipient_claims',
            'workflow_run_history',
            'workflow_mail_reservations',
            'workflow_revisions',
          ] as const
        ).map((table) =>
          db.selectFrom(table).selectAll().where('organization_id', '=', org).execute(),
        ),
      )
    const before = await snapshot()
    const audit = {
      record: vi.fn<import('./audit.ts').WorkflowAuditPort['record']>(async () => {}),
    }
    for (const enabled of [false, true]) {
      expect(
        await updateWorkflowDefinition({ ...ctx, audit }, first.id, {
          expectedRevision: 1,
          enabled,
        }),
      ).toMatchObject({ enabled, revision: 1 })
      expect(await snapshot()).toEqual(before)
    }
    expect(audit.record.mock.calls.map((call) => call[1].event)).toEqual([
      'workflow.disabled',
      'workflow.enabled',
    ])
    await updateWorkflowDefinition(ctx, first.id, {
      expectedRevision: 1,
      trigger: { type: 'before_start', offsetMinutes: 30 },
    })
    expect((await snapshot()).slice(0, -1)).toEqual(before.slice(0, -1))
  })
  it('conceals foreign identities and team-context mismatches and rechecks team roles', async () => {
    const owner = await createTestUser(db),
      admin = await createTestUser(db),
      member = await createTestUser(db),
      foreign = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const first = await createWorkflowDefinition(
      { db, principal: team.as(owner) },
      input(owner, { owner: { kind: 'team', id: team.id } }),
    )
    for (const principal of [owner.principal, foreign.principal, team.as(member), team.as(foreign)])
      await expect(
        updateWorkflowDefinition({ db, principal }, first.id, {
          expectedRevision: 1,
          enabled: true,
        }),
      ).rejects.toMatchObject({ code: 'workflow_not_found' })
    expect(
      (
        await updateWorkflowDefinition({ db, principal: team.as(admin) }, first.id, {
          expectedRevision: 1,
          name: 'Admin edit',
        })
      ).revision,
    ).toBe(2)
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', admin.id)
      .execute()
    await expect(
      updateWorkflowDefinition({ db, principal: team.as(admin) }, first.id, {
        expectedRevision: 2,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'workflow_not_found' })
    await db
      .updateTable('workflow_definitions')
      .set({ deleted_at: new Date() })
      .where('id', '=', first.id)
      .execute()
    await expect(
      updateWorkflowDefinition({ db, principal: team.as(owner) }, first.id, {
        expectedRevision: 2,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'workflow_not_found' })
  })
  it('can disable an event-scoped definition after the event is deleted, but cannot re-enable it', async () => {
    const user = await createTestUser(db),
      ctx = context(user)
    const event = await createEventType(testContext(db, user.principal), {
      title: 'Call',
      slug: 'call',
      durationMinutes: 30,
    })
    const first = await createWorkflowDefinition(
      ctx,
      input(user, { enabled: true, scope: { type: 'event_type', eventTypeId: event.id } }),
    )
    await db
      .updateTable('event_types')
      .set({ deleted_at: new Date() })
      .where('id', '=', event.id)
      .execute()
    expect(
      await updateWorkflowDefinition(ctx, first.id, { expectedRevision: 1, enabled: false }),
    ).toMatchObject({ enabled: false, revision: 1 })
    await expect(
      updateWorkflowDefinition(ctx, first.id, { expectedRevision: 1, enabled: true }),
    ).rejects.toMatchObject({ code: 'invalid_workflow' })
  })
  it('requires full scope and rejects owner/identity changes, unknown fields and webhook actions', async () => {
    const user = await createTestUser(db),
      ctx = context(user)
    const first = await createWorkflowDefinition(ctx, input(user))
    for (const apiKeyScope of ['read', 'bookings'] as const)
      await expect(
        updateWorkflowDefinition(
          {
            ...ctx,
            principal: { ...user.principal, kind: 'api_key', apiKeyId: randomUUID(), apiKeyScope },
          },
          first.id,
          { expectedRevision: 1, enabled: true },
        ),
      ).rejects.toMatchObject({ error: 'insufficient_scope' })
    for (const patch of [
      { id: randomUUID() },
      { owner: { kind: 'personal', id: user.id } },
      { extra: true },
      { actions: [{ type: 'webhook', webhookId: randomUUID() }] },
    ])
      await expect(
        updateWorkflowDefinition(ctx, first.id, { expectedRevision: 1, ...patch }),
      ).rejects.toMatchObject({ code: 'invalid_workflow' })
  })
  it.each(['exclusive', 'shared'])(
    'waits for a contender holding a %s owner lock before the combined cap admission',
    async (mode) => {
      const user = await createTestUser(db),
        ctx = context(user)
      const event = await createEventType(testContext(db, user.principal), {
        title: 'Call',
        slug: 'call',
        durationMinutes: 30,
      })
      for (let i = 0; i < 4; i++)
        await createWorkflowDefinition(ctx, input(user, { enabled: true }))
      const draft = await createWorkflowDefinition(
        ctx,
        input(user, { scope: { type: 'event_type', eventTypeId: event.id } }),
      )
      const contender = await owned.pool.connect()
      let writer: Promise<unknown> | undefined
      try {
        await contender.query('BEGIN')
        await contender.query('SELECT id FROM auth.organization WHERE id=$1 FOR KEY SHARE', [
          user.principal.organization.id,
        ])
        await contender.query(
          mode === 'shared'
            ? 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))'
            : 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`workflow-owner:${user.principal.organization.id}:${user.id}`],
        )
        let settled = false
        writer = updateWorkflowDefinition(ctx, draft.id, { expectedRevision: 1, enabled: true })
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          )
          .finally(() => {
            settled = true
          })
        // Poll until the service waits on the contested advisory lock or incorrectly completes.
        for (let i = 0; i < 200 && !settled; i++) {
          const { rows } = await owned.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'",
          )
          if (rows.length) break
          await setTimeout(10)
        }
        const inserted = await contender.query(
          'INSERT INTO workflow_definitions(organization_id,owner_user_id,enabled) VALUES($1,$2,true) RETURNING id',
          [user.principal.organization.id, user.id],
        )
        await contender.query(
          'INSERT INTO workflow_revisions(organization_id,workflow_id,revision,definition) VALUES($1,$2,1,$3)',
          [
            user.principal.organization.id,
            inserted.rows[0].id,
            JSON.stringify({
              name: 'Contender',
              scope: { type: 'all_event_types' },
              trigger: { type: 'booking.created', delayMinutes: 0 },
              conditions: [],
              actions: [{ type: 'email', recipients: ['booker'] }],
            }),
          ],
        )
        await contender.query('COMMIT')
        expect(await writer).toMatchObject({ error: { code: 'workflow_limit_reached' } })
        expect(settled).toBe(true)
        expect(
          await db
            .selectFrom('workflow_definitions')
            .select('id')
            .where('organization_id', '=', user.principal.organization.id)
            .where('enabled', '=', true)
            .execute(),
        ).toHaveLength(5)
      } finally {
        await contender.query('ROLLBACK')
        contender.release()
        await writer
      }
    },
  )
})
