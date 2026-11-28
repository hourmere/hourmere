import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { productRoutes } from '../server.ts'
import {
  bindingCookieName,
  deliverMailboxProof,
  MAILBOX_PROOF_CONSUME_PATH,
  MAILBOX_PROOF_SEND_PATH,
  MailboxProofEmailPayload,
  mailboxProofRoutes,
} from '../sso-mailbox-proof.ts'
import { EXPECTED_ORGANIZATION_HEADER } from '../team-management.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'http://localhost:4393'
const secret = 'synthetic-ownership-transfer-rest-test-only-secret'
const protocolsOff = { ssoOidcEnabled: false, ssoSamlEnabled: false }
const denied = 'team_management_access_denied'

type Login = { cookie: string; sessionId: string; membershipId: string; user: TestUser }
type Receipt = { id: string; expiresAt: string }
type Application = ReturnType<typeof createApp>

const path = (teamId: string) => `/api/v1/teams/${teamId}/ownership-transfer`

function call(
  app: Application,
  teamId: string,
  login: Login | undefined,
  options: {
    method?: 'GET' | 'POST'
    suffix?: string
    body?: unknown
    expected?: string | null
    origin?: string | null
    extraHeaders?: Record<string, string>
  } = {},
) {
  const headers = new Headers(options.extraHeaders)
  if (login) headers.set('cookie', login.cookie)
  if (options.expected !== null)
    headers.set(EXPECTED_ORGANIZATION_HEADER, options.expected ?? teamId)
  if (options.origin !== null) headers.set('origin', options.origin ?? publicUrl)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return app.request(`${path(teamId)}${options.suffix ?? ''}`, {
    method: options.method ?? 'GET',
    headers,
    body: JSON.stringify(options.body),
  })
}

async function expectError(response: Response, status: number, error: string) {
  expect(response.status).toBe(status)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.has('www-authenticate')).toBe(false)
  expect(await response.json()).toEqual({ error })
}

