import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Auth, createAuth, createAuthPool } from './index.ts'
import { memberReadPrivacy } from './member-read-privacy.ts'
import { isUuid } from './organizations.ts'
import { teamRoles } from './team-management.ts'
import { teamRoleDenied } from './team-role-policy.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:43841'
const secret = 'synthetic-member-read-privacy-secret-at-least-32-characters'
const signup = { mode: 'open', allowedDomains: [] } as const

describe.skipIf(!serverUrl)('organization member read privacy', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth

  function selectedAuth(privacy = memberReadPrivacy) {
    const selected = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
    const plugin = selected.options.plugins?.find((entry) => entry.id === 'member-read-privacy')
    if (!plugin) throw new Error('Member privacy plugin must be installed')
    Object.assign(plugin, privacy(db))
    return selected
  }

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    auth = selectedAuth()
  })
  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function fixture(role: string, emailVerified = true) {
    const userId = randomUUID()
    const peerId = randomUUID()
    const organizationId = randomUUID()
    const invitedEmail = `${randomUUID()}@invited.example.test`
    await db
      .insertInto('auth.user')
      .values([
        {
          id: userId,
          name: 'Visible member',
          email: `${userId}@example.test`,
          emailVerified,
          image: 'https://images.example.test/private-avatar',
        },
        {
          id: peerId,
          name: 'Visible member',
          email: `${peerId}@example.test`,
          emailVerified: true,
          image: 'https://images.example.test/another-private-avatar',
        },
      ])
      .execute()
    await db
      .insertInto('auth.organization')
      .values({
        id: organizationId,
        name: 'Member privacy team',
        slug: organizationId,
        createdAt: new Date(),
      })
      .execute()
    const members = await db
      .insertInto('auth.member')
      .values([
        { organizationId, userId, role, createdAt: new Date() },
        { organizationId, userId: peerId, role: 'member', createdAt: new Date() },
      ])
      .returning('id')
      .execute()
    await db
      .insertInto('auth.invitation')
      .values({
        organizationId,
        inviterId: userId,
        email: invitedEmail,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .execute()
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId,
        token,
        activeOrganizationId: organizationId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        updatedAt: new Date(),
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      userId,
      peerId,
      organizationId,
      invitedEmail,
      memberIds: members.map(({ id }) => id).sort(),
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>
  interface MemberRead {
    total?: number
    members: { id: string; user: { id: string; name: string; email?: string; image?: string } }[]
  }
  const get = (f: Fixture, path: string, selected = auth) =>
    selected.handler(
      new Request(`${origin}/api/auth/organization/${path}`, { headers: { cookie: f.cookie } }),
    )

  async function verifySummary(f: Fixture, selected = auth) {
    for (const selector of [
      `?organizationId=${f.organizationId}`,
      `?organizationSlug=${f.organizationId}`,
      '',
    ]) {
      for (const endpoint of ['list-members', 'get-full-organization']) {
        const response = await get(f, `${endpoint}${selector}`, selected)
        expect(response.status).toBe(200)
        const body = (await response.json()) as MemberRead
        expect(body.members).toHaveLength(2)
        expect(body).not.toHaveProperty('invitations')
        for (const member of body.members) {
          expect(member.user).toEqual({ id: expect.any(String), name: 'Visible member' })
        }
        if (endpoint === 'list-members') expect(body.total).toBe(2)
      }
    }
    const invitations = await get(
      f,
      `list-invitations?organizationId=${f.organizationId}`,
      selected,
    )
    expect(invitations.status).toBe(403)
    expect(await invitations.json()).toMatchObject({ code: 'TEAM_MANAGEMENT_ACCESS_DENIED' })
  }

  it.each(['owner', 'admin', 'member, admin', 'owner,member'])(
    'retains member emails and invitation access for a verified %s',
    async (role) => {
      const f = await fixture(role)
      for (const endpoint of ['list-members', 'get-full-organization']) {
        const response = await get(f, `${endpoint}?organizationId=${f.organizationId}`)
        expect(response.status).toBe(200)
        const body = (await response.json()) as MemberRead
        expect(body.members.map((member) => member.user.email).sort()).toEqual(
          [`${f.userId}@example.test`, `${f.peerId}@example.test`].sort(),
        )
        if (endpoint === 'list-members') expect(body.total).toBe(2)
        else
          expect(body).toHaveProperty('invitations', [
            expect.objectContaining({ email: f.invitedEmail }),
          ])
      }
      const invitations = await get(f, `list-invitations?organizationId=${f.organizationId}`)
      expect(invitations.status).toBe(200)
      expect(await invitations.json()).toEqual([expect.objectContaining({ email: f.invitedEmail })])
    },
  )

  it.each(['member', 'superadmin', 'owner-helper', 'member,unknown', 'admin,unknown'])(
    'returns only the public summary and no invitations for %s',
    async (role) => {
      await verifySummary(await fixture(role))
    },
  )

  it('requires current verified identity before disclosing management data', async () => {
    await verifySummary(await fixture('owner', false))
  })

  it('uses the current role after a downgrade with the same session cookie', async () => {
    const f = await fixture('admin')
    const before = await get(f, `list-members?organizationId=${f.organizationId}`)
    expect(((await before.json()) as MemberRead).members[0]?.user).toHaveProperty('email')
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', f.organizationId)
      .where('userId', '=', f.userId)
      .execute()
    await verifySummary(f)
  })

  it.each(['admin', 'member'])(
    'preserves %s paging, pending exclusion and empty-member regression responses',
    async (role) => {
      const f = await fixture(role)
      const ids: string[] = []
      for (const offset of [0, 1]) {
        const response = await get(
          f,
          `list-members?organizationId=${f.organizationId}&limit=1&offset=${offset}&sortBy=id&sortDirection=asc`,
        )
        expect(response.status).toBe(200)
        const body = (await response.json()) as MemberRead
        expect(body.total).toBe(2)
        expect(body.members).toHaveLength(1)
        ids.push(body.members[0]?.id as string)
      }
      expect(ids).toEqual(f.memberIds)
      for (const [query, total] of [
        ['offset=2', 2],
        ['offset=99', 2],
        ['filterField=role&filterValue=missing', 0],
      ] as const) {
        const response = await get(f, `list-members?organizationId=${f.organizationId}&${query}`)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ members: [], total })
      }
    },
  )

  it('keeps outsiders denied on the native member list', async () => {
    const f = await fixture('member')
    const other = await fixture('owner')
    for (const endpoint of ['list-members', 'get-full-organization', 'list-invitations']) {
      const response = await get(f, `${endpoint}?organizationId=${other.organizationId}`)
      expect(response.status).toBe(403)
    }
  })

  function sourceCopy(replace?: readonly [string, string]): typeof memberReadPrivacy {
    let source = readFileSync('packages/auth/src/member-read-privacy.ts', 'utf8')
    if (replace) {
      expect(source.includes(replace[0]), 'mutation must match current source').toBe(true)
      source = source.replace(replace[0], replace[1])
    }
    source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
      /\bexport /g,
      '',
    )
    const bindings = {
      createAuthMiddleware,
      getSessionFromCtx,
      isUuid,
      teamRoles,
      teamRoleDenied,
    }
    return new Function(...Object.keys(bindings), `${source}; return memberReadPrivacy`)(
      ...Object.values(bindings),
    ) as typeof memberReadPrivacy
  }

  it('passes the real HTTP assertions with an unmodified privacy source copy', async () => {
    await verifySummary(await fixture('member'), selectedAuth(sourceCopy()))
  })

  it.each([
    {
      name: 'member email projection',
      role: 'member',
      replace: ['user: { id: member.user.id, name: member.user.name },', 'user: member.user,'],
    },
    {
      name: 'full-organization invitation omission',
      role: 'member',
      replace: [
        'const { invitations: _invitations, ...summary } = response',
        'const summary = response',
      ],
    },
    {
      name: 'direct invitation-list permission',
      role: 'member',
      replace: [
        'if (!(await manager(ctx, organizationId))) throw teamRoleDenied()',
        'await manager(ctx, organizationId)',
      ],
    },
    {
      name: 'known-role validation',
      role: 'admin,unknown',
      replace: ["roles.every((role) => ['owner', 'admin', 'member'].includes(role)) &&", 'true &&'],
    },
    {
      name: 'management-role requirement',
      role: 'member',
      replace: ["roles.some((role) => role === 'owner' || role === 'admin')", 'true'],
    },
    {
      name: 'verified-identity requirement',
      role: 'owner',
      emailVerified: false,
      replace: ['if (!actor?.emailVerified) return false', 'if (!actor) return false'],
    },
  ] as const)('detects removal of $name with a real HTTP assertion failure', async (mutation) => {
    const f = await fixture(
      mutation.role,
      'emailVerified' in mutation ? mutation.emailVerified : true,
    )
    await expect(verifySummary(f, selectedAuth(sourceCopy(mutation.replace)))).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
