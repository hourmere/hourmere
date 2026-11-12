// The claim-reserved personal handle `route` (docs/routing-forms.md, Form model and limits):
// nobody may newly claim it or change to it, in any case, yet a legacy holder keeps it, its
// pages stay served and nothing renames it. Real PostgreSQL throughout, including a save that
// races a rename, with source-copy controls showing that each protection is what passes.
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { setTimeout } from 'node:timers/promises'
import { DISPLAY_NAME_MAX_LENGTH } from '@hourmere/auth'
import {
  CLAIM_RESERVED_HANDLES,
  isClaimReservedHandle,
  isPublicTeamSlug,
  isReservedName,
  RESERVED_NAMES,
} from '@hourmere/core'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findPublicEventType, servedHandle } from './availability.ts'
import { DomainError } from './errors.ts'
import { isConstraintViolation, SQLSTATE, timestamp, validTimeZone } from './internal.ts'
import {
  findLegacyHandleCollisions,
  getProfile,
  type ProfileInput,
  putProfile,
  RESERVED_HANDLES,
} from './profile.ts'
import { createFixtures, createTestUser, type TestUser, testContext } from './testing.ts'
import { cleanText } from './text.ts'

type ProfileModule = { putProfile: typeof putProfile } & {
  findLegacyHandleCollisions: typeof findLegacyHandleCollisions
}
type Change = readonly [string, string]

/** profile.ts compiled from source, optionally with one change, on its real dependencies. */
function profileCopy(change?: Change): ProfileModule {
  let source = readFileSync(new URL('./profile.ts', import.meta.url), 'utf8')
  if (change) {
    expect(source.includes(change[0]), `mutation must match source: ${change[0]}`).toBe(true)
    source = source.replace(...change)
  }
  const javascript = stripTypeScriptTypes(
    source.replace(/^import[\s\S]*?from '[^']+'\n/gm, ''),
  ).replace(/\bexport /g, '')
  const bindings = {
    DISPLAY_NAME_MAX_LENGTH,
    CLAIM_RESERVED_HANDLES,
    isClaimReservedHandle,
    isReservedName,
    RESERVED_NAMES,
    sql,
    DomainError,
    isConstraintViolation,
    SQLSTATE,
    timestamp,
    validTimeZone,
    cleanText,
  }
  return new Function(
    ...Object.keys(bindings),
    `${javascript}; return { putProfile, findLegacyHandleCollisions }`,
  )(...Object.values(bindings)) as ProfileModule
}

const serverUrl = process.env.DATABASE_URL

describe('the claim-reserved handle names', () => {
  it('reserve route for claims only, in any case, leaving reserved names and team slugs alone', () => {
    for (const name of ['route', 'Route', 'ROUTE', 'rOuTe']) {
      expect(isClaimReservedHandle(name), name).toBe(true)
      expect(isReservedName(name), name).toBe(false)
      expect(isPublicTeamSlug(name), name).toBe(true)
    }
    for (const name of ['router', 'routes', 'my-route', 'route-1', 'routing']) {
      expect(isClaimReservedHandle(name), name).toBe(false)
    }
    expect(RESERVED_NAMES.has('route')).toBe(false)
    expect(RESERVED_HANDLES.has('route')).toBe(false)
    expect(servedHandle('route')).toBe('route')
    expect(servedHandle('Route')).toBe('route')
  })
})

