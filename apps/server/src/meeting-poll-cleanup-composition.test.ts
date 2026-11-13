import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { meetingPollCleanupJob } from '@hourmere/jobs/meeting-polls'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startServer } from './server.ts'

const databaseUrl = process.env.DATABASE_URL
const queueName = 'meeting-poll-cleanup-v1'

/** Run a changed composition root while leaving production files intact. */
async function sourceCopy() {
  const location = new URL('./server.ts', import.meta.url)
  const original = readFileSync(location, 'utf8')
  const registration = '      meetingPollCleanupJob({\n'
  expect(
    original.split(registration).length - 1,
    'mutation matches the registered cleanup job once',
  ).toBe(1)
  const source = stripTypeScriptTypes(
    original.replace(registration, '      ...((_: unknown) => [])({\n'),
  ).replace(
    /(from |import )'([^']+)'/g,
    (_, prefix: string, specifier: string) =>
      `${prefix}'${specifier.startsWith('.') ? new URL(specifier, location).href : specifier.startsWith('node:') ? specifier : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
  )
  return (await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  )) as typeof import('./server.ts')
}

describe.skipIf(!databaseUrl)('meeting poll cleanup in server composition', () => {
  let owned: TestDatabase
  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'poll_clean_app' })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function withServer(
    role: 'web' | 'worker' | 'all',
    factory: typeof startServer,
    verify: () => Promise<void>,
  ) {
    const spies = (['log', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    try {
      const server = await factory({
        DATABASE_URL: owned.url,
        HOURMERE_ROLE: role,
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        SIGNUP: 'closed',
      })
      try {
        await verify()
      } finally {
        await server.close()
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  }

  const schedule = async () =>
    (
      await owned.pool.query<{ name: string; cron: string; data: unknown }>(
        'SELECT name,cron,data FROM pgboss.schedule WHERE name=$1',
        [queueName],
      )
    ).rows

  it('only installs the hourly schedule in worker roles and keeps it idempotent', async () => {
    await withServer('web', startServer, async () => {
      expect(await schedule()).toEqual([])
      expect(
        (await owned.pool.query('SELECT name FROM pgboss.queue WHERE name=$1', [queueName])).rows,
      ).toHaveLength(1)
    })
    for (const role of ['worker', 'all', 'worker'] as const) {
      await withServer(role, startServer, async () => {
        expect(
          await schedule(),
          'running worker roles install the hourly cleanup schedule',
        ).toEqual([{ name: queueName, cron: '0 * * * *', data: {} }])
      })
    }
  }, 60_000)

  async function verifyRegistered(factory: typeof startServer) {
    // Remove only this test's queue metadata so a prior production registration cannot
    // conceal the mutation. No cleanup jobs are running between server instances.
    await owned.pool.query('DELETE FROM pgboss.schedule WHERE name=$1', [queueName])
    await withServer('worker', factory, async () => {
      expect(await schedule(), 'running worker roles install the hourly cleanup schedule').toEqual([
        { name: queueName, cron: '0 * * * *', data: {} },
      ])
    })
  }

  it('detects source-copy removal of production worker registration', async () => {
    const copy = await sourceCopy()
    await expect(verifyRegistered(copy.startServer)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('worker roles install the hourly cleanup schedule'),
    })
  }, 30_000)

  it('runs a queued cleanup in the production worker role', async () => {
    // Enqueues only: the handler that runs is the production worker's registration.
    const producer = createJobs({
      connectionString: owned.url,
      definitions: [meetingPollCleanupJob({ cleanup: async () => ({ more: false }) })],
      migrate: true,
      work: false,
      maxConnections: 1,
      log: () => {},
    })
    try {
      await producer.start()
      await withServer('worker', startServer, async () => {
        const id = await producer.enqueue(queueName, {})
        const deadline = Date.now() + 8000
        let state: string | undefined
        do {
          const result = await owned.pool.query<{ state: string }>(
            'SELECT state FROM pgboss.job WHERE id=$1',
            [id],
          )
          state = result.rows[0]?.state
          if (state === 'completed') break
          await new Promise((resolve) => setTimeout(resolve, 50))
        } while (Date.now() < deadline)
        expect(state, 'the registered cleanup handler completes jobs in the real worker').toBe(
          'completed',
        )
      })
    } finally {
      await producer.stop()
    }
  }, 15000)
})
