import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { reserveInvitationEmailBudget } from '../../../packages/notifications/src/invitation-mail-limits.ts'
import { invitationRecipientHash } from '../../../packages/notifications/src/mail-limits.ts'
import { createApp } from './app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4387'
const secret = randomBytes(32).toString('base64')

interface Admin {
  userId: string
  sessionId: string
  organizationId: string
  cookie: string
}

interface Invitation {
  id: string
  email: string
  delivery: { generation: number; state: string; attempts: number }
}

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

// Import isolated source copies, so mutations cannot affect another test worker.
async function sourceCopy(removeTeamLock: boolean, removeInvitationLocks: boolean) {
  const managementLocation = new URL(
    '../../../packages/auth/src/team-management.ts',
    import.meta.url,
  )
  let management = readFileSync(managementLocation, 'utf8')
  const teamLock = 'if (lock) organizationQuery = organizationQuery.forUpdate()'
  expect(management.includes(teamLock), 'mutation matches the team serialization lock').toBe(true)
  if (removeTeamLock) management = management.replace(teamLock, '')
  const managementUrl = moduleUrl(management, managementLocation)

  const invitationLocation = new URL('../../../packages/auth/src/invitations.ts', import.meta.url)
  let invitations = readFileSync(invitationLocation, 'utf8')
  expect(invitations.match(/\.forUpdate\(\)/g)).toHaveLength(2)
  if (removeInvitationLocks) invitations = invitations.replaceAll('.forUpdate()', '')
  const invitationUrl = moduleUrl(invitations, invitationLocation, {
    './team-management.ts': managementUrl,
  })
  const hooksLocation = new URL('../../../packages/auth/src/hooks.ts', import.meta.url)
  const hooksUrl = moduleUrl(readFileSync(hooksLocation, 'utf8'), hooksLocation, {
    './invitations.ts': invitationUrl,
  })
  const authLocation = new URL('../../../packages/auth/src/index.ts', import.meta.url)
  const auth = await import(
    moduleUrl(readFileSync(authLocation, 'utf8'), authLocation, { './hooks.ts': hooksUrl })
  )
  return auth.createAuth as typeof createAuth
}

