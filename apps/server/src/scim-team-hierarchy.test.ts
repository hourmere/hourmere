import { randomBytes, randomUUID } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  type Principal,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import type { MailMessage } from '@hourmere/mail'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import {
  approveScimTeamMapping,
  commitScimTeamMapping,
  listScimTeamMappings,
  type ScimTeamMappingApprovalInput,
} from './scim-team-hierarchy.ts'
import {
  type ScimMappingNoticeQueue,
  scimMappingNoticeJob,
  scimMappingNoticeQueue,
} from './scim-team-mapping-notices.ts'
import { recoverScimTeamMapping } from './scim-team-mapping-recovery.ts'
import {
  bindingCookieName,
  consumeMailboxProof,
  deliverMailboxProof,
  sha256,
} from './sso-mailbox-proof.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const secret = 'synthetic-scim-hierarchy-proof-secret-0000000000'
const signup = { mode: 'open', allowedDomains: [] } as const
const capabilities = { ssoOidcEnabled: false, ssoSamlEnabled: false }
type Approval = ScimTeamMappingApprovalInput
type Link = Extract<Approval, { action: 'link' }>
type Browser = {
  principal: Extract<Principal, { kind: 'session' }>
  headers: Headers
  binding: string
}

describe.skipIf(!databaseUrl)('SCIM team hierarchy transactions', () => {
  let owned: TestDatabase
  let db: Db
  let pool: ReturnType<typeof createAuthPool>
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'scim_hierarchy' })
    db = createDb(owned.pool)
    pool = createAuthPool(owned.url, signup)
    const auth = createAuth({
      db,
      pool,
      signup,
      secret,
      baseURL: publicUrl,
      scimResourcesEnabled: true,
      mailer: { send: async () => expect.unreachable('Only the proof fake sends mail') },
    })
    app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      routes: [],
    })
  })

  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      await owned?.drop()
    }
  })

  const notices: ScimMappingNoticeQueue = {
    enqueue: async (_name, _payload, options) => {
      expect(options.transaction).toBeTruthy()
      return 'synthetic-job'
    },
  }
  const deps = () => ({ db, publicUrl, capabilities, resourcesEnabled: true, notices })

  async function browser(
    user: TestUser,
    organization: Principal['organization'],
  ): Promise<Browser> {
    const { cookie, id } = await db.transaction().execute((trx) =>
      createBrowserSession(
        trx,
        { publicUrl, secret },
        {
          userId: user.id,
          organizationId: organization.id,
          now: Temporal.Now.instant().toString(),
          headers: new Headers(),
        },
      ),
    )
    const binding = randomBytes(32).toString('base64url')
    const headers = new Headers({
      cookie: `${cookie.split(';')[0]}; ${bindingCookieName(publicUrl)}=${binding}`,
      origin: publicUrl,
      'content-type': 'application/json',
      'x-expected-organization-id': organization.id,
    })
    return {
      headers,
      binding,
      principal: { kind: 'session', sessionId: id, user, organization },
    }
  }

  async function team(sharedOwner?: TestUser) {
    const owner = sharedOwner ?? (await createTestUser(db))
    const admin = await createTestUser(db)
    const member = await createTestUser(db)
    const created = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const { id: connectionId } = await db
      .insertInto('scim_connections')
      .values({ organization_id: created.id })
      .returning('id')
      .executeTakeFirstOrThrow()
    return {
      id: created.id,
      connectionId,
      owner: await browser(owner, created.as(owner).organization),
      admin: await browser(admin, created.as(admin).organization),
      member,
    }
  }
  type Team = Awaited<ReturnType<typeof team>>

  function link(
    parent: Team,
    child: Team,
    externalId = 'Directory-Group',
    linkGeneration = 0,
  ): Link {
    return {
      intentId: randomUUID(),
      action: 'link',
      allowGroupRetirement: true,
      parentOrganizationId: parent.id,
      childOrganizationId: child.id,
      connectionId: parent.connectionId,
      externalId,
      linkGeneration,
    }
  }

  const approve = (actor: Browser, input: Approval) =>
    approveScimTeamMapping(deps(), actor.principal, actor.headers, input)
  const commit = (actor: Browser, input: Approval) =>
    commitScimTeamMapping(deps(), actor.principal, input.intentId)

  async function mailbox(actor: Browser, attemptId: string) {
    const presenter = {
      binding: sha256(actor.binding),
      sessionId: actor.principal.sessionId,
      userId: actor.principal.user.id,
    }
    const proofDeps = { ...deps(), scimMappingConsentEnabled: true }
    let token: string | undefined
    await deliverMailboxProof(
      {
        ...proofDeps,
        secret,
        mailer: {
          send: async (message) => {
            token = /&token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1]
          },
        },
      },
      { ...presenter, attemptId, language: 'en' },
    )
    if (!token) throw new Error('The proof email did not contain a token')
    expect(
      await consumeMailboxProof(
        { ...proofDeps, guesses: { hit: () => undefined } },
        { attemptId, token },
        presenter,
      ),
    ).toBe(true)
  }

  async function approved(actor: Browser, input: Approval) {
    const challenge = await approve(actor, input)
    expect(challenge.status).toBe('proof_required')
    if (challenge.status !== 'proof_required') throw new Error('Expected a proof challenge')
    expect(challenge.body.proofMethods).toEqual(['mailbox'])
    await mailbox(actor, challenge.body.attemptId)
    expect(
      await approve(actor, { ...input, proofAttemptId: challenge.body.attemptId }),
    ).toMatchObject({
      status: 'complete',
      value: { intentId: input.intentId },
    })
    return challenge.body.attemptId
  }

  async function both(parent: Team, child: Team, input: Approval) {
    await approved(parent.owner, input)
    await approved(child.owner, input)
  }

  const consentRows = (intentId: string) =>
    db
      .selectFrom('scim_team_mapping_consents')
      .selectAll()
      .where('intent_id', '=', intentId)
      .orderBy('organization_id')
      .execute()
  const mapping = (id: string) =>
    db.selectFrom('scim_team_mappings').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

  it('lists only live link metadata within the acting team', async () => {
    const parent = await team()
    const child = await team()
    const unrelated = await team()
    const input = link(parent, child)
    await both(parent, child, input)
    const { mappingId } = await commit(parent.owner, input)
    const metadata = {
      id: mappingId,
      parentOrganizationId: parent.id,
      childOrganizationId: child.id,
      connectionId: parent.connectionId,
      externalId: input.externalId,
      state: 'pending',
    }
    await expect(listScimTeamMappings(deps(), child.owner.principal)).resolves.toEqual({
      mappings: [metadata],
      connectionId: child.connectionId,
      linkGeneration: 1,
    })
    await expect(listScimTeamMappings(deps(), parent.admin.principal)).resolves.toEqual({
      mappings: [metadata],
      connectionId: null,
      linkGeneration: null,
    })
    const stranger = unrelated.owner.principal
    await expect(listScimTeamMappings(deps(), stranger)).resolves.toMatchObject({ mappings: [] })
    for (const target of [child.id, randomUUID()])
      await expect(listScimTeamMappings(deps(), stranger, target)).rejects.toMatchObject({
        code: 'scim_mapping_access_denied',
      })
  })

  it('denies consent if insertion reaches the fresh proof deadline', async () => {
    const parent = await team()
    const child = await team()
    const input = link(parent, child)
    const challenge = await approve(parent.owner, input)
    if (challenge.status !== 'proof_required') throw new Error('Expected a proof challenge')
    const proofAttemptId = challenge.body.attemptId
    await mailbox(parent.owner, proofAttemptId)

    // Force the exact deadline at consent persistence, after the proof has passed
    // validation and been consumed inside the transaction.
    await sql`CREATE FUNCTION test_force_scim_consent_deadline() RETURNS trigger AS $$
      BEGIN NEW.approved_at := NEW.expires_at; RETURN NEW; END;
      $$ LANGUAGE plpgsql`.execute(db)
    try {
      await sql`CREATE TRIGGER test_force_scim_consent_deadline BEFORE INSERT
        ON scim_team_mapping_consents FOR EACH ROW
        EXECUTE FUNCTION test_force_scim_consent_deadline()`.execute(db)
      await expect(approve(parent.owner, { ...input, proofAttemptId })).rejects.toMatchObject({
        code: 'scim_mapping_access_denied',
      })
      expect(await consentRows(input.intentId)).toEqual([])
      expect(
        await db
          .selectFrom('sso_attempts')
          .select('consumed_at')
          .where('id', '=', proofAttemptId)
          .executeTakeFirst(),
      ).toEqual({ consumed_at: null })
    } finally {
      await sql`DROP FUNCTION test_force_scim_consent_deadline() CASCADE`.execute(db)
    }
  })

  it('suspends and detaches offline with exact scope, guarded departure, and transactional notices', async () => {
    const parent = await team()
    const child = await team()
    const input = link(parent, child)
    await both(parent, child, input)
    const jobs = createJobs({
      connectionString: owned.url,
      definitions: [scimMappingNoticeQueue],
      work: false,
      migrate: true,
      log: () => {},
    })
    const sent: MailMessage[] = []
    try {
      await jobs.start()
      const { mappingId } = await commitScimTeamMapping(
        { ...deps(), notices: jobs },
        parent.owner.principal,
        input.intentId,
      )
      const target = { mappingId, parentOrganizationId: parent.id, childOrganizationId: child.id }
      const member = await db
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', child.id)
        .where('userId', '=', child.member.id)
        .executeTakeFirstOrThrow()
      await db
        .insertInto('scim_team_managed_memberships')
        .values({
          member_id: member.id,
          mapping_id: mappingId,
          child_organization_id: child.id,
          user_id: child.member.id,
        })
        .execute()
      const eventId = await createFixtures(db).eventType(child.id, null, {
        hosts: [{ userId: child.member.id }],
      })

      await expect(
        recoverScimTeamMapping(db, jobs, false, { ...target, action: 'detach' }),
      ).rejects.toMatchObject({ code: 'scim_resources_disabled' })
      await expect(
        recoverScimTeamMapping(db, jobs, true, {
          ...target,
          childOrganizationId: randomUUID(),
          action: 'suspend',
        }),
      ).rejects.toMatchObject({ code: 'scim_mapping_access_denied' })
      let enqueued = 0
      const failQueue: ScimMappingNoticeQueue = {
        enqueue: async (...args) => (++enqueued === 1 ? jobs.enqueue(...args) : null),
      }
      await expect(
        recoverScimTeamMapping(db, failQueue, true, { ...target, action: 'suspend' }),
      ).rejects.toThrow('could not be queued')
      expect((await mapping(mappingId)).suspended_at).toBeNull()
      await expect(
        recoverScimTeamMapping(db, jobs, true, { ...target, action: 'suspend' }),
      ).resolves.toBe('suspended')
      await expect(
        recoverScimTeamMapping(db, jobs, true, { ...target, action: 'suspend' }),
      ).resolves.toBe('unchanged')
      await expect(listScimTeamMappings(deps(), child.owner.principal)).resolves.toMatchObject({
        mappings: [{ state: 'suspended' }],
      })
      await expect(
        recoverScimTeamMapping(db, jobs, true, { ...target, action: 'detach' }),
      ).rejects.toMatchObject({ code: 'scim_mapping_roster_requires_departure' })
      expect(
        await db
          .selectFrom('auth.member')
          .select('id')
          .where('id', '=', member.id)
          .executeTakeFirst(),
      ).toEqual(member)

      await db
        .updateTable('event_types')
        .set({ deleted_at: new Date(), is_active: false })
        .where('id', '=', eventId)
        .execute()
      await expect(
        recoverScimTeamMapping(db, jobs, true, { ...target, action: 'detach' }),
      ).resolves.toBe('detached')
      await expect(
        recoverScimTeamMapping(db, jobs, true, { ...target, action: 'detach' }),
      ).resolves.toBe('unchanged')
      expect(
        await db
          .selectFrom('auth.member')
          .select('id')
          .where('id', '=', member.id)
          .executeTakeFirst(),
      ).toBeUndefined()
      expect(
        await db
          .selectFrom('auth.member')
          .select('role')
          .where('organizationId', '=', child.id)
          .orderBy('role')
          .execute(),
      ).toEqual([{ role: 'admin' }, { role: 'owner' }])
      expect((await mapping(mappingId)).retired_at).toBeTruthy()
      await expect(listScimTeamMappings(deps(), parent.owner.principal)).resolves.toMatchObject({
        mappings: [],
      })

      const journal = await db
        .selectFrom('audit_events')
        .select([
          'action',
          'organization_id',
          'actor_type',
          'actor_id',
          'credential_type',
          'details',
        ])
        .where('target_id', '=', mappingId)
        .orderBy('action')
        .orderBy('organization_id')
        .execute()
      const teams = [parent, child].sort((a, b) => a.id.localeCompare(b.id))
      expect(journal).toEqual(
        ['linked', 'suspended', 'unlinked'].flatMap((action) =>
          teams.map((item) => ({
            action: `scim_mapping.${action}`,
            organization_id: item.id,
            actor_type: action === 'linked' ? 'user' : 'system',
            actor_id: action === 'linked' ? item.owner.principal.user.id : 'scim-mapping-recovery',
            credential_type: 'none',
            details: {},
          })),
        ),
      )
      const { rows } = await sql<{
        data: unknown
      }>`SELECT data FROM pgboss.job WHERE name = ${scimMappingNoticeQueue.name}`.execute(db)
      expect(rows).toHaveLength(6)
      const worker = scimMappingNoticeJob(db, {
        send: async (message) => {
          sent.push(message)
        },
      })
      for (const row of rows) {
        const notice = scimMappingNoticeQueue.payload.parse(row.data)
        expect(Object.keys(notice).sort()).toEqual([
          'action',
          'language',
          'mappingId',
          'organizationId',
          'userId',
        ])
        await worker.handler(notice, {
          signal: new AbortController().signal,
          id: 'job',
          attempt: 1,
        })
      }
      expect(sent.map(({ to }) => to).sort()).toEqual(
        teams.flatMap((item) => Array(3).fill(item.owner.principal.user.email)).sort(),
      )
      expect(
        sent.every(
          ({ text }) =>
            text.includes(mappingId) &&
            teams.every(
              (item) => !text.includes(item.id) && !text.includes(item.owner.principal.user.email),
            ),
        ),
      ).toBe(true)
    } finally {
      await jobs.stop()
    }
  })

  it('requires separate bound proof from both current owners and commits each intent once', async () => {
    const sameOwner = await createTestUser(db)
    const parent = await team(sameOwner)
    const child = await team(sameOwner)
    const input = link(parent, child)
    const wrongOrigin = new Headers(parent.owner.headers)
    wrongOrigin.set('origin', 'https://other.example.test')
    await expect(
      approveScimTeamMapping(deps(), parent.owner.principal, wrongOrigin, input),
    ).rejects.toMatchObject({ status: 403 })
    const staleTeam = new Headers(child.owner.headers)
    staleTeam.set('x-expected-organization-id', parent.id)
    await expect(
      approveScimTeamMapping(deps(), child.owner.principal, staleTeam, input),
    ).rejects.toMatchObject({ code: 'scim_mapping_access_denied' })
    const bearer = new Headers(parent.owner.headers)
    bearer.set('authorization', 'Bearer synthetic')
    await expect(
      approveScimTeamMapping(deps(), parent.owner.principal, bearer, input),
    ).rejects.toMatchObject({ status: 403 })
    await expect(approve(parent.admin, input)).rejects.toThrow()
    await expect(
      approveScimTeamMapping(
        { ...deps(), resourcesEnabled: false },
        parent.owner.principal,
        parent.owner.headers,
        input,
      ),
    ).rejects.toThrow()
    expect(await consentRows(input.intentId)).toEqual([])

    const first = await approved(parent.owner, input)
    await expect(commit(parent.owner, input)).rejects.toThrow()
    const crossed = await approve(child.owner, { ...input, proofAttemptId: first })
    expect(crossed).toMatchObject({ status: 'proof_required' })
    expect(await consentRows(input.intentId)).toHaveLength(1)
    const second = await approved(child.owner, input)
    const consents = await consentRows(input.intentId)
    expect(consents.map(({ owner_id }) => owner_id)).toEqual([sameOwner.id, sameOwner.id])
    for (const [side, attemptId] of [
      [parent, first],
      [child, second],
    ] as const) {
      const attempt = await db
        .selectFrom('sso_attempts')
        .select(['consumed_at', 'mailbox_proof_expires_at'])
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow()
      expect(attempt.consumed_at).toBeTruthy()
      expect(consents.find(({ organization_id }) => organization_id === side.id)).toMatchObject({
        session_id: side.owner.principal.sessionId,
        proof_kind: 'mailbox',
        expires_at: attempt.mailbox_proof_expires_at,
      })
    }
    await expect(commit(parent.admin, input)).rejects.toThrow()
    const result = await Promise.allSettled([
      commit(parent.owner, input),
      commit(child.owner, input),
    ])
    expect(result.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected'])
    const committed = result.find((outcome) => outcome.status === 'fulfilled')
    if (!committed) throw new Error('Expected exactly one committed mapping')
    expect(committed.value.generation).toBe(1)
    await expect(mapping(committed.value.mappingId)).resolves.toMatchObject({
      parent_organization_id: parent.id,
      child_organization_id: child.id,
      external_id: input.externalId,
      retired_at: null,
    })
  })

  it('does not disclose counterpart existence to one owner and refuses a different or missing connection', async () => {
    const parent = await team()
    const child = await team()
    const real = link(parent, child)
    const unknown = {
      ...link(parent, child),
      childOrganizationId: randomUUID(),
      connectionId: randomUUID(),
    }
    for (const input of [real, unknown]) {
      await approved(parent.owner, input)
      expect(await consentRows(input.intentId)).toHaveLength(1)
    }
    const refusals = await Promise.allSettled([
      commit(parent.owner, real),
      commit(parent.owner, unknown),
    ])
    expect(refusals).toEqual([
      {
        status: 'rejected',
        reason: expect.objectContaining({ code: 'scim_mapping_access_denied' }),
      },
      {
        status: 'rejected',
        reason: expect.objectContaining({ code: 'scim_mapping_access_denied' }),
      },
    ])
    expect(refusals[0]).toEqual(refusals[1])
    const foreign = { ...link(parent, child), connectionId: child.connectionId }
    await both(parent, child, foreign)
    await expect(commit(parent.owner, foreign)).rejects.toMatchObject({
      code: 'scim_mapping_access_denied',
    })
    expect(
      await db
        .selectFrom('scim_team_mappings')
        .select('id')
        .where('child_organization_id', '=', child.id)
        .execute(),
    ).toEqual([])
  })

  it('requires the enforced team step-up and fallback and rechecks the provider on commit', async () => {
    const parent = await team()
    const child = await team()
    const input = link(parent, child)
    const enforcingDeps = { ...deps(), capabilities: { ...capabilities, ssoOidcEnabled: true } }
    const approveChild = (request: Approval) =>
      approveScimTeamMapping(enforcingDeps, child.owner.principal, child.owner.headers, request)
    const issuer = 'https://idp.example.test'
    const configuration = Buffer.alloc(30)
    configuration[0] = 1
    const { id: providerId } = await db
      .insertInto('sso_providers')
      .values({
        organization_id: child.id,
        protocol: 'oidc',
        display_name: 'Test identity provider',
        issuer,
        client_id: 'test-client',
        configuration,
        enabled: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { id: linkId } = await db
      .insertInto('sso_identity_links')
      .values({
        organization_id: child.id,
        provider_id: providerId,
        issuer,
        subject: 'test-owner',
        user_id: child.owner.principal.user.id,
        proven_email: child.owner.principal.user.email,
        email_proven_at: sql<Date>`clock_timestamp()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('sso_policies')
      .values({ organization_id: child.id, require_sso: true })
      .execute()
    await approved(parent.owner, input)

    const challenge = await approveChild(input)
    if (challenge.status !== 'proof_required') throw new Error('Expected the enforced challenge')
    expect(challenge.body.proofMethods).toEqual(['sso'])
    const proofAttemptId = challenge.body.attemptId
    // The OIDC callback records this state if the provider omits auth_time.
    const { step_up_proof_expires_at: deadline } = await db
      .updateTable('sso_attempts')
      .set({
        requires_mailbox: true,
        step_up_provider_id: providerId,
        step_up_link_id: linkId,
        step_up_authenticated_at: sql<Date>`statement_timestamp()`,
        step_up_proof_expires_at: sql<Date>`statement_timestamp() + interval '2 minutes'`,
        step_up_trust_generation: 1,
      })
      .where('id', '=', proofAttemptId)
      .returning('step_up_proof_expires_at')
      .executeTakeFirstOrThrow()
    await expect(approveChild({ ...input, proofAttemptId })).resolves.toMatchObject({
      status: 'proof_required',
      body: { attemptId: proofAttemptId, proofMethods: ['mailbox'] },
    })
    await mailbox(child.owner, proofAttemptId)
    const changed = await approveChild({ ...input, externalId: 'Other-Group', proofAttemptId })
    expect(changed).toMatchObject({ status: 'proof_required' })
    if (changed.status !== 'proof_required') throw new Error('Changed intent reused proof')
    expect(changed.body.attemptId).not.toBe(proofAttemptId)
    await expect(approveChild({ ...input, proofAttemptId })).resolves.toMatchObject({
      status: 'complete',
      value: { intentId: input.intentId },
    })
    expect(
      (await consentRows(input.intentId)).find((item) => item.organization_id === child.id),
    ).toMatchObject({ proof_kind: 'sso', expires_at: deadline })

    const ownerKey: Principal = {
      kind: 'api_key',
      apiKeyId: randomUUID(),
      apiKeyScope: 'full',
      user: child.owner.principal.user,
      organization: child.owner.principal.organization,
    }
    for (const id of [input.intentId, randomUUID()])
      await expect(commitScimTeamMapping(enforcingDeps, ownerKey, id)).rejects.toMatchObject({
        code: 'scim_mapping_access_denied',
      })

    // A provider revision can change without a trust generation change, for example
    // when updating display metadata. An earlier approval keeps its captured revision.
    configuration[29] = 1
    await db
      .updateTable('sso_providers')
      .set({ revision: 2, configuration })
      .where('id', '=', providerId)
      .execute()
    await expect(
      commitScimTeamMapping(enforcingDeps, parent.owner.principal, input.intentId),
    ).rejects.toMatchObject({ code: 'scim_mapping_access_denied' })
    expect(
      await db
        .selectFrom('scim_team_mapping_intents')
        .select('consumed_at')
        .where('id', '=', input.intentId)
        .executeTakeFirst(),
    ).toEqual({ consumed_at: null })
  })

  it('advances the child generation on unlink and requires new consent and ID to reparent', async () => {
    const parent = await team()
    const child = await team()
    const nextParent = await team()
    const stale = link(nextParent, child)
    await both(nextParent, child, stale)
    const input = link(parent, child)
    await both(parent, child, input)
    const first = await commit(parent.owner, input)
    const unlink: Approval = {
      intentId: randomUUID(),
      action: 'unlink',
      parentOrganizationId: parent.id,
      childOrganizationId: child.id,
      connectionId: parent.connectionId,
      mappingId: first.mappingId,
    }
    await both(parent, child, unlink)
    await expect(commit(child.owner, unlink)).resolves.toEqual({
      mappingId: first.mappingId,
      generation: 2,
    })
    expect((await mapping(first.mappingId)).retired_at).toBeTruthy()
    await expect(commit(nextParent.owner, stale)).rejects.toMatchObject({
      code: 'scim_mapping_generation_changed',
    })
    const fresh = link(nextParent, child, stale.externalId, 2)
    await both(nextParent, child, fresh)
    const second = await commit(nextParent.owner, fresh)
    expect(second.generation).toBe(3)
    expect(second.mappingId).not.toBe(first.mappingId)
    await expect(commit(parent.owner, unlink)).rejects.toThrow()
  })

  it('serializes opposite links and then refuses both a second parent and depth two', async () => {
    const a = await team()
    const b = await team()
    const c = await team()
    const ab = link(a, b)
    const ba = link(b, a)
    await both(a, b, ab)
    await both(b, a, ba)
    const race = await Promise.allSettled([commit(a.owner, ab), commit(b.owner, ba)])
    expect(race.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(race.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { code: 'scim_mapping_topology_conflict' },
    })
    const [parent, child] = race[0]?.status === 'fulfilled' ? [a, b] : [b, a]
    for (const [from, to] of [
      [c, child],
      [child, c],
      [c, parent],
    ] as const) {
      const invalid = link(from, to, 'Conflicting-Group', to === child ? 1 : 0)
      await both(from, to, invalid)
      await expect(commit(from.owner, invalid)).rejects.toMatchObject({
        code: 'scim_mapping_topology_conflict',
      })
    }
    expect(
      await db
        .selectFrom('scim_team_mappings')
        .select(['parent_organization_id', 'child_organization_id'])
        .where('parent_organization_id', 'in', [a.id, b.id, c.id])
        .execute(),
    ).toEqual([{ parent_organization_id: parent.id, child_organization_id: child.id }])
  })

  it('rechecks an approving owner session under the commit locks', async () => {
    const parent = await team()
    const child = await team()
    const input = link(parent, child)
    await both(parent, child, input)
    await db.deleteFrom('auth.session').where('id', '=', child.owner.principal.sessionId).execute()
    await expect(commit(parent.owner, input)).rejects.toThrow()
    const { consumed_at } = await db
      .selectFrom('scim_team_mapping_intents')
      .select('consumed_at')
      .where('id', '=', input.intentId)
      .executeTakeFirstOrThrow()
    expect(consumed_at).toBeNull()
  })

  it('sees a privileged roster member promoted by a native write while unlink waits', async () => {
    const parent = await team()
    const child = await team()
    const input = link(parent, child)
    await both(parent, child, input)
    const { mappingId } = await commit(parent.owner, input)
    const { id: memberId } = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', child.id)
      .where('userId', '=', child.member.id)
      .executeTakeFirstOrThrow()
    await db
      .insertInto('scim_team_managed_memberships')
      .values({
        mapping_id: mappingId,
        child_organization_id: child.id,
        member_id: memberId,
        user_id: child.member.id,
      })
      .execute()
    const unlink: Approval = {
      intentId: randomUUID(),
      action: 'unlink',
      parentOrganizationId: parent.id,
      childOrganizationId: child.id,
      connectionId: parent.connectionId,
      mappingId,
    }
    await both(parent, child, unlink)
    const held = await owned.pool.connect()
    let native: Promise<Response> | undefined
    let finalizing: Promise<PromiseSettledResult<unknown>[]> | undefined
    const waitFor = (blocker: number, pattern: string) =>
      vi.waitFor(
        async () => {
          const { rows } = await owned.pool.query<{ pid: number }>(
            'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid)) AND query ILIKE $2',
            [blocker, pattern],
          )
          expect(rows).toHaveLength(1)
          return (rows[0] as { pid: number }).pid
        },
        { timeout: 4000, interval: 20 },
      )
    try {
      await held.query('BEGIN')
      const {
        rows: [connection],
      } = await held.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await held.query('SELECT id FROM auth.member WHERE id = $1 FOR UPDATE', [memberId])
      native = Promise.resolve(
        app.request(`${publicUrl}/api/auth/organization/update-member-role`, {
          method: 'POST',
          headers: child.owner.headers,
          body: JSON.stringify({ organizationId: child.id, memberId, role: 'admin' }),
        }),
      )
      const writer = await waitFor((connection as { pid: number }).pid, '%"auth"."member"%')
      finalizing = Promise.allSettled([commit(parent.owner, unlink)])
      await waitFor(writer, '%auth%organization%for update%')
    } finally {
      try {
        await held.query('ROLLBACK')
      } finally {
        held.release()
        await Promise.allSettled([native, finalizing])
      }
    }
    expect((await native)?.status).toBe(200)
    expect(await finalizing).toEqual([
      {
        status: 'rejected',
        reason: expect.objectContaining({ code: 'scim_mapping_privileged_member' }),
      },
    ])
    expect((await mapping(mappingId)).retired_at).toBeNull()
    expect(
      await db
        .selectFrom('auth.member')
        .select('role')
        .where('id', '=', memberId)
        .executeTakeFirst(),
    ).toEqual({ role: 'admin' })
  })
})
