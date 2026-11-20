import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { withAuditRequest } from '@hourmere/db/audit'
import { withTeamWriteCheck } from '@hourmere/db/team-write'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { listAuditEvents, purgeAuditEvents, setAuditLogSettings } from '@hourmere/scheduling'
import { createTestTeam, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type WorkflowAuditPort, workflowAuditPort } from './audit.ts'
import { createWorkflowDefinition, type WorkflowCreateContext } from './creates.ts'
import { deleteWorkflowDefinition } from './deletes.ts'
import type { WorkflowOwnerSelector } from './ownership.ts'
import { previewWorkflowCandidate } from './preview.ts'
import { updateWorkflowDefinition } from './updates.ts'

const serverUrl = process.env.DATABASE_URL
const privateName = 'Synthetic private workflow name'
const privateEdit = 'Synthetic renamed workflow'
const privateSubject = 'Synthetic private subject'
const privateBody = 'Synthetic private body for {{recipient.name}}'
const privateAnswer = 'Synthetic private service answer'
const privatePath = '/synthetic-preview-path?private=example'
const privateAddress = 'synthetic-recipient@example.test'
const trigger = 'booking.created'
const boundAudit = workflowAuditPort

const candidate = (owner: WorkflowOwnerSelector) => ({
  owner,
  name: privateName,
  scope: { type: 'all_event_types' },
  trigger: { type: trigger },
  actions: [
    {
      type: 'email',
      recipients: ['booker'],
      content: { en: { subject: privateSubject, body: privateBody } },
    },
  ],
})

