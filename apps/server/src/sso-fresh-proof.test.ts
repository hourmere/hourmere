import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { type CallerResolver, checkTeamManagementAccess, type Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { Hono } from 'hono'
import { sql } from 'kysely'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  type IdentityFixture,
  identityFixture,
  proveMailbox,
  session,
} from '../../../packages/db/src/sso-identity-fixtures.ts'
import { createApp } from './app.ts'
import type { SsoCapabilities } from './sso.ts'
import * as real from './sso-fresh-proof.ts'
import * as mailbox from './sso-mailbox-proof.ts'

const PUBLIC_URL = 'http://localhost:4321'
const ON: SsoCapabilities = { ssoOidcEnabled: true, ssoSamlEnabled: false }
const OFF: SsoCapabilities = { ssoOidcEnabled: false, ssoSamlEnabled: false }
const schema = z.object({
  name: z.string().min(1),
  nested: z.object({ a: z.number(), b: z.number() }).optional(),
})
const databaseUrl = process.env.DATABASE_URL
let owned: TestDatabase
let db: Db
let client: pg.PoolClient
let f: IdentityFixture
const users = new Map<string, string>()
type Module = typeof real
type Browser = { binding: string; session: string }
const browser = (id = f.sessions[f.owner] as string): Browser => ({
  binding: randomBytes(32).toString('base64url'),
  session: id,
})
function headers(who: Browser, extra: Record<string, string> = {}) {
  return {
    origin: PUBLIC_URL,
    'content-type': 'application/json',
    cookie: `${mailbox.BROWSER_BINDING_COOKIE}=${who.binding}; session=${who.session}`,
    ...extra,
  }
}
const resolveCaller: CallerResolver = async (headers) => {
  const sessionId = /(?:^|; )session=([^;]+)/.exec(headers.get('cookie') ?? '')?.[1]
  const userId = sessionId ? users.get(sessionId) : undefined
  if (!sessionId || !userId) return { ok: false, error: 'unauthorized', setCookie: [] }
  return {
    ok: true,
    principal: {
      kind: 'session',
      sessionId,
      user: { id: userId, email: 'synthetic@example.test', name: 'Synthetic' },
      organization: {
        id: userId === f.otherOwner ? f.otherTeam : f.team,
        name: 'Team',
        slug: 'team',
        personal: false,
      },
    } as Principal,
    setCookie: [],
  }
}
function harness(M: Module = real, capabilities = ON) {
  const state = { now: undefined as string | undefined, clockReads: 0, fail: false }
  const app = new Hono()
  app.post('/test/:team/:operation', async (c) => {
    const resolved = await resolveCaller(c.req.raw.headers)
    if (!resolved.ok || resolved.principal.kind !== 'session')
      return c.json({ error: 'unauthorized' }, 401)
    const p = resolved.principal
    try {
      const result = await M.runWithFreshProof(
        {
          db,
          capabilities,
          publicUrl: PUBLIC_URL,
          now: async (trx) => {
            state.clockReads++
            return state.now ?? mailbox.databaseClock(trx)
          },
        },
        {
          headers: c.req.raw.headers,
          userId: p.user.id,
          sessionId: p.sessionId,
          organizationId: c.req.param('team'),
          operation: c.req.param('operation'),
          input: await c.req.json(),
          schema,
        },
        {
          authorize: async (trx) => {
            await checkTeamManagementAccess(trx, p, c.req.param('team'), true, {
              expectedOrganizationId: c.req.header('X-Expected-Organization-Id') ?? '',
              allowPersonal: false,
            })
          },
          mutate: async (trx) => {
            await sql`INSERT INTO fresh_proof_test_writes (organization_id) VALUES (${c.req.param('team')}::uuid)`.execute(
              trx,
            )
            if (state.fail) throw new Error('synthetic rollback')
            return { changed: true }
          },
        },
      )
      if (result.setCookie) c.header('Set-Cookie', result.setCookie)
      return result.status === 'proof_required'
        ? c.json(result.body, 403)
        : c.json(result.value, 200)
    } catch (error) {
      const e = error as { kind?: string; code?: string; status?: number }
      if (e.code === 'team_management_access_denied') return c.json({ error: e.code }, 403)
      if (e.code === 'organization_context_changed') return c.json({ error: e.code }, 409)
      if (e.status === 403) return c.json({ error: 'forbidden' }, 403)
      return c.json(
        { error: e.code ?? 'internal_error' },
        e.kind === 'invalid'
          ? 400
          : e.kind === 'forbidden'
            ? 403
            : e.kind === 'not_found'
              ? 404
              : e.kind === 'conflict'
                ? 409
                : 500,
      )
    }
  })
  return { app, state }
}
type Harness = ReturnType<typeof harness>
function write(
  h: Harness,
  who: Browser,
  body: unknown = { name: 'draft' },
  team = f.team,
  operation = 'testFreshWrite',
  extra: Record<string, string> = {},
) {
  return h.app.request(`/test/${team}/${operation}`, {
    method: 'POST',
    headers: headers(who, { 'X-Expected-Organization-Id': team, ...extra }),
    body: JSON.stringify(body),
  })
}
async function required(response: Response) {
  const body = (await response.json()) as {
    error: string
    attemptId: string
    proofMethods: string[]
    expiresAt: string
  }
  expect(response.status, JSON.stringify(body)).toBe(403)
  expect(body.error).toBe('sso_reauthentication_required')
  expect(body.attemptId).toMatch(/^[0-9a-f-]{36}$/)
  expect(Number.isFinite(Date.parse(body.expiresAt))).toBe(true)
  return body
}
async function row(id: string) {
  return (await client.query('SELECT * FROM sso_attempts WHERE id=$1', [id])).rows[0]
}
async function count(table: string) {
  return Number((await client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)
}
async function prove(id: string) {
  await proveMailbox(client, await row(id))
}
async function instant(id: string, column: string, adjustment = '') {
  return (
    await client.query(
      `SELECT (${column}${adjustment})::text AS instant FROM sso_attempts WHERE id=$1`,
      [id],
    )
  ).rows[0].instant as string
}
async function sourceCopy(mutation?: [string, string]): Promise<Module> {
  const location = new URL('./sso-fresh-proof.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  if (mutation) {
    expect(source).toContain(mutation[0])
    source = source.replaceAll(...mutation)
  }
  const javascript = stripTypeScriptTypes(source).replace(
    /((?:from|import)\s*)'([^']+)'/g,
    (_, prefix: string, specifier: string) =>
      `${prefix}'${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}

async function bindingScenario(M: Module) {
  const h = harness(M)
  const who = browser()
  const a = await required(await write(h, who))
  await prove(a.attemptId)
  const otherSession = await session(client, f.owner)
  users.set(otherSession, f.owner)
  await client.query('UPDATE auth.session SET "activeOrganizationId"=$1 WHERE id=$2', [
    f.team,
    otherSession,
  ])
  for (const [presenter, body, team, operation] of [
    [browser(), { name: 'draft', proofAttemptId: a.attemptId }, f.team, 'testFreshWrite'],
    [
      { ...who, session: otherSession },
      { name: 'draft', proofAttemptId: a.attemptId },
      f.team,
      'testFreshWrite',
    ],
    [
      { ...who, session: f.sessions[f.admin] },
      { name: 'draft', proofAttemptId: a.attemptId },
      f.team,
      'testFreshWrite',
    ],
    [who, { name: 'changed', proofAttemptId: a.attemptId }, f.team, 'testFreshWrite'],
    [who, { name: 'draft', proofAttemptId: a.attemptId }, f.team, 'anotherWrite'],
    [
      { ...who, session: f.sessions[f.otherOwner] },
      { name: 'draft', proofAttemptId: a.attemptId },
      f.otherTeam,
      'testFreshWrite',
    ],
  ] as const) {
    const next = await required(await write(h, presenter as Browser, body, team, operation))
    expect(next.attemptId).not.toBe(a.attemptId)
    expect((await row(a.attemptId)).consumed_at).toBeNull()
  }
  expect((await write(h, who, { name: 'draft', proofAttemptId: a.attemptId })).status).toBe(200)
}

async function expiryScenario(M: Module) {
  const h = harness(M)
  const who = browser()
  const a = await required(await write(h, who))
  await prove(a.attemptId)
  const live = await required(await write(h, who))
  await prove(live.attemptId)
  h.state.now = await instant(
    live.attemptId,
    'mailbox_proof_expires_at',
    " - interval '1 microsecond'",
  )
  expect((await write(h, who, { name: 'draft', proofAttemptId: live.attemptId })).status).toBe(200)
  h.state.now = await instant(a.attemptId, 'mailbox_proof_expires_at')
  const next = await required(await write(h, who, { name: 'draft', proofAttemptId: a.attemptId }))
  expect(next.attemptId).not.toBe(a.attemptId)
  expect((await row(a.attemptId)).consumed_at).toBeNull()
}

async function lockedExpiryScenario(M: Module) {
  const h = harness(M)
  const who = browser()
  const a = await required(await write(h, who))
  await prove(a.attemptId)
  const expires = await instant(a.attemptId, 'mailbox_proof_expires_at')
  h.state.now = await instant(
    a.attemptId,
    'mailbox_proof_expires_at',
    " - interval '1 microsecond'",
  )
  const before = await count('fresh_proof_test_writes')
  const blocker = await owned.pool.connect()
  let pending: Promise<Response> | undefined
  let reads = -1
  try {
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM sso_attempts WHERE id=$1 FOR UPDATE', [a.attemptId])
    h.state.clockReads = 0
    pending = Promise.resolve(write(h, who, { name: 'draft', proofAttemptId: a.attemptId }))
    let waiting = false
    for (let i = 0; i < 200; i++) {
      const result = await client.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%sso_attempts%'",
      )
      if (result.rowCount) {
        waiting = true
        break
      }
      await delay(10)
    }
    expect(waiting, 'the retry really waits for the attempt lock').toBe(true)
    reads = h.state.clockReads
    h.state.now = expires
  } finally {
    await blocker.query('ROLLBACK')
    blocker.release()
  }
  const response = await pending
  expect(reads, 'clock is read only after the attempt lock').toBe(0)
  const next = await required(response as Response)
  expect(next.attemptId).not.toBe(a.attemptId)
  expect((await row(a.attemptId)).consumed_at).toBeNull()
  expect(await count('fresh_proof_test_writes')).toBe(before)
}

describe.skipIf(!databaseUrl)('SSO fresh proof', () => {
  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'sso_fresh' })
    db = createDb(owned.pool)
    client = await owned.pool.connect()
    f = await identityFixture(client)
    await client.query('UPDATE auth."user" SET "emailVerified"=true WHERE id=ANY($1::uuid[])', [
      Object.keys(f.sessions),
    ])
    for (const [user, id] of Object.entries(f.sessions))
      await client.query('UPDATE auth.session SET "activeOrganizationId"=$1 WHERE id=$2', [
        user === f.otherOwner ? f.otherTeam : f.team,
        id,
      ])
    for (const [user, id] of Object.entries(f.sessions)) users.set(id, user)
    await client.query(
      'CREATE TABLE fresh_proof_test_writes (id integer GENERATED ALWAYS AS IDENTITY, organization_id uuid NOT NULL)',
    )
  }, 60_000)
  afterAll(async () => {
    client?.release()
    await owned?.drop()
  })

  it('returns an attempt only, proves through mailbox send/consume, and retries exactly once', async () => {
    const h = harness()
    const who = browser()
    const before = await count('fresh_proof_test_writes')
    const a = await required(await write(h, who))
    expect(a.proofMethods).toEqual(['mailbox'])
    expect(await count('fresh_proof_test_writes')).toBe(before)
    expect((await row(a.attemptId)).kind).toBe('fresh_proof')
    expect((await row(a.attemptId)).browser_binding_digest).toBe(mailbox.sha256(who.binding))
    const pending = await required(
      await write(h, who, { name: 'draft', proofAttemptId: a.attemptId }),
    )
    expect(pending.attemptId).toBe(a.attemptId)
    const queued: mailbox.MailboxProofEmailPayload[] = []
    const sent: MailMessage[] = []
    const mailApp = createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller,
      publicUrl: PUBLIC_URL,
      ssoMailboxProof: mailbox.mailboxProofRoutes({
        db,
        capabilities: ON,
        queue: {
          enqueue: async (_name, payload) => {
            queued.push(mailbox.MailboxProofEmailPayload.parse(payload))
            return 'job'
          },
        },
      }),
    })
    const post = (path: string, body: unknown) =>
      mailApp.request(path, { method: 'POST', headers: headers(who), body: JSON.stringify(body) })
    expect((await post(mailbox.MAILBOX_PROOF_SEND_PATH, { attemptId: a.attemptId })).status).toBe(
      202,
    )
    await mailbox.deliverMailboxProof(
      {
        db,
        capabilities: ON,
        publicUrl: PUBLIC_URL,
        secret: 'synthetic-secret-at-least-32-characters',
        mailer: {
          send: async (message) => {
            sent.push(message)
          },
        },
      },
      queued[0] as mailbox.MailboxProofEmailPayload,
    )
    expect(sent).toHaveLength(1)
    const token = /&token=([A-Za-z0-9_-]+)/.exec(sent[0]?.text ?? '')?.[1]
    expect(token).toBeDefined()
    expect(
      (await post(mailbox.MAILBOX_PROOF_CONSUME_PATH, { attemptId: a.attemptId, token })).status,
    ).toBe(200)
    expect(await count('fresh_proof_test_writes')).toBe(before)
    expect((await write(h, who, { name: 'draft', proofAttemptId: a.attemptId })).status).toBe(200)
    const replay = await required(
      await write(h, who, { name: 'draft', proofAttemptId: a.attemptId }),
    )
    expect(replay.attemptId).not.toBe(a.attemptId)
    expect(await count('fresh_proof_test_writes')).toBe(before + 1)
  })

  it('binds the proof to browser, user, session, input, operation and team', () =>
    bindingScenario(real))

  it('rejects a proof from another intent and unknown attempts without consuming them', async () => {
    const h = harness()
    const who = browser()
    const a = await required(await write(h, who))
    await prove(a.attemptId)
    await client.query('BEGIN')
    try {
      await client.query('SET LOCAL session_replication_role=replica')
      await client.query(
        "UPDATE sso_attempts SET kind='test', provider_id=$2, provider_revision=$3 WHERE id=$1",
        [a.attemptId, f.provider.id, f.provider.revision],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    for (const id of [a.attemptId, '0190f2c4-0000-7000-8000-000000000001']) {
      expect(
        (await required(await write(h, who, { name: 'draft', proofAttemptId: id }))).attemptId,
      ).not.toBe(id)
    }
    expect((await row(a.attemptId)).consumed_at).toBeNull()
  })

  it('uses a canonical object digest and ignores only the proofAttemptId', async () => {
    const h = harness()
    const who = browser()
    const a = await required(await write(h, who, { name: 'draft', nested: { a: 1, b: 2 } }))
    await prove(a.attemptId)
    expect(
      (await write(h, who, { nested: { b: 2, a: 1 }, proofAttemptId: a.attemptId, name: 'draft' }))
        .status,
    ).toBe(200)
  })

  it('validates session, role, expected team, exact Origin, Authorization and strict input before attempts', async () => {
    const h = harness()
    const who = browser()
    const before = await count('sso_attempts')
    for (const extra of [
      { authorization: 'Bearer synthetic' },
      { authorization: '' },
      { origin: '' },
      { origin: `${PUBLIC_URL}/` },
      { origin: 'https://attacker.example' },
    ] as Record<string, string>[])
      expect((await write(h, who, { name: 'draft' }, f.team, 'testFreshWrite', extra)).status).toBe(
        403,
      )
    expect((await write(h, browser(f.sessions[f.member]))).status).toBe(403)
    expect((await write(h, browser('missing-session'))).status).toBe(401)
    expect(
      (
        await write(h, who, { name: 'draft' }, f.team, 'testFreshWrite', {
          'X-Expected-Organization-Id': f.otherTeam,
        })
      ).status,
    ).toBe(403)
    for (const body of [
      {},
      { name: 'draft', extra: true },
      { name: 'draft', nested: { a: 1, b: 2, extra: true } },
      { name: 'draft', proofAttemptId: 'bad' },
      { name: 'draft', proofAttemptId: null },
      [],
    ])
      expect((await write(h, who, body)).status).toBe(400)
    expect(await count('sso_attempts')).toBe(before)
  })

  it('rechecks authority when retrying and leaves the proof unconsumed on refusal', async () => {
    const h = harness()
    const who = browser(f.sessions[f.admin])
    const a = await required(await write(h, who))
    await prove(a.attemptId)
    await client.query("UPDATE auth.member SET role='member' WHERE id=$1", [f.adminMember])
    try {
      expect((await write(h, who, { name: 'draft', proofAttemptId: a.attemptId })).status).toBe(403)
      expect((await row(a.attemptId)).consumed_at).toBeNull()
    } finally {
      await client.query("UPDATE auth.member SET role='admin' WHERE id=$1", [f.adminMember])
    }
  })

  it('consumes atomically with the operation and allows only one concurrent commit', async () => {
    const h = harness()
    const who = browser()
    const a = await required(await write(h, who))
    await prove(a.attemptId)
    const before = await count('fresh_proof_test_writes')
    h.state.fail = true
    expect((await write(h, who, { name: 'draft', proofAttemptId: a.attemptId })).status).toBe(500)
    expect((await row(a.attemptId)).consumed_at).toBeNull()
    expect(await count('fresh_proof_test_writes')).toBe(before)
    h.state.fail = false
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        write(h, who, { name: 'draft', proofAttemptId: a.attemptId }),
      ),
    )
    expect(responses.map((r) => r.status).sort()).toEqual([200, 403, 403])
    expect(await count('fresh_proof_test_writes')).toBe(before + 1)
  })

  it('requires unsatisfiable SSO on an enforced team even with a mailbox proof', async () => {
    await client.query(
      'INSERT INTO sso_policies (organization_id, require_sso) VALUES ($1, true)',
      [f.otherTeam],
    )
    const h = harness()
    const who = browser(f.sessions[f.otherOwner])
    const a = await required(await write(h, who, { name: 'draft' }, f.otherTeam))
    expect(a.proofMethods).toEqual(['sso'])
    await client.query('BEGIN')
    try {
      await client.query('SET LOCAL session_replication_role=replica')
      await client.query(
        "UPDATE sso_attempts SET requires_mailbox=true, mailbox_proven_at=clock_timestamp(), mailbox_proof_expires_at=clock_timestamp()+interval '240 seconds' WHERE id=$1",
        [a.attemptId],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    const retry = await required(
      await write(h, who, { name: 'draft', proofAttemptId: a.attemptId }, f.otherTeam),
    )
    expect(retry.attemptId).toBe(a.attemptId)
    expect(retry.proofMethods).toEqual(['sso'])
    expect((await row(a.attemptId)).consumed_at).toBeNull()
  })

  it('is off before any attempt or operation write and ships no route', async () => {
    const before = [await count('sso_attempts'), await count('fresh_proof_test_writes')]
    const h = harness(real, OFF)
    expect((await write(h, browser())).status).toBe(404)
    expect(h.state.clockReads).toBe(0)
    expect([await count('sso_attempts'), await count('fresh_proof_test_writes')]).toEqual(before)
    for (const file of ['./server.ts', './app.ts'])
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toContain(
        "from './sso-fresh-proof.ts'",
      )
    const production = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    expect(production).toContain('const ssoOidcEnabled = false')
    expect(production).toContain('const ssoSamlEnabled = false')
  })
  it('expires mailbox proof at its exact fresh-administration deadline', () => expiryScenario(real))
  it('reads expiry after waiting for the row lock', () => lockedExpiryScenario(real))
  it('expires attempts exactly at their deadline and keeps the preceding microsecond usable', async () => {
    const h = harness()
    const who = browser()
    const a = await required(await write(h, who))
    h.state.now = await instant(a.attemptId, 'expires_at', " - interval '1 microsecond'")
    expect(
      (await required(await write(h, who, { name: 'draft', proofAttemptId: a.attemptId })))
        .attemptId,
    ).toBe(a.attemptId)
    h.state.now = await instant(a.attemptId, 'expires_at')
    expect(
      (await required(await write(h, who, { name: 'draft', proofAttemptId: a.attemptId })))
        .attemptId,
    ).not.toBe(a.attemptId)
    expect((await row(a.attemptId)).consumed_at).toBeNull()
  })
  it('refuses the stored session exactly at expiry even if the resolver still accepts it', async () => {
    const h = harness()
    const who = browser()
    const a = await required(await write(h, who))
    await prove(a.attemptId)
    h.state.now = (
      await client.query('SELECT "expiresAt"::text AS at FROM auth.session WHERE id=$1', [
        who.session,
      ])
    ).rows[0].at
    const before = await count('sso_attempts')
    expect((await write(h, who, { name: 'draft', proofAttemptId: a.attemptId })).status).toBe(403)
    expect((await row(a.attemptId)).consumed_at).toBeNull()
    expect(await count('sso_attempts')).toBe(before)
  })
  it('issues a secure browser binding when none is supplied and never stores the raw value', async () => {
    const h = harness()
    const who = browser()
    const response = await write(h, who, { name: 'draft' }, f.team, 'testFreshWrite', {
      cookie: `session=${who.session}`,
    })
    const a = await required(response)
    const cookie = response.headers.get('set-cookie')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    const value = /hourmere.sso_binding=([^;]+)/.exec(cookie ?? '')?.[1] as string
    expect((await row(a.attemptId)).browser_binding_digest).toBe(mailbox.sha256(value))
    expect(JSON.stringify(await row(a.attemptId))).not.toContain(value)
  })
  describe('source-copy mutations', () => {
    it('runs unchanged source through the same assertions', async () => {
      const control = await sourceCopy()
      await bindingScenario(control)
      await expiryScenario(control)
      await lockedExpiryScenario(control)
    })
    it('detects missing browser and operation binding', async () => {
      const mutant = await sourceCopy([
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source-copy mutation anchor.
        'AND browser_binding_digest = ${binding} AND operation = ${request.operation}',
        '',
      ])
      await expect(bindingScenario(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
    })
    it('detects accepting the exact proof expiry boundary', async () => {
      const mutant = await sourceCopy([
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source-copy mutation anchor.
        'mailbox_proof_expires_at > ${now}::timestamptz',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source-copy mutation anchor.
        'mailbox_proof_expires_at >= ${now}::timestamptz',
      ])
      await expect(expiryScenario(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
    })
    it('detects reading time before the attempt lock', async () => {
      const mutant = await sourceCopy([
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source-copy mutation anchor.
        '    if (proofAttemptId)\n      await sql`SELECT id FROM sso_attempts WHERE id = ${proofAttemptId}::uuid FOR UPDATE`.execute(\n        trx,\n      )\n    const now = await clock(trx)',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source-copy mutation anchor.
        '    const now = await clock(trx)\n    if (proofAttemptId)\n      await sql`SELECT id FROM sso_attempts WHERE id = ${proofAttemptId}::uuid FOR UPDATE`.execute(\n        trx,\n      )',
      ])
      await expect(lockedExpiryScenario(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
    })
  })
})
