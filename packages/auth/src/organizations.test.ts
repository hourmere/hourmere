import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ensurePersonalOrganization,
  personalOrganizationName,
  slugCandidates,
  slugify,
} from './organizations.ts'

describe('personal organization names', () => {
  it('prefers the user name and falls back to the email local part', () => {
    expect(personalOrganizationName({ name: ' Grace Hopper ', email: 'g@example.com' })).toBe(
      'Grace Hopper',
    )
    expect(personalOrganizationName({ name: '', email: 'grace.h+cal@example.com' })).toBe(
      'grace.h+cal',
    )
  })

  it('slugifies to lowercase ASCII with single hyphens', () => {
    expect(slugify('Grace Hopper')).toBe('grace-hopper')
    expect(slugify('grace.h+cal')).toBe('grace-h-cal')
    expect(slugify('Zoë Ångström')).toBe('zoe-angstrom')
    expect(slugify('--  --')).toBe('user')
    expect(slugify('李雷')).toBe('user')
    expect(slugify('a'.repeat(40))).toHaveLength(32)
  })

  it('never slugifies to a reserved name, whatever the case or spelling', () => {
    expect(slugify('Admin')).toBe('admin-user')
    expect(slugify('API')).toBe('api-user')
    expect(slugify('Sign In')).toBe('sign-in-user')
    expect(slugify('Event Types')).toBe('event-types-user')
    expect(slugify('Booking!')).toBe('booking-user')
    expect(slugify('Ádmin')).toBe('admin-user')
    // Close to a reserved name is fine.
    expect(slugify('Admins')).toBe('admins')
    expect(slugify('Ada')).toBe('ada')
  })

  it('offers no reserved slug among the candidates', () => {
    expect([...slugCandidates('support', 3)]).toEqual([
      expect.stringMatching(/^support-[a-z0-9]{6}$/),
      expect.stringMatching(/^support-[a-z0-9]{6}$/),
    ])
    expect([...slugCandidates('ada', 2)]).toEqual(['ada', expect.stringMatching(/^ada-/)])
  })
})

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('ensurePersonalOrganization', () => {
  let testDb: TestDatabase
  let db: Db
  let seq = 0

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  async function user(name: string, email = `user${++seq}@example.com`) {
    const row = await db
      .insertInto('auth.user')
      .values({ name, email, emailVerified: true })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  }

  const counts = async (userId: string) => {
    const one = async (sql: string) =>
      (await testDb.pool.query<{ n: number }>(sql, [userId])).rows[0]?.n
    return {
      markers: await one(
        'SELECT count(*)::int AS n FROM personal_organizations WHERE user_id = $1',
      ),
      members: await one(`SELECT count(*)::int AS n FROM auth.member WHERE "userId" = $1`),
    }
  }

  it('creates the organization, an owner membership and the marker together', async () => {
    const id = await user('Grace Hopper')
    const orgId = await ensurePersonalOrganization(db, id)
    const org = await db
      .selectFrom('auth.organization as o')
      .innerJoin('auth.member as m', 'm.organizationId', 'o.id')
      .innerJoin('personal_organizations as p', 'p.organization_id', 'o.id')
      .select(['o.name', 'o.slug', 'm.role', 'm.userId', 'p.user_id'])
      .where('o.id', '=', orgId)
      .executeTakeFirstOrThrow()
    expect(org).toEqual({
      name: 'Grace Hopper',
      slug: 'grace-hopper',
      role: 'owner',
      userId: id,
      user_id: id,
    })
  })

  it('returns the same organization on every call, also when called concurrently', async () => {
    const id = await user('Concurrent')
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => ensurePersonalOrganization(db, id)),
    )
    expect(new Set(ids).size).toBe(1)
    expect(await ensurePersonalOrganization(db, id)).toBe(ids[0])
    expect(await counts(id)).toEqual({ markers: 1, members: 1 })
  })

  it('picks another slug when the plain one is taken', async () => {
    const first = await ensurePersonalOrganization(db, await user('Taken'))
    const second = await ensurePersonalOrganization(db, await user('Taken'))
    const slugs = await db
      .selectFrom('auth.organization')
      .select('slug')
      .where('id', 'in', [first, second])
      .execute()
    expect(slugs.map((s) => s.slug).sort()).toEqual([
      'taken',
      expect.stringMatching(/^taken-[a-z0-9]{6}$/),
    ])
  })

  it('gives a user named like a reserved path a slug that is not reserved', async () => {
    const orgId = await ensurePersonalOrganization(db, await user('Support'))
    const org = await db
      .selectFrom('auth.organization')
      .select('slug')
      .where('id', '=', orgId)
      .executeTakeFirstOrThrow()
    expect(org.slug).toBe('support-user')
  })

  it('refuses a user that does not exist', async () => {
    await expect(
      ensurePersonalOrganization(db, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow('not found')
  })
})
