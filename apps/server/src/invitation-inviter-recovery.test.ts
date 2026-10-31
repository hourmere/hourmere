import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { type Auth, createAuth, createAuthPool } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { leaveTeamMember } from '@hourmere/scheduling'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { manageInvitation } from '../../../packages/auth/src/invitations.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:44831'
const secret = 'synthetic-inviter-recovery-secret-000000000000'
const voidCode = 'INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION'
type Protocol = 'HTTP' | 'trusted API'
type Action = 'resend' | 'expired replacement'
interface Actor {
  userId: string
  sessionId: string
  cookie: string
  activeOrganizationId: string
}

// The mutation only changes a source copy; no production file is rewritten.
async function admissionCopy(disableOriginalInviterCheck = false) {
  const location = new URL('../../../packages/auth/src/invitations.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  if (disableOriginalInviterCheck) {
    const before = ".where('userId', '=', invitation.inviterId)"
    expect(source.includes(before), 'mutation matches the original inviter check').toBe(true)
    source = source.replace(before, ".where('userId', '=', actor.userId)")
  }
  const javascript = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) => {
      let resolved: string
      if (specifier.startsWith('.')) resolved = new URL(specifier, location).href
      else {
        try {
          resolved = import.meta.resolve(specifier)
        } catch {
          resolved = pathToFileURL(createRequire(location).resolve(specifier)).href
        }
      }
      return `from '${resolved}'`
    },
  )
  return (await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  )) as typeof import('../../../packages/auth/src/invitations.ts')
}

