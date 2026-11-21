// Routing retention in server composition (docs/routing-forms.md, step a4): worker roles
// install the 15-minute schedule, and a queued run purges expired answers and unreferenced
// versions through the production handlers while consumed evidence stays.
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs, routingRetentionJob } from '@hourmere/jobs'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { productApp } from './routes/test-app.ts'
import { parseRoutingFormsEnabled, resolveRoutingFormsEnabled } from './routing-form-setting.ts'
import { productRoutes, startServer } from './server.ts'

const databaseUrl = process.env.DATABASE_URL
const queueName = 'routing-retention-v1'
const REGISTRATION = `      // Routing receipt and version cleanup runs whether or not routing is enabled.
      routingRetentionJob({
        purgeReceipts: async () => ({
          more: (await purgeExpiredRoutingReceipts(db)) === ROUTING_RECEIPT_PURGE_BATCH,
        }),
        cleanupVersions: (after) => deleteUnreferencedRoutingVersions(db, { after }),
        continueRetention: (payload): Promise<string | null> =>
          jobs.enqueue('routing-retention-v1', payload, { singletonKey: 'continuation' }),
      }),
`

/** Run a changed composition root while leaving production files intact. */
async function sourceCopy() {
  const location = new URL('./server.ts', import.meta.url)
  const original = readFileSync(location, 'utf8')
  expect(
    original.split(REGISTRATION),
    'mutation matches the registered retention job',
  ).toHaveLength(2)
  const source = stripTypeScriptTypes(original.replace(REGISTRATION, '')).replace(
    /(from |import )'([^']+)'/g,
    (_, prefix: string, specifier: string) =>
      `${prefix}'${specifier.startsWith('.') ? new URL(specifier, location).href : specifier.startsWith('node:') ? specifier : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
  )
  return (await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  )) as typeof import('./server.ts')
}

describe.skipIf(!databaseUrl)('routing retention in server composition', () => {
  let owned: TestDatabase
  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'routing_ret_app' })
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

  it('installs the 15-minute schedule in worker roles only', async () => {
    await withServer('web', startServer, async () => {
      expect(await schedule()).toEqual([])
      expect(
        (await owned.pool.query('SELECT name FROM pgboss.queue WHERE name=$1', [queueName])).rows,
      ).toHaveLength(1)
    })
    for (const role of ['worker', 'all'] as const) {
      await withServer(role, startServer, async () => {
        expect(
          await schedule(),
          'running worker roles install the routing retention schedule',
        ).toEqual([{ name: queueName, cron: '*/15 * * * *', data: {} }])
      })
    }
  })

  it('detects source-copy removal of the production registration', async () => {
    const copy = await sourceCopy()
    // Remove only this test's queue metadata so the earlier registration cannot conceal it.
    await owned.pool.query('DELETE FROM pgboss.schedule WHERE name=$1', [queueName])
    await expect(
      withServer('worker', copy.startServer, async () => {
        expect(
          await schedule(),
          'running worker roles install the routing retention schedule',
        ).toEqual([{ name: queueName, cron: '*/15 * * * *', data: {} }])
      }),
    ).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('install the routing retention schedule'),
    })
  })

  it('keeps target invalidation and retention running after routing is turned off', async () => {
    const db = createDb(owned.pool)
    const host = await createTestUser(db)
    const org = host.principal.organization.id
    const key = await db
      .insertInto('auth.apikey')
      .values({
        configId: 'default',
        referenceId: host.id,
        key: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: JSON.stringify({ scope: 'full', organizationId: org }),
        enabled: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const token = 'synthetic-routing-retention-key'
    const principals = new Map([
      [
        token,
        {
          ...host.principal,
          kind: 'api_key' as const,
          apiKeyId: key.id,
          apiKeyScope: 'full' as const,
        },
      ],
    ])
    async function app(setting: 'true' | 'false') {
      const routingFormsEnabled = await resolveRoutingFormsEnabled({
        db,
        routingFormsEnabled: parseRoutingFormsEnabled(setting),
      })
      return productApp(
        db,
        principals,
        productRoutes({
          db,
          socialProviders: {},
          invitationMailLimits: { secret: 'synthetic-routing-retention-test' },
          routingFormsEnabled,
        }),
      )
    }
    const on = await app('true')
    async function request(server: typeof on, method: string, path: string, body?: object) {
      const response = await server.request(`/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
      return { status: response.status, body: await response.json() }
    }
    const eventTypeId = await createFixtures(db).eventType(org, host.id)
    const created = await request(on, 'POST', '/routing-forms', {
      slug: 'qualify',
      title: 'Qualification',
      fallback: { kind: 'event', eventTypeId, mappings: [] },
    })
    expect(created.status).toBe(201)
    const { id: form, draftRevision } = created.body as { id: string; draftRevision: number }
    const formPath = `/routing-forms/${form}`
    async function publish(expectedRevision: number) {
      const publication = await request(on, 'POST', `${formPath}/publish`, { expectedRevision })
      expect(publication.status).toBe(201)
      return (publication.body as { version: { id: string } }).version.id
    }
    const old = await publish(draftRevision)
    const consumedVersion = await publish(draftRevision + 1)
    const current = await publish(draftRevision + 2)
    expect(
      await request(on, 'PATCH', formPath, { expectedRevision: draftRevision + 3, enabled: true }),
    ).toMatchObject({
      status: 200,
      body: { enabled: true, health: { status: 'ok' } },
    })

    const insert = async (sql: string, params: unknown[]) =>
      (await owned.pool.query<{ id: string }>(sql, params)).rows[0]?.id as string
    const booking = await insert(
      `INSERT INTO bookings (organization_id, start_at, end_at, title, source, status)
       VALUES ($1, '2030-01-01T09:00Z', '2030-01-01T09:30Z', 'Routed', 'web', 'confirmed')
       RETURNING id`,
      [org],
    )
    const receipt = (versionId: string, consumed: string | null) =>
      insert(
        `INSERT INTO routing_receipts (organization_id, form_id, version_id, token_hash,
           answers_ciphertext, matched_rule_id, resolved_rule_id, resolved_target, created_at,
           expires_at, consumed_booking_id)
         VALUES ($1, $2, $3, md5(random()::text) || md5(random()::text), $4, 'fallback',
           'fallback', '{}', now() - interval '2 hours', now() - interval '90 minutes', $5)
         RETURNING id`,
        [org, form, versionId, consumed ? null : Buffer.from('answers'), consumed],
      )
    const expired = await receipt(current, null)
    const evidence = await receipt(consumedVersion, booking)

    const off = await app('false')
    expect(await request(off, 'GET', formPath)).toEqual({
      status: 404,
      body: { error: 'routing_forms_disabled' },
    })
    expect(
      await request(off, 'PATCH', `/event-types/${eventTypeId}`, { isActive: false }),
    ).toMatchObject({
      status: 200,
      body: { isActive: false },
    })
    const dependencies = await db
      .selectFrom('routing_target_dependencies')
      .select(['rule_id', 'health_code'])
      .where('version_id', '=', current)
      .execute()
    expect(dependencies).toEqual([{ rule_id: 'fallback', health_code: 'unavailable' }])

    const producer = createJobs({
      connectionString: owned.url,
      definitions: [
        routingRetentionJob({
          purgeReceipts: async () => ({ more: false }),
          cleanupVersions: async () => ({ next: null }),
        }),
      ],
      migrate: true,
      work: false,
      maxConnections: 1,
      log: () => {},
    })
    try {
      await producer.start()
      await withServer(
        'worker',
        (env) => startServer({ ...env, ROUTING_FORMS_ENABLED: 'false' }),
        async () => {
          // Its own key, so that a scheduled run queued at this moment cannot absorb it.
          const id = await producer.enqueue(queueName, {}, { singletonKey: 'composition-test' })
          expect(id).not.toBeNull()
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
          expect(state, 'the registered retention handler completes jobs in the worker').toBe(
            'completed',
          )
        },
      )
    } finally {
      await producer.stop()
    }
    const ids = async (table: string) =>
      (await owned.pool.query<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`)).rows.map(
        (row) => row.id,
      )
    const receipts = await ids('routing_receipts')
    expect(receipts, 'expired answers are purged, consumed evidence stays').toEqual([evidence])
    expect(receipts).not.toContain(expired)
    const versions = await ids('routing_form_versions')
    expect(versions).toEqual([consumedVersion, current].sort())
    expect(versions).not.toContain(old)
  }, 20_000)
})
