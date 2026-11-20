import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { leaveTeamMember } from '@hourmere/scheduling'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { suspendScimMember } from '../../db/src/scim-suspension-fixtures.ts'
import { identityFixture, link, proofValues } from '../../db/src/sso-identity-fixtures.ts'
import { insert } from '../../db/src/sso-storage-fixtures.ts'
import {
  AUTH_SESSION_LIFETIME_SECONDS,
  type Auth,
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
} from './index.ts'
import { cancelTeamInvitation } from './invitation-cancellation.ts'
import { manageInvitation } from './invitations.ts'
import { ensurePersonalOrganization } from './organizations.ts'
import { checkTeamManagementAccess } from './team-management.ts'
import { removeTeamMember } from './team-member-removal.ts'
import * as teamSsoNative from './team-sso-native.ts'

const databaseUrl = process.env.DATABASE_URL
const origin = 'http://localhost:43831'
const secret = randomBytes(32).toString('base64url')
const signup = { mode: 'open', allowedDomains: [] } as const
const ssoRequired = { code: 'SSO_REQUIRED', message: 'sso_required' }

type Operation = {
  api: keyof Auth['api']
  path?: string
  body?: Record<string, unknown>
  query?: Record<string, string>
  recipient?: boolean
}

describe.skipIf(!databaseUrl)('native and trusted team SSO enforcement', () => {
  let owned: TestDatabase
  let db: Db
  let pool: ReturnType<typeof createAuthPool>
  let off: Auth
  let on: Auth
  const enqueued: { invitationId: string; generation: number }[] = []

  function auth(enabled: boolean) {
    return createAuth({
      db,
      pool,
      baseURL: origin,
      secret,
      signup,
      ssoCapabilities: { ssoOidcEnabled: enabled, ssoSamlEnabled: false },
      leaveTeamMember: (principal, teamId, expectedOrganizationId, transaction) =>
        leaveTeamMember(
          { db: transaction ?? db, principal, now: () => Temporal.Now.instant() },
          { teamId, expectedOrganizationId },
        ),
      enqueueInvitationEmail: async (payload) => {
        enqueued.push(payload)
      },
      mailer: { send: async () => expect.unreachable('Uses the invitation outbox') },
    })
  }

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'native_team_sso' })
    db = createDb(owned.pool)
    pool = createAuthPool(owned.url, signup)
    off = auth(false)
    on = auth(true)
  })

  afterAll(async () => {
    await pool?.end()
    await owned?.drop()
  })

  async function browser(userId: string, organizationId: string) {
    const result = await db.transaction().execute((trx) =>
      createBrowserSession(
        trx,
        { publicUrl: origin, secret },
        {
          userId,
          organizationId,
          now: Temporal.Now.instant().toString(),
          headers: new Headers(),
        },
      ),
    )
    return { id: result.id, cookie: result.cookie.split(';')[0] as string }
  }

  async function fixture() {
    const client = await owned.pool.connect()
    let identity: Awaited<ReturnType<typeof identityFixture>>
    try {
      identity = await identityFixture(client)
    } finally {
      client.release()
    }
    const ownerPersonal = await ensurePersonalOrganization(db, identity.owner)
    const ownerSession = await browser(identity.owner, identity.team)
    await ensurePersonalOrganization(db, identity.member)
    const memberSession = await browser(identity.member, identity.team)
    const recipientPersonal = await ensurePersonalOrganization(db, identity.otherOwner)
    const recipient = await browser(identity.otherOwner, recipientPersonal)
    const { email } = await db
      .selectFrom('auth.user')
      .select('email')
      .where('id', '=', identity.otherOwner)
      .executeTakeFirstOrThrow()
    const { slug } = await db
      .selectFrom('auth.organization')
      .select('slug')
      .where('id', '=', identity.team)
      .executeTakeFirstOrThrow()
    const invitation = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: identity.team,
        inviterId: identity.owner,
        email,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const otherInvitation = await db
      .insertInto('auth.invitation')
      .values({
        ...invitation,
        id: randomUUID(),
        organizationId: identity.otherTeam,
        inviterId: identity.otherOwner,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return {
      ...identity,
      ownerSession,
      ownerPersonal,
      memberSession,
      recipient,
      invitation,
      otherInvitation,
      slug,
    }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>

  function scoped(f: Fixture): Operation[] {
    const query = { organizationId: f.team }
    const target = { invitationId: f.invitation.id }
    return [
      { api: 'getOrganization', path: 'get-organization', query },
      {
        api: 'getFullOrganization',
        path: 'get-full-organization',
        query: { organizationSlug: f.slug },
      },
      { api: 'getActiveMember', path: 'get-active-member' },
      { api: 'getActiveMemberRole', path: 'get-active-member-role' },
      { api: 'listMembers', path: 'list-members', query },
      { api: 'listInvitations', path: 'list-invitations', query },
      {
        api: 'getInvitation',
        path: 'get-invitation',
        query: { id: f.invitation.id },
        recipient: true,
      },
      { api: 'checkOrganizationSlug', path: 'check-slug', body: { slug: f.slug } },
      { api: 'setActiveOrganization', path: 'set-active', body: { organizationSlug: f.slug } },
      {
        api: 'updateOrganization',
        path: 'update',
        body: { ...query, data: { name: 'Synthetic rename' } },
      },
      { api: 'deleteOrganization', path: 'delete', body: query },
      {
        api: 'createInvitation',
        path: 'invite-member',
        body: { ...query, email: 'native-invite@example.test', role: 'member' },
      },
      { api: 'cancelInvitation', path: 'cancel-invitation', body: target },
      { api: 'acceptInvitation', path: 'accept-invitation', body: target, recipient: true },
      { api: 'rejectInvitation', path: 'reject-invitation', body: target, recipient: true },
      {
        api: 'updateMemberRole',
        path: 'update-member-role',
        body: { ...query, memberId: f.memberMember, role: 'admin' },
      },
      {
        api: 'removeMember',
        path: 'remove-member',
        body: { ...query, memberIdOrEmail: f.memberMember },
      },
      { api: 'leaveOrganization', path: 'leave', body: query },
      {
        api: 'hasPermission',
        path: 'has-permission',
        body: { ...query, permissions: { member: ['delete'] } },
      },
      { api: 'addMember', body: { ...query, userId: f.otherOwner, role: 'member' } },
    ]
  }

  function headers(f: Fixture, operation: Operation, cookie?: string, expected = f.team) {
    return new Headers({
      cookie: cookie ?? (operation.recipient ? f.recipient.cookie : f.ownerSession.cookie),
      origin,
      'content-type': 'application/json',
      'x-expected-organization-id': expected,
    })
  }

  function http(
    instance: Auth,
    f: Fixture,
    operation: Operation,
    cookie?: string,
    expected?: string,
  ) {
    const url = new URL(`/api/auth/organization/${operation.path}`, origin)
    url.search = new URLSearchParams(operation.query).toString()
    return instance.handler(
      new Request(url, {
        method: operation.body ? 'POST' : 'GET',
        headers: headers(f, operation, cookie, expected),
        ...(operation.body && { body: JSON.stringify(operation.body) }),
      }),
    )
  }

  function trusted(
    instance: Auth,
    f: Fixture,
    operation: Operation,
    withoutSession = false,
    asResponse = true,
  ) {
    // Every case shares Better Auth's context shape. The inventory assertion also covers the
    // pathless trusted API, which cannot be exercised through the HTTP handler.
    const call = instance.api[operation.api] as unknown as (input: {
      asResponse: boolean
      headers?: Headers
      body?: Record<string, unknown>
      query?: Record<string, string>
    }) => Promise<Response>
    return call({
      asResponse,
      ...(!withoutSession && { headers: headers(f, operation) }),
      ...(operation.body && { body: operation.body }),
      ...(operation.query && { query: operation.query }),
    })
  }

  async function policy(f: Fixture) {
    await db
      .insertInto('sso_policies')
      .values({ organization_id: f.team, require_sso: true })
      .execute()
  }

  async function effects(f: Fixture) {
    return {
      organization: await db
        .selectFrom('auth.organization')
        .selectAll()
        .where('id', '=', f.team)
        .execute(),
      members: await db
        .selectFrom('auth.member')
        .selectAll()
        .where('organizationId', '=', f.team)
        .orderBy('id')
        .execute(),
      invitations: await db
        .selectFrom('auth.invitation')
        .selectAll()
        .where('organizationId', '=', f.team)
        .orderBy('id')
        .execute(),
      delivery: await db
        .selectFrom('invitation_deliveries')
        .select(['invitation_id', 'state', 'generation', 'attempts', 'authorized_by_user_id'])
        .where(
          'invitation_id',
          'in',
          db.selectFrom('auth.invitation').select('id').where('organizationId', '=', f.team),
        )
        .execute(),
      operations: await db
        .selectFrom('organization_operations')
        .selectAll()
        .where('organization_id', '=', f.team)
        .orderBy('id')
        .execute(),
      audit: await db
        .selectFrom('audit_events')
        .selectAll()
        .where('organization_id', '=', f.team)
        .orderBy('id')
        .execute(),
      sessions: await db
        .selectFrom('auth.session')
        .select(['id', 'activeOrganizationId', 'updatedAt'])
        .where('id', 'in', [f.ownerSession.id, f.memberSession.id, f.recipient.id])
        .orderBy('id')
        .execute(),
    }
  }

  async function refused(response: Response, name?: string) {
    expect(response.status, name).toBe(403)
    expect(await response.json(), name).toEqual(ssoRequired)
    expect(response.headers.get('set-cookie'), name).toBeNull()
  }

  function trustedRefused(pending: Promise<unknown>, name: string) {
    return expect(pending, name).rejects.toMatchObject({ statusCode: 403, body: ssoRequired })
  }

  const lists = [
    { api: 'listOrganizations', path: 'list' },
    { api: 'listUserInvitations', path: 'list-user-invitations', recipient: true },
  ] as const satisfies Operation[]

  function createOperation(f: Fixture): Operation {
    return {
      api: 'createOrganization',
      path: 'create',
      body: {
        name: 'New synthetic team',
        slug: `new-${f.slug}`,
        keepCurrentActiveOrganization: true,
      },
    }
  }

  function legacyAuth() {
    const original = teamSsoNative.nativeTeamSso(db, {
      ssoOidcEnabled: false,
      ssoSamlEnabled: false,
    })
    const disabled = vi.spyOn(teamSsoNative, 'nativeTeamSso').mockReturnValueOnce({
      ...original,
      before: async () => undefined,
      plugin: { id: original.plugin.id, hooks: { after: [] } },
    })
    try {
      return auth(false)
    } finally {
      disabled.mockRestore()
    }
  }

  async function compatibilityOutcome(instance: Auth, f: Fixture, operation: Operation) {
    enqueued.length = 0
    const cookie = operation.api === 'leaveOrganization' ? f.memberSession.cookie : undefined
    const response = operation.path
      ? await http(instance, f, operation, cookie)
      : await trusted(instance, f, operation, true)
    const state = await effects(f)
    const created = await db
      .selectFrom('auth.organization')
      .selectAll()
      .where('slug', '=', `new-${f.slug}`)
      .executeTakeFirst()
    const creatorMember =
      created &&
      (await db
        .selectFrom('auth.member')
        .selectAll()
        .where('organizationId', '=', created.id)
        .where('userId', '=', f.owner)
        .executeTakeFirstOrThrow())
    const admitted = state.members.find((row) => row.userId === f.otherOwner)
    let bytes = await response.text()
    // Bind newly issued IDs and times to the persisted rows before comparing the wire bytes.
    // Replaying from the same initial rows will produce fresh IDs and timestamps.
    for (const [kind, row] of [
      ['organization', created],
      ['creator', creatorMember],
      ['member', admitted],
    ] as const) {
      if (!row) continue
      expect(bytes, operation.path).toContain(row.id)
      expect(bytes, operation.path).toContain(row.createdAt.toISOString())
      bytes = bytes
        .replaceAll(row.id, `<new ${kind} id>`)
        .replace(row.createdAt.toISOString(), `<new ${kind} time>`)
    }
    // Preserve exact Set-Cookie equality without printing the synthetic credential in a diff.
    const headers = [...response.headers].map(([name, value]) => [
      name,
      name === 'set-cookie' ? createHash('sha256').update(value).digest('hex') : value,
    ])
    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      bytes,
      state: {
        organization: state.organization,
        members: state.members
          .filter((row) => row !== admitted)
          .concat(admitted ? [{ ...admitted, id: '<new member id>', createdAt: new Date(0) }] : []),
        invitations: state.invitations,
        delivery: state.delivery,
        operations: state.operations.map(({ id: _id, occurred_at: _time, ...row }) => row),
        audit: state.audit.map(({ id: _id, occurred_at: _time, ...row }) => row),
        sessions: state.sessions.map(({ updatedAt: _time, ...row }) => row),
        created: created && { name: created.name, slug: created.slug, role: creatorMember?.role },
        enqueued: [...enqueued],
      },
    }
  }

  async function resetCompatibilityFixture(
    f: Fixture,
    initial: Awaited<ReturnType<typeof effects>>,
  ) {
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('auth.organization').where('slug', '=', `new-${f.slug}`).execute()
      await trx.deleteFrom('audit_events').where('organization_id', '=', f.team).execute()
      await trx
        .deleteFrom('organization_operations')
        .where('organization_id', '=', f.team)
        .execute()
      await trx
        .deleteFrom('invitation_deliveries')
        .where('invitation_id', '=', f.invitation.id)
        .execute()
      await trx
        .updateTable('auth.invitation')
        .set({ status: 'pending' })
        .where('id', '=', f.invitation.id)
        .execute()
      await trx
        .deleteFrom('auth.member')
        .where('organizationId', '=', f.team)
        .where('userId', '=', f.otherOwner)
        .execute()
      await trx
        .insertInto('auth.member')
        .values(initial.members)
        .onConflict((conflict) =>
          conflict.column('id').doUpdateSet((eb) => ({ role: eb.ref('excluded.role') })),
        )
        .execute()
      const organization = initial.organization[0]
      if (organization)
        await trx
          .updateTable('auth.organization')
          .set({ name: organization.name })
          .where('id', '=', f.team)
          .execute()
      for (const { id, ...values } of initial.sessions)
        await trx.updateTable('auth.session').set(values).where('id', '=', id).execute()
    })
  }

  it('preserves native response bytes, cookies, errors and writes without a team policy', async () => {
    const f = await fixture()
    const legacy = legacyAuth()
    const initial = await effects(f)
    const operations: Operation[] = [...scoped(f), ...lists, createOperation(f)]
    for (const entry of operations) {
      const operation =
        entry.api === 'createInvitation'
          ? { ...entry, body: { ...entry.body, email: f.invitation.email } }
          : entry
      const original = await compatibilityOutcome(legacy, f, operation)
      // Slug already taken and the permanently disabled native delete are established errors.
      const status =
        operation.api === 'deleteOrganization'
          ? 403
          : operation.api === 'checkOrganizationSlug'
            ? 400
            : 200
      expect(original.status, operation.api).toBe(status)
      if (operation.body) await resetCompatibilityFixture(f, initial)
      const enforced = await compatibilityOutcome(off, f, operation)
      expect(enforced, operation.api).toEqual(original)
      if (operation.body) await resetCompatibilityFixture(f, initial)
    }
  })

  it('keeps the disabled native delete from refreshing a no-policy session', async () => {
    const f = await fixture()
    const updatedAt = new Date(Date.now() - 48 * 3_600_000)
    const expiresAt = new Date(updatedAt.getTime() + AUTH_SESSION_LIFETIME_SECONDS * 1_000)
    await db
      .updateTable('auth.session')
      .set({ updatedAt, expiresAt })
      .where('id', '=', f.ownerSession.id)
      .execute()
    const response = await http(off, f, {
      api: 'deleteOrganization',
      path: 'delete',
      body: { organizationId: f.team },
    })
    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(
      await db
        .selectFrom('auth.session')
        .select(['updatedAt', 'expiresAt'])
        .where('id', '=', f.ownerSession.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ updatedAt, expiresAt })
  })

  it('classifies every native organization endpoint and enforces seeded policy with OIDC off', async () => {
    const f = await fixture()
    await policy(f)
    const operations = scoped(f)
    const { options } = await off.$context
    const organization = options.plugins?.find((plugin) => plugin.id === 'organization')
    const endpoints =
      organization && 'endpoints' in organization ? organization.endpoints : undefined
    expect(Object.keys(endpoints ?? {}).sort()).toEqual(
      [...operations, ...lists, createOperation(f)].map(({ api }) => api).sort(),
    )
    const before = await effects(f)
    for (const operation of operations) {
      if (operation.api === 'deleteOrganization') {
        const response = await http(off, f, operation)
        const body = {
          code: 'TEAM_OPERATION_NOT_SUPPORTED',
          message: 'Deleting a team is not supported.',
        }
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual(body)
        await expect(trusted(off, f, operation, false, false)).rejects.toMatchObject({
          statusCode: 403,
          body,
        })
        continue
      }
      if (operation.path) await refused(await http(off, f, operation), `HTTP ${operation.path}`)
      await trustedRefused(trusted(off, f, operation, false, false), `trusted ${operation.api}`)
    }
    await trustedRefused(
      trusted(
        off,
        f,
        {
          api: 'addMember',
          body: { organizationId: f.team, userId: f.otherOwner, role: 'member' },
        },
        true,
        false,
      ),
      'trusted addMember without headers',
    )
    expect(await effects(f)).toEqual(before)
  })

  it('keeps unauthenticated slug checks uniform when a policy exists', async () => {
    const f = await fixture()
    const operation: Operation = {
      api: 'checkOrganizationSlug',
      path: 'check-slug',
      body: { slug: f.slug },
    }
    const baseline = await http(off, f, operation, '')
    expect(baseline.status).toBe(401)
    await policy(f)
    const response = await http(off, f, operation, '')
    expect(response.status).toBe(baseline.status)
    expect([...response.headers]).toEqual([...baseline.headers])
    expect(await response.text()).toBe(await baseline.text())
    await trustedRefused(
      trusted(off, f, operation, true, false),
      'trusted slug lookup without headers',
    )
  })

  it('filters enforced teams and invitations from lists, including the trusted email query', async () => {
    const f = await fixture()
    await policy(f)
    for (const entry of [http, trusted] as const) {
      const organizations = await entry(off, f, lists[0])
      expect(organizations.status).toBe(200)
      expect(((await organizations.json()) as { id: string }[]).map(({ id }) => id)).toEqual([
        f.ownerPersonal,
      ])
      const invitations = await entry(off, f, lists[1])
      expect(invitations.status).toBe(200)
      expect(((await invitations.json()) as { id: string }[]).map(({ id }) => id)).toEqual([
        f.otherInvitation.id,
      ])
    }
    const trustedEmail = await trusted(
      off,
      f,
      { ...lists[1], query: { email: f.invitation.email } },
      true,
    )
    expect(trustedEmail.status).toBe(200)
    expect(((await trustedEmail.json()) as { id: string }[]).map(({ id }) => id)).toEqual([
      f.otherInvitation.id,
    ])
  })

  it('enforces proof at shared service entrances called without native HTTP or auth.api', async () => {
    const f = await fixture()
    await policy(f)
    const resolved = await createCallerResolver({ auth: off, db })(
      new Headers({ cookie: f.ownerSession.cookie }),
    )
    if (!resolved.ok || resolved.principal.kind !== 'session')
      expect.unreachable('Expected a valid team session')
    const { principal } = resolved
    const before = await effects(f)
    await trustedRefused(
      manageInvitation(
        db,
        { userId: f.owner, sessionId: f.ownerSession.id, activeOrganizationId: f.team },
        { email: 'native-service@example.test', role: 'member' },
      ),
      'issue invitation',
    )
    await trustedRefused(
      db.transaction().execute(async (trx) => {
        const actor = await checkTeamManagementAccess(trx, principal, f.team, true)
        if (actor.role === 'member') expect.unreachable('Expected a team manager')
        return cancelTeamInvitation(
          trx,
          { ...actor, role: actor.role, sessionId: f.ownerSession.id },
          f.invitation.id,
        )
      }),
      'cancel invitation',
    )
    await trustedRefused(
      removeTeamMember(db, principal, {
        teamId: f.team,
        expectedOrganizationId: f.team,
        memberUserId: f.member,
      }),
      'remove member',
    )
    await expect(
      leaveTeamMember(
        { db, principal, now: () => Temporal.Now.instant() },
        { teamId: f.team, expectedOrganizationId: f.team },
      ),
    ).rejects.toMatchObject({ code: 'sso_required' })
    expect(await effects(f)).toEqual(before)
  })

  async function grantProof(f: Fixture) {
    const client = await owned.pool.connect()
    try {
      const ownerLink = await link({ ...f, db: client }, f.owner)
      return (
        await insert(client, 'sso_browser_proofs', {
          ...proofValues(f, ownerLink),
          member_id: f.ownerMember,
          session_id: f.ownerSession.id,
        })
      ).id as string
    } finally {
      client.release()
    }
  }

  it('accepts live proof only under its enabled protocol', async () => {
    const f = await fixture()
    await policy(f)
    await grantProof(f)
    const read: Operation = {
      api: 'getOrganization',
      path: 'get-organization',
      query: { organizationId: f.team },
    }
    await refused(await http(off, f, read))
    const accepted = await http(on, f, read)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ id: f.team })
    const update: Operation = {
      api: 'updateOrganization',
      path: 'update',
      body: { organizationId: f.team, data: { name: 'Updated with live proof' } },
    }
    expect((await http(on, f, update)).status).toBe(200)
    expect((await effects(f)).organization).toMatchObject([{ name: 'Updated with live proof' }])
  })

  it('enforces the explicit slug target while the session is in its personal space', async () => {
    const f = await fixture()
    await policy(f)
    const personal = await browser(f.owner, f.ownerPersonal)
    const organizationSlug = f.slug
    for (const [api, path] of [
      ['getOrganization', 'get-organization'],
      ['getFullOrganization', 'get-full-organization'],
      ['getActiveMemberRole', 'get-active-member-role'],
      ['listMembers', 'list-members'],
    ] as const) {
      await refused(
        await http(off, f, { api, path, query: { organizationSlug } }, personal.cookie),
        path,
      )
    }
    await refused(
      await http(
        off,
        f,
        { api: 'setActiveOrganization', path: 'set-active', body: { organizationSlug } },
        personal.cookie,
      ),
    )
    const current = await db
      .selectFrom('auth.session')
      .select('activeOrganizationId')
      .where('id', '=', personal.id)
      .executeTakeFirstOrThrow()
    expect(current.activeOrganizationId).toBe(f.ownerPersonal)
  })

  it('blocks native team selection and reads after SCIM suspension while preserving other spaces', async () => {
    const f = await fixture()
    const personalId = await ensurePersonalOrganization(db, f.member)
    const { id, cookie } = f.memberSession
    await db
      .insertInto('auth.member')
      .values({
        organizationId: f.otherTeam,
        userId: f.member,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    const read: Operation = {
      api: 'getFullOrganization',
      path: 'get-full-organization',
      query: { organizationSlug: f.slug },
    }
    const selection = (body: Record<string, unknown>): Operation => ({
      api: 'setActiveOrganization',
      path: 'set-active',
      body,
    })
    const active = async () =>
      (
        await db
          .selectFrom('auth.session')
          .select('activeOrganizationId')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).activeOrganizationId
    expect((await http(off, f, read, cookie)).status).toBe(200)
    expect(await active()).toBe(f.team)

    await suspendScimMember(db, f.team, f.member)
    const denied = {
      code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
      message: 'team_management_access_denied',
    }
    for (const body of [{ organizationId: f.team }, { organizationSlug: f.slug }]) {
      const response = await http(off, f, selection(body), cookie, personalId)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
      expect(response.headers.getSetCookie()).toEqual([])
      await expect(
        off.api.setActiveOrganization({ body, headers: new Headers({ cookie }) }),
      ).rejects.toMatchObject({ statusCode: 403, body: denied })
    }
    const deniedRead = await http(off, f, read, cookie)
    expect(deniedRead.status).toBe(403)
    expect(await deniedRead.json()).toEqual(denied)

    const organizations = await http(off, f, lists[0], cookie)
    expect(organizations.status).toBe(200)
    expect(
      (await organizations.json()).map((organization: { id: string }) => organization.id).sort(),
    ).toEqual([personalId, f.otherTeam].sort())
    expect(await active()).toBe(f.team)

    const other = await http(off, f, selection({ organizationId: f.otherTeam }), cookie, personalId)
    expect(other.status).toBe(200)
    expect(await active()).toBe(f.otherTeam)
    const personal = await http(
      off,
      f,
      selection({ organizationId: personalId }),
      cookie,
      f.otherTeam,
    )
    expect(personal.status).toBe(200)
    expect(await active()).toBe(personalId)
  })

  it('preserves the membership denial for a caller outside the target team', async () => {
    const f = await fixture()
    const operation: Operation = {
      api: 'getOrganization',
      path: 'get-organization',
      query: { organizationId: f.team },
      recipient: true,
    }
    const unconfigured = await http(off, f, operation)
    expect(unconfigured.status).toBe(403)
    await policy(f)
    const enforced = await http(off, f, operation)
    expect(enforced.status).toBe(unconfigured.status)
    expect(await enforced.text()).toBe(await unconfigured.text())
  })

  it('keeps unscoped creation and deliberate context clearing available', async () => {
    const f = await fixture()
    await policy(f)
    const created = await http(off, f, createOperation(f))
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({ name: 'New synthetic team' })
    const cleared = await http(off, f, {
      api: 'setActiveOrganization',
      path: 'set-active',
      body: { organizationId: null },
    })
    expect(cleared.status).toBe(200)
    expect(await cleared.text()).toBe('null')
    const current = await db
      .selectFrom('auth.session')
      .select('activeOrganizationId')
      .where('id', '=', f.ownerSession.id)
      .executeTakeFirstOrThrow()
    expect(current.activeOrganizationId).toBeNull()
  })

  it.each(['HTTP', 'trusted'] as const)(
    'rechecks proof during %s member removal after waiting for the team lock',
    async (entry) => {
      const f = await fixture()
      await policy(f)
      const proofId = await grantProof(f)
      const before = await effects(f)
      const holder = await owned.pool.connect()
      let pending: Promise<Response> | undefined
      try {
        await holder.query('BEGIN')
        const {
          rows: [{ pid } = { pid: 0 }],
        } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        await holder.query('SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', [f.team])
        const operation: Operation = {
          api: 'removeMember',
          path: 'remove-member',
          body: { organizationId: f.team, memberIdOrEmail: f.memberMember },
        }
        pending =
          entry === 'HTTP' ? http(on, f, operation) : trusted(on, f, operation, false, false)
        void pending.catch(() => {})
        // The competing connection has passed its request check and reached the write lock.
        await vi.waitFor(
          async () => {
            const result = await owned.pool.query<{ blocked: boolean }>(
              `SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))
        ) AS blocked`,
              [pid],
            )
            expect(result.rows[0]?.blocked).toBe(true)
          },
          { interval: 10, timeout: 3_000 },
        )
        await holder.query('DELETE FROM sso_browser_proofs WHERE id = $1', [proofId])
        await holder.query('COMMIT')
        if (entry === 'HTTP') await refused(await pending)
        else await trustedRefused(pending, entry)
        expect(await effects(f)).toEqual(before)
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
        if (pending) await Promise.allSettled([pending])
      }
    },
  )
})
