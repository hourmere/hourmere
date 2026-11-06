import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ServiceContext } from './context.ts'
import * as events from './event-types.ts'
import { jsonb } from './internal.ts'
import type { LocationOption, LocationSettings } from './location-options.ts'
import { createTestTeam, createTestUser, type TestUser, testContext } from './testing.ts'

type Services = Pick<
  typeof events,
  'createEventType' | 'updateEventType' | 'getEventType' | 'listEventTypes'
>
type SourceCopy = Services & {
  normalize: (input: events.EventTypeInput) => {
    location: LocationSettings | null
    locations: LocationOption[] | null
  }
  project: (row: unknown) => { location: LocationSettings | null }
}
type Change = readonly [string, string]

/** Mutants run isolated source copies against the same behavioral assertions. */
async function sourceCopy(change?: Change, locationChange?: Change): Promise<SourceCopy> {
  const url = new URL('event-types.ts', import.meta.url)
  let source = readFileSync(url, 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source)
  const bindings: Record<string, unknown> = {}
  for (const imported of source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm)) {
    const specifier = imported[2] as string
    let module: Record<string, unknown>
    if (specifier === './location-options.ts' && locationChange) {
      const locationUrl = new URL(specifier, url)
      const original = readFileSync(locationUrl, 'utf8')
      expect(original.includes(locationChange[0]), 'mutation must match source').toBe(true)
      const modified = stripTypeScriptTypes(original.replace(...locationChange)).replace(
        /from '([^']+)'/g,
        (_, dependency: string) =>
          `from '${dependency.startsWith('.') ? new URL(dependency, locationUrl).href : import.meta.resolve(dependency)}'`,
      )
      module = await import(
        `data:text/javascript;base64,${Buffer.from(modified).toString('base64')}`
      )
    } else {
      module = await import(specifier.startsWith('.') ? new URL(specifier, url).href : specifier)
    }
    for (const binding of (imported[1] as string)
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)) {
      const [name, local] = binding.split(/\s+as\s+/)
      bindings[local ?? (name as string)] = module[name as string]
    }
    source = source.replace(imported[0], '')
  }
  source = source.replace(/\bexport /g, '')
  return new Function(
    ...Object.keys(bindings),
    `${source}; return { createEventType, updateEventType, getEventType, listEventTypes, normalize: (input) => validFields({...DEFAULTS, ...defined(input)}), project: fieldsOf }`,
  )(...Object.values(bindings)) as SourceCopy
}

const databaseUrl = process.env.DATABASE_URL
const base = { slug: 'choice', title: 'Choose where to meet', durationMinutes: 30 }
const options: LocationOption[] = [
  { id: 'office', kind: 'in_person', address: '1 Main Street', label: 'Our office' },
  { id: 'call', kind: 'phone', number: '+14155550123', isDefault: true },
  { id: 'room', kind: 'link', url: 'https://example.com/room' },
]
const link: LocationOption = { id: 'room', kind: 'link', url: 'https://example.com/room' }
const meet: LocationOption = { id: 'meet', kind: 'google_meet', autoCreate: true }
const zoom: LocationOption = { id: 'zoom', kind: 'zoom', autoCreate: true }

