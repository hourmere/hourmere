import { randomBytes, randomUUID } from 'node:crypto'
import {
  type CallerResolver,
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  ensurePersonalOrganization,
  type SignupPolicy,
} from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { Kysely, PostgresDialect, sql } from 'kysely'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { suspendScimMember } from '../../../packages/db/src/scim-suspension-fixtures.ts'
import {
  apiKey,
  type IdentityFixture,
  identityFixture,
  linkValues,
} from '../../../packages/db/src/sso-identity-fixtures.ts'
import { recoveryOwnerValues } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import { memberRemovalRoutes } from './routes/member-removal.ts'
import { ssoRoutes } from './routes/sso.ts'
import { ssoDelegationRoutes } from './routes/sso-delegation.ts'
import { ssoIdentityRecoveryRoutes } from './routes/sso-link-recovery.ts'
import { ssoPolicyRoutes } from './routes/sso-policy.ts'
import { ssoRecoveryEnrollmentRoutes } from './routes/sso-recovery-enrollment.ts'
import { teamBookingRoutes } from './routes/team-bookings.ts'
import { USE_SSO_RECOVERY } from './sso.ts'
import { SSO_DELEGATIONS_PATH } from './sso-delegation-proof.ts'
import { runWithFreshProof } from './sso-fresh-proof.ts'
import {
  bindingCookieName,
  cleanupSsoAttempts,
  databaseClock,
  deliverMailboxProof,
  MAILBOX_PROOF_CONSUME_PATH,
  MAILBOX_PROOF_SEND_PATH,
  type MailboxProofEmailPayload,
  mailboxProofRoutes,
} from './sso-mailbox-proof.ts'
import {
  type SsoRecoveryEnrollmentQueue,
  ssoRecoveryEnrollmentEmailJob,
} from './sso-recovery-enrollment.ts'
import { UseSsoRecoveryInput } from './sso-recovery-use.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://recovery-enrollment.example.test'
const secret = randomBytes(32).toString('base64url')
const signup: SignupPolicy = { mode: 'open', allowedDomains: [] }
const recoveryPath = '/api/v1/team/sso/recovery'
const recoveryUsePath = `${recoveryPath}/use`
const acceptancePath = (id: string) => `${recoveryPath}/${id}/accept`
const policyPath = '/api/v1/team/sso/policy'
const providersPath = '/api/v1/team/sso/providers'

type Attempt = { id: string; cookie: string }
type Notice = Parameters<SsoRecoveryEnrollmentQueue['enqueue']>[1]
type Enrollment = { enrollmentId: string; expiresAt: string; policyRevision: number }

