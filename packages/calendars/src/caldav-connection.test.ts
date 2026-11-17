import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { DomainError } from '@hourmere/scheduling/errors'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type CalDavConnectionDeps,
  connectCalDav,
  disconnectCalDav,
  listCalDavConnections,
} from './caldav-connection.ts'
import { readCalDavCredentials } from './caldav-credentials.ts'
import type { CalDavDiscoveryResult } from './caldav-discovery.ts'
import { createCalDavDiscovery } from './caldav-discovery.ts'
import { calendarTestSession, TEST_CALENDAR_KEY } from './testing.ts'

const credentials = {
  serverUrl: 'https://dav.example.com/',
  username: 'synthetic-login',
  password: 'synthetic-app-secret',
}
const home = 'https://dav.example.com/calendars/'
const eventUrl = `${home}events/`
const taskUrl = `${home}tasks/`
const result = (): CalDavDiscoveryResult => ({
  principalUrl: 'https://dav.example.com/principal/',
  calendarHomeUrl: home,
  calendars: [
    {
      url: eventUrl,
      displayName: 'Personal',
      color: '#112233',
      supportsEvents: true,
      canWrite: true,
    },
    { url: taskUrl, displayName: 'Tasks', color: null, supportsEvents: false, canWrite: false },
  ],
})

