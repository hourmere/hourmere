import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { createFixtures } from '@hourmere/scheduling/testing'
import { type CompiledQuery, PostgresQueryCompiler, type QueryId, sql } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WEBHOOK_DELIVERY_JOB, webhookCleanupJob, webhookDeliveryJob } from './delivery.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const RECENT = new Date(NOW.epochMilliseconds)
const OLD = new Date(NOW.subtract({ hours: 24 * 31 }).epochMilliseconds)
const isReconciliation = (query: CompiledQuery) => /UPDATE\s+webhook_deliveries/i.test(query.sql)
const isRetention = (query: CompiledQuery) => /DELETE\s+FROM\s+webhook_deliveries/i.test(query.sql)

describe.skipIf(!serverUrl)('bounded webhook delivery reconciliation', () => {
  let testDb: TestDatabase
  let db: Db
  let organizationId: string
  let webhookId: string
  let jobs: ReturnType<typeof createJobs>

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
    organizationId = await createFixtures(db).organization()
    webhookId = (
      await db
        .insertInto('webhooks')
        .values({
          organization_id: organizationId,
          url: 'https://hooks.example.com/reconciliation',
          events: ['booking.created'],
          secret_ciphertext: Buffer.from('unused synthetic ciphertext'),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    jobs = createJobs({
      connectionString: testDb.url,
      definitions: [
        webhookDeliveryJob({ db, enabled: false }),
        { ...webhookDeliveryJob({ db, enabled: false }), name: 'another-queue' },
      ],
      work: false,
      migrate: true,
      maxConnections: 2,
    })
    await jobs.start()
  })

  beforeEach(async () => {
    await db.deleteFrom('webhook_deliveries').execute()
    await testDb.pool.query('DELETE FROM pgboss.job')
  })

  afterEach(() => vi.restoreAllMocks())

  afterAll(async () => {
    await jobs?.stop()
    await testDb?.drop()
  })

  async function deliveries(count = 1, createdAt = RECENT) {
    const bookings = await db
      .insertInto('bookings')
      .values(
        Array.from({ length: count }, () => ({
          organization_id: organizationId,
          start_at: '2026-11-03T09:00Z',
          end_at: '2026-11-03T09:30Z',
          title: 'Synthetic reconciliation booking',
          source: 'api',
        })),
      )
      .returning('id')
      .execute()
    return db
      .insertInto('webhook_deliveries')
      .values(
        bookings.map((booking) => ({
          webhook_id: webhookId,
          organization_id: organizationId,
          booking_id: booking.id,
          event_id: randomUUID(),
          event_type: 'booking.created',
          payload: '{}',
          created_at: createdAt,
        })),
      )
      .returning('id')
      .execute()
  }

  async function history(
    deliveryId: string,
    state: string,
    retryCount = 0,
    started = true,
    name = WEBHOOK_DELIVERY_JOB,
  ) {
    await testDb.pool.query(
      `INSERT INTO pgboss.job(name, singleton_key, state, retry_count, started_on, start_after)
       VALUES ($1, $2, $3::pgboss.job_state, $4,
         CASE WHEN $5 THEN now() ELSE NULL END, now() + interval '1 hour')`,
      [name, deliveryId, state, retryCount, started],
    )
  }

  const run = (connection = db, signal = new AbortController().signal) =>
    webhookCleanupJob(connection, () => NOW).handler({}, { id: randomUUID(), attempt: 1, signal })

  function observe(
    onResult?: (query: CompiledQuery, affected: bigint | undefined) => Promise<void> | void,
    beforeQuery?: (query: CompiledQuery) => void,
  ) {
    const queries: CompiledQuery[] = []
    const mutations: { query: CompiledQuery; affected: bigint | undefined }[] = []
    const compiled = new WeakMap<QueryId, CompiledQuery>()
    const connection = db.withPlugin({
      transformQuery({ node, queryId }) {
        const query = new PostgresQueryCompiler().compileQuery(node, queryId)
        queries.push(query)
        compiled.set(queryId, query)
        beforeQuery?.(query)
        return node
      },
      async transformResult({ queryId, result }) {
        const query = compiled.get(queryId)
        if (query) {
          if (isReconciliation(query) || isRetention(query))
            mutations.push({ query, affected: result.numAffectedRows })
          await onResult?.(query, result.numAffectedRows)
        }
        return result
      },
    })
    return { connection, queries, mutations }
  }

  async function rows() {
    return db.selectFrom('webhook_deliveries').selectAll().orderBy('id').execute()
  }

  it('reconciles only pending orphans and preserves every live job state and queue boundary', async () => {
    const cases = []
    for (const state of [
      'missing',
      'failed',
      'cancelled',
      'completed',
      'created',
      'retry',
      'active',
    ]) {
      const [delivery] = await deliveries()
      if (!delivery) throw new Error('missing fixture')
      if (state !== 'missing') await history(delivery.id, state, 4, state !== 'cancelled')
      cases.push({ id: delivery.id, state })
    }
    const [otherQueue, mixed, maxHistory, clamped, stored] = await deliveries(5)
    if (!otherQueue || !mixed || !maxHistory || !clamped || !stored)
      throw new Error('missing fixtures')
    await history(otherQueue.id, 'active', 12, true, 'another-queue')
    await history(mixed.id, 'failed', 12)
    await history(mixed.id, 'retry', 1)
    await history(maxHistory.id, 'failed', 6)
    await history(maxHistory.id, 'cancelled', 12, false)
    await history(maxHistory.id, 'completed', 2)
    await history(maxHistory.id, 'failed', 12, true, 'another-queue')
    await history(clamped.id, 'failed', 20)
    await db
      .updateTable('webhook_deliveries')
      .set({ attempts: 9 })
      .where('id', '=', stored.id)
      .execute()
    await history(stored.id, 'completed', 1)
    const preserved = []
    for (const status of ['delivered', 'failed', 'skipped']) {
      const [delivery] = await deliveries()
      if (!delivery) throw new Error('missing fixture')
      await db
        .updateTable('webhook_deliveries')
        .set({ status, attempts: 3, last_error: status === 'delivered' ? null : 'http_error' })
        .where('id', '=', delivery.id)
        .execute()
      preserved.push((await rows()).find((row) => row.id === delivery.id))
    }
    await run()
    await run()
    const result = await rows()
    for (const item of cases) {
      expect(result.find((row) => row.id === item.id)).toMatchObject(
        ['created', 'retry', 'active'].includes(item.state)
          ? { status: 'pending', attempts: 0, last_error: null }
          : {
              status: 'failed',
              attempts: ['missing', 'cancelled'].includes(item.state) ? 0 : 5,
              last_error: 'job_missing',
            },
      )
    }
    expect(result.find((row) => row.id === otherQueue.id)).toMatchObject({
      status: 'failed',
      attempts: 0,
      last_error: 'job_missing',
    })
    expect(result.find((row) => row.id === mixed.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      last_error: null,
    })
    for (const [delivery, attempts] of [
      [maxHistory, 7],
      [clamped, 13],
      [stored, 9],
    ] as const)
      expect(result.find((row) => row.id === delivery.id)).toMatchObject({
        status: 'failed',
        attempts,
        last_error: 'job_missing',
      })
    for (const original of preserved)
      expect(result.find((row) => row.id === original?.id)).toEqual(original)
  })

  it('bounds each dispatch to 1000 orphans and continues the backlog on the next dispatch', async () => {
    await deliveries(1001)
    const observed = observe()
    await run(observed.connection)
    expect((await rows()).filter((row) => row.status === 'failed')).toHaveLength(1000)
    expect((await rows()).filter((row) => row.status === 'pending')).toHaveLength(1)
    expect(observed.mutations.map((entry) => entry.affected)).toEqual([1000n, 0n])
    // Settings and work are constant per batch, independent of delivery count.
    expect(observed.queries).toHaveLength(4)
    expect(observed.queries.filter((query) => /set_config/.test(query.sql))).toHaveLength(2)
    for (const query of observed.queries.filter((query) => /set_config/.test(query.sql)))
      expect(query.parameters).toEqual(['5000ms', '1000ms'])
    await run(observed.connection)
    expect((await rows()).filter((row) => row.status === 'pending')).toHaveLength(0)
    expect(observed.mutations.map((entry) => entry.affected)).toEqual([1000n, 0n, 1n, 0n])
  })

  it('bounds retention separately and preserves the inclusive thirty-day boundary', async () => {
    await deliveries(1001, OLD)
    await db.updateTable('webhook_deliveries').set({ status: 'delivered' }).execute()
    const [boundary] = await deliveries(
      1,
      new Date(NOW.subtract({ hours: 24 * 30 }).epochMilliseconds),
    )
    if (!boundary) throw new Error('missing fixture')
    await history(boundary.id, 'active')
    const observed = observe()
    await run(observed.connection)
    expect(await rows()).toHaveLength(2)
    expect(observed.mutations.map((entry) => entry.affected)).toEqual([0n, 1000n])
    await run(observed.connection)
    expect((await rows()).map((row) => row.id)).toEqual([boundary.id])
    expect(observed.mutations.map((entry) => entry.affected)).toEqual([0n, 1000n, 0n, 1n])
  })

  it('lets concurrent workers claim disjoint batches without waiting or reconciling a row twice', async () => {
    await deliveries(1001)
    const claimed = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const first = observe(async (query) => {
      if (isReconciliation(query)) {
        claimed.resolve()
        await release.promise
      }
    })
    const second = observe()
    const running = run(first.connection)
    await claimed.promise
    let secondFinished = false
    const concurrent = run(second.connection).then(() => {
      secondFinished = true
    })
    try {
      await expect.poll(() => secondFinished, { timeout: 3000 }).toBe(true)
      expect(
        second.mutations
          .filter((entry) => isReconciliation(entry.query))
          .map((entry) => entry.affected),
      ).toEqual([1n])
    } finally {
      release.resolve()
      await Promise.all([running, concurrent])
    }
    expect(
      first.mutations
        .filter((entry) => isReconciliation(entry.query))
        .map((entry) => entry.affected),
    ).toEqual([1000n])
    expect((await rows()).filter((row) => row.status === 'failed')).toHaveLength(1001)
    await run(second.connection)
    expect(
      second.mutations
        .filter((entry) => isReconciliation(entry.query))
        .map((entry) => entry.affected),
    ).toEqual([1n, 0n])
  })

  it('skips locked reconciliation and retention rows while processing unlocked rows', async () => {
    const [locked, free] = await deliveries(2)
    const [oldLocked, oldFree] = await deliveries(2, OLD)
    if (!locked || !free || !oldLocked || !oldFree) throw new Error('missing fixtures')
    await db
      .updateTable('webhook_deliveries')
      .set({ status: 'delivered' })
      .where('id', 'in', [oldLocked.id, oldFree.id])
      .execute()
    const holder = await testDb.pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM webhook_deliveries WHERE id=ANY($1::uuid[]) FOR UPDATE', [
        [locked.id, oldLocked.id],
      ])
      await run()
      const result = await rows()
      expect(result.find((row) => row.id === locked.id)?.status).toBe('pending')
      expect(result.find((row) => row.id === free.id)?.status).toBe('failed')
      expect(result.some((row) => row.id === oldLocked.id)).toBe(true)
      expect(result.some((row) => row.id === oldFree.id)).toBe(false)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
    await run()
    expect((await rows()).find((row) => row.id === locked.id)?.status).toBe('failed')
    expect((await rows()).some((row) => row.id === oldLocked.id)).toBe(false)
  })

  it('does not start any database batch after its shutdown signal is already aborted', async () => {
    await deliveries()
    const abort = new AbortController()
    abort.abort()
    const observed = observe()
    const transaction = vi.spyOn(observed.connection, 'transaction')
    await run(observed.connection, abort.signal)
    expect(transaction).not.toHaveBeenCalled()
    expect(observed.queries).toHaveLength(0)
    expect((await rows())[0]?.status).toBe('pending')
  })

  it.each(['shutdown', 'budget'] as const)(
    'defers retention when %s arrives after reconciliation',
    async (reason) => {
      await deliveries(1, OLD)
      const abort = new AbortController()
      let elapsed = 0
      vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
      const observed = observe((query) => {
        if (isReconciliation(query)) {
          if (reason === 'shutdown') abort.abort()
          else elapsed = 10_001
        }
      })
      const transaction = vi.spyOn(observed.connection, 'transaction')
      await run(observed.connection, abort.signal)
      expect(transaction).toHaveBeenCalledTimes(1)
      expect(observed.mutations.map((entry) => entry.affected)).toEqual([1n])
      expect((await rows())[0]?.status).toBe('failed')
      vi.restoreAllMocks()
      await run()
      expect(await rows()).toEqual([])
    },
  )

  it.each(['shutdown', 'budget'] as const)(
    'rechecks %s after setting transaction timeouts',
    async (reason) => {
      await deliveries()
      const abort = new AbortController()
      let elapsed = 0
      vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
      const observed = observe((query) => {
        if (/set_config/.test(query.sql)) {
          if (reason === 'shutdown') abort.abort()
          else elapsed = 10_001
        }
      })
      await run(observed.connection, abort.signal)
      expect(observed.mutations).toHaveLength(0)
      expect((await rows())[0]?.status).toBe('pending')
    },
  )

  it.each(['shutdown', 'budget'] as const)(
    'rechecks %s after waiting to acquire the transaction connection',
    async (reason) => {
      await deliveries()
      const abort = new AbortController()
      let elapsed = 0
      vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
      const observed = observe()
      const transaction = observed.connection.transaction.bind(observed.connection)
      vi.spyOn(observed.connection, 'transaction').mockImplementation(() => {
        const builder = transaction()
        const execute = builder.execute.bind(builder)
        builder.execute = (callback) =>
          execute((trx) => {
            if (reason === 'shutdown') abort.abort()
            else elapsed = 10_000
            return callback(trx)
          })
        return builder
      })
      await run(observed.connection, abort.signal)
      expect(observed.queries).toHaveLength(0)
      expect((await rows())[0]?.status).toBe('pending')
    },
  )

  it('shrinks SQL timeouts to the remaining lease budget', async () => {
    await deliveries()
    const ticks = [0, 9500]
    vi.spyOn(performance, 'now').mockImplementation(() => ticks.shift() ?? 9500)
    const observed = observe()
    await run(observed.connection)
    for (const query of observed.queries.filter((query) => /set_config/.test(query.sql)))
      expect(query.parameters).toEqual(['500ms', '500ms'])
    expect(observed.mutations.map((entry) => entry.affected)).toEqual([1n, 0n])
  })

  it.each(['57014', '55P03', '23514'])(
    'defers only recognized timeout SQLSTATE %s',
    async (code) => {
      await deliveries()
      const failure = Object.assign(new Error('synthetic SQL failure'), { code })
      const observed = observe(undefined, (query) => {
        if (isReconciliation(query)) throw failure
      })
      if (code === '23514') await expect(run(observed.connection)).rejects.toBe(failure)
      else await expect(run(observed.connection)).resolves.toBeUndefined()
      expect((await rows())[0]?.status).toBe('pending')
      await run()
      expect((await rows())[0]?.status).toBe('failed')
    },
  )

  it.each(['57014', '55P03'])(
    'rolls back a partially applied batch on SQLSTATE %s and restores transaction-local timeouts',
    async (code) => {
      await deliveries(3)
      await testDb.pool.query(`
        CREATE SEQUENCE webhook_reconciliation_test_sequence;
        CREATE FUNCTION webhook_reconciliation_test_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF current_setting('statement_timeout')::interval <= interval '0 seconds'
              OR current_setting('statement_timeout')::interval > interval '5 seconds'
              OR current_setting('lock_timeout')::interval <= interval '0 seconds'
              OR current_setting('lock_timeout')::interval > interval '1 second' THEN
            RAISE EXCEPTION 'batch SQL timeouts were not applied';
          END IF;
          IF nextval('webhook_reconciliation_test_sequence') = 2 THEN
            RAISE EXCEPTION 'synthetic database cancellation' USING ERRCODE = '${code}';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER webhook_reconciliation_test_cancel BEFORE UPDATE ON webhook_deliveries
          FOR EACH ROW EXECUTE FUNCTION webhook_reconciliation_test_cancel();
      `)
      try {
        await db.connection().execute(async (connection) => {
          const timeouts = () =>
            sql<{ statement: string; lock: string }>`
            SELECT current_setting('statement_timeout') AS statement,
              current_setting('lock_timeout') AS lock
          `.execute(connection)
          const initial = (await timeouts()).rows
          await expect(run(connection)).resolves.toBeUndefined()
          expect((await timeouts()).rows).toEqual(initial)
        })
        expect(
          (await testDb.pool.query('SELECT last_value FROM webhook_reconciliation_test_sequence'))
            .rows[0]?.last_value,
        ).toBe('2')
        expect(
          (await rows()).every((row) => row.status === 'pending' && row.last_error === null),
        ).toBe(true)
      } finally {
        await testDb.pool.query(`
          DROP TRIGGER webhook_reconciliation_test_cancel ON webhook_deliveries;
          DROP FUNCTION webhook_reconciliation_test_cancel();
          DROP SEQUENCE webhook_reconciliation_test_sequence;
        `)
      }
      await run()
      expect((await rows()).every((row) => row.status === 'failed')).toBe(true)
    },
  )

  it('scans retained pg-boss history once per batch rather than once per orphan', async () => {
    const orphaned = await deliveries(1000)
    await testDb.pool.query(
      `INSERT INTO pgboss.job(name, singleton_key, state, retry_count, started_on)
       SELECT $1, d.id::text, 'failed'::pgboss.job_state, 3, now() FROM webhook_deliveries d
       UNION ALL
       SELECT $1, gen_random_uuid()::text, 'completed'::pgboss.job_state, 1, now() FROM generate_series(1, 5000)`,
      [WEBHOOK_DELIVERY_JOB],
    )
    await testDb.pool.query('ANALYZE pgboss.job')
    await testDb.pool.query('ANALYZE webhook_deliveries')
    const observed = observe()
    await run(observed.connection)
    const query = observed.queries.find(isReconciliation)
    if (!query) throw new Error('reconciliation did not issue a query')
    await db
      .updateTable('webhook_deliveries')
      .set({ status: 'pending', attempts: 0, last_error: null })
      .execute()
    const client = await testDb.pool.connect()
    let plan: Record<string, unknown> = {}
    try {
      await client.query('BEGIN')
      const explained = await client.query(`EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) ${query.sql}`, [
        ...query.parameters,
      ])
      plan = explained.rows[0]['QUERY PLAN'][0].Plan
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    function nodes(node: Record<string, unknown>): Record<string, unknown>[] {
      return [node, ...((node.Plans ?? []) as Record<string, unknown>[]).flatMap(nodes)]
    }
    const all = nodes(plan)
    const historyScans = all.filter(
      (node) => node.Schema === 'pgboss' && /Scan/.test(String(node['Node Type'])),
    )
    expect(historyScans.length).toBeGreaterThan(0)
    expect(
      historyScans
        .filter((node) => /Seq Scan/.test(String(node['Node Type'])))
        .every((node) => Number(node['Actual Loops']) <= 2),
    ).toBe(true)
    expect(
      all.filter(
        (node) => /^SubPlan/.test(String(node['Subplan Name'])) && Number(node['Actual Loops']) > 2,
      ),
    ).toEqual([])
    expect(observed.mutations.map((entry) => entry.affected)).toEqual([1000n, 0n])
    expect((await rows()).every((row) => row.status === 'pending')).toBe(true)
    expect(orphaned).toHaveLength(1000)
  })
})