describe.skipIf(!databaseUrl)('SSO recovery', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let fixture: IdentityFixture
  const statements: string[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, {
      tag: 'sso_recovery',
    })
    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => expect.unreachable('Unexpected sign-in email') },
    })
  }, 60_000)

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  beforeEach(async () => {
    const client = await owned.pool.connect()
    try {
      fixture = await identityFixture(client)
    } finally {
      client.release()
    }
  })

  function instance(
    enabled: boolean | 'setting-off' = true,
    resolveCaller: CallerResolver = createCallerResolver({ auth, db }),
  ) {
    // 'setting-off' is what the running server passes while SSO_OIDC_ENABLED is off.
    const capabilities = {
      ssoOidcEnabled: enabled === true,
      ssoSamlEnabled: false,
      ssoOperatorSetting: enabled === 'setting-off',
    }
    const notices: Notice[] = []
    const proofJobs: MailboxProofEmailPayload[] = []
    const state = { now: undefined as string | undefined, failQueue: false }
    const now = (trx: Db) =>
      state.now === undefined ? databaseClock(trx) : Promise.resolve(state.now)
    const app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller,
      publicUrl,
      routes: [
        ssoRoutes({ db, capabilities }),
        ssoPolicyRoutes({ db, capabilities, publicUrl, now }),
        ssoDelegationRoutes({ db, capabilities, publicUrl }),
        memberRemovalRoutes({ db }),
        teamBookingRoutes({ db }),
        ssoRecoveryEnrollmentRoutes({
          db,
          capabilities,
          publicUrl,
          now,
          notificationQueue: {
            async enqueue(name, payload, { transaction }) {
              expect(name).toBe('sso-recovery-enrollment-email')
              expect(transaction).toMatchObject({ isTransaction: true })
              if (state.failQueue) return null
              notices.push(payload)
              return 'synthetic-notice'
            },
          },
        }),
        ssoIdentityRecoveryRoutes({
          db,
          capabilities,
          publicUrl,
          notificationQueue: {
            async enqueue() {
              return 'synthetic-link-notice'
            },
          },
        }),
      ],
      ssoTeamReads: { db, capabilities },
      ssoMailboxProof: mailboxProofRoutes({
        db,
        capabilities,
        queue: {
          async enqueue(_name, payload) {
            proofJobs.push(payload)
            return 'synthetic-proof'
          },
        },
      }),
    })
    return { app, capabilities, notices, proofJobs, state }
  }
  type Instance = ReturnType<typeof instance>

  function write(
    h: Instance,
    path: string,
    cookie: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
    method = 'POST',
  ) {
    return h.app.request(new URL(path, publicUrl), {
      method,
      headers: {
        origin: publicUrl,
        'content-type': 'application/json',
        'X-Expected-Organization-Id': fixture.team,
        cookie,
        ...headers,
      },
      body: JSON.stringify(body),
    })
  }

  async function browser(userId: string, organizationId = fixture.team) {
    const issued = await db
      .transaction()
      .execute(async (trx) =>
        createBrowserSession(
          trx,
          { publicUrl, secret },
          { userId, organizationId, now: await databaseClock(trx), headers: new Headers() },
        ),
      )
    return { id: issued.id, cookie: issued.cookie.split(';')[0] as string }
  }

  async function challenge(response: Response, cookie: string): Promise<Attempt> {
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = (await response.json()) as { attemptId: string }
    expect(body).toEqual({
      error: 'sso_reauthentication_required',
      attemptId: expect.any(String),
      proofMethods: ['mailbox'],
      expiresAt: expect.any(String),
    })
    const binding = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${bindingCookieName(publicUrl)}=`))
    return { id: body.attemptId, cookie: binding ? `${cookie}; ${binding.split(';')[0]}` : cookie }
  }

  async function email(userId: string) {
    return (
      await db
        .selectFrom('auth.user')
        .select('email')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow()
    ).email
  }

  async function setProfileLocale(userId: string, locale: string) {
    await db
      .insertInto('profiles')
      .values({
        user_id: userId,
        handle: `sso-${randomUUID().slice(0, 8)}`,
        time_zone: 'UTC',
        locale,
      })
      .execute()
  }

  async function prove(h: Instance, proof: Attempt, userId: string) {
    const response = await write(h, MAILBOX_PROOF_SEND_PATH, proof.cookie, { attemptId: proof.id })
    expect(response.status).toBe(202)
    const job = h.proofJobs.shift()
    if (!job) throw new Error('Expected a mailbox-proof email job')
    const messages: MailMessage[] = []
    await deliverMailboxProof(
      {
        capabilities: h.capabilities,
        db,
        mailer: { send: async (message) => void messages.push(message) },
        publicUrl,
        secret,
        mailMaxPerHour: 0,
      },
      job,
    )
    expect(messages.map(({ to }) => to)).toEqual([await email(userId)])
    const token = /#attempt=[0-9a-f-]+&token=([A-Za-z0-9_-]+)/.exec(messages[0]?.text ?? '')?.[1]
    expect(typeof token).toBe('string')
    const consumed = await write(h, MAILBOX_PROOF_CONSUME_PATH, proof.cookie, {
      attemptId: proof.id,
      token,
    })
    expect(consumed.status).toBe(200)
    expect(await consumed.json()).toEqual({ status: 'proven' })
  }

  async function deliverNotices(h: Instance) {
    const delivered: MailMessage[] = []
    const worker = ssoRecoveryEnrollmentEmailJob({
      db,
      capabilities: h.capabilities,
      publicUrl,
      mailer: { send: async (message) => void delivered.push(message) },
    })
    for (const notice of h.notices)
      await worker.handler(worker.payload.parse(notice), {
        id: 'synthetic-notice',
        attempt: 1,
        signal: new AbortController().signal,
      })
    return delivered
  }

  async function nominate(
    h: Instance,
    cookie: string,
    expectedRevision: number,
    ownerUserId = fixture.coOwner,
  ): Promise<Enrollment> {
    const input = { expectedRevision, ownerUserId }
    const proof = await challenge(await write(h, recoveryPath, cookie, input), cookie)
    await prove(h, proof, fixture.owner)
    const result = await write(h, recoveryPath, proof.cookie, {
      ...input,
      proofAttemptId: proof.id,
    })
    expect(result.status).toBe(201)
    expect(result.headers.get('cache-control')).toBe('no-store')
    const nomination = (await result.json()) as Enrollment
    expect(nomination).toEqual({
      enrollmentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expiresAt: expect.any(String),
      policyRevision: expectedRevision + 1,
    })
    return nomination
  }

  async function acceptanceProof(
    h: Instance,
    enrollmentId: string,
    revision: number,
    cookie: string,
  ) {
    const path = acceptancePath(enrollmentId)
    const proof = await challenge(
      await write(h, path, cookie, { expectedRevision: revision }),
      cookie,
    )
    await prove(h, proof, fixture.coOwner)
    return proof
  }

  function accept(h: Instance, enrollmentId: string, expectedRevision: number, proof: Attempt) {
    return write(h, acceptancePath(enrollmentId), proof.cookie, {
      expectedRevision,
      proofAttemptId: proof.id,
    })
  }

  const recoveryOwners = () =>
    db
      .selectFrom('sso_recovery_owners')
      .selectAll()
      .where('organization_id', '=', fixture.team)
      .orderBy('user_id')
      .execute()

  const nominations = () =>
    db
      .selectFrom('sso_recovery_nominations')
      .selectAll()
      .where('organization_id', '=', fixture.team)
      .execute()

  const journal = () =>
    db
      .selectFrom('audit_events')
      .select(['action', 'actor_id', 'credential_id', 'target_id', 'details'])
      .where('organization_id', '=', fixture.team)
      .orderBy('id')
      .execute()

  const policy = () =>
    db
      .selectFrom('sso_policies')
      .select(['policy_revision', 'trust_generation', 'require_sso'])
      .where('organization_id', '=', fixture.team)
      .executeTakeFirst()

  async function addExistingOwner() {
    return db
      .insertInto('sso_recovery_owners')
      .values(recoveryOwnerValues(fixture))
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  const recoveryRevision = 7

  async function enforceSso() {
    await db
      .insertInto('sso_recovery_owners')
      .values({
        ...recoveryOwnerValues(fixture),
        accepted_at: sql<string>`statement_timestamp() - interval '1 minute'`,
      })
      .execute()
    await db
      .insertInto('sso_policies')
      .values({
        organization_id: fixture.team,
        require_sso: true,
        policy_revision: recoveryRevision,
      })
      .execute()
  }

  function read(h: Instance, path: string, cookie: string, headers: Record<string, string> = {}) {
    return h.app.request(new URL(path, publicUrl), { headers: { cookie, ...headers } })
  }

  function useRecovery(h: Instance, cookie: string, proofAttemptId?: string) {
    return write(h, recoveryUsePath, cookie, { expectedRevision: recoveryRevision, proofAttemptId })
  }

  async function recoveryProof(h: Instance, cookie: string) {
    const proof = await challenge(await useRecovery(h, cookie), cookie)
    await prove(h, proof, fixture.owner)
    return proof
  }

  async function recover(h: Instance, cookie: string) {
    const proof = await recoveryProof(h, cookie)
    const result = await useRecovery(h, proof.cookie, proof.id)
    expect(result.status).toBe(204)
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(await result.text()).toBe('')
    return proof
  }

  async function expireProof(id: string) {
    // Age the fixture to the same persisted state reached by letting its mailbox proof expire.
    // Leave the attempt's own expiry in the future so either boundary is independently observable.
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx)
      await sql`UPDATE sso_attempts SET
          created_at = statement_timestamp() - interval '5 seconds',
          expires_at = statement_timestamp() + interval '5 minutes',
          mailbox_proven_at = statement_timestamp() - interval '4 seconds',
          mailbox_proof_expires_at = statement_timestamp() - interval '1 second',
          consumed_at = CASE WHEN consumed_at IS NOT NULL
            THEN statement_timestamp() - interval '2 seconds' END
        WHERE id = ${id}::uuid`.execute(trx)
    })
  }

  async function seedNomination() {
    return db
      .insertInto('sso_recovery_nominations')
      .values({
        organization_id: fixture.team,
        member_id: fixture.coOwnerMember,
        user_id: fixture.coOwner,
        nominated_by_user_id: fixture.owner,
        created_at: sql<string>`statement_timestamp() + interval '60 seconds' - interval '72 hours'`,
        expires_at: sql<string>`statement_timestamp() + interval '60 seconds'`,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  }

  const attemptUse = (id: string) =>
    db
      .selectFrom('sso_attempts')
      .select('consumed_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  async function checkError(response: Response, status: number, error: string) {
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error })
  }

  async function raceTeamWrites(
    write: () => Response | Promise<Response>,
    beforeRelease?: (blocker: PoolClient) => Promise<void>,
  ) {
    const blocker = await owned.pool.connect()
    let requests: Promise<Response>[] = []
    try {
      await blocker.query('BEGIN')
      const {
        rows: [lock],
      } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      if (!lock) throw new Error('Expected the blocker PID')
      await blocker.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [fixture.team])
      requests = Array.from({ length: 2 }, () => Promise.resolve(write()))
      await vi.waitFor(
        async () => {
          const {
            rows: [waiting],
          } = await owned.pool.query<{ count: number }>(
            `WITH RECURSIVE blocked(pid) AS (
             SELECT $1::integer
             UNION
             SELECT activity.pid FROM pg_stat_activity activity JOIN blocked
               ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
             WHERE activity.datname = current_database()
           ) SELECT count(*)::int - 1 AS count FROM blocked`,
            [lock.pid],
          )
          expect(waiting?.count).toBe(2)
        },
        { timeout: 3000, interval: 10 },
      )
      await beforeRelease?.(blocker)
      await blocker.query('COMMIT')
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
    return Promise.all(requests)
  }

  it('consumes a fresh mailbox ceremony once even with two concurrent retries', async () => {
    const h = instance()
    await setProfileLocale(fixture.coOwner, 'zh-CN')
    await enforceSso()
    const owner = await browser(fixture.owner)
    const proof = await recoveryProof(h, owner.cookie)
    expect(await attemptUse(proof.id)).toEqual({ consumed_at: null })
    await checkError(await read(h, policyPath, proof.cookie), 403, 'sso_required')

    const responses = await raceTeamWrites(() => useRecovery(h, proof.cookie, proof.id))
    expect(responses.map(({ status }) => status).sort()).toEqual([204, 403])
    const refused = responses.find(({ status }) => status === 403)
    if (!refused) throw new Error('Expected one retry to require new proof')
    expect((await challenge(refused, proof.cookie)).id).not.toBe(proof.id)
    expect(await attemptUse(proof.id)).toEqual({ consumed_at: expect.anything() })
    expect(await journal()).toEqual([
      {
        action: 'sso_recovery.used',
        actor_id: fixture.owner,
        credential_id: owner.id,
        target_id: fixture.team,
        details: { correlationId: proof.id },
      },
    ])
    expect(h.notices).toHaveLength(2)
    expect(h.notices).toEqual(
      expect.arrayContaining([
        {
          kind: 'used',
          userId: fixture.owner,
          organizationId: fixture.team,
          language: 'en',
        },
        {
          kind: 'used',
          userId: fixture.coOwner,
          organizationId: fixture.team,
          language: 'zh-CN',
        },
      ]),
    )
    const delivered = await deliverNotices(h)
    expect(delivered.map(({ to, subject }) => ({ to, subject }))).toEqual(
      expect.arrayContaining([
        { to: await email(fixture.owner), subject: 'Single sign-on recovery was used' },
        { to: await email(fixture.coOwner), subject: '已使用单点登录恢复' },
      ]),
    )
    expect(delivered.every(({ sensitive, text }) => sensitive && !text.includes(proof.id))).toBe(
      true,
    )
    expect(await policy()).toEqual({ require_sso: true, policy_revision: 7, trust_generation: 1 })
  })

  it('notifies every owner when recovery is used while the OIDC setting is off', async () => {
    const h = instance('setting-off')
    await enforceSso()
    const owner = await browser(fixture.owner)
    const proof = await recoveryProof(h, owner.cookie)
    expect((await useRecovery(h, proof.cookie, proof.id)).status).toBe(204)
    expect(h.notices.map(({ kind }) => kind)).toEqual(['used', 'used'])
    const delivered = await deliverNotices(h)
    expect(delivered.map(({ to }) => to).sort()).toEqual(
      [await email(fixture.owner), await email(fixture.coOwner)].sort(),
    )
    // Enrollment adds trust: a notice queued before the setting was turned off is dropped,
    // and hard-off, which only tests assemble, delivers nothing at all.
    h.notices.push({ kind: 'enrolled', userId: fixture.owner, language: 'en' })
    expect(await deliverNotices(h)).toHaveLength(2)
    expect(await deliverNotices({ ...h, capabilities: instance(false).capabilities })).toEqual([])
  })

  it('binds recovery use to its expected revision, browser session and origin', async () => {
    const h = instance()
    await enforceSso()
    const owner = await browser(fixture.owner)
    const proof = await recoveryProof(h, owner.cookie)
    const retry = { expectedRevision: recoveryRevision, proofAttemptId: proof.id }
    const wrongRevision = await write(h, recoveryUsePath, proof.cookie, {
      ...retry,
      expectedRevision: recoveryRevision - 1,
    })
    await checkError(wrongRevision, 409, 'sso_configuration_changed')
    const wrongTeam = await write(h, recoveryUsePath, proof.cookie, retry, {
      'X-Expected-Organization-Id': fixture.otherTeam,
    })
    await checkError(wrongTeam, 403, 'team_management_access_denied')
    for (const headers of [
      { origin: 'https://outside.example.test' },
      { authorization: 'Bearer synthetic-agent-fixture' },
    ] as Record<string, string>[]) {
      await checkError(
        await write(h, recoveryUsePath, proof.cookie, retry, headers),
        403,
        'team_management_access_denied',
      )
    }
    const missingBinding = await challenge(
      await useRecovery(h, owner.cookie, proof.id),
      owner.cookie,
    )
    expect(missingBinding.id).not.toBe(proof.id)
    expect(await attemptUse(proof.id)).toEqual({ consumed_at: null })
    expect(await journal()).toEqual([])
    expect(h.notices).toEqual([])
    expect((await useRecovery(h, proof.cookie, proof.id)).status).toBe(204)
  })

  it('refuses an unenforced active team even with valid mailbox proof', async () => {
    const h = instance()
    await addExistingOwner()
    await db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, policy_revision: recoveryRevision })
      .execute()
    const owner = await browser(fixture.owner)
    // Prepare a mailbox attempt that predates the enforcement-required gate.
    const issued = await runWithFreshProof(
      { db, publicUrl, capabilities: h.capabilities },
      {
        headers: new Headers({ origin: publicUrl, cookie: owner.cookie }),
        userId: fixture.owner,
        sessionId: owner.id,
        organizationId: fixture.team,
        operation: USE_SSO_RECOVERY,
        proofMode: 'mailbox',
        input: { expectedRevision: recoveryRevision },
        schema: UseSsoRecoveryInput.omit({ proofAttemptId: true }),
      },
      {
        authorize: async () => {},
        mutate: async () => expect.unreachable('Expected a proof challenge'),
      },
    )
    if (issued.status !== 'proof_required' || !issued.setCookie)
      throw new Error('Expected a mailbox proof challenge with a binding cookie')
    const proof = {
      id: issued.body.attemptId,
      cookie: `${owner.cookie}; ${issued.setCookie.split(';')[0]}`,
    }
    await prove(h, proof, fixture.owner)

    await checkError(
      await useRecovery(h, proof.cookie, proof.id),
      403,
      'team_management_access_denied',
    )
    expect(await attemptUse(proof.id)).toEqual({ consumed_at: null })
    expect(await journal()).toEqual([])
    expect(h.notices).toEqual([])
    await checkError(await useRecovery(h, owner.cookie), 403, 'team_management_access_denied')
  })

  it('recovers an enforced team from the owner’s personal session without switching spaces', async () => {
    const h = instance(
      true,
      createCallerResolver({
        auth,
        db,
        ssoCapabilities: { ssoOidcEnabled: true, ssoSamlEnabled: false },
      }),
    )
    await enforceSso()
    const personal = await ensurePersonalOrganization(db, fixture.owner)
    const owner = await browser(fixture.owner, personal)
    const target = { 'X-Expected-Organization-Id': fixture.team }
    const disable = {
      expectedRevision: recoveryRevision,
      requireSso: false,
      admission: 'invitation_only',
    }
    const summary = await read(h, '/api/v1/me', owner.cookie)
    expect(summary.status).toBe(200)
    expect(await summary.json()).toMatchObject({
      organization: { id: personal, personal: true },
      ssoRecoveryTeams: [
        { id: fixture.team, displayName: expect.any(String), policyRevision: recoveryRevision },
      ],
    })

    expect((await read(h, policyPath, owner.cookie, target)).status).toBe(403)
    expect((await write(h, policyPath, owner.cookie, disable, target, 'PUT')).status).toBe(403)
    await checkError(
      await write(h, recoveryUsePath, owner.cookie, { expectedRevision: recoveryRevision - 1 }),
      409,
      'sso_configuration_changed',
    )

    const proof = await recover(h, owner.cookie)
    const readPolicy = await read(h, policyPath, proof.cookie, target)
    expect(readPolicy.status).toBe(200)
    expect(await readPolicy.json()).toMatchObject({
      requireSso: true,
      policyRevision: recoveryRevision,
    })
    const providers = await read(h, providersPath, proof.cookie, target)
    expect(providers.status).toBe(200)
    expect(await providers.json()).toMatchObject({
      data: [expect.objectContaining({ id: fixture.provider.id })],
    })
    expect((await read(h, providersPath, proof.cookie)).status).toBe(403)
    const bookings = await read(h, '/api/v1/team/bookings', proof.cookie, target)
    expect(bookings.status).toBe(409)
    expect(await bookings.json()).toMatchObject({ error: 'organization_context_changed' })
    expect(
      (
        await read(h, providersPath, proof.cookie, {
          'X-Expected-Organization-Id': fixture.otherTeam,
        })
      ).status,
    ).toBe(403)
    const otherSession = await browser(fixture.owner, personal)
    const otherCookie = proof.cookie.replace(owner.cookie, otherSession.cookie)
    expect((await read(h, policyPath, otherCookie, target)).status).toBe(403)
    expect((await write(h, policyPath, otherCookie, disable, target, 'PUT')).status).toBe(403)

    const disabled = await write(h, policyPath, proof.cookie, disable, target, 'PUT')
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toMatchObject({
      requireSso: false,
      policyRevision: recoveryRevision + 1,
    })
    expect((await read(h, policyPath, proof.cookie, target)).status).toBe(403)
    expect(await (await read(h, '/api/v1/me', proof.cookie)).json()).toMatchObject({
      organization: { id: personal, personal: true },
    })
  })

  it('rejects expired proof, non-owners, demoted owners and owners who never enrolled', async () => {
    const h = instance()
    await enforceSso()
    for (const userId of [fixture.coOwner, fixture.member, fixture.admin]) {
      await checkError(
        await useRecovery(h, (await browser(userId)).cookie),
        403,
        'team_management_access_denied',
      )
    }
    const owner = await browser(fixture.owner)
    const expired = await recoveryProof(h, owner.cookie)
    await expireProof(expired.id)
    expect(
      (await challenge(await useRecovery(h, expired.cookie, expired.id), expired.cookie)).id,
    ).not.toBe(expired.id)
    expect(await attemptUse(expired.id)).toEqual({ consumed_at: null })

    const proof = await recoveryProof(h, expired.cookie)
    // A remaining stored recovery row must not make a demoted member usable.
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('id', '=', fixture.ownerMember)
      .execute()
    await checkError(
      await useRecovery(h, proof.cookie, proof.id),
      403,
      'team_management_access_denied',
    )
    expect(await attemptUse(proof.id)).toEqual({ consumed_at: null })
    expect(await journal()).toEqual([])
    expect(h.notices).toEqual([])
  })

  it('retains recovery through repeated configuration reads and stops at mailbox expiry', async () => {
    const h = instance()
    await enforceSso()
    const owner = await browser(fixture.owner)
    const otherSession = await browser(fixture.owner)
    const proof = await recover(h, owner.cookie)
    await cleanupSsoAttempts(db)
    expect(await attemptUse(proof.id)).toEqual({ consumed_at: expect.anything() })
    for (let index = 0; index < 2; index++) {
      const readPolicy = await read(h, policyPath, proof.cookie)
      expect(readPolicy.status).toBe(200)
      expect(await readPolicy.json()).toEqual({
        requireSso: true,
        admission: 'invitation_only',
        policyRevision: 7,
        trustGeneration: 1,
      })
      const providers = await read(h, providersPath, proof.cookie)
      expect(providers.status).toBe(200)
      const page = (await providers.json()) as {
        data: Record<string, unknown>[]
        nextCursor: string | null
      }
      expect(page.data).toEqual([expect.objectContaining({ id: fixture.provider.id })])
      expect(page.data[0]).not.toHaveProperty('links')
      expect(page.nextCursor).toBeNull()
    }
    for (const path of [policyPath, providersPath]) {
      await checkError(await read(h, path, owner.cookie), 403, 'sso_required')
      await checkError(
        await read(h, path, proof.cookie.replace(owner.cookie, otherSession.cookie)),
        403,
        'sso_required',
      )
      await checkError(
        await read(h, path, proof.cookie, { origin: 'https://other.example.test' }),
        403,
        'sso_required',
      )
    }

    await expireProof(proof.id)
    for (const path of [policyPath, providersPath])
      await checkError(await read(h, path, proof.cookie), 403, 'sso_required')
    await checkError(
      await write(
        h,
        policyPath,
        proof.cookie,
        {
          expectedRevision: recoveryRevision,
          requireSso: false,
          admission: 'invitation_only',
        },
        {},
        'PUT',
      ),
      403,
      'sso_required',
    )
    expect(await policy()).toMatchObject({ require_sso: true, policy_revision: recoveryRevision })
    await cleanupSsoAttempts(db)
    expect(
      await db.selectFrom('sso_attempts').select('id').where('id', '=', proof.id).execute(),
    ).toEqual([])
  })

  it('keeps query counts for configuration and fresh proof on a team without SSO data', async () => {
    const h = instance()
    const owner = await createTestUser(db)
    const team = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    const session = await browser(owner.id, team.id)
    const cookie = `${session.cookie}; ${bindingCookieName(publicUrl)}=${randomBytes(32).toString('base64url')}`
    const headers = { 'X-Expected-Organization-Id': team.id }
    const queries = [
      { path: providersPath, send: () => read(h, providersPath, cookie, headers), status: 200 },
      { path: policyPath, send: () => read(h, policyPath, cookie, headers), status: 200 },
      {
        path: 'policy fresh proof',
        send: () =>
          write(
            h,
            policyPath,
            cookie,
            { expectedRevision: 1, requireSso: false, admission: 'invitation_only' },
            headers,
            'PUT',
          ),
        status: 403,
      },
    ]
    const counts: Record<string, number> = {}
    for (const { path, send, status } of queries) {
      statements.length = 0
      const response = await send()
      expect(response.status).toBe(status)
      counts[path] = statements.length
      expect(statements.some((statement) => statement.includes('sso_recovery_owners'))).toBe(false)
    }
    expect(counts).toEqual({ [providersPath]: 11, [policyPath]: 10, 'policy fresh proof': 21 })

    statements.length = 0
    await checkError(
      await write(h, recoveryUsePath, cookie, { expectedRevision: 1 }, headers),
      403,
      'team_management_access_denied',
    )
    expect(statements).toHaveLength(13)
  })

  it('refuses recovery if the owner is suspended after caller resolution', async () => {
    const h = instance()
    await enforceSso()
    const proof = await recover(h, (await browser(fixture.owner)).cookie)
    const resolved = await createCallerResolver({ auth, db })(new Headers({ cookie: proof.cookie }))
    expect(resolved).toMatchObject({ ok: true, principal: { organization: { id: fixture.team } } })
    await suspendScimMember(db, fixture.team, fixture.owner)
    const stale = instance(true, async () => resolved)
    for (const path of [policyPath, providersPath])
      await checkError(await read(stale, path, proof.cookie), 403, 'team_management_access_denied')
    await checkError(
      await write(
        stale,
        policyPath,
        proof.cookie,
        {
          expectedRevision: recoveryRevision,
          requireSso: false,
          admission: 'invitation_only',
        },
        {},
        'PUT',
      ),
      403,
      'team_management_access_denied',
    )
    expect(await attemptUse(proof.id)).toEqual({ consumed_at: expect.anything() })
    expect(await policy()).toMatchObject({ require_sso: true, policy_revision: recoveryRevision })
  })

  it('permits only enforcement disable and consumes authority with that policy write', async () => {
    const h = instance()
    await enforceSso()
    const proof = await recover(h, (await browser(fixture.owner)).cookie)
    const disable = {
      expectedRevision: recoveryRevision,
      requireSso: false,
      admission: 'invitation_only',
    }
    const client = await owned.pool.connect()
    let keyId: string
    try {
      keyId = await apiKey(client, fixture.owner, fixture.team)
    } finally {
      client.release()
    }
    await checkError(
      await write(h, policyPath, proof.cookie, { ...disable, admission: 'jit' }, {}, 'PUT'),
      403,
      'sso_required',
    )
    await checkError(
      await write(h, `/api/v1/team/members/${fixture.member}/removal`, proof.cookie, {
        teamId: fixture.team,
      }),
      403,
      'sso_required',
    )
    await checkError(
      await write(h, SSO_DELEGATIONS_PATH, proof.cookie, {
        credentialKind: 'api_key',
        credentialId: keyId,
        expectedTrustGeneration: 1,
      }),
      403,
      'sso_required',
    )
    await checkError(
      await write(h, recoveryPath, proof.cookie, {
        expectedRevision: recoveryRevision,
        ownerUserId: fixture.coOwner,
      }),
      403,
      'sso_required',
    )
    await checkError(await read(h, '/api/v1/team/bookings', proof.cookie), 403, 'sso_required')
    expect(await policy()).toMatchObject({ require_sso: true, policy_revision: recoveryRevision })
    expect(await recoveryOwners()).toHaveLength(1)
    expect(await nominations()).toEqual([])
    expect(
      await db
        .selectFrom('auth.member')
        .select('id')
        .where('id', '=', fixture.memberMember)
        .executeTakeFirst(),
    ).toBeDefined()
    expect(
      await db
        .selectFrom('sso_delegation_bindings')
        .select('id')
        .where('organization_id', '=', fixture.team)
        .execute(),
    ).toEqual([])

    const responses = await raceTeamWrites(() =>
      write(h, policyPath, proof.cookie, disable, {}, 'PUT'),
    )
    const disabled = responses.find(({ status }) => status === 200)
    if (!disabled) throw new Error('Expected a successful policy write')
    const refused = responses.find((response) => response !== disabled)
    expect([403, 409]).toContain(refused?.status)
    expect(await disabled.json()).toEqual({
      requireSso: false,
      admission: 'invitation_only',
      policyRevision: 8,
      trustGeneration: 2,
    })
    expect(
      await db.selectFrom('sso_attempts').select('id').where('id', '=', proof.id).execute(),
    ).toEqual([])
    expect((await journal()).map(({ action }) => action)).toEqual([
      'sso_recovery.used',
      'sso_enforcement.disabled',
    ])
    await challenge(
      await write(h, policyPath, proof.cookie, { ...disable, expectedRevision: 8 }, {}, 'PUT'),
      proof.cookie,
    )
  })

  it('honors recovery when the ordinary browser proof ends while the policy write waits', async () => {
    const h = instance()
    await enforceSso()
    const owner = await browser(fixture.owner)
    const proof = await recover(h, owner.cookie)
    const link = await db
      .insertInto('sso_identity_links')
      .values({
        organization_id: fixture.team,
        user_id: fixture.owner,
        provider_id: String(fixture.provider.id),
        issuer: String(fixture.provider.issuer),
        subject: randomUUID(),
        proven_email: await email(fixture.owner),
        email_proven_at: await databaseClock(db),
      })
      .returning(['id', 'generation'])
      .executeTakeFirstOrThrow()
    await db
      .insertInto('sso_browser_proofs')
      .values({
        organization_id: fixture.team,
        user_id: fixture.owner,
        member_id: fixture.ownerMember,
        provider_id: String(fixture.provider.id),
        link_id: link.id,
        link_generation: link.generation,
        trust_generation: 1,
        domain_id: String(fixture.domain.id),
        domain_generation: Number(fixture.domain.generation),
        session_id: owner.id,
        expires_at: sql<string>`clock_timestamp() + interval '1 minute'`,
      })
      .execute()
    expect((await read(h, '/api/v1/team/bookings', proof.cookie)).status).toBe(200)
    const responses = await raceTeamWrites(
      () =>
        write(
          h,
          policyPath,
          proof.cookie,
          {
            expectedRevision: recoveryRevision,
            requireSso: false,
            admission: 'invitation_only',
          },
          {},
          'PUT',
        ),
      async (blocker) => {
        await blocker.query('DELETE FROM sso_browser_proofs WHERE session_id=$1', [owner.id])
      },
    )
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409])
    expect(await policy()).toMatchObject({ require_sso: false, trust_generation: 2 })
  })

  it('nominates without granting access, then adds the nominee and audits and notifies both owners', async () => {
    const h = instance()
    await setProfileLocale(fixture.owner, 'fr')
    await setProfileLocale(fixture.coOwner, 'zh-CN')
    const priorOwner = await addExistingOwner()
    const nominator = await browser(fixture.owner)
    const nominee = await browser(fixture.coOwner)
    const enrollment = await nominate(h, nominator.cookie, 1)
    expect(await recoveryOwners()).toEqual([priorOwner])
    expect(await policy()).toEqual({
      policy_revision: 2,
      trust_generation: 1,
      require_sso: false,
    })
    const duration = await db
      .selectFrom('sso_recovery_nominations')
      .select(sql<number>`extract(epoch FROM expires_at - created_at)::integer`.as('seconds'))
      .where('id', '=', enrollment.enrollmentId)
      .executeTakeFirstOrThrow()
    expect(duration.seconds).toBe(72 * 60 * 60)
    expect(h.notices).toEqual([
      {
        kind: 'nominated',
        userId: fixture.coOwner,
        organizationId: fixture.team,
        enrollmentId: enrollment.enrollmentId,
        revision: enrollment.policyRevision,
        language: 'zh-CN',
      },
    ])

    const delivered = await deliverNotices(h)
    expect(delivered.map(({ to, subject, sensitive }) => ({ to, subject, sensitive }))).toEqual([
      {
        to: await email(fixture.coOwner),
        subject: '您已获提名单点登录恢复所有者',
        sensitive: true,
      },
    ])
    const link = delivered[0]?.text.match(/https:\/\/[^\s]+/)?.[0]
    if (!link) throw new Error('Expected an inert app link in the nomination notice')
    const location = new URL(link)
    expect(location.origin).toBe(publicUrl)
    expect(location.pathname).toMatch(/^\/app\//)
    expect(location.search).toBe('')
    expect(location.hash).toContain(enrollment.enrollmentId)
    await h.app.request(location, { headers: { cookie: nominee.cookie } })
    expect(await recoveryOwners()).toEqual([priorOwner])
    expect((await nominations()).map(({ id }) => id)).toEqual([enrollment.enrollmentId])

    const proof = await acceptanceProof(h, enrollment.enrollmentId, 2, nominee.cookie)
    expect(await recoveryOwners()).toEqual([priorOwner])
    const accepted = await accept(h, enrollment.enrollmentId, 2, proof)
    expect(accepted.status).toBe(204)
    expect(await accepted.text()).toBe('')
    expect(await policy()).toEqual({
      policy_revision: 3,
      trust_generation: 1,
      require_sso: false,
    })
    expect(await nominations()).toEqual([])
    expect(await recoveryOwners()).toEqual(
      expect.arrayContaining([
        priorOwner,
        expect.objectContaining({
          user_id: fixture.coOwner,
          member_id: fixture.coOwnerMember,
          nominated_by_user_id: fixture.owner,
        }),
      ]),
    )
    expect(await recoveryOwners()).toHaveLength(2)
    expect(await journal()).toEqual([
      {
        action: 'sso_recovery.nominated',
        actor_id: fixture.owner,
        credential_id: nominator.id,
        target_id: fixture.coOwnerMember,
        details: {},
      },
      {
        action: 'sso_recovery.enrolled',
        actor_id: fixture.coOwner,
        credential_id: nominee.id,
        target_id: fixture.coOwnerMember,
        details: {},
      },
    ])
    expect(h.notices.slice(1)).toHaveLength(2)
    expect(h.notices.slice(1)).toEqual(
      expect.arrayContaining([
        { kind: 'enrolled', userId: fixture.owner, language: 'fr' },
        { kind: 'enrolled', userId: fixture.coOwner, language: 'zh-CN' },
      ]),
    )
    const confirmations = await deliverNotices(h)
    expect(confirmations).toHaveLength(2)
    expect(confirmations.map(({ to, subject }) => ({ to, subject }))).toEqual(
      expect.arrayContaining([
        {
          to: await email(fixture.owner),
          subject: 'Proposition de récupération de l’authentification unique acceptée',
        },
        { to: await email(fixture.coOwner), subject: '单点登录恢复提名已接受' },
      ]),
    )
    expect(
      confirmations.every(
        ({ sensitive, text }) => sensitive && !text.includes(enrollment.enrollmentId),
      ),
    ).toBe(true)
  })

  it('binds mailbox proof to the nominated owner, their session, enrollment and policy revision', async () => {
    const h = instance()
    const actor = await browser(fixture.owner)
    const nominee = await browser(fixture.coOwner)
    const secondSession = await browser(fixture.coOwner)
    const admin = await browser(fixture.admin)
    const personal = await browser(fixture.personalUser, fixture.personal)
    const outsider = await browser(fixture.otherOwner, fixture.otherTeam)
    await checkError(
      await write(h, recoveryPath, admin.cookie, {
        expectedRevision: 1,
        ownerUserId: fixture.coOwner,
      }),
      403,
      'team_management_access_denied',
    )
    await checkError(
      await write(h, recoveryPath, actor.cookie, {
        expectedRevision: 1,
        ownerUserId: fixture.admin,
      }),
      404,
      'sso_not_found',
    )
    const enrollment = await nominate(h, actor.cookie, 1)
    const path = acceptancePath(enrollment.enrollmentId)
    const input = { expectedRevision: 2 }
    const proof = await acceptanceProof(h, enrollment.enrollmentId, 2, nominee.cookie)
    const retry = { ...input, proofAttemptId: proof.id }

    await checkError(await write(h, path, actor.cookie, retry), 404, 'sso_not_found')
    await checkError(
      await write(h, path, outsider.cookie, retry, {
        'X-Expected-Organization-Id': fixture.otherTeam,
      }),
      404,
      'sso_not_found',
    )
    await checkError(
      await write(h, acceptancePath(randomUUID()), nominee.cookie, retry),
      404,
      'sso_not_found',
    )
    await checkError(
      await write(h, path, admin.cookie, retry),
      403,
      'team_management_access_denied',
    )
    await checkError(
      await write(h, path, personal.cookie, retry),
      403,
      'team_management_access_denied',
    )
    await checkError(
      await write(h, path, proof.cookie, { ...retry, expectedRevision: 1 }),
      409,
      'sso_configuration_changed',
    )
    const forbiddenHeaders: Record<string, string>[] = [
      { origin: 'https://outside.example.test' },
      { authorization: 'Bearer synthetic-agent-fixture' },
    ]
    for (const extra of forbiddenHeaders) {
      await checkError(
        await write(h, path, proof.cookie, retry, extra),
        403,
        'team_management_access_denied',
      )
    }

    const wrongSession = proof.cookie.replace(nominee.cookie, secondSession.cookie)
    const wrongAttempt = await challenge(await write(h, path, wrongSession, retry), wrongSession)
    expect(wrongAttempt.id).not.toBe(proof.id)
    const wrongBrowser = await challenge(
      await write(h, path, nominee.cookie, retry),
      nominee.cookie,
    )
    expect(wrongBrowser.id).not.toBe(proof.id)
    expect(await attemptUse(proof.id)).toEqual({ consumed_at: null })
    expect(await recoveryOwners()).toEqual([])
    expect((await accept(h, enrollment.enrollmentId, 2, proof)).status).toBe(204)
  })

  it('requires the nominating owner to retain current authority when the nominee retries', async () => {
    const h = instance()
    const nominee = await browser(fixture.coOwner)
    const enrollment = await nominate(h, (await browser(fixture.owner)).cookie, 1)
    const proof = await acceptanceProof(h, enrollment.enrollmentId, 2, nominee.cookie)
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('id', '=', fixture.ownerMember)
      .execute()
    await checkError(await accept(h, enrollment.enrollmentId, 2, proof), 404, 'sso_not_found')
    expect(await attemptUse(proof.id)).toEqual({ consumed_at: null })
    expect(await recoveryOwners()).toEqual([])
  })

  it.each([
    [true, " - interval '1 microsecond'"],
    [false, ''],
  ])('acceptance before the 72-hour deadline succeeds: %s', async (live, offset) => {
    const h = instance()
    const nominee = await browser(fixture.coOwner)
    const seed = await seedNomination()
    const proof = await acceptanceProof(h, seed.id, 1, nominee.cookie)
    const { instant } = await db
      .selectFrom('sso_recovery_nominations')
      .select(sql<string>`(expires_at${sql.raw(offset)})::text`.as('instant'))
      .where('id', '=', seed.id)
      .executeTakeFirstOrThrow()
    h.state.now = instant
    const response = await accept(h, seed.id, 1, proof)
    if (live) {
      expect(response.status).toBe(204)
      expect(await recoveryOwners()).toHaveLength(1)
      return
    }
    await checkError(response, 404, 'sso_not_found')
    expect(await attemptUse(proof.id)).toEqual({ consumed_at: null })
    expect(await recoveryOwners()).toEqual([])
    expect(await journal()).toEqual([])

    const replacement = await nominate(h, (await browser(fixture.owner)).cookie, 1)
    expect(replacement.enrollmentId).not.toBe(seed.id)
    expect((await nominations()).map(({ id }) => id)).toEqual([replacement.enrollmentId])
    await checkError(await accept(h, seed.id, 2, proof), 404, 'sso_not_found')
    expect(await recoveryOwners()).toEqual([])
  })

  it('replaces a live nomination and lets exactly one contender consume the replacement', async () => {
    const h = instance()
    const nominator = await browser(fixture.owner)
    const nominee = await browser(fixture.coOwner)
    const old = await nominate(h, nominator.cookie, 1)
    const oldProof = await acceptanceProof(h, old.enrollmentId, 2, nominee.cookie)
    const current = await nominate(h, nominator.cookie, 2)
    expect(current.enrollmentId).not.toBe(old.enrollmentId)
    await checkError(await accept(h, old.enrollmentId, 3, oldProof), 404, 'sso_not_found')
    expect(await recoveryOwners()).toEqual([])
    const secondNomineeSession = await browser(fixture.coOwner)
    const first = await acceptanceProof(h, current.enrollmentId, 3, nominee.cookie)
    const second = await acceptanceProof(h, current.enrollmentId, 3, secondNomineeSession.cookie)

    h.state.failQueue = true
    expect((await accept(h, current.enrollmentId, 3, first)).status).toBe(500)
    h.state.failQueue = false
    expect(await recoveryOwners()).toEqual([])
    expect(await attemptUse(first.id)).toEqual({ consumed_at: null })
    expect(await policy()).toMatchObject({ policy_revision: 3 })
    expect((await nominations()).map(({ id }) => id)).toEqual([current.enrollmentId])
    expect((await journal()).map(({ action }) => action)).toEqual([
      'sso_recovery.nominated',
      'sso_recovery.nominated',
    ])

    const blocker = await owned.pool.connect()
    let requests: Promise<Response>[] = []
    try {
      await blocker.query('BEGIN')
      const {
        rows: [blocking],
      } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      if (!blocking) throw new Error('Expected the blocker PID')
      await blocker.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [fixture.team])
      requests = [first, second].map((proof) =>
        Promise.resolve(accept(h, current.enrollmentId, 3, proof)),
      )
      await vi.waitFor(
        async () => {
          const {
            rows: [pending],
          } = await owned.pool.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',
            [blocking.pid],
          )
          // The second request can wait behind the first while both wait on our lock.
          expect(pending?.count).toBeGreaterThan(0)
        },
        { timeout: 3000, interval: 10 },
      )
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
    const responses = await Promise.all(requests)
    expect(responses.map(({ status }) => status).sort()).toEqual([204, 404])
    const winner = responses.findIndex(({ status }) => status === 204)
    const loser = responses[1 - winner] as Response
    await checkError(loser, 404, 'sso_not_found')
    const uses = await Promise.all([attemptUse(first.id), attemptUse(second.id)])
    expect(uses.map(({ consumed_at }) => consumed_at !== null)).toEqual([
      winner === 0,
      winner === 1,
    ])
    expect(await recoveryOwners()).toHaveLength(1)
    expect(await nominations()).toEqual([])
    expect(
      (await journal()).filter(({ action }) => action === 'sso_recovery.enrolled'),
    ).toHaveLength(1)
    expect(h.notices.filter(({ kind }) => kind === 'enrolled')).toHaveLength(2)
  })

  it('accepts on an enforced team without a live SSO proof and leaves team reads closed', async () => {
    const h = instance()
    const nominator = await browser(fixture.owner)
    const nominee = await browser(fixture.coOwner)
    await db
      .insertInto('sso_policies')
      .values({
        organization_id: fixture.team,
        require_sso: true,
        policy_revision: 7,
      })
      .execute()
    const prior = await addExistingOwner()
    const enrollment = await seedNomination()
    await checkError(
      await write(h, recoveryPath, nominator.cookie, {
        expectedRevision: 7,
        ownerUserId: fixture.coOwner,
      }),
      403,
      'sso_required',
    )

    async function teamReadsStillClosed() {
      for (const path of [policyPath, providersPath]) {
        const result = await h.app.request(new URL(path, publicUrl), {
          headers: { cookie: nominee.cookie },
        })
        await checkError(result, 403, 'sso_required')
      }
    }
    await teamReadsStillClosed()
    const proof = await acceptanceProof(h, enrollment.id, 7, nominee.cookie)
    const accepted = await accept(h, enrollment.id, 7, proof)
    expect(accepted.status).toBe(204)
    expect(accepted.headers.get('cache-control')).toBe('no-store')
    expect(await accepted.text()).toBe('')
    expect(await recoveryOwners()).toEqual(
      expect.arrayContaining([prior, expect.objectContaining({ user_id: fixture.coOwner })]),
    )
    expect(await policy()).toEqual({ policy_revision: 8, trust_generation: 1, require_sso: true })
    expect(
      await db
        .selectFrom('sso_browser_proofs')
        .select('id')
        .where('session_id', '=', nominee.id)
        .execute(),
    ).toEqual([])
    await teamReadsStillClosed()
  })

  it.each([
    ['unlink', true],
    ['owner removal', true],
    ['unlink', 'setting-off'],
    ['owner removal', 'setting-off'],
  ] as const)(
    'retains recovery ownership through %s of an SSO link (OIDC %s)',
    async (operation, state) => {
      const h = instance(state)
      if (state === 'setting-off')
        // Reads of stored state stay available to the team's administrators.
        for (const path of [policyPath, providersPath])
          expect((await read(h, path, (await browser(fixture.owner)).cookie)).status).toBe(200)
      const prior = await addExistingOwner()
      const link = await db
        .insertInto('sso_identity_links')
        .values({
          ...linkValues(fixture, fixture.owner),
          organization_id: fixture.team,
          provider_id: fixture.provider.id as string,
          issuer: fixture.provider.issuer as string,
          user_id: fixture.owner,
          subject: 'synthetic-owner-subject',
          proven_email: await email(fixture.owner),
          email_proven_at: sql<string>`clock_timestamp()`,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const base = `${providersPath}/${fixture.provider.id}`
      const self = operation === 'unlink'
      const path = self ? `${base}/link` : `${base}/links/${link.id}`
      const userId = self ? fixture.owner : fixture.coOwner
      const { cookie } = await browser(userId)
      const input = { expectedLinkGeneration: 1, ...(self ? { linkId: link.id } : {}) }
      const proof = await challenge(await write(h, path, cookie, input, {}, 'DELETE'), cookie)
      await prove(h, proof, userId)
      const retired = await write(
        h,
        path,
        proof.cookie,
        { ...input, proofAttemptId: proof.id },
        {},
        'DELETE',
      )
      expect(retired.status).toBe(204)
      expect(await recoveryOwners()).toEqual([prior])
      expect(
        await db
          .selectFrom('sso_identity_links')
          .select('retired_at')
          .where('id', '=', link.id)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({
        retired_at: expect.anything(),
      })
      expect((await journal()).map(({ action }) => action)).toEqual(['sso_link.unlinked'])
    },
  )

  it('keeps recovery operations hard-off before authentication or request validation', async () => {
    const h = instance(false)
    await checkError(await write(h, recoveryPath, '', {}), 404, 'sso_disabled')
    await checkError(await write(h, acceptancePath(randomUUID()), '', {}), 404, 'sso_disabled')
    await checkError(await write(h, recoveryUsePath, '', {}), 404, 'sso_disabled')
    expect(await recoveryOwners()).toEqual([])
    expect(await nominations()).toEqual([])
    expect(h.notices).toEqual([])
  })
})
