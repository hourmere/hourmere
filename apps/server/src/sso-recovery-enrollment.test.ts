import { randomBytes, randomUUID } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  type SignupPolicy,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type IdentityFixture,
  identityFixture,
  linkValues,
} from '../../../packages/db/src/sso-identity-fixtures.ts'
import { recoveryOwnerValues } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import { ssoRoutes } from './routes/sso.ts'
import { ssoIdentityRecoveryRoutes } from './routes/sso-link-recovery.ts'
import { ssoRecoveryEnrollmentRoutes } from './routes/sso-recovery-enrollment.ts'
import {
  bindingCookieName,
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

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://recovery-enrollment.example.test'
const secret = randomBytes(32).toString('base64url')
const signup: SignupPolicy = { mode: 'open', allowedDomains: [] }
const recoveryPath = '/api/v1/team/sso/recovery'
const acceptancePath = (id: string) => `${recoveryPath}/${id}/accept`
const policyPath = '/api/v1/team/sso/policy'
const providersPath = '/api/v1/team/sso/providers'

type Attempt = { id: string; cookie: string }
type Notice = Parameters<SsoRecoveryEnrollmentQueue['enqueue']>[1]
type Enrollment = { enrollmentId: string; expiresAt: string; policyRevision: number }

describe.skipIf(!databaseUrl)('SSO recovery enrollment', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let fixture: IdentityFixture

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, {
      tag: 'sso_enrollment',
    })
    db = createDb(owned.pool)
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

  function instance(enabled = true) {
    const capabilities = { ssoOidcEnabled: enabled, ssoSamlEnabled: false }
    const notices: Notice[] = []
    const proofJobs: MailboxProofEmailPayload[] = []
    const state = { now: undefined as string | undefined, failQueue: false }
    const app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl,
      routes: [
        ssoRoutes({ db, capabilities }),
        ssoRecoveryEnrollmentRoutes({
          db,
          capabilities,
          publicUrl,
          now: (trx) => (state.now === undefined ? databaseClock(trx) : Promise.resolve(state.now)),
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

  it('nominates without granting access, then adds the nominee and audits and notifies both owners', async () => {
    const h = instance()
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
        language: expect.any(String),
      },
    ])

    const delivered: MailMessage[] = []
    const worker = ssoRecoveryEnrollmentEmailJob({
      db,
      capabilities: h.capabilities,
      publicUrl,
      mailer: { send: async (message) => void delivered.push(message) },
    })
    const runNotice = (notice: Notice) =>
      worker.handler(worker.payload.parse(notice), {
        id: 'synthetic-notice',
        attempt: 1,
        signal: new AbortController().signal,
      })
    for (const notice of h.notices) await runNotice(notice)
    expect(delivered.map(({ to, sensitive }) => ({ to, sensitive }))).toEqual([
      { to: await email(fixture.coOwner), sensitive: true },
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
        expect.objectContaining({ kind: 'enrolled', userId: fixture.owner }),
        expect.objectContaining({ kind: 'enrolled', userId: fixture.coOwner }),
      ]),
    )
    delivered.length = 0
    for (const notice of h.notices) await runNotice(notice)
    expect(delivered.map(({ to }) => to).sort()).toEqual(
      (await Promise.all([email(fixture.owner), email(fixture.coOwner)])).sort(),
    )
    expect(
      delivered.every(
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

  it.each(['unlink', 'owner removal'])(
    'retains recovery ownership through %s of an SSO link',
    async (operation) => {
      const h = instance()
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

  it('keeps both operations hard-off before authentication or request validation', async () => {
    const h = instance(false)
    await checkError(await write(h, recoveryPath, '', {}), 404, 'sso_disabled')
    await checkError(await write(h, acceptancePath(randomUUID()), '', {}), 404, 'sso_disabled')
    expect(await recoveryOwners()).toEqual([])
    expect(await nominations()).toEqual([])
    expect(h.notices).toEqual([])
  })
})
