import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  createAuth,
  createAuthPool,
  createCallerResolver,
  ensurePersonalOrganization,
  maySignUp,
  type SignupPolicy,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type InvitationMailLimits,
  reserveInvitationEmailBudget,
} from '../../../packages/notifications/src/invitation-mail-limits.ts'
import {
  invitationRecipientHash,
  notificationRecipientHash,
  signInEmailBudget,
  signInRecipientHash,
} from '../../../packages/notifications/src/mail-limits.ts'
import { createApp } from './app.ts'
import type { RouteModule } from './openapi.ts'
import type { teamInvitationRoutes } from './routes/team-invitations.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4387'
const policy: SignupPolicy = { mode: 'closed', allowedDomains: ['allowed.example'] }
const secret = randomBytes(32).toString('base64')
const lifetime = 48 * 3_600_000
const generous: InvitationMailLimits = {
  invitationInviterMaxPerHour: 100,
  invitationInviterMaxPerDay: 200,
  invitationTeamMaxPerHour: 100,
  invitationTeamMaxPerDay: 200,
  mailRecipientMaxPerHour: 100,
  mailRecipientMaxPerDay: 200,
  mailMaxPerHour: 1_000,
}
const denied = { code: 'TEAM_MANAGEMENT_ACCESS_DENIED' }

interface Actor {
  userId: string
  sessionId: string
  organizationId: string
  cookie: string
}
interface Invitation {
  id: string
  email: string
  role: string
  expiresAt: string
  existing: boolean
  delivery: { generation: number; state: string; attempts: number }
}

// Native imports of source copies leave the workspace and other Vitest workers untouched.
function resolveModule(specifier: string, location: URL) {
  if (specifier.startsWith('.')) return new URL(specifier, location).href
  try {
    return import.meta.resolve(specifier)
  } catch {
    // npm keeps the auth-only dependencies beside packages/auth rather than hoisting them.
    return pathToFileURL(createRequire(location).resolve(specifier)).href
  }
}

