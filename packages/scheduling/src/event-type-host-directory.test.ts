import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createAuth, createAuthPool, type Principal, removeTeamMember } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { catalogPage, checkedCatalogPage } from './catalog-page.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import {
  createEventType,
  getEventType,
  listEventTypeHosts,
  type SchedulingType,
  updateEventType,
} from './event-types.ts'
import { isUuid } from './internal.ts'
import { leaveTeamMember } from './member-leave.ts'
import { createTestTeam, createTestUser, type TestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4387'
const secret = 'synthetic-host-directory-session-secret-000000000000'
type Directory = typeof listEventTypeHosts
type Replacement = readonly [string, string]
interface SourceCopy {
  directory: Directory
  hosts: (value: unknown, mode: string, personalOwnerId: string | null) => string[]
  write: (db: Db, ctx: ServiceContext, row: { owner_user_id: null }) => Promise<void>
}

/** Mutate an isolated source copy; the checked-in service and DB guards stay intact. */
function sourceCopy(replacement?: Replacement): SourceCopy {
  let source = readFileSync('packages/scheduling/src/event-types.ts', 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = { DomainError, catalogPage, checkedCatalogPage, isUuid }
  return new Function(
    ...Object.keys(bindings),
    `${source}; return { directory: listEventTypeHosts, hosts: validHosts, write: assertCanWrite }`,
  )(...Object.values(bindings)) as SourceCopy
}

describe.skipIf(!serverUrl)('team event host directory and assignment boundaries', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'host_directory' })
    db = createDb(owned.pool)
    // One reused auth pool (and its bounded lock pool), closed before dropping the DB.
    authPool = createAuthPool(owned.url, { mode: 'open', allowedDomains: [] })
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup: { mode: 'open', allowedDomains: [] },
      mailer: { send: async () => {} },
    })
  })
  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function fixture() {
    const owner = await createTestUser(db, 'Directory owner')
    const member = await createTestUser(db, 'Current member')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    return { owner, member, team, ctx: testContext(db, team.as(owner)) }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function session(principal: Principal) {
    const token = randomBytes(24).toString('base64url')
    const { id: sessionId } = await db
      .insertInto('auth.session')
      .values({
        userId: principal.user.id,
        token,
        activeOrganizationId: principal.organization.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      principal: { ...principal, kind: 'session', sessionId } as const,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  async function verifyDirectory(read: Directory, f: Fixture) {
    const memberships = await db
      .selectFrom('auth.member as m')
      .innerJoin('auth.user as u', 'u.id', 'm.userId')
      .select(['u.id', 'm.id as memberId', 'u.name'])
      .where('m.organizationId', '=', f.team.id)
      .where('u.emailVerified', '=', true)
      .orderBy('u.id')
      .execute()
    const page = await read(f.ctx, { limit: 100 })
    expect(page).toEqual({ data: memberships, nextAfter: null })
    for (const member of page.data)
      expect(Object.keys(member).sort()).toEqual(['id', 'memberId', 'name'])
  }

  it('links each directory user to the stable team membership without private fields', async () => {
    const f = await fixture()
    await verifyDirectory(listEventTypeHosts, f)
    const first = await listEventTypeHosts(f.ctx, { limit: 1 })
    const second = await listEventTypeHosts(f.ctx, { limit: 1, after: first.nextAfter as string })
    expect([...first.data, ...second.data].map((member) => member.id)).toEqual(
      [f.owner.id, f.member.id].sort(),
    )
    expect(second.nextAfter).toBeNull()
  })

  it('excludes pending invitations and lists the verified member after actual acceptance', async () => {
    const f = await fixture()
    const invited = await createTestUser(db, 'Invited host')
    const { id: invitationId } = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: f.team.id,
        inviterId: f.owner.id,
        email: invited.email,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const before = await listEventTypeHosts(f.ctx)
    expect(before.data.map((member) => member.id)).not.toContain(invited.id)
    await expect(
      createEventType(f.ctx, {
        slug: 'pending-invite',
        title: 'Pending invite',
        durationMinutes: 30,
        hosts: [{ userId: invited.id }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_hosts' })
    const actor = await session(invited.principal)
    const accepted = await auth.handler(
      new Request(`${origin}/api/auth/organization/accept-invitation`, {
        method: 'POST',
        headers: { origin, cookie: actor.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ invitationId }),
      }),
    )
    expect(accepted.status).toBe(200)
    const joined = await listEventTypeHosts(f.ctx)
    expect(joined.data.map((member) => member.id)).toContain(invited.id)
    const membership = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', invited.id)
      .executeTakeFirstOrThrow()
    expect(joined.data.find((member) => member.id === invited.id)?.memberId).toBe(membership.id)
  })

  it('omits a member immediately after safe self departure', async () => {
    const f = await fixture()
    expect((await listEventTypeHosts(f.ctx)).data.map((member) => member.id)).toContain(f.member.id)
    const actor = await session(f.team.as(f.member))
    await leaveTeamMember(testContext(db, actor.principal), {
      teamId: f.team.id,
      expectedOrganizationId: f.team.id,
    })
    expect((await listEventTypeHosts(f.ctx)).data.map((member) => member.id)).not.toContain(
      f.member.id,
    )
  })

  it('omits an administratively removed host on the next load while preserving saved hosts', async () => {
    const f = await fixture()
    const event = await createEventType(f.ctx, {
      slug: 'saved-host',
      title: 'Saved host',
      durationMinutes: 30,
      hosts: [{ userId: f.member.id }],
    })
    const actor = await session(f.team.as(f.owner))
    await removeTeamMember(db, actor.principal, {
      teamId: f.team.id,
      memberUserId: f.member.id,
      expectedOrganizationId: f.team.id,
    })
    expect((await listEventTypeHosts(f.ctx)).data.map((member) => member.id)).not.toContain(
      f.member.id,
    )
    const saved = await getEventType(f.ctx, event.id)
    expect(saved.hosts).toEqual(event.hosts)
    expect(saved.isActive).toBe(false)
    expect(
      (await updateEventType(f.ctx, event.id, { title: 'Coordinate replacement' })).hosts,
    ).toEqual(event.hosts)
    await expect(updateEventType(f.ctx, event.id, { hosts: event.hosts })).rejects.toMatchObject({
      code: 'invalid_hosts',
    })
  })

  it('excludes unverified members without rewriting saved assignments', async () => {
    const f = await fixture()
    const event = await createEventType(f.ctx, {
      slug: 'verification',
      title: 'Verification',
      durationMinutes: 30,
      hosts: [{ userId: f.member.id }],
    })
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', f.member.id)
      .execute()
    expect((await listEventTypeHosts(f.ctx)).data.map((member) => member.id)).not.toContain(
      f.member.id,
    )
    expect((await getEventType(f.ctx, event.id)).hosts).toEqual(event.hosts)
    await expect(updateEventType(f.ctx, event.id, { hosts: event.hosts })).rejects.toMatchObject({
      code: 'invalid_hosts',
    })
  })

  it('rejects ordinary member assignment changes even when that member hosts the event', async () => {
    const f = await fixture()
    const event = await createEventType(f.ctx, {
      slug: 'member-host',
      title: 'Member host',
      durationMinutes: 30,
      hosts: [{ userId: f.member.id }],
    })
    await expect(
      updateEventType(testContext(db, f.team.as(f.member)), event.id, {
        hosts: [{ userId: f.owner.id }],
      }),
    ).rejects.toMatchObject({ kind: 'forbidden', code: 'insufficient_role' })
    expect((await getEventType(f.ctx, event.id)).hosts).toEqual(event.hosts)
  })

  it.each([
    ['individual', 1, 1],
    ['collective', 2, 8],
    ['round_robin', 1, 8],
  ] as const)('keeps %s host limits at %i–%i on create and update', async (mode, min, max) => {
    const f = await fixture()
    const users: TestUser[] = [f.owner, f.member]
    for (let index = users.length; index < 9; index++) {
      const user = await createTestUser(db, `Boundary host ${index}`)
      users.push(user)
      await db
        .insertInto('auth.member')
        .values({
          organizationId: f.team.id,
          userId: user.id,
          role: 'member',
          createdAt: new Date(),
        })
        .execute()
    }
    const hosts = (count: number) => users.slice(0, count).map((user) => ({ userId: user.id }))
    const create = (count: number) =>
      createEventType(f.ctx, {
        slug: `${mode.replace('_', '-')}-${count}`,
        title: 'Host boundary',
        durationMinutes: 30,
        schedulingType: mode,
        hosts: hosts(count),
      })
    const event = await create(min)
    expect(event.hosts).toHaveLength(min)
    if (max !== min) expect((await create(max)).hosts).toHaveLength(max)
    expect((await updateEventType(f.ctx, event.id, { hosts: hosts(max) })).hosts).toHaveLength(max)
    for (const count of [min - 1, max + 1]) {
      await expect(create(count)).rejects.toMatchObject({ code: 'invalid_hosts' })
      await expect(updateEventType(f.ctx, event.id, { hosts: hosts(count) })).rejects.toMatchObject(
        { code: 'invalid_hosts' },
      )
    }
    expect((await getEventType(f.ctx, event.id)).hosts).toHaveLength(max)
  })

  it.each([
    [
      'membership ID projection',
      ".select(['u.id', 'm.id as memberId', 'u.name'])",
      ".select(['u.id', 'u.name'])",
    ],
    [
      'current team membership',
      ".where('m.organizationId', '=', ctx.principal.organization.id)\n    .where('u.emailVerified', '=', true)\n  if (after",
      ".where('u.emailVerified', '=', true)\n  if (after",
    ],
    ['verified identity', ".where('u.emailVerified', '=', true)\n  if (after", '\n  if (after'],
  ] as const)('detects a source-copy mutation removing %s', async (_, before, after) => {
    const f = await fixture()
    const unverified = await createTestUser(db, 'Unverified member')
    await db
      .insertInto('auth.member')
      .values({
        organizationId: f.team.id,
        userId: unverified.id,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', unverified.id)
      .execute()
    await verifyDirectory(sourceCopy().directory, f)
    await expect(verifyDirectory(sourceCopy([before, after]).directory, f)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('detects a source-copy mutation removing the directory role check', async () => {
    const f = await fixture()
    const ctx = testContext(db, f.team.as(f.member))
    const verify = async (read: Directory) => {
      await expect(read(ctx)).rejects.toMatchObject({ code: 'insufficient_role' })
    }
    await verify(sourceCopy().directory)
    await expect(
      verify(
        sourceCopy([
          'if (personalOwnerId !== ctx.principal.user.id && !canManageTeam) throw insufficientRole()',
          'if (false) throw insufficientRole()',
        ]).directory,
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects a source-copy mutation removing the assignment role check', async () => {
    const f = await fixture()
    const ctx = testContext(db, f.team.as(f.member))
    const verify = async (write: SourceCopy['write']) => {
      await expect(write(db, ctx, { owner_user_id: null })).rejects.toMatchObject({
        code: 'insufficient_role',
      })
    }
    await verify(sourceCopy().write)
    await expect(
      verify(
        sourceCopy([
          'if (!(await access(db, ctx, lock)).canManageTeam) throw insufficientRole()',
          'if (false) throw insufficientRole()',
        ]).write,
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it.each([
    [
      'individual maximum',
      'individual',
      2,
      "value.length > (mode === 'individual' ? 1 : 8)",
      "value.length > (mode === 'individual' ? 2 : 8)",
    ],
    [
      'collective minimum',
      'collective',
      1,
      "value.length < (mode === 'collective' ? 2 : 1)",
      'value.length < 1',
    ],
    [
      'round-robin minimum',
      'round_robin',
      0,
      "value.length < (mode === 'collective' ? 2 : 1)",
      "value.length < (mode === 'collective' ? 2 : 0)",
    ],
    [
      'pool maximum',
      'round_robin',
      9,
      "value.length > (mode === 'individual' ? 1 : 8)",
      "value.length > (mode === 'individual' ? 1 : 9)",
    ],
  ] as const)(
    'detects a source-copy mutation weakening the %s',
    async (_, mode: SchedulingType, count, before, after) => {
      const users = Array.from({ length: count }, () => ({ userId: crypto.randomUUID() }))
      const verify = async (validate: SourceCopy['hosts']) => {
        await expect(
          Promise.resolve().then(() => validate(users, mode, null)),
        ).rejects.toMatchObject({ code: 'invalid_hosts' })
      }
      await verify(sourceCopy().hosts)
      await expect(verify(sourceCopy([before, after]).hosts)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )
})
