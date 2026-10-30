import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createTestDatabase } from '@hourmere/db/testing'
import { createJobs, type Jobs } from '@hourmere/jobs'
import { createSmtpMailer } from '@hourmere/mail'
import {
  createInvitationEmailRepairer,
  INVITATION_EMAIL_JOB,
  INVITATION_EMAIL_REPAIR_JOB,
  invitationEmailRepairJob,
} from '@hourmere/notifications'
import { describe, expect, it, vi } from 'vitest'
import { type RunningServer, startServer } from './server.ts'

vi.mock('@hourmere/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hourmere/notifications')>()
  return {
    ...actual,
    createInvitationEmailRepairer: vi.fn(actual.createInvitationEmailRepairer),
  }
})

vi.mock('@hourmere/mail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hourmere/mail')>()
  return { ...actual, createSmtpMailer: vi.fn(() => ({ send: vi.fn(async () => {}) })) }
})

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('invitation queue production composition', () => {
  it('wires HTTP dispatch in web mode and repairs on worker startup with a minute schedule', async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, {
      tag: 'invite_compose',
    })
    const secret = randomBytes(32).toString('base64')
    const publicUrl = 'http://localhost'
    const spies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    let running: RunningServer | undefined
    try {
      const userId = randomUUID()
      const organizationId = randomUUID()
      const token = randomBytes(24).toString('base64url')
      await owned.pool.query(
        `INSERT INTO auth."user" (id, name, email, "emailVerified")
         VALUES ($1, 'Queue composition owner', 'owner@example.test', true)`,
        [userId],
      )
      await owned.pool.query(
        `INSERT INTO auth.organization (id, name, slug, "createdAt")
         VALUES ($1, 'Queue composition team', $2, now())`,
        [organizationId, organizationId],
      )
      await owned.pool.query(
        `INSERT INTO auth.member ("organizationId", "userId", role, "createdAt")
         VALUES ($1, $2, 'owner', now())`,
        [organizationId, userId],
      )
      await owned.pool.query(
        `INSERT INTO auth.session ("expiresAt", token, "updatedAt", "userId", "activeOrganizationId")
         VALUES (now() + interval '1 hour', $1, now(), $2, $3)`,
        [token, userId, organizationId],
      )
      const signature = createHmac('sha256', secret).update(token).digest('base64')
      const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
      const config = {
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: secret,
        SIGNUP: 'closed',
        PORT: '0',
        PUBLIC_URL: publicUrl,
        SMTP_URL: 'smtp://synthetic.invalid',
        MAIL_FROM: 'sender@example.test',
      }
      running = await startServer({ ...config, HOURMERE_ROLE: 'web' })
      const response = await fetch(
        `http://127.0.0.1:${running.port}/api/auth/organization/invite-member`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: publicUrl,
            cookie,
            'x-expected-organization-id': organizationId,
          },
          body: JSON.stringify({ organizationId, email: 'invitee@example.test' }),
        },
      )
      expect(response.status).toBe(200)
      const invitation = (await response.json()) as { id: string }
      const queued = await owned.pool.query<{ data: unknown; singleton_key: string }>(
        'SELECT data, singleton_key FROM pgboss.job WHERE name = $1',
        [INVITATION_EMAIL_JOB],
      )
      expect(queued.rows).toEqual([
        {
          data: { invitationId: invitation.id, generation: 1 },
          singleton_key: `invitation-email:v1:${invitation.id}:1`,
        },
      ])
      await running.close()
      running = undefined

      // Simulate an independently lost queue row. Startup must repair without waiting
      // for a cron tick or another invitation request.
      await owned.pool.query('DELETE FROM pgboss.job WHERE name = $1', [INVITATION_EMAIL_JOB])
      running = await startServer({ ...config, HOURMERE_ROLE: 'worker' })
      const repaired = await owned.pool.query<{ data: unknown }>(
        'SELECT data FROM pgboss.job WHERE name = $1',
        [INVITATION_EMAIL_JOB],
      )
      expect(repaired.rows).toEqual([{ data: { invitationId: invitation.id, generation: 1 } }])
      const schedule = await owned.pool.query<{ cron: string; data: unknown }>(
        'SELECT cron, data FROM pgboss.schedule WHERE name = $1',
        [INVITATION_EMAIL_REPAIR_JOB],
      )
      expect(schedule.rows).toEqual([{ cron: '* * * * *', data: {} }])
      await expect
        .poll(
          async () =>
            (
              await owned.pool.query(
                'SELECT state FROM invitation_deliveries WHERE invitation_id = $1',
                [invitation.id],
              )
            ).rows[0]?.state,
          { timeout: 10_000 },
        )
        .toBe('smtp_accepted')
      const delivery = await owned.pool.query<{ state: string; attempts: number }>(
        'SELECT state, attempts FROM invitation_deliveries WHERE invitation_id = $1',
        [invitation.id],
      )
      expect(delivery.rows).toEqual([{ state: 'smtp_accepted', attempts: 1 }])
      expect(vi.mocked(createSmtpMailer).mock.results.at(-1)?.value.send).toHaveBeenCalledOnce()
    } finally {
      try {
        await running?.close()
      } finally {
        await owned.drop()
        for (const spy of spies) spy.mockRestore()
      }
    }
  }, 30_000)

  it('logs a failed startup repair, serves health and lets the scheduled worker retry', async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, {
      tag: 'invite_retry',
    })
    const spies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    const factory = vi.mocked(createInvitationEmailRepairer)
    const realFactory = factory.getMockImplementation()
    if (!realFactory) throw new Error('Expected the real repair factory')
    const retry = vi.fn<() => Promise<void>>()
    factory.mockImplementationOnce((deps) => {
      const repair = realFactory(deps)
      retry.mockImplementation(repair).mockRejectedValueOnce(new Error('private database details'))
      return retry
    })
    let running: RunningServer | undefined
    let producer: Jobs<readonly [ReturnType<typeof invitationEmailRepairJob>]> | undefined
    try {
      const userId = randomUUID()
      const organizationId = randomUUID()
      const invitationId = randomUUID()
      await owned.pool.query(
        `INSERT INTO auth."user" (id, name, email, "emailVerified")
         VALUES ($1, 'Retry owner', 'owner@example.test', true)`,
        [userId],
      )
      await owned.pool.query(
        `INSERT INTO auth.organization (id, name, slug, "createdAt")
         VALUES ($1, 'Retry team', $2, now())`,
        [organizationId, organizationId],
      )
      await owned.pool.query(
        `INSERT INTO auth.invitation (id, "organizationId", "inviterId", email, role, status, "expiresAt")
         VALUES ($1, $2, $3, 'invitee@example.test', 'member', 'pending', now() + interval '1 day')`,
        [invitationId, organizationId, userId],
      )
      await owned.pool.query(
        `INSERT INTO invitation_deliveries (invitation_id, state) VALUES ($1, 'queued')`,
        [invitationId],
      )
      const startup = startServer({
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        HOURMERE_ROLE: 'worker',
        SIGNUP: 'closed',
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
      })
      await expect(startup, 'a repair failure must not stop worker startup').resolves.toBeDefined()
      running = await startup
      expect((await fetch(`http://127.0.0.1:${running.port}/api/health`)).status).toBe(200)
      expect(retry).toHaveBeenCalledOnce()
      expect(spies[3]).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\S+ ERROR invitation-email-repair-v1: startup_repair_unavailable; scheduled repair will retry$/,
        ),
      )
      expect(spies[3]?.mock.calls.flat().join(' ')).not.toContain('private database details')
      expect(
        (
          await owned.pool.query('SELECT cron FROM pgboss.schedule WHERE name = $1', [
            INVITATION_EMAIL_REPAIR_JOB,
          ])
        ).rows,
      ).toEqual([{ cron: '* * * * *' }])
      // Dispatch the scheduled job immediately through a producer. The production
      // worker must still be polling after the failed startup attempt.
      producer = createJobs({
        connectionString: owned.url,
        definitions: [invitationEmailRepairJob(async () => {})],
        work: false,
        migrate: false,
        maxConnections: 1,
        log: () => {},
      })
      await producer.start()
      const repairJobId = await producer.enqueue(INVITATION_EMAIL_REPAIR_JOB, {})
      expect(repairJobId).not.toBeNull()
      await expect
        .poll(
          async () =>
            (await owned.pool.query('SELECT state FROM pgboss.job WHERE id = $1', [repairJobId]))
              .rows[0]?.state,
          { timeout: 10_000, interval: 50 },
        )
        .toBe('completed')
      expect(retry.mock.calls.length).toBeGreaterThanOrEqual(2)
      await expect
        .poll(
          async () =>
            (
              await owned.pool.query('SELECT state FROM pgboss.job WHERE name = $1', [
                INVITATION_EMAIL_JOB,
              ])
            ).rows[0]?.state,
          { timeout: 10_000 },
        )
        .toBe('completed')
      expect(
        (
          await owned.pool.query('SELECT data, state FROM pgboss.job WHERE name = $1', [
            INVITATION_EMAIL_JOB,
          ])
        ).rows,
      ).toEqual([{ data: { invitationId, generation: 1 }, state: 'completed' }])
    } finally {
      try {
        await producer?.stop()
        await running?.close()
      } finally {
        await owned.drop()
        for (const spy of spies) spy.mockRestore()
      }
    }
  }, 30_000)
})
