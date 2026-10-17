import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  getProfile,
  type ProfileInput,
  putProfile,
  RESERVED_HANDLES,
  updateDisplayName,
} from './profile.ts'
import { createTestUser, domainError, type TestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('profile service', () => {
  let testDb: TestDatabase
  let db: Db

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  const ctx = (user: TestUser) => testContext(db, user.principal)
  const input = (overrides: Partial<ProfileInput> = {}): ProfileInput => ({
    handle: `ada-${Math.random().toString(36).slice(2, 10)}`,
    timeZone: 'Europe/Berlin',
    locale: 'en',
    ...overrides,
  })

  it('updates only the caller name before onboarding, preserving identity and timestamps', async () => {
    const a = await createTestUser(db, 'Old name')
    const b = await createTestUser(db, 'Peer name')
    const now = Temporal.Instant.from('2026-10-16T12:00:00Z')
    const before = await db
      .selectFrom('auth.user')
      .select(['email', 'emailVerified', 'createdAt'])
      .where('id', '=', a.id)
      .executeTakeFirstOrThrow()
    expect(
      await updateDisplayName(
        testContext(db, a.principal, () => now),
        '  Ada 👩‍💻  ',
      ),
    ).toEqual({ name: 'Ada 👩‍💻' })
    const after = await db
      .selectFrom('auth.user')
      .select(['name', 'email', 'emailVerified', 'createdAt', 'updatedAt'])
      .where('id', '=', a.id)
      .executeTakeFirstOrThrow()
    expect(after).toEqual({
      ...before,
      name: 'Ada 👩‍💻',
      updatedAt: new Date(now.epochMilliseconds),
    })
    expect(
      (
        await db
          .selectFrom('auth.user')
          .select('name')
          .where('id', '=', b.id)
          .executeTakeFirstOrThrow()
      ).name,
    ).toBe('Peer name')
    expect((await domainError(() => getProfile(ctx(a)))).code).toBe('profile_not_found')
  })

  it.each([
    null,
    false,
    42,
    {},
    [],
    '',
    '   ',
    'A'.repeat(201),
    'A\nB',
    'A\u0000B',
    'A\u0085B',
    'A\u2028B',
    'A\u2029B',
    'A\ud800B',
  ])('rejects invalid display names without any write or input echo (%#)', async (value) => {
    const user = await createTestUser(db, 'Keep me')
    const before = await db
      .selectFrom('auth.user')
      .selectAll()
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow()
    const error = await domainError(() => updateDisplayName(ctx(user), value))
    expect(error.code).toBe('invalid_display_name')
    expect(error.detail).toBe('Name must be a single line of text between 1 and 200 characters.')
    expect(
      await db
        .selectFrom('auth.user')
        .selectAll()
        .where('id', '=', user.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before)
  })

  it('accepts the exact name length boundary and an unchanged retry', async () => {
    const user = await createTestUser(db)
    const name = '😀'.repeat(100)
    expect(await updateDisplayName(ctx(user), name)).toEqual({ name })
    expect(await updateDisplayName(ctx(user), name)).toEqual({ name })
  })

  it('has no profile before onboarding', async () => {
    const user = await createTestUser(db)
    const error = await domainError(() => getProfile(ctx(user)))
    expect(error.kind).toBe('not_found')
    expect(error.code).toBe('profile_not_found')
  })

  it('creates the profile, then replaces it', async () => {
    const user = await createTestUser(db)
    const first = await putProfile(ctx(user), input({ handle: 'grace' }))
    expect(first.created).toBe(true)
    expect(first.profile).toEqual({
      handle: 'grace',
      timeZone: 'Europe/Berlin',
      locale: 'en',
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      updatedAt: expect.stringMatching(/Z$/),
    })
    expect(await getProfile(ctx(user))).toEqual(first.profile)

    const second = await putProfile(
      ctx(user),
      input({ handle: 'grace-h', timeZone: 'America/New_York', locale: 'pt-BR' }),
    )
    expect(second.created).toBe(false)
    expect(second.profile).toMatchObject({
      handle: 'grace-h',
      timeZone: 'America/New_York',
      locale: 'pt-BR',
      createdAt: first.profile.createdAt,
    })
    expect(await getProfile(ctx(user))).toEqual(second.profile)
  })

  it('keeps each user to their own profile', async () => {
    const [a, b] = [await createTestUser(db), await createTestUser(db)]
    await putProfile(ctx(a), input())
    expect((await domainError(() => getProfile(ctx(b)))).code).toBe('profile_not_found')
  })

  it('normalizes the time zone and locale', async () => {
    const user = await createTestUser(db)
    const { profile } = await putProfile(
      ctx(user),
      input({ timeZone: 'america/new_york', locale: 'zh-hans-cn' }),
    )
    expect(profile.timeZone).toBe('America/New_York')
    expect(profile.locale).toBe('zh-Hans-CN')
  })

  it('refuses a handle another user has, and lets the owner keep theirs', async () => {
    const [a, b] = [await createTestUser(db), await createTestUser(db)]
    await putProfile(ctx(a), input({ handle: 'taken-one' }))
    const error = await domainError(() => putProfile(ctx(b), input({ handle: 'taken-one' })))
    expect(error.kind).toBe('conflict')
    expect(error.code).toBe('handle_taken')
    expect(error.detail).toBe('This handle is already taken')
    // The database error is kept for the log, never shown.
    expect(error.cause).toMatchObject({ code: '23505', constraint: 'profiles_handle_key' })
    expect(error.detail).not.toContain('taken-one')

    const again = await putProfile(ctx(a), input({ handle: 'taken-one', locale: 'de' }))
    expect(again.profile.locale).toBe('de')
  })

  it.each([
    ['Ada', 'uppercase'],
    ['-ada', 'a leading hyphen'],
    ['ada-', 'a trailing hyphen'],
    ['ada_l', 'an underscore'],
    ['ada.l', 'a dot'],
    ['', 'nothing'],
    ['a'.repeat(41), '41 characters'],
  ])('refuses the handle %j (%s)', async (handle) => {
    const user = await createTestUser(db)
    const error = await domainError(() => putProfile(ctx(user), input({ handle })))
    expect(error.kind).toBe('invalid')
    expect(error.code).toBe('invalid_handle')
  })

  it('accepts handles at the limits of the pattern', async () => {
    const user = await createTestUser(db)
    for (const handle of ['x', `x${'-'.repeat(38)}y`, '0']) {
      const { profile } = await putProfile(ctx(user), input({ handle }))
      expect(profile.handle).toBe(handle)
    }
  })

  it('refuses reserved handles', async () => {
    const user = await createTestUser(db)
    expect(RESERVED_HANDLES).toContain('api')
    for (const handle of [
      'api',
      'admin',
      't',
      'mcp',
      'assets',
      'booking',
      'sign-in',
      'event-types',
      'api-keys',
      // Regardless of case: refused as reserved, not just as uppercase.
      'Admin',
      'SIGN-UP',
    ]) {
      const error = await domainError(() => putProfile(ctx(user), input({ handle })))
      expect(error.code).toBe('handle_reserved')
      expect(error.kind).toBe('invalid')
    }
  })

  it.each(['Mars/Olympus', '+08:00', '', 'Europe/Berlin '])(
    'refuses the time zone %j',
    async (timeZone) => {
      const user = await createTestUser(db)
      const error = await domainError(() => putProfile(ctx(user), input({ timeZone })))
      expect(error.kind).toBe('invalid')
      expect(error.code).toBe('invalid_time_zone')
    },
  )

  it.each(['en_US', 'x', '', 'a'.repeat(36)])('refuses the locale %j', async (locale) => {
    const user = await createTestUser(db)
    const error = await domainError(() => putProfile(ctx(user), input({ locale })))
    expect(error.code).toBe('invalid_locale')
  })

  it('writes nothing when the input is invalid', async () => {
    const user = await createTestUser(db)
    await domainError(() => putProfile(ctx(user), input({ timeZone: 'Nowhere/Land' })))
    expect((await domainError(() => getProfile(ctx(user)))).code).toBe('profile_not_found')
  })
})
