import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  BOOKING_EXPORT_COLUMNS,
  csvCell,
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
        (await read(await exportBookingsCsv(testContext(db, team.as(user)), range)))[1]?.[0],
      ).toBe(id)
    await expect(exportBookingsCsv(testContext(db, team.as(member)), range)).rejects.toMatchObject({
      code: 'insufficient_role',
    })
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', admin.id)
      .execute()
    await expect(exportBookingsCsv(testContext(db, team.as(admin)), range)).rejects.toMatchObject({
      code: 'insufficient_role',
    })
    const forged = { ...member.principal, organization: owner.principal.organization }
    await expect(exportBookingsCsv(testContext(db, forged), range)).rejects.toMatchObject({
      code: 'insufficient_role',
    })
    expect(
      await read(await exportBookingsCsv(testContext(db, owner.principal), range)),
    ).toHaveLength(1)
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
        responses: JSON.stringify({ q: '=ANSWER', other: ['+multi', '\rline'] }),
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
    expect(row[4]).toContain('01:30:00+01:00')
    expect(row[5]).toContain('03:30:00+02:00')
    expect(row[8]).toBe('cancelled')
    expect(row[15]).toBe('api')
    expect(row[17]).not.toBe('')
    expect(JSON.parse(row[12] ?? '')[0].name).toBe('  =HOST("x")')
    expect(JSON.parse(row[14] ?? '')).toEqual({ q: '=ANSWER', other: ['+multi', '\rline'] })
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
  it('holds a cross-connection lease, releases on cancel and timeout, and isolates organizations', async () => {
    const user = await createTestUser(db),
      other = await createTestUser(db)
    const ctx = testContext(db, user.principal)
    const stream = await exportBookingsCsv(ctx, range)
    await expect(exportBookingsCsv(ctx, range)).rejects.toMatchObject({
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
