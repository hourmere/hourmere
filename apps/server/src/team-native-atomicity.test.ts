import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4397'
const secret = randomBytes(32).toString('base64')
const barrier = [1848329061, 1668440435]

type Mutation = 'create' | 'accept' | 'binding' | 'clock' | 'limit' | 'session'

function moduleUrl(source: string, location: URL, replacements: Record<string, string> = {}) {
  const code = stripTypeScriptTypes(source).replace(/from '([^']+)'/g, (_, specifier: string) => {
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
  })
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}

/** Compile isolated real source copies; never mutate tracked files or installed dependencies. */
async function sourceCopy(mutation?: Mutation): Promise<typeof createAuth> {
  const changes: Record<Mutation, [string, string]> = {
    create: [
      'return runWithTransaction(context.context.adapter, () => createOrganization(context))',
      'return createOrganization(context)',
    ],
    accept: [
      'return runWithTransaction(context.context.adapter, () => acceptInvitation(context))',
      'return acceptInvitation(context)',
    ],
    binding: ['const trx = transactions.getStore()', 'const trx = undefined'],
    clock: ['if (!validity.active) throw teamRoleDenied()', 'if (false) throw teamRoleDenied()'],
    limit: ['if (Number(count.total) >= teamMembershipLimit) {', 'if (false) {'],
    session: [
      "await teamSession(trx, actor, 'no-key-update')",
      'await teamSession(trx, actor, true)',
    ],
  }
  const copy = (path: string, bindings: Record<string, string> = {}) => {
    const location = new URL(`../../../packages/auth/src/${path}`, import.meta.url)
    let source = readFileSync(location, 'utf8')
    const applies =
      mutation &&
      (['create', 'accept'].includes(mutation)
        ? path === 'team-native-atomicity.ts'
        : path === 'team-role-policy.ts')
    if (applies && mutation) {
      const [before, after] = changes[mutation]
      expect(
        source.includes(before),
        `${mutation} mutation matches its production protection`,
      ).toBe(true)
      source = source.replace(before, after)
    }
    return moduleUrl(source, location, bindings)
  }
  const transactions = copy('team-native-atomicity.ts')
  const policy = copy('team-role-policy.ts')
  const auth = await import(
    copy('index.ts', {
      './team-native-atomicity.ts': transactions,
      './team-role-policy.ts': policy,
    })
  )
  return auth.createAuth
}