describe.skipIf(!serverUrl)('the claim-reserved personal handle route', () => {
  let testDb: TestDatabase
  let db: Db

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string, undefined, { tag: 'route_handle' })
    db = createDb(testDb.pool)
  })

  /** Handles and the team slug are unique: each case releases the ones it stored. */
  async function release() {
    await db
      .deleteFrom('profiles')
      .where('handle', 'in', ['route', 'router', 'routes', 'my-route'])
      .execute()
    await db.deleteFrom('auth.organization').where('slug', '=', 'route').execute()
  }

  afterEach(release)

  afterAll(async () => {
    await testDb?.drop()
  })

  const ctx = (user: TestUser, on: Db = db) => testContext(on, user.principal)
  const input = (overrides: Partial<ProfileInput> = {}): ProfileInput => ({
    handle: `ada-${Math.random().toString(36).slice(2, 10)}`,
    timeZone: 'Europe/Berlin',
    locale: 'en',
    ...overrides,
  })
  const stored = (user: TestUser) =>
    db
      .selectFrom('profiles')
      .select(['handle', 'time_zone', 'locale'])
      .where('user_id', '=', user.id)
      .executeTakeFirst()
  /** A save's outcome as data, so that a refusal or an unexpected success fails an assertion. */
  const outcome = (save: Promise<{ profile: { handle: string }; created: boolean }>) =>
    save.then(
      ({ profile, created }) => ({ handle: profile.handle, created }),
      (error: unknown) => ({ error: error instanceof DomainError ? error.code : String(error) }),
    )

  /** A user holding `route` from before the claim check existed, as stored data has it. */
  async function legacyOwner(): Promise<TestUser> {
    const owner = await createTestUser(db, 'Legacy route owner')
    await db
      .insertInto('profiles')
      .values({ user_id: owner.id, handle: 'route', time_zone: 'UTC', locale: 'en' })
      .execute()
    return owner
  }

  /** Waits until a profile upsert in this database is blocked on a row lock. */
  async function upsertWaitingForLock() {
    for (let attempt = 0; attempt < 1_000; attempt++) {
      const { rows } = await testDb.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query ILIKE 'insert into "profiles"%'`,
      )
      if ((rows[0]?.n ?? 0) > 0) return
      await setTimeout(5)
    }
    throw new Error('the concurrent save never waited for the open transaction')
  }

  async function newClaimRefused(put = putProfile) {
    for (const handle of ['route', 'Route', 'ROUTE']) {
      const user = await createTestUser(db)
      expect(await outcome(put(ctx(user), input({ handle }))), handle).toEqual({
        error: 'handle_reserved',
      })
      expect(await stored(user), handle).toBeUndefined()
    }
  }

  async function changeRefused(put = putProfile) {
    for (const handle of ['route', 'Route', 'ROUTE']) {
      const user = await createTestUser(db)
      await putProfile(ctx(user), input({ handle: `kept-${user.id.slice(0, 8)}` }))
      const before = await stored(user)
      expect(
        await outcome(put(ctx(user), input({ handle, timeZone: 'Asia/Tokyo' }))),
        handle,
      ).toEqual({ error: 'handle_reserved' })
      expect(await stored(user), handle).toEqual(before)
    }
  }

  async function legacyOwnerKeepsIt(put = putProfile) {
    const owner = await legacyOwner()
    expect(
      await outcome(put(ctx(owner), input({ handle: 'route', timeZone: 'america/new_york' }))),
    ).toEqual({ handle: 'route', created: false })
    expect(await stored(owner)).toEqual({
      handle: 'route',
      time_zone: 'America/New_York',
      locale: 'en',
    })
  }

  /** The legacy owner renames in an open transaction while a second save keeps `route`. */
  async function renameRacesKeep(put = putProfile) {
    const owner = await legacyOwner()
    const renamed = Promise.withResolvers<void>()
    const commit = Promise.withResolvers<void>()
    const rename = db.transaction().execute(async (trx) => {
      await putProfile(ctx(owner, trx), {
        handle: `renamed-${owner.id.slice(0, 8)}`,
        timeZone: 'Asia/Tokyo',
        locale: 'ja',
      })
      renamed.resolve()
      await commit.promise
    })
    try {
      await renamed.promise
      // Started while the rename is uncommitted: its snapshot still shows `route`.
      const keep = outcome(
        put(ctx(owner), { handle: 'route', timeZone: 'Europe/Berlin', locale: 'de' }),
      )
      await upsertWaitingForLock()
      commit.resolve()
      await rename
      expect(await keep).toEqual({ error: 'handle_reserved' })
    } finally {
      commit.resolve()
      await rename.catch(() => {})
    }
    expect(await stored(owner)).toEqual({
      handle: `renamed-${owner.id.slice(0, 8)}`,
      time_zone: 'Asia/Tokyo',
      locale: 'ja',
    })
    expect(await findLegacyHandleCollisions(db)).toEqual([])
  }

  async function detectorFinds(find = findLegacyHandleCollisions) {
    expect(await find(db)).toEqual([])
    const owner = await legacyOwner()
    // Look-alikes and a team slug `route` are no collision.
    for (const handle of ['router', 'routes', 'my-route']) {
      const user = await createTestUser(db)
      await putProfile(ctx(user), input({ handle }))
    }
    await createFixtures(db).organization('route')
    expect(await find(db)).toEqual([{ userId: owner.id, handle: 'route' }])
    // Detection never renames: the stored handle is exactly as it was.
    expect(await stored(owner)).toEqual({ handle: 'route', time_zone: 'UTC', locale: 'en' })
  }

  /** Case-insensitive, even for a row the lowercase CHECK would refuse (rolled back). */
  async function detectorIgnoresCase(find = findLegacyHandleCollisions) {
    const user = await createTestUser(db)
    const found = await db
      .transaction()
      .execute(async (trx) => {
        await sql`ALTER TABLE profiles DROP CONSTRAINT profiles_handle_check`.execute(trx)
        await trx
          .insertInto('profiles')
          .values({ user_id: user.id, handle: 'Route', time_zone: 'UTC' })
          .execute()
        const result = await find(trx)
        throw Object.assign(new Error('rollback'), { result })
      })
      .catch((error: { result?: unknown }) => error.result)
    expect(found).toEqual([{ userId: user.id, handle: 'Route' }])
    expect(await stored(user)).toBeUndefined()
  }

  it('refuses route, Route and ROUTE as a new handle, writing nothing', async () => {
    await newClaimRefused()
  })

  it('refuses changing an existing handle to route in any case, keeping the profile', async () => {
    await changeRefused()
  })

  it('refuses route while a legacy owner holds it, as reserved rather than taken', async () => {
    await legacyOwner()
    const other = await createTestUser(db)
    expect(await outcome(putProfile(ctx(other), input({ handle: 'route' })))).toEqual({
      error: 'handle_reserved',
    })
    expect(await stored(other)).toBeUndefined()
  })

  it('lets the legacy owner save other fields with the unchanged handle', async () => {
    await legacyOwnerKeepsIt()
  })

  it('refuses Route and ROUTE even from the legacy owner, keeping the stored handle', async () => {
    const owner = await legacyOwner()
    for (const handle of ['Route', 'ROUTE']) {
      expect(await outcome(putProfile(ctx(owner), input({ handle }))), handle).toEqual({
        error: 'handle_reserved',
      })
    }
    expect(await stored(owner)).toEqual({ handle: 'route', time_zone: 'UTC', locale: 'en' })
  })

  it('never gives route back once its legacy owner renames away', async () => {
    const owner = await legacyOwner()
    const away = `away-${owner.id.slice(0, 8)}`
    expect((await putProfile(ctx(owner), input({ handle: away }))).profile.handle).toBe(away)
    expect(await outcome(putProfile(ctx(owner), input({ handle: 'route' })))).toEqual({
      error: 'handle_reserved',
    })
    expect(await stored(owner)).toMatchObject({ handle: away })
  })

  it('refuses a keep-save that raced a committed rename, without undoing the rename', async () => {
    await renameRacesKeep()
  })

  it('lets a rename wait for a keep-save in flight and then succeed', async () => {
    const owner = await legacyOwner()
    const kept = Promise.withResolvers<void>()
    const commit = Promise.withResolvers<void>()
    const keep = db.transaction().execute(async (trx) => {
      await putProfile(ctx(owner, trx), input({ handle: 'route', locale: 'de' }))
      kept.resolve()
      await commit.promise
    })
    const away = `later-${owner.id.slice(0, 8)}`
    try {
      await kept.promise
      const rename = outcome(putProfile(ctx(owner), input({ handle: away, locale: 'fr' })))
      await upsertWaitingForLock()
      commit.resolve()
      await keep
      expect(await rename).toEqual({ handle: away, created: false })
    } finally {
      commit.resolve()
      await keep.catch(() => {})
    }
    expect(await stored(owner)).toMatchObject({ handle: away, locale: 'fr' })
  })

  it("keeps serving a legacy route owner's booking pages", async () => {
    const f = createFixtures(db)
    const host = await f.host({ handle: 'route', timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const id = await f.eventType(host.organizationId, host.userId, { slug: 'intro' })
    for (const handle of ['route', 'Route']) {
      expect((await findPublicEventType(db, handle, 'intro'))?.id, handle).toBe(id)
    }
  })

  it('detects a stored route handle without renaming it, ignoring look-alikes and teams', async () => {
    await detectorFinds()
  })

  it('detects the handle regardless of case', async () => {
    await detectorIgnoresCase()
  })

  describe('source-copy controls', () => {
    it('pass with the unmodified source copy', async () => {
      const copy = profileCopy()
      await newClaimRefused(copy.putProfile)
      await changeRefused(copy.putProfile)
      await legacyOwnerKeepsIt(copy.putProfile)
      await release()
      await renameRacesKeep(copy.putProfile)
      await release()
      await detectorFinds(copy.findLegacyHandleCollisions)
      await release()
      await detectorIgnoresCase(copy.findLegacyHandleCollisions)
    })

    const controls: {
      name: string
      change: Change
      probe: (copy: ProfileModule) => Promise<void>
    }[] = [
      {
        name: 'the Route/ROUTE refusal',
        change: [
          'isClaimReservedHandle(value) && !HANDLE_PATTERN.test(value)) {\n    throw reserved()',
          'false) {\n    throw reserved()',
        ],
        probe: (copy) => newClaimRefused(copy.putProfile),
      },
      {
        name: 'the stored-handle check on the proposed row',
        change: ['keptOnly\n          ? proposed.where(', 'false\n          ? proposed.where('],
        probe: (copy) => newClaimRefused(copy.putProfile),
      },
      {
        name: 'the refusal when no row comes back',
        change: ['if (!row) throw reserved()', 'if (!row) return { profile: {}, created: false }'],
        probe: (copy) => changeRefused(copy.putProfile),
      },
      {
        name: 'the stored-handle check on the locked row',
        change: [
          "keptOnly ? update.whereRef('profiles.handle', '=', 'excluded.handle') : update",
          'update',
        ],
        probe: (copy) => renameRacesKeep(copy.putProfile),
      },
      {
        name: 'keeping a held handle (route refused outright)',
        change: [
          'isClaimReservedHandle(value) && !HANDLE_PATTERN.test(value)',
          'isClaimReservedHandle(value)',
        ],
        probe: (copy) => legacyOwnerKeepsIt(copy.putProfile),
      },
      {
        name: 'the detector name list',
        change: ['[...CLAIM_RESERVED_HANDLES]', "['none']"],
        probe: (copy) => detectorFinds(copy.findLegacyHandleCollisions),
      },
      {
        name: 'the case-insensitive detector match',
        change: ["eb.fn('lower', ['handle'])", "eb.ref('handle')"],
        probe: (copy) => detectorIgnoresCase(copy.findLegacyHandleCollisions),
      },
    ]

    it.each(controls)('fail without $name', async ({ change, probe }) => {
      await expect(probe(profileCopy(change))).rejects.toMatchObject({ name: 'AssertionError' })
    })
  })

  it('reads back what was kept', async () => {
    const owner = await legacyOwner()
    await putProfile(ctx(owner), input({ handle: 'route', locale: 'pt-br' }))
    expect(await getProfile(ctx(owner))).toMatchObject({ handle: 'route', locale: 'pt-BR' })
  })
})
