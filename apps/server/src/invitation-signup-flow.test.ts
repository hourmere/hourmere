import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { createAuth, createAuthPool, createCallerResolver, type SignupPolicy } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs, type Jobs } from '@hourmere/jobs'
import { createSmtpMailer } from '@hourmere/mail'
import {
  createInvitationEmailDispatcher,
  INVITATION_EMAIL_JOB,
  invitationEmailJob,
} from '@hourmere/notifications'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fakeSmtpServer } from '../../../packages/mail/src/smtp-testing.ts'
import {
  queuedSignInEmail,
  SIGN_IN_EMAIL_JOB,
  signInEmailJobs,
} from '../../../packages/notifications/src/sign-in.ts'
import { createApp } from './app.ts'
import { pressConfirmButton } from './sign-in-confirm-testing.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4387'
const secret = randomBytes(32).toString('base64')
const policies: SignupPolicy[] = [
  { mode: 'closed', allowedDomains: ['trusted.example'] },
  { mode: 'first-user', allowedDomains: ['trusted.example'] },
]
const recipient = 'recipient@outside.example'
const states = ['expired', 'canceled', 'accepted'] as const
type State = (typeof states)[number]
type Definitions = readonly [
  ReturnType<typeof invitationEmailJob>,
  ...ReturnType<typeof signInEmailJobs>,
]

