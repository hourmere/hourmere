// SSO mailbox proof (docs/sso.md, Implementation sequence, "Mailbox proof"): the send/consume
// pair on attempts of every intent seeded in real PostgreSQL, the worker that alone decides
// delivery, token digests, rotation and expiry at the exact boundary instant, races, misuse
// across accounts, mailboxes, intents and teams, rate limits and the mail budget, the bounded
// cleanup, and the Off state. Mail goes only to a recording fake. Every protection is also
// broken in a source copy of the module, and a real assertion of its scenario must then fail.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { CallerResolver, Principal } from '@hourmere/auth'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { Mailer, MailMessage } from '@hourmere/mail'
import { mailboxProofRecipientHash } from '@hourmere/notifications'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  freshProofValues,
  type IdentityFixture,
  identityFixture,
  linkAttemptValues,
  mailboxOf,
  type Row,
  seeded,
  session,
  signInValues,
  testValues,
} from '../../../packages/db/src/sso-identity-fixtures.ts'
import {
  at,
  digest,
  insert,
  oidcProviderValues,
  sealed,
} from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import type * as server from './server.ts'
import type { SsoCapabilities } from './sso.ts'
import * as real from './sso-mailbox-proof.ts'

type Module = typeof real

async function sourceCopy<T>(file: string, mutation?: [string, string]): Promise<T> {
  const location = new URL(file, import.meta.url)
  let source = readFileSync(location, 'utf8')
  if (mutation) {
    expect(source.includes(mutation[0]), mutation[0]).toBe(true)
    source = source.replace(...mutation)
  }
  const javascript = stripTypeScriptTypes(source).replace(
    /((?:from|import)\s*)'([^']+)'/g,
    (_, prefix: string, specifier: string) =>
      `${prefix}'${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}

const PUBLIC_URL = 'http://localhost:4321'
const ORIGIN = 'http://localhost:4321'
const SECRET = 'synthetic-mailbox-proof-secret-at-least-32-characters'
const ON: SsoCapabilities = { ssoOidcEnabled: true, ssoSamlEnabled: false }
const OFF: SsoCapabilities = { ssoOidcEnabled: false, ssoSamlEnabled: false }
const SESSION_COOKIE = 'synthetic-session'
const databaseUrl = process.env.DATABASE_URL

let owned: TestDatabase
let db: Db
let client: pg.PoolClient
let f: IdentityFixture
/**
 * createApp as Node itself loads it, for source copies: a copy imports its dependencies through
 * Node, so its DomainError is Node's, which only an app loaded the same way recognises.
 */
let nativeCreateApp: typeof createApp

/** Commits a row that the guards only allow to arise with time (expired, consumed). */
async function seed(table: string, values: Row): Promise<Row> {
  await client.query('BEGIN')
  try {
    const inserted = await seeded(client, table, values)
    await client.query('COMMIT')
    return inserted
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
const users = new Map<string, string>()

/** The test's own session cookie stands for Better Auth: it names a session of the fixture. */
const resolveCaller: CallerResolver = async (headers) => {
  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(headers.get('cookie') ?? '')
  const sessionId = match?.[1]
  const userId = sessionId ? users.get(sessionId) : undefined
  if (!sessionId || !userId) return { ok: false, error: 'unauthorized', setCookie: [] }
  const principal = {
    kind: 'session',
    sessionId,
    user: { id: userId, name: 'Synthetic', email: 'synthetic@example.test' },
    organization: { id: f.team, name: 'Team', slug: 'team', personal: false },
  } as Principal
  return { ok: true, principal, setCookie: [] }
}

interface Harness {
  app: ReturnType<typeof createApp>
  queued: { payload: Record<string, unknown>; singletonKey: string | undefined }[]
  sent: MailMessage[]
  logs: string[]
  /** What delivery jobs threw: the worker would retry them. */
  errors: unknown[]
  /** Runs every queued delivery job, as the worker would, and empties the queue. */
  deliver(options?: Partial<real.MailboxProofDeliveryDeps>): Promise<void>
  /** An instant injected into the database clock, or undefined for clock_timestamp(). */
  clock: { now: string | undefined }
}

function harness(
  M: Module = real,
  {
    capabilities = ON,
    limits = {},
    delivery = {},
    database = db,
  }: {
    capabilities?: SsoCapabilities
    limits?: Partial<real.MailboxProofLimits>
    delivery?: Partial<real.MailboxProofDeliveryDeps>
    database?: Db
  } = {},
): Harness {
  const queued: Harness['queued'] = []
  const sent: MailMessage[] = []
  const logs: string[] = []
  const errors: unknown[] = []
  const clock: Harness['clock'] = { now: undefined }
  const now: real.MailboxProofClock = async (trx) => clock.now ?? real.databaseClock(trx)
  const mailer: Mailer = {
    async send(message) {
      sent.push(message)
    },
  }
  const app = (M === real ? createApp : nativeCreateApp)({
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller,
    publicUrl: PUBLIC_URL,
    ssoMailboxProof: M.mailboxProofRoutes({
      capabilities,
      db: database,
      limits: { sendsPerSourcePerMinute: 1000, consumesPerSourcePerMinute: 1000, ...limits },
      now,
      queue: {
        async enqueue(_name, payload, options) {
          queued.push({ payload, singletonKey: options?.singletonKey })
          return 'job'
        },
      },
    }),
  })
  return {
    app,
    queued,
    sent,
    logs,
    errors,
    clock,
    async deliver(options = {}) {
      const jobs = queued.splice(0)
      for (const { payload } of jobs)
        await M.deliverMailboxProof(
          {
            capabilities,
            db: database,
            mailer,
            publicUrl: PUBLIC_URL,
            secret: SECRET,
            mailMaxPerHour: 0,
            limits,
            now,
            log: (line) => logs.push(line),
            ...delivery,
            ...options,
          },
          real.MailboxProofEmailPayload.parse(payload),
        ).catch((error: unknown) => errors.push(error))
      // A refusal is silent; a delivery that threw (a trigger, say) is never a refusal.
      expect(errors).toEqual([])
    },
  }
}

/** A browser: its binding cookie value and, optionally, a session of the fixture. */
interface Browser {
  binding: string
  session?: string | undefined
}
const browser = (session?: string): Browser => ({
  binding: randomBytes(32).toString('base64url'),
  session,
})

function headersFor(who: Browser | undefined, extra: Record<string, string> = {}) {
  const cookies = [
    ...(who ? [`${real.BROWSER_BINDING_COOKIE}=${who.binding}`] : []),
    ...(who?.session ? [`${SESSION_COOKIE}=${who.session}`] : []),
  ]
  return {
    origin: ORIGIN,
    'content-type': 'application/json',
    ...(cookies.length ? { cookie: cookies.join('; ') } : {}),
    ...extra,
  }
}

function post(
  h: Harness,
  path: string,
  body: unknown,
  who: Browser | undefined,
  extra?: Record<string, string>,
) {
  return h.app.request(path, {
    method: 'POST',
    headers: headersFor(who, extra),
    body: JSON.stringify(body),
  })
}
const send = (h: Harness, attemptId: unknown, who?: Browser, extra?: Record<string, string>) =>
  post(h, real.MAILBOX_PROOF_SEND_PATH, { attemptId }, who, extra)
const consume = (
  h: Harness,
  attemptId: unknown,
  token: unknown,
  who?: Browser,
  extra?: Record<string, string>,
) => post(h, real.MAILBOX_PROOF_CONSUME_PATH, { attemptId, token }, who, extra)

/** The attempt id and token of a proof email's link (fragment only). */
function linkOf(message: MailMessage | undefined) {
  const match =
    /https?:\/\/\S+\/app\/mailbox-proof#attempt=([0-9a-f-]+)&token=([A-Za-z0-9_-]+)/.exec(
      message?.text ?? '',
    )
  expect(match, 'a proof link').not.toBeNull()
  return { attemptId: match?.[1] as string, token: match?.[2] as string }
}

type Kind = 'sign_in' | 'test' | 'link' | 'fresh_proof'

/** A seeded attempt that awaits a mailbox proof, bound to `who`'s browser. */
async function attempt(
  kind: Kind,
  who: Browser,
  overrides: Row = {},
): Promise<Row & { id: string; mailbox: string }> {
  const base =
    kind === 'sign_in'
      ? signInValues(f)
      : kind === 'test'
        ? testValues(f)
        : kind === 'link'
          ? linkAttemptValues(f)
          : freshProofValues(f)
  return (await insert(client, 'sso_attempts', {
    ...base,
    requires_mailbox: true,
    mailbox: mailboxOf(kind),
    browser_binding_digest: real.sha256(who.binding),
    ...overrides,
  })) as Row & { id: string; mailbox: string }
}

/** The session a kind's fixture attempt is bound to (none for a sign-in). */
const sessionOf = (kind: Kind) =>
  kind === 'sign_in'
    ? undefined
    : kind === 'link'
      ? f.sessions[f.member]
      : (f.sessions[f.owner] as string)

async function row(table: string, where: string, params: unknown[]) {
  return (await client.query(`SELECT * FROM ${table} WHERE ${where}`, params)).rows[0] as
    | Row
    | undefined
}
const tokenOf = (attemptId: string) => row('sso_mailbox_tokens', 'attempt_id=$1', [attemptId])
const attemptRow = (attemptId: string) => row('sso_attempts', 'id=$1', [attemptId])
async function text(sql: string, params: unknown[]) {
  return (await client.query<{ v: string }>(sql, params)).rows[0]?.v as string
}

/** Sends and delivers one proof for the attempt, and returns its emailed token. */
async function proofToken(h: Harness, a: { id: string }, who: Browser) {
  const before = h.sent.length
  expect((await send(h, a.id, who)).status).toBe(202)
  await h.deliver()
  expect(h.errors).toEqual([])
  expect(h.sent.length).toBe(before + 1)
  const link = linkOf(h.sent.at(-1))
  expect(link.attemptId).toBe(a.id)
  return link.token
}

async function expectProven(h: Harness, a: { id: string }, token: string, who: Browser) {
  const response = await consume(h, a.id, token, who)
  expect(await response.json()).toEqual({ status: 'proven' })
  expect(response.status).toBe(200)
}
async function expectDenied(h: Harness, a: { id: unknown }, token: unknown, who?: Browser) {
  const response = await consume(h, a.id, token, who)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'sso_mailbox_proof_invalid' })
}

// ---------------------------------------------------------------------------------------
// Scenarios. Each takes the module so that a source copy with one protection broken runs the
// very same assertions (see "Source-copy mutations" at the end).

const scenarios = {
  /** Off: both endpoints 404 sso_disabled before Origin, input, rate limit or any effect. */
  async offEndpoints(M: Module) {
    const refusing = createDb(createPool('postgres://mailbox-proof@127.0.0.1:9/off'))
    try {
      const h = harness(M, {
        capabilities: OFF,
        database: refusing,
        limits: { sendsPerSourcePerMinute: 1, consumesPerSourcePerMinute: 1 },
      })
      for (const path of [real.MAILBOX_PROOF_SEND_PATH, real.MAILBOX_PROOF_CONSUME_PATH])
        for (const method of ['POST', 'GET'])
          for (const headers of [{}, headersFor(browser(f.sessions[f.owner]))])
            for (const attemptId of [f.provider.id, '0190f2c4-0000-7000-8000-000000000001', 'x'])
              for (let repeat = 0; repeat < 2; repeat++) {
                const response = await h.app.request(path, {
                  method,
                  headers,
                  ...(method === 'POST' ? { body: JSON.stringify({ attemptId, token: 't' }) } : {}),
                })
                expect(response.status).toBe(404)
                expect(await response.json()).toEqual({ error: 'sso_disabled' })
              }
      expect(h.queued).toEqual([])
    } finally {
      await refusing.destroy()
    }
  },

  /** Off: a queued delivery is dropped, with no token and no mail. */
  async offDelivery(M: Module) {
    const who = browser()
    const a = await attempt('sign_in', who)
    const h = harness(M, { capabilities: OFF })
    await M.deliverMailboxProof(
      {
        capabilities: OFF,
        db,
        mailer: { send: async (m) => void h.sent.push(m) },
        publicUrl: PUBLIC_URL,
        secret: SECRET,
      },
      real.MailboxProofEmailPayload.parse({
        attemptId: a.id,
        binding: real.sha256(who.binding),
        sessionId: null,
        userId: null,
        language: 'en',
      }),
    )
    expect(h.sent).toEqual([])
    expect(await tokenOf(a.id)).toBeUndefined()
  },

  /** Exact Origin and no Authorization header, before any queueing or lookup. */
  async origin(M: Module) {
    const who = browser()
    const a = await attempt('sign_in', who)
    const h = harness(M)
    const extras: Record<string, string>[] = [
      { origin: '' },
      { origin: 'null' },
      { origin: 'https://attacker.example' },
      { origin: `${ORIGIN}/` },
      { origin: 'http://localhost:4322' },
      { authorization: 'Bearer hm_synthetic' },
    ]
    for (const extra of extras) {
      for (const response of [
        await send(h, a.id, who, extra),
        await consume(h, a.id, 'token', who, extra),
      ]) {
        expect(response.status, JSON.stringify(extra)).toBe(403)
        expect(await response.json()).toEqual({ error: 'forbidden' })
      }
    }
    // A Referer from the right origin is no Origin.
    const refererOnly = await h.app.request(real.MAILBOX_PROOF_SEND_PATH, {
      method: 'POST',
      headers: { referer: `${ORIGIN}/app`, 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: a.id }),
    })
    expect(refererOnly.status).toBe(403)
    expect(h.queued).toEqual([])
  },

  /** The browser binding: another browser can neither get mail nor prove the attempt. */
  async binding(M: Module) {
    const who = browser()
    const a = await attempt('sign_in', who)
    const h = harness(M)
    for (const stranger of [browser(), undefined, { binding: `${who.binding}x` }]) {
      expect((await send(h, a.id, stranger)).status).toBe(202)
    }
    await h.deliver()
    expect(h.sent).toEqual([])
    const token = await proofToken(h, a, who)
    for (const stranger of [browser(), undefined]) await expectDenied(h, a, token, stranger)
    expect((await attemptRow(a.id))?.mailbox_proven_at).toBeNull()
    await expectProven(h, a, token, who)
  },

  /** Session-bound intents need their own session and person; a sign-in needs no session. */
  async session(M: Module) {
    const h = harness(M)
    // Missing-session enrollment: a sign-in attempt with only the pre-session browser cookie.
    const anonymous = browser()
    const signIn = await attempt('sign_in', anonymous)
    await expectProven(h, signIn, await proofToken(h, signIn, anonymous), anonymous)
    // The member's link attempt: the member's browser without the session, or with the owner's.
    const binding = randomBytes(32).toString('base64url')
    const member = { binding, session: f.sessions[f.member] }
    const link = await attempt('link', member)
    // The member's other session is not the attempt's session.
    const otherSession = await session(client, f.member)
    users.set(otherSession, f.member)
    const others = [
      { binding },
      { binding, session: f.sessions[f.owner] },
      { binding, session: otherSession },
    ]
    for (const wrong of others) {
      expect((await send(h, link.id, wrong)).status).toBe(202)
      await h.deliver()
    }
    expect(h.sent.filter(({ to }) => to === link.mailbox)).toEqual([])
    const token = await proofToken(h, link, member)
    for (const wrong of others) await expectDenied(h, link, token, wrong)
    await expectProven(h, link, token, member)

    // Keep the presenter authenticated in the fake resolver: the stored session expiry
    // must independently refuse this attempt while its token and attempt remain live.
    const expiringSession = await session(client, f.member, at(120))
    users.set(expiringSession, f.member)
    const expiringBrowser = browser(expiringSession)
    const expiring = await attempt('link', expiringBrowser, { session_id: expiringSession })
    const expiredSessionToken = await proofToken(h, expiring, expiringBrowser)
    h.clock.now = await text('SELECT "expiresAt"::text AS v FROM auth.session WHERE id=$1', [
      expiringSession,
    ])
    await expectDenied(h, expiring, expiredSessionToken, expiringBrowser)
    expect((await tokenOf(expiring.id))?.consumed_at).toBeNull()
    expect((await attemptRow(expiring.id))?.mailbox_proven_at).toBeNull()
    expect((await send(h, expiring.id, expiringBrowser)).status).toBe(202)
    await h.deliver()
    expect(h.sent.filter(({ to }) => to === expiring.mailbox)).toHaveLength(1)
  },

  /** Attempt expiry at the exact boundary instant, in delivery and in consumption. */
  async attemptExpiry(M: Module) {
    const h = harness(M)
    const who = browser()
    // 100 seconds left: the token ends with the attempt, not 300 seconds after issuance.
    const a = await attempt('sign_in', who, { expires_at: at(100) })
    const expiresAt = await text('SELECT expires_at::text AS v FROM sso_attempts WHERE id=$1', [
      a.id,
    ])
    h.clock.now = expiresAt
    expect((await send(h, a.id, who)).status).toBe(202)
    await h.deliver()
    expect(h.sent).toEqual([])
    h.clock.now = undefined
    const token = await proofToken(h, a, who)
    expect(
      await text(
        'SELECT (t.expires_at = a.expires_at)::text AS v FROM sso_mailbox_tokens t JOIN sso_attempts a ON a.id = t.attempt_id WHERE a.id=$1',
        [a.id],
      ),
    ).toBe('true')
    h.clock.now = expiresAt
    await expectDenied(h, a, token, who)
    h.clock.now = await text("SELECT ($1::timestamptz - interval '1 microsecond')::text AS v", [
      expiresAt,
    ])
    await expectProven(h, a, token, who)
    expect(
      await text('SELECT mailbox_proof_expires_at::text AS v FROM sso_attempts WHERE id=$1', [
        a.id,
      ]),
    ).toBe(expiresAt)
    // The attempt's own expiry is checked, not only its token's: a token seeded to outlive the
    // attempt (which issuance never does) is still refused at the attempt's expiry instant.
    const b = await attempt('sign_in', who, { expires_at: at(100) })
    const outliving = randomBytes(32).toString('base64url')
    await seed('sso_mailbox_tokens', {
      token_digest: real.sha256(outliving),
      organization_id: b.organization_id,
      attempt_id: b.id,
      issued_at: at(-10),
      expires_at: at(250),
    })
    h.clock.now = await text('SELECT expires_at::text AS v FROM sso_attempts WHERE id=$1', [b.id])
    await expectDenied(h, b, outliving, who)
    h.clock.now = undefined
  },

  /** Token expiry (issuance plus freshAdministrationProof) at the exact boundary instant. */
  async tokenExpiry(M: Module) {
    const h = harness(M)
    const who = browser(f.sessions[f.owner])
    const a = await attempt('fresh_proof', who)
    const token = await proofToken(h, a, who)
    const t = await tokenOf(a.id)
    expect(
      await text(
        "SELECT (expires_at = issued_at + interval '300 seconds')::text AS v FROM sso_mailbox_tokens WHERE attempt_id=$1",
        [a.id],
      ),
    ).toBe('true')
    const expiresAt = await text(
      'SELECT expires_at::text AS v FROM sso_mailbox_tokens WHERE attempt_id=$1',
      [a.id],
    )
    h.clock.now = expiresAt
    await expectDenied(h, a, token, who)
    expect((await tokenOf(a.id))?.consumed_at).toBeNull()
    h.clock.now = await text("SELECT ($1::timestamptz - interval '1 microsecond')::text AS v", [
      expiresAt,
    ])
    await expectProven(h, a, token, who)
    expect((await tokenOf(a.id))?.token_digest).toBe(t?.token_digest)
  },

  /** Only the digest is stored; resend rotates the token; the old one stops working. */
  async rotation(M: Module) {
    const h = harness(M, { limits: { resendCooldownSeconds: 0 } })
    const who = browser(f.sessions[f.owner])
    const a = await attempt('test', who)
    const first = await proofToken(h, a, who)
    const firstRow = await tokenOf(a.id)
    expect(firstRow?.token_digest).toBe(real.sha256(first))
    expect(JSON.stringify(firstRow)).not.toContain(first)
    expect(JSON.stringify(await attemptRow(a.id))).not.toContain(first)
    // The job carries no token, mailbox or cookie value.
    expect((await send(h, a.id, who)).status).toBe(202)
    expect(Object.keys(h.queued[0]?.payload ?? {}).sort()).toEqual([
      'attemptId',
      'binding',
      'language',
      'sessionId',
      'userId',
    ])
    expect(JSON.stringify(h.queued)).not.toContain(who.binding)
    expect(JSON.stringify(h.queued)).not.toContain(a.mailbox)
    await h.deliver()
    const second = linkOf(h.sent.at(-1)).token
    expect(second).not.toBe(first)
    expect(
      (
        await client.query('SELECT token_digest FROM sso_mailbox_tokens WHERE attempt_id=$1', [
          a.id,
        ])
      ).rows,
    ).toEqual([{ token_digest: real.sha256(second) }])
    await expectDenied(h, a, first, who)
    await expectProven(h, a, second, who)
  },

  /** Within the cooldown a resend issues nothing, and the current token stays. */
  async cooldown(M: Module) {
    const h = harness(M)
    const who = browser()
    const a = await attempt('sign_in', who)
    const token = await proofToken(h, a, who)
    expect((await send(h, a.id, who)).status).toBe(202)
    await h.deliver()
    expect(h.sent.filter(({ to }) => to === a.mailbox)).toHaveLength(1)
    expect((await tokenOf(a.id))?.token_digest).toBe(real.sha256(token))
  },

  /** A wrong token, a replayed one, and the guess cap. */
  async tokens(M: Module) {
    const h = harness(M)
    const who = browser()
    const a = await attempt('sign_in', who)
    const token = await proofToken(h, a, who)
    for (const wrong of [`${token.slice(0, -1)}A`, 'x', token.toUpperCase()])
      await expectDenied(h, a, wrong === token ? 'y' : wrong, who)
    await expectProven(h, a, token, who)
    // Replay of a consumed token, on the proven attempt.
    await expectDenied(h, a, token, who)
    expect((await send(h, a.id, who)).status).toBe(202)
    await h.deliver()
    expect(h.sent.filter(({ to }) => to === a.mailbox)).toHaveLength(1)
  },

  async guessCap(M: Module) {
    const h = harness(M)
    const who = browser()
    const a = await attempt('sign_in', who)
    const token = await proofToken(h, a, who)
    // Another browser's guesses are refused before the token is compared and count nothing.
    for (let i = 0; i < 8; i++) await expectDenied(h, a, `wrong-${i}`, browser())
    for (let i = 0; i < 4; i++) await expectDenied(h, a, `wrong-${i}`, who)
    expect(await tokenOf(a.id)).toBeDefined()
    await expectDenied(h, a, 'wrong-5', who)
    expect(await tokenOf(a.id)).toBeUndefined()
    await expectDenied(h, a, token, who)
    expect((await attemptRow(a.id))?.mailbox_proven_at).toBeNull()
  },

  /** A token proves only its own attempt: other mailbox, intent, team or account. */
  async attemptBound(M: Module) {
    const h = harness(M)
    const binding = randomBytes(32).toString('base64url')
    const owner = { binding, session: f.sessions[f.owner] }
    // Same browser and person, two intents and two mailboxes.
    const fresh = await attempt('fresh_proof', owner)
    const test = await attempt('test', owner)
    // Same browser, the other team's sign-in.
    const other = await attempt('sign_in', owner, {
      ...signInValues(f, f.otherProvider),
      requires_mailbox: true,
      mailbox: mailboxOf('other'),
      browser_binding_digest: real.sha256(binding),
    })
    const freshToken = await proofToken(h, fresh, owner)
    const testToken = await proofToken(h, test, owner)
    await expectDenied(h, test, freshToken, owner)
    await expectDenied(h, fresh, testToken, owner)
    await expectDenied(h, other, freshToken, owner)
    // Another account: the member's link attempt, with the owner's token and the owner's session.
    const member = { binding, session: f.sessions[f.member] }
    const link = await attempt('link', member)
    await expectDenied(h, link, freshToken, member)
    await expectDenied(h, link, freshToken, owner)
    for (const id of [test.id, other.id, link.id])
      expect((await attemptRow(id))?.mailbox_proven_at).toBeNull()
    await expectProven(h, fresh, freshToken, owner)
    await expectProven(h, test, testToken, owner)
    expect((await attemptRow(other.id))?.mailbox_proven_at).toBeNull()
  },

  /** A provider that is no longer what the attempt relied on ends delivery and consumption. */
  async providerCurrent(M: Module) {
    for (const state of ['revision', 'disabled', 'retired'] as const) {
      // No cooldown can mask an eligibility regression in the second delivery.
      const h = harness(M, { limits: { resendCooldownSeconds: 0 } })
      const provider = await insert(client, 'sso_providers', {
        ...oidcProviderValues(f.team),
        enabled: true,
      })
      // A retired test provider isolates retirement from the enabled check for sign-in/link.
      const kind = state === 'retired' ? 'test' : 'sign_in'
      const who = browser(sessionOf(kind))
      const a = await attempt(kind, who, {
        provider_id: provider.id,
        provider_revision: provider.revision,
      })
      const token = await proofToken(h, a, who)
      if (state === 'revision')
        await client.query(
          'UPDATE sso_providers SET revision = revision + 1, configuration = $2 WHERE id=$1',
          [provider.id, sealed()],
        )
      else
        await client.query(
          state === 'disabled'
            ? 'UPDATE sso_providers SET enabled = false WHERE id=$1'
            : 'UPDATE sso_providers SET enabled = false, retired_at = now() WHERE id=$1',
          [provider.id],
        )
      await expectDenied(h, a, token, who)
      expect((await tokenOf(a.id))?.consumed_at).toBeNull()
      expect((await attemptRow(a.id))?.mailbox_proven_at).toBeNull()
      expect((await send(h, a.id, who)).status).toBe(202)
      await h.deliver()
      expect(h.sent.filter(({ to }) => to === a.mailbox)).toHaveLength(1)
    }
  },

  /** Consume reads its instant only after the row locks it waits for. */
  async lockThenClock(M: Module) {
    const h = harness(M)
    const who = browser()
    const a = await attempt('sign_in', who)
    const token = await proofToken(h, a, who)
    const blocker = await owned.pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT 1 FROM sso_attempts WHERE id=$1 FOR UPDATE', [a.id])
      const pending = consume(h, a.id, token, who)
      await new Promise((resolve) => setTimeout(resolve, 300))
      const released = (await blocker.query<{ v: string }>('SELECT clock_timestamp()::text AS v'))
        .rows[0]?.v
      await blocker.query('COMMIT')
      expect((await pending).status).toBe(200)
      expect(
        await text(
          'SELECT (mailbox_proven_at >= $2::timestamptz)::text AS v FROM sso_attempts WHERE id=$1',
          [a.id, released],
        ),
      ).toBe('true')
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
  },

  /** Two concurrent consumes of one token: exactly one proof. */
  async consumeRace(M: Module) {
    const h = harness(M)
    const who = browser(f.sessions[f.owner])
    const a = await attempt('fresh_proof', who)
    const token = await proofToken(h, a, who)
    const responses = await Promise.all([
      consume(h, a.id, token, who),
      consume(h, a.id, token, who),
      consume(h, a.id, token, who),
    ])
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 400, 400])
  },

  /** Two proofs of the same mailbox at once stay two proofs, each of its own attempt. */
  async sameMailbox(M: Module) {
    const h = harness(M)
    const mailbox = mailboxOf('shared')
    const first = browser()
    const second = browser()
    const a = await attempt('sign_in', first, { mailbox })
    const b = await attempt('sign_in', second, { mailbox })
    const sends = await Promise.all([send(h, a.id, first), send(h, b.id, second)])
    expect(sends.map(({ status }) => status)).toEqual([202, 202])
    const jobs = h.queued.splice(0)
    const parallel = harness(M)
    parallel.queued.push(jobs[0] as Harness['queued'][number])
    h.queued.push(jobs[1] as Harness['queued'][number])
    await Promise.all([parallel.deliver(), h.deliver()])
    const tokens = new Map(
      [...parallel.sent, ...h.sent].map((m) => [linkOf(m).attemptId, linkOf(m).token]),
    )
    expect(tokens.size).toBe(2)
    await expectDenied(h, a, tokens.get(b.id), first)
    await expectDenied(h, b, tokens.get(a.id), second)
    const consumes = await Promise.all([
      consume(h, a.id, tokens.get(a.id), first),
      consume(h, b.id, tokens.get(b.id), second),
    ])
    expect(consumes.map(({ status }) => status)).toEqual([200, 200])
  },

  /** Per-source limits on both endpoints. */
  async sourceLimits(M: Module) {
    const h = harness(M, { limits: { sendsPerSourcePerMinute: 2, consumesPerSourcePerMinute: 2 } })
    const who = browser()
    const a = await attempt('sign_in', who)
    expect((await send(h, a.id, who)).status).toBe(202)
    expect((await send(h, a.id, who)).status).toBe(202)
    const limited = await send(h, a.id, who)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/)
    expect(await limited.json()).toEqual({ error: 'rate_limited' })
    expect(h.queued).toHaveLength(2)
    await expectDenied(h, a, 'x', who)
    await expectDenied(h, a, 'y', who)
    expect((await consume(h, a.id, 'z', who)).status).toBe(429)
  },

  /** The recipient budget per address digest, in the shared mail ledger. */
  async mailBudget(M: Module) {
    const h = harness(M, { delivery: { signInMailMaxPerHour: 2 } })
    const mailbox = mailboxOf('budget')
    const sent: Row[] = []
    for (let i = 0; i < 3; i++) {
      const who = browser()
      const a = await attempt('sign_in', who, { mailbox })
      expect((await send(h, a.id, who)).status).toBe(202)
      await h.deliver()
      sent.push((await tokenOf(a.id)) ?? {})
    }
    expect(h.sent.filter(({ to }) => to === mailbox)).toHaveLength(2)
    expect(sent.map((t) => typeof t.token_digest)).toEqual(['string', 'string', 'undefined'])
    expect(h.logs.map((line) => JSON.parse(line).reason)).toEqual(['recipient_hourly_limit'])
    expect(h.logs.join('\n')).not.toContain(mailbox)
    const hash = mailboxProofRecipientHash(mailbox, SECRET)
    expect(
      Number(
        (
          await client.query(
            'SELECT count(*) AS n FROM notification_email_sends WHERE recipient_hash=$1',
            [hash],
          )
        ).rows[0]?.n,
      ),
    ).toBe(2)
  },

  /** The bounded cleanup: expired and consumed attempts with their tokens, sign-ins included. */
  async cleanup(M: Module) {
    const doomed: string[] = []
    const liveIds: string[] = []
    for (const kind of ['sign_in', 'test', 'link', 'fresh_proof'] as const) {
      const who = browser(sessionOf(kind))
      const live = await attempt(kind, who)
      const expired = await seed('sso_attempts', {
        ...(await attemptRowValues(kind, who)),
        created_at: at(-650),
        expires_at: at(-100),
      })
      await seed('sso_mailbox_tokens', {
        token_digest: digest(),
        organization_id: expired.organization_id,
        attempt_id: expired.id,
        // Two clock reads: stay a second inside the 300-second lifetime the table allows.
        issued_at: at(-399),
        expires_at: at(-100),
      })
      const consumed = await seed('sso_attempts', {
        ...(await attemptRowValues(kind, who)),
        consumed_at: at(-1),
      })
      doomed.push(expired.id as string, consumed.id as string)
      liveIds.push(live.id)
    }
    expect(await M.cleanupSsoAttempts(db, 3)).toBe(3)
    let rounds = 0
    while ((await M.cleanupSsoAttempts(db, 3)) > 0) rounds++
    expect(rounds).toBeGreaterThan(0)
    const left = await client.query<{ id: string }>(
      'SELECT id FROM sso_attempts WHERE id = ANY($1::uuid[])',
      [doomed],
    )
    expect(left.rows).toEqual([])
    const tokens = await client.query(
      'SELECT 1 FROM sso_mailbox_tokens WHERE attempt_id = ANY($1::uuid[])',
      [doomed],
    )
    expect(tokens.rows).toEqual([])
    const kept = await client.query<{ n: string }>(
      'SELECT count(*) AS n FROM sso_attempts WHERE id = ANY($1::uuid[])',
      [liveIds],
    )
    expect(Number(kept.rows[0]?.n)).toBe(liveIds.length)
  },
}

/** Values of an attempt of `kind` for direct seeding (expired or consumed state). */
async function attemptRowValues(kind: Kind, who: Browser): Promise<Row> {
  const base =
    kind === 'sign_in'
      ? signInValues(f)
      : kind === 'test'
        ? testValues(f)
        : kind === 'link'
          ? linkAttemptValues(f)
          : freshProofValues(f)
  return {
    ...base,
    requires_mailbox: true,
    mailbox: mailboxOf(`seeded-${kind}`),
    browser_binding_digest: real.sha256(who.binding),
  }
}

describe.skipIf(!databaseUrl)('SSO mailbox proof', () => {
  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'sso_mailbox' })
    db = createDb(owned.pool)
    client = await owned.pool.connect()
    f = await identityFixture(client)
    for (const [user, session] of Object.entries(f.sessions)) users.set(session, user)
    nativeCreateApp = (await sourceCopy<typeof import('./app.ts')>('./app.ts')).createApp
  }, 60_000)

  afterAll(async () => {
    client?.release()
    await owned?.drop()
  })

  it.each(['sign_in', 'test', 'link', 'fresh_proof'] as const)(
    'proves the mailbox of a seeded %s attempt through send and consume',
    async (kind) => {
      const h = harness()
      const who = browser(sessionOf(kind))
      const a = await attempt(kind, who)
      const response = await send(h, a.id, who)
      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ status: 'queued' })
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(h.sent).toEqual([])
      await h.deliver()
      expect(h.sent.map(({ to }) => to)).toEqual([a.mailbox])
      const { token } = linkOf(h.sent[0])
      expect(h.sent[0]?.text).toContain(`${PUBLIC_URL}/app/mailbox-proof#attempt=${a.id}&token=`)
      await expectProven(h, a, token, who)
      const proven = await attemptRow(a.id)
      expect(proven?.mailbox_proven_at).not.toBeNull()
      const proofExpiry = proven?.mailbox_proof_expires_at as Date
      const tokenExpiry = (await tokenOf(a.id))?.expires_at as Date
      expect(proofExpiry.getTime()).toBe(tokenExpiry.getTime())
      // A proof creates no session and consumes no attempt.
      expect(proven?.consumed_at).toBeNull()
    },
  )

  it('answers every send the same, whether or not delivery is eligible', async () => {
    const h = harness()
    const who = browser()
    const eligible = await attempt('sign_in', who)
    const consumed = await seed('sso_attempts', {
      ...(await attemptRowValues('sign_in', who)),
      consumed_at: at(-1),
    })
    const expired = await seed('sso_attempts', {
      ...(await attemptRowValues('sign_in', who)),
      created_at: at(-500),
      expires_at: at(-1),
    })
    const noMailbox = await insert(client, 'sso_attempts', {
      ...signInValues(f),
      browser_binding_digest: real.sha256(who.binding),
    })
    const answers: string[] = []
    for (const [id, presenter] of [
      [eligible.id, who],
      [consumed.id, who],
      [expired.id, who],
      [noMailbox.id, who],
      ['0190f2c4-0000-7000-8000-000000000001', who],
      [eligible.id, browser()],
      [eligible.id, browser(f.sessions[f.owner])],
    ] as const) {
      const response = await send(h, id, presenter)
      answers.push(
        JSON.stringify({
          status: response.status,
          body: await response.text(),
          type: response.headers.get('content-type'),
          cache: response.headers.get('cache-control'),
          cookie: response.headers.get('set-cookie'),
        }),
      )
    }
    expect(new Set(answers).size).toBe(1)
    expect(h.queued).toHaveLength(7)
    await h.deliver()
    expect(h.sent.map(({ to }) => to)).toEqual([eligible.mailbox])
  })

  it('sends the same message whether or not the address has a Hourmere account', async () => {
    const h = harness()
    const accountEmail = (
      await client.query<{ email: string }>('SELECT email FROM auth."user" WHERE id=$1', [f.member])
    ).rows[0]?.email as string
    const messages: MailMessage[] = []
    for (const mailbox of [accountEmail, mailboxOf('no-account')]) {
      const who = browser()
      const a = await attempt('sign_in', who, { mailbox: mailbox.toLowerCase() })
      await proofToken(h, a, who)
      const message = h.sent.at(-1) as MailMessage
      const { token } = linkOf(message)
      const normal = (value: string | undefined) =>
        (value ?? '').replaceAll(a.id, 'ATTEMPT').replaceAll(token, 'TOKEN')
      messages.push({
        ...message,
        to: 'RECIPIENT',
        text: normal(message.text),
        html: normal(message.html),
      })
    }
    expect(messages[0]).toEqual(messages[1])
  })

  it('accepts only the strict inputs and never a caller-chosen mailbox', async () => {
    const h = harness()
    const who = browser()
    const a = await attempt('sign_in', who)
    for (const body of [
      { attemptId: a.id, mailbox: 'attacker@example.test' },
      { attemptId: 'not-a-uuid' },
      {},
      [a.id],
    ]) {
      const response = await post(h, real.MAILBOX_PROOF_SEND_PATH, body, who)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_request' })
    }
    const malformed = await h.app.request(real.MAILBOX_PROOF_SEND_PATH, {
      method: 'POST',
      headers: headersFor(who),
      body: '{',
    })
    expect(malformed.status).toBe(400)
    const wrongMethod = await h.app.request(real.MAILBOX_PROOF_CONSUME_PATH, {
      headers: headersFor(who),
    })
    expect(wrongMethod.status).toBe(405)
    expect(h.queued).toEqual([])
    await proofToken(h, a, who)
    expect(h.sent.map(({ to }) => to)).toEqual([a.mailbox])
  })

  for (const [name, scenario] of Object.entries(scenarios))
    it(`holds: ${name}`, async () => {
      await scenario(real)
    })

  it('refuses an unknown attempt and consumes nothing on any refusal', async () => {
    const h = harness()
    const who = browser()
    await expectDenied(h, { id: '0190f2c4-0000-7000-8000-000000000001' }, 'x', who)
    const a = await attempt('sign_in', who)
    await expectDenied(h, a, 'x', who)
    expect(await tokenOf(a.id)).toBeUndefined()
  })

  it('keeps mailbox proof reachable in the production composition while the setting is off', async () => {
    const control = await sourceCopy<typeof server>('./server.ts')
    await expectProductionAvailable(control)
    // Without the operator setting marker the composition would be hard-off again.
    const mutant = await sourceCopy<typeof server>('./server.ts', [
      'ssoOperatorSetting: true }',
      'ssoOperatorSetting: false }',
    ])
    await expect(expectProductionAvailable(mutant)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  describe('source-copy mutations: each protection fails a real assertion when broken', () => {
    const mutations: [keyof typeof scenarios, string, [string, string]][] = [
      [
        'offEndpoints',
        'endpoint guard',
        [
          "requireSsoRetained(deps.capabilities)\n        c.header('Cache-Control', 'no-store')",
          "c.header('Cache-Control', 'no-store')",
        ],
      ],
      [
        'offDelivery',
        'delivery guard',
        ['    requireSsoRetained(deps.capabilities)\n  } catch {', '  } catch {'],
      ],
      ['origin', 'exact Origin', ["c.req.header('origin') !== origin ||", 'false ||']],
      [
        'origin',
        'Authorization refusal',
        ["|| c.req.header('authorization') !== undefined", '|| false'],
      ],
      [
        'binding',
        'browser binding',
        ['if (!sameDigest(attempt.browser_binding_digest, presenter.binding)) return false', ''],
      ],
      ['session', 'session binding', ['presenter.sessionId === attempt.session_id &&', 'true &&']],
      [
        'session',
        'session expiry',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation anchor.
        ['AND s."expiresAt" > ${now}::timestamptz', ''],
      ],
      [
        'attemptExpiry',
        'attempt expiry is exclusive',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation anchor.
        ['(a.expires_at > ${now}::timestamptz', '(a.expires_at >= ${now}::timestamptz'],
      ],
      [
        'tokenExpiry',
        'token expiry is exclusive',
        [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation anchor.
          '(consumed_at IS NULL AND expires_at > ${now}::timestamptz)',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation anchor.
          '(consumed_at IS NULL AND expires_at >= ${now}::timestamptz)',
        ],
      ],
      [
        'attemptExpiry',
        'token ends with its attempt',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation anchor.
        ['least(a.expires_at, ${at}::timestamptz', 'greatest(a.expires_at, ${at}::timestamptz'],
      ],
      [
        'tokens',
        'token digest comparison',
        ['if (!sameDigest(token.token_digest, sha256(input.token))) {', 'if (false) {'],
      ],
      ['guessCap', 'guess cap', ['if (deps.guesses.hit(attempt.id) !== undefined)', 'if (false)']],
      ['cooldown', 'resend cooldown', ['if (cooling[0]?.cooling) return', '']],
      [
        'lockThenClock',
        'consume locks before reading its instant',
        [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation anchor.
          'await sql`SELECT 1 FROM sso_attempts WHERE id = ${input.attemptId}::uuid FOR UPDATE`.execute(',
          'void ((unlocked: unknown) => unlocked)(',
        ],
      ],
      [
        'rotation',
        'rotation deletes the previous token',
        [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation anchor.
          'await sql`DELETE FROM sso_mailbox_tokens WHERE attempt_id = ${recheck.id}::uuid`.execute(trx)',
          '',
        ],
      ],
      ['providerCurrent', 'provider revision', ['AND p.revision = a.provider_revision', '']],
      ['providerCurrent', 'provider retirement', ['AND p.retired_at IS NULL', '']],
      [
        'providerCurrent',
        'provider enabled for sign-in',
        ["AND (p.enabled OR a.kind NOT IN ('sign_in', 'link'))", ''],
      ],
      ['mailBudget', 'recipient budget', ['      if (reason)\n', '      if (false)\n']],
      [
        'sourceLimits',
        'per-source limit',
        ['const wait = limiter.hit(rateLimitKey(c.var.clientIp))', 'const wait = undefined'],
      ],
      [
        'cleanup',
        'cleanup deletes consumed attempts',
        ['OR (consumed_at IS NOT NULL AND (', 'OR (false AND ('],
      ],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation anchor.
      ['cleanup', 'cleanup is bounded', ['        LIMIT ${limit}\n', '\n']],
      [
        'attemptBound',
        'token is the attempt’s own',
        [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation anchor.
          'FROM sso_mailbox_tokens WHERE attempt_id = ${attempt.id}::uuid FOR UPDATE`.execute(trx)\n    const token',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation anchor.
          'FROM sso_mailbox_tokens WHERE token_digest = ${sha256(input.token)} FOR UPDATE`.execute(trx)\n    const token',
        ],
      ],
    ]

    it('runs every scenario against an unchanged source copy', async () => {
      const control = await sourceCopy<Module>('./sso-mailbox-proof.ts')
      for (const name of new Set(mutations.map(([scenario]) => scenario)))
        await scenarios[name](control)
    })

    it.each(mutations)('%s fails without its %s', async (name, _label, mutation) => {
      const mutant = await sourceCopy<Module>('./sso-mailbox-proof.ts', mutation)
      await expect(scenarios[name](mutant)).rejects.toMatchObject({ name: 'AssertionError' })
    })
  })
})

/** The app startServer assembles answers 404 sso_disabled on both endpoints, before anything. */
async function expectProductionAvailable(module: typeof server) {
  const refusing = createDb(createPool('postgres://mailbox-proof@127.0.0.1:9/production'))
  const unavailable = async (): Promise<never> => {
    throw new Error('unavailable')
  }
  try {
    const { loadConfig } = await import('./config.ts')
    const config = loadConfig({
      DATABASE_URL: 'postgres://mailbox-proof@127.0.0.1:9/production',
      BETTER_AUTH_SECRET: SECRET,
      PUBLIC_URL: PUBLIC_URL,
      // Unset, empty and false are the same setting-off state; SAML is not a setting.
      SSO_OIDC_ENABLED: '',
      SSO_SAML_ENABLED: 'true',
    })
    const app = nativeCreateApp(
      module.productionAppOptions({
        config,
        db: refusing,
        auth: { handler: unavailable },
        resolveCaller: unavailable,
        resolveMcpOAuth: unavailable,
        checkDb: unavailable,
        waitlist: { verify: unavailable, remove: unavailable },
        invitationMailLimits: { secret: 'mailbox-proof-test-only' },
        webhookSettings: { enabled: false },
        webhookQueue: { enqueue: unavailable },
        notify: unavailable,
        notifyAttendeeNoShow: unavailable,
        googleCalendar: undefined,
        microsoftCalendar: undefined,
        zoomConference: undefined,
        enqueueCalendarSync: unavailable,
        enqueueCalendarWritebackRecovery: unavailable,
        mailboxProofQueue: { enqueue: unavailable },
      }),
    )
    for (const path of [real.MAILBOX_PROOF_SEND_PATH, real.MAILBOX_PROOF_CONSUME_PATH])
      for (const [headers, status, error] of [
        // The endpoint's own checks answer: exact Origin first, then the input.
        [{}, 403, 'forbidden'],
        [{ origin: PUBLIC_URL, 'content-type': 'application/json' }, 400, 'invalid_request'],
      ] as const) {
        const response = await app.request(path, {
          method: 'POST',
          headers,
          body: JSON.stringify({ attemptId: 'not-an-attempt', token: 't' }),
        })
        expect(response.status).toBe(status)
        expect(await response.json()).toEqual({ error })
      }
  } finally {
    await refusing.destroy()
  }
}
