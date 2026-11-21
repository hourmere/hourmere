import { randomBytes, randomUUID } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
} from '@hourmere/auth'
import { createDb, type Database, type Db } from '@hourmere/db'
import { writeSsoAuditEvent } from '@hourmere/db/audit'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { type Insertable, sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  at,
  claimedDomainValues,
  lapsedDomainValues,
  nominationValues,
  oidcProviderValues,
  recoveryOwnerValues,
  type SsoFixture,
  samlProviderValues,
  ssoFixture,
} from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import { ssoDomainRoutes } from './routes/sso-domains.ts'
import { ssoDraftRoutes } from './routes/sso-drafts.ts'
import { ssoPolicyRoutes } from './routes/sso-policy.ts'
import { ssoRecoveryEnrollmentRoutes } from './routes/sso-recovery-enrollment.ts'
import { sealSsoProviderConfiguration } from './sso-configuration.ts'
import { recheckSsoDomains } from './sso-domain-recheck.ts'
import {
  bindingCookieName,
  databaseClock,
  deliverMailboxProof,
  MAILBOX_PROOF_CONSUME_PATH,
  MAILBOX_PROOF_SEND_PATH,
  type MailboxProofEmailPayload,
  mailboxProofRoutes,
} from './sso-mailbox-proof.ts'
import { disableSsoEnforcement } from './sso-operator-recovery.ts'
import type { SsoPolicyDeps } from './sso-policy.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://sso-activation.example.test'
const secret = randomBytes(32).toString('base64url')
const configurationKey = randomBytes(32)
const clientSecret = 'synthetic-provider-activation-secret'
const signup = { mode: 'open', allowedDomains: [] } as const
const on = { ssoOidcEnabled: true, ssoSamlEnabled: false }
const off = { ssoOidcEnabled: false, ssoSamlEnabled: false }
const bothOn = { ssoOidcEnabled: true, ssoSamlEnabled: true }
const samlOnly = { ssoOidcEnabled: false, ssoSamlEnabled: true }
const providerPath = (id: string) => `/api/v1/team/sso/providers/${id}`
const activationPath = (id: string) => `${providerPath(id)}/activation`
const activate = { expectedRevision: 1, enabled: true }
const deactivate = { expectedRevision: 1, enabled: false }
const policyPath = '/api/v1/team/sso/policy'
const enforce = { expectedRevision: 1, requireSso: true, admission: 'invitation_only' }

