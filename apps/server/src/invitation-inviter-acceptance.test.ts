import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { leaveTeamMember } from '@hourmere/scheduling'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4391'
const secret = randomBytes(32).toString('base64')
const inviterLeftCode = 'INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION'
type Departure = 'left' | 'removed'
type Entry = 'HTTP' | 'trusted auth.api'

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

async function sourceCopy(mutation?: 'inviter' | 'organization'): Promise<typeof createAuth> {
  const location = new URL('../../../packages/auth/src/team-role-policy.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  const guard = '    if (!inviter) {'
  const lock = `.where('id', '=', target.organizationId)
      .forUpdate()`
  expect(source.includes(guard), 'mutation matches the original inviter membership guard').toBe(
    true,
  )
  expect(source.includes(lock), 'mutation matches the acceptance organization lock').toBe(true)
  if (mutation === 'inviter') source = source.replace(guard, '    if (false) {')
  if (mutation === 'organization')
    source = source.replace(lock, ".where('id', '=', target.organizationId)")
  const policyUrl = moduleUrl(source, location)
  const authLocation = new URL('../../../packages/auth/src/index.ts', import.meta.url)
  return (
    await import(
      moduleUrl(readFileSync(authLocation, 'utf8'), authLocation, {
        './team-role-policy.ts': policyUrl,
      })
    )
  ).createAuth
}

describe.skipIf(!serverUrl)(
  'invitation acceptance requires the original inviter membership',
  () => {
    let owned: TestDatabase
    let db: Db
    let pool: pg.Pool

    beforeAll(async () => {
      owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'inviter_accept' })
      db = createDb(owned.pool)
      pool = createAuthPool(owned.url, { mode: 'open', allowedDomains: [] })
    })
    beforeEach(async () => {
      await owned.pool.query('DELETE FROM auth.organization')
      await owned.pool.query('DELETE FROM auth."user"')
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })
    afterEach(() => vi.restoreAllMocks())
    afterAll(async () => {
      try {
        // Reuse one auth pool, including its bounded organization-lock pool, for the file.
        await pool?.end()
      } finally {
        await owned?.drop()
      }
    })

    function instance(factory = createAuth) {
      const auth = factory({
        pool,
        db,
        baseURL: origin,
        secret,
        signup: { mode: 'open', allowedDomains: [] },
        mailer: { send: async () => {} },
        leaveTeamMember: (principal, teamId, expectedOrganizationId) =>
          leaveTeamMember(
            { db, principal, now: () => Temporal.Now.instant() },
            { teamId, expectedOrganizationId },
          ),
      })
      return {
        auth,
        app: createApp({
          authHandler: auth.handler,
          resolveCaller: createCallerResolver({ auth, db }),
          checkDb: async () => {},
          publicUrl: origin,
        }),
      }
    }
    type Instance = ReturnType<typeof instance>

    async function fixture() {
      const team = await db
        .insertInto('auth.organization')
        .values({
          name: 'Synthetic inviter membership team',
          slug: randomUUID(),
          createdAt: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const users = []
      for (const role of ['owner', 'admin', null] as const) {
        const user = await db
          .insertInto('auth.user')
          .values({
            name: 'Synthetic invitation account',
            email: `${randomUUID()}@example.test`,
            emailVerified: true,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const member = role
          ? await db
              .insertInto('auth.member')
              .values({ userId: user.id, organizationId: team.id, role, createdAt: new Date() })
              .returning('id')
              .executeTakeFirstOrThrow()
          : null
        const token = randomBytes(24).toString('base64url')
        const session = await db
          .insertInto('auth.session')
          .values({
            userId: user.id,
            token,
            activeOrganizationId: role ? team.id : null,
            expiresAt: new Date(Date.now() + 3_600_000),
            updatedAt: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        const signature = createHmac('sha256', secret).update(token).digest('base64')
        users.push({
          ...user,
          memberId: member?.id,
          sessionId: session.id,
          cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
        })
      }
      const [owner, inviter, recipient] = users as [
        (typeof users)[number],
        (typeof users)[number],
        (typeof users)[number],
      ]
      const invitation = await db
        .insertInto('auth.invitation')
        .values({
          organizationId: team.id,
          inviterId: inviter.id,
          email: recipient.email,
          role: 'member',
          status: 'pending',
          expiresAt: new Date(Date.now() + 3_600_000),
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      return { team, owner, inviter, recipient, invitation }
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>

    function post(
      i: Instance,
      cookie: string,
      path: string,
      input: Record<string, unknown>,
      teamId?: string,
    ) {
      return i.app.request(`/api/auth/organization/${path}`, {
        method: 'POST',
        headers: {
          origin,
          cookie,
          'content-type': 'application/json',
          ...(teamId && { 'x-expected-organization-id': teamId }),
        },
        body: JSON.stringify(input),
      })
    }

    function accept(i: Instance, f: Fixture, entry: Entry) {
      return entry === 'trusted auth.api'
        ? i.auth.api.acceptInvitation({
            body: { invitationId: f.invitation.id },
            headers: new Headers({ cookie: f.recipient.cookie }),
            asResponse: true,
          })
        : post(i, f.recipient.cookie, 'accept-invitation', { invitationId: f.invitation.id })
    }

    function depart(i: Instance, f: Fixture, departure: Departure) {
      return departure === 'left'
        ? post(i, f.inviter.cookie, 'leave', { organizationId: f.team.id }, f.team.id)
        : post(
            i,
            f.owner.cookie,
            'remove-member',
            {
              organizationId: f.team.id,
              memberIdOrEmail: f.inviter.memberId,
            },
            f.team.id,
          )
    }

    function memberships(f: Fixture, userId = f.recipient.id) {
      return db
        .selectFrom('auth.member')
        .select(['userId', 'role'])
        .where('organizationId', '=', f.team.id)
        .where('userId', '=', userId)
        .execute()
    }

    async function assertVoid(i: Instance, f: Fixture, entry: Entry) {
      const read = await i.app.request(
        `/api/auth/organization/get-invitation?id=${f.invitation.id}`,
        {
          headers: { cookie: f.recipient.cookie },
        },
      )
      expect(read.status).toBe(400)
      const nativeError = await read.json()
      expect(nativeError).toMatchObject({ code: inviterLeftCode })
      const response = await accept(i, f, entry)
      expect(
        response.status,
        'acceptance refuses an invitation whose original inviter has left',
      ).toBe(400)
      expect(await response.json()).toEqual(nativeError)
      expect(await memberships(f), 'void acceptance never creates a membership').toEqual([])
      expect(
        await db
          .selectFrom('auth.invitation')
          .selectAll()
          .where('id', '=', f.invitation.id)
          .executeTakeFirstOrThrow(),
        'refusing a void invitation preserves every invitation column',
      ).toEqual(f.invitation)
      expect(
        await db
          .selectFrom('auth.session')
          .select('activeOrganizationId')
          .where('id', '=', f.recipient.sessionId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ activeOrganizationId: null })
    }

    it.each([
      ['left', 'HTTP'],
      ['removed', 'HTTP'],
      ['left', 'trusted auth.api'],
      ['removed', 'trusted auth.api'],
    ] as const)('refuses an inviter who %s through %s', async (departure, entry) => {
      const i = instance()
      const f = await fixture()
      expect((await depart(i, f, departure)).status).toBe(200)
      expect(await memberships(f, f.inviter.id)).toEqual([])
      await assertVoid(i, f, entry)
    })

    it.each(['HTTP', 'trusted auth.api'] as const)(
      'accepts after inviter demotion through %s',
      async (entry) => {
        const i = instance()
        const f = await fixture()
        const demoted = await post(
          i,
          f.owner.cookie,
          'update-member-role',
          {
            organizationId: f.team.id,
            memberId: f.inviter.memberId,
            role: 'member',
          },
          f.team.id,
        )
        expect(demoted.status).toBe(200)
        expect(await memberships(f, f.inviter.id)).toEqual([
          { userId: f.inviter.id, role: 'member' },
        ])
        expect((await accept(i, f, entry)).status).toBe(200)
        expect(await memberships(f)).toEqual([{ userId: f.recipient.id, role: 'member' }])
      },
    )

    async function blockedBy(blockers: number[], message: string, settled?: () => boolean) {
      let pids: number[] = []
      await vi.waitFor(
        async () => {
          expect(settled?.() ?? false, message).toBe(false)
          const result = await owned.pool.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND pg_blocking_pids(pid) && $1::int[]`,
            [blockers],
          )
          pids = result.rows.map((row) => row.pid)
          expect(pids.length, message).toBeGreaterThan(0)
        },
        { timeout: 3000, interval: 10 },
      )
      return pids
    }

    async function departureFirst(departure: Departure, entry: Entry) {
      const i = instance()
      const f = await fixture()
      const holder = await owned.pool.connect()
      const fence = `hourmere.inviter-departure-test:${randomUUID()}`
      const requests: Promise<Response>[] = []
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [fence])
        const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]?.pid as number
        await owned.pool.query(`CREATE FUNCTION public.pause_inviter_departure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('${fence}', 0)); RETURN OLD; END $$`)
        await owned.pool.query(`CREATE TRIGGER pause_inviter_departure BEFORE DELETE ON auth.member
        FOR EACH ROW WHEN (OLD."userId" = '${f.inviter.id}'::uuid)
        EXECUTE FUNCTION public.pause_inviter_departure()`)
        requests.push(Promise.resolve(depart(i, f, departure)))
        const departing = await blockedBy(
          [holderPid],
          'departure reaches its in-transaction deletion fence',
        )
        requests.push(Promise.resolve(accept(i, f, entry)))
        await blockedBy(departing, 'acceptance waits for the inviter departure organization lock')
        await holder.query('ROLLBACK')
        const [departed, accepted] = await Promise.all(requests)
        expect(departed?.status).toBe(200)
        expect(accepted?.status).toBe(400)
        expect(await accepted?.json()).toMatchObject({ code: inviterLeftCode })
        expect(await memberships(f, f.inviter.id)).toEqual([])
        expect(
          await memberships(f),
          'departure commits before acceptance, so nobody joins',
        ).toEqual([])
        expect(
          await db
            .selectFrom('auth.invitation')
            .selectAll()
            .where('id', '=', f.invitation.id)
            .executeTakeFirstOrThrow(),
        ).toEqual(f.invitation)
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
        await Promise.allSettled(requests)
        await owned.pool.query('DROP TRIGGER IF EXISTS pause_inviter_departure ON auth.member')
        await owned.pool.query('DROP FUNCTION IF EXISTS public.pause_inviter_departure()')
      }
    }

    async function acceptanceFirst(departure: Departure, entry: Entry, factory = createAuth) {
      const i = instance(factory)
      const f = await fixture()
      const adapter = (await i.auth.$context).adapter
      const transaction = adapter.transaction.bind(adapter)
      const release = Promise.withResolvers<void>()
      let paused = false
      let departureSettled = false
      const requests: Promise<Response>[] = []
      const spy = vi.spyOn(adapter, 'transaction').mockImplementation((callback) =>
        transaction(async (trx) => {
          const create = trx.create.bind(trx)
          trx.create = async (request) => {
            if (request.model === 'member' && request.data.userId === f.recipient.id) {
              paused = true
              await release.promise
            }
            return create(request)
          }
          return callback(trx)
        }),
      )
      try {
        requests.push(Promise.resolve(accept(i, f, entry)))
        await vi.waitFor(() => expect(paused).toBe(true), { timeout: 3000, interval: 10 })
        const owners = await owned.pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND state='idle in transaction'
        AND query ILIKE 'update %invitation%'`)
        expect(owners.rows.length, 'acceptance pauses after its locked invitation claim').toBe(1)
        requests.push(
          Promise.resolve(depart(i, f, departure)).then((response) => {
            departureSettled = true
            return response
          }),
        )
        await blockedBy(
          owners.rows.map((row) => row.pid),
          'departure waits until the earlier acceptance commits',
          () => departureSettled,
        )
        expect(await memberships(f, f.inviter.id)).toEqual([
          { userId: f.inviter.id, role: 'admin' },
        ])
        release.resolve()
        const [accepted, departed] = await Promise.all(requests)
        expect(accepted?.status).toBe(200)
        expect(departed?.status).toBe(200)
        expect(await memberships(f)).toEqual([{ userId: f.recipient.id, role: 'member' }])
        expect(await memberships(f, f.inviter.id)).toEqual([])
        expect(
          await db
            .selectFrom('auth.invitation')
            .select('status')
            .where('id', '=', f.invitation.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ status: 'accepted' })
      } finally {
        release.resolve()
        await Promise.allSettled(requests)
        spy.mockRestore()
      }
    }

    it.each([
      ['left', 'HTTP'],
      ['removed', 'HTTP'],
      ['left', 'trusted auth.api'],
      ['removed', 'trusted auth.api'],
    ] as const)('refuses when inviter %s commits before %s acceptance', departureFirst)

    it.each([
      ['left', 'HTTP'],
      ['removed', 'HTTP'],
      ['left', 'trusted auth.api'],
      ['removed', 'trusted auth.api'],
    ] as const)('commits %s inviter departure after earlier %s acceptance', (departure, entry) =>
      acceptanceFirst(departure, entry),
    )

    async function verifyMembershipGuard(factory: typeof createAuth) {
      const i = instance(factory)
      const f = await fixture()
      expect((await depart(i, f, 'removed')).status).toBe(200)
      await assertVoid(i, f, 'trusted auth.api')
    }

    it('runs an unchanged source copy through original inviter membership and race checks', async () => {
      const factory = await sourceCopy()
      await verifyMembershipGuard(factory)
      await acceptanceFirst('removed', 'trusted auth.api', factory)
    })

    it('detects removal of the original inviter membership protection', async () => {
      await expect(verifyMembershipGuard(await sourceCopy('inviter'))).rejects.toMatchObject({
        name: 'AssertionError',
        message: expect.stringContaining(
          'acceptance refuses an invitation whose original inviter has left',
        ),
      })
    })

    it('detects removal of the organization lock that orders acceptance and inviter departure', async () => {
      await expect(
        acceptanceFirst('removed', 'trusted auth.api', await sourceCopy('organization')),
      ).rejects.toMatchObject({
        name: 'AssertionError',
        message: expect.stringContaining('departure waits until the earlier acceptance commits'),
      })
    })
  },
)
