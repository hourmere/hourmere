import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createTestDatabase } from '@hourmere/db/testing'
import { INVITATION_EMAIL_JOB, INVITATION_EMAIL_REPAIR_JOB } from '@hourmere/notifications'
import { describe, expect, it, vi } from 'vitest'
import { type RunningServer, startServer } from './server.ts'

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
      const delivery = await owned.pool.query<{ state: string; attempts: number }>(
        'SELECT state, attempts FROM invitation_deliveries WHERE invitation_id = $1',
        [invitation.id],
      )
      expect(delivery.rows).toEqual([{ state: 'queued', attempts: 0 }])
    } finally {
      try {
        await running?.close()
      } finally {
        await owned.drop()
        for (const spy of spies) spy.mockRestore()
      }
    }
  }, 30_000)
})
