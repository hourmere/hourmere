// The definition reads behind the hard-off guard (docs/workflows.md, step 4), called directly
// with injected dependencies as hard-off.ts prescribes: the guarded operations refuse while
// off, and the internal services decide who reads what. A caller reads only the owner it acts
// as in its current organization, its personal workflows there or a team's as a current owner
// or admin there. Everything else reveals nothing: a list of any other owner gets the same
// insufficient_role, and a lookup of anything it may not read gets the same
// workflow_not_found as an unknown ID.
import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { DomainError } from '@hourmere/scheduling/errors'
import {
  createTestTeam,
  createTestUser,
  type TestTeam,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateWorkflowDefinition, type WorkflowDefinition } from './definition.ts'
import {
  getWorkflow,
  getWorkflowDefinition,
  listWorkflowDefinitions,
  listWorkflows,
  WORKFLOW_PAGE,
  type WorkflowView,
} from './reads.ts'
import { candidate, ids, personalContext, teamContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL

/** Canonical definitions as the contract returns them, the shape a revision stores. */
const personalDefinition = (name: string, enabled = false) =>
  validateWorkflowDefinition(candidate({ name, enabled }), personalContext)
const teamDefinition = (name: string, enabled = false) =>
  validateWorkflowDefinition(
    candidate({
      name,
      enabled,
      scope: { type: 'all_event_types' },
      trigger: { type: 'booking.created', delayMinutes: 15 },
      conditions: [{ field: 'guest_count', operator: 'at_least', value: 1 }],
      actions: [
        {
          type: 'email',
          recipients: ['hosts', 'booker'],
          content: { en: { subject: 'Hello {{recipient.name}}', body: 'See you\r\nsoon' } },
        },
      ],
    }),
    teamContext,
  )

/** The same refusal, field by field, whatever was asked. */
async function refusal(read: () => Promise<unknown>) {
  const error = await read().then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(DomainError)
  const { kind, code, detail } = error as DomainError
  return { kind, code, detail }
}
const notFound = { kind: 'not_found', code: 'workflow_not_found', detail: 'No such workflow' }
const forbidden = {
  kind: 'forbidden',
  code: 'insufficient_role',
  detail:
    'Only the personal owner, or a team owner or admin acting in that team, can read its workflows',
}

describe('workflow definition reads while workflows are off', () => {
  it('refuse through the guarded operations before touching their context', async () => {
    const untouchable = new Proxy(
      {},
      {
        get: () => {
          throw new Error('a guarded read must not touch its context')
        },
      },
    ) as Parameters<typeof listWorkflows>[0]
    for (const read of [
      () => listWorkflows(untouchable, { owner: { kind: 'personal', id: ids.user } }),
      () => getWorkflow(untouchable, ids.event),
    ])
      expect(await refusal(read)).toEqual({
        kind: 'not_found',
        code: 'workflows_disabled',
        detail: undefined,
      })
  })
})

describe.skipIf(!serverUrl)('workflow definition reads', () => {
  let owned: TestDatabase
  let db: Db
  let owner: TestUser
  let admin: TestUser
  let member: TestUser
  let outsider: TestUser
  let teamA: TestTeam
  let teamB: TestTeam
  let teamC: TestTeam
  /** Definition IDs by fixture name. */
  const workflow: Record<string, string> = {}
  const stored: Record<string, WorkflowDefinition> = {}

  /** Inserts a definition with its revisions (the last one current) and returns its ID. */
  async function define(
    name: string,
    organizationId: string,
    ownerUserId: string | null,
    revisions: WorkflowDefinition[],
    options: { enabled?: boolean; deleted?: boolean } = {},
  ) {
    await db.transaction().execute(async (trx) => {
      const { id } = await trx
        .insertInto('workflow_definitions')
        .values({
          organization_id: organizationId,
          owner_user_id: ownerUserId,
          enabled: options.enabled ?? false,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      for (const [index, definition] of revisions.entries()) {
        const { enabled: _enabled, ...content } = definition
        await trx
          .insertInto('workflow_revisions')
          .values({
            organization_id: organizationId,
            workflow_id: id,
            revision: index + 1,
            definition: JSON.stringify(content),
          })
          .execute()
      }
      workflow[name] = id
      stored[name] = { ...(revisions.at(-1) as WorkflowDefinition), enabled: !!options.enabled }
    })
    if (options.deleted)
      await db
        .updateTable('workflow_definitions')
        .set({ deleted_at: new Date(), enabled: false })
        .where('id', '=', workflow[name] as string)
        .execute()
  }

  /** `user` acting in `organization`, with each principal kind. */
  const actingIn = (
    user: TestUser,
    team: TestTeam | undefined,
    kind: Principal['kind'] = 'api_key',
  ): Principal => {
    const base = team ? team.as(user) : user.principal
    if (kind === 'session') return { ...base, kind, sessionId: randomUUID() } as Principal
    if (kind === 'oauth')
      return {
        ...base,
        kind,
        oauthConsentId: randomUUID(),
        clientId: 'workflow-reads',
        scopes: ['mcp:tools'],
      } as Principal
    return { ...base, kind: 'api_key', apiKeyScope: 'read' } as Principal
  }
  const ctx = (principal: Principal) => ({ db, principal })
  const list = (principal: Principal, kind: 'personal' | 'team', id: string, more = {}) =>
    listWorkflowDefinitions(ctx(principal), { owner: { kind, id }, ...more })
  const get = (principal: Principal, id: string) => getWorkflowDefinition(ctx(principal), id)

  /** The view a fixture definition must read as, apart from its times. */
  const expected = (
    name: string,
    selector: { kind: 'personal' | 'team'; id: string },
    revision: number,
  ) => ({
    id: workflow[name],
    owner: selector,
    revision,
    ...stored[name],
    createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
    updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
  })

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'wf_reads' })
    db = createDb(owned.pool)
    owner = await createTestUser(db, 'Workflow owner')
    admin = await createTestUser(db, 'Workflow admin')
    member = await createTestUser(db, 'Workflow member')
    outsider = await createTestUser(db, 'Workflow outsider')
    teamA = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'member, admin' },
      { user: member, role: 'member' },
    ])
    teamB = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    teamC = await createTestTeam(db, [{ user: outsider, role: 'owner' }])
    const personal = owner.principal.organization.id
    await define('first', personal, owner.id, [personalDefinition('First')])
    await define('second', personal, owner.id, [personalDefinition('Second', true)], {
      enabled: true,
    })
    await define('personalDeleted', personal, owner.id, [personalDefinition('Gone')], {
      deleted: true,
    })
    await define('foreignPersonal', outsider.principal.organization.id, outsider.id, [
      personalDefinition('Foreign'),
    ])
    await define('team', teamA.id, null, [teamDefinition('Old'), teamDefinition('Current', true)], {
      enabled: true,
    })
    await define('teamDeleted', teamA.id, null, [teamDefinition('Gone')], { deleted: true })
    await define('teamB', teamB.id, null, [teamDefinition('Other team')])
    await define('teamC', teamC.id, null, [teamDefinition('Foreign team')])
  })
  afterAll(async () => {
    // Dropping the database also ends the pool behind db.
    await owned?.drop()
  })

  it('reads the personal owner its own live definitions, current revision and flag', async () => {
    for (const kind of ['api_key', 'session', 'oauth'] as const) {
      const principal = actingIn(owner, undefined, kind)
      const selector = { kind: 'personal' as const, id: owner.id }
      const page = await list(principal, 'personal', owner.id)
      expect(page).toEqual({
        data: [expected('first', selector, 1), expected('second', selector, 1)],
        nextCursor: null,
      })
      for (const view of page.data) expect(await get(principal, view.id)).toEqual(view)
      // An uppercase ID names the same definition; the database form is returned.
      expect((await get(principal, (workflow.first as string).toUpperCase())).id).toBe(
        workflow.first,
      )
    }
  })

  it('reads a team owner or admin the team definitions, at their current revision', async () => {
    for (const user of [owner, admin]) {
      const principal = actingIn(user, teamA)
      const page = await list(principal, 'team', teamA.id)
      expect(page.data).toEqual([expected('team', { kind: 'team', id: teamA.id }, 2)])
      expect(page.data[0]?.name).toBe('Current')
      expect(page.data[0]?.actions).toEqual([
        {
          type: 'email',
          recipients: ['booker', 'hosts'],
          content: { en: { subject: 'Hello {{recipient.name}}', body: 'See you\nsoon' } },
        },
      ])
      expect(await get(principal, workflow.team as string)).toEqual(page.data[0])
    }
  })

  it('refuses an ordinary member, with the same answers as for any other team', async () => {
    const principal = actingIn(member, teamA)
    expect(await refusal(() => list(principal, 'team', teamA.id))).toEqual(forbidden)
    for (const name of ['team', 'teamB', 'teamC', 'first'])
      expect(await refusal(() => get(principal, workflow[name] as string))).toEqual(notFound)
    // Their own personal workflows stay in their personal organization.
    expect(await refusal(() => list(principal, 'personal', member.id))).toEqual(forbidden)
  })

  it('reveals nothing about foreign, deleted, unknown or malformed IDs', async () => {
    const principal = actingIn(owner, undefined)
    const unknown = randomUUID()
    for (const id of [
      workflow.foreignPersonal,
      workflow.personalDeleted,
      workflow.team,
      workflow.teamC,
      unknown,
      'not-a-uuid',
      '',
    ])
      expect(await refusal(() => get(principal, id as string)), id).toEqual(notFound)
    const team = actingIn(admin, teamA)
    for (const id of [workflow.teamDeleted, workflow.teamB, workflow.teamC, workflow.first])
      expect(await refusal(() => get(team, id as string)), id).toEqual(notFound)
    // Listing another owner, existing or not, is the same refusal.
    for (const [kind, id] of [
      ['personal', outsider.id],
      ['personal', admin.id],
      ['personal', randomUUID()],
      ['team', teamC.id],
      ['team', teamB.id],
      ['team', randomUUID()],
      ['team', owner.principal.organization.id],
    ] as const) {
      expect(await refusal(() => list(principal, kind, id)), `${kind} ${id}`).toEqual(forbidden)
      expect(await refusal(() => list(team, kind, id)), `${kind} ${id}`).toEqual(forbidden)
    }
  })

  it('follows the organization the caller acts in, so a context change reveals nothing', async () => {
    // The owner owns teams A and B and has personal workflows; each context shows only its own.
    const contexts = [
      [undefined, 'personal', owner.id, ['first', 'second']],
      [teamA, 'team', teamA.id, ['team']],
      [teamB, 'team', teamB.id, ['teamB']],
    ] as const
    for (const [team, kind, id, visible] of contexts) {
      for (const sessionKind of ['session', 'api_key'] as const) {
        const principal = actingIn(owner, team, sessionKind)
        expect((await list(principal, kind, id)).data.map((view) => view.id)).toEqual(
          visible.map((name) => workflow[name]),
        )
        for (const [, otherKind, otherId] of contexts.filter((other) => other[2] !== id))
          expect(await refusal(() => list(principal, otherKind, otherId))).toEqual(forbidden)
        for (const name of ['first', 'second', 'team', 'teamB'])
          if (!(visible as readonly string[]).includes(name))
            expect(await refusal(() => get(principal, workflow[name] as string)), name).toEqual(
              notFound,
            )
      }
    }
  })

  it('rechecks the current role, membership and verified identity on every read', async () => {
    const principal = actingIn(admin, teamA)
    expect((await list(principal, 'team', teamA.id)).data).toHaveLength(1)
    const membership = (role: string) =>
      db
        .updateTable('auth.member')
        .set({ role })
        .where('organizationId', '=', teamA.id)
        .where('userId', '=', admin.id)
        .execute()
    try {
      await membership('member')
      expect(await refusal(() => list(principal, 'team', teamA.id))).toEqual(forbidden)
      expect(await refusal(() => get(principal, workflow.team as string))).toEqual(notFound)
      await membership('owner')
      expect((await list(principal, 'team', teamA.id)).data).toHaveLength(1)
      await db
        .updateTable('auth.user')
        .set({ emailVerified: false })
        .where('id', '=', admin.id)
        .execute()
      expect(await refusal(() => list(principal, 'team', teamA.id))).toEqual(forbidden)
      expect(await refusal(() => get(principal, workflow.team as string))).toEqual(notFound)
    } finally {
      await membership('member, admin')
      await db
        .updateTable('auth.user')
        .set({ emailVerified: true })
        .where('id', '=', admin.id)
        .execute()
    }
    const removed = await createTestUser(db, 'Removed admin')
    const removedPrincipal = actingIn(removed, teamA)
    expect(await refusal(() => list(removedPrincipal, 'team', teamA.id))).toEqual(forbidden)
    expect(await refusal(() => get(removedPrincipal, workflow.team as string))).toEqual(notFound)
  })

  it('reads a personal organization only for its own user', async () => {
    // A row that makes another user a member of the owner's personal organization.
    await db
      .insertInto('auth.member')
      .values({
        organizationId: owner.principal.organization.id,
        userId: outsider.id,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    try {
      const principal: Principal = {
        ...outsider.principal,
        organization: owner.principal.organization,
      }
      for (const id of [owner.id, outsider.id])
        expect(await refusal(() => list(principal, 'personal', id))).toEqual(forbidden)
      expect(await refusal(() => get(principal, workflow.first as string))).toEqual(notFound)
    } finally {
      await db
        .deleteFrom('auth.member')
        .where('organizationId', '=', owner.principal.organization.id)
        .where('userId', '=', outsider.id)
        .execute()
    }
  })

  it('pages oldest first with a cursor bound to its owner', async () => {
    const principal = actingIn(owner, undefined)
    const first = await list(principal, 'personal', owner.id, { limit: 1 })
    expect(first.data.map((view) => view.id)).toEqual([workflow.first])
    expect(first.nextCursor).toEqual(expect.any(String))
    const second = await list(principal, 'personal', owner.id, {
      limit: 1,
      cursor: first.nextCursor,
    })
    expect(second.data.map((view) => view.id)).toEqual([workflow.second])
    expect(second.nextCursor).toBeNull()
    // A cursor after the last definition reads an empty last page.
    const afterLast = Buffer.from(
      JSON.stringify([`personal:${owner.id}`, workflow.second]),
    ).toString('base64url')
    expect(await list(principal, 'personal', owner.id, { cursor: afterLast })).toEqual({
      data: [],
      nextCursor: null,
    })
    expect(
      (await list(principal, 'personal', owner.id, { limit: WORKFLOW_PAGE.max })).nextCursor,
    ).toBeNull()
    const invalidCursor = { kind: 'invalid', code: 'invalid_cursor', detail: 'cursor is not valid' }
    // A cursor continues only the list it came from.
    const otherOwner = Buffer.from(JSON.stringify([`team:${teamA.id}`, workflow.first])).toString(
      'base64url',
    )
    for (const cursor of [
      otherOwner,
      'not a cursor',
      Buffer.from('[1,2]').toString('base64url'),
      Buffer.from(JSON.stringify([`personal:${owner.id}`, 'nope'])).toString('base64url'),
      'x'.repeat(513),
    ])
      expect(
        await refusal(() => list(principal, 'personal', owner.id, { cursor })),
        cursor,
      ).toEqual(invalidCursor)
    for (const limit of [0, WORKFLOW_PAGE.max + 1, 1.5, Number.NaN])
      expect(await refusal(() => list(principal, 'personal', owner.id, { limit }))).toMatchObject({
        code: 'invalid_limit',
      })
    expect(
      await refusal(() =>
        listWorkflowDefinitions(ctx(principal), {
          owner: { kind: 'nobody', id: owner.id } as never,
        }),
      ),
    ).toMatchObject({ code: 'invalid_workflow_owner' })
  })

  it('treats a stored revision outside the contract as a fault, not as data', async () => {
    const organizationId = outsider.principal.organization.id
    let id = ''
    await db.transaction().execute(async (trx) => {
      id = (
        await trx
          .insertInto('workflow_definitions')
          .values({ organization_id: organizationId, owner_user_id: outsider.id })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
      const { enabled: _enabled, ...content } = personalDefinition('Odd')
      // The database mirrors only the envelope; an unknown recipient class passes it.
      await trx
        .insertInto('workflow_revisions')
        .values({
          organization_id: organizationId,
          workflow_id: id,
          revision: 1,
          definition: JSON.stringify({
            ...content,
            actions: [{ type: 'email', recipients: ['everyone'] }],
          }),
        })
        .execute()
    })
    const principal = actingIn(outsider, undefined)
    const error = await getWorkflowDefinition(ctx(principal), id).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(DomainError)
    expect(String(error)).not.toContain('everyone')
    await expect(list(principal, 'personal', outsider.id)).rejects.not.toBeInstanceOf(DomainError)
  })

  it('returns every field of the view and nothing else', async () => {
    const view: WorkflowView = await get(actingIn(owner, teamA), workflow.team as string)
    expect(Object.keys(view).sort()).toEqual(
      [
        'actions',
        'conditions',
        'createdAt',
        'enabled',
        'id',
        'name',
        'owner',
        'revision',
        'scope',
        'trigger',
        'updatedAt',
      ].sort(),
    )
  })
})