describe.skipIf(!databaseUrl)('SSO provider activation', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let fixture: SsoFixture
  let app: ReturnType<typeof createApp>
  let owner: Awaited<ReturnType<typeof browser>>
  let proofJobs: MailboxProofEmailPayload[]

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'sso_activation' })
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      ssoCapabilities: on,
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
      fixture = await ssoFixture(client)
    } finally {
      client.release()
    }
    proofJobs = []
    app = instance()
    owner = await browser(fixture.owner)
  })

  function instance(capabilities = on, policyClock?: SsoPolicyDeps['now']) {
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db, ssoCapabilities: capabilities }),
      publicUrl,
      routes: [
        ssoDraftRoutes({ db, capabilities, publicUrl, configurationKey }),
        ssoPolicyRoutes({ db, capabilities, publicUrl, now: policyClock }),
        ssoDomainRoutes({ db, capabilities, publicUrl }),
        ssoRecoveryEnrollmentRoutes({
          db,
          capabilities,
          publicUrl,
          notificationQueue: { enqueue: async () => 'synthetic-recovery-job' },
        }),
      ],
      ssoTeamReads: { db, capabilities },
      ssoMailboxProof: mailboxProofRoutes({
        db,
        capabilities,
        queue: {
          async enqueue(_job, payload) {
            proofJobs.push(payload)
            return 'synthetic-proof-job'
          },
        },
      }),
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

  function write(
    path: string,
    body: Record<string, unknown>,
    {
      method = 'POST',
      cookie = owner.cookie,
      headers = {},
      target = app,
    }: {
      method?: string
      cookie?: string
      headers?: Record<string, string>
      target?: ReturnType<typeof createApp>
    } = {},
  ) {
    return target.request(new URL(path, publicUrl), {
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

  async function challenge(response: Response, { method = 'mailbox', cookie = owner.cookie } = {}) {
    expect(response.status).toBe(403)
    const body = (await response.json()) as { attemptId: string }
    expect(body).toEqual({
      error: 'sso_reauthentication_required',
      attemptId: expect.any(String),
      proofMethods: [method],
      expiresAt: expect.any(String),
    })
    const binding = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${bindingCookieName(publicUrl)}=`))
    return { id: body.attemptId, cookie: binding ? `${cookie}; ${binding.split(';')[0]}` : cookie }
  }

  async function mailbox(response: Response, capabilities = on) {
    const proof = await challenge(response)
    const sent = await write(MAILBOX_PROOF_SEND_PATH, { attemptId: proof.id }, proof)
    expect(sent.status).toBe(202)
    const job = proofJobs.shift()
    if (!job) throw new Error('Missing mailbox-proof email job')
    const messages: MailMessage[] = []
    await deliverMailboxProof(
      {
        capabilities,
        db,
        mailer: { send: async (message) => void messages.push(message) },
        publicUrl,
        secret,
        mailMaxPerHour: 0,
      },
      job,
    )
    const { email } = await db
      .selectFrom('auth.user')
      .select('email')
      .where('id', '=', fixture.owner)
      .executeTakeFirstOrThrow()
    expect(messages.map(({ to }) => to)).toEqual([email])
    const token = /#attempt=[0-9a-f-]+&token=([A-Za-z0-9_-]+)/.exec(messages[0]?.text ?? '')?.[1]
    expect(token).toEqual(expect.any(String))
    const verified = await write(MAILBOX_PROOF_CONSUME_PATH, { attemptId: proof.id, token }, proof)
    expect(verified.status).toBe(200)
    expect(await verified.json()).toEqual({ status: 'proven' })
    return proof
  }

  async function draft({ organizationId = fixture.team, revision = 1, enabled = false } = {}) {
    const base = oidcProviderValues(organizationId)
    const { id } = await db.selectNoFrom(sql<string>`uuidv7()`.as('id')).executeTakeFirstOrThrow()
    return db
      .insertInto('sso_providers')
      .values({
        ...base,
        id,
        revision,
        enabled,
        configuration: sealSsoProviderConfiguration(
          configurationKey,
          { organizationId, providerId: id, revision },
          JSON.stringify({ issuer: base.issuer, clientId: base.client_id, clientSecret }),
        ),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function domain(
    values: Insertable<Database['sso_domains']> = claimedDomainValues(fixture.team),
  ) {
    return db.insertInto('sso_domains').values(values).returningAll().executeTakeFirstOrThrow()
  }

  async function serve(providerId: string, domainId: string) {
    await db
      .insertInto('sso_provider_domains')
      .values({ organization_id: fixture.team, provider_id: providerId, domain_id: domainId })
      .execute()
  }

  async function receipt(
    providerId: string,
    revision = 1,
    outcome: 'passed' | 'failed' = 'passed',
    ownerTest = false,
    method: 'oidc' | 'saml' = 'oidc',
  ) {
    await db.transaction().execute((trx) =>
      writeSsoAuditEvent(trx, {
        organizationId: fixture.team,
        actor: { type: 'user', id: ownerTest ? fixture.owner : fixture.admin },
        credential: { type: 'session' },
        targetType: ownerTest ? 'sso_provider_owner_test' : 'sso_provider',
        targetId: providerId,
        action: 'sso_provider.tested',
        details: { method, providerId, revision, outcome },
      }),
    )
  }

  async function testedDraft() {
    const provider = await draft()
    const claim = await domain()
    await serve(provider.id, claim.id)
    await receipt(provider.id)
    return { provider, claim }
  }

  async function testedEnabledProvider() {
    const provider = await draft({ enabled: true })
    const claim = await domain()
    await serve(provider.id, claim.id)
    await receipt(provider.id, 1, 'passed', true)
    return { provider, claim }
  }

  const setPolicy = (body: Record<string, unknown>, options?: Parameters<typeof write>[2]) =>
    write(policyPath, body, { ...options, method: 'PUT' })

  async function seedOwnerProof(
    provider: Awaited<ReturnType<typeof draft>>,
    claim: Awaited<ReturnType<typeof domain>>,
  ) {
    const link = await db
      .insertInto('sso_identity_links')
      .values({
        organization_id: fixture.team,
        provider_id: provider.id,
        issuer: provider.issuer,
        subject: 'synthetic-owner-subject',
        user_id: fixture.owner,
        proven_email: `owner@${claim.name}`,
        email_proven_at: at(-60),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const reliance = {
      organization_id: fixture.team,
      user_id: fixture.owner,
      member_id: fixture.ownerMember,
      provider_id: provider.id,
      link_id: link.id,
      link_generation: link.generation,
      trust_generation: 1,
      domain_id: claim.id,
      domain_generation: claim.generation,
      expires_at: at(300),
    }
    await db
      .insertInto('sso_browser_proofs')
      .values({ ...reliance, session_id: owner.id })
      .execute()
    return reliance
  }

  async function stepUp(
    response: Response,
    { provider_id, link_id }: { provider_id: string; link_id: string },
  ) {
    const proof = await challenge(response, { method: 'sso' })
    // The OIDC protocol suite tests the signed step-up. Use its recorded, bound result here.
    const authenticatedAt = Date.parse(await databaseClock(db))
    await db
      .updateTable('sso_attempts')
      .set({
        step_up_provider_id: provider_id,
        step_up_link_id: link_id,
        step_up_authenticated_at: new Date(authenticatedAt).toISOString(),
        step_up_proof_expires_at: new Date(authenticatedAt + 240_000).toISOString(),
        step_up_trust_generation: 1,
      })
      .where('id', '=', proof.id)
      .execute()
    return proof
  }

  const policy = () =>
    db
      .selectFrom('sso_policies')
      .select(['require_sso', 'trust_generation', 'policy_revision'])
      .where('organization_id', '=', fixture.team)
      .executeTakeFirst()

  const stored = (id: string) =>
    db.selectFrom('sso_providers').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

  const consumption = (id: string) =>
    db
      .selectFrom('sso_attempts')
      .select('consumed_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  const activationEvents = () =>
    db
      .selectFrom('audit_events')
      .select([
        'action',
        'actor_id',
        'actor_type',
        'credential_id',
        'credential_type',
        'target_id',
        'target_type',
        'details',
      ])
      .where('organization_id', '=', fixture.team)
      .where('action', 'in', ['sso_provider.enabled', 'sso_provider.disabled'])
      .orderBy('id')
      .execute()

  async function error(response: Response, status: number, code: string) {
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: code })
  }

  const blockerPid = async (trx: Db) =>
    (await trx.selectNoFrom(sql<number>`pg_backend_pid()`.as('pid')).executeTakeFirstOrThrow()).pid

  async function waitForBlocked(blocker: number) {
    return vi.waitFor(
      async () => {
        const { rows } = await owned.pool.query<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))',
          [blocker],
        )
        const waiter = rows[0]?.pid
        expect(waiter).toEqual(expect.any(Number))
        return waiter as number
      },
      { timeout: 2500, interval: 15 },
    )
  }

  it('enables after mailbox fresh proof and advances trust once on disabling', async () => {
    const { provider } = await testedDraft()
    const path = activationPath(provider.id)
    const enabling = await mailbox(await write(path, activate))
    const altered = await challenge(
      await write(path, { ...deactivate, proofAttemptId: enabling.id }, enabling),
      { cookie: enabling.cookie },
    )
    expect(altered.id).not.toBe(enabling.id)
    expect(await consumption(enabling.id)).toEqual({ consumed_at: null })
    expect((await stored(provider.id)).enabled).toBe(false)
    const response = await write(path, { ...activate, proofAttemptId: enabling.id }, enabling)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      provider: {
        id: provider.id,
        protocol: 'oidc',
        enabled: true,
        revision: 1,
        hasClientSecret: true,
      },
    })
    expect(result).not.toHaveProperty('provider.configuration')
    expect(JSON.stringify(result)).not.toContain(clientSecret)
    expect(await stored(provider.id)).toMatchObject({
      enabled: true,
      revision: 1,
      configuration: provider.configuration,
    })
    expect(await consumption(enabling.id)).toMatchObject({ consumed_at: expect.any(Date) })
    expect((await policy())?.trust_generation ?? 1).toBe(1)

    for (let repeat = 0; repeat < 2; repeat++) {
      const disabling = await mailbox(await write(path, deactivate))
      const response = await write(path, { ...deactivate, proofAttemptId: disabling.id }, disabling)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        provider: { id: provider.id, enabled: false, revision: 1 },
      })
      expect(await policy()).toEqual({
        require_sso: false,
        trust_generation: 2,
        policy_revision: 1,
      })
    }
    expect(await stored(provider.id)).toMatchObject({
      enabled: false,
      revision: 1,
      configuration: provider.configuration,
    })
    expect(await activationEvents()).toEqual(
      ['sso_provider.enabled', 'sso_provider.disabled'].map((action) => ({
        action,
        actor_id: fixture.owner,
        actor_type: 'user',
        credential_id: owner.id,
        credential_type: 'session',
        target_id: provider.id,
        target_type: 'sso_provider',
        details: { method: 'oidc', providerId: provider.id, revision: 1 },
      })),
    )
  })

  it('requires a passed receipt for the exact current revision', async () => {
    const provider = await draft({ revision: 2 })
    await serve(provider.id, (await domain()).id)
    const path = activationPath(provider.id)
    const input = { ...activate, expectedRevision: 2 }
    await error(await write(path, input), 409, 'sso_test_required')
    await receipt(provider.id, 1)
    await error(await write(path, input), 409, 'sso_test_required')
    await receipt(provider.id, 2)
    const proof = await mailbox(await write(path, input))
    await receipt(provider.id, 2, 'failed')
    await error(
      await write(path, { ...input, proofAttemptId: proof.id }, proof),
      409,
      'sso_test_required',
    )
    expect(await consumption(proof.id)).toEqual({ consumed_at: null })
    expect((await stored(provider.id)).enabled).toBe(false)
    expect(await activationEvents()).toEqual([])
  })

  it('requires a linked verified domain and refuses expired or unknown verification', async () => {
    const provider = await draft()
    await receipt(provider.id)
    const path = activationPath(provider.id)
    await domain()
    await error(await write(path, activate), 409, 'sso_domain_unverified')
    const expired = await domain({ ...lapsedDomainValues(fixture.team), next_check_at: null })
    await serve(provider.id, expired.id)
    await error(await write(path, activate), 409, 'sso_domain_unverified')
    const unknown = await domain({
      ...claimedDomainValues(fixture.team),
      last_check_outcome: 'unknown',
    })
    await serve(provider.id, unknown.id)
    await error(await write(path, activate), 409, 'sso_domain_unverified')
    expect((await stored(provider.id)).enabled).toBe(false)
    expect(await activationEvents()).toEqual([])
  })

  it('requires a current owner, expected context, exact Origin and the proof browser', async () => {
    const { provider } = await testedDraft()
    const path = activationPath(provider.id)
    const denied = 'team_management_access_denied'
    const admin = await browser(fixture.admin)
    await error(await write(path, activate, admin), 403, denied)
    await error(
      await write(path, activate, { headers: { authorization: 'Bearer synthetic' } }),
      403,
      denied,
    )
    await error(
      await write(path, activate, {
        headers: { origin: 'https://wrong.example.test', referer: publicUrl },
      }),
      403,
      denied,
    )
    await error(
      await write(path, activate, { headers: { 'X-Expected-Organization-Id': '' } }),
      409,
      'organization_context_changed',
    )
    const foreign = await draft({ organizationId: fixture.otherTeam })
    for (const id of [foreign.id, randomUUID()])
      await error(await write(activationPath(id), activate), 404, 'sso_not_found')

    const proof = await mailbox(await write(path, activate))
    const otherSession = await browser(fixture.owner)
    const otherBrowser = await challenge(
      await write(path, { ...activate, proofAttemptId: proof.id }, otherSession),
      otherSession,
    )
    expect(otherBrowser.id).not.toBe(proof.id)
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('id', '=', fixture.ownerMember)
      .execute()
    await error(await write(path, { ...activate, proofAttemptId: proof.id }, proof), 403, denied)
    expect(await consumption(proof.id)).toEqual({ consumed_at: null })
    expect((await stored(provider.id)).enabled).toBe(false)
    expect(await activationEvents()).toEqual([])
  })

  it('keeps activation hard-off before lookup, input validation and caller resolution', async () => {
    const target = instance(off)
    const provider = await draft()
    for (const id of [provider.id, randomUUID()]) {
      await error(
        await write(
          activationPath(id),
          { unexpected: true },
          { target, cookie: '', headers: { origin: '' } },
        ),
        404,
        'sso_disabled',
      )
    }
    expect((await stored(provider.id)).enabled).toBe(false)
    expect(await activationEvents()).toEqual([])
  })

  it('preserves the last usable OIDC provider even with SAML enabled', async () => {
    app = instance(bothOn)
    const provider = await draft({ enabled: true })
    const claim = await domain()
    await serve(provider.id, claim.id)
    const path = activationPath(provider.id)
    await db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, require_sso: true })
      .execute()
    await db.insertInto('sso_recovery_owners').values(recoveryOwnerValues(fixture)).execute()
    await error(await write(path, deactivate), 403, 'sso_required')
    const reliance = await seedOwnerProof(provider, claim)
    const saml = await db
      .insertInto('sso_providers')
      .values({ ...samlProviderValues(fixture.team), enabled: true })
      .returning('id')
      .executeTakeFirstOrThrow()
    await serve(saml.id, claim.id)
    const alternate = await draft({ enabled: true })
    const expired = await domain({ ...lapsedDomainValues(fixture.team), next_check_at: null })
    await serve(alternate.id, expired.id)
    await error(await write(path, deactivate), 409, 'sso_last_provider')
    expect((await stored(provider.id)).enabled).toBe(true)
    expect(await policy()).toEqual({ require_sso: true, trust_generation: 1, policy_revision: 1 })
    expect(await activationEvents()).toEqual([])

    await serve(alternate.id, claim.id)
    const proof = await stepUp(await write(path, deactivate), reliance)
    const disabled = await write(path, { ...deactivate, proofAttemptId: proof.id }, proof)
    expect(disabled.status).toBe(200)
    expect((await stored(provider.id)).enabled).toBe(false)
    expect((await stored(alternate.id)).enabled).toBe(true)
    expect(await policy()).toEqual({ require_sso: true, trust_generation: 2, policy_revision: 1 })
    expect(await activationEvents()).toMatchObject([
      { action: 'sso_provider.disabled', target_id: provider.id },
    ])
  })

  it('refuses retirement of the last usable provider on a seeded enforced team', async () => {
    const { provider, claim } = await testedEnabledProvider()
    const reliance = await seedOwnerProof(provider, claim)
    await db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, require_sso: true })
      .execute()
    await db.insertInto('sso_recovery_owners').values(recoveryOwnerValues(fixture)).execute()
    const remove = (proof?: { id: string; cookie: string }) =>
      write(
        providerPath(provider.id),
        { expectedRevision: 1, ...(proof && { proofAttemptId: proof.id }) },
        { ...proof, method: 'DELETE' },
      )
    await error(await remove(), 409, 'sso_last_provider')
    expect(await stored(provider.id)).toMatchObject({ enabled: true, retired_at: null })
    expect(await policy()).toEqual({ require_sso: true, trust_generation: 1, policy_revision: 1 })

    const replacement = await draft({ enabled: true })
    await serve(replacement.id, claim.id)
    const proof = await stepUp(await remove(), reliance)
    const response = await remove(proof)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ deleted: true })
    expect(await stored(provider.id)).toMatchObject({
      enabled: false,
      retired_at: expect.any(Date),
    })
    expect(await policy()).toEqual({ require_sso: true, trust_generation: 2, policy_revision: 1 })
  })

  it('requires an enabled provider with a current owner receipt for enforcement', async () => {
    const provider = await draft({ revision: 2 })
    await serve(provider.id, (await domain()).id)
    await db.insertInto('sso_recovery_owners').values(recoveryOwnerValues(fixture)).execute()
    await receipt(provider.id, 2, 'passed', true)
    await error(await setPolicy(enforce), 409, 'sso_test_required')

    const other = await draft({ enabled: true, revision: 2 })
    await serve(other.id, (await domain()).id)
    await receipt(other.id, 1, 'passed', true)
    await receipt(other.id, 2)
    await error(await setPolicy(enforce), 409, 'sso_test_required')

    await receipt(other.id, 2, 'passed', true)
    const proof = await mailbox(await setPolicy(enforce))
    await receipt(other.id, 2, 'failed')
    await error(
      await setPolicy({ ...enforce, proofAttemptId: proof.id }, proof),
      409,
      'sso_test_required',
    )
    expect(await consumption(proof.id)).toEqual({ consumed_at: null })
    expect(await policy()).toBeUndefined()
  })

  it('refuses a SAML-only provider even when SAML is enabled', async () => {
    const provider = await db
      .insertInto('sso_providers')
      .values({ ...samlProviderValues(fixture.team), enabled: true })
      .returning('id')
      .executeTakeFirstOrThrow()
    await serve(provider.id, (await domain()).id)
    await receipt(provider.id, 1, 'passed', true, 'saml')
    await db.insertInto('sso_recovery_owners').values(recoveryOwnerValues(fixture)).execute()
    await error(await setPolicy(enforce), 404, 'sso_disabled')
    for (const capabilities of [bothOn, samlOnly]) {
      await error(await setPolicy(enforce, { target: instance(capabilities) }), 404, 'sso_disabled')
    }
    expect(await policy()).toBeUndefined()
  })

  it('locks the test result under the organization lock and checks it after waiting', async () => {
    const { provider } = await testedEnabledProvider()
    await db.insertInto('sso_recovery_owners').values(recoveryOwnerValues(fixture)).execute()
    const proof = await mailbox(await setPolicy(enforce))
    let enabling: Promise<Response> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        const blocker = await blockerPid(trx)
        const tests = trx
          .selectFrom('audit_events')
          .select('id')
          .where('organization_id', '=', fixture.team)
          .where('target_id', '=', provider.id)
          .where('action', '=', 'sso_provider.tested')
        const current = await tests.forUpdate().executeTakeFirstOrThrow()
        enabling = Promise.resolve(setPolicy({ ...enforce, proofAttemptId: proof.id }, proof))
        await Promise.race([
          waitForBlocked(blocker),
          enabling.then((response) => {
            expect(response.status, 'The policy write must wait for the locked receipt').toBe(409)
            return expect.unreachable('The policy write returned before the receipt changed')
          }),
        ])

        // This models a concurrent result change at the row. Real test writers also acquire
        // the organization lock before they append a result.
        await trx
          .updateTable('audit_events')
          .set({
            details: { method: 'oidc', providerId: provider.id, revision: 1, outcome: 'failed' },
          })
          .where('id', '=', current.id)
          .execute()
      })
    } finally {
      await Promise.allSettled([enabling])
    }
    if (!enabling) throw new Error('Missing concurrent policy request')
    await error(await enabling, 409, 'sso_test_required')
    expect(await consumption(proof.id)).toEqual({ consumed_at: null })
    expect(await policy()).toBeUndefined()
  })

  it('can recover without any linked admin and remove trust after OIDC turns off', async () => {
    const { provider, claim } = await testedEnabledProvider()
    await db.insertInto('sso_recovery_owners').values(recoveryOwnerValues(fixture)).execute()
    expect(
      await db
        .selectFrom('sso_identity_links')
        .select('id')
        .where('organization_id', '=', fixture.team)
        .execute(),
    ).toEqual([])
    const enabling = await mailbox(await setPolicy(enforce))
    expect((await setPolicy({ ...enforce, proofAttemptId: enabling.id }, enabling)).status).toBe(
      200,
    )

    app = instance(samlOnly)
    const turnOff = { ...enforce, expectedRevision: 2, requireSso: false }
    const removals = [
      { path: activationPath(provider.id), method: 'POST', body: deactivate },
      { path: providerPath(provider.id), method: 'DELETE', body: { expectedRevision: 1 } },
      {
        path: `/api/v1/team/sso/domains/${claim.id}`,
        method: 'DELETE',
        body: { expectedGeneration: claim.generation },
      },
    ]
    await error(await setPolicy(turnOff), 403, 'sso_required')
    for (const { path, method, body } of removals) {
      await error(await write(path, body, { method }), 403, 'sso_required')
    }
    await error(await write(activationPath(provider.id), activate), 404, 'sso_disabled')

    const use = '/api/v1/team/sso/recovery/use'
    const recovery = await mailbox(await write(use, { expectedRevision: 2 }), samlOnly)
    expect(
      (await write(use, { expectedRevision: 2, proofAttemptId: recovery.id }, recovery)).status,
    ).toBe(204)
    const disabled = await setPolicy(turnOff, recovery)
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toMatchObject({ requireSso: false, policyRevision: 3 })
    for (const { path, method, body } of removals) {
      const proof = await mailbox(await write(path, body, { method }), samlOnly)
      expect(
        (await write(path, { ...body, proofAttemptId: proof.id }, { ...proof, method })).status,
      ).toBe(200)
    }
    expect(await stored(provider.id)).toMatchObject({
      enabled: false,
      retired_at: expect.any(Date),
    })
    const retired = await db
      .selectFrom('sso_domains')
      .select('retired_at')
      .where('id', '=', claim.id)
      .executeTakeFirstOrThrow()
    expect(retired.retired_at).toBeInstanceOf(Date)
  })

  it('points an enforced owner with only a SAML browser proof to recovery for trust reductions', async () => {
    const saml = await db
      .insertInto('sso_providers')
      .values({ ...samlProviderValues(fixture.team), enabled: true })
      .returningAll()
      .executeTakeFirstOrThrow()
    const claim = await domain()
    await serve(saml.id, claim.id)
    await seedOwnerProof(saml, claim)
    const oidc = await draft({ enabled: true })
    await serve(oidc.id, claim.id)
    await db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, require_sso: true })
      .execute()
    app = instance(samlOnly)

    await error(await setPolicy({ ...enforce, requireSso: false }), 403, 'sso_required')
    for (const { id } of [saml, oidc]) {
      await error(await write(activationPath(id), deactivate), 403, 'sso_required')
      await error(
        await write(providerPath(id), { expectedRevision: 1 }, { method: 'DELETE' }),
        403,
        'sso_required',
      )
    }
    await error(
      await write(
        `/api/v1/team/sso/domains/${claim.id}`,
        { expectedGeneration: claim.generation },
        { method: 'DELETE' },
      ),
      403,
      'sso_required',
    )
  })

  it('requires an accepted current recovery owner and refuses a demoted or re-promoted former owner', async () => {
    await testedEnabledProvider()
    await db.insertInto('sso_recovery_nominations').values(nominationValues(fixture)).execute()
    await error(await setPolicy(enforce), 409, 'sso_recovery_required')
    expect(await policy()).toBeUndefined()

    await db
      .insertInto('sso_recovery_owners')
      .values(
        recoveryOwnerValues(fixture, {
          user: fixture.coOwner,
          member: fixture.coOwnerMember,
        }),
      )
      .execute()
    const proof = await mailbox(await setPolicy(enforce))
    const setRole = (role: string) =>
      db.updateTable('auth.member').set({ role }).where('id', '=', fixture.coOwnerMember).execute()
    // Model a record left behind by an older writer. Only an active owner is usable.
    await setRole('admin')
    await error(
      await setPolicy({ ...enforce, proofAttemptId: proof.id }, proof),
      409,
      'sso_recovery_required',
    )
    expect(await consumption(proof.id)).toEqual({ consumed_at: null })

    // Use the ordinary role-change transaction to remove the former owner's recovery record.
    const demoted = await write('/api/auth/organization/update-member-role', {
      organizationId: fixture.team,
      memberId: fixture.coOwnerMember,
      role: 'member',
    })
    expect(demoted.status).toBe(200)
    expect(await policy()).toEqual({ require_sso: false, trust_generation: 1, policy_revision: 2 })
    // The product does not expose owner promotion.
    await setRole('owner')
    await error(await setPolicy({ ...enforce, expectedRevision: 2 }), 409, 'sso_recovery_required')
  })

  it('refuses enforcement after a failed recheck or an expired verification', async () => {
    const { provider, claim } = await testedEnabledProvider()
    await db.insertInto('sso_recovery_owners').values(recoveryOwnerValues(fixture)).execute()
    const proof = await mailbox(await setPolicy(enforce))
    await db
      .updateTable('sso_domains')
      .set({ next_check_at: at(-1) })
      .where('id', '=', claim.id)
      .execute()
    expect(
      await recheckSsoDomains({ db, publicUrl, capabilities: on, resolveTxt: async () => [] }),
    ).toBe(1)
    await error(
      await setPolicy({ ...enforce, proofAttemptId: proof.id }, proof),
      409,
      'sso_domain_unverified',
    )
    expect(await consumption(proof.id)).toEqual({ consumed_at: null })

    const expired = await domain({ ...lapsedDomainValues(fixture.team), next_check_at: null })
    await db
      .deleteFrom('sso_provider_domains')
      .where('provider_id', '=', provider.id)
      .where('domain_id', '=', claim.id)
      .execute()
    await serve(provider.id, expired.id)
    await error(await setPolicy(enforce), 409, 'sso_domain_unverified')
    expect(await policy()).toBeUndefined()
  })

  it('serializes operator recovery behind setSsoPolicy when enforcement has no stored row yet', async () => {
    await testedEnabledProvider()
    await db.insertInto('sso_recovery_owners').values(recoveryOwnerValues(fixture)).execute()
    const proof = await mailbox(await setPolicy(enforce))
    // Recovery ownership alone does not install a policy; a missing parent lock would let
    // maintenance incorrectly report that enforcement is off before the enable commits.
    expect(await policy()).toBeUndefined()

    const entered = Promise.withResolvers<number>()
    const resume = Promise.withResolvers<void>()
    const target = instance(on, async (trx) => {
      entered.resolve(await blockerPid(trx))
      await resume.promise
      return databaseClock(trx)
    })
    const change = Promise.resolve(
      setPolicy({ ...enforce, proofAttemptId: proof.id }, { ...proof, target }),
    )
    let recovery: ReturnType<typeof disableSsoEnforcement> | undefined
    try {
      const blocker = await Promise.race([
        entered.promise,
        change.then((response) => {
          throw new Error(
            `Policy write exited before reaching the lock barrier (${response.status})`,
          )
        }),
      ])
      recovery = disableSsoEnforcement(
        db,
        { enqueue: async () => 'synthetic-notice' },
        fixture.team,
      )
      await waitForBlocked(blocker)
    } finally {
      resume.resolve()
      await Promise.allSettled([change, recovery])
    }
    expect((await change).status).toBe(200)
    await expect(recovery).resolves.toBe('disabled')
    expect(await policy()).toEqual({ require_sso: false, trust_generation: 2, policy_revision: 3 })
  })

  it('keeps the earlier delegation usable across enforcement, admission and membership changes', async () => {
    const { provider, claim } = await testedEnabledProvider()
    const reliance = await seedOwnerProof(provider, claim)
    await db.insertInto('sso_recovery_owners').values(recoveryOwnerValues(fixture)).execute()
    const credential = await auth.api.createApiKey({
      body: {
        userId: fixture.owner,
        name: 'Synthetic delegated read key',
        metadata: { organizationId: fixture.team, scope: 'read' },
      },
    })
    await db
      .insertInto('sso_delegation_bindings')
      .values({ ...reliance, api_key_id: credential.id })
      .execute()
    const checkKey = () =>
      app.request(new URL('/api/v1/me', publicUrl), {
        headers: { authorization: `Bearer ${credential.key}` },
      })
    expect((await checkKey()).status).toBe(200)
    const admin = await browser(fixture.admin)
    await error(await setPolicy(enforce, admin), 403, 'team_management_access_denied')
    const proof = await mailbox(await setPolicy(enforce))
    const enabled = await setPolicy({ ...enforce, proofAttemptId: proof.id }, proof)
    expect(enabled.status).toBe(200)
    expect(await enabled.json()).toEqual({
      requireSso: true,
      admission: 'invitation_only',
      policyRevision: 2,
      trustGeneration: 1,
    })
    expect((await checkKey()).status).toBe(200)

    await error(await setPolicy(enforce), 409, 'sso_configuration_changed')
    const admission = { ...enforce, expectedRevision: 2, admission: 'jit' }
    const admissionProof = await stepUp(await setPolicy(admission), reliance)
    const updated = await setPolicy(
      { ...admission, proofAttemptId: admissionProof.id },
      admissionProof,
    )
    expect(updated.status).toBe(200)
    expect(await updated.json()).toEqual({
      requireSso: true,
      admission: 'jit',
      policyRevision: 3,
      trustGeneration: 1,
    })
    const memberChanged = await write('/api/auth/organization/update-member-role', {
      organizationId: fixture.team,
      memberId: fixture.memberMember,
      role: 'admin',
    })
    expect(memberChanged.status).toBe(200)
    expect(await policy()).toEqual({ require_sso: true, trust_generation: 1, policy_revision: 3 })
    expect((await checkKey()).status).toBe(200)

    const disable = { ...admission, expectedRevision: 3, requireSso: false }
    const disableProof = await stepUp(await setPolicy(disable), reliance)
    const disabled = await setPolicy({ ...disable, proofAttemptId: disableProof.id }, disableProof)
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toEqual({
      requireSso: false,
      admission: 'jit',
      policyRevision: 4,
      trustGeneration: 2,
    })
    const repeated = { ...disable, expectedRevision: 4 }
    const repeatProof = await mailbox(await setPolicy(repeated))
    expect(
      (await setPolicy({ ...repeated, proofAttemptId: repeatProof.id }, repeatProof)).status,
    ).toBe(200)
    expect(await policy()).toEqual({ require_sso: false, trust_generation: 2, policy_revision: 4 })
    expect(
      await db
        .selectFrom('audit_events')
        .select(['action', 'actor_id', 'credential_id', 'target_type', 'target_id', 'details'])
        .where('organization_id', '=', fixture.team)
        .where('action', 'like', 'sso_enforcement.%')
        .orderBy('id')
        .execute(),
    ).toEqual(
      ['enabled', 'updated', 'disabled'].map((action, index) => ({
        action: `sso_enforcement.${action}`,
        actor_id: fixture.owner,
        credential_id: owner.id,
        target_type: 'organization',
        target_id: fixture.team,
        details: { revision: index + 2 },
      })),
    )
  })

  it('requires a verified domain for an administrator to opt in to JIT without enforcement', async () => {
    const admin = await browser(fixture.admin)
    const admission = { ...enforce, requireSso: false, admission: 'jit' }
    await error(await setPolicy(admission, admin), 409, 'sso_domain_unverified')
    await domain()
    await challenge(await setPolicy(admission, admin), admin)
    expect(await policy()).toBeUndefined()
  })

  it('rejects stale activation after a concurrent provider edit', async () => {
    const { provider } = await testedDraft()
    const path = activationPath(provider.id)
    const patchPath = providerPath(provider.id)
    const patch = { expectedRevision: 1, displayName: 'Renamed during activation' }
    const enabling = await mailbox(await write(path, activate))
    const editing = await mailbox(await write(patchPath, patch, { method: 'PATCH' }))
    let activation: Promise<Response> | undefined
    let edit: Promise<Response> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        const blocker = await blockerPid(trx)
        await trx
          .selectFrom('sso_providers')
          .select('id')
          .where('id', '=', provider.id)
          .forUpdate()
          .execute()
        // PATCH takes the team lock and blocks on our provider row. Activation queues
        // behind PATCH on that team lock and must read the new revision after it commits.
        edit = Promise.resolve(
          write(
            patchPath,
            { ...patch, proofAttemptId: editing.id },
            { ...editing, method: 'PATCH' },
          ),
        )
        const editor = await waitForBlocked(blocker)
        activation = Promise.resolve(
          write(path, { ...activate, proofAttemptId: enabling.id }, enabling),
        )
        await waitForBlocked(editor)
      })
    } finally {
      await Promise.allSettled([edit, activation])
    }
    if (!edit || !activation) throw new Error('Missing concurrent provider requests')
    expect((await edit).status).toBe(200)
    await error(await activation, 409, 'sso_configuration_changed')
    expect(await stored(provider.id)).toMatchObject({
      revision: 2,
      enabled: false,
      display_name: patch.displayName,
    })
    expect(await consumption(enabling.id)).toEqual({ consumed_at: null })
    expect(await activationEvents()).toEqual([])
  })

  it('refuses activation queued behind a failed domain recheck', async () => {
    const { provider, claim } = await testedDraft()
    const path = activationPath(provider.id)
    const proof = await mailbox(await write(path, activate))
    await db
      .updateTable('sso_domains')
      .set({ next_check_at: at(-1) })
      .where('id', '=', claim.id)
      .execute()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let workerPid: number | undefined
    const checking = recheckSsoDomains({
      db,
      publicUrl,
      capabilities: on,
      now: async (trx) => {
        if (trx.isTransaction) workerPid = await blockerPid(trx)
        return databaseClock(trx)
      },
      resolveTxt: async (name) => {
        expect(name).toBe(`_hourmere-sso.${claim.name}`)
        entered.resolve()
        await release.promise
        return []
      },
    })
    let activation: Promise<Response> | undefined
    try {
      await Promise.race([
        entered.promise,
        checking.then(() => expect.unreachable('Worker skipped due claim')),
      ])
      if (workerPid === undefined) throw new Error('Missing domain recheck PID')
      activation = Promise.resolve(write(path, { ...activate, proofAttemptId: proof.id }, proof))
      await waitForBlocked(workerPid)
    } finally {
      release.resolve()
      await Promise.allSettled([checking, activation])
    }
    expect(await checking).toBe(1)
    if (!activation) throw new Error('Missing concurrent activation request')
    await error(await activation, 409, 'sso_domain_unverified')
    await error(await write(path, activate), 409, 'sso_domain_unverified')
    expect(await consumption(proof.id)).toEqual({ consumed_at: null })
    expect((await stored(provider.id)).enabled).toBe(false)
    expect(await activationEvents()).toEqual([])
    const outcome = await db
      .selectFrom('sso_domains')
      .select('last_check_outcome')
      .where('id', '=', claim.id)
      .executeTakeFirstOrThrow()
    expect(outcome).toEqual({ last_check_outcome: 'failed' })
  })
})