describe.skipIf(!serverUrl)('native team write durability through HTTP and PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let pool: pg.Pool

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'team_atomicity' })
    db = createDb(owned.pool)
    // One reusable application pool, one auth pool and its two context-lock connections.
    pool = createAuthPool(owned.url, { mode: 'open', allowedDomains: [] })
    await owned.pool.query(`CREATE FUNCTION public.pause_native_member_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(${barrier[0]}, ${barrier[1]});
        RETURN NEW;
      END $$`)
  })
  beforeEach(async () => {
    await owned.pool.query('DELETE FROM auth.organization')
    await owned.pool.query('DELETE FROM auth."user"')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      await owned?.drop()
    }
  })

  function authentication(factory = createAuth) {
    return factory({
      pool,
      db,
      baseURL: origin,
      secret,
      signup: { mode: 'open', allowedDomains: [] },
      mailer: { send: async () => {} },
    })
  }

  function instance(factory = createAuth) {
    const auth = authentication(factory)
    return createApp({
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
    })
  }

  async function account() {
    const user = await db
      .insertInto('auth.user')
      .values({
        name: 'Synthetic durability account',
        email: `${randomUUID()}@outside.example`,
        emailVerified: true,
      })
      .returning(['id', 'email'])
      .executeTakeFirstOrThrow()
    const token = randomBytes(24).toString('base64url')
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      ...user,
      sessionId: session.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  async function post(
    app: ReturnType<typeof instance>,
    path: string,
    cookie: string,
    input: Record<string, unknown>,
  ) {
    return app.request(`/api/auth/organization/${path}`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  }

  async function invitationFixture(invited?: Awaited<ReturnType<typeof account>>) {
    const owner = await account()
    const recipient = invited ?? (await account())
    const team = await db
      .insertInto('auth.organization')
      .values({ name: 'Synthetic durable team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.member')
      .values({
        organizationId: team.id,
        userId: owner.id,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    const invitation = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: team.id,
        inviterId: owner.id,
        email: recipient.email,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { owner, recipient, team, invitation }
  }

  async function verifySameSessionAcceptances(factory = createAuth) {
    const auth = authentication(factory)
    const recipient = await account()
    // Avoid an unrelated pre-handler session renewal while the test holds its row.
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date(Date.now() + 7 * 86_400_000) })
      .where('id', '=', recipient.sessionId)
      .execute()
    const rounds: { successes: number; statuses: string[]; memberships: number }[] = []
    // Widen the actual database write gap after both requests have reached the session
    // lock. SHARE locks then deadlock on session activation; NO KEY UPDATE queues them.
    await owned.pool.query(`CREATE FUNCTION public.pause_concurrent_acceptance() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.status = 'accepted' THEN PERFORM pg_sleep(0.03); END IF;
        RETURN NEW;
      END $$`)
    await owned.pool.query(`CREATE TRIGGER pause_concurrent_acceptance
      BEFORE UPDATE ON auth.invitation FOR EACH ROW
      EXECUTE FUNCTION public.pause_concurrent_acceptance()`)
    try {
      for (let round = 0; round < 10; round++) {
        const fixtures = [await invitationFixture(recipient), await invitationFixture(recipient)]
        const holder = await owned.pool.connect()
        const pending: Promise<unknown>[] = []
        let outcomes: PromiseSettledResult<unknown>[]
        try {
          await holder.query('BEGIN')
          await holder.query('SELECT id FROM auth.session WHERE id=$1 FOR UPDATE', [
            recipient.sessionId,
          ])
          for (const f of fixtures) {
            pending.push(
              auth.api.acceptInvitation({
                body: { invitationId: f.invitation.id },
                headers: new Headers({ cookie: recipient.cookie, origin }),
              }),
            )
          }
          // Install rejection handlers before releasing either database request.
          const settled = Promise.allSettled(pending)
          await vi.waitFor(
            async () => {
              const blocked = await owned.pool.query<{ pid: number }>(
                `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
                  AND wait_event_type='Lock'`,
              )
              expect(
                blocked.rows,
                'both trusted acceptances reach the same session row',
              ).toHaveLength(2)
            },
            { timeout: 5000, interval: 10 },
          )
          await holder.query('COMMIT')
          outcomes = await settled
        } finally {
          await holder.query('ROLLBACK')
          holder.release()
          await Promise.allSettled(pending)
        }
        const teamIds = fixtures.map((f) => f.team.id)
        const invitations = await db
          .selectFrom('auth.invitation')
          .select('status')
          .where('organizationId', 'in', teamIds)
          .execute()
        const members = await db
          .selectFrom('auth.member')
          .select('id')
          .where('organizationId', 'in', teamIds)
          .where('userId', '=', recipient.id)
          .execute()
        rounds.push({
          successes: outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
          statuses: invitations.map((invitation) => invitation.status).sort(),
          memberships: members.length,
        })
      }
      expect(rounds, 'both trusted acceptances on one session succeed in all ten rounds').toEqual(
        Array.from({ length: 10 }, () => ({
          successes: 2,
          statuses: ['accepted', 'accepted'],
          memberships: 2,
        })),
      )
    } finally {
      await owned.pool.query('DROP TRIGGER pause_concurrent_acceptance ON auth.invitation')
      await owned.pool.query('DROP FUNCTION public.pause_concurrent_acceptance()')
    }
  }

  async function verifyJoinedRemoval(factory = createAuth) {
    const auth = authentication(factory)
    const f = await invitationFixture()
    await db
      .insertInto('auth.member')
      .values({
        organizationId: f.team.id,
        userId: f.recipient.id,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: f.team.id })
      .where('id', '=', f.owner.sessionId)
      .execute()
    const context = await auth.$context
    const transaction = context.adapter.transaction.bind(context.adapter)
    let completed = false
    context.adapter.transaction = (operation) =>
      transaction(async (adapter) => {
        await operation(adapter)
        completed = true
        throw new Error('Synthetic failure after native member removal')
      })
    const app = createApp({
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
    })
    const response = await app.request('/api/auth/organization/remove-member', {
      method: 'POST',
      headers: {
        cookie: f.owner.cookie,
        origin,
        'content-type': 'application/json',
        'x-expected-organization-id': f.team.id,
      },
      body: JSON.stringify({ organizationId: f.team.id, memberIdOrEmail: f.recipient.email }),
    })
    expect(completed, 'the native removal finishes before the enclosing transaction aborts').toBe(
      true,
    )
    expect(response.status).toBe(500)
    expect(
      await db
        .selectFrom('auth.member')
        .select('userId')
        .where('organizationId', '=', f.team.id)
        .where('userId', '=', f.recipient.id)
        .execute(),
      'member removal rolls back with the joined native transaction',
    ).toEqual([{ userId: f.recipient.id }])
    expect(
      await db
        .selectFrom('organization_operations')
        .select('id')
        .where('organization_id', '=', f.team.id)
        .execute(),
    ).toEqual([])
  }

  /**
   * Stop the actual INSERT before the member exists, after the organization INSERT or
   * invitation UPDATE has executed. A separate connection reads committed state while
   * the request is still alive, so JavaScript error compensation cannot hide a crash cut.
   * Cancel the blocked SQL statement to abort the transaction as a lost process would.
   */
  async function abortMemberInsert<T>(request: () => Promise<T>, atCut: () => Promise<void>) {
    const holder = await owned.pool.connect()
    let pending: Promise<T> | undefined
    let blockedPid: number | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock($1, $2)', barrier)
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid as number
      await owned.pool.query(`CREATE TRIGGER pause_native_member_insert
        BEFORE INSERT ON auth.member FOR EACH ROW
        EXECUTE FUNCTION public.pause_native_member_insert()`)
      pending = Promise.resolve(request())
      await vi.waitFor(
        async () => {
          const blocked = await owned.pool.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
              AND wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`,
            [holderPid],
          )
          expect(
            blocked.rows,
            'the native member INSERT reaches the database crash cut',
          ).toHaveLength(1)
          blockedPid = blocked.rows[0]?.pid
        },
        { timeout: 5000, interval: 10 },
      )
      await atCut()
      const canceled = await owned.pool.query<{ canceled: boolean }>(
        'SELECT pg_cancel_backend($1) AS canceled',
        [blockedPid],
      )
      expect(canceled.rows[0]?.canceled, 'abort the actual blocked database statement').toBe(true)
      blockedPid = undefined
      return await pending
    } finally {
      if (blockedPid) await owned.pool.query('SELECT pg_cancel_backend($1)', [blockedPid])
      await holder.query('ROLLBACK')
      holder.release()
      if (pending) await Promise.allSettled([pending])
      await owned.pool.query('DROP TRIGGER IF EXISTS pause_native_member_insert ON auth.member')
    }
  }

  async function verifyCreateCrash(factory = createAuth) {
    const app = instance(factory)
    const creator = await account()
    const slug = randomUUID()
    const input = { name: 'Synthetic creation crash', slug }
    const organizations = () =>
      db.selectFrom('auth.organization').select('id').where('slug', '=', slug).execute()
    const memberships = () =>
      db
        .selectFrom('auth.member')
        .innerJoin('auth.organization', 'auth.organization.id', 'auth.member.organizationId')
        .select(['auth.member.userId', 'auth.member.role'])
        .where('auth.organization.slug', '=', slug)
        .execute()
    const response = await abortMemberInsert(
      () => post(app, 'create', creator.cookie, input),
      async () => {
        expect(
          await organizations(),
          'an organization is never committed before its creator owner membership',
        ).toEqual([])
        expect(await memberships()).toEqual([])
      },
    )
    expect(response.status).toBe(500)
    expect(await organizations(), 'aborted creation leaves no orphan organization').toEqual([])
    expect(await memberships()).toEqual([])
    const retry = await post(app, 'create', creator.cookie, input)
    expect(retry.status).toBe(200)
    const created = (await retry.json()) as { id: string }
    expect(created).toMatchObject({
      id: expect.any(String),
      slug,
      members: [
        {
          id: expect.any(String),
          organizationId: created.id,
          userId: creator.id,
          role: 'owner',
        },
      ],
    })
    expect(await organizations()).toEqual([{ id: created.id }])
    expect(await memberships()).toEqual([{ userId: creator.id, role: 'owner' }])
  }

  async function verifyAcceptCrash(factory = createAuth) {
    const app = instance(factory)
    const f = await invitationFixture()
    const status = () =>
      db
        .selectFrom('auth.invitation')
        .select('status')
        .where('id', '=', f.invitation.id)
        .executeTakeFirstOrThrow()
    const memberships = () =>
      db
        .selectFrom('auth.member')
        .select(['userId', 'role'])
        .where('organizationId', '=', f.team.id)
        .where('userId', '=', f.recipient.id)
        .execute()
    const input = { invitationId: f.invitation.id }
    const response = await abortMemberInsert(
      () => post(app, 'accept-invitation', f.recipient.cookie, input),
      async () => {
        expect(
          await status(),
          'an accepted invitation is never committed before its recipient membership',
        ).toEqual({ status: 'pending' })
        expect(await memberships()).toEqual([])
      },
    )
    expect(response.status).toBe(500)
    expect(await status(), 'aborted acceptance preserves the pending invitation').toEqual({
      status: 'pending',
    })
    expect(await memberships()).toEqual([])
    const retry = await post(app, 'accept-invitation', f.recipient.cookie, input)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({
      invitation: { id: f.invitation.id, status: 'accepted' },
      member: { organizationId: f.team.id, userId: f.recipient.id, role: 'member' },
    })
    expect(await status()).toEqual({ status: 'accepted' })
    expect(await memberships()).toEqual([{ userId: f.recipient.id, role: 'member' }])
    const repeated = await post(app, 'accept-invitation', f.recipient.cookie, input)
    expect(repeated.status).toBe(400)
    expect(await repeated.json()).toMatchObject({ code: 'INVITATION_NOT_FOUND' })
    expect(await memberships()).toHaveLength(1)
  }

  async function verifyDatabaseClock(factory = createAuth) {
    const app = instance(factory)
    const f = await invitationFixture()
    const databaseTime = await owned.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    const now = databaseTime.rows[0]?.now as Date
    await db
      .updateTable('auth.invitation')
      .set({ expiresAt: new Date(now.getTime() - 60_000) })
      .where('id', '=', f.invitation.id)
      .execute()
    // The native process-clock check sees this expired invitation as still live.
    // Only the locked database-clock check can reject this acceptance.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now.getTime() - 3_600_000)
    try {
      const response = await post(app, 'accept-invitation', f.recipient.cookie, {
        invitationId: f.invitation.id,
      })
      expect(
        response.status,
        'the database clock refuses an expired invitation despite process skew',
      ).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'TEAM_MANAGEMENT_ACCESS_DENIED' })
      expect(
        await db
          .selectFrom('auth.invitation')
          .select('status')
          .where('id', '=', f.invitation.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'pending' })
      expect(
        await db
          .selectFrom('auth.member')
          .select('id')
          .where('organizationId', '=', f.team.id)
          .where('userId', '=', f.recipient.id)
          .execute(),
      ).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  }

  async function verifyMembershipLimit(factory = createAuth) {
    const app = instance(factory)
    const f = await invitationFixture()
    const second = await account()
    const invitation = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: f.team.id,
        inviterId: (
          await db
            .selectFrom('auth.member')
            .select('userId')
            .where('organizationId', '=', f.team.id)
            .executeTakeFirstOrThrow()
        ).userId,
        email: second.email,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const existing = await db
      .insertInto('auth.user')
      .values(
        Array.from({ length: 98 }, () => ({
          name: 'Synthetic existing team member',
          email: `${randomUUID()}@outside.example`,
          emailVerified: true,
        })),
      )
      .returning('id')
      .execute()
    await db
      .insertInto('auth.member')
      .values(
        existing.map((user) => ({
          organizationId: f.team.id,
          userId: user.id,
          role: 'member',
          createdAt: new Date(),
        })),
      )
      .execute()
    const holder = await owned.pool.connect()
    const pending: Promise<Response>[] = []
    let responses: Response[]
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [f.team.id])
      pending.push(
        Promise.resolve(
          post(app, 'accept-invitation', f.recipient.cookie, {
            invitationId: f.invitation.id,
          }),
        ),
        Promise.resolve(
          post(app, 'accept-invitation', second.cookie, {
            invitationId: invitation.id,
          }),
        ),
      )
      await vi.waitFor(
        async () => {
          const blocked = await owned.pool.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
              AND wait_event_type='Lock' AND wait_event<>'advisory'`,
          )
          expect(
            blocked.rows,
            'both recipients pass the native count and wait for the team lock',
          ).toHaveLength(2)
        },
        { timeout: 5000, interval: 10 },
      )
      await holder.query('COMMIT')
      responses = await Promise.all(pending)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await Promise.allSettled(pending)
    }
    const count = await db
      .selectFrom('auth.member')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('organizationId', '=', f.team.id)
      .executeTakeFirstOrThrow()
    expect(
      Number(count.total),
      'concurrent recipients cannot both consume the last membership slot',
    ).toBe(100)
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403])
    const refused = responses.find((response) => response.status === 403) as Response
    expect(await refused.json()).toEqual({
      code: 'ORGANIZATION_MEMBERSHIP_LIMIT_REACHED',
      message: 'Organization membership limit reached',
    })
    const states = await db
      .selectFrom('auth.invitation')
      .select('status')
      .where('organizationId', '=', f.team.id)
      .execute()
    expect(states.map((row) => row.status).sort()).toEqual(['accepted', 'pending'])
  }

  it('rolls creation back after a database abort between organization and owner writes', async () => {
    await verifyCreateCrash()
  })

  it('rolls acceptance back after a database abort between status and member writes', async () => {
    await verifyAcceptCrash()
  })

  it('uses the database clock when the process clock would allow an expired invitation', async () => {
    await verifyDatabaseClock()
  })

  it('serializes different recipients competing for the last team membership slot', async () => {
    await verifyMembershipLimit()
  })

  it('accepts two teams concurrently on the same trusted session for ten rounds', async () => {
    await verifySameSessionAcceptances()
  }, 30_000)

  it('rolls member removal and its operation record back with the joined native transaction', async () => {
    await verifyJoinedRemoval()
  })

  it('detects a policy transaction detached from native member removal', async () => {
    await expect(verifyJoinedRemoval(await sourceCopy('binding'))).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining(
        'member removal rolls back with the joined native transaction',
      ),
    })
  })

  it('detects session SHARE lock upgrades with ten real database races', async () => {
    await expect(verifySameSessionAcceptances(await sourceCopy('session'))).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining(
        'both trusted acceptances on one session succeed in all ten rounds',
      ),
    })
  }, 30_000)

  it('rolls a trusted sessionless creation back and permits a later native API retry', async () => {
    const auth = authentication()
    const creator = await account()
    const slug = randomUUID()
    const body = { name: 'Synthetic trusted creation', slug, userId: creator.id }
    const organizations = () =>
      db.selectFrom('auth.organization').select('id').where('slug', '=', slug).execute()
    const aborted = await abortMemberInsert(
      () =>
        auth.api.createOrganization({ body }).then(
          () => false,
          () => true,
        ),
      async () => {
        expect(
          await organizations(),
          'trusted API creation also hides the organization until its owner exists',
        ).toEqual([])
      },
    )
    expect(aborted, 'the actual PostgreSQL abort rejects trusted native creation').toBe(true)
    expect(await organizations()).toEqual([])
    const created = await auth.api.createOrganization({ body })
    expect(created).toMatchObject({
      slug,
      members: [{ userId: creator.id, role: 'owner' }],
    })
    expect(await organizations()).toEqual([{ id: created?.id }])
    const member = await db
      .selectFrom('auth.member')
      .select(['userId', 'role'])
      .where('organizationId', '=', created?.id as string)
      .execute()
    expect(member).toEqual([{ userId: creator.id, role: 'owner' }])
  })

  it('rolls trusted native API acceptance back with the same status/member durability', async () => {
    const auth = authentication()
    const f = await invitationFixture()
    const input = {
      body: { invitationId: f.invitation.id },
      headers: new Headers({ cookie: f.recipient.cookie, origin }),
    }
    const status = () =>
      db
        .selectFrom('auth.invitation')
        .select('status')
        .where('id', '=', f.invitation.id)
        .executeTakeFirstOrThrow()
    const members = () =>
      db
        .selectFrom('auth.member')
        .select(['userId', 'role'])
        .where('organizationId', '=', f.team.id)
        .where('userId', '=', f.recipient.id)
        .execute()
    const aborted = await abortMemberInsert(
      () =>
        auth.api.acceptInvitation(input).then(
          () => false,
          () => true,
        ),
      async () => {
        expect(
          await status(),
          'trusted API acceptance also hides accepted status until the member exists',
        ).toEqual({ status: 'pending' })
        expect(await members()).toEqual([])
      },
    )
    expect(aborted, 'the actual PostgreSQL abort rejects trusted native acceptance').toBe(true)
    expect(await status()).toEqual({ status: 'pending' })
    expect(await members()).toEqual([])
    const accepted = await auth.api.acceptInvitation(input)
    expect(accepted).toMatchObject({
      invitation: { id: f.invitation.id, status: 'accepted' },
      member: { organizationId: f.team.id, userId: f.recipient.id, role: 'member' },
    })
    expect(await status()).toEqual({ status: 'accepted' })
    expect(await members()).toEqual([{ userId: f.recipient.id, role: 'member' }])
  })

  it('runs unchanged source copies through both database crash cuts', async () => {
    const factory = await sourceCopy()
    await verifyCreateCrash(factory)
    await verifyAcceptCrash(factory)
  })

  it.each([
    [
      'create',
      verifyCreateCrash,
      'an organization is never committed before its creator owner membership',
    ],
    [
      'accept',
      verifyAcceptCrash,
      'an accepted invitation is never committed before its recipient membership',
    ],
    [
      'binding',
      verifyAcceptCrash,
      'an accepted invitation is never committed before its recipient membership',
    ],
    [
      'clock',
      verifyDatabaseClock,
      'the database clock refuses an expired invitation despite process skew',
    ],
    [
      'limit',
      verifyMembershipLimit,
      'concurrent recipients cannot both consume the last membership slot',
    ],
  ] as const)(
    'detects removal of the %s protection with a real database assertion',
    async (mutation, verify, message) => {
      const factory = await sourceCopy(mutation)
      await expect(verify(factory)).rejects.toMatchObject({
        name: 'AssertionError',
        message: expect.stringContaining(message),
      })
    },
  )
})
