import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs, defineJob, type Jobs } from '@hourmere/jobs'
import {
  createInvitationEmailDispatcher,
  createInvitationEmailRepairer,
  invitationEmailJob,
  invitationEmailRepairJob,
  reserveInvitationEmailBudget,
} from '@hourmere/notifications'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createApp } from './app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4387'
const secret = randomBytes(32).toString('base64')
const queueName = 'invitation-email-v1'
type Payload = { invitationId: string; generation: number }
type Enqueue = (payload: Payload) => Promise<void>
const pollingProbe = defineJob({
  name: 'invitation-http-polling-probe',
  payload: z.strictObject({}),
  async handler() {},
})
type InvitationJobs = Jobs<readonly [ReturnType<typeof invitationEmailJob>, typeof pollingProbe]>

interface Actor {
  userId: string
  sessionId: string
  organizationId: string
  cookie: string
}

interface Invitation {
  id: string
  email: string
  delivery: { generation: number; state: string; attempts: number }
}

function moduleUrl(source: string, location: URL, replacements: Record<string, string> = {}) {
  const javascript = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) => {
      let resolved = replacements[specifier]
      if (!resolved) {
        if (specifier.startsWith('.')) resolved = new URL(specifier, location).href
        else {
          try {
            resolved = import.meta.resolve(specifier)
          } catch {
            resolved = pathToFileURL(createRequire(location).resolve(specifier)).href
          }
        }
      }
      return `from '${resolved}'`
    },
  )
  return `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
}

// Source copies leave production files and other Vitest workers untouched.
async function authSourceCopy(enqueueBeforeCommit: boolean): Promise<typeof createAuth> {
  const serviceLocation = new URL('../../../packages/auth/src/invitations.ts', import.meta.url)
  let source = readFileSync(serviceLocation, 'utf8')
  const seam =
    '      return result(invitation, delivery, existing && !replacingExpired)\n    })\n  // Admission is already committed:'
  expect(source.includes(seam), 'mutation matches the admission commit boundary').toBe(true)
  if (enqueueBeforeCommit) {
    const postCommitStart = source.indexOf('  // Admission is already committed:')
    const postCommitEnd = source.indexOf('\n  return admitted\n}', postCommitStart)
    expect(postCommitStart, 'mutation finds the post-commit enqueue block').toBeGreaterThan(0)
    expect(postCommitEnd, 'mutation finds the post-commit return').toBeGreaterThan(postCommitStart)
    source = source.replace(
      seam,
      `      const early = result(invitation, delivery, existing && !replacingExpired)
      if (options.enqueue && early.delivery.state === 'queued') {
        await options.enqueue({ invitationId: invitation.id, generation: delivery.generation })
      }
      return early
    })
  // Admission is already committed:`,
    )
    const movedStart = source.indexOf('  // Admission is already committed:')
    const movedEnd = source.indexOf('\n  return admitted\n}', movedStart)
    source = source.slice(0, movedStart) + source.slice(movedEnd)
  }
  const serviceUrl = moduleUrl(source, serviceLocation)
  const hookLocation = new URL('../../../packages/auth/src/hooks.ts', import.meta.url)
  const hookUrl = moduleUrl(readFileSync(hookLocation, 'utf8'), hookLocation, {
    './invitations.ts': serviceUrl,
  })
  const authLocation = new URL('../../../packages/auth/src/index.ts', import.meta.url)
  const copy = await import(
    moduleUrl(readFileSync(authLocation, 'utf8'), authLocation, { './hooks.ts': hookUrl })
  )
  return copy.createAuth
}

