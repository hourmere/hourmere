import { createHmac, randomBytes } from 'node:crypto'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { publicRoutes } from './routes/public.ts'
import { EXPECTED_ORGANIZATION_HEADER } from './team-management.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4397'
const secret = randomBytes(32).toString('base64')

type Settings = { name: string; slug: string }

describe.skipIf(!serverUrl)('team settings through HTTP and PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let pool: ReturnType<typeof createAuthPool>
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'team_settings' })
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    pool = createAuthPool(owned.url, signup)
    const auth = createAuth({
      pool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
    app = createApp({
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
      routes: [publicRoutes({ db })],
    })
  })

  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      await owned?.drop()
    }
  })

  async function cookieFor(userId: string, activeOrganizationId: string) {
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId,
        token,
        activeOrganizationId,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
  }

  async function fixture() {
    const owner = await createTestUser(db)
    const admin = await createTestUser(db)
    const member = await createTestUser(db)
    const team = await createTestTeam(
      db,
      [
        { user: owner, role: 'owner' },
        { user: admin, role: 'admin' },
        { user: member, role: 'member' },
      ],
      '原来的团队 100% / München',
    )
    return {
      team: team.as(owner).organization,
      ownerId: owner.id,
      ownerCookie: await cookieFor(owner.id, team.id),
      adminCookie: await cookieFor(admin.id, team.id),
      memberCookie: await cookieFor(member.id, team.id),
    }
  }

  function update(
    teamId: string,
    cookie: string,
    data: Partial<Settings>,
    expected: Partial<Settings>,
  ) {
    return app.request('/api/auth/organization/update', {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        [EXPECTED_ORGANIZATION_HEADER]: teamId,
        ...(expected.name !== undefined && {
          'x-expected-team-name': encodeURIComponent(expected.name),
        }),
        ...(expected.slug !== undefined && {
          'x-expected-team-slug': encodeURIComponent(expected.slug),
        }),
      },
      body: JSON.stringify({ organizationId: teamId, data }),
    })
  }

  function settings(teamId: string) {
    return db
      .selectFrom('auth.organization')
      .select(['name', 'slug'])
      .where('id', '=', teamId)
      .executeTakeFirstOrThrow()
  }

  it('applies a name and address change to the existing public event without a redirect', async () => {
    const f = await fixture()
    const events = createFixtures(db)
    await events.eventType(f.team.id, null, {
      slug: 'intro',
      title: 'Team introduction',
      hosts: [{ userId: f.ownerId }],
    })
    const publicEvent = (address: string) => app.request(`/api/v1/public/teams/${address}/intro`)
    const before = await publicEvent(f.team.slug)
    expect(before.status).toBe(200)
    expect(await before.json()).toMatchObject({
      team: { name: f.team.name, slug: f.team.slug },
    })

    const edited = { name: '新团队', slug: 'new-public-address' }
    const saved = await update(f.team.id, f.adminCookie, edited, f.team)
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ id: f.team.id, ...edited })
    expect(await settings(f.team.id)).toEqual(edited)

    const current = await publicEvent(edited.slug)
    expect(current.status).toBe(200)
    expect(await current.json()).toMatchObject({ title: 'Team introduction', team: edited })
    const old = await publicEvent(f.team.slug)
    expect(old.status).toBe(404)
    expect(old.headers.get('location')).toBeNull()
    expect(await old.json()).toMatchObject({ error: 'event_type_not_found' })
  })

  it('rejects a stale form after a concurrent edit and accepts its freshly loaded values', async () => {
    const f = await fixture()
    const changes = await Promise.all([
      update(f.team.id, f.ownerCookie, { name: 'Owner edit', slug: 'owner-address' }, f.team),
      update(f.team.id, f.adminCookie, { name: 'Admin edit', slug: 'admin-address' }, f.team),
    ])
    expect(changes.map((response) => response.status).sort()).toEqual([200, 409])
    const conflict = changes.find((response) => response.status === 409)
    expect(await conflict?.json()).toMatchObject({ code: 'TEAM_SETTINGS_CHANGED' })
    const saved = changes.find((response) => response.status === 200)
    const current = await settings(f.team.id)
    expect(await saved?.json()).toMatchObject(current)

    const retry = await update(f.team.id, f.adminCookie, { name: 'Reloaded edit' }, current)
    expect(retry.status).toBe(200)
    expect(await settings(f.team.id)).toEqual({ ...current, name: 'Reloaded edit' })
  })

  it.each([{ name: 'Changed name' }, { slug: 'changed-address' }])(
    'detects stale settings when only one value changed (%o)',
    async (change: Partial<Settings>) => {
      const f = await fixture()
      const current = { name: f.team.name, slug: f.team.slug, ...change }
      const saved = await update(f.team.id, f.ownerCookie, change, f.team)
      expect(saved.status).toBe(200)

      const refused = await update(f.team.id, f.adminCookie, { name: 'Stale edit' }, f.team)
      expect(refused.status).toBe(409)
      expect(await refused.json()).toMatchObject({ code: 'TEAM_SETTINGS_CHANGED' })
      expect(await settings(f.team.id)).toEqual(current)
    },
  )

  it('requires a valid, complete baseline when one is supplied and preserves existing callers', async () => {
    const f = await fixture()
    const partial = await update(
      f.team.id,
      f.ownerCookie,
      { name: 'Partial' },
      { slug: f.team.slug },
    )
    expect(partial.status).toBe(409)
    expect(await partial.json()).toMatchObject({ code: 'TEAM_SETTINGS_CHANGED' })

    const invalid = await update(
      f.team.id,
      f.ownerCookie,
      { name: 'Invalid baseline' },
      { name: '\0', slug: f.team.slug },
    )
    expect(invalid.status).toBe(409)
    expect(await invalid.json()).toMatchObject({ code: 'TEAM_SETTINGS_CHANGED' })
    expect(await settings(f.team.id)).toEqual({ name: f.team.name, slug: f.team.slug })

    const native = await update(f.team.id, f.ownerCookie, { name: 'Native update' }, {})
    expect(native.status).toBe(200)
    expect(await settings(f.team.id)).toEqual({ name: 'Native update', slug: f.team.slug })
  })

  it('uses the existing role and reserved-slug checks for settings updates', async () => {
    const f = await fixture()
    const attempted = { name: 'Should not save', slug: 'unpublished-address' }
    const stale = { ...f.team, name: 'Older team name' }
    const denied = await update(f.team.id, f.memberCookie, attempted, stale)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: 'TEAM_MANAGEMENT_ACCESS_DENIED' })

    const reserved = await update(f.team.id, f.adminCookie, { ...attempted, slug: 'API' }, f.team)
    expect(reserved.status).toBe(400)
    expect(await reserved.json()).toMatchObject({ code: 'ORGANIZATION_SLUG_RESERVED' })
    expect(await settings(f.team.id)).toEqual({ name: f.team.name, slug: f.team.slug })
  })

  it('lets an owner edit the name of a team with a legacy reserved address', async () => {
    const f = await fixture()
    const legacy = { name: f.team.name, slug: 'privacy' }
    await db.updateTable('auth.organization').set(legacy).where('id', '=', f.team.id).execute()

    const response = await update(f.team.id, f.ownerCookie, { name: 'Renamed legacy team' }, legacy)
    expect(response.status).toBe(200)
    expect(await settings(f.team.id)).toEqual({ name: 'Renamed legacy team', slug: legacy.slug })
  })

  it('returns the same address-in-use error for a PostgreSQL race and an existing claim', async () => {
    const f = await fixture()
    const rival = await createTestTeam(db, [])
    const slug = 'raced-public-address'
    const holder = await owned.pool.connect()
    let pending: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('UPDATE auth.organization SET slug = $1 WHERE id = $2', [slug, rival.id])
      const result = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const blocker = result.rows[0]?.pid
      pending = Promise.resolve(
        update(f.team.id, f.ownerCookie, { name: 'Must not save', slug }, f.team),
      )
      // The rival's uncommitted slug is invisible to the native precheck, but blocks the
      // unique constraint check until that transaction commits.
      await vi.waitFor(
        async () => {
          const result = await owned.pool.query<{ blocked: boolean }>(
            `SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
            ) AS blocked`,
            [blocker],
          )
          expect(result.rows[0]?.blocked).toBe(true)
        },
        { timeout: 3000, interval: 10 },
      )
      await holder.query('COMMIT')

      const raced = await pending
      const taken = await update(f.team.id, f.ownerCookie, { slug }, f.team)
      for (const refused of [raced, taken]) {
        expect(refused.status).toBe(400)
        expect(await refused.json()).toMatchObject({ code: 'ORGANIZATION_SLUG_ALREADY_TAKEN' })
      }
      expect(await settings(f.team.id)).toEqual({ name: f.team.name, slug: f.team.slug })
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await Promise.allSettled(pending ? [pending] : [])
    }
  })
})
