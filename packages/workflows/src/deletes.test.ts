import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WorkflowAuditPort } from './audit.ts'
import { createWorkflowDefinition } from './creates.ts'
import { deleteWorkflow, deleteWorkflowDefinition, type WorkflowDeleteContext } from './deletes.ts'
import { updateWorkflowDefinition } from './updates.ts'

const serverUrl = process.env.DATABASE_URL
const input = (user: TestUser, extra: Record<string, unknown> = {}) => ({
  owner: { kind: 'personal', id: user.id },
  idempotencyKey: randomUUID(),
  name: 'Private preparation',
  scope: { type: 'all_event_types' },
  trigger: { type: 'before_start', offsetMinutes: 30 },
  actions: [{ type: 'email', recipients: ['booker'] }],
  enabled: true,
  ...extra,
})
const revision = { expectedRevision: 1 }
describe('workflow delete hard-off', () => {
  it('refuses before reading context or input', async () => {
    const ctx = new Proxy(
      {},
      {
        get() {
          throw new Error('context read')
        },
      },
    ) as WorkflowDeleteContext
    await expect(deleteWorkflow(ctx, 'invalid', null)).rejects.toMatchObject({
      code: 'workflows_disabled',
    })
  })
})
describe.skipIf(!serverUrl)('workflow deletion', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'workflow_delete' })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  const context = (user: TestUser): WorkflowDeleteContext => ({ db, principal: user.principal })
  const booking = async (org: string) =>
    db
      .insertInto('bookings')
      .values({
        organization_id: org,
        start_at: new Date('2030-01-01T12:00Z'),
        end_at: new Date('2030-01-01T12:30Z'),
        title: 'Private meeting',
        source: 'web',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  const fixture = async (org: string, workflow: string) => {
    const b = await booking(org)
    const e = await db
      .insertInto('workflow_enrollments')
      .values({
        organization_id: org,
        workflow_id: workflow,
        revision: 1,
        booking_id: b.id,
        occurrence: 'created',
        trigger: 'before_start',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return db
      .insertInto('workflow_runs')
      .values({
        organization_id: org,
        enrollment_id: e.id,
        booking_id: b.id,
        due_at: new Date('2030-01-01T11:30Z'),
        expires_at: new Date('2030-01-01T12:00Z'),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }
  const definition = (id: string) =>
    db.selectFrom('workflow_definitions').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  const runs = (org: string) =>
    db
      .selectFrom('workflow_runs')
      .selectAll()
      .where('organization_id', '=', org)
      .orderBy('id')
      .execute()
  it('tombstones before retiring all pending runs, preserves terminal and claimed rows, and safely replays one minimal audit event', async () => {
    const user = await createTestUser(db),
      ctx = context(user),
      org = user.principal.organization.id
    const first = await createWorkflowDefinition(ctx, input(user))
    const pending = await Promise.all([fixture(org, first.id), fixture(org, first.id)])
    const claimed = await fixture(org, first.id),
      completed = await fixture(org, first.id)
    await db
      .updateTable('workflow_runs')
      .set({
        state: 'claimed',
        claim_token: randomUUID(),
        lease_until: new Date('2030-01-01T12:00Z'),
      })
      .where('id', '=', claimed.id)
      .execute()
    await db
      .updateTable('workflow_runs')
      .set({ state: 'completed', finished_at: new Date() })
      .where('id', '=', completed.id)
      .execute()
    const before = await runs(org)
    const audit = {
      record: vi.fn<WorkflowAuditPort['record']>(async (trx, record) => {
        expect(record).toMatchObject({
          event: 'workflow.deleted',
          workflowId: first.id,
          revision: 1,
        })
        expect(Object.keys(record).sort()).toEqual([
          'actor',
          'event',
          'occurredAt',
          'owner',
          'revision',
          'workflowId',
        ])
        expect(
          await trx
            .selectFrom('workflow_definitions')
            .select('deleted_at')
            .where('id', '=', first.id)
            .executeTakeFirstOrThrow(),
        ).toMatchObject({ deleted_at: expect.any(Date) })
        expect(
          await trx
            .selectFrom('workflow_runs')
            .select('id')
            .where('organization_id', '=', org)
            .where('state', '=', 'pending')
            .execute(),
        ).toEqual([])
      }),
    }
    await deleteWorkflowDefinition({ ...ctx, audit }, first.id, revision)
    expect(await definition(first.id)).toMatchObject({
      enabled: false,
      deleted_at: expect.any(Date),
      revision: 1,
    })
    const after = await runs(org)
    for (const run of pending) {
      expect(after.find((r) => r.id === run.id)).toMatchObject({
        state: 'retired',
        finished_at: expect.any(Date),
        claim_token: null,
        lease_until: null,
      })
      await expect(
        db
          .updateTable('workflow_runs')
          .set({ state: 'pending', finished_at: null })
          .where('id', '=', run.id)
          .execute(),
      ).rejects.toMatchObject({ constraint: 'workflow_runs_final' })
    }
    for (const run of [claimed, completed])
      expect(after.find((r) => r.id === run.id)).toEqual(before.find((r) => r.id === run.id))
    const tombstone = await definition(first.id)
    await deleteWorkflowDefinition({ ...ctx, audit }, first.id, revision)
    expect(audit.record).toHaveBeenCalledTimes(1)
    expect(await definition(first.id)).toEqual(tombstone)
    expect(await runs(org)).toEqual(after)
    await expect(
      db.deleteFrom('workflow_definitions').where('id', '=', first.id).execute(),
    ).rejects.toMatchObject({ constraint: 'workflow_definitions_unfinished_runs' })
  })
  it('rolls back the tombstone and run retirement if the injected audit fails', async () => {
    const user = await createTestUser(db),
      ctx = context(user),
      org = user.principal.organization.id
    const first = await createWorkflowDefinition(ctx, input(user))
    await fixture(org, first.id)
    const before = await definition(first.id),
      runBefore = await runs(org)
    await expect(
      deleteWorkflowDefinition(
        {
          ...ctx,
          audit: {
            record: async () => {
              throw new Error('audit unavailable')
            },
          },
        },
        first.id,
        revision,
      ),
    ).rejects.toThrow('audit unavailable')
    expect(await definition(first.id)).toEqual(before)
    expect(await runs(org)).toEqual(runBefore)
  })
  it('retains creation keys and minimal history with the tombstone; history and definition purges retain terminal execution identity', async () => {
    const user = await createTestUser(db),
      ctx = context(user),
      org = user.principal.organization.id
    const request = input(user),
      first = await createWorkflowDefinition(ctx, request)
    const run = await fixture(org, first.id)
    await db
      .updateTable('workflow_runs')
      .set({ state: 'completed', finished_at: new Date() })
      .where('id', '=', run.id)
      .execute()
    await db
      .insertInto('workflow_run_history')
      .values({
        run_id: run.id,
        organization_id: org,
        workflow_id: first.id,
        revision: 1,
        trigger: 'before_start',
        due_at: run.due_at,
        finished_at: new Date(),
        outcome: 'completed',
      })
      .execute()
    const history = await db
      .selectFrom('workflow_run_history')
      .selectAll()
      .where('workflow_id', '=', first.id)
      .execute()
    const keys = await db
      .selectFrom('workflow_creation_keys')
      .selectAll()
      .where('workflow_id', '=', first.id)
      .execute()
    await deleteWorkflowDefinition(ctx, first.id, revision)
    expect(
      await db
        .selectFrom('workflow_creation_keys')
        .selectAll()
        .where('workflow_id', '=', first.id)
        .execute(),
    ).toEqual(keys)
    expect(await createWorkflowDefinition(ctx, request)).toMatchObject({
      id: first.id,
      enabled: false,
    })
    await expect(
      createWorkflowDefinition(ctx, { ...request, name: 'Different' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    expect(
      await db
        .selectFrom('workflow_run_history')
        .selectAll()
        .where('workflow_id', '=', first.id)
        .execute(),
    ).toEqual(history)
    expect(Object.keys(history[0] ?? {}).sort()).toEqual([
      'delivery_unknown',
      'due_at',
      'finished_at',
      'organization_id',
      'outcome',
      'reason',
      'rejected',
      'revision',
      'run_id',
      'sent',
      'skipped',
      'trigger',
      'workflow_id',
    ])
    const identities = await runs(org)
    await db.deleteFrom('workflow_run_history').where('workflow_id', '=', first.id).execute()
    expect(await runs(org)).toEqual(identities)
    await db.deleteFrom('workflow_definitions').where('id', '=', first.id).execute()
    expect(await runs(org)).toEqual(identities)
    expect(
      await db
        .selectFrom('workflow_enrollments')
        .select('id')
        .where('id', '=', run.enrollment_id)
        .execute(),
    ).toHaveLength(1)
    expect(
      await db
        .selectFrom('workflow_creation_keys')
        .selectAll()
        .where('workflow_id', '=', first.id)
        .execute(),
    ).toEqual([])
    await expect(fixture(org, first.id)).rejects.toMatchObject({
      constraint: 'workflow_enrollments_live_workflow',
    })
  })
  it('conceals foreign and mismatched team contexts, and checks current role even on tombstone replay', async () => {
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
        deleteWorkflowDefinition({ db, principal }, first.id, revision),
      ).rejects.toMatchObject({ code: 'workflow_not_found' })
    await deleteWorkflowDefinition({ db, principal: team.as(admin) }, first.id, revision)
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', admin.id)
      .execute()
    await expect(
      deleteWorkflowDefinition({ db, principal: team.as(admin) }, first.id, revision),
    ).rejects.toMatchObject({ code: 'workflow_not_found' })
    await deleteWorkflowDefinition({ db, principal: team.as(owner) }, first.id, revision)
    for (const id of [randomUUID(), 'invalid', first.id])
      await expect(
        deleteWorkflowDefinition({ db, principal: foreign.principal }, id, revision),
      ).rejects.toMatchObject({ code: 'workflow_not_found' })
  })
  it('requires full scope and a strict positive expected revision, including on replay', async () => {
    const user = await createTestUser(db),
      ctx = context(user),
      first = await createWorkflowDefinition(ctx, input(user))
    for (const apiKeyScope of ['read', 'bookings'] as const)
      await expect(
        deleteWorkflowDefinition(
          {
            ...ctx,
            principal: { ...user.principal, kind: 'api_key', apiKeyId: randomUUID(), apiKeyScope },
          },
          first.id,
          revision,
        ),
      ).rejects.toMatchObject({ error: 'insufficient_scope' })
    for (const value of [
      null,
      {},
      { expectedRevision: 0 },
      { expectedRevision: 1.5 },
      { expectedRevision: 1, extra: true },
    ])
      await expect(deleteWorkflowDefinition(ctx, first.id, value)).rejects.toMatchObject({
        code: 'invalid_workflow',
      })
    await expect(
      deleteWorkflowDefinition(ctx, first.id, { expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: 'workflow_revision_conflict' })
    await deleteWorkflowDefinition(ctx, first.id, revision)
    await expect(
      deleteWorkflowDefinition(ctx, first.id, { expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: 'workflow_revision_conflict' })
  })
  // The audit port pauses a real transaction after its writes, so the other writer must
  // wait for the first commit. No dispatcher or reschedule service exists in this stage.
  const pauseAudit = () => {
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const audit: WorkflowAuditPort = {
      record: async () => {
        entered()
        await wait
      },
    }
    return { audit, ready, release }
  }
  const waitForLock = async () => {
    for (let i = 0; i < 200; i++) {
      const result = await owned.pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
      )
      if (result.rowCount) return
      await setTimeout(10)
    }
    throw new Error('Contender did not wait on a database lock')
  }
  it.each(['edit', 'enable'] as const)(
    'serializes deletion after %s and rejects stale revisions',
    async (kind) => {
      const user = await createTestUser(db),
        ctx = context(user),
        first = await createWorkflowDefinition(ctx, input(user, { enabled: false }))
      const gate = pauseAudit()
      const update = updateWorkflowDefinition({ ...ctx, audit: gate.audit }, first.id, {
        ...revision,
        ...(kind === 'edit' ? { name: 'Changed' } : { enabled: true }),
      })
      await gate.ready
      const deletion = deleteWorkflowDefinition(ctx, first.id, revision).then(
        () => null,
        (e) => e,
      )
      try {
        await waitForLock()
      } finally {
        gate.release()
      }
      await update
      if (kind === 'edit') {
        expect(await deletion).toMatchObject({ code: 'workflow_revision_conflict' })
        expect((await definition(first.id)).deleted_at).toBeNull()
        await deleteWorkflowDefinition(ctx, first.id, { expectedRevision: 2 })
      } else expect(await deletion).toBeNull()
      expect((await definition(first.id)).deleted_at).toBeInstanceOf(Date)
    },
  )
  it.each(['edit', 'enable'] as const)('rejects %s after deletion wins the lock', async (kind) => {
    const user = await createTestUser(db),
      ctx = context(user),
      first = await createWorkflowDefinition(ctx, input(user, { enabled: false }))
    const gate = pauseAudit(),
      deletion = deleteWorkflowDefinition({ ...ctx, audit: gate.audit }, first.id, revision)
    await gate.ready
    const update = updateWorkflowDefinition(ctx, first.id, {
      ...revision,
      ...(kind === 'edit' ? { name: 'Changed' } : { enabled: true }),
    }).then(
      () => null,
      (e) => e,
    )
    try {
      await waitForLock()
    } finally {
      gate.release()
    }
    await deletion
    expect(await update).toMatchObject({ code: 'workflow_not_found' })
  })
  it.each(['carry', 'delete'] as const)(
    'serializes a timer carry with %s committing first without deadlock',
    async (firstWriter) => {
      const user = await createTestUser(db),
        ctx = context(user),
        org = user.principal.organization.id
      const first = await createWorkflowDefinition(ctx, input(user)),
        original = await fixture(org, first.id),
        successor = await booking(org)
      const carry = async () =>
        db.transaction().execute(async (trx) => {
          await trx
            .selectFrom('auth.organization')
            .select('id')
            .where('id', '=', org)
            .forKeyShare()
            .execute()
          await trx
            .updateTable('workflow_runs')
            .set({ state: 'retired', finished_at: new Date() })
            .where('id', '=', original.id)
            .where('state', '=', 'pending')
            .execute()
          const e = await trx
            .insertInto('workflow_enrollments')
            .values({
              organization_id: org,
              booking_id: successor.id,
              workflow_id: first.id,
              revision: 1,
              occurrence: 'created',
              trigger: 'before_start',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
          await trx
            .insertInto('workflow_runs')
            .values({
              organization_id: org,
              booking_id: successor.id,
              enrollment_id: e.id,
              due_at: original.due_at,
              expires_at: original.expires_at,
            })
            .execute()
          await gate.audit.record(trx, {} as never)
        })
      const gate = pauseAudit()
      const leading =
        firstWriter === 'carry'
          ? carry()
          : deleteWorkflowDefinition({ ...ctx, audit: gate.audit }, first.id, revision)
      await gate.ready
      const following = (
        firstWriter === 'carry' ? deleteWorkflowDefinition(ctx, first.id, revision) : carry()
      ).then(
        () => null,
        (e) => e,
      )
      try {
        await waitForLock()
      } finally {
        gate.release()
      }
      await leading
      if (firstWriter === 'carry') expect(await following).toBeNull()
      else
        expect(await following).toMatchObject({ constraint: 'workflow_enrollments_live_workflow' })
      const result = await runs(org)
      expect(result).toHaveLength(firstWriter === 'carry' ? 2 : 1)
      expect(result.every((run) => run.state === 'retired')).toBe(true)
    },
  )
  it.each(['claim', 'delete'] as const)(
    'serializes a storage claim with %s first and never reclaims a retired run',
    async (firstWriter) => {
      const user = await createTestUser(db),
        ctx = context(user),
        org = user.principal.organization.id
      const first = await createWorkflowDefinition(ctx, input(user)),
        run = await fixture(org, first.id),
        gate = pauseAudit()
      const claim = () =>
        db.transaction().execute(async (trx) => {
          await trx
            .selectFrom('auth.organization')
            .select('id')
            .where('id', '=', org)
            .forKeyShare()
            .execute()
          const claimed = await trx
            .updateTable('workflow_runs')
            .set({
              state: 'claimed',
              claim_token: randomUUID(),
              lease_until: new Date('2030-01-01T12:00Z'),
            })
            .where('id', '=', run.id)
            .where('state', '=', 'pending')
            .returning('id')
            .execute()
          if (firstWriter === 'claim') await gate.audit.record(trx, {} as never)
          return claimed
        })
      const leading =
        firstWriter === 'claim'
          ? claim()
          : deleteWorkflowDefinition({ ...ctx, audit: gate.audit }, first.id, revision)
      await gate.ready
      const following =
        firstWriter === 'claim' ? deleteWorkflowDefinition(ctx, first.id, revision) : claim()
      try {
        await waitForLock()
      } finally {
        gate.release()
      }
      await leading
      const result = await following
      if (firstWriter === 'delete') expect(result).toEqual([])
      expect((await runs(org))[0]?.state).toBe(firstWriter === 'claim' ? 'claimed' : 'retired')
    },
  )
})