// Import executable copies without changing tracked source or installed packages.
function moduleUrl(source: string, location: URL, replacements: Record<string, string> = {}) {
  const javascript = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) => {
      let resolved = replacements[specifier]
      if (!resolved) {
        if (specifier.startsWith('.')) resolved = new URL(specifier, location).href
        else {
          try {
            resolved = import.meta.resolve(specifier)
          } catch {
            resolved = pathToFileURL(createRequire(location).resolve(specifier)).href
          }
        }
      }
      return `from '${resolved}'`
    },
  )
  return `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
}

async function signupWorkerCopy(remove?: 'address' | 'pending' | 'expiry' | 'authority') {
  const signupLocation = new URL('../../../packages/auth/src/signup.ts', import.meta.url)
  let source = readFileSync(signupLocation, 'utf8')
  const guards = {
    address: ".where(sql<string>`lower(auth.invitation.email)`, '=', email.toLowerCase())",
    pending: ".where('status', '=', 'pending')",
    expiry: ".where('expiresAt', '>', sql<Date>`clock_timestamp()`)",
    authority: `.where((eb) =>
      eb.or([
        sql<boolean>\`lower(substring(inviter.email FROM '@([^@]*)$')) = ANY (\${policy.allowedDomains}::text[])\`,
        eb(
          'inviter.id',
          '=',
          eb.selectFrom('auth.user').select('id').orderBy('createdAt').orderBy('id').limit(1),
        ),
      ]),
    )`,
  }
  if (remove) {
    expect(source.includes(guards[remove]), 'the mutation matches its signup protection').toBe(true)
    source = source.replace(guards[remove], '')
  }
  const signup = moduleUrl(source, signupLocation)
  const authFacade = `export * from '${import.meta.resolve('@hourmere/auth')}'; export { maySignUp } from '${signup}';`
  const facade = `data:text/javascript;base64,${Buffer.from(authFacade).toString('base64')}`
  const workerLocation = new URL('../../../packages/notifications/src/sign-in.ts', import.meta.url)
  return (
    await import(
      moduleUrl(readFileSync(workerLocation, 'utf8'), workerLocation, { '@hourmere/auth': facade })
    )
  ).signInEmailJobs as typeof signInEmailJobs
}

describe.skipIf(!serverUrl)(
  'invitation signup through durable queues and the SMTP test mailbox',
  () => {
    let owned: TestDatabase
    let db: Db
    const pools = new Map<string, pg.Pool>()
    const jobs: Jobs<Definitions>[] = []
    const smtp = fakeSmtpServer()
    let smtpPort: number

    beforeAll(async () => {
      owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_signup' })
      db = createDb(owned.pool)
      await new Promise<void>((resolve) => smtp.server.listen(0, '127.0.0.1', resolve))
      smtpPort = (smtp.server.address() as AddressInfo).port
    })
    beforeEach(async () => {
      await db.deleteFrom('sign_in_emails').execute()
      await db.deleteFrom('notification_email_sends').execute()
      await db.deleteFrom('auth.verification').execute()
      await db.deleteFrom('auth.organization').execute()
      await db.deleteFrom('auth.user').execute()
      smtp.received.data = undefined
      smtp.received.to.length = 0
    })
    afterEach(async () => {
      await Promise.all(jobs.splice(0).map((queue) => queue.stop()))
    })
    afterAll(async () => {
      try {
        await Promise.all([...pools.values()].map((pool) => pool.end()))
        for (const socket of smtp.sockets) socket.destroy()
        await new Promise<void>((resolve, reject) =>
          smtp.server.close((error) => (error ? reject(error) : resolve())),
        )
      } finally {
        await owned?.drop()
      }
    })

    function authPool(policy: SignupPolicy) {
      const key = JSON.stringify(policy)
      let pool = pools.get(key)
      if (!pool) {
        pool = createAuthPool(owned.url, policy)
        pools.set(key, pool)
      }
      return pool
    }

    async function instance(policy: SignupPolicy, workerFactory = signInEmailJobs) {
      const mailer = createSmtpMailer({
        url: `smtp://127.0.0.1:${smtpPort}`,
        from: 'Hourmere <sender@hourmere.invalid>',
      })
      const definitions: Definitions = [
        invitationEmailJob({ db, secret, mailer, publicUrl: origin, smtpConfigured: true }),
        ...workerFactory({ db, secret, mailer, publicUrl: origin, signup: policy }),
      ]
      const queue = createJobs({
        connectionString: owned.url,
        definitions,
        work: false,
        migrate: true,
        maxConnections: 2,
        log: () => {},
      })
      jobs.push(queue)
      await queue.start()
      const auth = createAuth({
        pool: authPool(policy),
        db,
        secret,
        baseURL: origin,
        signup: policy,
        mailer,
        queueSignInEmail: queuedSignInEmail(queue, { db, secret, publicUrl: origin }),
        enqueueInvitationEmail: createInvitationEmailDispatcher({ db, queue }),
      })
      const app = createApp({
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        publicUrl: origin,
        checkDb: async () => {},
      })
      let worker: Jobs<Definitions> | undefined
      return {
        app,
        async work() {
          if (worker) return
          worker = createJobs({
            connectionString: owned.url,
            definitions,
            work: true,
            migrate: false,
            maxConnections: 2,
            pollingIntervalSeconds: 0.5,
            log: () => {},
          })
          jobs.push(worker)
          await worker.start()
        },
      }
    }
    type Instance = Awaited<ReturnType<typeof instance>>
    const cookie = (response: Response) =>
      response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ')
    const hasSession = (response: Response) =>
      response.headers.getSetCookie().some((value) => value.includes('session_token='))
    const post = (i: Instance, path: string, body: unknown, session = '', team?: string) =>
      i.app.request(`/api/auth/${path}`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          ...(session && { cookie: session }),
          ...(team && { 'x-expected-organization-id': team }),
        },
        body: JSON.stringify(body),
      })

    function mailedLink(path: '/app/join' | '/sign-in/confirm') {
      // Nodemailer wraps quoted-printable body lines; do not expose capabilities in assertions.
      const decoded = (smtp.received.data ?? '')
        .replace(/=\r\n/g, '')
        .replace(/=([\da-f]{2})/gi, (_, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        )
      return decoded.match(new RegExp(`${origin}${path}[^\\s<"]*`))?.[0]
    }
    async function drained(name: string) {
      await expect
        .poll(
          async () => {
            const result = await owned.pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM pgboss.job WHERE name = $1 AND state NOT IN ('completed', 'cancelled', 'failed')",
              [name],
            )
            return result.rows[0]?.count
          },
          { timeout: 10_000, interval: 20 },
        )
        .toBe(0)
    }
    async function requestLink(i: Instance, email: string, invitationId: string) {
      smtp.received.data = undefined
      const response = await post(i, 'sign-in/magic-link', {
        email,
        callbackURL: `/app/join?invitationId=${invitationId}`,
      })
      expect(response.status, 'every address receives the same sign-in request status').toBe(200)
      expect(await response.json(), 'request responses do not disclose account existence').toEqual({
        status: true,
      })
      await i.work()
      await drained(SIGN_IN_EMAIL_JOB)
      const link = mailedLink('/sign-in/confirm')
      return link ? new URL(link) : undefined
    }
    async function prove(i: Instance, link: URL | undefined) {
      expect(Boolean(link), 'the SMTP sink received a usable identity-proof link').toBe(true)
      return i.app.request((await pressConfirmButton(i.app, link as URL)).toString())
    }
    async function signIn(i: Instance, email: string, invitationId: string) {
      const response = await prove(i, await requestLink(i, email, invitationId))
      expect(response.status).toBe(302)
      expect(hasSession(response), 'email proof creates a real signed-in session').toBe(true)
      expect(
        response.headers.get('location') === `${origin}/app/join?invitationId=${invitationId}`,
      ).toBe(true)
      return cookie(response)
    }

    async function seed({ existing = false, role = 'owner', trusted = true } = {}) {
      // The actual instance founder precedes every arbitrary team owner/admin in database order.
      const founder = await db
        .insertInto('auth.user')
        .values({
          name: 'Instance founder',
          email: 'founder@outside.example',
          emailVerified: true,
          createdAt: new Date('2020-01-01T00:00:00Z'),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const inviter = await db
        .insertInto('auth.user')
        .values({
          name: 'Inviting manager',
          email: `manager@${trusted ? 'trusted' : 'outside'}.example`,
          emailVerified: true,
          createdAt: new Date('2021-01-01T00:00:00Z'),
        })
        .returning(['id', 'email'])
        .executeTakeFirstOrThrow()
      expect(founder.id === inviter.id, 'a team owner is not the instance founder').toBe(false)
      const actualFirst = await db
        .selectFrom('auth.user')
        .select('id')
        .orderBy('createdAt')
        .orderBy('id')
        .limit(1)
        .executeTakeFirstOrThrow()
      expect(actualFirst.id, 'the founder is the first user by the actual database order').toBe(
        founder.id,
      )
      if (existing)
        await db
          .insertInto('auth.user')
          .values({
            name: 'Existing recipient',
            email: recipient,
            emailVerified: true,
          })
          .execute()
      const team = await db
        .insertInto('auth.organization')
        .values({
          name: 'End to end invitation team',
          slug: randomUUID(),
          createdAt: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await db
        .insertInto('auth.member')
        .values([
          { organizationId: team.id, userId: inviter.id, role, createdAt: new Date() },
          ...(role === 'owner'
            ? []
            : [
                {
                  organizationId: team.id,
                  userId: founder.id,
                  role: 'owner',
                  createdAt: new Date(),
                },
              ]),
        ])
        .execute()
      return { inviter, team: team.id }
    }
    type Fixture = Awaited<ReturnType<typeof seed>> & { id: string; session: string }
    async function invite(i: Instance, seeded: Awaited<ReturnType<typeof seed>>) {
      const session = await signIn(i, seeded.inviter.email, randomUUID())
      const active = await post(
        i,
        'organization/set-active',
        { organizationId: seeded.team },
        session,
      )
      expect(active.status).toBe(200)
      smtp.received.data = undefined
      const response = await post(
        i,
        'organization/invite-member',
        {
          email: recipient,
          role: 'member',
          organizationId: seeded.team,
        },
        session,
        seeded.team,
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        id: string
        delivery: { state: string; generation: number }
      }
      expect(body.delivery).toMatchObject({ generation: 1, state: 'queued' })
      const queued = await owned.pool.query<{ data: unknown }>(
        "SELECT data FROM pgboss.job WHERE name = $1 AND data ->> 'invitationId' = $2",
        [INVITATION_EMAIL_JOB, body.id],
      )
      expect(queued.rows, 'queueing is durable before mail delivery is claimed').toEqual([
        { data: { invitationId: body.id, generation: 1 } },
      ])
      await drained(INVITATION_EMAIL_JOB)
      const delivery = await db
        .selectFrom('invitation_deliveries')
        .select(['state', 'attempts'])
        .where('invitation_id', '=', body.id)
        .executeTakeFirstOrThrow()
      expect(delivery).toEqual({ state: 'smtp_accepted', attempts: 1 })
      const link = mailedLink('/app/join')
      expect(Boolean(link), 'the real invitation sender reached the SMTP sink').toBe(true)
      expect(new URL(link as string).searchParams.get('invitationId') === body.id).toBe(true)
      expect(smtp.received.to.at(-1)?.includes(`<${recipient}>`)).toBe(true)
      return { ...seeded, id: body.id, session }
    }
    async function membership(f: Fixture) {
      return db
        .selectFrom('auth.member as member')
        .innerJoin('auth.user as user', 'user.id', 'member.userId')
        .select('member.id')
        .where('member.organizationId', '=', f.team)
        .where('user.email', '=', recipient)
        .execute()
    }
    const read = (i: Instance, f: Fixture, session = '') =>
      i.app.request(`/api/auth/organization/get-invitation?id=${f.id}`, {
        headers: session ? { cookie: session } : {},
      })
    const join = (i: Instance, f: Fixture, session: string) =>
      post(i, 'organization/accept-invitation', { invitationId: f.id }, session)
    async function invalidate(i: Instance, f: Fixture, state: State) {
      if (state === 'canceled') {
        expect(
          (
            await post(
              i,
              'organization/cancel-invitation',
              { invitationId: f.id },
              f.session,
              f.team,
            )
          ).status,
        ).toBe(200)
      } else {
        await db
          .updateTable('auth.invitation')
          .set(state === 'expired' ? { expiresAt: new Date(0) } : { status: 'accepted' })
          .where('id', '=', f.id)
          .execute()
      }
    }
    async function noSignup(i: Instance, f: Fixture, email = recipient) {
      const link = await requestLink(i, email, f.id)
      expect(Boolean(link), 'an ineligible new address receives no identity-proof mail').toBe(false)
      expect(
        await db.selectFrom('auth.user').select('id').where('email', '=', email).execute(),
        'an ineligible new address has no account',
      ).toEqual([])
      expect(await membership(f), 'ineligible registration never joins the team').toEqual([])
    }

    for (const policy of policies) {
      describe(policy.mode, () => {
        it.each(['owner', 'admin'])(
          'allows a trusted %s invitation to sign up exactly the recipient, with explicit join',
          async (role) => {
            const i = await instance(policy)
            const f = await invite(i, await seed({ role }))
            expect(
              (await read(i, f)).status,
              'opening an invitation before signin does not disclose its details',
            ).toBe(401)
            await noSignup(i, f, 'different@outside.example')
            const session = await signIn(i, recipient.toUpperCase(), f.id)
            expect(await membership(f), 'signup and signin alone do not join').toEqual([])
            expect((await read(i, f, session)).status).toBe(200)
            expect(await membership(f), 'reviewing invitation details does not join').toEqual([])
            expect((await join(i, f, session)).status).toBe(200)
            expect(await membership(f)).toHaveLength(1)
            expect((await join(i, f, session)).status).toBe(400)
            expect(await membership(f)).toHaveLength(1)
          },
          // Allow four real queue drains while preserving each drain's own deadline.
          30_000,
        )

        it('keeps existing-account signin separate from joining and rejects an already-used link', async () => {
          const i = await instance(policy)
          const f = await invite(i, await seed({ existing: true, trusted: false }))
          const session = await signIn(i, recipient, f.id)
          expect(
            await membership(f),
            'signing into an existing account alone does not join',
          ).toEqual([])
          expect((await join(i, f, session)).status).toBe(200)
          const later = await signIn(i, recipient, f.id)
          expect((await read(i, f, later)).status).toBe(400)
          expect((await join(i, f, later)).status).toBe(400)
          expect(await membership(f)).toHaveLength(1)
        })

        it('blocks nontransitive registration from an arbitrary outside-domain team owner', async () => {
          const i = await instance(policy)
          const f = await invite(i, await seed({ trusted: false }))
          await noSignup(i, f)
        })

        it('does not allow a member to create an invitation or open signup', async () => {
          const i = await instance(policy)
          const f = await seed({ role: 'member' })
          const session = await signIn(i, f.inviter.email, randomUUID())
          expect(
            (await post(i, 'organization/set-active', { organizationId: f.team }, session)).status,
          ).toBe(200)
          const response = await post(
            i,
            'organization/invite-member',
            { organizationId: f.team, email: recipient },
            session,
            f.team,
          )
          expect(response.status).toBe(403)
          expect(
            await db
              .selectFrom('auth.invitation')
              .select('id')
              .where('organizationId', '=', f.team)
              .execute(),
          ).toEqual([])
          expect(Boolean(await requestLink(i, recipient, randomUUID()))).toBe(false)
        })

        it.each(states)(
          'an %s invitation cannot start signup before proof is requested',
          async (state) => {
            const i = await instance(policy)
            const f = await invite(i, await seed())
            await invalidate(i, f, state)
            expect((await read(i, f)).status).toBe(401)
            await noSignup(i, f)
          },
        )

        it.each(states)(
          'rechecks an %s invitation after mail delivery and before signup',
          async (state) => {
            const i = await instance(policy)
            const f = await invite(i, await seed())
            const link = await requestLink(i, recipient, f.id)
            await invalidate(i, f, state)
            const response = await prove(i, link)
            expect(response.status).toBe(302)
            expect(hasSession(response)).toBe(false)
            const destination = new URL(response.headers.get('location') as string)
            expect(destination.pathname).toBe('/sign-in')
            expect(destination.searchParams.get('error')).toBe('SIGNUP_DISABLED')
            expect(
              await db
                .selectFrom('auth.user')
                .select('id')
                .where('email', '=', recipient)
                .execute(),
            ).toEqual([])
            expect(await membership(f)).toEqual([])
          },
        )

        it.each(states)(
          'refuses an %s invitation after signup without creating another membership',
          async (state) => {
            const i = await instance(policy)
            const f = await invite(i, await seed())
            const session = await signIn(i, recipient, f.id)
            expect(await membership(f)).toEqual([])
            if (state === 'accepted') expect((await join(i, f, session)).status).toBe(200)
            else await invalidate(i, f, state)
            expect((await read(i, f, session)).status).toBe(400)
            expect((await join(i, f, session)).status).toBe(400)
            expect(await membership(f)).toHaveLength(state === 'accepted' ? 1 : 0)
          },
        )

        it.each(['expired', 'canceled'] as const)(
          'lets an existing account sign in after an invitation becomes %s, while refusing join',
          async (state) => {
            const i = await instance(policy)
            const f = await invite(i, await seed({ existing: true }))
            const link = await requestLink(i, recipient, f.id)
            await invalidate(i, f, state)
            const response = await prove(i, link)
            expect(hasSession(response)).toBe(true)
            const session = cookie(response)
            expect((await read(i, f, session)).status).toBe(400)
            expect((await join(i, f, session)).status).toBe(400)
            expect(await membership(f)).toEqual([])
          },
        )
      })
    }

    async function verifySuppressed(
      workerFactory: typeof signInEmailJobs,
      guard: 'address' | 'pending' | 'expiry' | 'authority',
    ) {
      const i = await instance(policies[0] as SignupPolicy, workerFactory)
      const f = await invite(i, await seed({ trusted: guard !== 'authority' }))
      if (guard === 'pending') await invalidate(i, f, 'canceled')
      if (guard === 'expiry') await invalidate(i, f, 'expired')
      await noSignup(i, f, guard === 'address' ? 'different@outside.example' : recipient)
    }
    it('runs an unchanged executable signup worker copy through the mail eligibility assertion', async () => {
      await verifySuppressed(await signupWorkerCopy(), 'address')
    })
    it.each(['address', 'pending', 'expiry', 'authority'] as const)(
      'detects removal of the %s signup protection in the real queued mail worker',
      async (guard) => {
        await expect(verifySuppressed(await signupWorkerCopy(guard), guard)).rejects.toMatchObject({
          name: 'AssertionError',
          message: expect.stringContaining(
            'an ineligible new address receives no identity-proof mail',
          ),
        })
      },
    )
  },
)
