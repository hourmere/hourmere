// These dependency probes deliberately bypass Hourmere's invitation admission hook to
// retain evidence of Better Auth's native transaction gaps. Product behavior is covered
// separately by invitation-limits.test.ts; production always installs the admission hook.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createAuth, createAuthPool, createCallerResolver, type SignupPolicy } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs, defineJob } from '@hourmere/jobs'
import { sql } from 'kysely'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createApp } from './app.ts'
import { EXPECTED_ORGANIZATION_HEADER } from './team-management.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:3000'
const OPEN: SignupPolicy = { mode: 'open', allowedDomains: [] }
const queueName = 'invitation-delivery-ordering-probe'
const delivery = defineJob({
  name: queueName,
  payload: z.strictObject({ invitationId: z.uuid(), generation: z.literal(1) }),
  policy: 'exclusive',
  handler: async () => {},
})

interface HookInput {
  invitation: { id?: string }
  organization: { id: string }
}
interface OrganizationOptions {
  sendInvitationEmail?: (input: HookInput) => Promise<void>
  organizationHooks: Record<string, (input: HookInput) => unknown>
}

describe.skipIf(!serverUrl)('invitation creation and delivery enqueue ordering', () => {
  let testDb: TestDatabase
  let db: Db
  let authPool: pg.Pool
  let jobs: ReturnType<typeof createJobs<readonly [typeof delivery]>>
  const successfulEnqueues: string[] = []

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_delivery' })
    db = createDb(testDb.pool)
    authPool = createAuthPool(testDb.url, OPEN)
    jobs = createJobs({
      connectionString: testDb.url,
      definitions: [delivery] as const,
      work: false,
      migrate: true,
      maxConnections: 2,
      log: () => {},
    })
    await jobs.start()
    // This fixture deliberately does not install a production migration or generate types.
    await testDb.pool.query(`
      CREATE TABLE invitation_delivery_probe (
        invitation_id uuid PRIMARY KEY REFERENCES auth.invitation(id) ON DELETE CASCADE,
        generation integer NOT NULL,
        job_id uuid
      );
      CREATE FUNCTION fail_invitation_probe_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = 'invitation-delivery-ordering-probe' THEN
          RAISE EXCEPTION 'synthetic queue insert failure' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $$
    `)
  })
  beforeEach(async () => {
    successfulEnqueues.length = 0
    await testDb.pool.query('DROP TRIGGER IF EXISTS invitation_probe_queue_failure ON pgboss.job')
    await testDb.pool.query('DELETE FROM pgboss.job WHERE name = $1', [queueName])
    await testDb.pool.query('DELETE FROM auth.organization')
    await testDb.pool.query('DELETE FROM auth."user"')
    // Dependency errors are intentionally synthetic and contain no recipient or links.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      try {
        await authPool?.end()
      } finally {
        await testDb?.drop()
      }
    }
  })

  function instance(instrument: (options: OrganizationOptions) => void = () => {}) {
    const secret = randomBytes(32).toString('base64')
    const auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup: OPEN,
      mailer: { send: async () => {} },
    })
    const hookOptions: { hooks?: typeof auth.options.hooks } = auth.options
    hookOptions.hooks = undefined
    const plugin = auth.options.plugins.find((candidate) => candidate.id === 'organization')
    const options = (plugin as unknown as { options: OrganizationOptions }).options
    instrument(options)
    return {
      app: createApp({
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        checkDb: async () => {},
        publicUrl: origin,
      }),
      secret,
    }
  }

  async function owner(i: ReturnType<typeof instance>) {
    const userId = randomUUID()
    const organizationId = randomUUID()
    const token = randomBytes(24).toString('base64url')
    await testDb.pool.query(
      `INSERT INTO auth."user" (id, name, email, "emailVerified")
       VALUES ($1, 'Owner', 'owner@example.com', true)`,
      [userId],
    )
    await testDb.pool.query(
      `INSERT INTO auth.organization (id, name, slug, "createdAt")
       VALUES ($1, 'Inviting team', $2, now())`,
      [organizationId, organizationId],
    )
    await testDb.pool.query(
      `INSERT INTO auth.member ("organizationId", "userId", role, "createdAt")
       VALUES ($1, $2, 'owner', now())`,
      [organizationId, userId],
    )
    await testDb.pool.query(
      `INSERT INTO auth.session ("expiresAt", token, "updatedAt", "userId", "activeOrganizationId")
       VALUES (now() + interval '1 hour', $1, now(), $2, $3)`,
      [token, userId, organizationId],
    )
    const signature = createHmac('sha256', i.secret).update(token).digest('base64')
    const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
    return { organizationId, cookie }
  }

  const invite = (
    i: ReturnType<typeof instance>,
    actor: Awaited<ReturnType<typeof owner>>,
    resend = false,
  ) =>
    i.app.request('/api/auth/organization/invite-member', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        cookie: actor.cookie,
        [EXPECTED_ORGANIZATION_HEADER]: actor.organizationId,
      },
      body: JSON.stringify({
        email: 'recipient@example.com',
        role: 'member',
        organizationId: actor.organizationId,
        resend,
      }),
    })

  const invitations = async () =>
    (
      await testDb.pool.query<{ id: string; status: string }>(
        'SELECT id, status FROM auth.invitation',
      )
    ).rows
  const ledger = async () =>
    (
      await testDb.pool.query(
        'SELECT invitation_id, generation, job_id FROM invitation_delivery_probe',
      )
    ).rows
  const queued = async () =>
    (
      await testDb.pool.query<{ id: string; data: unknown; singleton_key: string }>(
        'SELECT id, data, singleton_key FROM pgboss.job WHERE name = $1',
        [queueName],
      )
    ).rows
  const gaps = async () =>
    (
      await testDb.pool.query<{ id: string }>(`
        SELECT i.id FROM auth.invitation i
        LEFT JOIN invitation_delivery_probe d ON d.invitation_id = i.id
        WHERE i.status = 'pending' AND i."expiresAt" > clock_timestamp()
          AND d.invitation_id IS NULL
        ORDER BY i.id
      `)
    ).rows

  async function failQueueInsert() {
    await testDb.pool.query(`
      CREATE TRIGGER invitation_probe_queue_failure BEFORE INSERT ON pgboss.job
      FOR EACH ROW EXECUTE FUNCTION fail_invitation_probe_enqueue()
    `)
  }

  // A small transaction fixture only: production also needs leases, finite budgets,
  // lifecycle guards, missing-job reconciliation, resend generations and retention.
  async function recordAndEnqueue(invitationId: string, interruptBeforeCommit = false) {
    return db.transaction().execute(async (trx) => {
      const inserted = await sql`
        INSERT INTO invitation_delivery_probe (invitation_id, generation)
        VALUES (${invitationId}::uuid, 1) ON CONFLICT DO NOTHING RETURNING invitation_id
      `.execute(trx)
      if (!inserted.rows.length) return false
      const jobId = await jobs.enqueue(
        queueName,
        { invitationId, generation: 1 },
        { singletonKey: `invitation:${invitationId}:1`, transaction: trx },
      )
      if (!jobId) throw new Error('synthetic duplicate without delivery record')
      successfulEnqueues.push(jobId)
      await sql`
        UPDATE invitation_delivery_probe SET job_id = ${jobId}::uuid
        WHERE invitation_id = ${invitationId}::uuid
      `.execute(trx)
      if (interruptBeforeCommit) throw new Error('synthetic interruption before delivery commit')
      return true
    })
  }

  it('fails before invitation INSERT when enqueue in the before-create hook fails', async () => {
    await failQueueInsert()
    const beforeIds: boolean[] = []
    const i = instance((options) => {
      const original = options.organizationHooks.beforeCreateInvitation
      options.organizationHooks.beforeCreateInvitation = async (input) => {
        await original?.(input)
        beforeIds.push(input.invitation.id !== undefined)
        // The id does not exist yet; a placeholder is solely for exercising queue failure.
        await jobs.enqueue(queueName, { invitationId: randomUUID(), generation: 1 })
      }
    })
    const response = await invite(i, await owner(i))
    expect(response.status).toBe(500)
    expect(beforeIds).toEqual([false])
    expect(await invitations()).toEqual([])
    expect(await ledger()).toEqual([])
    expect(await queued()).toEqual([])
  })

  it('leaves a pending invitation but rolls back its delivery record when queue INSERT fails', async () => {
    await failQueueInsert()
    const i = instance((options) => {
      options.organizationHooks.afterCreateInvitation = async ({ invitation }) => {
        await recordAndEnqueue(invitation.id as string)
      }
    })
    const actor = await owner(i)
    expect((await invite(i, actor)).status).toBe(500)
    const rows = await invitations()
    expect(rows).toEqual([{ id: expect.any(String), status: 'pending' }])
    expect(await ledger()).toEqual([])
    expect(await queued()).toEqual([])
    expect(await gaps()).toEqual([{ id: rows[0]?.id }])
    const retried = await invite(i, actor)
    expect(retried.status).toBe(400)
    expect(await retried.json()).toMatchObject({
      code: 'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION',
    })
    await testDb.pool.query('DROP TRIGGER invitation_probe_queue_failure ON pgboss.job')
    const id = rows[0]?.id as string
    // Two competing repair attempts converge through the ledger primary key.
    expect((await Promise.all([recordAndEnqueue(id), recordAndEnqueue(id)])).sort()).toEqual([
      false,
      true,
    ])
    expect(await gaps()).toEqual([])
    const jobs = await queued()
    expect(jobs).toEqual([
      {
        id: expect.any(String),
        data: { invitationId: id, generation: 1 },
        singleton_key: `invitation:${id}:1`,
      },
    ])
    expect(await ledger()).toEqual([{ invitation_id: id, generation: 1, job_id: jobs[0]?.id }])
  })

  it('rolls back both ledger and successful enqueue if the delivery transaction is interrupted', async () => {
    const i = instance((options) => {
      options.organizationHooks.afterCreateInvitation = async ({ invitation }) => {
        await recordAndEnqueue(invitation.id as string, true)
      }
    })
    expect((await invite(i, await owner(i))).status).toBe(500)
    expect(successfulEnqueues).toHaveLength(1)
    expect(await invitations()).toEqual([{ id: expect.any(String), status: 'pending' }])
    expect(await ledger()).toEqual([])
    expect(await queued()).toEqual([])
    expect(await gaps()).toHaveLength(1)
  })

  it('keeps a committed delivery after response failure and does not enqueue it again on repair', async () => {
    const i = instance((options) => {
      options.organizationHooks.afterCreateInvitation = async ({ invitation }) => {
        await recordAndEnqueue(invitation.id as string)
        throw new Error('synthetic lost response after delivery commit')
      }
    })
    const actor = await owner(i)
    expect((await invite(i, actor)).status).toBe(500)
    const rows = await invitations()
    expect(rows).toEqual([{ id: expect.any(String), status: 'pending' }])
    const before = await queued()
    expect(before).toHaveLength(1)
    expect(await ledger()).toHaveLength(1)
    expect((await invite(i, actor)).status).toBe(400)
    await expect(recordAndEnqueue(rows[0]?.id as string)).resolves.toBe(false)
    expect(await queued()).toEqual(before)
    expect(await gaps()).toEqual([])
  })

  it('observes the committed invitation before delivery starts and can identify the crash gap', async () => {
    const reached = Promise.withResolvers<void>()
    const interrupted = Promise.withResolvers<void>()
    const i = instance((options) => {
      options.organizationHooks.afterCreateInvitation = async () => {
        reached.resolve()
        await interrupted.promise
        throw new Error('synthetic interruption at post-insert barrier')
      }
    })
    const request = Promise.resolve(invite(i, await owner(i)))
    try {
      await expect(
        Promise.race([
          reached.promise.then(() => 'hook reached'),
          request.then(() => 'request completed before hook'),
        ]),
      ).resolves.toBe('hook reached')
      // An independent connection sees the durable gap while the request is still in its
      // hook. Throwing below models the crash cut point; this does not kill an OS process.
      const rows = await invitations()
      expect(rows).toEqual([{ id: expect.any(String), status: 'pending' }])
      expect(await ledger()).toEqual([])
      expect(await queued()).toEqual([])
      expect(await gaps()).toEqual([{ id: rows[0]?.id }])
    } finally {
      interrupted.resolve()
      expect((await request).status).toBe(500)
    }
  })

  it('bypasses both create hooks on resend and reports success even when its enqueue callback rejects', async () => {
    const calls: string[] = []
    const i = instance((options) => {
      const original = options.organizationHooks.beforeCreateInvitation
      options.organizationHooks.beforeCreateInvitation = async (input) => {
        await original?.(input)
        calls.push('before')
      }
      options.organizationHooks.afterCreateInvitation = async () => void calls.push('after')
      options.sendInvitationEmail = async ({ invitation }) => {
        calls.push('enqueue')
        await recordAndEnqueue(invitation.id as string)
      }
    })
    const actor = await owner(i)
    const first = await invite(i, actor)
    expect(first.status).toBe(200)
    const created = (await first.json()) as { id: string; expiresAt: string }
    expect(calls).toEqual(['before', 'enqueue', 'after'])
    await testDb.pool.query('DELETE FROM invitation_delivery_probe')
    await testDb.pool.query('DELETE FROM pgboss.job WHERE name = $1', [queueName])
    await testDb.pool.query(
      `UPDATE auth.invitation SET "expiresAt" = now() + interval '1 hour' WHERE id = $1`,
      [created.id],
    )
    await failQueueInsert()
    const resent = await invite(i, actor, true)
    expect(resent.status).toBe(200)
    const response = (await resent.json()) as { id: string; expiresAt: string }
    expect(response.id).toBe(created.id)
    expect(Date.parse(response.expiresAt) - Date.now()).toBeGreaterThan(47 * 3_600_000)
    expect(calls).toEqual(['before', 'enqueue', 'after', 'enqueue'])
    expect(await invitations()).toEqual([{ id: created.id, status: 'pending' }])
    expect(await ledger()).toEqual([])
    expect(await queued()).toEqual([])
    expect(await gaps()).toEqual([{ id: created.id }])
  })
})