function moduleUrl(source: string, location: URL, replacements: Record<string, string> = {}) {
  const javascript = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${replacements[specifier] ?? resolveModule(specifier, location)}'`,
  )
  return `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
}

async function authModuleSourceCopy(
  before: string,
  after: string,
  sourceFile = 'invitations.ts',
): Promise<{ createAuth: typeof createAuth; url: string }> {
  const mutationLocation = new URL(`../../../packages/auth/src/${sourceFile}`, import.meta.url)
  const mutationSource = readFileSync(mutationLocation, 'utf8')
  expect(mutationSource.includes(before), 'mutation matches real auth source').toBe(true)
  const mutationUrl = moduleUrl(
    sourceFile === 'invitation-resend.ts'
      ? mutationSource.replaceAll(before, after)
      : mutationSource.replace(before, after),
    mutationLocation,
  )
  const managerLocation = new URL('../../../packages/auth/src/team-management.ts', import.meta.url)
  const managerUrl =
    sourceFile === 'team-management.ts'
      ? mutationUrl
      : moduleUrl(readFileSync(managerLocation, 'utf8'), managerLocation)
  const roleLocation = new URL('../../../packages/auth/src/team-role-policy.ts', import.meta.url)
  const roleSource = readFileSync(roleLocation, 'utf8')
  const roleUrl = moduleUrl(
    sourceFile === 'team-role-policy.ts' ? roleSource.replace(before, after) : roleSource,
    roleLocation,
    { './team-management.ts': managerUrl },
  )
  const resendLocation = new URL('../../../packages/auth/src/invitation-resend.ts', import.meta.url)
  const resendUrl =
    sourceFile === 'invitation-resend.ts'
      ? mutationUrl
      : moduleUrl(readFileSync(resendLocation, 'utf8'), resendLocation)
  const serviceLocation = new URL('../../../packages/auth/src/invitations.ts', import.meta.url)
  const serviceSource = readFileSync(serviceLocation, 'utf8')
  const serviceUrl = moduleUrl(
    sourceFile === 'invitations.ts' ? serviceSource.replace(before, after) : serviceSource,
    serviceLocation,
    {
      './team-management.ts': managerUrl,
      './team-role-policy.ts': roleUrl,
      './invitation-resend.ts': resendUrl,
    },
  )
  const hookLocation = new URL('../../../packages/auth/src/hooks.ts', import.meta.url)
  const hookUrl = moduleUrl(readFileSync(hookLocation, 'utf8'), hookLocation, {
    './invitations.ts': serviceUrl,
    './team-role-policy.ts': roleUrl,
  })
  const authLocation = new URL('../../../packages/auth/src/index.ts', import.meta.url)
  const url = moduleUrl(readFileSync(authLocation, 'utf8'), authLocation, {
    './hooks.ts': hookUrl,
    './team-role-policy.ts': roleUrl,
    './invitation-resend.ts': resendUrl,
  })
  const copy = await import(url)
  return { createAuth: copy.createAuth, url }
}

async function authSourceCopy(before: string, after: string, sourceFile = 'invitations.ts') {
  return (await authModuleSourceCopy(before, after, sourceFile)).createAuth
}

async function sharedAdmissionSourceCopy(before: string, after: string) {
  const auth = await authModuleSourceCopy(before, after, 'invitation-resend.ts')
  const summaryLocation = new URL('./team-invitations.ts', import.meta.url)
  const summaryUrl = moduleUrl(readFileSync(summaryLocation, 'utf8'), summaryLocation, {
    '@hourmere/auth': auth.url,
  })
  const routeLocation = new URL('./routes/team-invitations.ts', import.meta.url)
  const route = await import(
    moduleUrl(readFileSync(routeLocation, 'utf8'), routeLocation, {
      '../team-invitations.ts': summaryUrl,
    })
  )
  return {
    createAuth: auth.createAuth,
    teamInvitationRoutes: route.teamInvitationRoutes as typeof teamInvitationRoutes,
  }
}

describe.skipIf(!serverUrl)('team invitation request limits over real HTTP and PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let pool: pg.Pool
  let limits: InvitationMailLimits
  let reservation: typeof reserveInvitationEmailBudget
  const diagnostics: string[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_limits' })
    db = createDb(owned.pool)
    pool = createAuthPool(owned.url, { mode: 'open', allowedDomains: [] })
  })
  beforeEach(async () => {
    await owned.pool.query('DELETE FROM auth.organization')
    await owned.pool.query('DELETE FROM auth."user"')
    await owned.pool.query('DELETE FROM notification_email_sends')
    await owned.pool.query('DELETE FROM invitation_email_requests')
    limits = { ...generous }
    reservation = reserveInvitationEmailBudget
    diagnostics.length = 0
    for (const method of ['error', 'warn', 'log', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        diagnostics.push(args.map(String).join(' '))
      })
    }
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      await owned?.drop()
    }
  })

  function instance(factory = createAuth, routes: RouteModule[] = []) {
    const auth = factory({
      pool,
      db,
      baseURL: origin,
      secret,
      signup: policy,
      mailer: { send: async () => {} },
      reserveInvitationEmail: (trx, input, now) =>
        reservation(trx, input, { ...limits, secret }, now),
    })
    return {
      auth,
      app: createApp({
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        checkDb: async () => {},
        publicUrl: origin,
        routes,
      }),
    }
  }
  type Instance = ReturnType<typeof instance>

  async function user(email = `${randomUUID()}@outside.example`, verified = true) {
    return db
      .insertInto('auth.user')
      .values({ name: 'Synthetic invitation actor', email, emailVerified: verified })
      .returning('id')
      .executeTakeFirstOrThrow()
  }

  async function team() {
    return db
      .insertInto('auth.organization')
      .values({ name: 'Synthetic invitation team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
  }

  async function actor(role = 'owner', organizationId?: string, userId?: string): Promise<Actor> {
    const id = userId ?? (await user()).id
    const orgId = organizationId ?? (await team()).id
    await db
      .insertInto('auth.member')
      .values({ organizationId: orgId, userId: id, role, createdAt: new Date() })
      .execute()
    const token = randomBytes(24).toString('base64url')
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: id,
        token,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: orgId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      userId: id,
      sessionId: session.id,
      organizationId: orgId,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  function invite(
    i: Instance,
    a: Actor,
    body: Record<string, unknown> = {},
    expected: string | null = a.organizationId,
  ) {
    return i.app.request('/api/auth/organization/invite-member', {
      method: 'POST',
      headers: {
        origin,
        cookie: a.cookie,
        'content-type': 'application/json',
        ...(expected === null ? {} : { 'x-expected-organization-id': expected }),
      },
      body: JSON.stringify({
        email: `${randomUUID()}@outside.example`,
        role: 'member',
        organizationId: a.organizationId,
        ...body,
      }),
    })
  }

  async function created(i: Instance, a: Actor, email?: string) {
    const response = await invite(i, a, email ? { email } : {})
    expect(response.status).toBe(200)
    return (await response.json()) as Invitation
  }

  const resend = (
    i: Instance,
    a: Actor,
    invitation: Invitation,
    body: Record<string, unknown> = {},
  ) =>
    invite(i, a, {
      email: invitation.email,
      invitationId: invitation.id,
      resend: true,
      expectedGeneration: invitation.delivery.generation,
      requestId: randomUUID(),
      ...body,
    })

  async function ageGeneration(invitation: Invitation) {
    await owned.pool.query(
      `UPDATE invitation_deliveries SET generation_started_at = clock_timestamp() - interval '61 seconds',
       updated_at = clock_timestamp() - interval '61 seconds' WHERE invitation_id = $1`,
      [invitation.id],
    )
  }

  async function snapshot(invitationId?: string) {
    const invitations = await owned.pool.query(
      'SELECT * FROM auth.invitation WHERE ($1::uuid IS NULL OR id = $1) ORDER BY id',
      [invitationId ?? null],
    )
    const deliveries = await owned.pool.query(
      'SELECT * FROM invitation_deliveries WHERE ($1::uuid IS NULL OR invitation_id = $1) ORDER BY invitation_id',
      [invitationId ?? null],
    )
    const requests = await owned.pool.query(
      'SELECT * FROM invitation_email_requests ORDER BY requested_at, user_id, organization_id',
    )
    const sends = await owned.pool.query(
      'SELECT * FROM notification_email_sends ORDER BY sent_at, recipient_hash',
    )
    return {
      invitations: invitations.rows,
      deliveries: deliveries.rows,
      requests: requests.rows,
      sends: sends.rows,
    }
  }

  async function error(response: Response, status: number, code: string) {
    expect(response.status).toBe(status)
    const result = await response.json()
    expect(result).toMatchObject({ code })
    expect(JSON.stringify(result)).not.toContain('@')
    return result
  }

  async function verifyInvitationRoles(factory = createAuth, role = 'owner') {
    const i = instance(factory)
    const a = await actor(role)
    const invitation = await created(i, a)
    expect(invitation).toMatchObject({
      role: 'member',
      delivery: { generation: 1, state: 'queued', attempts: 0 },
    })
    for (const requestedRole of [undefined, ['member']]) {
      const response = await invite(i, a, { role: requestedRole })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ role: 'member' })
    }
    const before = await snapshot()
    for (const requestedRole of [null, 'admin', 'owner', 'member,admin', ['member', 'admin']]) {
      await error(await invite(i, a, { role: requestedRole }), 403, denied.code)
    }
    expect(await snapshot()).toEqual(before)
  }

  it.each(['owner', 'admin'])('allows %s to create only member invitations', async (role) => {
    await verifyInvitationRoles(createAuth, role)
  })

  async function invitationContext(current: 'personal' | 'member' | 'unset') {
    const a = await actor('admin')
    const currentId =
      current === 'member' ? (await team()).id : await ensurePersonalOrganization(db, a.userId)
    if (current === 'member') {
      await db
        .insertInto('auth.member')
        .values({
          userId: a.userId,
          organizationId: currentId,
          role: 'member',
          createdAt: new Date(),
        })
        .execute()
    }
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: current === 'unset' ? null : currentId })
      .where('id', '=', a.sessionId)
      .execute()
    return { a, currentId }
  }

  async function verifyInvitationContext(
    factory = createAuth,
    current: 'personal' | 'member' | 'unset' = 'personal',
  ) {
    const i = instance(factory)
    const { a, currentId } = await invitationContext(current)
    const before = await snapshot()
    for (const organizationId of [a.organizationId, currentId, undefined]) {
      await error(await invite(i, a, { organizationId }), 409, 'ORGANIZATION_CONTEXT_CHANGED')
    }
    expect(await snapshot()).toEqual(before)
  }

  it.each(['personal', 'member', 'unset'] as const)(
    'returns a context conflict before the current %s space role when the expected team is managed',
    async (current) => {
      await verifyInvitationContext(createAuth, current)
    },
  )

  it.each(['personal', 'member', 'unset'] as const)(
    'keeps the uniform denial after expected-team administration is revoked in the current %s space',
    async (current) => {
      const i = instance()
      const { a, currentId } = await invitationContext(current)
      await db
        .updateTable('auth.member')
        .set({ role: 'member' })
        .where('organizationId', '=', a.organizationId)
        .where('userId', '=', a.userId)
        .execute()
      const before = await snapshot()
      for (const organizationId of [a.organizationId, currentId, undefined]) {
        await error(await invite(i, a, { organizationId }), 403, denied.code)
      }
      await error(await invite(i, a, {}, randomUUID()), 403, denied.code)
      expect(await snapshot()).toEqual(before)
    },
  )

  it('keeps missing invitation-context headers subject to the existing target authorization', async () => {
    const i = instance()
    const a = await actor('admin')
    await error(await invite(i, a, {}, null), 409, 'ORGANIZATION_CONTEXT_CHANGED')
    const member = await actor('member', a.organizationId)
    await error(await invite(i, member, {}, null), 403, denied.code)
    const { a: switched } = await invitationContext('personal')
    await error(await invite(i, switched, {}, null), 409, 'ORGANIZATION_CONTEXT_CHANGED')
    await error(await invite(i, switched, { organizationId: undefined }, null), 403, denied.code)
  })

  async function verifyInvalidInvitationContext(factory = createAuth) {
    const i = instance(factory)
    const admin = await actor('admin')
    const member = await actor('member', admin.organizationId)
    const before = await snapshot()
    for (const a of [admin, member]) {
      for (const expected of ['', 'invalid', 'malformed@outside.example']) {
        await error(await invite(i, a, {}, expected), 403, denied.code)
      }
    }
    expect(await snapshot()).toEqual(before)
  }

  it('keeps malformed supplied invitation context uniformly denied for administrators and members', async () => {
    await verifyInvalidInvitationContext()
  })

  async function verifyExistingInvitation(factory = createAuth) {
    const i = instance(factory)
    const a = await actor()
    const invitation = await created(i, a)
    expect(invitation.existing, 'a new invitation is not marked as already pending').toBe(false)
    const before = await snapshot()
    const repeated = await invite(i, a, { email: ` ${invitation.email.toUpperCase()} ` })
    expect(repeated.status).toBe(200)
    expect(
      await repeated.json(),
      'an ordinary queued retry identifies its retained pending invitation',
    ).toEqual({ ...invitation, existing: true })
    expect(await snapshot()).toEqual(before)

    await ageGeneration(invitation)
    const requestId = randomUUID()
    const resent = await resend(i, a, invitation, { requestId })
    expect(resent.status).toBe(200)
    const current = (await resent.json()) as Invitation
    expect(current).toMatchObject({
      id: invitation.id,
      existing: true,
      delivery: { generation: 2, state: 'queued' },
    })
    const replayed = await resend(i, a, invitation, { requestId })
    expect(replayed.status).toBe(200)
    expect(await replayed.json()).toEqual(current)
  }

  it('identifies retained pending invitations even when their delivery is queued', async () => {
    await verifyExistingInvitation()
  })

  it('identifies an existing legacy invitation when creating its first delivery metadata', async () => {
    const i = instance()
    const a = await actor()
    const invitation = await created(i, a)
    await db
      .deleteFrom('invitation_deliveries')
      .where('invitation_id', '=', invitation.id)
      .execute()
    const repeated = await invite(i, a, { email: invitation.email })
    expect(repeated.status).toBe(200)
    expect(await repeated.json()).toMatchObject({ id: invitation.id, existing: true })
  })

  async function verifyAlreadyMember(factory = createAuth) {
    const i = instance(factory)
    const a = await actor('admin')
    const member = await actor('member', a.organizationId)
    const joinedEmail = `${randomUUID()}@outside.example`
    const invitation = await created(i, a, joinedEmail)
    await ageGeneration(invitation)
    const joined = await user(joinedEmail)
    await actor('member', a.organizationId, joined.id)
    const existing = await db
      .selectFrom('auth.user')
      .select('email')
      .where('id', 'in', [a.userId, member.userId])
      .execute()
    const before = await snapshot()
    for (const { email } of existing) {
      await error(
        await invite(i, a, { email: ` ${email.toUpperCase()} ` }),
        409,
        'INVITATION_RECIPIENT_ALREADY_MEMBER',
      )
      await error(await invite(i, member, { email }), 403, denied.code)
    }
    await error(await resend(i, a, invitation), 409, 'INVITATION_RECIPIENT_ALREADY_MEMBER')
    expect(await snapshot()).toEqual(before)
  }

  it('refuses current team members on create and resend, including an admin self-invite', async () => {
    await verifyAlreadyMember()
  })

  async function verifyAcceptAlreadyMember(factory = createAuth) {
    const i = instance(factory)
    const owner = await actor('owner')
    const admin = await actor('admin', owner.organizationId)
    const recipient = await db
      .selectFrom('auth.user')
      .select('email')
      .where('id', '=', admin.userId)
      .executeTakeFirstOrThrow()
    await error(
      await invite(i, admin, { email: recipient.email }),
      409,
      'INVITATION_RECIPIENT_ALREADY_MEMBER',
    )
    // Historical invitations may predate the admission guard or a later team join.
    const legacy = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: owner.organizationId,
        inviterId: admin.userId,
        email: recipient.email,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const post = (action: string, actor: Actor, body: Record<string, unknown>) =>
      i.app.request(`/api/auth/organization/${action}`, {
        method: 'POST',
        headers: {
          origin,
          cookie: actor.cookie,
          'content-type': 'application/json',
          'x-expected-organization-id': owner.organizationId,
        },
        body: JSON.stringify(body),
      })
    await error(
      await post('accept-invitation', admin, { invitationId: legacy.id }),
      409,
      'INVITATION_RECIPIENT_ALREADY_MEMBER',
    )
    const memberships = () =>
      db
        .selectFrom('auth.member')
        .select(['id', 'role'])
        .where('organizationId', '=', owner.organizationId)
        .where('userId', '=', admin.userId)
        .execute()
    const rows = await memberships()
    expect(rows).toEqual([{ id: expect.any(String), role: 'admin' }])
    expect(
      (
        await post('remove-member', owner, {
          organizationId: owner.organizationId,
          memberIdOrEmail: rows[0]?.id,
        })
      ).status,
    ).toBe(200)
    expect(await memberships()).toEqual([])
    const me = await i.app.request('/api/v1/me', { headers: { cookie: admin.cookie } })
    expect(me.status).toBe(200)
    const context = (await me.json()) as { organization: { id: string; personal: boolean } }
    expect(context.organization.personal).toBe(true)
    expect(context.organization.id).not.toBe(owner.organizationId)
    await error(await invite(i, admin), 403, denied.code)
  }

  it('refuses legacy self-invitation acceptance so owner removal revokes every team membership and access', async () => {
    await verifyAcceptAlreadyMember()
  })

  async function verifyPendingCap(factory = createAuth) {
    const i = instance(factory)
    const a = await actor()
    await db
      .insertInto('auth.invitation')
      .values(
        Array.from({ length: 99 }, () => ({
          organizationId: a.organizationId,
          inviterId: a.userId,
          email: `${randomUUID()}@outside.example`,
          role: 'member',
          status: 'pending',
          expiresAt: new Date(Date.now() + 3_600_000),
        })),
      )
      .execute()
    const invitation = await created(i, a)
    const before = await snapshot()
    await error(await invite(i, a), 409, 'INVITATION_PENDING_LIMIT')
    expect(await snapshot()).toEqual(before)
    const retry = await invite(i, a, { email: invitation.email })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ id: invitation.id })
    expect(await snapshot()).toEqual(before)
    expect(
      await db
        .selectFrom('auth.invitation')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('organizationId', '=', a.organizationId)
        .where('status', '=', 'pending')
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: '100' })
  }

  it('keeps the native cap of 100 pending invitations per team without spending a refused request', async () => {
    await verifyPendingCap()
  })

  async function verifyDenied(factory = createAuth) {
    const i = instance(factory)
    const manager = await actor('owner')
    const invitation = await created(i, manager)
    await ageGeneration(invitation)
    const member = await actor('member', manager.organizationId)
    const outsider = await actor('owner')
    const unknownRole = await actor('administrator', manager.organizationId)
    const before = await snapshot()
    const answers: unknown[] = []
    for (const a of [
      member,
      { ...outsider, organizationId: manager.organizationId },
      unknownRole,
    ]) {
      for (const body of [
        {},
        {
          email: invitation.email,
          invitationId: invitation.id,
          resend: true,
          expectedGeneration: 1,
          requestId: randomUUID(),
        },
      ]) {
        answers.push(await error(await invite(i, a, body), 403, denied.code))
      }
    }
    expect(answers.every((answer) => JSON.stringify(answer) === JSON.stringify(answers[0]))).toBe(
      true,
    )
    expect(await snapshot()).toEqual(before)
  }

  it('uniformly denies members, other-team owners and unknown roles on create and resend', async () => {
    await verifyDenied()
  })

  it.each(['unverified', 'revoked membership', 'expired session', 'switched organization'])(
    'rechecks %s before a write',
    async (change) => {
      const i = instance()
      const a = await actor()
      const invitation = await created(i, a)
      await ageGeneration(invitation)
      if (change === 'unverified')
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', a.userId)
          .execute()
      if (change === 'revoked membership')
        await db
          .deleteFrom('auth.member')
          .where('userId', '=', a.userId)
          .where('organizationId', '=', a.organizationId)
          .execute()
      if (change === 'expired session')
        await db
          .updateTable('auth.session')
          .set({ expiresAt: new Date(Date.now() - 1_000) })
          .where('id', '=', a.sessionId)
          .execute()
      if (change === 'switched organization')
        await db
          .updateTable('auth.session')
          .set({ activeOrganizationId: (await team()).id })
          .where('id', '=', a.sessionId)
          .execute()
      const before = await snapshot()
      await error(
        await resend(i, a, invitation),
        change === 'switched organization' ? 409 : 403,
        change === 'switched organization' ? 'ORGANIZATION_CONTEXT_CHANGED' : denied.code,
      )
      expect(await snapshot()).toEqual(before)
    },
  )

  it.each([undefined, 'null', 'https://foreign.example'])(
    'denies invitation writes with origin %s before changing rows',
    async (requestOrigin) => {
      const i = instance()
      const a = await actor()
      const invitation = await created(i, a)
      await ageGeneration(invitation)
      const before = await snapshot()
      for (const resendRequest of [false, true]) {
        const response = await i.app.request('/api/auth/organization/invite-member', {
          method: 'POST',
          headers: {
            cookie: a.cookie,
            'content-type': 'application/json',
            'x-expected-organization-id': a.organizationId,
            ...(requestOrigin === undefined ? {} : { origin: requestOrigin }),
          },
          body: JSON.stringify({
            email: invitation.email,
            organizationId: a.organizationId,
            role: 'member',
            ...(resendRequest
              ? { resend: true, expectedGeneration: 1, requestId: randomUUID() }
              : {}),
          }),
        })
        await error(
          response,
          403,
          requestOrigin === undefined || requestOrigin === 'null'
            ? 'MISSING_OR_NULL_ORIGIN'
            : 'INVALID_ORIGIN',
        )
      }
      expect(await snapshot()).toEqual(before)
    },
  )

  async function verifyVerified(factory = createAuth) {
    const i = instance(factory)
    const a = await actor()
    const invitation = await created(i, a)
    await ageGeneration(invitation)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', a.userId)
      .execute()
    const before = await snapshot()
    await error(await resend(i, a, invitation), 403, denied.code)
    expect(await snapshot()).toEqual(before)
  }

  it('uses the same permission and resend protocol for trusted auth.api calls', async () => {
    const i = instance()
    const a = await actor()
    const invitation = await created(i, a)
    await expect(
      i.auth.api.createInvitation({
        headers: new Headers({ cookie: a.cookie }),
        body: {
          organizationId: a.organizationId,
          email: invitation.email,
          role: 'member',
          resend: true,
        },
      }),
    ).rejects.toMatchObject({ body: { code: 'INVALID_INVITATION_REQUEST' } })
    const member = await actor('member', a.organizationId)
    await expect(
      i.auth.api.createInvitation({
        headers: new Headers({ cookie: member.cookie }),
        body: {
          organizationId: a.organizationId,
          email: `${randomUUID()}@outside.example`,
          role: 'member',
        },
      }),
    ).rejects.toMatchObject({ body: denied })
  })

  it.each(['inviter', 'team', 'recipient'] as const)(
    'enforces the rolling %s boundary for create and resend',
    async (boundary) => {
      if (boundary === 'inviter') limits.invitationInviterMaxPerHour = 1
      if (boundary === 'team') limits.invitationTeamMaxPerHour = 1
      if (boundary === 'recipient') limits.mailRecipientMaxPerHour = 1
      const i = instance()
      const a = await actor()
      const invitation = await created(i, a, 'bounded@outside.example')
      await ageGeneration(invitation)
      const b =
        boundary === 'inviter'
          ? await actor('owner', undefined, a.userId)
          : boundary === 'team'
            ? await actor('admin', a.organizationId)
            : await actor('owner')
      const before = await snapshot()
      await error(
        await invite(
          i,
          b,
          boundary === 'recipient' ? { email: invitation.email.toUpperCase() } : {},
        ),
        429,
        'INVITATION_RATE_LIMITED',
      )
      await error(await resend(i, a, invitation), 429, 'INVITATION_RATE_LIMITED')
      expect(await snapshot()).toEqual(before)
    },
  )

  it('uses invitation HMAC identity without spending shared booking or sign-in mail capacity', async () => {
    limits.mailMaxPerHour = 5
    const i = instance()
    const a = await actor()
    const hash = notificationRecipientHash('other@outside.example', secret)
    await db
      .insertInto('notification_email_sends')
      .values(Array.from({ length: 5 }, () => ({ recipient_hash: hash, sent_at: new Date() })))
      .execute()
    const before = (await snapshot()).sends
    const invitation = await created(i, a, 'Reserved@outside.example')
    const after = await snapshot()
    expect(after.sends).toEqual(before)
    expect(after.requests).toHaveLength(1)
    expect(
      after.requests[0].recipient_hash.equals(invitationRecipientHash(invitation.email, secret)),
    ).toBe(true)
    expect(
      after.requests[0].recipient_hash.equals(signInRecipientHash(invitation.email, secret)),
    ).toBe(false)
    expect(
      after.requests[0].recipient_hash.equals(notificationRecipientHash(invitation.email, secret)),
    ).toBe(false)
    await expect(
      signInEmailBudget(
        db,
        limits,
        signInRecipientHash('login@outside.example', secret),
        new Date(),
      ),
    ).resolves.toBeUndefined()
  })

  async function verifyCooldown(factory = createAuth) {
    const i = instance(factory)
    const a = await actor()
    const invitation = await created(i, a)
    const before = await snapshot()
    const response = await resend(i, a, invitation)
    const result = await error(response, 429, 'INVITATION_RESEND_COOLDOWN')
    expect(result).toMatchObject({ retryAfterSeconds: 60 })
    expect(response.headers.get('retry-after')).toBe('60')
    expect(await snapshot()).toEqual(before)
    await verifyExplicitCooldown(factory)
  }

  it('returns a fixed non-leaking cooldown response without spending a budget', async () => {
    await verifyCooldown()
  })

  async function verifyExplicitCooldown(factory = createAuth) {
    const i = instance(factory)
    const a = await actor()
    const invitation = await created(i, a)
    await ageGeneration(invitation)
    const first = await resend(i, a, invitation)
    expect(first.status).toBe(200)
    const current = (await first.json()) as Invitation
    expect(current.delivery.generation).toBe(2)
    const before = await snapshot()
    await error(await resend(i, a, current), 429, 'INVITATION_RESEND_COOLDOWN')
    expect(await snapshot()).toEqual(before)
    // A stale worker timestamp must not move a newer generation's anchor backwards.
    await owned.pool.query(
      `UPDATE invitation_deliveries SET updated_at = clock_timestamp() - interval '61 seconds'
       WHERE invitation_id = $1`,
      [invitation.id],
    )
    const staleTimestamp = await snapshot()
    await error(await resend(i, a, current), 429, 'INVITATION_RESEND_COOLDOWN')
    expect(await snapshot()).toEqual(staleTimestamp)
  }

  it('delays the next explicit resend after an explicit generation change', async () => {
    await verifyExplicitCooldown()
  })

  async function verifyWorkerCooldown(factory = createAuth) {
    const i = instance(factory)
    const a = await actor()
    const invitation = await created(i, a)
    await ageGeneration(invitation)
    // No sender exists yet. Persist the completed worker-attempt state without SMTP.
    await owned.pool.query(
      `UPDATE invitation_deliveries SET state = 'failed', attempts = 1,
       last_error_code = 'transport_error', updated_at = clock_timestamp()
       WHERE invitation_id = $1`,
      [invitation.id],
    )
    const before = await snapshot()
    await error(await resend(i, a, invitation), 429, 'INVITATION_RESEND_COOLDOWN')
    expect(await snapshot()).toEqual(before)
    await ageGeneration(invitation)
    expect((await resend(i, a, invitation)).status).toBe(200)
  }

  it('delays an explicit resend after a worker delivery attempt even when its generation is old', async () => {
    await verifyWorkerCooldown()
  })

  it.each([
    {},
    { expectedGeneration: 1 },
    { requestId: randomUUID() },
    { expectedGeneration: 0, requestId: randomUUID() },
    { expectedGeneration: 33, requestId: randomUUID() },
    { expectedGeneration: 1.5, requestId: randomUUID() },
    { expectedGeneration: 1, requestId: 'recipient@outside.example' },
  ])('rejects malformed resend protocol %j before changing any rows', async (protocol) => {
    const i = instance()
    const a = await actor()
    const invitation = await created(i, a)
    await ageGeneration(invitation)
    const before = await snapshot()
    await error(
      await invite(i, a, {
        email: invitation.email,
        invitationId: invitation.id,
        resend: true,
        ...protocol,
      }),
      400,
      'INVALID_INVITATION_REQUEST',
    )
    expect(await snapshot()).toEqual(before)
  })

  it('requires an explicit invitation ID even when the recipient matches an existing invitation', async () => {
    const i = instance()
    const a = await actor()
    const invitation = await created(i, a)
    await ageGeneration(invitation)
    const before = await snapshot()
    await error(
      await invite(i, a, {
        email: invitation.email,
        resend: true,
        expectedGeneration: 1,
        requestId: randomUUID(),
      }),
      400,
      'INVALID_INVITATION_REQUEST',
    )
    expect(await snapshot()).toEqual(before)
  })

  async function verifyResendProtocol(factory = createAuth) {
    const i = instance(factory)
    const a = await actor()
    let invitation = await created(i, a)
    await owned.pool.query(
      `UPDATE auth.invitation SET "expiresAt" = clock_timestamp() + interval '1 hour' WHERE id = $1`,
      [invitation.id],
    )
    await ageGeneration(invitation)
    const beforeResend = await db
      .selectFrom('auth.invitation')
      .selectAll()
      .where('id', '=', invitation.id)
      .executeTakeFirstOrThrow()
    const requestId = randomUUID()
    const first = await resend(i, a, invitation, { requestId })
    expect(first.status).toBe(200)
    invitation = (await first.json()) as Invitation
    expect(invitation.delivery).toMatchObject({ generation: 2, attempts: 0, state: 'queued' })
    expect(invitation.expiresAt).toBe(beforeResend.expiresAt.toISOString())
    expect(
      await db
        .selectFrom('auth.invitation')
        .selectAll()
        .where('id', '=', invitation.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeResend)
    const after = await snapshot()
    const replay = await resend(i, a, invitation, { expectedGeneration: 1, requestId })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(invitation)
    const uppercaseReplay = await resend(i, a, invitation, {
      expectedGeneration: 1,
      requestId: requestId.toUpperCase(),
    })
    expect(uppercaseReplay.status).toBe(200)
    expect(await uppercaseReplay.json()).toEqual(invitation)
    expect(await snapshot()).toEqual(after)
    await error(
      await resend(i, a, invitation, { expectedGeneration: 1 }),
      409,
      'INVITATION_CONFLICT',
    )
    expect(await snapshot()).toEqual(after)
    await ageGeneration(invitation)
    const second = await resend(i, a, invitation)
    expect(second.status).toBe(200)
    const updated = (await second.json()) as Invitation
    expect(updated.id).toBe(invitation.id)
    expect(updated.delivery.generation).toBe(3)
    expect(updated.expiresAt).toBe(beforeResend.expiresAt.toISOString())
    const advanced = await snapshot()
    await error(
      await resend(i, a, updated, { expectedGeneration: 1, requestId }),
      409,
      'INVITATION_CONFLICT',
    )
    expect(await snapshot()).toEqual(advanced)
  }

  async function verifyLegacyDuration(factory = createAuth, storedDelivery = false) {
    const i = instance(factory)
    const a = await actor()
    const row = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: a.organizationId,
        inviterId: a.userId,
        email: `${randomUUID()}@outside.example`,
        role: 'member',
        status: 'pending',
        // Native historical resends changed expiresAt while retaining the original createdAt.
        createdAt: new Date(Date.now() - 10 * 86_400_000),
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    if (storedDelivery) {
      await db
        .insertInto('invitation_deliveries')
        .values({
          invitation_id: row.id,
          state: 'failed',
          last_error_code: 'legacy_delivery_unknown',
          generation_started_at: new Date(Date.now() - 3_600_000),
          updated_at: new Date(Date.now() - 3_600_000),
          expiry_duration_ms: lifetime,
        })
        .execute()
    }
    const invitation: Invitation = {
      id: row.id,
      existing: true,
      email: row.email,
      role: 'member',
      expiresAt: row.expiresAt.toISOString(),
      delivery: { generation: 1, state: storedDelivery ? 'failed' : 'unknown', attempts: 0 },
    }
    const response = await resend(i, a, invitation)
    expect(response.status).toBe(200)
    const resent = (await response.json()) as Invitation
    expect(resent.expiresAt).toBe(row.expiresAt.toISOString())
    expect(
      await db
        .selectFrom('auth.invitation')
        .selectAll()
        .where('id', '=', row.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(row)
    expect(resent).toMatchObject({
      id: row.id,
      delivery: { generation: 2, attempts: 0, state: 'queued' },
    })
    const stored = await db
      .selectFrom('invitation_deliveries')
      .select('expiry_duration_ms')
      .where('invitation_id', '=', row.id)
      .executeTakeFirstOrThrow()
    expect(Number(stored.expiry_duration_ms)).toBe(lifetime)
  }

  it.each([false, true])(
    'preserves legacy invitation expiry when resending (delivery record %s)',
    async (storedDelivery) => {
      await verifyLegacyDuration(createAuth, storedDelivery)
    },
  )

  async function verifyPinnedDuration(factory = createAuth) {
    const i = instance(factory)
    const a = await actor()
    const invitation = await created(i, a)
    const pinnedDuration = 3 * 3_600_000
    await db
      .updateTable('invitation_deliveries')
      .set({ expiry_duration_ms: pinnedDuration })
      .where('invitation_id', '=', invitation.id)
      .execute()
    await ageGeneration(invitation)
    const response = await resend(i, a, invitation)
    expect(response.status).toBe(200)
    const resent = (await response.json()) as Invitation
    expect(resent.expiresAt).toBe(invitation.expiresAt)
    const stored = await db
      .selectFrom('invitation_deliveries')
      .select('expiry_duration_ms')
      .where('invitation_id', '=', invitation.id)
      .executeTakeFirstOrThrow()
    expect(Number(stored.expiry_duration_ms)).toBe(pinnedDuration)
  }

  it('retains legacy duration metadata without using it to change expiry', async () => {
    await verifyPinnedDuration()
  })

  it('preserves business expiry across generations and replays one request unchanged', async () => {
    await verifyResendProtocol()
  })

  it('serializes competing resends and duplicate clicks to one generation and one budget debit', async () => {
    const i = instance()
    const a = await actor()
    const invitation = await created(i, a)
    await ageGeneration(invitation)
    const requestId = randomUUID()
    const repeated = await Promise.all([
      resend(i, a, invitation, { requestId }),
      resend(i, a, invitation, { requestId }),
    ])
    expect(repeated.map((response) => response.status)).toEqual([200, 200])
    expect(await repeated[0]?.json()).toEqual(await repeated[1]?.json())
    const current = (await snapshot(invitation.id)).deliveries[0]
    expect(current.generation).toBe(2)
    expect((await snapshot()).requests).toHaveLength(2)
    const next = { ...invitation, delivery: { ...invitation.delivery, generation: 2 } }
    await ageGeneration(invitation)
    const competing = await Promise.all([resend(i, a, next), resend(i, a, next)])
    expect(competing.map((response) => response.status).sort()).toEqual([200, 409])
    expect((await snapshot(invitation.id)).deliveries[0].generation).toBe(3)
    expect((await snapshot()).requests).toHaveLength(3)
  })

  it('grants fresh attempts only to a new generation and preserves SMTP receipts on request replay', async () => {
    const i = instance()
    const a = await actor()
    const invitation = await created(i, a)
    await db
      .updateTable('invitation_deliveries')
      .set({ state: 'failed', attempts: 4, last_error_code: 'attempts_exhausted' })
      .where('invitation_id', '=', invitation.id)
      .execute()
    await ageGeneration(invitation)
    const requestId = randomUUID()
    const response = await resend(i, a, invitation, { requestId })
    expect(response.status).toBe(200)
    const current = (await response.json()) as Invitation
    expect(current.delivery).toEqual({ generation: 2, attempts: 0, state: 'queued' })
    await db
      .updateTable('invitation_deliveries')
      .set({ state: 'smtp_accepted', attempts: 1, smtp_accepted_at: new Date() })
      .where('invitation_id', '=', invitation.id)
      .execute()
    const before = await snapshot()
    const replay = await resend(i, a, current, { requestId, expectedGeneration: 1 })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({
      id: invitation.id,
      delivery: { generation: 2, attempts: 1, state: 'smtp_accepted' },
    })
    expect(await snapshot()).toEqual(before)
  })

  async function verifyGenerationCap(factory = createAuth) {
    const i = instance(factory)
    const a = await actor()
    const invitation = await created(i, a)
    await ageGeneration(invitation)
    await db
      .updateTable('invitation_deliveries')
      .set({ generation: 32 })
      .where('invitation_id', '=', invitation.id)
      .execute()
    const before = await snapshot()
    await error(
      await resend(i, a, invitation, { expectedGeneration: 32 }),
      409,
      'INVITATION_GENERATION_LIMIT',
    )
    expect(await snapshot()).toEqual(before)
  }

  it('refuses a thirty-third generation without renewing expiry or spending a budget', async () => {
    await verifyGenerationCap()
  })

  async function verifyIneligible(factory = createAuth) {
    const i = instance(factory)
    const a = await actor()
    for (const state of ['accepted', 'canceled', 'rejected']) {
      const invitation = await created(i, a)
      await ageGeneration(invitation)
      await db
        .updateTable('auth.invitation')
        .set(state === 'expired' ? { expiresAt: new Date(Date.now() - 1_000) } : { status: state })
        .where('id', '=', invitation.id)
        .execute()
      const before = await snapshot()
      await error(await resend(i, a, invitation), 409, 'INVITATION_INELIGIBLE')
      expect(await snapshot()).toEqual(before)
    }
  }

  it('never revives accepted, canceled or rejected invitation IDs', async () => {
    await verifyIneligible()
  })

  async function verifyBusy(factory = createAuth) {
    const i = instance(factory)
    const a = await actor()
    const invitation = await created(i, a)
    await ageGeneration(invitation)
    await db
      .updateTable('invitation_deliveries')
      .set({
        state: 'sending',
        attempts: 1,
        lease_id: randomUUID(),
        lease_until: new Date(Date.now() + 120_000),
      })
      .where('invitation_id', '=', invitation.id)
      .execute()
    const before = await snapshot()
    await error(await resend(i, a, invitation), 409, 'INVITATION_DELIVERY_BUSY')
    expect(await snapshot()).toEqual(before)
  }

  it('preserves a live sending lease and its consumed attempt', async () => {
    await verifyBusy()
  })

  it('ordinary create retries preserve delivery tombstones and never renew or spend another budget', async () => {
    const i = instance()
    const a = await actor()
    const invitation = await created(i, a)
    await db
      .updateTable('invitation_deliveries')
      .set({ state: 'failed', attempts: 4, last_error_code: 'attempts_exhausted' })
      .where('invitation_id', '=', invitation.id)
      .execute()
    const before = await snapshot()
    const response = await invite(i, a, { email: invitation.email })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: invitation.id,
      delivery: { generation: 1, attempts: 4, state: 'failed' },
    })
    expect(await snapshot()).toEqual(before)
  })

  async function verifyRollback(factory = createAuth) {
    const i = instance(factory)
    const a = await actor()
    reservation = async (...args) => {
      await reserveInvitationEmailBudget(...args)
      throw new Error('sensitive-recipient@outside.example synthetic provider diagnostic')
    }
    const before = await snapshot()
    const response = await invite(i, a, { email: 'sensitive-recipient@outside.example' })
    await error(response, 500, 'INVITATION_REQUEST_FAILED')
    expect(await snapshot()).toEqual(before)
    expect(diagnostics.join('\n')).not.toContain('@')
  }

  async function verifyFenceExpiry(factory = createAuth) {
    const i = instance(factory)
    const a = await actor()
    const invitation = await created(i, a)
    await db
      .deleteFrom('invitation_deliveries')
      .where('invitation_id', '=', invitation.id)
      .execute()
    await db
      .updateTable('auth.invitation')
      .set({ expiresAt: new Date(Date.now() + 1_500) })
      .where('id', '=', invitation.id)
      .execute()
    const before = await snapshot()
    const blocker = await owned.pool.connect()
    const reached = Promise.withResolvers<void>()
    reservation = async (...args) => {
      reached.resolve()
      return reserveInvitationEmailBudget(...args)
    }
    let pending: Promise<Response> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock(1852798057, 1835100524)')
      pending = Promise.resolve(
        invite(i, a, { email: invitation.email, invitationId: invitation.id }),
      )
      expect(
        await Promise.race([
          reached.promise.then(() => 'waiting'),
          pending.then(() => 'completed'),
        ]),
      ).toBe('waiting')
      await owned.pool.query('SELECT pg_sleep(1.6)')
      await blocker.query('COMMIT')
      await error(await pending, 409, 'INVITATION_INELIGIBLE')
      expect(await snapshot()).toEqual(before)
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await pending
    }
  }

  it('rechecks expiry after waiting for the global mail fence and rolls back reservations', async () => {
    await verifyFenceExpiry()
  })

  it('rolls back invitation, delivery and budget writes when the reservation fails after writing', async () => {
    await verifyRollback()
  })

  it('treats existing non-members and disallowed new accounts identically without changing signup policy', async () => {
    await user('bootstrap@outside.example')
    const i = instance()
    const a = await actor()
    const existing = 'existing@outside.example'
    const absent = 'new@outside.example'
    await user(existing)
    await expect(maySignUp(db, policy, absent)).resolves.toBe(false)
    const invitations: Invitation[] = []
    for (const email of [existing, absent]) {
      const invitation = await created(i, a, email)
      expect(invitation.delivery).toEqual({ generation: 1, state: 'queued', attempts: 0 })
      invitations.push(invitation)
    }
    const cooldowns: unknown[] = []
    for (const invitation of invitations)
      cooldowns.push(await error(await resend(i, a, invitation), 429, 'INVITATION_RESEND_COOLDOWN'))
    expect(cooldowns[0]).toEqual(cooldowns[1])
    await expect(maySignUp(db, policy, absent)).resolves.toBe(false)
    await expect(maySignUp(db, policy, `${randomUUID()}@allowed.example`)).resolves.toBe(true)
    await user('account@outside.example')
    limits.invitationInviterMaxPerHour = 2
    const failures: unknown[] = []
    for (const invitation of invitations) {
      await ageGeneration(invitation)
      failures.push(await error(await resend(i, a, invitation), 429, 'INVITATION_RATE_LIMITED'))
    }
    for (const email of ['account@outside.example', 'absent@outside.example']) {
      failures.push(await error(await invite(i, a, { email }), 429, 'INVITATION_RATE_LIMITED'))
    }
    expect(
      failures.every((failure) => JSON.stringify(failure) === JSON.stringify(failures[0])),
    ).toBe(true)
    const log = diagnostics.join('\n')
    for (const email of [existing, absent, 'account@outside.example', 'absent@outside.example'])
      expect(log).not.toContain(email)
    expect(log).not.toContain('@')
  })

  it('detects removal of the invitation hook origin guard in a source copy', async () => {
    const location = new URL('../../../packages/auth/src/invitations.ts', import.meta.url)
    const source = readFileSync(location, 'utf8')
    const guard =
      "if (ctx.request && ctx.request.headers.get('origin') !== new URL(ctx.context.baseURL).origin)"
    expect(source.includes(guard)).toBe(true)
    const a = await actor()
    const context = {
      path: '/organization/invite-member',
      request: new Request(origin, {
        headers: {
          origin: 'https://foreign.example',
          'x-expected-organization-id': a.organizationId,
        },
      }),
      context: {
        baseURL: origin,
        session: {
          user: { id: a.userId },
          session: { id: a.sessionId, activeOrganizationId: a.organizationId },
        },
      },
      body: {
        organizationId: a.organizationId,
        email: 'hook-origin@outside.example',
        role: 'member',
      },
      json: (value: unknown) => value,
    }
    const verify = async (
      rules: typeof import('../../../packages/auth/src/invitations.ts')['invitationRules'],
    ) => {
      await expect(rules(context as never, db)).rejects.toMatchObject({
        statusCode: 403,
        body: denied,
      })
    }
    const baseline = await import(moduleUrl(source, location))
    await verify(baseline.invitationRules)
    const mutant = await import(moduleUrl(source.replace(guard, 'if (false)'), location))
    await expect(verify(mutant.invitationRules)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  // The baseline and each mutant run the same assertions against real HTTP + DB behavior.
  it('runs an unchanged invitation source copy through every protocol protection', async () => {
    const token = 'INVITATION_GENERATION_LIMIT'
    const copy = await authSourceCopy(token, token)
    await verifyDenied(copy)
    await verifyInvitationRoles(copy)
    await verifyVerified(copy)
    await verifyAlreadyMember(copy)
    await verifyAcceptAlreadyMember(copy)
    await verifyPendingCap(copy)
    await verifyCooldown(copy)
    await verifyWorkerCooldown(copy)
    await verifyResendProtocol(copy)
    await verifyLegacyDuration(copy)
    await verifyPinnedDuration(copy)
    await verifyGenerationCap(copy)
    await verifyIneligible(copy)
    await verifyBusy(copy)
    await verifyFenceExpiry(copy)
    await verifyRollback(copy)
  }, 30_000)

  it.each([
    {
      rule: 'role',
      before: 'if (!invitationRoleAllowed(invitation.role))',
      after: 'if (false)',
      status: 403,
      code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
    },
    {
      rule: 'pending status',
      before: "if (invitation.status !== 'pending') return",
      after: 'if (false) return',
      status: 409,
      code: 'INVITATION_INELIGIBLE',
    },
    {
      rule: 'recipient membership',
      before: 'return Boolean(member)',
      after: 'return false',
      status: 409,
      code: 'INVITATION_RECIPIENT_ALREADY_MEMBER',
    },
  ])(
    'detects one shared $rule mutation in both the HTTP summary and real resend',
    async ({ rule, before, after, status, code }) => {
      for (const mutate of [false, true]) {
        const copy = await sharedAdmissionSourceCopy(before, mutate ? after : before)
        const i = instance(copy.createAuth, [
          copy.teamInvitationRoutes({ db, invitationMailLimits: { ...limits, secret } }),
        ])
        const a = await actor()
        const invitation = await created(i, a)
        await ageGeneration(invitation)
        if (rule === 'recipient membership') {
          const joined = await user(invitation.email)
          await actor('member', a.organizationId, joined.id)
        } else {
          await db
            .updateTable('auth.invitation')
            .set(
              rule === 'role'
                ? { role: 'admin' }
                : rule === 'expiry'
                  ? { expiresAt: new Date(Date.now() - 1_000) }
                  : { status: 'canceled' },
            )
            .where('id', '=', invitation.id)
            .execute()
        }
        const summaryDenied = async () => {
          const response = await i.app.request('/api/v1/team/invitations', {
            headers: { cookie: a.cookie },
          })
          expect(response.status).toBe(200)
          const page = (await response.json()) as {
            data: { id: string; resendAllowed: boolean }[]
          }
          expect(page.data.find((entry) => entry.id === invitation.id)?.resendAllowed).toBe(false)
        }
        const resendDenied = async () => {
          await error(await resend(i, a, invitation), status, code)
        }
        if (mutate) {
          // Run both independently: an early summary failure cannot hide write-path drift.
          await expect(summaryDenied()).rejects.toMatchObject({ name: 'AssertionError' })
          await expect(resendDenied()).rejects.toMatchObject({ name: 'AssertionError' })
        } else {
          await summaryDenied()
          await resendDenied()
        }
      }
    },
  )
  it.each<[string, string, string, (factory: typeof createAuth) => Promise<void>, string?]>([
    [
      'malformed invitation expected-team denial',
      '!isUuid(options.expectedOrganizationId)',
      'false',
      verifyInvalidInvitationContext,
    ],
    [
      'invitation expected-team authorization before the current team role',
      'options.requireContext && options.expectedOrganizationId',
      'false',
      verifyInvitationContext,
    ],
    [
      'existing pending invitation marker',
      'const existing = Boolean(invitation)',
      'const existing = false',
      verifyExistingInvitation,
    ],
    [
      'verified actor check',
      'if (!user?.emailVerified) throw denied()',
      'if (!user) throw denied()',
      verifyVerified,
      'team-management.ts',
    ],
    [
      'role authorization',
      'if (!role) throw denied()',
      'if (false) throw denied()',
      verifyDenied,
      'team-management.ts',
    ],
    [
      'current member admission guard',
      'if (recipient) throw recipientAlreadyMember()',
      'if (false) throw recipientAlreadyMember()',
      verifyAlreadyMember,
    ],
    [
      'fixed invitation member role',
      "if (fixedTeamRole(input.role === undefined ? 'member' : input.role) !== 'member') throw denied()",
      'if (false) throw denied()',
      verifyInvitationRoles,
    ],
    [
      'current member acceptance guard',
      'if (member) throw recipientAlreadyMember()',
      'if (false) throw recipientAlreadyMember()',
      verifyAcceptAlreadyMember,
      'team-role-policy.ts',
    ],
    ['pending invitation cap', 'if (Number(pending.count) >= 100)', 'if (false)', verifyPendingCap],
    [
      'worker attempt cooldown anchor',
      '(delivery?.updated_at ?? invitation.createdAt).getTime(),',
      '0,',
      verifyWorkerCooldown,
      'invitation-resend.ts',
    ],
    [
      'explicit generation cooldown anchor',
      '(delivery?.generation_started_at ?? invitation.createdAt).getTime(),',
      '0,',
      verifyExplicitCooldown,
      'invitation-resend.ts',
    ],
    [
      'resend cooldown',
      'now.getTime() - started.getTime() < 60_000',
      'now.getTime() - started.getTime() < 0',
      verifyCooldown,
      'invitation-resend.ts',
    ],
    [
      'expected generation comparison',
      'generation !== input.expectedGeneration',
      'false',
      verifyResendProtocol,
    ],
    [
      'request replay identity',
      'generation === (input.expectedGeneration as number) + 1',
      'generation === (input.expectedGeneration as number) + 2',
      verifyResendProtocol,
    ],
    [
      'generation cap',
      'if (generation >= 32)',
      'if (false)',
      verifyGenerationCap,
      'invitation-resend.ts',
    ],
    [
      'resend expiry preservation',
      'const duration = Number(delivery?.expiry_duration_ms ?? lifetime)',
      `const duration = Number(delivery?.expiry_duration_ms ?? lifetime)
      if (resend) {
        invitation = await trx.updateTable('auth.invitation')
          .set({ expiresAt: new Date(now.getTime() + duration) })
          .where('id', '=', invitation.id).returningAll().executeTakeFirstOrThrow()
      }`,
      verifyResendProtocol,
    ],
    [
      'persisted original validity duration',
      'delivery?.expiry_duration_ms ??',
      'undefined ??',
      verifyPinnedDuration,
    ],
    [
      'known legacy validity interval',
      'delivery?.expiry_duration_ms ?? lifetime',
      'delivery?.expiry_duration_ms ?? Math.max(1, invitation.expiresAt.getTime() - invitation.createdAt.getTime())',
      verifyLegacyDuration,
    ],
    [
      'business lifecycle guard',
      "if (invitation.status !== 'pending') return",
      'if (false) return',
      verifyIneligible,
      'invitation-resend.ts',
    ],
    [
      'live sending lease',
      "delivery?.state === 'sending' && delivery.lease_until && delivery.lease_until > now",
      'false',
      verifyBusy,
      'invitation-resend.ts',
    ],
    [
      'expiry recheck after the global mail fence',
      "if (admissionDenial === 'INVITATION_INELIGIBLE') throw ineligible()",
      '',
      verifyFenceExpiry,
    ],
    [
      'reservation failure rollback',
      '!(await options.reserve(trx, { userId: actor.userId, organizationId, email }, now))',
      '!(await options.reserve(trx, { userId: actor.userId, organizationId, email }, now).catch(() => true))',
      verifyRollback,
    ],
    [
      'redacted unexpected failure response',
      "code: 'INVITATION_REQUEST_FAILED'",
      'code: String(error)',
      verifyRollback,
    ],
  ])(
    'detects removed %s in a source copy through a real assertion failure',
    async (_label, before, after, verify, sourceFile) => {
      const copy = await authSourceCopy(before, after, sourceFile)
      await expect(verify(copy)).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )
})
