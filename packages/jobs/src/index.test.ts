import { randomUUID } from 'node:crypto'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import pgBossPackage from 'pg-boss/package.json' with { type: 'json' }
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type AnyJobDefinition, createJobs, defineJob, JobPayloadError } from './index.ts'

const serverUrl = process.env.DATABASE_URL

/** A promise and the functions that settle it. */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

let seq = 0
const queueName = (label: string) => `test-${label}-${process.pid}-${++seq}`

describe.skipIf(!serverUrl)('createJobs', () => {
  let testDb: TestDatabase
  const started: { stop(): Promise<void> }[] = []

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
  })

  // Stopped after each test, so a shared Postgres never holds every instance's pool at once.
  afterEach(async () => {
    for (const jobs of started.splice(0)) await jobs.stop()
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  // Every test gets its own queues, so instances in one database do not see each other's jobs.
  async function start<const Defs extends readonly AnyJobDefinition[]>(
    definitions: Defs,
    options: { work?: boolean; shutdownTimeoutMs?: number; lines?: string[] } = {},
  ) {
    const jobs = createJobs({
      connectionString: testDb.url,
      definitions,
      work: options.work ?? true,
      migrate: true,
      pollingIntervalSeconds: 0.5,
      maxConnections: 2,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5000,
      log: (_level, line) => options.lines?.push(line),
    })
    started.push(jobs)
    await jobs.start()
    return jobs
  }

  const jobRows = async (name: string) =>
    (
      await testDb.pool.query<{ id: string; state: string; start_after: Date; output: unknown }>(
        'SELECT id, state, start_after, output FROM pgboss.job WHERE name = $1',
        [name],
      )
    ).rows

  it('installs pg-boss in its own schema, apart from our migrations', async () => {
    await start([])
    const schemas = await testDb.pool.query<{ nspname: string }>(
      "SELECT nspname FROM pg_namespace WHERE nspname = 'pgboss'",
    )
    expect(schemas.rows).toHaveLength(1)
    const migrations = await testDb.pool.query<{ name: string }>(
      'SELECT name FROM schema_migrations',
    )
    expect(migrations.rows.every((r) => /^\d{4}_[a-z0-9_]+\.sql$/.test(r.name))).toBe(true)
  })

  it('says what to run when migrate is off and pg-boss is not installed', async () => {
    const empty = await createTestDatabase(serverUrl as string)
    try {
      const jobs = createJobs({
        connectionString: empty.url,
        definitions: [],
        work: true,
        migrate: false,
        log: () => {},
      })
      await expect(jobs.start()).rejects.toThrow(
        /pg-boss is not installed .*migrate is off.*npm run db:migrate/,
      )
      expect(jobs.running).toBe(false)
    } finally {
      await empty.drop()
    }
  })

  it('installs a validated recurring schedule only on workers', async () => {
    const name = queueName('recurring')
    const definition = defineJob({
      name,
      payload: z.strictObject({ marker: z.literal('ok') }),
      schedule: { cron: '* * * * *', payload: { marker: 'ok' as const } },
      handler: async () => {},
    })
    const web = await start([definition], { work: false })
    expect(
      (await testDb.pool.query('SELECT 1 FROM pgboss.schedule WHERE name=$1', [name])).rowCount,
    ).toBe(0)
    await web.stop()
    const worker = await start([definition])
    const rows = await testDb.pool.query('SELECT cron,data FROM pgboss.schedule WHERE name=$1', [
      name,
    ])
    expect(rows.rows).toEqual([{ cron: '* * * * *', data: { marker: 'ok' } }])
    await worker.stop()
    await start([definition])
    expect(
      (await testDb.pool.query('SELECT 1 FROM pgboss.schedule WHERE name=$1', [name])).rowCount,
    ).toBe(1)
  })

  it('runs a job with its validated payload', async () => {
    const received = deferred<{ to: string; count: number }>()
    const name = queueName('echo')
    const echo = defineJob({
      name,
      payload: z.object({ to: z.email(), count: z.number().int().default(1) }),
      async handler(payload) {
        received.resolve(payload)
      },
    })
    const jobs = await start([echo])
    expect(await jobs.enqueue(name, { to: 'ada@example.com' })).toMatch(/^[0-9a-f-]{36}$/)
    expect(await received.promise).toEqual({ to: 'ada@example.com', count: 1 })
  })

  it('leaves a queue without a consumer created while other workers poll and complete jobs', async () => {
    const name = queueName('unconsumed')
    const sentinelName = queueName('polling-sentinel')
    let sentinelRuns = 0
    const jobs = await start([
      defineJob({ name, payload: z.strictObject({ generation: z.number().int() }) }),
      defineJob({
        name: sentinelName,
        payload: z.object({}),
        async handler() {
          sentinelRuns++
        },
      }),
    ])
    const id = await jobs.enqueue(name, { generation: 1 })
    for (let poll = 1; poll <= 3; poll++) {
      await jobs.enqueue(sentinelName, {})
      await until(() => sentinelRuns === poll, 'another polling sentinel to run')
      expect(await jobRows(name)).toEqual([expect.objectContaining({ id, state: 'created' })])
    }
  })

  it('refuses an invalid payload without echoing it', async () => {
    const name = queueName('strict')
    const strict = defineJob({
      name,
      payload: z.object({ bookingId: z.uuid() }),
      async handler() {},
    })
    const jobs = await start([strict], { work: false })
    const attempt = jobs.enqueue(name, { bookingId: 'secret-token-value' })
    await expect(attempt).rejects.toBeInstanceOf(JobPayloadError)
    await expect(attempt).rejects.toThrow(/bookingId/)
    await expect(attempt).rejects.not.toThrow(/secret-token-value/)
    expect(await jobRows(name)).toEqual([])
  })

  it('commits a job with the transaction it was enqueued in, and drops it on rollback', async () => {
    const name = queueName('tx')
    const ran: number[] = []
    const tx = defineJob({
      name,
      payload: z.object({ n: z.number() }),
      async handler({ n }) {
        ran.push(n)
      },
    })
    const jobs = await start([tx])
    const db = createDb(testDb.pool)

    await expect(
      db.transaction().execute(async (trx) => {
        await jobs.enqueue(name, { n: 1 }, { transaction: trx })
        throw new Error('booking failed')
      }),
    ).rejects.toThrow('booking failed')
    expect(await jobRows(name)).toEqual([])

    await db.transaction().execute(async (trx) => {
      await jobs.enqueue(name, { n: 2 }, { transaction: trx })
      // Not visible outside the transaction until it commits, so no worker can run it early.
      expect(await jobRows(name)).toEqual([])
    })
    await until(() => ran.length === 1, 'the committed transaction job to run exactly once')
    expect(ran).toEqual([2])
    await new Promise((r) => setTimeout(r, 1200))
    expect(ran).toEqual([2])
  }, 20_000)

  it('deduplicates by singletonKey under the exclusive policy', async () => {
    const name = queueName('dedup')
    const dedup = defineJob({
      name,
      payload: z.object({}),
      policy: 'exclusive',
      async handler() {},
    })
    const jobs = await start([dedup], { work: false })
    const first = await jobs.enqueue(name, {}, { singletonKey: 'booking-1' })
    expect(first).toBeTruthy()
    expect(await jobs.enqueue(name, {}, { singletonKey: 'booking-1' })).toBeNull()
    expect(await jobs.enqueue(name, {}, { singletonKey: 'booking-2' })).toBeTruthy()
    expect(await jobRows(name)).toHaveLength(2)
  })

  it('recognizes only the retained invitation job with exact queue, key, payload and live expiry', async () => {
    const payload = { invitationId: randomUUID(), generation: 3 }
    const key = `invitation-email:v1:${payload.invitationId}:3`
    const definition = defineJob({
      name: 'invitation-email-v1',
      payload: z.strictObject({ invitationId: z.uuid(), generation: z.number().int() }),
      policy: 'exclusive',
      handler: async () => {},
    })
    const other = defineJob({ ...definition, name: queueName('other-invitation') })
    const jobs = await start([definition, other], { work: false })
    const id = (await jobs.enqueue(definition.name, payload, { singletonKey: key })) as string
    const identity = { id, ...payload }
    expect(await jobs.hasLiveInvitationEmailJob(identity)).toBe(true)
    expect(await jobs.hasLiveInvitationEmailJob({ ...identity, id: randomUUID() })).toBe(false)
    expect(await jobs.hasLiveInvitationEmailJob({ ...identity, generation: 2 })).toBe(false)
    const otherId = (await jobs.enqueue(other.name, payload, { singletonKey: key })) as string
    expect(await jobs.hasLiveInvitationEmailJob({ ...identity, id: otherId })).toBe(false)

    await testDb.pool.query('UPDATE pgboss.job SET singleton_key=$2 WHERE id=$1', [id, 'wrong-key'])
    expect(await jobs.hasLiveInvitationEmailJob(identity)).toBe(false)
    await testDb.pool.query('UPDATE pgboss.job SET singleton_key=$2, data=$3::jsonb WHERE id=$1', [
      id,
      key,
      JSON.stringify({ ...payload, extra: 'unexpected' }),
    ])
    expect(await jobs.hasLiveInvitationEmailJob(identity)).toBe(false)
    await testDb.pool.query('UPDATE pgboss.job SET data=$2::jsonb WHERE id=$1', [
      id,
      JSON.stringify(payload),
    ])

    for (const state of ['created', 'retry', 'active', 'completed', 'cancelled', 'failed']) {
      await testDb.pool.query(
        `UPDATE pgboss.job SET state=$2::pgboss.job_state,
        keep_until=clock_timestamp() + INTERVAL '1 day',
        started_on=clock_timestamp(), expire_seconds=180 WHERE id=$1`,
        [id, state],
      )
      expect(await jobs.hasLiveInvitationEmailJob(identity), state).toBe(
        ['created', 'retry', 'active'].includes(state),
      )
    }
    await testDb.pool.query(
      "UPDATE pgboss.job SET state='created', keep_until=clock_timestamp() - INTERVAL '1 second' WHERE id=$1",
      [id],
    )
    expect(await jobs.hasLiveInvitationEmailJob(identity)).toBe(false)
    await testDb.pool.query(
      "UPDATE pgboss.job SET state='active', started_on=clock_timestamp() - INTERVAL '181 seconds' WHERE id=$1",
      [id],
    )
    expect(await jobs.hasLiveInvitationEmailJob(identity)).toBe(false)
    await testDb.pool.query('UPDATE pgboss.job SET started_on=NULL WHERE id=$1', [id])
    expect(await jobs.hasLiveInvitationEmailJob(identity)).toBe(false)
  })

  it('refuses startup when the pinned pg-boss version changes, even without invitation queues', async () => {
    const jobs = createJobs({
      connectionString: testDb.url,
      definitions: [],
      work: true,
      migrate: true,
      maxConnections: 2,
      log: () => {},
    })
    started.push(jobs)
    const version = pgBossPackage.version
    try {
      pgBossPackage.version = 'unsupported-test-version'
      await expect(jobs.start()).rejects.toThrow(
        'background jobs require pg-boss 12.38.0; found unsupported-test-version. Review the invitation job lookup before upgrading',
      )
      expect(jobs.running).toBe(false)
    } finally {
      pgBossPackage.version = version
    }
  })

  it("uses pg-boss's transaction clock for queued and active invitation expiry", async () => {
    const definition = defineJob({
      name: 'invitation-email-v1',
      payload: z.strictObject({ invitationId: z.uuid(), generation: z.number().int() }),
      policy: 'exclusive',
    })
    const jobs = await start([definition], { work: false })
    const payload = { invitationId: randomUUID(), generation: 1 }
    const db = createDb(testDb.pool)
    await db.transaction().execute(async (trx) => {
      const id = (await jobs.enqueue(definition.name, payload, {
        singletonKey: `invitation-email:v1:${payload.invitationId}:1`,
        transaction: trx,
      })) as string
      // pg-boss's job_now() stays at this transaction's start while wall time advances.
      await sql`UPDATE pgboss.job
        SET keep_until=pgboss.job_now() + INTERVAL '1 second',
            started_on=pgboss.job_now() - INTERVAL '179 seconds', expire_seconds=180
        WHERE id=${id}`.execute(trx)
      await new Promise((resolve) => setTimeout(resolve, 1200))
      for (const state of ['created', 'retry', 'active']) {
        await sql`UPDATE pgboss.job SET state=${state}::pgboss.job_state WHERE id=${id}`.execute(
          trx,
        )
        expect(await jobs.hasLiveInvitationEmailJob({ id, ...payload }, trx), state).toBe(true)
      }
    })
  })

  it('reads an invitation job through the caller transaction without requiring another connection', async () => {
    const definition = defineJob({
      name: 'invitation-email-v1',
      payload: z.strictObject({ invitationId: z.uuid(), generation: z.number().int() }),
      policy: 'exclusive',
      handler: async () => {},
    })
    const jobs = await start([definition], { work: false })
    const payload = { invitationId: randomUUID(), generation: 2 }
    const db = createDb(testDb.pool)
    await expect(
      db.transaction().execute(async (trx) => {
        const id = (await jobs.enqueue(definition.name, payload, {
          singletonKey: `invitation-email:v1:${payload.invitationId}:2`,
          transaction: trx,
        })) as string
        expect(await jobs.hasLiveInvitationEmailJob({ id, ...payload })).toBe(false)
        expect(await jobs.hasLiveInvitationEmailJob({ id, ...payload }, trx)).toBe(true)
        throw new Error('synthetic rollback')
      }),
    ).rejects.toThrow('synthetic rollback')
  })

  it('starts a job no earlier than startAfter', async () => {
    const name = queueName('later')
    let ran = false
    const later = defineJob({
      name,
      payload: z.object({}),
      async handler() {
        ran = true
      },
    })
    const jobs = await start([later])
    const at = Temporal.Now.instant().add({ hours: 23 }).round('second')
    const id = await jobs.enqueue(name, {}, { startAfter: at })
    const [row] = await jobRows(name)
    expect(row?.id).toBe(id)
    expect(row?.start_after.toISOString()).toBe(new Date(at.epochMilliseconds).toISOString())
    await new Promise((r) => setTimeout(r, 1200))
    expect(ran).toBe(false)
    expect((await jobRows(name))[0]?.state).toBe('created')
  })

  it('retries a failed attempt and logs one line per failure, without the payload', async () => {
    const name = queueName('flaky')
    const lines: string[] = []
    let calls = 0
    const flaky = defineJob({
      name,
      payload: z.object({ secret: z.string() }),
      retry: { limit: 1, delaySeconds: 0, backoff: false },
      async handler() {
        calls++
        if (calls === 1) throw new Error('smtp down\nsecond line')
      },
    })
    const jobs = await start([flaky], { lines })
    await jobs.enqueue(name, { secret: 'hm_super_secret_value' })
    await until(
      async () => (await jobRows(name))[0]?.state === 'completed',
      'the failed job retry to reach the completed state',
    )
    expect(calls).toBe(2)
    const failures = lines.filter((l) => l.includes(`ERROR job ${name}`))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain(
      'attempt 1 of 2 failed (will retry): Error: smtp down\\nsecond line',
    )
    expect(failures[0]).not.toMatch(/[\n\r]/)
    expect(lines.join('\n')).not.toContain('hm_super_secret_value')
  }, 20_000)

  it('waits for a running job when stopping and takes no new ones', async () => {
    const name = queueName('slow')
    const entered = deferred()
    const release = deferred()
    const slow = defineJob({
      name,
      payload: z.object({}),
      async handler() {
        entered.resolve()
        await release.promise
      },
    })
    const jobs = await start([slow])
    await jobs.enqueue(name, {})
    await entered.promise
    let stopped = false
    const stopping = jobs.stop().then(() => {
      stopped = true
    })
    expect(jobs.running).toBe(false)
    await new Promise((r) => setTimeout(r, 300))
    expect(stopped).toBe(false)
    release.resolve()
    await stopping
    expect((await jobRows(name))[0]?.state).toBe('completed')
    await expect(jobs.enqueue(name, {})).rejects.toThrow(/not running/)
  })

  it('fails a job still running after the shutdown timeout, so it is retried later', async () => {
    const name = queueName('stuck')
    const entered = deferred()
    let aborted = false
    const stuck = defineJob({
      name,
      payload: z.object({}),
      async handler(_payload, { signal }) {
        entered.resolve()
        // Like a mailer that stops waiting: rejects with the signal's reason.
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => {
            aborted = true
            reject(signal.reason)
          }),
        )
      },
    })
    const lines: string[] = []
    const jobs = await start([stuck], { shutdownTimeoutMs: 1000, lines })
    await jobs.enqueue(name, {})
    await entered.promise
    const before = Date.now()
    await jobs.stop()
    expect(Date.now() - before).toBeLessThan(5000)
    expect(aborted).toBe(true)
    expect((await jobRows(name))[0]?.state).toBe('retry')
    // One plain line, not an abort error's stack.
    const mine = lines.filter((l) => l.includes(name))
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatch(
      /WARN job .* attempt 1 of 4 stopped: the worker is shutting down \(will retry\)$/,
    )
  })

  it("checks pg-boss's own pool while running", async () => {
    const jobs = await start([], { work: false })
    await expect(jobs.check()).resolves.toBeUndefined()
    await jobs.stop()
    await expect(jobs.check()).rejects.toThrow(/not running/)
  })

  it('refuses to change the policy of an existing queue', async () => {
    const name = queueName('policy')
    await start([defineJob({ name, payload: z.object({}), async handler() {} })], { work: false })
    await expect(
      start([defineJob({ name, payload: z.object({}), policy: 'exclusive', async handler() {} })], {
        work: false,
      }),
    ).rejects.toThrow(/has policy standard but its job definition says exclusive/)
  })

  it('updates retry settings of an existing queue', async () => {
    const name = queueName('retune')
    const define = (limit: number) =>
      defineJob({ name, payload: z.object({}), retry: { limit }, async handler() {} })
    await start([define(1)], { work: false })
    await start([define(7)], { work: false })
    const queue = await testDb.pool.query<{ retry_limit: number }>(
      'SELECT retry_limit FROM pgboss.queue WHERE name = $1',
      [name],
    )
    expect(queue.rows[0]?.retry_limit).toBe(7)
  })
})