describe.skipIf(!serverUrl)('ownership transfer REST', () => {
  let owned: TestDatabase
  let db: Db
  let auth: Auth
  let authPool: ReturnType<typeof createAuthPool>
  let app: Application
  let mails: MailMessage[]

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'owner_xfer_rest' })
    owned.pool.options.max = 8
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    authPool = createAuthPool(owned.url, signup)
    authPool.options.max = 8
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => expect.unreachable('Tests use the fake proof mailer') },
    })
    mails = []
    app = application(true)
  })

  afterAll(async () => {
    try {
      await authPool?.end()
    } finally {
      await owned?.drop()
    }
  })

  function application(enabled: boolean, onResolve = () => {}) {
    const resolve = createCallerResolver({ auth, db })
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: (headers) => {
        onResolve()
        return resolve(headers)
      },
      publicUrl,
      ssoTeamReads: { db, capabilities: protocolsOff },
      ssoMailboxProof: mailboxProofRoutes({
        db,
        capabilities: protocolsOff,
        ownershipTransferEnabled: enabled,
        queue: {
          enqueue: async (_job, payload) => {
            await deliverMailboxProof(
              {
                db,
                capabilities: protocolsOff,
                ownershipTransferEnabled: enabled,
                mailer: { send: async (message) => void mails.push(message) },
                publicUrl,
                secret,
                mailMaxPerHour: 0,
              },
              MailboxProofEmailPayload.parse(payload),
            )
            return randomUUID()
          },
        },
      }),
      routes: productRoutes({
        db,
        publicUrl,
        socialProviders: {},
        invitationMailLimits: { secret },
        ...(enabled && {
          ownershipTransfer: {
            db,
            capabilities: protocolsOff,
            publicUrl,
            notificationQueue: { enqueue: async () => randomUUID() },
          },
        }),
      }),
    })
  }

  async function login(user: TestUser, teamId: string): Promise<Login> {
    const token = randomBytes(24).toString('base64url')
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        activeOrganizationId: teamId,
        expiresAt: sql`clock_timestamp() + interval '1 hour'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const membership = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', teamId)
      .where('userId', '=', user.id)
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      user,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
      sessionId: session.id,
      membershipId: membership.id,
    }
  }

  async function team() {
    const owner = await createTestUser(db, 'Offering owner')
    const recipient = await createTestUser(db, 'Named recipient')
    const other = await createTestUser(db, 'Other owner')
    const bystander = await createTestUser(db, 'Unrelated member')
    const { id } = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: recipient, role: 'member' },
      { user: other, role: 'owner' },
      { user: bystander, role: 'member' },
    ])
    return {
      id,
      owner: await login(owner, id),
      recipient: await login(recipient, id),
      other: await login(other, id),
      bystander: await login(bystander, id),
    }
  }
  type Team = Awaited<ReturnType<typeof team>>

  async function mailbox(login: Login, challenge: Response) {
    expect(challenge.status).toBe(403)
    const proof = (await challenge.json()) as {
      error: string
      attemptId: string
      proofMethods: string[]
      expiresAt: string
    }
    expect(proof).toEqual({
      error: 'sso_reauthentication_required',
      attemptId: expect.any(String),
      proofMethods: ['mailbox'],
      expiresAt: expect.any(String),
    })
    const binding = challenge.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${bindingCookieName(publicUrl)}=`))
      ?.split(';')[0]
    if (binding) login.cookie += `; ${binding}`
    const headers = { origin: publicUrl, cookie: login.cookie, 'content-type': 'application/json' }
    const sent = await app.request(MAILBOX_PROOF_SEND_PATH, {
      method: 'POST',
      headers,
      body: JSON.stringify({ attemptId: proof.attemptId }),
    })
    expect(sent.status).toBe(202)
    const message = mails.at(-1)
    expect(message?.to).toBe(login.user.email)
    const token = /#attempt=[0-9a-f-]+&token=([A-Za-z0-9_-]+)/.exec(message?.text ?? '')?.[1]
    if (!token) throw new Error('Expected a mailbox proof token in synthetic test mail')
    const consumed = await app.request(MAILBOX_PROOF_CONSUME_PATH, {
      method: 'POST',
      headers,
      body: JSON.stringify({ attemptId: proof.attemptId, token }),
    })
    expect(consumed.status).toBe(200)
    return proof.attemptId
  }

  function offerRequest(f: Team, proofAttemptId?: string) {
    return call(app, f.id, f.owner, {
      method: 'POST',
      body: { targetMembershipId: f.recipient.membershipId, proofAttemptId },
    })
  }

  async function offer(f: Team): Promise<Receipt> {
    const proof = await mailbox(f.owner, await offerRequest(f))
    const response = await offerRequest(f, proof)
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return response.json() as Promise<Receipt>
  }

  function confirm(f: Team, id: string, proofAttemptId?: string, actor = f.recipient) {
    return call(app, f.id, actor, {
      method: 'POST',
      suffix: `/${id}/confirm`,
      body: { proofAttemptId },
    })
  }

  function cancel(f: Team, id: string, action: 'revoke' | 'decline', actor: Login) {
    return call(app, f.id, actor, { method: 'POST', suffix: `/${id}/${action}` })
  }

  async function roles(f: Team) {
    const rows = await db
      .selectFrom('auth.member')
      .select(['id', 'role'])
      .where('organizationId', '=', f.id)
      .execute()
    const roles = new Map(rows.map(({ id, role }) => [id, role]))
    return [f.owner, f.recipient, f.other, f.bystander].map(({ membershipId }) =>
      roles.get(membershipId),
    )
  }

  it('hides the hard-off routes before session resolution or request-body validation', async () => {
    const invoked = vi.fn()
    const off = application(false, invoked)
    const f = await team()
    const id = randomUUID()
    for (const [method, suffix, body] of [
      ['GET', '', undefined],
      ['POST', '', { unknown: 'invalid field' }],
      ['POST', `/${id}/confirm`, { unknown: 'invalid field' }],
      ['POST', `/${id}/revoke`, undefined],
      ['POST', `/${id}/decline`, undefined],
    ] as const) {
      await expectError(
        await call(off, f.id, f.owner, {
          method,
          suffix,
          body,
          extraHeaders: { authorization: '' },
        }),
        404,
        'ownership_transfer_disabled',
      )
    }
    expect(invoked).not.toHaveBeenCalled()
    expect(await (await off.request('/api/v1/instance')).json()).not.toHaveProperty(
      'teamOwnershipTransferEnabled',
    )
    expect(await (await app.request('/api/v1/instance')).json()).toMatchObject({
      teamOwnershipTransferEnabled: true,
    })
  })

  it('denies every Authorization header before resolving even a valid session', async () => {
    const invoked = vi.fn()
    const traced = application(true, invoked)
    const f = await team()
    const key = await auth.api.createApiKey({
      body: { userId: f.owner.user.id, metadata: { organizationId: f.id } },
    })
    const id = randomUUID()
    for (const authorization of [
      '',
      'Basic malformed',
      `Bearer ${key.key}`,
      'Bearer mcp.oauth.synthetic',
    ]) {
      const extraHeaders = { authorization }
      const body = { targetMembershipId: f.recipient.membershipId }
      for (const [method, suffix, input] of [
        ['GET', '', undefined],
        ['POST', '', body],
        ['POST', `/${id}/confirm`, {}],
        ['POST', `/${id}/revoke`, undefined],
        ['POST', `/${id}/decline`, undefined],
      ] as const) {
        await expectError(
          await call(traced, f.id, f.owner, { method, suffix, body: input, extraHeaders }),
          403,
          denied,
        )
      }
      await expectError(await call(traced, f.id, undefined, { extraHeaders }), 403, denied)
    }
    expect(invoked).not.toHaveBeenCalled()
    await expectError(await call(traced, f.id, undefined), 403, denied)
  })

  it('requires exact Origin before validation or session resolution on every write', async () => {
    const invoked = vi.fn()
    const traced = application(true, invoked)
    const f = await team()
    const id = randomUUID()
    for (const origin of [null, 'null', `${publicUrl}/`, 'https://unrelated.example.test']) {
      for (const suffix of ['', `/${id}/confirm`, `/${id}/revoke`, `/${id}/decline`]) {
        await expectError(
          await call(traced, f.id, f.owner, {
            method: 'POST',
            suffix,
            origin,
            body: { unknown: 'invalid field' },
            extraHeaders: { referer: `${publicUrl}/app/settings` },
          }),
          403,
          denied,
        )
      }
    }
    expect(invoked).not.toHaveBeenCalled()
  })

  it('rejects missing or stale expected context and scopes lookup to its path team', async () => {
    const f = await team()
    const { id } = await offer(f)
    await expectError(
      await call(app, f.id, f.owner, { expected: null }),
      409,
      'organization_context_changed',
    )
    await expectError(
      await call(app, f.id, f.recipient, {
        method: 'POST',
        suffix: `/${id}/confirm`,
        body: {},
        expected: randomUUID(),
      }),
      409,
      'organization_context_changed',
    )
    const second = await createTestTeam(db, [{ user: f.owner.user, role: 'owner' }])
    await db
      .insertInto('sso_policies')
      .values({ organization_id: second.id, require_sso: true })
      .execute()
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: second.id })
      .where('id', '=', f.owner.sessionId)
      .execute()
    await expectError(await call(app, f.id, f.owner), 409, 'organization_context_changed')
    await expectError(await cancel(f, id, 'revoke', f.owner), 409, 'organization_context_changed')
    await expectError(
      await call(app, second.id, f.owner, { method: 'POST', suffix: `/${id}/revoke` }),
      403,
      denied,
    )
    await expectError(
      await call(app, second.id, f.owner, {
        method: 'POST',
        body: { targetMembershipId: f.recipient.membershipId },
      }),
      403,
      denied,
    )
    expect(await roles(f)).toEqual(['owner', 'member', 'owner', 'member'])
  })

  it('requires ordinary bound-team SSO before exposing or acting on an offer', async () => {
    const f = await team()
    const { id } = await offer(f)
    await db
      .insertInto('sso_policies')
      .values({ organization_id: f.id, require_sso: true })
      .execute()
    await expectError(await call(app, f.id, f.owner), 403, denied)
    await expectError(await confirm(f, id), 403, denied)
    await expectError(await cancel(f, id, 'revoke', f.owner), 403, denied)
    await expectError(await cancel(f, id, 'decline', f.recipient), 403, denied)
    expect(await roles(f)).toEqual(['owner', 'member', 'owner', 'member'])
    const offerState = await db
      .selectFrom('organization_ownership_transfers')
      .select('state')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(offerState.state).toBe('pending')
  })

  it('confirms once after both mailbox challenges and restricts pending and terminal projections', async () => {
    const f = await team()
    const receipt = await offer(f)
    const read = (actor: Login, suffix?: string) =>
      call(app, f.id, actor, suffix === undefined ? {} : { suffix })
    const recipients = {
      initiator: { displayName: f.owner.user.name },
      recipient: { displayName: f.recipient.user.name },
    }
    const pending = { ...receipt, state: 'pending' }
    expect(await (await read(f.owner)).json()).toEqual({
      offer: { ...pending, ...recipients, action: 'revoke' },
    })
    expect(await (await read(f.recipient)).json()).toEqual({
      offer: { ...pending, ...recipients, action: 'confirm' },
    })
    expect(await (await read(f.other)).json()).toEqual({ offer: { ...pending, action: 'revoke' } })
    expect(await (await read(f.bystander)).json()).toEqual({ offer: null })
    await expectError(await confirm(f, receipt.id, undefined, f.bystander), 403, denied)
    await expectError(await cancel(f, receipt.id, 'revoke', f.recipient), 403, denied)
    await expectError(await cancel(f, receipt.id, 'decline', f.other), 403, denied)

    const proof = await mailbox(f.recipient, await confirm(f, receipt.id))
    const response = await confirm(f, receipt.id, proof)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      initiator: { membershipId: f.owner.membershipId, role: 'admin' },
      recipient: { membershipId: f.recipient.membershipId, role: 'owner' },
    })
    await expectError(await confirm(f, receipt.id, proof), 409, 'ownership_transfer_unavailable')
    expect(await roles(f)).toEqual(['admin', 'owner', 'owner', 'member'])
    const known = `?transferId=${receipt.id}`
    expect(await (await read(f.owner)).json()).toEqual({ offer: null })
    expect(await (await read(f.owner, known)).json()).toEqual({
      offer: { ...receipt, state: 'confirmed' },
    })
    expect(await (await read(f.recipient, known)).json()).toEqual({
      offer: { ...receipt, state: 'confirmed' },
    })
    expect(await (await read(f.other, known)).json()).toEqual({ offer: null })
    expect(await (await read(f.bystander, known)).json()).toEqual({ offer: null })
  })

  it('serializes concurrent confirmation and owner revocation through REST', async () => {
    const f = await team()
    const { id } = await offer(f)
    const proof = await mailbox(f.recipient, await confirm(f, id))
    const [confirmed, revoked] = await Promise.all([
      confirm(f, id, proof),
      cancel(f, id, 'revoke', f.other),
    ])
    expect([confirmed.status, revoked.status].sort()).toEqual([200, 409])
    const didConfirm = confirmed.status === 200
    await expectError(didConfirm ? revoked : confirmed, 409, 'ownership_transfer_unavailable')
    expect(await roles(f)).toEqual(
      didConfirm ? ['admin', 'owner', 'owner', 'member'] : ['owner', 'member', 'owner', 'member'],
    )
    const { state } = await db
      .selectFrom('organization_ownership_transfers')
      .select('state')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(state).toBe(didConfirm ? 'confirmed' : 'revoked')
  })

  it('returns 429 with Retry-After when the owner budget is exhausted and still allows the recipient to decline', async () => {
    const f = await team()
    const { id } = await offer(f)
    await db
      .insertInto('organization_ownership_transfer_budgets')
      .values({
        organization_id: f.id,
        operation: 'revoke',
        request_count: 6,
        window_start: sql`date_bin(interval '1 hour', clock_timestamp(), timestamptz '2000-01-01 UTC')`,
      })
      .execute()
    const refused = await cancel(f, id, 'revoke', f.owner)
    await expectError(refused, 429, 'rate_limited')
    const retryAfter = Number(refused.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(3600)
    const declined = await cancel(f, id, 'decline', f.recipient)
    expect(declined.status).toBe(200)
    expect(await declined.json()).toEqual({ state: 'revoked' })
    await expectError(
      await cancel(f, id, 'decline', f.recipient),
      409,
      'ownership_transfer_unavailable',
    )
    expect(await roles(f)).toEqual(['owner', 'member', 'owner', 'member'])
  })
})