describe.skipIf(!serverUrl)('workflow definition journal', () => {
  let testDb: TestDatabase
  let db: Db

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string, undefined, { tag: 'workflow_audit' })
    db = createDb(testDb.pool)
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  const journal = (organizationId: string, executor = db) =>
    executor
      .selectFrom('audit_events')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('action', 'like', 'workflow.%')
      .orderBy('id')

  const context = (principal: Principal, audit = boundAudit): WorkflowCreateContext => ({
    db,
    principal,
    audit,
    followUpHostNotesEnabled: true,
  })

  it('writes each transition in its transaction and records each replayable change once', async () => {
    const user = await createTestUser(db)
    const apiKey = user.principal
    if (apiKey.kind !== 'api_key') throw new Error('Expected API key fixture')
    const organizationId = apiKey.organization.id
    const session: Principal = { ...apiKey, kind: 'session', sessionId: randomUUID() }
    const oauth: Principal = {
      ...apiKey,
      kind: 'oauth',
      clientId: randomUUID(),
      oauthConsentId: randomUUID(),
      scopes: ['mcp:tools'],
    }
    const requestIds = new Map<string, string>()
    const audit: WorkflowAuditPort = {
      async record(trx, record) {
        expect(trx.isTransaction).toBe(true)
        await boundAudit.record(trx, record)
        const requestId = requestIds.get(record.event)
        if (!requestId) throw new Error(`Unexpected action ${record.event}`)
        const byRequest = (executor: Db) =>
          journal(organizationId, executor).where('request_id', '=', requestId).execute()
        expect(await byRequest(trx)).toMatchObject([{ action: record.event }])
        expect(await byRequest(db)).toEqual([])
      },
    }
    const request = <T>(action: string, perform: () => Promise<T>) => {
      const requestId = randomUUID()
      requestIds.set(action, requestId)
      return withAuditRequest(requestId, perform)
    }
    const content = candidate({ kind: 'personal', id: user.id })
    const input = { ...content, idempotencyKey: randomUUID() }
    const create = () => createWorkflowDefinition(context(apiKey, audit), input)
    const created = await request('workflow.created', create)
    await expect(create()).resolves.toEqual(created)

    const id = created.id
    const edit = () =>
      updateWorkflowDefinition(context(session, audit), id.toUpperCase(), {
        expectedRevision: 1,
        name: privateEdit,
      })
    await expect(request('workflow.updated', edit)).resolves.toMatchObject({ revision: 2 })
    await expect(edit()).rejects.toMatchObject({ code: 'workflow_revision_conflict' })

    const toggle = (enabled: boolean) => () =>
      updateWorkflowDefinition(context(session, audit), id, { expectedRevision: 2, enabled })
    for (const [action, enabled] of [
      ['workflow.enabled', true],
      ['workflow.disabled', false],
    ] as const) {
      await expect(request(action, toggle(enabled))).resolves.toMatchObject({
        enabled,
        revision: 2,
      })
      await expect(toggle(enabled)()).resolves.toMatchObject({ enabled, revision: 2 })
    }

    const remove = () =>
      deleteWorkflowDefinition(context(oauth, audit), id.toUpperCase(), { expectedRevision: 2 })
    await request('workflow.deleted', remove)
    await remove()

    const example = {
      recipientName: privateAddress,
      publicPath: privatePath,
      answers: { notes: privateAnswer },
    }
    const preview = () =>
      previewWorkflowCandidate(context(oauth, audit), {
        ...content,
        conditions: [{ field: 'guest_count', operator: 'equals', value: 1 }],
        example,
      })
    // Each invocation is a separate authorized preview, even with the same synthetic input.
    const result = await request('workflow.previewed', preview)
    expect(result).toMatchObject({ match: 'condition_false' })
    expect(result.emails[0]?.text).toContain(privateAddress)
    await expect(request('workflow.previewed', preview)).resolves.toEqual(result)

    const rows = await journal(organizationId).execute()
    expect(
      rows.map(({ action, target_type, target_id, details }) => [
        action,
        target_type,
        target_id,
        details,
      ]),
    ).toEqual([
      ['workflow.created', 'workflow', id, { revision: 1, trigger }],
      ['workflow.updated', 'workflow', id, { revision: 2, trigger }],
      ['workflow.enabled', 'workflow', id, { revision: 2, trigger }],
      ['workflow.disabled', 'workflow', id, { revision: 2, trigger }],
      ['workflow.deleted', 'workflow', id, { revision: 2 }],
      [
        'workflow.previewed',
        'workflow_preview',
        organizationId,
        { trigger, reason: 'condition_false' },
      ],
      [
        'workflow.previewed',
        'workflow_preview',
        organizationId,
        { trigger, reason: 'condition_false' },
      ],
    ])
    expect(rows[0]).toMatchObject({
      actor_type: 'api_key',
      actor_id: apiKey.apiKeyId,
      credential_type: 'api_key',
      credential_id: apiKey.apiKeyId,
      credential_scope: 'full',
      oauth_client_id: null,
      oauth_grant_id: null,
    })
    expect(rows[1]).toMatchObject({
      actor_type: 'user',
      actor_id: user.id,
      credential_type: 'session',
      credential_id: session.sessionId,
      credential_scope: null,
      oauth_client_id: null,
      oauth_grant_id: null,
    })
    expect(rows[4]).toMatchObject({
      actor_type: 'user',
      actor_id: user.id,
      credential_type: 'oauth',
      credential_id: null,
      credential_scope: null,
      oauth_client_id: oauth.clientId,
      oauth_grant_id: oauth.oauthConsentId,
    })
    const stored = JSON.stringify(rows)
    for (const value of [
      privateName,
      privateEdit,
      privateSubject,
      privateBody,
      privateAnswer,
      privatePath,
      privateAddress,
      user.email,
      input.idempotencyKey,
    ]) {
      expect(stored).not.toContain(value)
    }
  })

  it('rolls back the journal and the business change after the shared writer inserts', async () => {
    const user = await createTestUser(db)
    const { principal } = user
    const organizationId = principal.organization.id
    const input = { ...candidate({ kind: 'personal', id: user.id }), idempotencyKey: randomUUID() }
    const audit: WorkflowAuditPort = {
      async record(trx, record) {
        await boundAudit.record(trx, record)
        expect(
          await journal(organizationId, trx).where('action', '=', record.event).execute(),
        ).toHaveLength(1)
        if (record.event !== 'workflow.updated')
          throw new Error('Synthetic failure after audit insert')
      },
    }
    const failing = context(principal, audit)
    await expect(createWorkflowDefinition(failing, input)).rejects.toThrow(
      'Synthetic failure after audit insert',
    )
    expect(await journal(organizationId).execute()).toEqual([])
    for (const table of [
      'workflow_definitions',
      'workflow_revisions',
      'workflow_creation_keys',
    ] as const) {
      expect(
        await db
          .selectFrom(table)
          .select('organization_id')
          .where('organization_id', '=', organizationId)
          .execute(),
      ).toEqual([])
    }

    const created = await createWorkflowDefinition(context(principal), input)
    const before = await journal(organizationId).execute()
    await expect(
      updateWorkflowDefinition(failing, created.id, {
        expectedRevision: 1,
        name: privateEdit,
        enabled: true,
      }),
    ).rejects.toThrow('Synthetic failure after audit insert')
    await expect(
      deleteWorkflowDefinition(failing, created.id, { expectedRevision: 1 }),
    ).rejects.toThrow('Synthetic failure after audit insert')
    const { idempotencyKey: _, ...preview } = input
    await expect(previewWorkflowCandidate(failing, preview)).rejects.toThrow(
      'Synthetic failure after audit insert',
    )
    expect(await journal(organizationId).execute()).toEqual(before)
    expect(await createWorkflowDefinition(context(principal), input)).toEqual(created)
    expect(
      await db
        .selectFrom('workflow_definitions')
        .select('deleted_at')
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ deleted_at: null })
  })

  it('keeps workflow events under existing team journal access and retention', async () => {
    const owner = await createTestUser(db)
    const admin = await createTestUser(db)
    const member = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const session: Principal = { ...team.as(admin), kind: 'session', sessionId: randomUUID() }
    const preview = candidate({ kind: 'team', id: team.id })
    const input = { ...preview, idempotencyKey: randomUUID() }
    const memberContext = context(team.as(member))
    await expect(previewWorkflowCandidate(memberContext, preview)).rejects.toMatchObject({
      code: 'workflow_not_found',
    })
    await expect(createWorkflowDefinition(memberContext, input)).rejects.toMatchObject({
      code: 'workflow_not_found',
    })
    expect(await journal(team.id).execute()).toEqual([])
    const created = await createWorkflowDefinition(context(session), input)
    const proofRevoked = new Error('Synthetic team proof revoked before commit')
    await expect(
      withTeamWriteCheck(
        {
          organizationId: team.id,
          identity: { userId: admin.id, sessionId: session.sessionId },
          async lockProof(trx) {
            expect(
              await journal(team.id, trx).where('action', '=', 'workflow.previewed').execute(),
            ).toHaveLength(1)
            throw proofRevoked
          },
          expired: () => {
            throw proofRevoked
          },
        },
        () => previewWorkflowCandidate(context(session), candidate({ kind: 'team', id: team.id })),
      ),
    ).rejects.toThrow(proofRevoked)
    expect(await journal(team.id).where('action', '=', 'workflow.previewed').execute()).toEqual([])
    const list = (principal: Principal) =>
      listAuditEvents(testContext(db, principal), { action: 'workflow.created' })
    for (const user of [owner, admin]) {
      const page = await list(team.as(user))
      expect(page.data).toMatchObject([
        {
          actor: { type: 'user', id: admin.id },
          credential: {
            type: 'session',
            apiKeyId: null,
            apiKeyScope: null,
            oauthClientId: null,
            oauthGrantId: null,
          },
          target: { type: 'workflow', id: created.id },
          details: { revision: 1, trigger },
        },
      ])
      expect(JSON.stringify(page)).not.toContain(session.sessionId)
    }
    await expect(list(team.as(member))).rejects.toMatchObject({
      code: 'team_management_access_denied',
    })
    await expect(list(admin.principal)).resolves.toMatchObject({ data: [] })

    await db
      .updateTable('audit_events')
      .set({ occurred_at: sql`now() - interval '31 days'` })
      .where('organization_id', '=', team.id)
      .where('action', '=', 'workflow.created')
      .execute()
    const retentionContext = testContext(db, team.as(owner))
    await setAuditLogSettings(retentionContext, 30, { retention: 'forever' })
    await purgeAuditEvents(db, { instance: 30 })
    expect((await list(team.as(owner))).data).toHaveLength(1)
    await setAuditLogSettings(retentionContext, null, { retention: 'days', retentionDays: 30 })
    await purgeAuditEvents(db, { instance: null })
    expect((await list(team.as(owner))).data).toEqual([])
  })
})