describe.skipIf(!serverUrl)('team invitation concurrency across distinct admin sessions', () => {
  let owned: TestDatabase
  let db: Db
  let pool: pg.Pool

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_races' })
    db = createDb(owned.pool)
    pool = createAuthPool(owned.url, { mode: 'open', allowedDomains: [] })
  })
  beforeEach(async () => {
    await owned.pool.query('DELETE FROM auth.organization')
    await owned.pool.query('DELETE FROM auth."user"')
    await owned.pool.query('DELETE FROM invitation_email_requests')
    await owned.pool.query('DELETE FROM notification_email_sends')
  })
  afterAll(async () => {
    try {
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
      signup: { mode: 'closed', allowedDomains: [] },
      mailer: { send: async () => {} },
      reserveInvitationEmail: (trx, input, now) =>
        reserveInvitationEmailBudget(trx, input, { secret }, now),
    })
    return createApp({
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
    })
  }

  async function admins(): Promise<[Admin, Admin]> {
    const organization = await db
      .insertInto('auth.organization')
      .values({ name: 'Synthetic concurrency team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    const result: Admin[] = []
    for (let index = 0; index < 2; index++) {
      const user = await db
        .insertInto('auth.user')
        .values({
          name: 'Synthetic concurrency administrator',
          email: `${randomUUID()}@outside.example`,
          emailVerified: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await db
        .insertInto('auth.member')
        .values({
          userId: user.id,
          organizationId: organization.id,
          role: 'admin',
          createdAt: new Date(),
        })
        .execute()
      const token = randomBytes(24).toString('base64url')
      const session = await db
        .insertInto('auth.session')
        .values({
          userId: user.id,
          token,
          expiresAt: new Date(Date.now() + 3_600_000),
          updatedAt: new Date(),
          activeOrganizationId: organization.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const signature = createHmac('sha256', secret).update(token).digest('base64')
      result.push({
        userId: user.id,
        sessionId: session.id,
        organizationId: organization.id,
        cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
      })
    }
    const [first, second] = result as [Admin, Admin]
    expect(first.userId).not.toBe(second.userId)
    expect(first.sessionId).not.toBe(second.sessionId)
    return [first, second]
  }

  function invite(app: ReturnType<typeof instance>, admin: Admin, body: Record<string, unknown>) {
    return app.request('/api/auth/organization/invite-member', {
      method: 'POST',
      headers: {
        origin,
        cookie: admin.cookie,
        'content-type': 'application/json',
        'x-expected-organization-id': admin.organizationId,
      },
      body: JSON.stringify({ organizationId: admin.organizationId, role: 'member', ...body }),
    })
  }

  async function blockedBy(blockers: number[], minimum: number) {
    let pids: number[] = []
    await vi.waitFor(
      async () => {
        const result = await owned.pool.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND pg_blocking_pids(pid) && $1::int[]`,
          [blockers],
        )
        pids = result.rows.map((row) => row.pid)
        expect(
          pids.length,
          'requests reached their PostgreSQL serialization barriers',
        ).toBeGreaterThanOrEqual(minimum)
      },
      { timeout: 3000, interval: 10 },
    )
    return pids
  }

  /**
   * Stop the first admission after its invitation/generation read. The second session
   * then queues behind that transaction's team/row locks. Removing those locks instead
   * puts both admissions at the budget fence with stale reads, deterministically
   * exposing duplicate writes once the fence opens. No elapsed sleep decides the race.
   */
  async function race(first: () => Promise<Response>, second: () => Promise<Response>) {
    const holder = await owned.pool.connect()
    const requests: Promise<Response>[] = []
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(1852798057, 1835100524)')
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid as number
      requests.push(first())
      const [firstPid] = await blockedBy([holderPid], 1)
      requests.push(second())
      await blockedBy([holderPid, firstPid as number], 2)
      await holder.query('COMMIT')
      return await Promise.all(requests)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await Promise.allSettled(requests)
    }
  }

  async function verifyRace(kind: 'create' | 'resend', factory = createAuth) {
    const app = instance(factory)
    const [first, second] = await admins()
    const email = `${randomUUID()}@outside.example`
    let invitation: Invitation | undefined
    if (kind === 'resend') {
      const response = await invite(app, first, { email })
      expect(response.status).toBe(200)
      invitation = (await response.json()) as Invitation
      await db
        .updateTable('invitation_deliveries')
        .set({
          generation_started_at: new Date(Date.now() - 61_000),
          updated_at: new Date(Date.now() - 61_000),
        })
        .where('invitation_id', '=', invitation.id)
        .execute()
    }
    const body = () =>
      invitation
        ? {
            email,
            invitationId: invitation.id,
            resend: true,
            expectedGeneration: invitation.delivery.generation,
            requestId: randomUUID(),
          }
        : { email }
    const responses = await race(
      () => Promise.resolve(invite(app, first, body())),
      () => Promise.resolve(invite(app, second, body())),
    )

    const invitations = await db
      .selectFrom('auth.invitation')
      .select(['id', 'status'])
      .where('organizationId', '=', first.organizationId)
      .where('email', '=', email)
      .execute()
    expect(invitations, 'same-address admissions create exactly one invitation').toEqual([
      { id: invitation?.id ?? expect.any(String), status: 'pending' },
    ])
    const generations = await db
      .selectFrom('invitation_deliveries')
      .innerJoin('auth.invitation', 'auth.invitation.id', 'invitation_deliveries.invitation_id')
      .select(['generation', 'state', 'attempts'])
      .where('auth.invitation.organizationId', '=', first.organizationId)
      .execute()
    expect(generations, 'competing requests advance exactly one generation').toEqual([
      { generation: kind === 'resend' ? 2 : 1, state: 'queued', attempts: 0 },
    ])
    const requests = await db
      .selectFrom('invitation_email_requests')
      .selectAll()
      .where('organization_id', '=', first.organizationId)
      .execute()
    expect(requests, 'only the winning request debits invitation admission').toHaveLength(
      kind === 'resend' ? 2 : 1,
    )
    const recipientDebits = await owned.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM invitation_email_requests WHERE recipient_hash=$1',
      [invitationRecipientHash(email, secret)],
    )
    expect(recipientDebits.rows[0]?.n).toBe(kind === 'resend' ? 2 : 1)
    expect(await db.selectFrom('notification_email_sends').selectAll().execute()).toEqual([])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    const refused = responses.find((response) => response.status === 409) as Response
    expect(await refused.json()).toMatchObject({
      code: kind === 'resend' ? 'INVITATION_CONFLICT' : 'INVITATION_ALREADY_PENDING',
    })
  }

  it('serializes same-address creation from two admins with separate sessions', async () => {
    await verifyRace('create')
  })

  it('serializes same-generation resends with distinct request ids from two admin sessions', async () => {
    await verifyRace('resend')
  })

  it('runs the unchanged source copy through both cross-session invariants', async () => {
    const factory = await sourceCopy(false, false)
    await verifyRace('create', factory)
    await verifyRace('resend', factory)
  })

  it('detects removal of the team row lock through a duplicate-invitation assertion', async () => {
    const factory = await sourceCopy(true, false)
    await expect(verifyRace('create', factory)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('same-address admissions create exactly one invitation'),
    })
  })

  it('detects removal of all three row locks through a duplicate-debit assertion', async () => {
    const factory = await sourceCopy(true, true)
    await expect(verifyRace('resend', factory)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('only the winning request debits invitation admission'),
    })
  })
})