describe.skipIf(!serverUrl)(
  'team invitation HTTP delivery queue with real PostgreSQL and pg-boss',
  () => {
    let owned: TestDatabase
    let db: Db
    let authPool: pg.Pool
    let jobs: InvitationJobs
    let dispatch: Enqueue
    let repair: ReturnType<typeof invitationEmailRepairJob>

    beforeAll(async () => {
      owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_queue' })
      db = createDb(owned.pool)
      authPool = createAuthPool(owned.url, { mode: 'open', allowedDomains: [] })
      jobs = createJobs({
        connectionString: owned.url,
        definitions: [invitationEmailJob(), pollingProbe] as const,
        work: true,
        pollingIntervalSeconds: 0.5,
        migrate: true,
        maxConnections: 2,
        log: () => {},
      })
      await jobs.start()
      dispatch = createInvitationEmailDispatcher({ db, queue: jobs })
      repair = invitationEmailRepairJob(createInvitationEmailRepairer({ db, queue: jobs }))
      await owned.pool.query(`
      CREATE FUNCTION fail_invitation_queue_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = 'invitation-email-v1' THEN
          RAISE EXCEPTION 'synthetic invitation queue outage' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $$
    `)
    })

    beforeEach(async () => {
      await owned.pool.query('DROP TRIGGER IF EXISTS invitation_queue_failure ON pgboss.job')
      await owned.pool.query('DELETE FROM pgboss.job WHERE name = $1', [queueName])
      await owned.pool.query('DELETE FROM auth.organization')
      await owned.pool.query('DELETE FROM auth."user"')
      await owned.pool.query('DELETE FROM invitation_email_requests')
      await owned.pool.query('DELETE FROM notification_email_sends')
    })

    afterAll(async () => {
      try {
        await jobs?.stop()
      } finally {
        try {
          await authPool?.end()
        } finally {
          await owned?.drop()
        }
      }
    })

    function instance(enqueue: Enqueue | undefined = dispatch, factory = createAuth) {
      const auth = factory({
        pool: authPool,
        db,
        baseURL: origin,
        secret,
        signup: { mode: 'closed', allowedDomains: [] },
        mailer: { send: async () => {} },
        reserveInvitationEmail: (trx, input, now) =>
          reserveInvitationEmailBudget(trx, input, { secret }, now),
        enqueueInvitationEmail: enqueue,
      })
      return createApp({
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        checkDb: async () => {},
        publicUrl: origin,
      })
    }

    async function actor(organizationId?: string): Promise<Actor> {
      const user = await db
        .insertInto('auth.user')
        .values({
          name: 'Synthetic queue administrator',
          email: `${randomUUID()}@outside.example`,
          emailVerified: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const orgId =
        organizationId ??
        (
          await db
            .insertInto('auth.organization')
            .values({ name: 'Synthetic queue team', slug: randomUUID(), createdAt: new Date() })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id
      await db
        .insertInto('auth.member')
        .values({ userId: user.id, organizationId: orgId, role: 'admin', createdAt: new Date() })
        .execute()
      const token = randomBytes(24).toString('base64url')
      const session = await db
        .insertInto('auth.session')
        .values({
          userId: user.id,
          token,
          expiresAt: new Date(Date.now() + 3_600_000),
          updatedAt: new Date(),
          activeOrganizationId: orgId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const signature = createHmac('sha256', secret).update(token).digest('base64')
      return {
        userId: user.id,
        sessionId: session.id,
        organizationId: orgId,
        cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
      }
    }

    function invite(app: ReturnType<typeof instance>, admin: Actor, body: Record<string, unknown>) {
      return app.request('/api/auth/organization/invite-member', {
        method: 'POST',
        headers: {
          origin,
          cookie: admin.cookie,
          'content-type': 'application/json',
          'x-expected-organization-id': admin.organizationId,
        },
        body: JSON.stringify({ organizationId: admin.organizationId, role: 'member', ...body }),
      })
    }

    async function create(app: ReturnType<typeof instance>, admin: Actor, email?: string) {
      const response = await invite(app, admin, {
        email: email ?? `${randomUUID()}@outside.example`,
      })
      expect(response.status).toBe(200)
      return (await response.json()) as Invitation
    }

    const queued = async () =>
      (
        await owned.pool.query<{
          id: string
          data: Payload
          singleton_key: string
          retry_limit: number
          state: string
        }>(
          "SELECT id, data, singleton_key, retry_limit, state FROM pgboss.job WHERE name = $1 ORDER BY data->>'generation'",
          [queueName],
        )
      ).rows

    async function current(invitationId: string) {
      return db
        .selectFrom('invitation_deliveries')
        .selectAll()
        .where('invitation_id', '=', invitationId)
        .executeTakeFirstOrThrow()
    }

    async function cool(invitationId: string) {
      await db
        .updateTable('invitation_deliveries')
        .set({
          generation_started_at: new Date(Date.now() - 61_000),
          updated_at: new Date(Date.now() - 61_000),
        })
        .where('invitation_id', '=', invitationId)
        .execute()
    }

    const runRepair = () =>
      repair.handler({}, { id: randomUUID(), attempt: 1, signal: new AbortController().signal })

    async function pollWorkers() {
      const probeId = await jobs.enqueue(pollingProbe.name, {})
      await expect
        .poll(async () => {
          const result = await owned.pool.query<{ state: string }>(
            'SELECT state FROM pgboss.job WHERE id=$1',
            [probeId],
          )
          return result.rows[0]?.state
        })
        .toBe('completed')
      await new Promise((resolve) => setTimeout(resolve, 550))
    }

    async function expectJobs(invitationId: string, generations: number[]) {
      expect(await queued()).toEqual(
        generations.map((generation) => ({
          id: expect.any(String),
          data: { invitationId, generation },
          singleton_key: `invitation-email:v1:${invitationId}:${generation}`,
          retry_limit: 0,
          state: 'created',
        })),
      )
    }

    it('creates exactly one durable ID-only job with the exclusive generation key and no retries', async () => {
      const app = instance()
      const admin = await actor()
      const invitation = await create(app, admin)
      await expectJobs(invitation.id, [1])
      for (let pass = 0; pass < 3; pass += 1) {
        await pollWorkers()
        await runRepair()
        await expectJobs(invitation.id, [1])
      }
      const queue = await owned.pool.query<{ policy: string; retry_limit: number }>(
        'SELECT policy, retry_limit FROM pgboss.queue WHERE name = $1',
        [queueName],
      )
      expect(queue.rows).toEqual([{ policy: 'exclusive', retry_limit: 0 }])
      expect(await current(invitation.id)).toMatchObject({
        generation: 1,
        state: 'queued',
        attempts: 0,
        last_job_id: (await queued())[0]?.id,
      })
      const retry = await invite(app, admin, { email: invitation.email })
      expect(retry.status).toBe(200)
      await expectJobs(invitation.id, [1])
      expect(await db.selectFrom('notification_email_sends').selectAll().execute()).toEqual([])
    }, 15_000)

    it('queues one job for explicit resend and replays the same request without another generation', async () => {
      const app = instance()
      const admin = await actor()
      const invitation = await create(app, admin)
      await cool(invitation.id)
      const body = {
        email: invitation.email,
        invitationId: invitation.id,
        resend: true,
        expectedGeneration: 1,
        requestId: randomUUID(),
      }
      const response = await invite(app, admin, body)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        id: invitation.id,
        delivery: { generation: 2 },
      })
      expect((await invite(app, admin, body)).status).toBe(200)
      await expectJobs(invitation.id, [1, 2])
      const before = await queued()
      for (let pass = 0; pass < 3; pass += 1) {
        await pollWorkers()
        await runRepair()
        expect(await queued()).toEqual(before)
      }
      expect((await current(invitation.id)).last_job_id).toBe((await queued())[1]?.id)
    }, 15_000)

    it('waits for durable enqueue before answering while the committed invitation is visible', async () => {
      const reached = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const app = instance(async (payload) => {
        expect(await current(payload.invitationId)).toMatchObject({
          generation: payload.generation,
          state: 'queued',
        })
        reached.resolve()
        await release.promise
        await dispatch(payload)
      })
      let completed = false
      const request = Promise.resolve(
        invite(app, await actor(), { email: `${randomUUID()}@outside.example` }),
      ).then((response) => {
        completed = true
        return response
      })
      try {
        await expect(
          Promise.race([reached.promise.then(() => 'dispatch'), request.then(() => 'response')]),
        ).resolves.toBe('dispatch')
        expect(completed).toBe(false)
        expect(await queued()).toEqual([])
      } finally {
        release.resolve()
        expect((await request).status).toBe(200)
      }
      expect(await queued()).toHaveLength(1)
    })

    it.each(['canceled', 'accepted'] as const)(
      'refuses queue success if a committed invitation becomes %s before dispatch',
      async (status) => {
        const reached = Promise.withResolvers<Payload>()
        const release = Promise.withResolvers<void>()
        const app = instance(async (payload) => {
          reached.resolve(payload)
          await release.promise
          await dispatch(payload)
        })
        const first = await actor()
        const second = await actor(first.organizationId)
        const request = Promise.resolve(
          invite(app, first, { email: `${randomUUID()}@outside.example` }),
        )
        let response: Response
        let payload: Payload
        try {
          payload = await Promise.race([
            reached.promise,
            request.then(() => {
              throw new Error('admission responded before the post-commit dispatch barrier')
            }),
          ])
          expect(await current(payload.invitationId)).toMatchObject({
            state: 'queued',
            generation: 1,
          })
          if (status === 'canceled') {
            const canceled = await app.request('/api/auth/organization/cancel-invitation', {
              method: 'POST',
              headers: {
                origin,
                cookie: second.cookie,
                'content-type': 'application/json',
                'x-expected-organization-id': second.organizationId,
              },
              body: JSON.stringify({ invitationId: payload.invitationId }),
            })
            expect(canceled.status).toBe(200)
          } else {
            await db
              .updateTable('auth.invitation')
              .set({ status: 'accepted' })
              .where('id', '=', payload.invitationId)
              .execute()
          }
        } finally {
          release.resolve()
          response = await request
        }
        expect(response.status, 'a retired generation cannot report durable queue success').toBe(
          409,
        )
        expect(await response.json()).toMatchObject({
          code: 'INVITATION_INELIGIBLE',
          message: 'This invitation is no longer pending. Create a new invitation if needed.',
        })
        expect(await current(payload.invitationId)).toMatchObject({
          generation: 1,
          state: 'skipped',
          last_error_code: 'invitation_ineligible',
          last_job_id: null,
        })
        expect(await queued()).toEqual([])
      },
    )

    it('refuses stale post-commit queue success when a concurrent explicit resend wins', async () => {
      const reached = Promise.withResolvers<Payload>()
      const release = Promise.withResolvers<void>()
      const app = instance(async (payload) => {
        if (payload.generation === 1) {
          reached.resolve(payload)
          await release.promise
        }
        await dispatch(payload)
      })
      const first = await actor()
      const second = await actor(first.organizationId)
      const email = `${randomUUID()}@outside.example`
      const request = Promise.resolve(invite(app, first, { email }))
      let response: Response
      let payload: Payload
      try {
        payload = await Promise.race([
          reached.promise,
          request.then(() => {
            throw new Error('admission responded before the post-commit dispatch barrier')
          }),
        ])
        await cool(payload.invitationId)
        const resent = await invite(app, second, {
          email,
          invitationId: payload.invitationId,
          resend: true,
          expectedGeneration: 1,
          requestId: randomUUID(),
        })
        expect(resent.status).toBe(200)
        expect(await resent.json()).toMatchObject({ delivery: { generation: 2 } })
        await expectJobs(payload.invitationId, [2])
      } finally {
        release.resolve()
        response = await request
      }
      expect(response.status, 'a superseded generation cannot report durable queue success').toBe(
        503,
      )
      expect(await response.json()).toMatchObject({ code: 'INVITATION_DELIVERY_UNAVAILABLE' })
      expect(await current(payload.invitationId)).toMatchObject({
        generation: 2,
        state: 'queued',
        attempts: 0,
      })
      await expectJobs(payload.invitationId, [2])
    })

    it.each(
      (['create', 'resend'] as const).flatMap((kind) =>
        (['insert throws', 'exclusive returns null'] as const).map((failure) => ({
          kind,
          failure,
        })),
      ),
    )(
      'preserves committed $kind queued intent when $failure and repairs twice to one job',
      async ({ kind, failure }) => {
        const admin = await actor()
        const invitation = kind === 'resend' ? await create(instance(), admin) : undefined
        if (invitation) await cool(invitation.id)
        const previousJobs = await queued()
        const body = invitation
          ? {
              email: invitation.email,
              invitationId: invitation.id,
              resend: true,
              expectedGeneration: 1,
              requestId: randomUUID(),
            }
          : { email: `${randomUUID()}@outside.example` }
        let enqueue = dispatch
        if (failure === 'insert throws') {
          await owned.pool.query(`
          CREATE TRIGGER invitation_queue_failure BEFORE INSERT ON pgboss.job
          FOR EACH ROW EXECUTE FUNCTION fail_invitation_queue_insert()
        `)
        } else {
          enqueue = createInvitationEmailDispatcher({
            db,
            queue: { ...jobs, enqueue: async () => null },
          })
        }
        const app = instance(enqueue)
        const response = await invite(app, admin, body)
        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({
          code: 'INVITATION_DELIVERY_UNAVAILABLE',
          message: 'The invitation was saved, but delivery could not be queued. Try again later.',
        })
        const invitations = await db
          .selectFrom('auth.invitation')
          .select(['id', 'status'])
          .execute()
        expect(invitations).toEqual([{ id: expect.any(String), status: 'pending' }])
        const id = invitations[0]?.id as string
        const generation = kind === 'resend' ? 2 : 1
        const delivery = await current(id)
        expect(delivery).toMatchObject({
          generation,
          state: 'queued',
          attempts: 0,
          last_job_id: null,
        })
        expect(delivery.due_at.getTime()).toBeLessThanOrEqual(Date.now())
        expect(await queued()).toEqual(previousJobs)
        await owned.pool.query('DROP TRIGGER IF EXISTS invitation_queue_failure ON pgboss.job')
        await runRepair()
        await runRepair()
        await expectJobs(id, generation === 2 ? [1, 2] : [1])
        expect((await current(id)).attempts).toBe(0)
        expect((await invite(app, admin, body)).status).toBe(200)
        expect((await current(id)).generation).toBe(generation)
        await expectJobs(id, generation === 2 ? [1, 2] : [1])
      },
    )

    it('does not enqueue a second job while the current generation has a live job', async () => {
      const invitation = await create(instance(), await actor())
      const before = await queued()
      await runRepair()
      await runRepair()
      expect(await queued()).toEqual(before)
      expect((await current(invitation.id)).last_job_id).toBe(before[0]?.id)
    })

    async function blockedBy(blockers: number[], minimum: number) {
      let pids: number[] = []
      await vi.waitFor(
        async () => {
          const result = await owned.pool.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND pg_blocking_pids(pid) && $1::int[]`,
            [blockers],
          )
          pids = result.rows.map((row) => row.pid)
          expect(
            pids.length,
            'requests reached their PostgreSQL serialization barriers',
          ).toBeGreaterThanOrEqual(minimum)
        },
        { timeout: 3000, interval: 10 },
      )
      return pids
    }

    async function race(first: () => Promise<Response>, second: () => Promise<Response>) {
      const holder = await owned.pool.connect()
      const requests: Promise<Response>[] = []
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT pg_advisory_xact_lock(1852798057, 1835100524)')
        const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]?.pid as number
        requests.push(first())
        const [firstPid] = await blockedBy([holderPid], 1)
        requests.push(second())
        await blockedBy([holderPid, firstPid as number], 2)
        await holder.query('COMMIT')
        return await Promise.all(requests)
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
        await Promise.allSettled(requests)
      }
    }

    it.each(['create', 'resend'] as const)(
      'queues only one job for a generation during concurrent %s from distinct sessions',
      async (kind) => {
        const app = instance()
        const first = await actor()
        const second = await actor(first.organizationId)
        expect(first.userId).not.toBe(second.userId)
        expect(first.sessionId).not.toBe(second.sessionId)
        const email = `${randomUUID()}@outside.example`
        const invitation = kind === 'resend' ? await create(app, first, email) : undefined
        if (invitation) await cool(invitation.id)
        const body = () =>
          invitation
            ? {
                email,
                invitationId: invitation.id,
                resend: true,
                expectedGeneration: 1,
                requestId: randomUUID(),
              }
            : { email }
        const responses = await race(
          () => Promise.resolve(invite(app, first, body())),
          () => Promise.resolve(invite(app, second, body())),
        )
        expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
        const invitations = await db.selectFrom('auth.invitation').select('id').execute()
        expect(invitations).toHaveLength(1)
        await expectJobs(invitations[0]?.id as string, kind === 'resend' ? [1, 2] : [1])
      },
    )

    it.each(['canceled', 'accepted', 'rejected', 'expired'] as const)(
      're-reads an invitation changed to %s after enqueue and skips the current generation',
      async (status) => {
        const invitation = await create(instance(), await actor())
        await db
          .updateTable('auth.invitation')
          .set(status === 'expired' ? { expiresAt: new Date(Date.now() - 1000) } : { status })
          .where('id', '=', invitation.id)
          .execute()
        const before = await queued()
        await pollWorkers()
        await runRepair()
        await runRepair()
        expect(await queued()).toEqual(before)
        expect(await current(invitation.id)).toMatchObject({
          generation: 1,
          state: 'skipped',
          attempts: 0,
          last_error_code: 'invitation_ineligible',
        })
      },
    )

    it('leaves a current pending generation unchanged for the future sender', async () => {
      const invitation = await create(instance(), await actor())
      const before = await current(invitation.id)
      await pollWorkers()
      await runRepair()
      expect(await current(invitation.id)).toEqual(before)
      expect(await db.selectFrom('notification_email_sends').selectAll().execute()).toEqual([])
    })

    it('retains the old job while repair leaves its queued successor unchanged', async () => {
      const app = instance()
      const admin = await actor()
      const invitation = await create(app, admin)
      const oldJob = (await queued())[0]
      await cool(invitation.id)
      const response = await invite(app, admin, {
        email: invitation.email,
        invitationId: invitation.id,
        resend: true,
        expectedGeneration: 1,
        requestId: randomUUID(),
      })
      expect(response.status).toBe(200)
      const before = await current(invitation.id)
      await pollWorkers()
      await runRepair()
      await runRepair()
      await expectJobs(invitation.id, [1, 2])
      expect((await queued())[0]).toEqual(oldJob)
      expect(await current(invitation.id)).toEqual(before)
      expect(before).toMatchObject({ generation: 2, state: 'queued', attempts: 0 })
    })

    it('keeps standalone createAuth fixtures working without a queue dependency', async () => {
      // Remove this optional integration just as independent package/schema fixtures do.
      const auth = createAuth({
        pool: authPool,
        db,
        baseURL: origin,
        secret,
        signup: { mode: 'closed', allowedDomains: [] },
        mailer: { send: async () => {} },
      })
      const standalone = createApp({
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        checkDb: async () => {},
        publicUrl: origin,
      })
      const invitation = await create(standalone, await actor())
      expect(await current(invitation.id)).toMatchObject({ generation: 1, state: 'queued' })
      expect(await queued()).toEqual([])
    })

    async function verifyCommittedBeforeEnqueue(factory: typeof createAuth) {
      const visible: boolean[] = []
      const app = instance(async (payload) => {
        // This independent connection cannot observe the admission transaction's writes
        // before COMMIT. A fake enqueue avoids acquiring locks against that transaction.
        const result = await owned.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM auth.invitation i
         JOIN invitation_deliveries d ON d.invitation_id=i.id
         WHERE i.id=$1 AND d.generation=$2 AND d.state='queued'`,
          [payload.invitationId, payload.generation],
        )
        visible.push(result.rows[0]?.n === 1)
      }, factory)
      await create(app, await actor())
      expect(
        visible,
        'enqueue sees committed invitation and current delivery on an independent connection',
      ).toEqual([true])
    }

    it('runs the unchanged source copy through the post-commit visibility assertion', async () => {
      await verifyCommittedBeforeEnqueue(await authSourceCopy(false))
    })

    it('detects enqueue moved before admission commit with a real visibility assertion', async () => {
      const factory = await authSourceCopy(true)
      await expect(verifyCommittedBeforeEnqueue(factory)).rejects.toMatchObject({
        name: 'AssertionError',
        message: expect.stringContaining('enqueue sees committed invitation and current delivery'),
      })
    })
  },
)
