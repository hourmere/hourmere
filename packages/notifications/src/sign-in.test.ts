import { randomBytes, randomUUID } from 'node:crypto'
import { createAuth, createAuthPool, type SignupPolicy } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs, type EnqueueOptions } from '@hourmere/jobs'
import type { MailMessage } from '@hourmere/mail'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deliverSignInEmail,
  queuedSignInEmail,
  SIGN_IN_EMAIL_JOB,
  type SignInEmailDeps,
  signInEmailJobs,
} from './sign-in.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'http://localhost:4189'
const closed: SignupPolicy = { mode: 'closed', allowedDomains: [] }
const secret = randomBytes(32).toString('base64')

describe.skipIf(!serverUrl)('queued sign-in email', () => {
  let owned: TestDatabase
  let db: Db
  const pools = new Map<string, pg.Pool>()
  const sent: MailMessage[] = []
  const queued: { name: string; payload: { emailId: string }; options?: EnqueueOptions }[] = []
  const deps = (overrides: Partial<SignInEmailDeps> = {}): SignInEmailDeps => ({
    db,
    publicUrl,
    secret,
    signup: closed,
    mailer: {
      send: async (message) => {
        sent.push(message)
      },
    },
    ...overrides,
  })
  const queue = {
    enqueue: async (
      name: typeof SIGN_IN_EMAIL_JOB,
      payload: { emailId: string },
      options?: EnqueueOptions,
    ) => {
      queued.push({ name, payload, ...(options && { options }) })
      expect(options?.transaction).toHaveProperty('isTransaction', true)
      return randomUUID()
    },
  }

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await Promise.all([...pools.values()].map((pool) => pool.end()))
    await owned?.drop()
  })
  beforeEach(async () => {
    await db.deleteFrom('sign_in_emails').execute()
    await db.deleteFrom('auth.verification').execute()
    await db.deleteFrom('auth.organization').execute()
    await db.deleteFrom('auth.user').execute()
    sent.length = 0
    queued.length = 0
  })
  const rows = () => db.selectFrom('sign_in_emails').selectAll().execute()
  async function existing(email = 'existing@example.com') {
    return db
      .insertInto('auth.user')
      .values({ email, name: 'Existing', emailVerified: true })
      .returning('id')
      .executeTakeFirstOrThrow()
  }
  function authWith({
    policy = closed,
    appDb = db,
    sender = queuedSignInEmail(queue, deps()),
    direct = false,
  }: {
    policy?: SignupPolicy
    appDb?: Db
    sender?: (request: { email: string; url: string }) => Promise<void>
    direct?: boolean
  } = {}) {
    const key = JSON.stringify(policy)
    let pool = pools.get(key)
    if (!pool) {
      pool = createAuthPool(owned.url, policy)
      pools.set(key, pool)
    }
    return createAuth({
      pool,
      db: appDb,
      baseURL: publicUrl,
      secret,
      signup: policy,
      mailer: {
        send: async (message) => {
          if (direct) {
            sent.push(message)
            return
          }
          throw new Error('direct mail must never run')
        },
      },
      ...(!direct && { queueSignInEmail: sender }),
    })
  }
  async function request(
    auth: ReturnType<typeof authWith>,
    email = 'existing@example.com',
    languageHeaders: Record<string, string> = {},
  ) {
    return auth.handler(
      new Request(`${publicUrl}/api/auth/sign-in/magic-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: publicUrl, ...languageHeaders },
        body: JSON.stringify({ email, callbackURL: '/app' }),
      }),
    )
  }
  async function enqueueExisting() {
    await existing()
    const response = await request(authWith())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: true })
    const row = (await rows())[0]
    expect(row).toBeDefined()
    return row as NonNullable<typeof row>
  }

  it.each([
    [
      'cookie Chinese overrides browser English',
      { cookie: 'hourmere-language=zh-CN', 'accept-language': 'en-US' },
      'zh-CN',
    ],
    [
      'cookie English overrides browser Chinese',
      { cookie: 'hourmere-language=en', 'accept-language': 'zh-CN' },
      'en',
    ],
    ['browser Simplified Chinese', { 'accept-language': 'zh-Hans-CN,en;q=0.5' }, 'zh-CN'],
    [
      'invalid cookie falls back to browser language',
      { cookie: 'hourmere-language=zh_CN', 'accept-language': 'zh-CN' },
      'zh-CN',
    ],
    [
      'unsupported browser language defaults to English',
      { 'accept-language': 'zh-TW,fr-FR' },
      'en',
    ],
    ['missing preferences default to English', {}, 'en'],
  ] as const)(
    'keeps the requester language through encrypted delivery: %s',
    async (_, headers, language) => {
      await existing()
      const response = await request(authWith(), 'existing@example.com', headers)
      expect(response.status).toBe(200)
      expect(sent).toEqual([])
      expect(queued).toHaveLength(1)
      expect(Object.keys(queued[0]?.payload ?? {})).toEqual(['emailId'])
      await deliverSignInEmail(deps(), (await rows())[0]?.id as string)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.subject).toBe(language === 'zh-CN' ? '登录 Hourmere' : 'Sign in to Hourmere')
      expect(sent[0]?.html).toContain(`<html lang="${language}">`)
      expect(sent[0]?.text).toContain(language === 'zh-CN' ? '仅能使用一次' : 'works once')
    },
  )

  it.each(['en', 'zh-CN'] as const)(
    'localizes direct auth delivery using the same requester language: %s',
    async (language) => {
      await existing()
      const response = await request(authWith({ direct: true }), 'existing@example.com', {
        cookie: `hourmere-language=${language}`,
      })
      expect(response.status).toBe(200)
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      expect(sent[0]?.subject).toBe(language === 'zh-CN' ? '登录 Hourmere' : 'Sign in to Hourmere')
      expect(sent[0]?.html).toContain(`<html lang="${language}">`)
      expect(queued).toEqual([])
    },
  )

  it('delivers an older encrypted outbox payload without a language in English', async () => {
    await existing()
    const send = queuedSignInEmail(queue, deps())
    const auth = authWith({ sender: ({ email, url }) => send({ email, url }) })
    const response = await request(auth, 'existing@example.com', {
      cookie: 'hourmere-language=zh-CN',
    })
    expect(response.status).toBe(200)
    await deliverSignInEmail(deps(), (await rows())[0]?.id as string)
    expect(sent[0]?.subject).toBe('Sign in to Hourmere')
    expect(sent[0]?.html).toContain('<html lang="en">')
  })

  it('queues every address with no request-time eligibility lookup, no SMTP, and no plaintext in jobs/outbox', async () => {
    const tables: string[] = []
    const appDb = new Proxy(db, {
      get(target, property) {
        if (property === 'selectFrom')
          return (table: string) => {
            tables.push(table)
            return target.selectFrom(table as 'auth.user')
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await existing()
    // Observe both the auth hooks and the queue's own reads: even an unused account lookup
    // inside queuedSignInEmail would make request timing depend on the address.
    const auth = authWith({ appDb, sender: queuedSignInEmail(queue, deps({ db: appDb })) })
    const answers = []
    for (const email of ['existing@example.com', 'denied@example.com']) {
      const response = await request(auth, email)
      answers.push({ status: response.status, body: await response.json() })
    }
    expect(answers).toEqual(Array(2).fill({ status: 200, body: { status: true } }))
    expect(tables).not.toContain('auth.user')
    expect(tables).not.toContain('auth.invitation')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(sent).toEqual([])
    expect(queued).toHaveLength(2)
    const data = await rows()
    expect(data).toHaveLength(2)
    for (const job of queued) {
      expect(Object.keys(job.payload)).toEqual(['emailId'])
      expect(job.name).toBe(SIGN_IN_EMAIL_JOB)
      const row = data.find((r) => r.id === job.payload.emailId)
      expect(row?.encrypted_payload[0]).toBe(1)
      const text = row?.encrypted_payload.toString('utf8') ?? ''
      for (const needle of [
        'existing@example.com',
        'denied@example.com',
        '/sign-in/confirm',
        'token=',
        secret,
      ])
        expect(text).not.toContain(needle)
    }
    for (const job of queued) await deliverSignInEmail(deps(), job.payload.emailId)
    expect(sent.map((mail) => mail.to)).toEqual(['existing@example.com'])
    expect(await rows()).toEqual([])
  })

  it('delivers a real scanner-safe link and keeps sign-in proof usable', async () => {
    const row = await enqueueExisting()
    const auth = authWith()
    await deliverSignInEmail(deps(), row.id)
    expect(sent).toHaveLength(1)
    const link = new URL(sent[0]?.text.match(/https?:\/\/\S+/)?.[0] as string)
    expect(link.pathname).toBe('/sign-in/confirm')
    expect(link.search).toBe('')
    expect(link.hash).toContain('token=')
    const query = new URLSearchParams(link.hash.slice(1))
    const response = await auth.handler(
      new Request(`${publicUrl}/api/auth/magic-link/verify?${query}`),
    )
    expect(response.status).toBe(302)
    expect(response.headers.getSetCookie().some((c) => c.includes('session_token='))).toBe(true)
    expect(response.headers.get('location')).toBe(`${publicUrl}/app`)
    expect(await rows()).toEqual([])
    await deliverSignInEmail(deps(), row.id)
    expect(sent).toHaveLength(1)
  })

  it.each(['foreign-origin', 'query-token'])(
    'refuses to queue an otherwise valid proof in an unsafe URL: %s',
    async (mode) => {
      await existing()
      const send = queuedSignInEmail(queue, deps())
      const auth = authWith({
        sender: async (input) => {
          const link = new URL(input.url)
          if (mode === 'foreign-origin') link.host = 'untrusted.example'
          else link.search = link.hash.slice(1)
          await send({ ...input, url: link.href })
        },
      })
      await expect(request(auth)).rejects.toThrow('Sign-in email could not be queued')
      expect(queued).toEqual([])
      expect(await rows()).toEqual([])
      expect(sent.length).toBe(0)
    },
  )

  it('discards an expired outbox even when its verification is still live', async () => {
    const row = await enqueueExisting()
    await db
      .updateTable('sign_in_emails')
      .set({ expires_at: new Date(0) })
      .where('id', '=', row.id)
      .execute()
    await deliverSignInEmail(deps(), row.id)
    expect(sent.length).toBe(0)
    expect(await rows()).toEqual([])
    expect(await db.selectFrom('auth.verification').select('id').execute()).toHaveLength(1)
  })

  it('uses worker-time registration policy and live invitations, with separate team acceptance', async () => {
    const owner = await existing('owner@example.com')
    const org = await db
      .insertInto('auth.organization')
      .values({ name: 'Team', slug: 'team', createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.invitation')
      .values({
        organizationId: org.id,
        inviterId: owner.id,
        email: 'invited@example.com',
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 60_000),
      })
      .execute()
    const auth = authWith()
    expect((await request(auth, 'invited@example.com')).status).toBe(200)
    await deliverSignInEmail(deps(), (await rows())[0]?.id as string)
    expect(sent.map((m) => m.to)).toEqual(['invited@example.com'])
    expect(
      await db.selectFrom('auth.member').selectAll().where('organizationId', '=', org.id).execute(),
    ).toEqual([])
    expect((await request(auth, 'later@example.com')).status).toBe(200)
    await deliverSignInEmail(
      deps({ signup: { mode: 'open', allowedDomains: [] } }),
      (await rows())[0]?.id as string,
    )
    expect(sent.map((m) => m.to)).toEqual(['invited@example.com', 'later@example.com'])
  })

  it('does not send an expired, consumed, mismatched or now-revoked link', async () => {
    await existing()
    for (const mode of ['expired', 'consumed', 'mismatched', 'revoked']) {
      await db.deleteFrom('sign_in_emails').execute()
      await db.deleteFrom('auth.verification').execute()
      const auth = authWith({ policy: { mode: 'open', allowedDomains: [] } })
      await request(auth, mode === 'revoked' ? 'new@example.com' : 'existing@example.com')
      const row = (await rows())[0] as Awaited<ReturnType<typeof enqueueExisting>>
      if (mode === 'expired')
        await db
          .updateTable('auth.verification')
          .set({ expiresAt: new Date(0) })
          .execute()
      if (mode === 'consumed') await db.deleteFrom('auth.verification').execute()
      if (mode === 'mismatched')
        await db
          .updateTable('auth.verification')
          .set({ value: JSON.stringify({ type: 'magic-link', email: 'other@example.com' }) })
          .execute()
      await deliverSignInEmail(deps(), row.id)
      expect(sent, mode).toEqual([])
      expect(await rows(), mode).toEqual([])
    }
  })

  it('rolls back the outbox when enqueue throws or refuses the job, and exposes no credentials in the error', async () => {
    await existing()
    for (const result of ['throw', 'null']) {
      const auth = authWith({
        sender: queuedSignInEmail(
          {
            enqueue: async () => {
              if (result === 'null') return null
              throw new Error('raw recipient or token must not escape')
            },
          },
          deps(),
        ),
      })
      await expect(request(auth)).rejects.toThrow('Sign-in email could not be queued')
      expect(await rows()).toEqual([])
    }
  })

  it('keeps a failed send retryable without leaking raw SMTP details', async () => {
    const row = await enqueueExisting()
    const raw = Object.assign(new Error('existing@example.com token=SECRET_PRIVATE_LINK'), {
      code: 'ECONNECTION',
      responseCode: 550,
      private: 'SECRET_PRIVATE_LINK',
    })
    const error = await deliverSignInEmail(
      deps({
        mailer: {
          send: async () => {
            throw raw
          },
        },
      }),
      row.id,
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Sign-in email could not be sent (ECONNECTION) (550)')
    expect((error as Error).cause).toBeUndefined()
    expect((await rows()).map((r) => r.id)).toEqual([row.id])
    await deliverSignInEmail(deps(), row.id)
    expect(sent).toHaveLength(1)
    expect(await rows()).toEqual([])
  })

  it.each(['tampered', 'swapped', 'wrong-secret', 'wrong-origin', 'wrong-version'])(
    'discards unavailable ciphertext without sending or logging data: %s',
    async (mode) => {
      const row = await enqueueExisting()
      const log = vi.fn()
      const runtime = deps({ log })
      if (mode === 'wrong-secret') runtime.secret = randomBytes(32).toString('base64')
      if (mode === 'wrong-origin') runtime.publicUrl = 'http://localhost:4190'
      if (mode === 'tampered' || mode === 'wrong-version') {
        const value = Buffer.from(row.encrypted_payload)
        if (mode === 'wrong-version') value[0] = 2
        else value[value.length - 1] = (value.at(-1) ?? 0) ^ 1
        await db
          .updateTable('sign_in_emails')
          .set({ encrypted_payload: value })
          .where('id', '=', row.id)
          .execute()
      }
      if (mode === 'swapped') {
        await request(authWith())
        const other = (await rows()).find((r) => r.id !== row.id)
        await db
          .updateTable('sign_in_emails')
          .set({ encrypted_payload: other?.encrypted_payload as Buffer })
          .where('id', '=', row.id)
          .execute()
      }
      await deliverSignInEmail(runtime, row.id)
      expect(sent).toEqual([])
      expect(
        await db.selectFrom('sign_in_emails').select('id').where('id', '=', row.id).execute(),
      ).toEqual([])
      expect(log.mock.calls).toEqual([['[auth] discarded an unavailable queued sign-in email']])
    },
  )

  it('serializes duplicate delivery through the outbox lock', async () => {
    const row = await enqueueExisting()
    let release = () => {}
    let reached = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const sending = new Promise<void>((resolve) => {
      reached = resolve
    })
    const mailer = {
      send: vi.fn(async () => {
        reached()
        await held
      }),
    }
    const first = deliverSignInEmail(deps({ mailer }), row.id)
    await sending
    const second = deliverSignInEmail(deps({ mailer }), row.id)
    try {
      await vi.waitFor(async () => {
        const blocked = await owned.pool.query(
          "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%sign_in_emails%'",
        )
        expect(blocked.rows.length).toBeGreaterThan(0)
      })
    } finally {
      release()
      await Promise.all([first, second])
    }
    expect(mailer.send).toHaveBeenCalledTimes(1)
    expect(await rows()).toEqual([])
  })

  it('rechecks consumption after a blocked worker eligibility query', async () => {
    const row = await enqueueExisting()
    const blocker = await owned.pool.connect()
    let delivery: Promise<void> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE auth.invitation IN ACCESS EXCLUSIVE MODE')
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid
      delivery = deliverSignInEmail(deps(), row.id)
      await vi.waitFor(async () => {
        const waiting = await owned.pool.query(
          'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))',
          [pid],
        )
        expect(waiting.rows.length).toBeGreaterThan(0)
      })
      await db.deleteFrom('auth.verification').execute()
      await blocker.query('COMMIT')
      await delivery
      expect(sent).toEqual([])
      expect(await rows()).toEqual([])
    } finally {
      await blocker.query('ROLLBACK')
      await delivery
      blocker.release()
    }
  })

  it('rechecks expiry after a blocked worker eligibility query', async () => {
    const row = await enqueueExisting()
    const proof = await db
      .selectFrom('auth.verification')
      .select('expiresAt')
      .executeTakeFirstOrThrow()
    let now = new Date()
    const blocker = await owned.pool.connect()
    let delivery: Promise<void> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE auth.invitation IN ACCESS EXCLUSIVE MODE')
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid
      delivery = deliverSignInEmail(deps({ now: () => now }), row.id)
      await vi.waitFor(async () => {
        const waiting = await owned.pool.query(
          'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))',
          [pid],
        )
        expect(waiting.rows.length).toBeGreaterThan(0)
      })
      now = proof.expiresAt
      await blocker.query('COMMIT')
      await delivery
      expect(sent.length).toBe(0)
      expect(await rows()).toEqual([])
    } finally {
      await blocker.query('ROLLBACK')
      await delivery
      blocker.release()
    }
  })

  it('removes expired outbox data even if the job was lost, and preserves live data', async () => {
    const row = await enqueueExisting()
    const jobs = signInEmailJobs(deps())
    await jobs[1].handler(
      {},
      { id: randomUUID(), attempt: 1, signal: new AbortController().signal },
    )
    expect((await rows()).map((r) => r.id)).toEqual([row.id])
    await db
      .updateTable('sign_in_emails')
      .set({ expires_at: new Date(0) })
      .where('id', '=', row.id)
      .execute()
    await jobs[1].handler(
      {},
      { id: randomUUID(), attempt: 1, signal: new AbortController().signal },
    )
    expect(await rows()).toEqual([])
    expect(sent).toEqual([])
  })

  it('rolls back the real job as well as the outbox when commit fails', async () => {
    await existing()
    const producer = createJobs({
      connectionString: owned.url,
      definitions: signInEmailJobs(deps()),
      work: false,
      migrate: true,
    })
    try {
      await producer.start()
      const before = (
        await owned.pool.query('SELECT id FROM pgboss.job WHERE name = $1 ORDER BY id', [
          SIGN_IN_EMAIL_JOB,
        ])
      ).rows
      await owned.pool.query(
        `CREATE FUNCTION test_fail_outbox_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced outbox commit failure'; END $$`,
      )
      await owned.pool.query(
        'CREATE CONSTRAINT TRIGGER test_fail_outbox AFTER INSERT ON sign_in_emails DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_outbox_commit()',
      )
      const auth = authWith({ sender: queuedSignInEmail(producer, deps()) })
      await expect(request(auth)).rejects.toThrow('Sign-in email could not be queued')
      expect(await rows()).toEqual([])
      expect(
        (
          await owned.pool.query('SELECT id FROM pgboss.job WHERE name = $1 ORDER BY id', [
            SIGN_IN_EMAIL_JOB,
          ])
        ).rows,
      ).toEqual(before)
    } finally {
      await owned.pool.query('DROP TRIGGER IF EXISTS test_fail_outbox ON sign_in_emails')
      await owned.pool.query('DROP FUNCTION IF EXISTS test_fail_outbox_commit()')
      await producer.stop()
    }
  })

  it('uses real pg-boss producer and worker processes with only ids in stored job payloads', async () => {
    await existing()
    const producer = createJobs({
      connectionString: owned.url,
      definitions: signInEmailJobs(deps()),
      work: false,
      migrate: true,
    })
    const worker = createJobs({
      connectionString: owned.url,
      definitions: signInEmailJobs(deps()),
      work: true,
      migrate: true,
      pollingIntervalSeconds: 0.5,
    })
    try {
      await producer.start()
      const auth = authWith({ sender: queuedSignInEmail(producer, deps()) })
      await request(auth)
      await request(auth, 'denied@example.com')
      expect(sent).toEqual([])
      const jobs = await owned.pool.query<{ data: { emailId: string } }>(
        'SELECT data FROM pgboss.job WHERE name = $1',
        [SIGN_IN_EMAIL_JOB],
      )
      expect(jobs.rows).toHaveLength(2)
      expect(jobs.rows.every((j) => Object.keys(j.data).join(',') === 'emailId')).toBe(true)
      await producer.stop()
      await worker.start()
      await vi.waitFor(
        async () =>
          expect(await rows(), 'waiting for the worker to drain sign-in emails').toEqual([]),
        { timeout: 5_000 },
      )
      expect(sent.map((mail) => mail.to)).toEqual(['existing@example.com'])
    } finally {
      await producer.stop()
      await worker.stop()
    }
  }, 15_000)
})