describe.skipIf(!serverUrl)('departed original inviter recovery with PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth
  let owner: Actor
  let inviter: Actor
  let originalInviter: TestUser
  let teamId: string
  let invitationId: string
  const enqueue = vi.fn(async () => {})

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'inviter_recovery' })
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, { mode: 'open', allowedDomains: [] })
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup: { mode: 'open', allowedDomains: [] },
      mailer: { send: async () => {} },
      enqueueInvitationEmail: enqueue,
      leaveTeamMember: (principal, teamId, expectedOrganizationId) =>
        leaveTeamMember(
          { db, principal, now: () => Temporal.Now.instant() },
          { teamId, expectedOrganizationId },
        ),
    })
  })

  beforeEach(async () => {
    await db.deleteFrom('auth.organization').execute()
    await db.deleteFrom('auth.user').execute()
    enqueue.mockClear()
    const currentOwner = await createTestUser(db, 'Current owner')
    originalInviter = await createTestUser(db, 'Original inviter')
    teamId = (
      await createTestTeam(db, [
        { user: currentOwner, role: 'owner' },
        { user: originalInviter, role: 'admin' },
      ])
    ).id
    owner = await actor(currentOwner)
    inviter = await actor(originalInviter)
    invitationId = (
      await db
        .insertInto('auth.invitation')
        .values({
          inviterId: inviter.userId,
          organizationId: teamId,
          email: 'recipient@example.test',
          role: 'member',
          status: 'pending',
          createdAt: sql`clock_timestamp() - INTERVAL '5 minutes'`,
          expiresAt: sql`clock_timestamp() + INTERVAL '1 day'`,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    await db
      .insertInto('invitation_deliveries')
      .values({
        invitation_id: invitationId,
        generation: 1,
        authorized_by_user_id: owner.userId,
        state: 'queued',
        generation_started_at: sql`clock_timestamp() - INTERVAL '5 minutes'`,
        updated_at: sql`clock_timestamp() - INTERVAL '5 minutes'`,
      })
      .execute()
  })

  afterAll(async () => {
    try {
      await authPool?.end()
      expect(owned?.pool.totalCount ?? 0).toBeLessThanOrEqual(8)
    } finally {
      await owned?.drop()
    }
  })

  async function actor(user: TestUser): Promise<Actor> {
    const token = randomUUID()
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        updatedAt: new Date(),
        activeOrganizationId: teamId,
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      userId: user.id,
      sessionId: session.id,
      activeOrganizationId: teamId,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  function post(path: string, actor: Actor, body: Record<string, unknown>) {
    return auth.handler(
      new Request(`${origin}/api/auth/organization/${path}`, {
        method: 'POST',
        headers: {
          origin,
          cookie: actor.cookie,
          'content-type': 'application/json',
          'x-expected-organization-id': teamId,
        },
        body: JSON.stringify(body),
      }),
    )
  }

  async function depart(change: 'left' | 'removed' | 'demoted') {
    const response =
      change === 'left'
        ? await post('leave', inviter, { organizationId: teamId })
        : change === 'removed'
          ? await post('remove-member', owner, {
              organizationId: teamId,
              memberIdOrEmail: originalInviter.email,
            })
          : await post('update-member-role', owner, {
              organizationId: teamId,
              memberId: (
                await db
                  .selectFrom('auth.member')
                  .select('id')
                  .where('userId', '=', inviter.userId)
                  .where('organizationId', '=', teamId)
                  .executeTakeFirstOrThrow()
              ).id,
              role: 'member',
            })
    expect(response.status, `${change} must commit through the native endpoint`).toBe(200)
  }

  async function request(action: Action) {
    if (action === 'expired replacement')
      await db
        .updateTable('auth.invitation')
        .set({ expiresAt: sql`clock_timestamp() - INTERVAL '1 second'` })
        .where('id', '=', invitationId)
        .execute()
    return {
      organizationId: teamId,
      invitationId,
      email: 'recipient@example.test',
      role: 'member' as const,
      resend: true,
      expectedGeneration: 1,
      requestId: randomUUID(),
    }
  }

  const rows = () =>
    Promise.all([
      db.selectFrom('auth.invitation').selectAll().where('organizationId', '=', teamId).execute(),
      db.selectFrom('invitation_deliveries').selectAll().execute(),
    ])

  async function recover(protocol: Protocol, body: Awaited<ReturnType<typeof request>>) {
    return protocol === 'HTTP'
      ? post('invite-member', owner, body)
      : auth.api.createInvitation({
          headers: new Headers({ cookie: owner.cookie }),
          body,
          asResponse: true,
        })
  }

  for (const change of ['left', 'removed'] as const) {
    for (const action of ['resend', 'expired replacement'] as const) {
      it.each(['HTTP', 'trusted API'] as const)(
        `refuses ${action} through %s after the original inviter ${change}`,
        async (protocol) => {
          await depart(change)
          const body = await request(action)
          const before = await rows()
          if (protocol === 'trusted API') {
            await expect(recover(protocol, body)).rejects.toMatchObject({
              statusCode: 409,
              body: { code: voidCode },
            })
          } else {
            const response = await recover(protocol, body)
            expect(response.status).toBe(409)
            expect(await response.json()).toMatchObject({ code: voidCode })
          }
          expect(await rows(), 'refusal never rewrites the old link or delivery').toEqual(before)
          expect(enqueue).not.toHaveBeenCalled()
        },
      )
    }
  }

  for (const action of ['resend', 'expired replacement'] as const) {
    it.each(['HTTP', 'trusted API'] as const)(
      `allows ${action} through %s when the original inviter was demoted but remains a member`,
      async (protocol) => {
        await depart('demoted')
        const response = await recover(protocol, await request(action))
        expect(response.status).toBe(200)
        const result = (await response.json()) as { id: string; inviterId: string }
        expect(result.inviterId).toBe(action === 'resend' ? inviter.userId : owner.userId)
        expect(result.id === invitationId).toBe(action === 'resend')
        expect(enqueue).toHaveBeenCalledTimes(1)
      },
    )
  }

  it('refuses an exact successful resend replay after the original inviter leaves', async () => {
    const body = await request('resend')
    expect((await recover('HTTP', body)).status).toBe(200)
    await depart('left')
    const before = await rows()
    enqueue.mockClear()
    expect((await recover('HTTP', body)).status).toBe(409)
    expect(await rows()).toEqual(before)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('lets the current owner create a fresh invitation after canceling the voided link', async () => {
    await depart('removed')
    expect((await post('cancel-invitation', owner, { invitationId })).status).toBe(200)
    const fresh = await post('invite-member', owner, {
      organizationId: teamId,
      email: 'recipient@example.test',
      role: 'member',
    })
    expect(fresh.status).toBe(200)
    const result = (await fresh.json()) as { id: string; inviterId: string }
    expect(result.id).not.toBe(invitationId)
    expect(result.inviterId).toBe(owner.userId)
  })

  async function verifyAdmission(action: Action | 'replay', manage: typeof manageInvitation) {
    const body = await request(action === 'replay' ? 'resend' : action)
    if (action === 'replay') await manageInvitation(db, owner, body)
    await depart('removed')
    const before = await rows()
    const error = await manage(db, owner, body).catch((error: unknown) => error)
    expect(error, 'departed original inviter must block recovery').toMatchObject({
      body: { code: voidCode },
    })
    expect(await rows()).toEqual(before)
  }

  it.each(['resend', 'expired replacement', 'replay'] as const)(
    'passes %s assertions with the unchanged source copy',
    async (action) => verifyAdmission(action, (await admissionCopy()).manageInvitation),
  )

  it.each(['resend', 'expired replacement', 'replay'] as const)(
    'detects removal of the original-inviter check for %s with a real assertion',
    async (action) => {
      await expect(
        verifyAdmission(action, (await admissionCopy(true)).manageInvitation),
      ).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )
})
