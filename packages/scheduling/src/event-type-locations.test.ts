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
async function sourceCopy(change?: Change): Promise<SourceCopy> {
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
    const module = await import(
      specifier.startsWith('.') ? new URL(specifier, url).href : specifier
    )
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
    const multi = await api.updateEventType(ctx, saved.id, { locations: options })
    expect(multi.locations).toEqual(options)
    const changed = { kind: 'in_person' as const, address: '10 Side Street' }
    expect(await api.updateEventType(ctx, saved.id, { location: changed })).toMatchObject({
      location: changed,
      locations: [{ id: 'legacy', ...changed }],
    })
    expect(await api.updateEventType(ctx, saved.id, { location: null })).toMatchObject({
      locations: null,
      location: null,
    })
  }
  it('keeps single-location clients compatible and makes a legacy edit replace the complete list', () =>
    verifyLegacy())

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

  it('passes unmodified source-copy controls', async () => {
    const api = await sourceCopy()
    await verifyRoundTrip(api)
    await verifyLegacy(api)
    await verifyConflict(api)
    await verifyValidation(api)
    await verifyProjection(api)
    await verifyMeet(api)
    await verifyZoom(api)
    await verifyBothConferences(api)
  })

  it.each<[string, Change, (api: Services) => Promise<void>]>([
    [
      'conflicting write protection',
      ['input.location !== undefined && input.locations !== undefined', 'false'],
      verifyConflict,
    ],
    [
      'legacy conversion',
      [
        'result.locations = locationOptionsFromLegacy(validLocation(input.location))',
        'result.locations = null',
      ],
      verifyLegacy,
    ],
    [
      'write validation',
      [
        'const locations = validateLocationOptions(c.locations)',
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
      ['input.locations !== undefined ||', 'false ||'],
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
