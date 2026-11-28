import { randomBytes } from 'node:crypto'
import { createScimToken, type Principal, removeTeamMember, rotateScimToken } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import type { MailMessage } from '@hourmere/mail'
import { leaveTeamMember } from '@hourmere/scheduling'
import {
  createTestTeam,
  createTestUser,
  type TestTeam,
  type TestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apiKey, oauthGrant } from '../../../packages/db/src/sso-identity-fixtures.ts'
import {
  claimedDomainValues,
  oidcProviderValues,
} from '../../../packages/db/src/sso-storage-fixtures.ts'
import {
  confirmOwnershipTransfer,
  createOwnershipTransfer,
  type OwnershipTransferDeps,
  revokeOwnershipTransfer,
  viewOwnershipTransfer,
} from './ownership-transfer.ts'
import { ownershipTransferNoticeJob } from './ownership-transfer-notices.ts'
import { createRateLimiter } from './rate-limit.ts'
import type { FreshProofResult } from './sso-fresh-proof.ts'
import {
  bindingCookieName,
  browserBindingDigest,
  consumeMailboxProof,
  deliverMailboxProof,
  readBindingCookie,
  sha256,
} from './sso-mailbox-proof.ts'
import { setSsoPolicy } from './sso-policy.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'https://ownership-transfer.example.test'
const protocolsOff = { ssoOidcEnabled: false, ssoSamlEnabled: false }

type Session = Extract<Principal, { kind: 'session' }>
type Browser = { principal: Session; headers: Headers; membershipId: string }

function completed<T>(result: FreshProofResult<T>): T {
  if (result.status !== 'complete') throw new Error('Expected completed ownership transfer action')
  return result.value
}

function challenge(result: FreshProofResult<unknown>, method = 'mailbox') {
  expect(result).toMatchObject({
    status: 'proof_required',
    body: { error: 'sso_reauthentication_required', proofMethods: [method] },
  })
  if (result.status !== 'proof_required') throw new Error('Expected fresh proof challenge')
  return result.body.attemptId
}