describe.skipIf(!databaseUrl)('event type location options (real Postgres)', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'locations' })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  const context = async () => {
    const user = await createTestUser(db)
    return testContext(db, user.principal)
  }
  const stored = (id: string) =>
    db
      .selectFrom('event_types')
      .select(['location', 'locations'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  async function verifyRoundTrip(api: Services = events) {
    const ctx = await context()
    const saved = await api.createEventType(ctx, { ...base, locations: options })
    expect(saved.locations).toEqual(options)
    expect(saved.location).toEqual({ kind: 'phone', number: '+14155550123' })
    if ('normalize' in api) {
      expect((api as SourceCopy).normalize({ ...base, locations: options }).location).toEqual({
        kind: 'phone',
        number: '+14155550123',
      })
    }
    expect(await stored(saved.id)).toEqual({
      locations: options,
      location: { kind: 'phone', number: '+14155550123' },
    })
    expect((await api.getEventType(ctx, saved.id)).locations).toEqual(options)
    expect((await api.listEventTypes(ctx))[0]?.locations).toEqual(options)
    const renamed = await api.updateEventType(ctx, saved.id, { title: 'Renamed' })
    expect(renamed.locations).toEqual(options)
    expect(renamed.location).toEqual(saved.location)
    const noDefault = await api.updateEventType(ctx, saved.id, {
      locations: [link, options[0] as LocationOption],
    })
    expect(noDefault.location).toEqual({ kind: 'link', url: 'https://example.com/room' })
    const collectedPhone = await api.updateEventType(ctx, saved.id, {
      locations: [{ id: 'call', kind: 'phone', askInvitee: true }],
    })
    expect(collectedPhone.location).toEqual({ kind: 'phone', askInvitee: true })
    await expect(api.updateEventType(ctx, saved.id, { locations: null })).resolves.toMatchObject({
      locations: null,
      location: null,
    })
    expect(await stored(saved.id)).toEqual({ locations: null, location: null })
  }
  it('persists ordered choices, derives compatibility and preserves choices on unrelated edits', () =>
    verifyRoundTrip())

  async function verifyLegacy(api: Services = events) {
    const ctx = await context()
    const location = { kind: 'link' as const, url: 'https://example.com/legacy' }
    const saved = await api.createEventType(ctx, { ...base, location })
    expect(saved.location).toEqual(location)
    expect(saved.locations).toEqual([{ id: 'legacy', ...location }])
    const changed = { kind: 'link' as const, url: 'https://example.com/changed' }
    expect(await api.updateEventType(ctx, saved.id, { location: changed })).toMatchObject({
      location: changed,
      locations: [{ id: 'legacy', ...changed }],
    })
    expect(await api.updateEventType(ctx, saved.id, { location: null })).toMatchObject({
      locations: null,
      location: null,
    })
  }
  it('keeps legacy singleton identity when settings change or clear', () => verifyLegacy())

  async function verifyLegacyEcho(api: Services = events) {
    const ctx = await context()
    for (const locations of [options, [options[0] as LocationOption], null]) {
      const saved = await api.createEventType(ctx, {
        ...base,
        slug: randomUUID(),
        locations,
      })
      const before = await owned.pool.query(
        'SELECT xmin::text, ctid::text FROM event_types WHERE id = $1',
        [saved.id],
      )
      const echo = await api.updateEventType(ctx, saved.id, { location: saved.location })
      expect(echo.locations).toEqual(locations)
      expect(
        await owned.pool.query('SELECT xmin::text, ctid::text FROM event_types WHERE id = $1', [
          saved.id,
        ]),
      ).toMatchObject({ rows: before.rows })
      const renamed = await api.updateEventType(ctx, saved.id, {
        title: 'Saved by an old client',
        location: saved.location,
      })
      expect(renamed.locations).toEqual(locations)
      expect(await stored(saved.id)).toEqual({ locations, location: saved.location })
    }
  }
  it('preserves rich option lists on exact legacy echoes including unrelated saves', () =>
    verifyLegacyEcho())

  async function verifyHistoricalEcho(api: Services = events) {
    const ctx = await context()
    const historical = [
      [
        { id: 'office', kind: 'in_person', address: ' Office ', label: 'Headquarters' },
        { id: 'room', kind: 'link', url: 'https://EXAMPLE.COM:443/room', isDefault: true },
      ],
      [{ id: 'office', kind: 'in_person', address: ' Office ', label: 'Headquarters' }],
      [{ id: 'call', kind: 'phone' }],
      [
        {
          id: 'room',
          kind: 'link',
          url: 'https://example.com/room',
          label: 'Room',
          historical: { rooms: [{ name: 'Main', floor: 2 }], flags: [true, null] },
        },
      ],
    ]
    for (const locations of historical) {
      const created = await api.createEventType(ctx, { ...base, slug: randomUUID() })
      await db
        .updateTable('event_types')
        .set({ locations: jsonb(locations) })
        .where('id', '=', created.id)
        .execute()
      const saved = await api.getEventType(ctx, created.id)
      await expect(
        api.updateEventType(ctx, saved.id, { location: saved.location }),
      ).resolves.toMatchObject({ locations })
      await expect(
        api.updateEventType(ctx, saved.id, { title: 'Legacy echo save', location: saved.location }),
      ).resolves.toMatchObject({ locations })
      await expect(
        api.updateEventType(ctx, saved.id, { title: 'Editor omitted location' }),
      ).resolves.toMatchObject({ locations })
      expect(await stored(saved.id)).toEqual({ locations, location: saved.location })
    }
  }
  it('preserves historical settings before validating or normalizing exact echoes and unrelated saves', () =>
    verifyHistoricalEcho())

  async function verifyLegacySettings(api: Services = events) {
    const ctx = await context()
    const saved = await api.createEventType(ctx, {
      ...base,
      locations: [{ id: 'office', kind: 'in_person', address: 'Before', isDefault: true }],
    })
    expect(
      await api.updateEventType(ctx, saved.id, {
        location: { kind: 'in_person', address: 'After' },
      }),
    ).toMatchObject({
      location: { kind: 'in_person', address: 'After' },
      locations: [{ id: 'office', kind: 'in_person', address: 'After', isDefault: true }],
    })
  }
  it('keeps a singleton option id and default when its settings change', () =>
    verifyLegacySettings())

  async function verifyLegacyIdentity(api: Services = events) {
    const ctx = await context()
    const location = { kind: 'link' as const, url: 'https://example.com/legacy' }
    const saved = await api.createEventType(ctx, { ...base, location })
    const changed = await api.updateEventType(ctx, saved.id, {
      location: { kind: 'in_person', address: 'Office' },
    })
    expect(changed.locations?.[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(changed.locations?.[0]?.id).not.toBe(saved.locations?.[0]?.id)
    await api.updateEventType(ctx, saved.id, { location: null })
    const recreated = await api.updateEventType(ctx, saved.id, { location })
    expect(recreated.locations?.[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(recreated.locations?.[0]?.id).not.toBe(saved.locations?.[0]?.id)
    expect(recreated.locations?.[0]?.id).not.toBe(changed.locations?.[0]?.id)
  }
  it('rotates singleton identity after changing kind or clearing and re-creating it', () =>
    verifyLegacyIdentity())

  async function verifyLegacyConflict(api: Services = events) {
    const ctx = await context()
    const unlabelled: LocationOption[] = [
      { id: 'office', kind: 'in_person', address: '1 Main Street' },
      { id: 'call', kind: 'phone', number: '+14155550123', isDefault: true },
      link,
    ]
    for (const locations of [unlabelled, options, [options[0] as LocationOption]]) {
      const saved = await api.createEventType(ctx, { ...base, slug: randomUUID(), locations })
      for (const location of [null, { kind: 'zoom' as const }])
        await expect(
          api.updateEventType(ctx, saved.id, { title: 'Must not commit', location }),
        ).rejects.toMatchObject({
          kind: 'conflict',
          code: 'location_options_conflict',
          message: expect.stringContaining('locations'),
        })
      expect(await api.getEventType(ctx, saved.id)).toMatchObject({ title: base.title, locations })
      expect(await stored(saved.id)).toEqual({ locations, location: saved.location })
    }
  }
  it('rejects changed and cleared legacy writes for multiple or labelled options atomically', () =>
    verifyLegacyConflict())

  async function verifyLegacyPhoneCreate(api: Services = events) {
    const ctx = await context()
    await expect(
      api.createEventType(ctx, {
        ...base,
        location: { kind: 'phone', askInvitee: true },
      }),
    ).rejects.toMatchObject({ kind: 'invalid', code: 'invalid_location' })
    expect(await api.listEventTypes(ctx)).toEqual([])
  }
  it('rejects new legacy invitee-phone configuration before creating an event', () =>
    verifyLegacyPhoneCreate())

  async function verifyLegacyPhoneUpdate(api: Services = events) {
    const ctx = await context()
    for (const fields of [
      {},
      { location: { kind: 'phone' as const, number: '+14155550123' } },
      {
        locations: [link, { id: 'call', kind: 'phone' as const, askInvitee: true as const }],
      },
    ]) {
      const saved = await api.createEventType(ctx, {
        ...base,
        slug: randomUUID(),
        ...fields,
      })
      await expect(
        api.updateEventType(ctx, saved.id, {
          title: 'Must not commit',
          location: { kind: 'phone', askInvitee: true },
        }),
      ).rejects.toMatchObject({ kind: 'invalid', code: 'invalid_location' })
      expect(await api.getEventType(ctx, saved.id)).toMatchObject({
        title: base.title,
        location: saved.location,
        locations: saved.locations,
      })
      expect(await stored(saved.id)).toEqual({
        location: saved.location,
        locations: saved.locations,
      })
    }
  }
  it('rejects non-verbatim legacy invitee-phone updates without changing stored settings', () =>
    verifyLegacyPhoneUpdate())

  async function verifyLegacyPhone(api: Services = events) {
    const ctx = await context()
    const locations: LocationOption[] = [
      { id: 'office', kind: 'in_person', address: 'Office', label: 'Headquarters' },
      { id: 'call', kind: 'phone', askInvitee: true, isDefault: true },
    ]
    const saved = await api.createEventType(ctx, { ...base, locations })
    const before = await stored(saved.id)
    await expect(
      api.updateEventType(ctx, saved.id, { location: saved.location }),
    ).resolves.toMatchObject({ locations, location: { kind: 'phone', askInvitee: true } })
    await expect(
      api.updateEventType(ctx, saved.id, {
        title: 'Phone save',
        location: { askInvitee: true, kind: 'phone' },
      }),
    ).resolves.toMatchObject({
      title: 'Phone save',
      locations,
      location: { kind: 'phone', askInvitee: true },
    })
    expect(await stored(saved.id)).toEqual(before)
    for (const location of [
      { kind: 'phone', askInvitee: true, number: '+14155550123' },
      { kind: 'phone', askInvitee: false },
      { kind: 'phone', askInvitee: 'true' },
      { kind: 'phone' },
    ])
      await expect(
        api.updateEventType(ctx, saved.id, { location } as events.EventTypeUpdate),
      ).rejects.toMatchObject({ code: 'invalid_location' })
  }
  it('round-trips an invitee-phone compat value while rejecting invalid and mixed phone settings', () =>
    verifyLegacyPhone())

  async function verifyConflict(api: Services = events) {
    const ctx = await context()
    await expect(
      api.createEventType(ctx, { ...base, location: null, locations: options }),
    ).rejects.toMatchObject({ code: 'invalid_locations' })
    const saved = await api.createEventType(ctx, base)
    await expect(
      api.updateEventType(ctx, saved.id, { location: null, locations: options }),
    ).rejects.toMatchObject({ code: 'invalid_locations' })
  }
  it('rejects ambiguous simultaneous legacy and list writes', () => verifyConflict())

  async function verifyValidation(api: Services = events) {
    const ctx = await context()
    const bad = {
      locations: [{ id: 'broken', kind: 'link', url: 'javascript:alert(1)' }],
    } as unknown as events.EventTypeUpdate
    await expect(api.createEventType(ctx, { ...base, ...bad })).rejects.toMatchObject({
      code: 'invalid_locations',
    })
    const saved = await api.createEventType(ctx, base)
    await expect(api.updateEventType(ctx, saved.id, bad)).rejects.toMatchObject({
      code: 'invalid_locations',
    })
    expect((await api.getEventType(ctx, saved.id)).locations).toBeNull()
  }
  it('applies option validation to creation and replacement before writing', () =>
    verifyValidation())

  async function verifyProjection(api: Services = events) {
    const ctx = await context()
    const saved = await api.createEventType(ctx, base)
    await db
      .updateTable('event_types')
      .set({ locations: jsonb(options), location: jsonb({ kind: 'zoom' }) })
      .where('id', '=', saved.id)
      .execute()
    const expected = { kind: 'phone', number: '+14155550123' }
    if ('project' in api) {
      const row = await db
        .selectFrom('event_types')
        .selectAll()
        .where('id', '=', saved.id)
        .executeTakeFirstOrThrow()
      expect((api as SourceCopy).project({ ...row, location: { kind: 'zoom' } }).location).toEqual(
        expected,
      )
    }
    expect((await api.getEventType(ctx, saved.id)).location).toEqual(expected)
    expect((await api.listEventTypes(ctx))[0]?.location).toEqual(expected)
    expect(
      (await api.updateEventType(ctx, saved.id, { title: 'Correct projection' })).location,
    ).toEqual(expected)
    expect((await stored(saved.id)).location).toEqual(expected)
  }
  it('derives reads and subsequent writes from the ordered list even if the legacy column is stale', () =>
    verifyProjection())

  it('preserves personal visibility and team write permissions for option changes', async () => {
    const owner = await createTestUser(db)
    const member = await createTestUser(db)
    const personal = await events.createEventType(testContext(db, owner.principal), {
      ...base,
      locations: options,
    })
    await expect(
      events.updateEventType(testContext(db, member.principal), personal.id, { locations: null }),
    ).rejects.toMatchObject({ code: 'event_type_not_found' })
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const saved = await events.createEventType(testContext(db, team.as(owner)), {
      ...base,
      locations: options,
    })
    expect(
      (await events.getEventType(testContext(db, team.as(member)), saved.id)).locations,
    ).toEqual(options)
    await expect(
      events.updateEventType(testContext(db, team.as(member)), saved.id, { locations: null }),
    ).rejects.toMatchObject({ code: 'insufficient_role' })
  })

  async function teamContext() {
    const owner = await createTestUser(db)
    const host = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: host, role: 'member' },
    ])
    return {
      owner,
      host,
      ctx: { ...testContext(db, team.as(owner)), automaticMeet: true, automaticZoom: true },
    }
  }

  async function verifyMeet(api: Services = events) {
    const { owner, host, ctx } = await teamContext()
    const hosts = [{ userId: owner.id }, { userId: host.id }]
    await expect(
      api.createEventType(ctx, {
        ...base,
        locations: [link, meet],
        schedulingType: 'collective',
        hosts,
      }),
    ).rejects.toMatchObject({ code: 'invalid_conference_organizer' })
    await expect(
      api.createEventType(ctx, {
        ...base,
        locations: [link, meet],
        schedulingType: 'collective',
        hosts,
        conferenceOrganizer: { userId: host.id },
      }),
    ).rejects.toMatchObject({ code: 'automatic_meet_unavailable' })
    await expect(
      api.createEventType(ctx, {
        ...base,
        locations: [link, meet],
        schedulingType: 'round_robin',
        hosts,
      }),
    ).rejects.toMatchObject({ code: 'automatic_meet_unavailable' })
    const existing = await api.createEventType(ctx, { ...base, locations: [link] })
    await expect(
      api.updateEventType(ctx, existing.id, { locations: [link, meet] }),
    ).rejects.toMatchObject({ code: 'automatic_meet_unavailable' })
  }
  it('checks non-default Meet organizer and readiness rules for individual, collective and round-robin hosts', () =>
    verifyMeet())

  async function verifyConferenceEcho(api: Services = events) {
    const { owner, ctx } = await teamContext()
    const saved = await api.createEventType(ctx, { ...base, locations: [link] })
    const choices = [link, meet]
    // A saved non-default automatic option can lose readiness independently of metadata edits.
    await db
      .updateTable('event_types')
      .set({ locations: jsonb(choices) })
      .where('id', '=', saved.id)
      .execute()
    await expect(
      api.updateEventType(ctx, saved.id, { title: 'Legacy echo save', location: saved.location }),
    ).resolves.toMatchObject({ locations: choices })
    await expect(
      api.updateEventType(ctx, saved.id, { title: 'Editor save' }),
    ).resolves.toMatchObject({ locations: choices })
    for (const patch of [
      { locations: choices },
      { hosts: [{ userId: owner.id }] },
      { scheduleId: null },
      { conferenceOrganizer: null },
      { zoomConnectionId: null },
    ])
      await expect(api.updateEventType(ctx, saved.id, patch)).rejects.toMatchObject({
        code: 'automatic_meet_unavailable',
      })
    await api.updateEventType(ctx, saved.id, { isActive: false })
    await expect(api.updateEventType(ctx, saved.id, { isActive: true })).rejects.toMatchObject({
      code: 'automatic_meet_unavailable',
    })
  }
  it('preserves unready automatic options on legacy echo saves while explicit readiness changes are checked', () =>
    verifyConferenceEcho())

  async function verifyZoom(api: Services = events) {
    const { owner, host, ctx } = await teamContext()
    const hosts = [{ userId: owner.id }, { userId: host.id }]
    for (const schedulingType of ['collective', 'round_robin'] as const) {
      await expect(
        api.createEventType(ctx, { ...base, locations: [link, zoom], schedulingType, hosts }),
      ).rejects.toMatchObject({ code: 'automatic_zoom_host_policy' })
    }
    await expect(
      api.createEventType(ctx, { ...base, locations: [link, zoom], hosts: [{ userId: host.id }] }),
    ).rejects.toMatchObject({ code: 'zoom_host_session_required' })
    const existing = await api.createEventType(ctx, {
      ...base,
      locations: [link],
      hosts: [{ userId: host.id }],
    })
    await expect(
      api.updateEventType(ctx, existing.id, { locations: [link, zoom] }),
    ).rejects.toMatchObject({ code: 'zoom_host_session_required' })
  }
  it('enforces non-default Zoom host policy and host authorization on create and update', () =>
    verifyZoom())

  async function persistZoom(user: TestUser, ctx: ServiceContext) {
    const principal = ctx.principal
    if (principal.kind !== 'api_key') throw new Error('Expected API key fixture')
    await owned.pool.query(
      `INSERT INTO auth.apikey (id, "configId", "referenceId", key, "createdAt", "updatedAt", enabled, metadata) VALUES ($1, 'default', $2, $3, now(), now(), true, $4)`,
      [
        principal.apiKeyId,
        user.id,
        randomUUID(),
        JSON.stringify({ organizationId: principal.organization.id }),
      ],
    )
    return (
      await db
        .insertInto('conference_connections')
        .values({
          user_id: user.id,
          provider: 'zoom',
          mode: 'meetings',
          external_user_id: `synthetic-${user.id}`,
          status: 'active',
          credentials: Buffer.from('synthetic'),
          scopes: [
            'user:read:user',
            'meeting:write:meeting',
            'meeting:read:meeting',
            'meeting:update:meeting',
            'meeting:delete:meeting',
          ],
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
  }

  it('allows a connected host to configure non-default automatic Zoom and preserves connection selection', async () => {
    const { owner, ctx } = await teamContext()
    const connectionId = await persistZoom(owner, ctx)
    const saved = await events.createEventType(ctx, {
      ...base,
      locations: [link, zoom],
      zoomConnectionId: connectionId,
    })
    expect(saved).toMatchObject({
      locations: [link, zoom],
      location: { kind: 'link', url: link.url },
      zoomConnectionId: connectionId,
    })
    expect(
      (await events.updateEventType(ctx, saved.id, { locations: [zoom, link] })).location,
    ).toEqual({ kind: 'zoom', autoCreate: true })
  })

  async function verifyBothConferences(api: Services = events) {
    const { owner, ctx } = await teamContext()
    const connectionId = await persistZoom(owner, ctx)
    await expect(
      api.createEventType(ctx, {
        ...base,
        locations: [zoom, meet, link],
        zoomConnectionId: connectionId,
      }),
    ).rejects.toMatchObject({ code: 'automatic_meet_unavailable' })
  }
  it('validates Meet readiness even when an earlier Zoom choice is fully authorized', () =>
    verifyBothConferences())

  it.each(
    [
      verifyRoundTrip,
      verifyLegacy,
      verifyLegacyEcho,
      verifyHistoricalEcho,
      verifyLegacySettings,
      verifyLegacyIdentity,
      verifyLegacyConflict,
      verifyLegacyPhoneCreate,
      verifyLegacyPhoneUpdate,
      verifyLegacyPhone,
      verifyConflict,
      verifyValidation,
      verifyProjection,
      verifyMeet,
      verifyConferenceEcho,
      verifyZoom,
      verifyBothConferences,
    ].map((verify) => ({ name: verify.name, verify })),
  )('passes the unmodified source-copy $name control', async ({ verify }) =>
    verify(await sourceCopy()),
  )

  it('detects removing the multiple-unlabelled-option conflict with a real service assertion', async () => {
    const api = await sourceCopy(undefined, ['locations.length > 1 ||', 'false ||'])
    await expect(verifyLegacyConflict(api)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it.each<[string, Change, (api: Services) => Promise<void>]>([
    [
      'conflicting write protection',
      ['input.location !== undefined && input.locations !== undefined', 'false'],
      verifyConflict,
    ],
    ['legacy conversion', ['locationOptionsFromLegacy(location)', 'null'], verifyLegacy],
    [
      'legacy update preservation',
      [
        'return result\n    const location',
        'return { ...result, locations: locationOptionsFromLegacy(validLocation(input.location)) }\n    const location',
      ],
      verifyLegacyEcho,
    ],
    [
      'exact historical echo before legacy validation',
      ['isLegacyLocationEcho(currentLocations, input.location)', 'false'],
      verifyHistoricalEcho,
    ],
    [
      'trusted stored options on unrelated writes',
      ['changes.locations !== undefined,', 'true,'],
      verifyHistoricalEcho,
    ],
    [
      'legacy echo avoids row rewrites',
      ["name !== 'location' && input[name] !== undefined", 'input[name] !== undefined'],
      verifyLegacyEcho,
    ],
    [
      'singleton legacy settings identity',
      ['applyLegacyLocation(currentLocations, location)', 'locationOptionsFromLegacy(location)'],
      verifyLegacySettings,
    ],
    [
      'kind change and recreation identity',
      ['applyLegacyLocation(currentLocations, location)', 'locationOptionsFromLegacy(location)'],
      verifyLegacyIdentity,
    ],
    [
      'rich option legacy conflict',
      ['applyLegacyLocation(currentLocations, location)', 'locationOptionsFromLegacy(location)'],
      verifyLegacyConflict,
    ],
    [
      'invitee-phone compatibility',
      ['isLegacyLocationEcho(currentLocations, input.location)', 'false'],
      verifyLegacyPhone,
    ],
    [
      'new legacy invitee-phone rejection',
      [
        "return fail('Invitee phone collection is not available yet')",
        'return { kind, askInvitee: true }',
      ],
      verifyLegacyPhoneCreate,
    ],
    [
      'non-verbatim legacy invitee-phone update rejection',
      [
        "return fail('Invitee phone collection is not available yet')",
        'return { kind, askInvitee: true }',
      ],
      verifyLegacyPhoneUpdate,
    ],
    [
      'write validation',
      [
        'const locations = validateLocations\n    ? validateLocationOptions(c.locations)\n    : (c.locations as LocationOption[] | null)',
        'const locations = c.locations as LocationOption[] | null',
      ],
      verifyValidation,
    ],
    [
      'default compatibility',
      ['location: compatLocation(locations),', 'location: null,'],
      verifyRoundTrip,
    ],
    [
      'ordered-list storage',
      [
        'locations: fields.locations === null ? null : jsonb(fields.locations),',
        'locations: null,',
      ],
      verifyRoundTrip,
    ],
    [
      'preserving choices on unrelated writes',
      ['...fieldsOf(row),', '...fieldsOf(row), locations: null,'],
      verifyRoundTrip,
    ],
    [
      'read compatibility',
      [
        'location: compatLocation(locations),\n    locations,\n    successRedirect: row',
        'location: row.location,\n    locations,\n    successRedirect: row',
      ],
      verifyProjection,
    ],
    [
      'legacy echoes avoid conference revalidation',
      [
        'changes.locations !== undefined ||',
        'input.location !== undefined || changes.locations !== undefined ||',
      ],
      verifyConferenceEcho,
    ],
    [
      'all-option Meet rules',
      [
        'if (!locations?.some(automaticMeet)) return',
        'if (!locations?.slice(0, 1).some(automaticMeet)) return',
      ],
      verifyMeet,
    ],
    [
      'all-option Zoom rules',
      [
        'if (locations?.some(automaticZoom)) {',
        'if (locations?.slice(0, 1).some(automaticZoom)) {',
      ],
      verifyZoom,
    ],
    [
      'Meet readiness alongside authorized Zoom',
      [
        'if (!locations?.some(automaticMeet)) return',
        'if (locations?.some(automaticZoom) || !locations?.some(automaticMeet)) return',
      ],
      verifyBothConferences,
    ],
    [
      'location replacement readiness',
      ['changes.locations !== undefined ||', 'false ||'],
      verifyMeet,
    ],
    [
      'new Zoom choice authorization',
      ['!fieldsOf(row).locations?.some(automaticZoom) ||', 'false ||'],
      verifyZoom,
    ],
  ])('detects removing %s with a real assertion failure', async (_name, change, verify) => {
    await expect(verify(await sourceCopy(change))).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
