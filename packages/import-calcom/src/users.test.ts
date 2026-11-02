import { describe, expect, it } from 'vitest'
import { checkSourceMutation, required } from './mutation-testing.ts'
import type { SourceRow, SourceSnapshot, TargetContext } from './types.ts'
import { matchIdentityRows, parseUsers } from './users.ts'

const targetId = '019a4321-1234-7000-8000-000000000001'
export const target: TargetContext = {
  users: [
    {
      id: targetId,
      email: ' Alice@example.com ',
      emailVerified: true,
      personalOrganizationId: '019a4321-1234-7000-8000-000000000002',
      authorized: true,
    },
  ],
  occupiedHandles: [],
  occupiedSlugs: [],
  busy: [],
}
const user = (): SourceRow => ({
  id: 1,
  email: 'alice@EXAMPLE.com',
  emailVerified: '2026-01-01T00:00:00.000Z',
  username: 'alice',
  timeZone: 'America/Los_Angeles',
  locale: null,
  organizationId: null,
  movedToProfileId: null,
  bufferTime: 0,
})
const snapshot = (users = [user()]): SourceSnapshot => ({
  sourceVersion: 'cal.diy-a5ee96f77edd',
  schemaFingerprint: 'a'.repeat(64),
  cutoff: '2026-11-01T00:00:00.000Z',
  extractedAt: '2026-11-01T00:00:00.000Z',
  selectedUserIds: [1],
  tables: { users },
})
describe('verified identity and profile proposals', () => {
  it('matches only trim+lowercase and never creates an account', () => {
    expect(matchIdentityRows([user()], target.users)).toEqual([1])
    expect(
      matchIdentityRows([{ ...user(), email: 'alice+alias@example.com' }], target.users),
    ).toEqual([])
    expect(matchIdentityRows([{ ...user(), email: 'a.lice@example.com' }], target.users)).toEqual(
      [],
    )
    const problems = [] as Parameters<typeof parseUsers>[2]
    const matched = parseUsers(snapshot(), target, problems)
    expect(matched.get(1)).toMatchObject({
      targetUserId: targetId,
      profileAction: 'propose',
      profile: { handle: 'alice', timeZone: 'America/Los_Angeles', locale: 'en' },
    })
    expect(problems.map((p) => p.code)).toContain('user_locale_defaulted')
  })
  it.each(['emailVerified', 'authorized', 'personalOrganizationId'] as const)(
    'requires target %s',
    (field) => {
      const t = structuredClone(target)
      Object.assign(required(t.users[0]), {
        [field]: field === 'personalOrganizationId' ? null : false,
      })
      expect(matchIdentityRows([user()], t.users)).toEqual([])
    },
  )
  it('blocks unverified source and duplicate normalized identities on both ends', () => {
    expect(matchIdentityRows([{ ...user(), emailVerified: null }], target.users)).toEqual([])
    expect(matchIdentityRows([user(), { ...user(), id: 2 }], target.users)).toEqual([])
    expect(
      matchIdentityRows(
        [user()],
        [
          ...target.users,
          { ...required(target.users[0]), id: '019a4321-1234-7000-8000-000000000003' },
        ],
      ),
    ).toEqual([])
    expect(
      matchIdentityRows(
        [user(), { ...user(), id: 2, email: 'other@example.com' }],
        [...target.users, { ...required(target.users[0]), email: 'other@example.com' }],
      ),
    ).toEqual([])
  })
  it.each([
    { organizationId: 1 },
    { movedToProfileId: 3 },
    { timeZone: 'Invalid/Zone' },
    { username: 'admin' },
    { username: 'a'.repeat(41) },
    { locale: 'invalid_locale' },
  ])('blocks invalid scope or profile %j', (change) => {
    const problems = [] as Parameters<typeof parseUsers>[2]
    expect(parseUsers(snapshot([{ ...user(), ...change }]), target, problems).size).toBe(0)
    expect(problems.some((p) => p.severity === 'import_blocker')).toBe(true)
  })
  it('preserves existing profile, blocks collisions and reports nonzero user buffers', () => {
    const existing = structuredClone(target)
    required(existing.users[0]).profile = { handle: 'kept', timeZone: 'UTC', locale: 'zh-CN' }
    expect(parseUsers(snapshot(), existing, []).get(1)).toMatchObject({
      profileAction: 'preserve',
      profile: { handle: 'kept' },
    })
    expect(parseUsers(snapshot(), { ...target, occupiedHandles: ['alice'] }, []).size).toBe(0)
    const problems = [] as Parameters<typeof parseUsers>[2]
    parseUsers(snapshot([{ ...user(), bufferTime: 10 }]), target, problems)
    expect(problems.map((p) => p.code)).toContain('user_buffer_unmapped')
  })
  it('never includes source emails, names or invalid values in problems', () => {
    const problems = [] as Parameters<typeof parseUsers>[2]
    parseUsers(
      snapshot([{ ...user(), email: 'private-secret@example.com', name: 'private-secret' }]),
      target,
      problems,
    )
    expect(JSON.stringify(problems)).not.toContain('private-secret')
  })
})

it('kills source-copy identity, authorization, scope and collision mutations', async () => {
  const source = new URL('./users.ts', import.meta.url)
  const identity = (module: Record<string, unknown>) =>
    module.matchIdentityRows as typeof matchIdentityRows
  const profiles = (module: Record<string, unknown>) => module.parseUsers as typeof parseUsers
  await checkSourceMutation(source, '!validInstant(row.emailVerified)', 'false', identity, (run) =>
    expect(run([{ ...user(), emailVerified: null }], target.users)).toEqual([]),
  )
  await checkSourceMutation(source, '!target?.emailVerified', 'false', identity, (run) =>
    expect(run([user()], [{ ...required(target.users[0]), emailVerified: false }])).toEqual([]),
  )
  await checkSourceMutation(source, '!target.authorized', 'false', identity, (run) =>
    expect(run([user()], [{ ...required(target.users[0]), authorized: false }])).toEqual([]),
  )
  await checkSourceMutation(
    source,
    "sources.filter((s) => typeof s.email === 'string' && normalizeEmail(s.email) === email).length !== 1",
    'false',
    identity,
    (run) => expect(run([user(), { ...user(), id: 2 }], target.users)).toEqual([]),
  )
  await checkSourceMutation(source, 'row.organizationId != null', 'false', profiles, (run) =>
    expect(run(snapshot([{ ...user(), organizationId: 2 }]), target, []).size).toBe(0),
  )
  await checkSourceMutation(source, 'isReservedName(handle)', 'false', profiles, (run) =>
    expect(run(snapshot([{ ...user(), username: 'admin' }]), target, []).size).toBe(0),
  )
  await checkSourceMutation(
    source,
    'target.occupiedHandles.some((h) => h.toLowerCase() === handle)',
    'false',
    profiles,
    (run) => expect(run(snapshot(), { ...target, occupiedHandles: ['alice'] }, []).size).toBe(0),
  )
})

it('kills a source-copy many-source-to-one-target identity mutation', async () => {
  await checkSourceMutation(
    new URL('./users.ts', import.meta.url),
    'targets.filter((t) => t.id === target?.id).length !== 1',
    'false',
    (m) => m.matchIdentityRows as typeof matchIdentityRows,
    (run) =>
      expect(
        run(
          [user(), { ...user(), id: 2, email: 'other@example.com' }],
          [...target.users, { ...required(target.users[0]), email: 'other@example.com' }],
        ),
      ).toEqual([]),
  )
})
