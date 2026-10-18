// CLI -> real HTTP -> MCP -> real API keys -> disposable PostgreSQL. No provider or mail delivery.
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { describe, expect, it } from 'vitest'
import { runCli } from '../../../../tools/cli/src/cli.ts'
import { createApp } from '../app.ts'
import { bookingTools } from './bookings.ts'
import { catalogTools } from './catalog.ts'
import { mcpEndpoint } from './endpoint.ts'
import { whoamiTool } from './whoami.ts'

const bootstrap = process.env.DATABASE_URL

describe.skipIf(!bootstrap)('CLI through HTTP and PostgreSQL', () => {
  it('discovers, books, replays, lists, moves and cancels with API-key ownership and audit attribution', async () => {
    const owned = await createTestDatabase(bootstrap as string)
    const db = createDb(owned.pool)
    const signup = { mode: 'closed', allowedDomains: [] } as const
    const authPool = createAuthPool(owned.url, signup)
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-cli-integration-'))
    let server: ReturnType<typeof serve> | undefined
    try {
      const auth = createAuth({
        pool: authPool,
        db,
        baseURL: 'http://localhost:3000',
        secret: randomBytes(32).toString('base64'),
        mailer: {
          send: async () => {
            throw new Error('Mail delivery is forbidden in CLI tests')
          },
        },
        signup,
      })
      const fixtures = createFixtures(db)
      const host = await fixtures.host({ name: 'CLI Test Host', handle: 'cli-host' })
      await fixtures.schedule(host.userId)
      const event = await fixtures.eventType(host.organizationId, host.userId, {
        slug: 'intro',
        title: 'CLI Test Meeting',
        durationMinutes: 30,
      })
      const other = await fixtures.host({ name: 'CLI Other Host', handle: 'cli-other' })
      const key = await auth.api.createApiKey({
        body: { userId: host.userId, name: 'cli-integration' },
      })
      const otherKey = await auth.api.createApiKey({
        body: { userId: other.userId, name: 'cli-other' },
      })
      const app = createApp({
        publicUrl: 'http://localhost:3000',
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        mcp: mcpEndpoint({
          tools: [
            whoamiTool,
            ...catalogTools({ db }),
            ...bookingTools({ db, now: () => Temporal.Instant.from('2026-11-01T12:00:00Z') }),
          ],
        }),
      })
      server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
      if (!server.listening)
        await new Promise<void>((resolve) => server?.once('listening', resolve))
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      const secrets = [key.key, otherKey.key]
      async function run(
        command: string,
        input: Record<string, unknown> = {},
        options: { key?: string; output?: string } = {},
      ) {
        let stdout = ''
        let stderr = ''
        const code = await runCli({
          argv: [command, '--input', '-', ...(options.output ? ['--output', options.output] : [])],
          env: { HOURMERE_URL: url, HOURMERE_API_KEY: options.key ?? key.key },
          stdin: (async function* () {
            yield JSON.stringify(input)
          })(),
          stdout: (text) => {
            stdout += text
          },
          stderr: (text) => {
            stderr += text
          },
        })
        expect(secrets.some((secret) => (stdout + stderr).includes(secret))).toBe(false)
        return {
          code,
          data: stdout ? JSON.parse(stdout) : undefined,
          error: stderr ? JSON.parse(stderr) : undefined,
        }
      }
      const identity = await run('whoami')
      expect(identity.code).toBe(0)
      expect(identity.data.organization.id).toBe(host.organizationId)
      expect((await run('profile')).data.handle).toBe('cli-host')
      const catalog = await run('catalog', { limit: 1 })
      expect(catalog.data.data[0].id).toBe(event)
      expect((await run('event', { id: event })).code).toBe(0)
      const schedules = await run('schedules', { limit: 1 })
      expect(schedules.data.data).toHaveLength(1)
      expect((await run('schedule', { id: schedules.data.data[0].id })).code).toBe(0)
      const slots = await run('slots', {
        handle: 'cli-host',
        slug: 'intro',
        startDate: '2026-11-02',
        endDate: '2026-11-02',
        timeZone: 'Europe/Berlin',
        maxSlots: 2,
      })
      expect(slots.code).toBe(0)
      expect(slots.data.slots).toHaveLength(2)
      expect(typeof slots.data.nextAfter).toBe('string')
      const next = await run('slots', {
        handle: 'cli-host',
        slug: 'intro',
        startDate: '2026-11-02',
        endDate: '2026-11-02',
        timeZone: 'Europe/Berlin',
        maxSlots: 2,
        after: slots.data.nextAfter,
      })
      expect(next.data.slots[0].start > slots.data.slots[1].start).toBe(true)
      const request = {
        handle: 'cli-host',
        slug: 'intro',
        start: slots.data.slots[0].start,
        invitee: {
          name: 'CLI Test Invitee',
          email: 'cli-invitee@example.test',
          timeZone: 'Europe/Berlin',
        },
        idempotencyKey: randomUUID(),
      }
      const createdPath = join(directory, 'created.json')
      expect((await run('book', request, { output: createdPath })).code).toBe(0)
      const created = JSON.parse(await readFile(createdPath, 'utf8'))
      expect(typeof created.manageToken === 'string').toBe(true)
      secrets.push(created.manageToken)
      expect(created.booking.source).toBe('mcp')
      const replay = await run('book', request)
      expect(replay.code).toBe(0)
      expect(replay.data.booking.id).toBe(created.booking.id)
      expect(replay.data.replayed).toBe(true)
      expect(replay.data.manageToken).toBeNull()
      const wrongRetry = await run('book', { ...request, start: slots.data.slots[1].start })
      expect(wrongRetry.error.error).toBe('idempotency_key_reused')
      const listed = await run('list', { limit: 1, order: 'asc', status: 'confirmed' })
      expect(listed.data.data[0].id).toBe(created.booking.id)
      expect((await run('list', {}, { key: otherKey.key })).data.data).toHaveLength(0)
      expect(
        (await run('cancel', { bookingId: created.booking.id }, { key: otherKey.key })).error.error,
      ).toBe('booking_not_found')
      const movedPath = join(directory, 'moved.json')
      expect(
        (
          await run(
            'reschedule',
            { bookingId: created.booking.id, start: next.data.slots[0].start },
            { output: movedPath },
          )
        ).code,
      ).toBe(0)
      const moved = JSON.parse(await readFile(movedPath, 'utf8'))
      expect(moved.manageToken === null).toBe(true)
      expect(moved.booking.rescheduledFromId).toBe(created.booking.id)
      expect(moved.booking.source).toBe('mcp')
      expect(
        (
          await run('reschedule', {
            bookingId: created.booking.id,
            start: next.data.slots[0].start,
          })
        ).error.error,
      ).toBe('booking_cancelled')
      expect(
        (
          await run('cancel', {
            manageToken: created.manageToken,
            reason: 'CLI integration cleanup',
          })
        ).data.status,
      ).toBe('cancelled')
      const audit = await db
        .selectFrom('bookings')
        .select(['id', 'source', 'api_key_id', 'cancelled_source', 'cancelled_api_key_id'])
        .where('id', 'in', [created.booking.id, moved.booking.id])
        .execute()
      expect(audit).toHaveLength(2)
      expect(
        audit.every(
          (row) =>
            row.source === 'mcp' &&
            row.api_key_id === key.id &&
            row.cancelled_source === 'mcp' &&
            row.cancelled_api_key_id === key.id,
        ),
      ).toBe(true)
      expect((await run('whoami', {}, { key: 'hm_invalid_synthetic_key' })).error.status).toBe(401)
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server?.close((error) => (error ? reject(error) : resolve())),
        )
      await authPool.end()
      await owned.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