describe.skipIf(!serverUrl)('ownership transfer service', () => {
  let owned: TestDatabase
  let db: Db
  let jobs: ReturnType<typeof createJobs<[ReturnType<typeof ownershipTransferNoticeJob>]>>
  let deps: OwnershipTransferDeps

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'owner_transfer' })
    owned.pool.options.max = 8
    db = createDb(owned.pool)
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [
        ownershipTransferNoticeJob({
          db,
          publicUrl,
          mailer: { send: async () => expect.unreachable('Producer-only outbox') },
        }),
      ],
      work: false,
      migrate: true,
      maxConnections: 2,
      log: () => {},
    })
    await jobs.start()
    deps = { db, publicUrl, capabilities: protocolsOff, notificationQueue: jobs }
  })

  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      await owned?.drop()
    }
  })

  async function browser(user: TestUser, team: TestTeam): Promise<Browser> {
    const { id } = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token: randomBytes(32).toString('base64url'),
        activeOrganizationId: team.id,
        expiresAt: sql`clock_timestamp() + interval '1 hour'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const membership = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', team.id)
      .where('userId', '=', user.id)
      .executeTakeFirstOrThrow()
    return {
      principal: { kind: 'session', user, sessionId: id, organization: team.as(user).organization },
      membershipId: membership.id,
      headers: new Headers({
        origin: publicUrl,
        'X-Expected-Organization-Id': team.id,
        cookie: `${bindingCookieName(publicUrl)}=${randomBytes(32).toString('base64url')}`,
      }),
    }
  }

  async function fixture({
    oldRole = 'owner',
    targetRole = 'member',
    survivor = false,
  }: {
    oldRole?: string
    targetRole?: string
    survivor?: boolean
  } = {}) {
    const owner = await createTestUser(db, 'Initiating owner')
    const recipient = await createTestUser(db, 'Named recipient')
    const other = await createTestUser(db, 'Another team member')
    const team = await createTestTeam(db, [
      { user: owner, role: oldRole },
      { user: recipient, role: targetRole },
      { user: other, role: survivor ? 'owner' : 'member' },
    ])
    return {
      team,
      recipientUser: recipient,
      owner: await browser(owner, team),
      recipient: await browser(recipient, team),
      other: await browser(other, team),
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function initiate(f: Fixture, proofAttemptId?: string, d = deps) {
    return createOwnershipTransfer(d, f.owner.principal, f.owner.headers, f.team.id, {
      targetMembershipId: f.recipient.membershipId,
      ...(proofAttemptId === undefined ? {} : { proofAttemptId }),
    })
  }

  function confirm(f: Fixture, id: string, proofAttemptId?: string, actor = f.recipient, d = deps) {
    return confirmOwnershipTransfer(d, actor.principal, actor.headers, f.team.id, id, {
      ...(proofAttemptId === undefined ? {} : { proofAttemptId }),
    })
  }

  // Seed a completed mailbox ceremony through the same token and attempt guards.
  async function proveMailbox(id: string) {
    await db.transaction().execute(async (trx) => {
      await sql`INSERT INTO sso_mailbox_tokens (attempt_id, organization_id, token_digest, expires_at)
        SELECT id, organization_id, ${sha256(randomBytes(32).toString('base64url'))},
          least(expires_at, clock_timestamp() + interval '3 minutes')
        FROM sso_attempts WHERE id = ${id}::uuid`.execute(trx)
      await sql`UPDATE sso_mailbox_tokens SET consumed_at = clock_timestamp()
        WHERE attempt_id = ${id}::uuid`.execute(trx)
      await sql`UPDATE sso_attempts AS proof
        SET mailbox_proven_at = clock_timestamp(), mailbox_proof_expires_at = token.expires_at
        FROM sso_mailbox_tokens AS token WHERE proof.id = ${id}::uuid AND token.attempt_id = proof.id`.execute(
        trx,
      )
    })
    return id
  }

  async function offer(f: Fixture) {
    const proof = await proveMailbox(challenge(await initiate(f)))
    return completed(await initiate(f, proof))
  }

  async function prepared(f: Fixture) {
    const { id } = await offer(f)
    const proof = await proveMailbox(challenge(await confirm(f, id)))
    return { id, proof }
  }

  async function linkDirectoryUser(organizationId: string, user: Session['user']) {
    const membership = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', organizationId)
      .where('userId', '=', user.id)
      .executeTakeFirstOrThrow()
    const connection = await db
      .insertInto('scim_connections')
      .values({ organization_id: organizationId })
      .returning('id')
      .executeTakeFirstOrThrow()
    const scimUser = await db
      .insertInto('scim_users')
      .values({
        organization_id: organizationId,
        connection_id: connection.id,
        user_name: user.email,
        display_name: user.name,
        active: true,
        linked_user_id: user.id,
        linked_member_id: membership.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { connectionId: connection.id, scimUserId: scimUser.id }
  }

  async function state(id: string) {
    return db
      .selectFrom('organization_ownership_transfers')
      .select(['state', 'terminal_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }

  const attempt = (id: string) =>
    db
      .selectFrom('sso_attempts')
      .select('consumed_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  const members = (f: Fixture) =>
    db
      .selectFrom('auth.member')
      .select(['id', 'role'])
      .where('organizationId', '=', f.team.id)
      .orderBy('id')
      .execute()

  const journal = (f: Fixture) =>
    db
      .selectFrom('audit_events')
      .select([
        'action',
        'actor_type',
        'actor_id',
        'credential_id',
        'target_id',
        'details',
        'request_id',
      ])
      .where('organization_id', '=', f.team.id)
      .orderBy('id')
      .execute()

  const notices = async (f: Fixture) =>
    (
      await owned.pool.query<{ data: { kind: string; userId: string; organizationId: string } }>(
        "SELECT data FROM pgboss.job WHERE data->>'organizationId' = $1 ORDER BY id",
        [f.team.id],
      )
    ).rows.map(({ data }) => data)

  async function assertPending(f: Fixture, id: string, proof: string) {
    expect(await state(id)).toEqual({ state: 'pending', terminal_at: null })
    expect(await attempt(proof)).toEqual({ consumed_at: null })
    expect(await members(f)).toEqual(
      expect.arrayContaining([
        { id: f.owner.membershipId, role: 'owner' },
        { id: f.recipient.membershipId, role: 'member' },
      ]),
    )
    expect((await journal(f)).map(({ action }) => action)).toEqual([
      'organization.ownership_transfer_offered',
    ])
    expect(await notices(f)).toEqual([
      {
        kind: 'offered',
        userId: f.recipient.principal.user.id,
        organizationId: f.team.id,
        transferId: id,
      },
    ])
  }

  async function lockTeam(trx: Db, f: Fixture) {
    await trx
      .selectFrom('auth.organization')
      .select('id')
      .where('id', '=', f.team.id)
      .forUpdate()
      .executeTakeFirstOrThrow()
    return (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]?.pid
  }

  async function waitForBlocked(pid: number | undefined, count: number) {
    await vi.waitFor(async () => {
      const waiting = await owned.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND (query ILIKE '%auth.organization%' OR query ILIKE '%"auth"."organization"%')`,
      )
      expect(waiting.rows[0]?.n).toBe(count)
      const directlyBlocked = await owned.pool.query<{ blocked: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked',
        [pid],
      )
      expect(directlyBlocked.rows[0]?.blocked).toBe(true)
    })
  }

  it.each([
    { oldRole: 'owner', targetRole: 'member' },
    { oldRole: 'admin, owner', targetRole: ' member,admin ' },
  ])(
    'stores canonical roles for $oldRole to $targetRole and preserves other memberships',
    async (roles) => {
      const f = await fixture({ ...roles, survivor: true })
      const { id, proof } = await prepared(f)
      const result = await confirm(f, id, proof)
      expect(completed(result)).toEqual({
        initiator: { membershipId: f.owner.membershipId, role: 'admin' },
        recipient: { membershipId: f.recipient.membershipId, role: 'owner' },
      })
      expect(await members(f)).toHaveLength(3)
      expect(await members(f)).toEqual(
        expect.arrayContaining([
          { id: f.owner.membershipId, role: 'admin' },
          { id: f.recipient.membershipId, role: 'owner' },
          { id: f.other.membershipId, role: 'owner' },
        ]),
      )
      expect(await state(id)).toEqual({ state: 'confirmed', terminal_at: expect.any(Date) })
      expect(await attempt(proof)).toEqual({ consumed_at: expect.any(Date) })
      const events = await journal(f)
      expect(events[0]).toMatchObject({
        action: 'organization.ownership_transfer_offered',
        actor_id: f.owner.principal.user.id,
        credential_id: f.owner.principal.sessionId,
        target_id: f.team.id,
        details: { targetMembershipId: f.recipient.membershipId },
      })
      expect(events.slice(1)).toHaveLength(3)
      expect(events.slice(1)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'organization.ownership_transferred',
            target_id: f.team.id,
            details: {},
          }),
          expect.objectContaining({
            action: 'membership.role_changed',
            target_id: f.owner.membershipId,
            details: { oldRole: roles.oldRole, newRole: 'admin' },
          }),
          expect.objectContaining({
            action: 'membership.role_changed',
            target_id: f.recipient.membershipId,
            details: { oldRole: roles.targetRole, newRole: 'owner' },
          }),
        ]),
      )
      const requestId = events[1]?.request_id
      expect(typeof requestId).toBe('string')
      expect(
        events
          .slice(1)
          .every(
            (event) =>
              event.actor_id === f.recipient.principal.user.id &&
              event.credential_id === f.recipient.principal.sessionId &&
              event.request_id === requestId,
          ),
      ).toBe(true)
      const confirmedNotices = (await notices(f)).filter(({ kind }) => kind === 'confirmed')
      expect(confirmedNotices).toHaveLength(3)
      expect(confirmedNotices.map(({ userId }) => userId).sort()).toEqual(
        [f.owner, f.recipient, f.other].map(({ principal }) => principal.user.id).sort(),
      )
    },
  )

  it('completes a real mailbox challenge with both SSO protocols off and binds it to the browser', async () => {
    const f = await fixture()
    const { id } = await offer(f)
    const proof = challenge(await confirm(f, id))
    const actor = f.recipient.principal
    const presenter = {
      binding: browserBindingDigest(
        readBindingCookie(f.recipient.headers, bindingCookieName(publicUrl)),
      ),
      sessionId: actor.sessionId,
      userId: actor.user.id,
    }
    const messages: MailMessage[] = []
    const delivery = {
      db,
      publicUrl,
      capabilities: protocolsOff,
      mailer: { send: async (message: MailMessage) => void messages.push(message) },
      secret: randomBytes(32).toString('base64url'),
      mailMaxPerHour: 0,
    }
    const job = { ...presenter, attemptId: proof, language: 'en' as const }
    await deliverMailboxProof(delivery, job)
    expect(messages).toHaveLength(0)
    await deliverMailboxProof({ ...delivery, ownershipTransferEnabled: true }, job)
    expect(messages.map(({ to }) => to)).toEqual([actor.user.email])
    const token = /#attempt=[0-9a-f-]+&token=([A-Za-z0-9_-]+)/.exec(messages[0]?.text ?? '')?.[1]
    if (!token) throw new Error('Expected a mailbox proof token in the test mail')
    const consumed = await consumeMailboxProof(
      {
        db,
        capabilities: protocolsOff,
        ownershipTransferEnabled: true,
        guesses: createRateLimiter({ limit: 5, windowSeconds: 600 }),
      },
      { attemptId: proof, token },
      presenter,
    )
    expect(consumed).toBe(true)

    const headers = new Headers(f.recipient.headers)
    headers.set(
      'cookie',
      `${bindingCookieName(publicUrl)}=${randomBytes(32).toString('base64url')}`,
    )
    const wrongBrowser = await confirm(f, id, proof, { ...f.recipient, headers })
    expect(challenge(wrongBrowser)).not.toBe(proof)
    await assertPending(f, id, proof)
    await expect(confirm(f, id, proof)).resolves.toMatchObject({ status: 'complete' })
  })

  it('clears the recipient’s custom assignment and advances its generation atomically with transfer', async () => {
    const f = await fixture()
    const organizationId = f.team.id
    const memberId = f.recipient.membershipId
    const authorization = () =>
      db
        .selectFrom('team_member_authorizations')
        .select(['generation', 'fixed_role'])
        .where('organization_id', '=', organizationId)
        .where('member_id', '=', memberId)
        .executeTakeFirstOrThrow()
    const assignment = () =>
      db
        .selectFrom('custom_role_assignments')
        .select('role_id')
        .where('organization_id', '=', organizationId)
        .where('member_id', '=', memberId)
        .executeTakeFirst()

    // Seed a retained assignment while both custom-role switches are off.
    const role = await db.transaction().execute(async (trx) => {
      const { id } = await trx
        .insertInto('custom_roles')
        .values({ organization_id: organizationId, active_revision: 1 })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('custom_role_revisions')
        .values({
          organization_id: organizationId,
          role_id: id,
          revision: 1,
          name: 'Coordinator',
          permission_ids: ['event_types.create'],
        })
        .execute()
      await trx
        .insertInto('custom_role_assignments')
        .values({
          organization_id: organizationId,
          member_id: memberId,
          user_id: f.recipient.principal.user.id,
          role_id: id,
          assigned_by_user_id: f.owner.principal.user.id,
        })
        .execute()
      return id
    })
    const before = await authorization()
    expect(before).toEqual({ generation: 2, fixed_role: 'member' })
    expect(await assignment()).toEqual({ role_id: role })
    const { id, proof } = await prepared(f)
    const failingDeps = {
      ...deps,
      notificationQueue: {
        async enqueue() {
          throw new Error('Synthetic failure after role updates')
        },
      },
    }
    await expect(confirm(f, id, proof, f.recipient, failingDeps)).rejects.toThrow(
      'Synthetic failure after role updates',
    )
    await assertPending(f, id, proof)
    expect(await authorization()).toEqual(before)
    expect(await assignment()).toEqual({ role_id: role })

    expect(completed(await confirm(f, id, proof)).recipient).toEqual({
      membershipId: memberId,
      role: 'owner',
    })
    expect(await authorization()).toEqual({
      generation: before.generation + 1,
      fixed_role: 'owner',
    })
    expect(await assignment()).toBeUndefined()
    expect(
      (await journal(f)).filter(({ action }) => action === 'membership.custom_role_cleared'),
    ).toEqual([
      expect.objectContaining({
        actor_type: 'system',
        target_id: memberId,
        details: expect.objectContaining({ roleId: role, oldRevision: 1 }),
      }),
    ])
  })

  it('serializes two proved confirmations and rejects replay without consuming the losing proof', async () => {
    const f = await fixture()
    const { id, proof } = await prepared(f)
    const secondProof = await proveMailbox(challenge(await confirm(f, id)))
    let raced: Promise<PromiseSettledResult<FreshProofResult<unknown>>[]> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        const pid = await lockTeam(trx, f)
        raced = Promise.allSettled([confirm(f, id, proof), confirm(f, id, secondProof)])
        await waitForBlocked(pid, 2)
      })
    } finally {
      await raced
    }
    const outcomes = await raced
    expect(outcomes).toHaveLength(2)
    expect(outcomes?.filter(({ status }) => status === 'fulfilled')).toEqual([
      expect.objectContaining({ value: expect.objectContaining({ status: 'complete' }) }),
    ])
    expect(outcomes?.filter(({ status }) => status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'ownership_transfer_unavailable' }),
      }),
    ])
    expect(
      [await attempt(proof), await attempt(secondProof)].filter(({ consumed_at }) => consumed_at),
    ).toHaveLength(1)
    await expect(confirm(f, id, proof)).rejects.toMatchObject({
      code: 'ownership_transfer_unavailable',
    })
    expect(
      (await journal(f)).filter(({ action }) => action === 'organization.ownership_transferred'),
    ).toHaveLength(1)
    expect((await notices(f)).filter(({ kind }) => kind === 'confirmed')).toHaveLength(2)
  })

  it('orders member removal ahead of a waiting confirmation and binds the offer to the deleted membership', async () => {
    const f = await fixture()
    const { id, proof } = await prepared(f)
    let result: Promise<unknown> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        const pid = await lockTeam(trx, f)
        result = expect(confirm(f, id, proof)).rejects.toMatchObject({
          code: 'team_management_access_denied',
        })
        await waitForBlocked(pid, 1)
        await removeTeamMember(trx, f.owner.principal, {
          expectedOrganizationId: f.team.id,
          teamId: f.team.id,
          memberUserId: f.recipient.principal.user.id,
        })
      })
    } finally {
      await result
    }
    expect(await state(id)).toMatchObject({ state: 'invalidated' })
    expect(await attempt(proof)).toEqual({ consumed_at: null })
    expect(await members(f)).toEqual(
      expect.arrayContaining([{ id: f.owner.membershipId, role: 'owner' }]),
    )
    const replacement = await db
      .insertInto('auth.member')
      .values({
        organizationId: f.team.id,
        userId: f.recipient.principal.user.id,
        role: 'member',
        createdAt: sql`clock_timestamp()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    expect(replacement.id).not.toBe(f.recipient.membershipId)
    await expect(confirm(f, id, proof)).rejects.toMatchObject({
      code: 'team_management_access_denied',
    })
    expect(
      (await journal(f)).filter(
        ({ action }) => action === 'organization.ownership_transfer_invalidated',
      ),
    ).toEqual([
      expect.objectContaining({ actor_type: 'system', target_id: f.team.id, details: {} }),
    ])
  })

  it('invalidates when the initiating owner leaves before a waiting confirmation', async () => {
    const f = await fixture({ survivor: true })
    const { id, proof } = await prepared(f)
    let result: Promise<unknown> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        const pid = await lockTeam(trx, f)
        result = expect(confirm(f, id, proof)).rejects.toMatchObject({
          code: 'ownership_transfer_unavailable',
        })
        await waitForBlocked(pid, 1)
        await leaveTeamMember(testContext(trx, f.owner.principal), {
          expectedOrganizationId: f.team.id,
          teamId: f.team.id,
        })
      })
    } finally {
      await result
    }
    expect(await state(id)).toMatchObject({ state: 'invalidated' })
    expect(await attempt(proof)).toEqual({ consumed_at: null })
    expect(await members(f)).toEqual(
      expect.arrayContaining([
        { id: f.recipient.membershipId, role: 'member' },
        { id: f.other.membershipId, role: 'owner' },
      ]),
    )
    expect(
      (await journal(f)).filter(({ action }) => action === 'organization.ownership_transferred'),
    ).toHaveLength(0)
  })

  it('keeps the sole owner until confirmation commits, then lets the former owner leave', async () => {
    const f = await fixture()
    const { id, proof } = await prepared(f)
    const leave = () =>
      leaveTeamMember(testContext(db, f.owner.principal), {
        expectedOrganizationId: f.team.id,
        teamId: f.team.id,
      })
    await expect(leave()).rejects.toMatchObject({ code: 'member_departure_owner_required' })
    await assertPending(f, id, proof)
    await expect(confirm(f, id, proof)).resolves.toMatchObject({ status: 'complete' })
    await expect(leave()).resolves.toHaveProperty('organizationId')
    expect(await members(f)).toEqual(
      expect.arrayContaining([{ id: f.recipient.membershipId, role: 'owner' }]),
    )
    expect((await members(f)).filter(({ role }) => role === 'owner')).toHaveLength(1)
  })

  it('retires an offer using the database clock after a confirmation waits for the team', async () => {
    const f = await fixture()
    const { id, proof } = await prepared(f)
    let result: Promise<unknown> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        const pid = await lockTeam(trx, f)
        // Seed a deadline just ahead of the database clock without waiting 24 hours.
        await sql`SET LOCAL session_replication_role = replica`.execute(trx)
        const { rows } = await sql<{ expires_at: string }>`
          WITH deadline AS (SELECT clock_timestamp() + interval '350 milliseconds' AS instant)
          UPDATE organization_ownership_transfers
          SET created_at = deadline.instant - interval '24 hours', expires_at = deadline.instant
          FROM deadline WHERE id = ${id}::uuid
          RETURNING expires_at::text`.execute(trx)
        await sql`SET LOCAL session_replication_role = origin`.execute(trx)
        const deadline = rows[0]?.expires_at
        result = expect(confirm(f, id, proof)).rejects.toMatchObject({
          code: 'ownership_transfer_unavailable',
        })
        await waitForBlocked(pid, 1)
        await sql`SELECT pg_sleep_until(${deadline}::timestamptz)`.execute(trx)
      })
    } finally {
      await result
    }
    expect(await state(id)).toMatchObject({ state: 'expired' })
    expect(await attempt(proof)).toEqual({ consumed_at: null })
    await expect(confirm(f, id, proof)).rejects.toMatchObject({
      code: 'ownership_transfer_unavailable',
    })
    expect((await journal(f)).map(({ action }) => action)).toEqual([
      'organization.ownership_transfer_offered',
      'organization.ownership_transfer_expired',
    ])
    expect((await members(f)).filter(({ role }) => role === 'owner')).toEqual([
      { id: f.owner.membershipId, role: 'owner' },
    ])
  })

  it.each([
    {
      change: 'the recipient becomes directly SCIM-managed',
      apply: (f: Fixture) => linkDirectoryUser(f.team.id, f.recipient.principal.user),
    },
    {
      change: 'the recipient becomes SCIM-managed in a child team',
      apply: async (f: Fixture) => {
        const parentOwner = await createTestUser(db, 'Directory parent owner')
        const parent = await createTestTeam(db, [
          { user: parentOwner, role: 'owner' },
          { user: f.recipientUser, role: 'member' },
        ])
        const { connectionId, scimUserId } = await linkDirectoryUser(parent.id, f.recipientUser)
        const mapping = await db
          .insertInto('scim_team_mappings')
          .values({
            parent_organization_id: parent.id,
            child_organization_id: f.team.id,
            connection_id: connectionId,
            external_id: 'directory-group',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        await db.insertInto('scim_groups').values({ mapping_id: mapping.id }).execute()
        // Attach provenance to the existing membership the offer targets.
        await db
          .insertInto('scim_team_managed_memberships')
          .values({
            mapping_id: mapping.id,
            child_organization_id: f.team.id,
            member_id: f.recipient.membershipId,
            user_id: f.recipientUser.id,
            scim_user_id: scimUserId,
          })
          .execute()
      },
    },
    {
      change: 'the initiator becomes directly SCIM-managed',
      apply: (f: Fixture) => linkDirectoryUser(f.team.id, f.owner.principal.user),
    },
    {
      change: 'the initiator loses ownership outside the team role policy',
      apply: (f: Fixture) =>
        db
          .updateTable('auth.member')
          .set({ role: 'admin' })
          .where('id', '=', f.owner.membershipId)
          .returning('id')
          .executeTakeFirstOrThrow(),
    },
  ])('invalidates on confirmation when $change', async ({ apply }) => {
    const f = await fixture({ survivor: true })
    const { id, proof } = await prepared(f)
    await apply(f)
    const rolesBeforeConfirm = await members(f)
    expect(await state(id)).toEqual({ state: 'pending', terminal_at: null })

    await expect(confirm(f, id, proof)).rejects.toMatchObject({
      code: 'ownership_transfer_unavailable',
    })

    expect(await state(id)).toEqual({ state: 'invalidated', terminal_at: expect.any(Date) })
    expect(await attempt(proof)).toEqual({ consumed_at: null })
    expect(await members(f)).toEqual(rolesBeforeConfirm)
    expect((await journal(f)).map(({ action }) => action)).toEqual([
      'organization.ownership_transfer_offered',
      'organization.ownership_transfer_invalidated',
    ])
  })

  it('rechecks both verified accounts, the named membership, and browser context before consuming proof', async () => {
    const f = await fixture({ survivor: true })
    const { id, proof } = await prepared(f)
    await expect(confirm(f, id, proof, f.other)).rejects.toMatchObject({
      code: 'team_management_access_denied',
    })
    const bearer = new Headers(f.recipient.headers)
    bearer.set('Authorization', 'Bearer synthetic-only')
    await expect(confirm(f, id, proof, { ...f.recipient, headers: bearer })).rejects.toMatchObject({
      code: 'team_management_access_denied',
    })
    const crossTeam = await createTestTeam(db, [])
    await expect(
      confirmOwnershipTransfer(deps, f.recipient.principal, f.recipient.headers, crossTeam.id, id, {
        proofAttemptId: proof,
      }),
    ).rejects.toMatchObject({ code: 'team_management_access_denied' })
    const setVerified = (actor: Browser, emailVerified: boolean) =>
      db
        .updateTable('auth.user')
        .set({ emailVerified })
        .where('id', '=', actor.principal.user.id)
        .execute()
    await setVerified(f.owner, false)
    await expect(confirm(f, id, proof)).rejects.toMatchObject({
      code: 'team_management_access_denied',
    })
    await assertPending(f, id, proof)
    await setVerified(f.owner, true)
    const personal = await db
      .selectFrom('personal_organizations')
      .select('organization_id')
      .where('user_id', '=', f.recipient.principal.user.id)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: personal.organization_id })
      .where('id', '=', f.recipient.principal.sessionId)
      .execute()
    await expect(confirm(f, id, proof)).rejects.toMatchObject({
      code: 'organization_context_changed',
    })
    await assertPending(f, id, proof)
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: f.team.id })
      .where('id', '=', f.recipient.principal.sessionId)
      .execute()
    await setVerified(f.recipient, false)
    await expect(confirm(f, id, proof)).rejects.toMatchObject({
      code: 'team_management_access_denied',
    })
    await assertPending(f, id, proof)
    await setVerified(f.recipient, true)
    // Re-verification revokes stale sessions and cascades their fresh-proof attempts.
    await expect(confirm(f, id, proof)).rejects.toMatchObject({
      code: 'team_management_access_denied',
    })
    const refreshed = await browser(f.recipientUser, f.team)
    const refreshedProof = await proveMailbox(challenge(await confirm(f, id, undefined, refreshed)))
    await expect(confirm(f, id, refreshedProof, refreshed)).resolves.toMatchObject({
      status: 'complete',
    })
  })

  it('lets another owner revoke while the recipient is temporarily unverified', async () => {
    const f = await fixture({ survivor: true })
    const { id, proof } = await prepared(f)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', f.recipient.principal.user.id)
      .execute()
    const visible = await viewOwnershipTransfer(deps, f.other.principal, f.other.headers, f.team.id)
    const projected = JSON.stringify(visible)
    expect(projected).toContain(id)
    expect(projected).not.toContain(f.owner.membershipId)
    expect(projected).not.toContain(f.recipient.membershipId)
    expect(projected).not.toContain(f.owner.principal.user.name)
    expect(projected).not.toContain(f.recipient.principal.user.name)
    await revokeOwnershipTransfer(deps, f.other.principal, f.other.headers, f.team.id, id)
    expect(await state(id)).toMatchObject({ state: 'revoked' })
    expect(await attempt(proof)).toEqual({ consumed_at: null })
    expect((await journal(f)).at(-1)).toMatchObject({
      action: 'organization.ownership_transfer_revoked',
      actor_id: f.other.principal.user.id,
      credential_id: f.other.principal.sessionId,
      details: {},
    })
  })

  it('shares aligned create and revoke budgets across owners and allows revocation of a carried offer', async () => {
    // Starting near the real hourly boundary would mix the simulated and actual rollover.
    await sql`SELECT pg_sleep(
      CASE WHEN extract(epoch FROM date_trunc('hour', clock_timestamp()) + interval '1 hour' - clock_timestamp()) < 1
        THEN 1 ELSE 0 END)`.execute(db)
    const f = await fixture({ survivor: true })
    const carry = await offer(f)
    await db
      .updateTable('organization_ownership_transfer_budgets')
      .set({ window_start: sql`window_start - interval '1 hour'` })
      .where('organization_id', '=', f.team.id)
      .execute()
    const revoke = (actor: Browser, id: string) =>
      revokeOwnershipTransfer(deps, actor.principal, actor.headers, f.team.id, id)
    await revoke(f.other, carry.id)

    async function teamOffer(actor: Browser) {
      const send = (proofAttemptId?: string) =>
        createOwnershipTransfer(deps, actor.principal, actor.headers, f.team.id, {
          targetMembershipId: f.recipient.membershipId,
          ...(proofAttemptId === undefined ? {} : { proofAttemptId }),
        })
      const proof = await proveMailbox(challenge(await send()))
      return { proof, submit: () => send(proof) }
    }

    const [first, second] = await Promise.all([teamOffer(f.owner), teamOffer(f.other)])
    const raced = await Promise.allSettled([first.submit(), second.submit()])
    const accepted = raced.filter((result) => result.status === 'fulfilled')
    expect(accepted).toHaveLength(1)
    expect(raced).toContainEqual(
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'ownership_transfer_pending' }),
      }),
    )
    const winner = accepted[0]
    if (!winner) throw new Error('Expected one concurrent offer to commit')
    await revoke(f.owner, completed(winner.value).id)
    for (let i = 0; i < 4; i++) {
      const next = await teamOffer(i % 2 ? f.owner : f.other)
      await revoke(f.other, completed(await next.submit()).id)
    }
    const refused = await teamOffer(f.owner)
    const failure = await refused.submit().catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'rate_limited', retryAfterSeconds: expect.any(Number) })
    const { retryAfterSeconds } = failure as { retryAfterSeconds: number }
    expect(retryAfterSeconds).toBeGreaterThan(0)
    expect(retryAfterSeconds).toBeLessThanOrEqual(3600)
    expect(await attempt(refused.proof)).toEqual({ consumed_at: null })
    const budgets = await db
      .selectFrom('organization_ownership_transfer_budgets')
      .select(['operation', 'request_count', 'window_start'])
      .where('organization_id', '=', f.team.id)
      .orderBy('operation')
      .execute()
    expect(budgets).toEqual([
      { operation: 'initiate', request_count: 5, window_start: expect.any(Date) },
      { operation: 'revoke', request_count: 6, window_start: expect.any(Date) },
    ])
    expect(budgets[0]?.window_start).toEqual(budgets[1]?.window_start)
    expect((await notices(f)).filter(({ kind }) => kind === 'offered')).toHaveLength(6)
  })

  it('rolls back roles, proof, offer, audit and jobs when a later write fails', async () => {
    const f = await fixture()
    const { id, proof } = await prepared(f)
    await sql`ALTER TABLE audit_events ADD CONSTRAINT ownership_transfer_test_reject_audit
      CHECK (action <> 'organization.ownership_transferred') NOT VALID`.execute(db)
    try {
      await expect(confirm(f, id, proof)).rejects.toMatchObject({
        constraint: 'ownership_transfer_test_reject_audit',
      })
      await assertPending(f, id, proof)
    } finally {
      await sql`ALTER TABLE audit_events DROP CONSTRAINT ownership_transfer_test_reject_audit`.execute(
        db,
      )
    }
    const failingDeps = {
      ...deps,
      notificationQueue: {
        async enqueue(...args: Parameters<OwnershipTransferDeps['notificationQueue']['enqueue']>) {
          await jobs.enqueue(...args)
          throw new Error('Synthetic outbox failure after enqueue')
        },
      },
    }
    await expect(confirm(f, id, proof, f.recipient, failingDeps)).rejects.toThrow(
      'Synthetic outbox failure',
    )
    await assertPending(f, id, proof)
    await expect(confirm(f, id, proof)).resolves.toMatchObject({ status: 'complete' })
  })

  function addRecoveryOwner(f: Fixture, actor: Browser, nominator: Browser) {
    return db
      .insertInto('sso_recovery_owners')
      .values({
        organization_id: f.team.id,
        user_id: actor.principal.user.id,
        member_id: actor.membershipId,
        nominated_by_user_id: nominator.principal.user.id,
      })
      .execute()
  }

  it('requires enforced step-up and keeps the last usable recovery owner until another has accepted', async () => {
    const f = await fixture({ survivor: true })
    const { id, proof: mailboxProof } = await prepared(f)
    const d = { ...deps, capabilities: { ...protocolsOff, ssoOidcEnabled: true } }
    const organizationId = f.team.id
    const providerValues = oidcProviderValues(organizationId)
    const provider = await db
      .insertInto('sso_providers')
      .values({
        ...providerValues,
        enabled: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const domain = await db
      .insertInto('sso_domains')
      .values({
        ...claimedDomainValues(organizationId),
        claimed_at: sql`clock_timestamp() - interval '1 day'`,
        verified_at: sql`clock_timestamp() - interval '1 day'`,
        verification_expires_at: sql`clock_timestamp() + interval '6 days'`,
        last_checked_at: sql`clock_timestamp() - interval '1 minute'`,
        challenge_expires_at: sql`clock_timestamp() + interval '1 day'`,
        next_check_at: sql`clock_timestamp() + interval '1 day'`,
      })
      .returning(['id', 'generation'])
      .executeTakeFirstOrThrow()
    await db
      .insertInto('sso_provider_domains')
      .values({
        organization_id: organizationId,
        domain_id: domain.id,
        provider_id: provider.id,
      })
      .execute()
    await addRecoveryOwner(f, f.owner, f.other)
    await db
      .insertInto('sso_policies')
      .values({ organization_id: organizationId, require_sso: true })
      .execute()
    const browserProof = async (actor: Browser) => {
      const userId = actor.principal.user.id
      const link = await db
        .insertInto('sso_identity_links')
        .values({
          organization_id: organizationId,
          provider_id: provider.id,
          issuer: providerValues.issuer,
          subject: userId,
          user_id: userId,
          proven_email: actor.principal.user.email,
          email_proven_at: sql`clock_timestamp()`,
        })
        .returning(['id', 'generation'])
        .executeTakeFirstOrThrow()
      await db
        .insertInto('sso_browser_proofs')
        .values({
          organization_id: organizationId,
          user_id: userId,
          member_id: actor.membershipId,
          session_id: actor.principal.sessionId,
          provider_id: provider.id,
          link_id: link.id,
          link_generation: link.generation,
          trust_generation: 1,
          domain_id: domain.id,
          domain_generation: domain.generation,
          expires_at: sql`clock_timestamp() + interval '30 minutes'`,
        })
        .execute()
      return link.id
    }
    await browserProof(f.owner)
    const recipientLink = await browserProof(f.recipient)
    const actual = challenge(await confirm(f, id, mailboxProof, f.recipient, d), 'sso')
    expect(actual).not.toBe(mailboxProof)
    await db
      .updateTable('sso_attempts')
      .set({
        step_up_provider_id: provider.id,
        step_up_link_id: recipientLink,
        step_up_authenticated_at: sql`clock_timestamp()`,
        step_up_proof_expires_at: sql`clock_timestamp() + interval '2 minutes'`,
        step_up_trust_generation: 1,
      })
      .where('id', '=', actual)
      .executeTakeFirstOrThrow()

    const confirmWithStepUp = () => confirm(f, id, actual, f.recipient, d)
    await expect(confirmWithStepUp()).rejects.toMatchObject({ code: 'sso_recovery_required' })
    await assertPending(f, id, actual)
    await addRecoveryOwner(f, f.other, f.owner)
    const verifyBackup = (emailVerified: boolean) =>
      db
        .updateTable('auth.user')
        .set({ emailVerified })
        .where('id', '=', f.other.principal.user.id)
        .execute()
    await verifyBackup(false)
    await expect(confirmWithStepUp()).rejects.toMatchObject({ code: 'sso_recovery_required' })
    await assertPending(f, id, actual)
    await verifyBackup(true)
    await expect(confirmWithStepUp()).resolves.toMatchObject({ status: 'complete' })
    expect(await attempt(mailboxProof)).toEqual({ consumed_at: null })
    expect(
      await db
        .selectFrom('sso_recovery_owners')
        .select('user_id')
        .where('organization_id', '=', organizationId)
        .execute(),
    ).toEqual([{ user_id: f.other.principal.user.id }])
    const editPolicy = (actor: Browser) =>
      setSsoPolicy(d, actor.principal, actor.headers, {
        admission: 'invitation_only',
        expectedRevision: 2,
        requireSso: false,
      })
    await expect(editPolicy(f.owner)).rejects.toMatchObject({
      code: 'team_management_access_denied',
    })
    expect(challenge(await editPolicy(f.recipient), 'sso')).not.toBe(actual)
  })

  it('clears recovery records and nominations and rechecks owner authority from the open sessions', async () => {
    const f = await fixture({ survivor: true })
    const ownerId = f.owner.principal.user.id
    const otherId = f.other.principal.user.id
    await db
      .insertInto('sso_policies')
      .values({ organization_id: f.team.id, policy_revision: 4 })
      .execute()
    await addRecoveryOwner(f, f.owner, f.other)
    await db
      .insertInto('sso_recovery_nominations')
      .values(
        [
          { user_id: ownerId, member_id: f.owner.membershipId, nominated_by_user_id: otherId },
          { user_id: otherId, member_id: f.other.membershipId, nominated_by_user_id: ownerId },
        ].map((item) => ({
          ...item,
          organization_id: f.team.id,
          expires_at: sql<Date>`clock_timestamp() + interval '72 hours'`,
        })),
      )
      .execute()
    const client = await owned.pool.connect()
    let keyId: string
    let grantId: string
    try {
      keyId = await apiKey(client, ownerId, f.team.id)
      grantId = await oauthGrant(client, ownerId, f.team.id)
    } finally {
      client.release()
    }
    const scimActor = (actor: Browser) => ({
      userId: actor.principal.user.id,
      sessionId: actor.principal.sessionId,
      organizationId: f.team.id,
    })
    const { token } = await createScimToken(db, { ...scimActor(f.owner), name: 'Directory token' })
    const { id, proof } = await prepared(f)
    await expect(confirm(f, id, proof)).resolves.toMatchObject({ status: 'complete' })
    const rotate = (actor: Browser) =>
      rotateScimToken(db, { ...scimActor(actor), tokenId: token.id, overlapSeconds: 0 })
    await expect(
      createScimToken(db, { ...scimActor(f.owner), name: 'Old owner' }),
    ).rejects.toMatchObject({
      status: 403,
    })
    await expect(rotate(f.owner)).rejects.toMatchObject({ status: 403 })
    expect((await rotate(f.recipient)).token).toMatchObject({
      createdByUserId: ownerId,
      rotatedByUserId: f.recipient.principal.user.id,
    })
    expect(
      (await createScimToken(db, { ...scimActor(f.recipient), name: 'New owner' })).token
        .createdByUserId,
    ).toBe(f.recipient.principal.user.id)
    expect(
      await db
        .selectFrom('sso_recovery_owners')
        .select('user_id')
        .where('organization_id', '=', f.team.id)
        .execute(),
    ).toEqual([])
    expect(
      await db
        .selectFrom('sso_recovery_nominations')
        .select('id')
        .where('organization_id', '=', f.team.id)
        .execute(),
    ).toEqual([])
    expect(
      await db
        .selectFrom('sso_policies')
        .select('policy_revision')
        .where('organization_id', '=', f.team.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ policy_revision: 5 })
    expect(
      (await journal(f)).filter(({ action }) => action === 'sso_recovery.removed'),
    ).toHaveLength(1)
    expect(
      await db
        .selectFrom('auth.apikey')
        .select('referenceId')
        .where('id', '=', keyId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ referenceId: ownerId })
    expect(
      await db
        .selectFrom('mcp_oauth_grants')
        .select(['user_id', 'organization_id'])
        .where('id', '=', grantId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      user_id: ownerId,
      organization_id: f.team.id,
    })
  })
})