describe.skipIf(!process.env.DATABASE_URL)('internal CalDAV connection persistence', () => {
  let database: TestDatabase, db: Db
  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(database.pool)
  })
  afterAll(async () => {
    await database?.drop()
  })
  async function setup() {
    const owner = await calendarTestSession(db)
    const discover = vi.fn(async () => result())
    const deps: CalDavConnectionDeps = {
      db,
      client: { discover },
      encryptionKey: TEST_CALENDAR_KEY,
    }
    return { owner, discover, deps }
  }
  it('stores encrypted credentials and selected event calendars without enabling conflict checks or exposing secrets', async () => {
    const s = await setup()
    const connection = await connectCalDav(s.deps, s.owner, credentials, [eventUrl])
    const record = await db
      .selectFrom('calendar_connections')
      .selectAll()
      .where('id', '=', connection.id)
      .executeTakeFirstOrThrow()
    expect(readCalDavCredentials(Buffer.from(TEST_CALENDAR_KEY, 'base64'), record).password).toBe(
      credentials.password,
    )
    const stored = await db
      .selectFrom('calendars')
      .selectAll()
      .where('connection_id', '=', connection.id)
      .execute()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      external_id: eventUrl,
      check_conflicts: false,
      last_synced_at: null,
      access_role: 'writer',
    })
    const listed = await listCalDavConnections(s.deps, s.owner)
    expect(listed).toEqual([
      {
        id: connection.id,
        status: 'active',
        calendars: [
          {
            id: stored[0]?.id,
            displayName: 'Personal',
            color: '#112233',
            readOnly: false,
            available: true,
          },
        ],
      },
    ])
    for (const secret of Object.values(credentials)) {
      expect(JSON.stringify(record)).not.toContain(secret)
      expect(JSON.stringify(listed)).not.toContain(secret)
      expect(JSON.stringify(connection)).not.toContain(secret)
    }
  })
  it('persists the real guarded discovery fixture and ignores provider secret echoes', async () => {
    const s = await setup()
    const xml = (href: string, props: string) =>
      `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
    const bodies = [
      xml(
        '/.well-known/caldav',
        '<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>',
      ),
      xml('/principal/', '<c:calendar-home-set><d:href>/calendars/</d:href></c:calendar-home-set>'),
      xml(
        '/calendars/events/',
        `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${credentials.password}</d:displayname>`,
      ),
    ]
    s.deps.client = createCalDavDiscovery(async () => ({ status: 207, body: bodies.shift() ?? '' }))
    await connectCalDav(s.deps, s.owner, credentials, [eventUrl])
    expect((await listCalDavConnections(s.deps, s.owner))[0]?.calendars[0]).toMatchObject({
      displayName: 'Calendar',
      readOnly: true,
      available: true,
    })
  })
  it('snapshots mutable caller credentials and selection before discovery', async () => {
    const s = await setup(),
      input = { ...credentials },
      selection = [eventUrl]
    s.discover.mockImplementation(async () => {
      input.password = 'changed'
      selection.length = 0
      return result()
    })
    const connection = await connectCalDav(s.deps, s.owner, input, selection)
    const record = await db
      .selectFrom('calendar_connections')
      .selectAll()
      .where('id', '=', connection.id)
      .executeTakeFirstOrThrow()
    expect(readCalDavCredentials(Buffer.from(TEST_CALENDAR_KEY, 'base64'), record).password).toBe(
      credentials.password,
    )
    expect((await listCalDavConnections(s.deps, s.owner))[0]?.calendars).toHaveLength(1)
  })
  it('rejects non-event, unknown and duplicate selections without persisting a connection', async () => {
    const s = await setup()
    for (const selection of [[taskUrl], ['https://dav.example.com/other/'], [eventUrl, eventUrl]]) {
      await expect(connectCalDav(s.deps, s.owner, credentials, selection)).rejects.toMatchObject({
        code: 'caldav_calendar_selection_invalid',
      })
    }
    expect(await listCalDavConnections(s.deps, s.owner)).toEqual([])
  })
  it('reconnects in place and keeps missing calendars unavailable without claiming freshness', async () => {
    const s = await setup()
    const first = await connectCalDav(s.deps, s.owner, credentials, [eventUrl])
    const before = (await listCalDavConnections(s.deps, s.owner))[0]?.calendars[0]
    s.discover.mockResolvedValue({ ...result(), calendars: [] })
    const nextCredentials = { ...credentials, password: 'replacement-app-secret' }
    expect(await connectCalDav(s.deps, s.owner, nextCredentials, [])).toEqual(first)
    expect((await listCalDavConnections(s.deps, s.owner))[0]?.calendars).toEqual([
      { ...before, available: false, readOnly: true, color: null },
    ])
    const record = await db
      .selectFrom('calendar_connections')
      .selectAll()
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow()
    expect(readCalDavCredentials(Buffer.from(TEST_CALENDAR_KEY, 'base64'), record).password).toBe(
      nextCredentials.password,
    )
    s.discover.mockResolvedValue(result())
    await connectCalDav(s.deps, s.owner, nextCredentials, [eventUrl])
    expect((await listCalDavConnections(s.deps, s.owner))[0]?.calendars[0]?.id).toBe(before?.id)
  })
  it('keeps owner accounts isolated even under another organization context and removes only owned credentials', async () => {
    const s = await setup(),
      other = await calendarTestSession(db)
    const connection = await connectCalDav(s.deps, s.owner, credentials, [eventUrl])
    const teamOther = { ...other, organization: s.owner.organization }
    expect(await listCalDavConnections(s.deps, teamOther)).toEqual([])
    await expect(disconnectCalDav(s.deps, teamOther, connection.id)).rejects.toMatchObject({
      code: 'calendar_connection_not_found',
    })
    const second = await connectCalDav(s.deps, teamOther, credentials, [eventUrl])
    expect(second.id).not.toBe(connection.id)
    await disconnectCalDav(s.deps, s.owner, connection.id)
    expect(await listCalDavConnections(s.deps, s.owner)).toEqual([])
    expect(await listCalDavConnections(s.deps, teamOther)).toHaveLength(1)
  })
  it('refuses expired sessions before contacting the provider', async () => {
    const s = await setup()
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where('id', '=', s.owner.sessionId)
      .execute()
    await expect(connectCalDav(s.deps, s.owner, credentials, [eventUrl])).rejects.toMatchObject({
      code: 'session_required',
    })
    expect(s.discover).not.toHaveBeenCalled()
  })
  it('rejects API-key mutation before discovery and rechecks revoked sessions after discovery', async () => {
    const s = await setup()
    const apiKey = {
      ...s.owner,
      kind: 'api_key' as const,
      apiKeyId: s.owner.user.id,
      apiKeyScope: 'full' as const,
    }
    await expect(connectCalDav(s.deps, apiKey, credentials, [eventUrl])).rejects.toMatchObject({
      code: 'session_required',
    })
    expect(s.discover).not.toHaveBeenCalled()
    s.discover.mockImplementation(async () => {
      await db.deleteFrom('auth.session').where('id', '=', s.owner.sessionId).execute()
      return result()
    })
    await expect(connectCalDav(s.deps, s.owner, credentials, [eventUrl])).rejects.toMatchObject({
      code: 'session_required',
    })
    expect(
      await db
        .selectFrom('calendar_connections')
        .select('id')
        .where('user_id', '=', s.owner.user.id)
        .execute(),
    ).toEqual([])
  })
  it('preserves prior configuration after provider failure and does not log or propagate raw errors', async () => {
    const s = await setup()
    const first = await connectCalDav(s.deps, s.owner, credentials, [eventUrl])
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      s.discover.mockImplementation(() => {
        throw new DomainError('invalid', 'provider_error', credentials.password)
      })
      await expect(connectCalDav(s.deps, s.owner, credentials, [])).rejects.toMatchObject({
        code: 'unavailable',
        message: 'CalDAV unavailable',
      })
      expect(log).not.toHaveBeenCalled()
      expect((await listCalDavConnections(s.deps, s.owner))[0]).toMatchObject({
        id: first.id,
        calendars: [{ available: true }],
      })
    } finally {
      log.mockRestore()
    }
  })
  it('rolls back credential rotation if calendar persistence fails', async () => {
    const s = await setup()
    const first = await connectCalDav(s.deps, s.owner, credentials, [eventUrl])
    const invalid = result()
    const calendar = invalid.calendars[0]
    if (!calendar) throw new Error('Missing fixture')
    calendar.displayName = 'invalid\u0000name'
    s.discover.mockResolvedValue(invalid)
    await expect(
      connectCalDav(s.deps, s.owner, { ...credentials, password: 'replacement' }, [eventUrl]),
    ).rejects.toMatchObject({ code: 'unavailable' })
    const record = await db
      .selectFrom('calendar_connections')
      .selectAll()
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow()
    expect(readCalDavCredentials(Buffer.from(TEST_CALENDAR_KEY, 'base64'), record).password).toBe(
      credentials.password,
    )
    expect((await listCalDavConnections(s.deps, s.owner))[0]?.calendars[0]?.displayName).toBe(
      'Personal',
    )
  })
})
