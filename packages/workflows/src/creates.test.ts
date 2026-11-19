import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import type { Principal } from '@hourmere/auth'
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
import { createWorkflow, createWorkflowDefinition, type WorkflowCreateContext } from './creates.ts'

const serverUrl = process.env.DATABASE_URL
const input = (user: TestUser, overrides: Record<string, unknown> = {}) => ({
  owner: { kind: 'personal', id: user.id },
  idempotencyKey: randomUUID(),
  name: 'Prepare',
  scope: { type: 'all_event_types' },
  trigger: { type: 'booking.created' },
  actions: [{ type: 'email', recipients: ['booker'] }],
  ...overrides,
})

describe('workflow creation hard-off', () => {
  it('refuses before inspecting the context or input', async () => {
    const ctx = new Proxy(
      {},
      {
        get() {
          throw new Error('context was read')
        },
      },
    ) as WorkflowCreateContext
    await expect(createWorkflow(ctx, null)).rejects.toMatchObject({ code: 'workflows_disabled' })
  })
})

describe.skipIf(!serverUrl)('workflow creation', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'workflow_create' })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  const context = (user: TestUser): WorkflowCreateContext => ({ db, principal: user.principal })

  it('creates a server UUIDv7, normalizes input, replays once and audits only the creation', async () => {
    const user = await createTestUser(db)
    const audit = {
      record: vi.fn<import('./audit.ts').WorkflowAuditPort['record']>(async () => {}),
    }
    const ctx = { ...context(user), audit }
    const request = input(user, {
      name: ' Prepare ',
      actions: [
        {
          type: 'email',
          recipients: ['hosts', 'booker'],
          content: { en: { subject: ' Hi ', body: ' Hello\r\nthere ' } },
        },
      ],
    })
    const first = await createWorkflowDefinition(ctx, request)
    expect(first.id[14]).toBe('7')
    expect(first).toMatchObject({ name: 'Prepare', enabled: false, revision: 1 })
    expect(audit.record).toHaveBeenCalledTimes(1)
    expect(audit.record.mock.calls[0]?.[1]).toMatchObject({
      event: 'workflow.created',
      workflowId: first.id,
      revision: 1,
    })
    const replay = await createWorkflowDefinition(ctx, {
      ...request,
      name: 'Prepare',
      enabled: false,
      conditions: [],
      trigger: { type: 'booking.created', delayMinutes: 0 },
      actions: [
        {
          type: 'email',
          recipients: ['booker', 'hosts'],
          content: { en: { body: 'Hello\nthere', subject: 'Hi' } },
        },
      ],
    })
    expect(replay).toEqual(first)
    expect(audit.record).toHaveBeenCalledTimes(1)
    expect(
      await db
        .selectFrom('workflow_definitions')
        .select('id')
        .where('organization_id', '=', user.principal.organization.id)
        .execute(),
    ).toHaveLength(1)
    await expect(
      createWorkflowDefinition(ctx, { ...request, name: 'Changed' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
  })

  it('enforces host text policy for every recipient on create and replay without writes', async () => {
    const user = await createTestUser(db)
    for (const recipient of ['booker', 'guests', 'hosts']) {
      const request = input(user, {
        actions: [
          {
            type: 'email',
            recipients: [recipient],
            content: { en: { subject: 'Hello', body: 'Body' } },
          },
        ],
      })
      const off = { ...context(user), followUpHostNotesEnabled: false }
      await expect(createWorkflowDefinition(off, request)).rejects.toMatchObject({
        code: 'invalid_workflow',
      })
      const created = await createWorkflowDefinition(
        { ...context(user), followUpHostNotesEnabled: true },
        request,
      )
      await expect(createWorkflowDefinition(off, request)).rejects.toMatchObject({
        code: 'invalid_workflow',
      })
      expect(created.actions).toEqual(request.actions)
      for (const followUpHostNotesEnabled of [true, false])
        await expect(
          createWorkflowDefinition(
            { ...context(user), followUpHostNotesEnabled },
            input(user, { actions: [{ type: 'email', recipients: [recipient] }] }),
          ),
        ).resolves.toHaveProperty('id')
    }
    expect(
      await db
        .selectFrom('workflow_definitions')
        .select('id')
        .where('organization_id', '=', user.principal.organization.id)
        .execute(),
    ).toHaveLength(9)
  })

  it('retains replay across event deletion and tombstones without validating live references', async () => {
    const user = await createTestUser(db),
      ctx = context(user)
    const event = await createEventType(testContext(db, user.principal), {
      title: 'Call',
      slug: 'call',
      durationMinutes: 30,
    })
    const request = input(user, { scope: { type: 'event_type', eventTypeId: event.id } })
    const first = await createWorkflowDefinition(ctx, request)
    await db
      .updateTable('event_types')
      .set({ deleted_at: new Date() })
      .where('id', '=', event.id)
      .execute()
    await db
      .updateTable('workflow_definitions')
      .set({ deleted_at: new Date(), enabled: false })
      .where('id', '=', first.id)
      .execute()
    expect((await createWorkflowDefinition(ctx, request)).id).toBe(first.id)
    await expect(
      createWorkflowDefinition(ctx, { ...request, name: 'Changed' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
  })

  it('rejects IDs, unknown fields, webhook actions and non-full scopes', async () => {
    const user = await createTestUser(db),
      ctx = context(user)
    for (const extra of [
      { id: randomUUID() },
      { extra: true },
      { actions: [{ type: 'webhook', webhookId: randomUUID() }] },
    ])
      await expect(createWorkflowDefinition(ctx, input(user, extra))).rejects.toMatchObject({
        code: 'invalid_workflow',
      })
    for (const apiKeyScope of ['read', 'bookings'] as const)
      await expect(
        createWorkflowDefinition(
          {
            ...ctx,
            principal: { ...user.principal, kind: 'api_key', apiKeyId: randomUUID(), apiKeyScope },
          },
          input(user),
        ),
      ).rejects.toMatchObject({ error: 'insufficient_scope' })
  })

  it('accepts only current team owners/admins and conceals foreign/context mismatches', async () => {
    const owner = await createTestUser(db),
      admin = await createTestUser(db),
      member = await createTestUser(db),
      foreign = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const request = input(owner, { owner: { kind: 'team', id: team.id } })
    for (const user of [owner, admin])
      expect(
        (
          await createWorkflowDefinition(
            { db, principal: team.as(user) },
            { ...request, idempotencyKey: randomUUID() },
          )
        ).owner,
      ).toEqual(request.owner)
    for (const [principal, candidate] of [
      [team.as(member), request],
      [team.as(foreign), request],
      [owner.principal, request],
      [team.as(owner), input(owner)],
      [owner.principal, input(foreign)],
      [owner.principal, input(owner, { owner: { kind: 'team', id: randomUUID() } })],
    ] as const)
      await expect(createWorkflowDefinition({ db, principal }, candidate)).rejects.toMatchObject({
        code: 'workflow_not_found',
      })
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', admin.id)
      .execute()
    await expect(
      createWorkflowDefinition({ db, principal: team.as(admin) }, request),
    ).rejects.toMatchObject({ code: 'workflow_not_found' })
  })

  it('rejects replay by a demoted admin without writes or an audit event', async () => {
    const owner = await createTestUser(db),
      admin = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
    ])
    const audit = { record: vi.fn(async () => {}) }
    const ctx = { db, principal: team.as(admin), audit }
    const request = input(admin, { owner: { kind: 'team', id: team.id } })
    const created = await createWorkflowDefinition(ctx, request)
    expect(audit.record).toHaveBeenCalledTimes(1)
    const stored = () =>
      Promise.all(
        (['workflow_definitions', 'workflow_revisions', 'workflow_creation_keys'] as const).map(
          (table) =>
            db.selectFrom(table).selectAll().where('organization_id', '=', team.id).execute(),
        ),
      )
    const before = await stored()
    expect(before.map((rows) => rows.length)).toEqual([1, 1, 1])
    expect(before[0]?.[0]).toMatchObject({ id: created.id })
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', admin.id)
      .execute()
    audit.record.mockClear()

    // Reuse the exact principal, credential and key that created the retained definition.
    await expect(createWorkflowDefinition(ctx, request)).rejects.toMatchObject({
      kind: 'not_found',
      code: 'workflow_not_found',
    })
    expect(await stored()).toEqual(before)
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('scopes keys by actor, principal kind and credential, with sessions shared across sessions', async () => {
    const user = await createTestUser(db),
      request = input(user)
    const principals: Principal[] = [
      user.principal,
      { ...user.principal, kind: 'api_key', apiKeyScope: 'full', apiKeyId: randomUUID() },
      { ...user.principal, kind: 'session', sessionId: randomUUID() },
      {
        ...user.principal,
        kind: 'oauth',
        oauthConsentId: user.principal.kind === 'api_key' ? user.principal.apiKeyId : randomUUID(),
        clientId: 'client',
        scopes: ['mcp:tools'],
      },
    ]
    const ids = []
    for (const principal of principals)
      ids.push((await createWorkflowDefinition({ db, principal }, request)).id)
    expect(new Set(ids).size).toBe(4)
    expect(
      (
        await createWorkflowDefinition(
          { db, principal: { ...user.principal, kind: 'session', sessionId: randomUUID() } },
          request,
        )
      ).id,
    ).toBe(ids[2])
  })

  it('isolates team session keys by actor and returns the current revision on replay', async () => {
    const owner = await createTestUser(db),
      admin = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
    ])
    const request = input(owner, { owner: { kind: 'team', id: team.id } })
    const as = (user: TestUser): Principal => ({
      ...team.as(user),
      kind: 'session',
      sessionId: 'session',
    })
    const first = await createWorkflowDefinition({ db, principal: as(owner) }, request)
    const other = await createWorkflowDefinition({ db, principal: as(admin) }, request)
    expect(other.id).not.toBe(first.id)
    const {
      id: _,
      owner: __,
      enabled: ___,
      revision: ____,
      createdAt: _____,
      updatedAt: ______,
      ...definition
    } = first
    await db
      .insertInto('workflow_revisions')
      .values({
        organization_id: team.id,
        workflow_id: first.id,
        revision: 2,
        definition: JSON.stringify({ ...definition, name: 'Edited' }),
      })
      .execute()
    expect(await createWorkflowDefinition({ db, principal: as(owner) }, request)).toMatchObject({
      id: first.id,
      revision: 2,
      name: 'Edited',
    })
  })

  it('bounds enabled all-event workflows even before any event type exists', async () => {
    const user = await createTestUser(db),
      ctx = context(user)
    for (let i = 0; i < 5; i++) await createWorkflowDefinition(ctx, input(user, { enabled: true }))
    await expect(
      createWorkflowDefinition(ctx, input(user, { enabled: true })),
    ).rejects.toMatchObject({ code: 'workflow_limit_reached' })
  })

  it('rolls back definition and key if the audit port fails', async () => {
    const user = await createTestUser(db),
      request = input(user)
    await expect(
      createWorkflowDefinition(
        {
          ...context(user),
          audit: {
            record: async () => {
              throw new Error('audit unavailable')
            },
          },
        },
        request,
      ),
    ).rejects.toThrow('audit unavailable')
    expect(
      await db
        .selectFrom('workflow_definitions')
        .select('id')
        .where('organization_id', '=', user.principal.organization.id)
        .execute(),
    ).toHaveLength(0)
    expect(
      await db
        .selectFrom('workflow_creation_keys')
        .select('workflow_id')
        .where('organization_id', '=', user.principal.organization.id)
        .execute(),
    ).toHaveLength(0)
  })

  it('combines all-event and event-specific enabled limits in either direction, but admits drafts', async () => {
    for (const reverse of [false, true]) {
      const user = await createTestUser(db),
        ctx = context(user)
      const event = await createEventType(testContext(db, user.principal), {
        title: 'Call',
        slug: 'call',
        durationMinutes: 30,
      })
      const eventScope = { type: 'event_type', eventTypeId: event.id }
      for (let i = 0; i < 5; i++)
        await createWorkflowDefinition(
          ctx,
          input(user, {
            enabled: true,
            scope:
              i === 0
                ? reverse
                  ? eventScope
                  : { type: 'all_event_types' }
                : reverse
                  ? { type: 'all_event_types' }
                  : eventScope,
          }),
        )
      await expect(
        createWorkflowDefinition(
          ctx,
          input(user, { enabled: true, scope: reverse ? eventScope : { type: 'all_event_types' } }),
        ),
      ).rejects.toMatchObject({ code: 'workflow_limit_reached' })
      expect((await createWorkflowDefinition(ctx, input(user))).enabled).toBe(false)
    }
  })

  it('bounds retained draft definitions and releases capacity only on tombstone', async () => {
    const user = await createTestUser(db),
      ctx = context(user)
    let first = ''
    for (let i = 0; i < 100; i++) {
      const created = await createWorkflowDefinition(ctx, input(user))
      first ||= created.id
    }
    await expect(createWorkflowDefinition(ctx, input(user))).rejects.toMatchObject({
      code: 'workflow_limit_reached',
    })
    await db
      .updateTable('workflow_definitions')
      .set({ deleted_at: new Date() })
      .where('id', '=', first)
      .execute()
    await expect(createWorkflowDefinition(ctx, input(user))).resolves.toHaveProperty('id')
  })

  it('serializes concurrent identical keys and audits one creation', async () => {
    const user = await createTestUser(db),
      request = input(user),
      audit = { record: vi.fn(async () => {}) },
      ctx = { ...context(user), audit }
    const results = await Promise.all([
      createWorkflowDefinition(ctx, request),
      createWorkflowDefinition(ctx, request),
    ])
    expect(results[0]).toEqual(results[1])
    expect(audit.record).toHaveBeenCalledTimes(1)
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
        writer = createWorkflowDefinition(
          ctx,
          input(user, { enabled: true, scope: { type: 'event_type', eventTypeId: event.id } }),
        )
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
  it('locks the organization before the owner when the organization contender arrives first', async () => {
    const user = await createTestUser(db)
    const contender = await owned.pool.connect()
    let writer: Promise<unknown> | undefined
    try {
      await contender.query('BEGIN')
      await contender.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [
        user.principal.organization.id,
      ])
      let settled = false
      writer = createWorkflowDefinition(context(user), input(user))
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
        .finally(() => {
          settled = true
        })
      let waited = false
      for (let i = 0; i < 200 && !settled; i++) {
        const { rows } = await owned.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
        )
        if (rows.length) {
          waited = true
          break
        }
        await setTimeout(10)
      }
      const contenderOutcome = await contender
        .query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `workflow-owner:${user.principal.organization.id}:${user.id}`,
        ])
        .then(
          () => 'locked',
          (error) => error.code,
        )
      await contender.query('COMMIT')
      const outcome = await writer
      expect(waited).toBe(true)
      expect(contenderOutcome).toBe('locked')
      expect(outcome).toHaveProperty('value.id')
    } finally {
      await contender.query('ROLLBACK')
      contender.release()
      await writer
    }
  })

  it('event-type creation takes the same exclusive owner lock', async () => {
    const user = await createTestUser(db)
    const contender = await owned.pool.connect()
    let writer: Promise<unknown> | undefined
    try {
      await contender.query('BEGIN')
      await contender.query('SELECT id FROM auth.organization WHERE id=$1 FOR KEY SHARE', [
        user.principal.organization.id,
      ])
      await contender.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `workflow-owner:${user.principal.organization.id}:${user.id}`,
      ])
      let settled = false
      writer = createEventType(testContext(db, user.principal), {
        title: 'Call',
        slug: 'call',
        durationMinutes: 30,
      })
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
        .finally(() => {
          settled = true
        })
      let waited = false
      for (let i = 0; i < 200 && !settled; i++) {
        const { rows } = await owned.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'",
        )
        if (rows.length) {
          waited = true
          break
        }
        await setTimeout(10)
      }
      await contender.query('COMMIT')
      expect(await writer).toHaveProperty('value.id')
      expect(waited).toBe(true)
    } finally {
      await contender.query('ROLLBACK')
      contender.release()
      await writer
    }
  })
})
