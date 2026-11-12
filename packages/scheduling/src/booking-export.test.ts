import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { groupFixture, occupiedSlot } from '../../db/src/group-seats-fixtures.ts'
import {
  BOOKING_EXPORT_COLUMNS,
  csvCell,
  EXPORT_STALL_TIMEOUT_MS,
  EXPORT_TIMEOUT_MS,
  exportBookingsCsv,
  prepareBookingExport,
} from './booking-export.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const range = { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' }
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = !quoted
    } else if (ch === ',' && !quoted) {
      row.push(cell)
      cell = ''
    } else if (ch === '\r' && text[i + 1] === '\n' && !quoted) {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else cell += ch
  }
  return rows
}
const read = async (stream: ReadableStream<Uint8Array>) =>
  parseCsv(await new Response(stream).text())

describe('CSV cells', () => {
  it.each([
    '=1',
    '+cmd',
    '-1',
    '@sum',
    '\ttab',
    '\rcarriage',
    '  =x',
    '\u2003+x',
    ' \tplain',
    ' \rplain',
  ])('escapes %j', (value) => {
    expect(parseCsv(`${csvCell(value)}\r\n`)).toEqual([[`'${value}`]])
  })
  it.each(['x;=HYPERLINK("https://evil.invalid")', 'x,  +SUM(1)', 'x;\t@formula', 'x;=1, -2'])(
    'neutralizes formula triggers after locale separators: %j',
    (value) => {
      const encoded = csvCell(value)
      const cell = parseCsv(`${encoded}\r\n`)[0]?.[0] ?? ''
      expect(cell).toBe(`'${value.replace(/;(\s*[=+\-@\t\r])/gu, ";'$1")}`)
      expect(encoded.startsWith('"')).toBe(true)
    },
  )
  it('neutralizes semicolon formulas even when a wrong-delimiter parser splits the full CSV row', () => {
    const row = ['id', 'ordinary', 'x;=HYPERLINK("https://evil.invalid")', 'z;  +CMD']
      .map(csvCell)
      .join(',')
    for (const field of row.split(';')) expect(field).not.toMatch(/^[\s"]*[=+\-@\t\r]/u)
    expect(row).toContain(";'=HYPERLINK")
    expect(row).toContain(";'  +CMD")
  })
  it.each(['x;"=1+1;z', 'x; "@cmd', 'x;""+SUM(1)', '"=HYPERLINK("https://evil.invalid")'])(
    'neutralizes triggers behind quotes when a semicolon parser splits the row: %j',
    (value) => {
      const row = ['id', csvCell(value), 'z'].join(',')
      for (const field of row.split(';')) expect(field).not.toMatch(/^[\s"]*[=+\-@\t\r]/u)
      expect(parseCsv(`${csvCell(value)}\r\n`)[0]?.[0]?.startsWith("'")).toBe(true)
    },
  )
  it('preserves nested JSON after removing the spreadsheet protection prefix', () => {
    const value = JSON.stringify({ q: [1, -2], text: 'ordinary' })
    const cell = parseCsv(`${csvCell(value)}\r\n`)[0]?.[0] ?? ''
    expect(cell[0]).toBe("'")
    expect(JSON.parse(cell.slice(1))).toEqual({ q: [1, -2], text: 'ordinary' })
  })
  it('quotes commas, doubled quotes and line breaks without changing ordinary text', () => {
    for (const value of ['ordinary', 'comma,here', 'a"quote', 'line\nnext', ''])
      expect(parseCsv(`${csvCell(value)}\r\n`)).toEqual([[value]])
    expect(csvCell('a"b')).toBe('"a""b"')
  })
})

describe.skipIf(!process.env.DATABASE_URL)('booking CSV database stream', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function session(principal: Principal): Promise<Principal> {
    const row = await db
      .insertInto('auth.session')
      .values({
        userId: principal.user.id,
        token: randomUUID(),
        activeOrganizationId: principal.organization.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return {
      user: principal.user,
      organization: principal.organization,
      kind: 'session',
      sessionId: row.id,
    }
  }
  it('rejects invalid limits, zones, IDs and stale organization contexts', async () => {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal)
    for (const input of [
      { to: range.from },
      { to: '2028-01-01T00:00:00Z' },
      { from: 'bad' },
      { timeZone: '+01:00' },
      { hostUserId: 'bad' },
      { endAfter: range.to, endTo: range.from },
    ])
      await expect(prepareBookingExport(ctx, { ...range, ...input })).rejects.toThrow()
    const other = await createTestUser(db)
    await expect(
      prepareBookingExport(ctx, {
        ...range,
        expectedOrganizationId: other.principal.organization.id,
      }),
    ).rejects.toMatchObject({ code: 'organization_context_changed' })
    await expect(
      prepareBookingExport(ctx, { ...range, to: '2027-01-02T00:00:00Z' }),
    ).resolves.toMatchObject({ timeZone: 'UTC', bom: false })
  })
  it('enforces live owner/admin membership, real personal ownership and organization isolation', async () => {
    const owner = await createTestUser(db),
      admin = await createTestUser(db),
      member = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'member, admin' },
      { user: member, role: 'member' },
    ])
    const fixtures = createFixtures(db)
    const id = await fixtures.booking(
      team.id,
      [member.id],
      '2026-03-29T00:30:00Z',
      '2026-03-29T01:30:00Z',
    )
    for (const user of [owner, admin])
      expect(
        (
          await read(await exportBookingsCsv(testContext(db, await session(team.as(user))), range))
        )[1]?.[0],
      ).toBe(id)
    await expect(
      exportBookingsCsv(testContext(db, await session(team.as(member))), range),
    ).rejects.toMatchObject({
      code: 'team_management_access_denied',
    })
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', admin.id)
      .execute()
    await expect(
      exportBookingsCsv(testContext(db, await session(team.as(admin))), range),
    ).rejects.toMatchObject({
      code: 'team_management_access_denied',
    })
    const forged = { ...member.principal, organization: owner.principal.organization }
    await expect(exportBookingsCsv(testContext(db, forged), range)).rejects.toMatchObject({
      code: 'insufficient_role',
    })
    expect(
      await read(await exportBookingsCsv(testContext(db, owner.principal), range)),
    ).toHaveLength(1)
  })
  it('keeps team browser exports within the team-admin whitelist and personal exports full on every principal kind', async () => {
    const owner = await createTestUser(db),
      former = await createTestUser(db)
    const team = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    const { id } = await db
      .insertInto('bookings')
      .values({
        organization_id: team.id,
        start_at: '2026-05-01T00:00:00Z',
        end_at: '2026-05-01T01:00:00Z',
        source: 'api',
        manage_token_hash: Buffer.alloc(32, 2),
        title: 'PRIVATE_TITLE',
        responses: JSON.stringify({ q: 'PRIVATE_ANSWER' }),
        cancel_reason: 'PRIVATE_REASON',
        location_option: JSON.stringify({
          id: 'private-option',
          kind: 'link',
          label: 'PRIVATE_LOCATION',
          url: 'https://private.invalid',
        }),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db.insertInto('booking_hosts').values({ booking_id: id, user_id: former.id }).execute()
    const teamSession = await session(team.as(owner))
    const rows = await read(await exportBookingsCsv(testContext(db, teamSession), range))
    expect(rows[0]).toEqual([
      'id',
      'event_type_id',
      'event_type',
      'start',
      'end',
      'start_utc',
      'end_utc',
      'status',
      'invitee_name',
      'invitee_email',
      'guests_count',
      'hosts',
      'cancelled_at',
      'time_zone',
    ])
    expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_|answers|location_option|source|created_at/)
    expect(JSON.stringify(rows)).not.toContain(former.email)
    expect(JSON.parse(rows[1]?.[11] ?? '')).toEqual([{ id: former.id, name: former.name }])
    const oauth: Principal = {
      ...team.as(owner),
      kind: 'oauth',
      oauthConsentId: randomUUID(),
      clientId: 'test',
      scopes: ['mcp:tools'],
    }
    for (const principal of [
      team.as(owner),
      {
        ...team.as(owner),
        kind: 'api_key' as const,
        apiKeyScope: 'read' as const,
        apiKeyId: randomUUID(),
      },
      oauth,
    ])
      await expect(prepareBookingExport(testContext(db, principal), range)).rejects.toMatchObject({
        code: 'team_management_access_denied',
      })
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', teamSession.kind === 'session' ? teamSession.sessionId : '')
      .execute()
    await expect(prepareBookingExport(testContext(db, teamSession), range)).rejects.toMatchObject({
      code: 'team_management_access_denied',
    })
    const personalId = await createFixtures(db).booking(
      owner.principal.organization.id,
      [owner.id],
      '2026-05-01T00:00:00Z',
      '2026-05-01T01:00:00Z',
    )
    await db
      .updateTable('bookings')
      .set({ title: 'PERSONAL_TITLE', responses: JSON.stringify({ q: 'PERSONAL_ANSWER' }) })
      .where('id', '=', personalId)
      .execute()
    for (const principal of [
      owner.principal,
      await session(owner.principal),
      { ...oauth, organization: owner.principal.organization },
    ]) {
      const personal = await read(await exportBookingsCsv(testContext(db, principal), range))
      expect(personal[0]).toEqual([...BOOKING_EXPORT_COLUMNS])
      expect(JSON.stringify(personal)).toContain('PERSONAL_TITLE')
      expect(JSON.stringify(personal)).toContain('PERSONAL_ANSWER')
      expect(JSON.stringify(personal)).toContain(owner.email)
    }
  })
  it('exports projected fields safely, including JSON answers, imported/cancelled rows and DST', async () => {
    const user = await createTestUser(db, '  =HOST("x")')
    const org = user.principal.organization.id
    const eventTypeId = await createFixtures(db).eventType(org, user.id, { title: '  -EVENT' })
    const { id } = await db
      .insertInto('bookings')
      .values({
        organization_id: org,
        event_type_id: eventTypeId,
        start_at: '2026-03-29T00:30:00Z',
        end_at: '2026-03-29T01:30:00Z',
        source: 'api',
        status: 'cancelled',
        cancelled_at: new Date(),
        manage_token_hash: Buffer.alloc(32, 1),
        title: '  @TITLE,"quoted"\nnext',
        responses: JSON.stringify({
          q: '=ANSWER',
          other: ['+multi', '\rline'],
          nested: [1, -2],
          separator: 'x;=formula',
        }),
        location_option: JSON.stringify({
          id: 'option',
          kind: 'link',
          label: '=LABEL',
          url: 'https://private.invalid/secret',
        }),
        cancel_reason: 'PRIVATE_REASON',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db.insertInto('booking_hosts').values({ booking_id: id, user_id: user.id }).execute()
    await db
      .insertInto('booking_attendees')
      .values({
        booking_id: id,
        name: '\t=NAME',
        email: '+EMAIL@example.com',
        time_zone: 'UTC',
        is_booker: true,
      })
      .execute()
    const text = await new Response(
      await exportBookingsCsv(testContext(db, user.principal), {
        ...range,
        timeZone: 'Europe/Berlin',
        bom: true,
      }),
    ).text()
    const rows = parseCsv(text)
    expect(rows[0]).toEqual([...BOOKING_EXPORT_COLUMNS])
    const row = rows[1] ?? []
    expect(row[2]).toBe("'  -EVENT")
    expect(row[3]).toBe('\'  @TITLE,"quoted"\nnext')
    expect(row[9]).toBe("'\t=NAME")
    expect(row[10]).toBe("'+EMAIL@example.com")
    expect(row[4]).toBe('2026-03-29T01:30:00+01:00')
    expect(row.at(-1)).toBe('Europe/Berlin')
    expect(row[5]).toBe('2026-03-29T03:30:00+02:00')
    expect(row[8]).toBe('cancelled')
    expect(row[15]).toBe('api')
    expect(row[17]).not.toBe('')
    expect(JSON.parse(row[12] ?? '')[0].name).toBe('  =HOST("x")')
    expect(JSON.parse((row[14] ?? '').replace(/^'/u, ''))).toEqual({
      q: '=ANSWER',
      other: ['+multi', '\rline'],
      nested: [1, -2],
      separator: 'x;=formula',
    })
    expect(row[13]).toBe('{"id":"option","kind":"link","label":"=LABEL"}')
    expect(text).not.toMatch(/PRIVATE_REASON|private.invalid|manage_token|hash|credential/)
    await createFixtures(db).booking(
      org,
      [user.id],
      '2026-03-30T00:30:00Z',
      '2026-03-30T01:30:00Z',
      { source: 'import' },
    )
    const imported = await read(
      await exportBookingsCsv(testContext(db, user.principal), { ...range, status: 'confirmed' }),
    )
    expect(imported[1]?.[15]).toBe('import')
    expect(
      await read(
        await exportBookingsCsv(testContext(db, user.principal), {
          ...range,
          status: 'confirmed',
          to: '2026-03-30T00:00:00Z',
        }),
      ),
    ).toHaveLength(1)
    expect(
      await read(
        await exportBookingsCsv(testContext(db, user.principal), {
          ...range,
          hostUserId: (await createTestUser(db)).id,
        }),
      ),
    ).toHaveLength(1)
  })
  it('preserves autumn repeated times, filters and replayed reschedule history', async () => {
    const user = await createTestUser(db)
    const org = user.principal.organization.id
    const ctx = testContext(db, user.principal)
    const f = createFixtures(db)
    const event = await f.eventType(org, user.id)
    const old = await f.booking(org, [user.id], '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z', {
      eventTypeId: event,
      status: 'cancelled',
    })
    const next = await f.booking(org, [user.id], '2026-10-26T00:30:00Z', '2026-10-26T01:30:00Z', {
      eventTypeId: event,
    })
    await db
      .updateTable('bookings')
      .set({ rescheduled_from_id: old })
      .where('id', '=', next)
      .execute()
    await f.booking(org, [user.id], '2026-10-27T00:30:00Z', '2026-10-27T01:30:00Z')
    const filters = {
      ...range,
      eventTypeId: event,
      hostUserId: user.id,
      timeZone: 'Europe/Berlin',
      order: 'desc' as const,
    }
    const rows = await read(await exportBookingsCsv(ctx, filters))
    expect(rows.slice(1).map((row) => row[0])).toEqual([next, old])
    expect(rows[2]?.[4]).toContain('02:30:00+02:00')
    expect(rows[2]?.[5]).toContain('02:30:00+01:00')
    expect(await read(await exportBookingsCsv(ctx, filters))).toEqual(rows)
    const bounded = await read(
      await exportBookingsCsv(ctx, {
        ...filters,
        endAfter: '2026-10-25T01:30:00Z',
        endTo: '2026-10-26T01:30:00Z',
      }),
    )
    expect(bounded.slice(1).map((row) => row[0])).toEqual([next])
  })
  it('caps exports across organizations before connection acquisition and keeps queries responsive', async () => {
    const users = await Promise.all(Array.from({ length: 3 }, () => createTestUser(db)))
    const streams: ReadableStream<Uint8Array>[] = []
    try {
      for (const user of users.slice(0, 2))
        streams.push(await exportBookingsCsv(testContext(db, user.principal), range))
      const third = users[2]
      if (!third) throw new Error('missing fixture')
      const connect = vi.spyOn(owned.pool, 'connect')
      try {
        await expect(
          exportBookingsCsv(testContext(db, third.principal), range).then((stream) => {
            streams.push(stream)
            return stream
          }),
        ).rejects.toMatchObject({ code: 'export_busy' })
        expect(connect).not.toHaveBeenCalled()
      } finally {
        connect.mockRestore()
      }
      const response = await Promise.race([
        sql`SELECT 1 AS answer`.execute(db),
        new Promise<never>((_, reject) => {
          const timeout = setTimeout(() => reject(new Error('unrelated query blocked')), 1000)
          timeout.unref()
        }),
      ])
      expect(response.rows).toEqual([{ answer: 1 }])
      expect(owned.pool.waitingCount).toBe(0)
    } finally {
      await Promise.all(streams.map((stream) => stream.cancel()))
    }
  })
  it('uses the configured process limit and releases reservations after validation failure', async () => {
    const user = await createTestUser(db),
      other = await createTestUser(db)
    const ctx = { ...testContext(db, user.principal), bookingExportMaxConcurrent: 1 }
    await expect(exportBookingsCsv(ctx, { ...range, from: 'bad' })).rejects.toMatchObject({
      code: 'invalid_export_range',
    })
    const stream = await exportBookingsCsv(ctx, range)
    const otherCtx = { ...testContext(db, other.principal), bookingExportMaxConcurrent: 1 }
    let unexpected: ReadableStream<Uint8Array> | undefined
    try {
      await expect(
        exportBookingsCsv(otherCtx, range).then((result) => {
          unexpected = result
          return result
        }),
      ).rejects.toMatchObject({ code: 'export_busy' })
    } finally {
      await stream.cancel()
      await unexpected?.cancel()
    }
    await (await exportBookingsCsv(otherCtx, range)).cancel()
  })
  it('limits each user across personal and team exports before acquiring a connection', async () => {
    const user = await createTestUser(db),
      other = await createTestUser(db)
    const team = await createTestTeam(db, [{ user, role: 'owner' }])
    const personal = testContext(db, user.principal)
    const teamContext = testContext(db, await session(team.as(user)))
    const streams: ReadableStream<Uint8Array>[] = []
    try {
      // Starting both calls together exercises reservation before asynchronous permission checks.
      const first = exportBookingsCsv(personal, range)
      const connect = vi.spyOn(owned.pool, 'connect')
      try {
        await expect(
          exportBookingsCsv(teamContext, range).then((stream) => {
            streams.push(stream)
            return stream
          }),
        ).rejects.toMatchObject({ code: 'export_user_in_progress' })
        expect(connect).not.toHaveBeenCalled()
      } finally {
        connect.mockRestore()
        streams.push(await first)
      }
      streams.push(await exportBookingsCsv(testContext(db, other.principal), range))
      await expect(exportBookingsCsv(teamContext, range)).rejects.toMatchObject({
        code: 'export_user_in_progress',
      })
    } finally {
      await Promise.all(streams.map((stream) => stream.cancel()))
    }
    // Cancellation frees the user reservation as well as the process slot.
    await expect(
      exportBookingsCsv(teamContext, range).then((stream) => stream.cancel()),
    ).resolves.toBeUndefined()
  })
  it('releases the connection and export slots when the stream is never read', async () => {
    const user = await createTestUser(db)
    const ctx = { ...testContext(db, user.principal), bookingExportMaxConcurrent: 1 }
    const idleBefore = owned.pool.totalCount - owned.pool.idleCount
    let stream: ReadableStream<Uint8Array> | undefined
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      stream = await exportBookingsCsv(ctx, range)
      expect(owned.pool.totalCount - owned.pool.idleCount).toBe(idleBefore + 1)
      await vi.advanceTimersByTimeAsync(EXPORT_STALL_TIMEOUT_MS)
      vi.useRealTimers()
      // No reader is acquired until after the connection has returned.
      await vi.waitFor(() => expect(owned.pool.totalCount - owned.pool.idleCount).toBe(idleBefore))
      await expect(stream.getReader().read()).rejects.toThrow('reader timed out')
      await (await exportBookingsCsv(ctx, range)).cancel()
    } finally {
      vi.useRealTimers()
      if (stream && !stream.locked) await stream.cancel().catch(() => {})
    }
  })
  it('emits personal and team headers in exactly the documented order', async () => {
    const doc = readFileSync(
      new URL('../../../apps/site/src/content/docs/docs/booking-export.md', import.meta.url),
      'utf8',
    )
    const personalColumns = [
      ...(doc.split('## Columns')[1] ?? '').matchAll(/^\| `([^`]+)` \|/gmu),
    ].map((match) => match[1])
    const teamSection = doc.match(/Team exports use only ([\s\S]*?)\./u)?.[1] ?? ''
    const teamColumns = [...teamSection.matchAll(/`([^`]+)`/gu)].map((match) => match[1])
    const user = await createTestUser(db)
    const team = await createTestTeam(db, [{ user, role: 'owner' }])
    const personal = await read(await exportBookingsCsv(testContext(db, user.principal), range))
    const teamRows = await read(
      await exportBookingsCsv(testContext(db, await session(team.as(user))), range),
    )
    expect(personalColumns).toEqual(personal[0])
    expect(teamColumns).toEqual(teamRows[0])
  })
  it('cuts off stalled readers and returns their database connection', async () => {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal)
    const idleBefore = owned.pool.totalCount - owned.pool.idleCount
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const stream = await exportBookingsCsv(ctx, range)
      const reader = stream.getReader()
      await reader.read()
      expect(owned.pool.totalCount - owned.pool.idleCount).toBe(idleBefore + 1)
      await vi.advanceTimersByTimeAsync(EXPORT_STALL_TIMEOUT_MS)
      await expect(reader.read()).rejects.toThrow('reader timed out')
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() => expect(owned.pool.totalCount - owned.pool.idleCount).toBe(idleBefore))
    await (await exportBookingsCsv(ctx, range)).cancel()
  })
  it('releases a disconnected locked reader and an already-aborted request', async () => {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal)
    const signal = new AbortController()
    const stream = await exportBookingsCsv(ctx, range, signal.signal)
    const reader = stream.getReader()
    await reader.read()
    signal.abort()
    await expect(reader.read()).rejects.toThrow('aborted')
    await vi.waitFor(async () => {
      const retry = await exportBookingsCsv(ctx, range)
      await retry.cancel()
    })
    const ended = await exportBookingsCsv(ctx, range, AbortSignal.abort())
    await expect(ended.getReader().read()).rejects.toThrow('aborted')
    await vi.waitFor(async () => {
      const retry = await exportBookingsCsv(ctx, range)
      await retry.cancel()
    })
  })
  it('exports group seats with resolved hosts and isolated per-seat attendee fields', async () => {
    const f = await groupFixture(owned.pool)
    const { bookings } = await occupiedSlot(f, 2)
    const first = bookings[0] as string,
      second = bookings[1] as string
    await db
      .insertInto('auth.member')
      .values({
        organizationId: f.organization,
        userId: f.host,
        role: 'admin',
        createdAt: new Date(),
      })
      .execute()
    const host = await db
      .selectFrom('auth.user')
      .select(['id', 'name', 'email'])
      .where('id', '=', f.host)
      .executeTakeFirstOrThrow()
    const ctx = testContext(
      db,
      await session({
        kind: 'api_key',
        apiKeyId: 'synthetic-key',
        apiKeyScope: 'read',
        user: host,
        organization: { id: f.organization, name: 'Group team', slug: 'group', personal: false },
      }),
    )
    await db
      .updateTable('booking_attendees')
      .set({ name: 'First seat' })
      .where('booking_id', '=', first)
      .execute()
    await db
      .updateTable('booking_attendees')
      .set({ name: 'Private sibling' })
      .where('booking_id', '=', second)
      .execute()
    await db
      .updateTable('bookings')
      .set({
        responses: JSON.stringify({ q: 'first-answer' }),
        status: 'cancelled',
        cancelled_at: new Date(),
      })
      .where('id', '=', first)
      .execute()
    await db
      .updateTable('bookings')
      .set({ responses: JSON.stringify({ q: 'private-sibling-answer' }) })
      .where('id', '=', second)
      .execute()
    const filters = {
      from: '2032-01-01T00:00:00Z',
      to: '2032-01-03T00:00:00Z',
      eventTypeId: f.event,
    }
    const all = await read(await exportBookingsCsv(ctx, filters))
    expect(
      all
        .slice(1)
        .map((row) => row[0])
        .sort(),
    ).toEqual([...bookings].sort())
    for (const row of all.slice(1)) {
      const data = Object.fromEntries((all[0] ?? []).map((column, index) => [column, row[index]]))
      expect(JSON.parse(data.hosts ?? '')).toEqual([{ id: host.id, name: host.name }])
      expect(data.guests_count).toBe('0')
      if (row[0] === first) {
        expect(data.status).toBe('cancelled')
        expect(data.invitee_name).toBe('First seat')
        expect(data.invitee_email).toContain('@example.test')
        expect(row.join(',')).not.toContain('Private sibling')
        expect(row.join(',')).not.toContain('private-sibling-answer')
        expect(data).not.toHaveProperty('answers')
        expect(row.join(',')).not.toContain('first-answer')
      } else {
        expect(data.status).toBe('confirmed')
        expect(data.invitee_name).toBe('Private sibling')
        expect(row.join(',')).not.toContain('first-answer')
      }
    }
    expect(await read(await exportBookingsCsv(ctx, { ...filters, hostUserId: f.host }))).toEqual(
      all,
    )
    expect(
      await read(await exportBookingsCsv(ctx, { ...filters, hostUserId: f.otherHost })),
    ).toHaveLength(1)
    const cancelled = await read(
      await exportBookingsCsv(ctx, { ...filters, hostUserId: f.host, status: 'cancelled' }),
    )
    expect(cancelled.slice(1).map((row) => row[0])).toEqual([first])
    const outsider = await createTestUser(db)
    expect(
      await read(
        await exportBookingsCsv(testContext(db, outsider.principal), {
          ...filters,
          hostUserId: f.host,
        }),
      ),
    ).toHaveLength(1)
  })
  it('holds a cross-connection lease, releases on cancel and timeout, and isolates organizations', async () => {
    const user = await createTestUser(db),
      other = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user, role: 'owner' },
      { user: other, role: 'admin' },
    ])
    const ctx = testContext(db, await session(team.as(user)))
    const otherContext = testContext(db, await session(team.as(other)))
    const stream = await exportBookingsCsv(ctx, range)
    await expect(exportBookingsCsv(otherContext, range)).rejects.toMatchObject({
      code: 'export_in_progress',
    })
    await (await exportBookingsCsv(testContext(db, other.principal), range)).cancel()
    await stream.cancel()
    const again = await exportBookingsCsv(ctx, range)
    await again.cancel()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timed = await exportBookingsCsv(ctx, range)
    await vi.advanceTimersByTimeAsync(EXPORT_TIMEOUT_MS)
    await expect(timed.getReader().read()).rejects.toThrow('timed out')
    vi.useRealTimers()
    // A subsequent database statement waits until rollback/commit has completed.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await (await exportBookingsCsv(ctx, range)).cancel()
  })
  it('streams over 10k rows with bounded pages, stable keysets and a consistent cancellation snapshot', async () => {
    const user = await createTestUser(db)
    const org = user.principal.organization.id
    let largestPage = 0
    const observed = db.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        if (result.rows.some((row) => Object.hasOwn(row, 'cursor_start')))
          largestPage = Math.max(largestPage, result.rows.length)
        return result
      },
    })
    const ctx = testContext(observed, user.principal)
    await sql`INSERT INTO bookings (organization_id,start_at,end_at,title,source,manage_token_hash)
      SELECT ${org}::uuid,'2026-06-01T10:00:00Z'::timestamptz + n * interval '1 microsecond','2026-06-01T11:00:00Z'::timestamptz,'row-' || n,'api',decode(md5(n::text),'hex') FROM generate_series(1,10005) n`.execute(
      db,
    )
    const reader = (await exportBookingsCsv(ctx, range)).getReader()
    await reader.read()
    const before = process.memoryUsage().heapUsed
    let maximum = before
    let count = 0
    const ids = new Set<string>()
    const first = await reader.read()
    expect(first.done).toBe(false)
    ids.add(parseCsv(new TextDecoder().decode(first.value))[0]?.[0] ?? '')
    count++
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: new Date() })
      .where('organization_id', '=', org)
      .execute()
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const row = parseCsv(new TextDecoder().decode(next.value))[0] ?? []
      expect(row[8]).toBe('confirmed')
      expect(ids.has(row[0] ?? '')).toBe(false)
      ids.add(row[0] ?? '')
      count++
      if (count % 100 === 0) maximum = Math.max(maximum, process.memoryUsage().heapUsed)
    }
    expect(largestPage).toBeLessThanOrEqual(100)
    expect(count).toBe(10005)
    expect(ids.size).toBe(10005)
    expect(maximum - before).toBeLessThan(64 * 1024 * 1024)
  }, 60_000)
})
