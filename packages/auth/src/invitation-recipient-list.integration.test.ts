import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAuth, createAuthPool } from './index.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:43831'
const secret = randomBytes(32).toString('base64')
const signup = { mode: 'open', allowedDomains: [] } as const
type Entry = 'HTTP' | 'trusted auth.api'
type Mutation = 'filter' | 'team' | 'inviter'

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

async function sourceCopy(mutation?: Mutation): Promise<typeof createAuth> {
  const location = new URL('./member-read-privacy.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  const guards = {
    filter: ['validIds.has(invitation.id)', 'true'],
    team: [".onRef('m.organizationId', '=', 'i.organizationId')", ''],
    inviter: [".onRef('m.userId', '=', 'i.inviterId')", ''],
  } as const
  for (const [guard] of Object.values(guards)) {
    expect(source.includes(guard), 'mutation matches the recipient-list membership check').toBe(
      true,
    )
  }
  if (mutation) {
    const [guard, replacement] = guards[mutation]
    source = source.replace(guard, replacement)
  }
  const authLocation = new URL('./index.ts', import.meta.url)
  return (
    await import(
      moduleUrl(readFileSync(authLocation, 'utf8'), authLocation, {
        './member-read-privacy.ts': moduleUrl(source, location),
      })
    )
  ).createAuth
}

describe.skipIf(!serverUrl)('native recipient invitation lists require current inviters', () => {
  let owned: TestDatabase
  let db: Db
  let pool: ReturnType<typeof createAuthPool>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'inviter_list' })
    db = createDb(owned.pool)
    pool = createAuthPool(owned.url, signup)
  })
  beforeEach(async () => {
    await db.deleteFrom('auth.organization').execute()
    await db.deleteFrom('auth.user').execute()
  })
  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      await owned?.drop()
    }
  })

  function instance(factory = createAuth) {
    return factory({ pool, db, baseURL: origin, secret, signup, mailer: { send: async () => {} } })
  }

  async function fixture() {
    const team = await db
      .insertInto('auth.organization')
      .values({ name: 'Synthetic recipient-list team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    const otherTeam = await db
      .insertInto('auth.organization')
      .values({ name: 'Synthetic other team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    const users = []
    for (const role of ['owner', 'admin', 'admin', null, null] as const) {
      const user = await db
        .insertInto('auth.user')
        .values({
          name: 'Synthetic recipient-list account',
          email: `${randomUUID()}@example.test`,
          emailVerified: true,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      if (role) {
        await db
          .insertInto('auth.member')
          .values({ userId: user.id, organizationId: team.id, role, createdAt: new Date() })
          .execute()
      }
      users.push(user)
    }
    const [owner, departed, demoted, recipient, otherRecipient] = users as [
      (typeof users)[number],
      (typeof users)[number],
      (typeof users)[number],
      (typeof users)[number],
      (typeof users)[number],
    ]
    // Membership elsewhere must not keep the original team's invitation valid.
    await db
      .insertInto('auth.member')
      .values({
        userId: departed.id,
        organizationId: otherTeam.id,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    const invitations = []
    for (const inviter of [owner, departed, demoted]) {
      invitations.push(
        await db
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
          .executeTakeFirstOrThrow(),
      )
    }
    await db
      .insertInto('auth.invitation')
      .values({
        organizationId: team.id,
        inviterId: owner.id,
        email: otherRecipient.email,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .execute()
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId: recipient.id,
        token,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      team,
      owner,
      departed,
      demoted,
      recipient,
      otherRecipient,
      invitations,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function list(auth: ReturnType<typeof createAuth>, f: Fixture, entry: Entry, query = '') {
    const headers = new Headers({ cookie: f.cookie })
    return entry === 'HTTP'
      ? auth.handler(
          new Request(`${origin}/api/auth/organization/list-user-invitations${query}`, { headers }),
        )
      : auth.api.listUserInvitations({ headers, asResponse: true })
  }

  async function departAndDemote(f: Fixture) {
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.departed.id)
      .execute()
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.demoted.id)
      .execute()
  }

  async function assertCurrentList(auth: ReturnType<typeof createAuth>, f: Fixture, entry: Entry) {
    const response = await list(auth, f, entry)
    expect(response.status).toBe(200)
    const invitations = (await response.json()) as {
      id: string
      inviterId: string
      status: string
    }[]
    expect(
      invitations.map((invitation) => invitation.inviterId).sort(),
      'recipient discovery omits void invitations and retains a demoted current inviter',
    ).toEqual([f.owner.id, f.demoted.id].sort())
    expect(invitations.every((invitation) => invitation.status === 'pending')).toBe(true)
    expect(Object.keys(invitations[0] ?? {}).sort()).toEqual(
      [
        'id',
        'organizationId',
        'email',
        'role',
        'status',
        'expiresAt',
        'createdAt',
        'inviterId',
        'organizationName',
      ].sort(),
    )
  }

  it.each<Entry>(['HTTP', 'trusted auth.api'])(
    'filters departed inviters through %s without rewriting invitations',
    async (entry) => {
      const f = await fixture()
      const auth = instance()
      expect(await (await list(auth, f, entry)).json()).toHaveLength(3)
      await departAndDemote(f)
      await assertCurrentList(auth, f, entry)
      expect(
        await db
          .selectFrom('auth.invitation')
          .selectAll()
          .where(
            'id',
            'in',
            f.invitations.map((invitation) => invitation.id),
          )
          .orderBy('id')
          .execute(),
      ).toEqual([...f.invitations].sort((a, b) => a.id.localeCompare(b.id)))
    },
  )

  it('preserves native recipient and email-proof restrictions', async () => {
    const f = await fixture()
    const auth = instance()
    expect((await list(auth, f, 'HTTP', `?email=${f.otherRecipient.email}`)).status).toBe(400)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', f.recipient.id)
      .execute()
    expect((await list(auth, f, 'HTTP')).status).toBe(403)
    expect((await list(auth, f, 'trusted auth.api')).status).toBe(403)
  })

  it('answers an empty list when every recipient invitation is void', async () => {
    const f = await fixture()
    await db.deleteFrom('auth.member').where('organizationId', '=', f.team.id).execute()
    const response = await list(instance(), f, 'HTTP')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  it('preserves an empty native result', async () => {
    const f = await fixture()
    await db.deleteFrom('auth.invitation').execute()
    for (const entry of ['HTTP', 'trusted auth.api'] as const) {
      const response = await list(instance(), f, entry)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([])
    }
  })

  it.each<Mutation>(['filter', 'team', 'inviter'])(
    'detects removal of the %s membership check in a production source copy',
    async (mutation) => {
      const f = await fixture()
      await departAndDemote(f)
      const broken = instance(await sourceCopy(mutation))
      await expect(assertCurrentList(broken, f, 'HTTP')).rejects.toThrow(
        'recipient discovery omits void invitations',
      )
      const restored = instance(await sourceCopy())
      await assertCurrentList(restored, f, 'HTTP')
      await assertCurrentList(restored, f, 'trusted auth.api')
    },
  )
})
