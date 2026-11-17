import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPublicEventType, getPublicHost } from './availability.ts'
import { createFixtures, type Fixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00:00Z')

describe.skipIf(!serverUrl)('host directory event branding', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    f = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('keeps personal framing and uses the owning space brand on each listed event', async () => {
    const host = await f.host()
    const team = await f.organization('consulting-team')
    const unbranded = await f.organization('unbranded-team')
    await f.member(host.userId, team)
    await f.member(host.userId, unbranded)
    await f.eventType(host.organizationId, host.userId, { slug: 'personal' })
    await f.eventType(team, host.userId, { slug: 'team' })
    await f.eventType(unbranded, host.userId, { slug: 'default' })
    await db
      .insertInto('organization_branding')
      .values([
        { organization_id: host.organizationId, brand_primary_color: '#AABBCC' },
        { organization_id: team, brand_primary_color: '#123456' },
      ])
      .execute()
    const ctx = { db, now }
    const directory = await getPublicHost(ctx, { handle: host.handle })
    expect(directory.branding?.primaryColor).toBe('#AABBCC')
    expect(directory.eventTypes).toHaveLength(3)
    const personal = directory.eventTypes.find((event) => event.slug === 'personal')
    expect(personal?.branding).toEqual(directory.branding)
    expect(personal).not.toHaveProperty('organizationName')
    const teamCard = directory.eventTypes.find((event) => event.slug === 'team')
    expect(teamCard?.organizationName).toBe('consulting-team')
    expect(teamCard?.branding?.primaryColor).toBe('#123456')
    expect(teamCard?.branding).toEqual(
      (await getPublicEventType(ctx, { handle: host.handle, slug: 'team' })).branding,
    )
    const defaultCard = directory.eventTypes.find((event) => event.slug === 'default')
    expect(defaultCard?.organizationName).toBe('unbranded-team')
    expect(defaultCard).not.toHaveProperty('branding')
  })

  it('does not reveal hidden or departed-owner spaces through event branding', async () => {
    const host = await f.host()
    const hidden = await f.organization('private-customer')
    const departed = await f.organization('former-customer')
    await f.member(host.userId, hidden)
    await f.member(host.userId, departed)
    const hiddenId = await f.eventType(hidden, host.userId, { slug: 'hidden' })
    await db
      .updateTable('event_types')
      .set({ is_hidden: true })
      .where('id', '=', hiddenId)
      .execute()
    await f.eventType(departed, host.userId, { slug: 'departed' })
    await db
      .insertInto('organization_branding')
      .values([
        { organization_id: hidden, brand_primary_color: '#112233' },
        { organization_id: departed, brand_primary_color: '#445566' },
      ])
      .execute()
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', departed)
      .where('userId', '=', host.userId)
      .execute()
    const directory = await getPublicHost({ db, now }, { handle: host.handle })
    expect(directory.eventTypes).toEqual([])
    expect(JSON.stringify(directory)).not.toMatch(/private-customer|former-customer|112233|445566/)
  })
})
