// TJ-01: exercise the installed organization plugin through Hourmere's HTTP boundary.
import { createHmac, randomBytes } from 'node:crypto'
import { createAuth, createAuthPool, createCallerResolver, type SignupPolicy } from '@hourmere/auth'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4387'
const policy: SignupPolicy = { mode: 'open', allowedDomains: [] }

interface Organization {
  id: string
  name: string
  slug: string
  logo: string | null
  createdAt: string
  metadata?: Record<string, unknown> | string | null
}
interface Member {
  id: string
  organizationId: string
  userId: string
  role: string
  createdAt: string
}

describe.skipIf(!serverUrl)('team organization HTTP contract (Better Auth 1.7.10)', () => {
  let testDb: TestDatabase
  let pool: pg.Pool
  let app: ReturnType<typeof createApp>
  const secret = randomBytes(32).toString('base64')

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    const db = createDb(testDb.pool)
    pool = createAuthPool(testDb.url, policy)
    const auth = createAuth({
      pool,
      db,
      baseURL: origin,
      secret,
      signup: policy,
      mailer: { send: async () => {} },
    })
    app = createApp({
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
    })
  })
  afterAll(async () => {
    await pool?.end()
    await testDb?.drop()
  })

  // Seed synthetic verified sessions; actual sign-in/no-auto-join is covered separately.
  async function actor(email: string) {
    const { rows: users } = await testDb.pool.query<{ id: string }>(
      `INSERT INTO auth."user" (name, email, "emailVerified")
       VALUES ('Contract user', $1, true) RETURNING id`,
      [email],
    )
    const id = users[0]?.id as string
    const token = randomBytes(24).toString('base64url')
    await testDb.pool.query(
      `INSERT INTO auth.session ("expiresAt", token, "updatedAt", "userId")
       VALUES (now() + interval '1 hour', $1, now(), $2)`,
      [token, id],
    )
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }
  function post(path: string, cookie: string, body: unknown) {
    return app.request(`/api/auth/organization/${path}`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  const get = (path: string, cookie: string) =>
    app.request(`/api/auth/organization/${path}`, { headers: { cookie } })
  async function active(userId: string) {
    const { rows } = await testDb.pool.query<{ activeOrganizationId: string | null }>(
      `SELECT "activeOrganizationId" FROM auth.session WHERE "userId" = $1`,
      [userId],
    )
    return rows[0]?.activeOrganizationId
  }
  async function create(cookie: string, slug: string, extra: Record<string, unknown> = {}) {
    const response = await post('create', cookie, { name: 'Contract team', slug, ...extra })
    expect(response.status).toBe(200)
    return (await response.json()) as Organization & { members: Member[] }
  }

  it('creates an owner membership, returns members, and honors keepCurrentActiveOrganization', async () => {
    const owner = await actor('create@contract.example')
    const other = await actor('other@contract.example')
    const team = await create(owner.cookie, 'contract-create', {
      userId: other.id,
      metadata: { purpose: 'characterization' },
    })
    expect(team).toEqual({
      id: expect.any(String),
      name: 'Contract team',
      slug: 'contract-create',
      logo: null,
      createdAt: expect.any(String),
      metadata: { purpose: 'characterization' },
      members: [
        {
          id: expect.any(String),
          organizationId: team.id,
          userId: owner.id,
          role: 'owner',
          createdAt: expect.any(String),
        },
      ],
    })
    expect(await active(owner.id)).toBe(team.id)
    const kept = await create(owner.cookie, 'contract-keep', {
      keepCurrentActiveOrganization: true,
    })
    expect(kept.members[0]?.userId).toBe(owner.id)
    expect(await active(owner.id)).toBe(team.id)
  })

  it('lists only memberships and requires membership to switch by ID or slug', async () => {
    const owner = await actor('switch-owner@contract.example')
    const member = await actor('switch-member@contract.example')
    const outsider = await actor('switch-outsider@contract.example')
    const team = await create(owner.cookie, 'contract-switch')
    await testDb.pool.query(
      `INSERT INTO auth.member ("organizationId", "userId", role, "createdAt")
       VALUES ($1, $2, 'member', now())`,
      [team.id, member.id],
    )
    for (const user of [owner, member]) {
      const listed = await get('list', user.cookie)
      expect(listed.status).toBe(200)
      expect(await listed.json()).toEqual([
        {
          id: team.id,
          name: team.name,
          slug: team.slug,
          logo: null,
          createdAt: team.createdAt,
          metadata: null,
        },
      ])
    }
    const hidden = await get('list', outsider.cookie)
    expect(await hidden.json()).toEqual([])
    for (const body of [{ organizationId: team.id }, { organizationSlug: team.slug }]) {
      const switched = await post('set-active', member.cookie, body)
      expect(switched.status).toBe(200)
      expect(await switched.json()).toMatchObject({ id: team.id, slug: team.slug })
      expect(await active(member.id)).toBe(team.id)
      const forbidden = await post('set-active', outsider.cookie, body)
      expect(forbidden.status).toBe(403)
      expect(await forbidden.json()).toMatchObject({
        code: 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION',
      })
      expect(await active(outsider.id)).toBeNull()
    }
    const cleared = await post('set-active', member.cookie, { organizationId: null })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toBeNull()
    expect(await active(member.id)).toBeNull()
  })

  it('returns a paged member/user projection to every member role and refuses outsiders', async () => {
    const owner = await actor('list-owner@contract.example')
    const team = await create(owner.cookie, 'contract-members')
    for (const role of ['admin', 'member']) {
      const user = await actor(`list-${role}@contract.example`)
      await testDb.pool.query(
        `INSERT INTO auth.member ("organizationId", "userId", role, "createdAt")
         VALUES ($1, $2, $3, now())`,
        [team.id, user.id, role],
      )
      const response = await get(
        `list-members?organizationId=${team.id}&limit=1&offset=0&sortBy=createdAt&sortDirection=asc`,
        user.cookie,
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        total: role === 'admin' ? 2 : 3,
        members: [
          {
            ...team.members[0],
            user: {
              id: owner.id,
              name: 'Contract user',
              email: 'list-owner@contract.example',
              image: null,
            },
          },
        ],
      })
    }
    const outsider = await actor('list-outsider@contract.example')
    const response = await get(`list-members?organizationId=${team.id}`, outsider.cookie)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      code: 'YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION',
    })
  })
})
