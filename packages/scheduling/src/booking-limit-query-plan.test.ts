// Exercise the production query against enough unrelated history to expose an
// unbounded join. One shared throwaway pool owns every connection in this file.
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { type CompiledQuery, PostgresQueryCompiler, type QueryId, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertCachedCalendarSync,
  buildAvailabilityInput,
  selectDurationMinutes,
  toInstant,
} from './availability.ts'
import { DomainError } from './errors.ts'
import { createFixtures } from './testing.ts'

type Build = typeof buildAvailabilityInput
type Change = readonly [string, string]
type Limits = 'none' | 'week' | 'month'
interface PlanNode {
  'Node Type': string
  'Index Name'?: string
  'Relation Name'?: string
  'Actual Rows'?: number
  Plans?: PlanNode[]
}
interface Explanation {
  Plan: PlanNode
  'Execution Time': number
}

const serverUrl = process.env.DATABASE_URL
const rangeStart = Temporal.Instant.from('2026-11-01T12:00Z')
const rangeEnd = Temporal.Instant.from('2027-01-02T12:00Z')
const now = Temporal.Instant.from('2026-01-01T00:00Z')
const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)]

/** Compile copies of the real function; mutants never alter the shared source file. */
function sourceCopy(change?: Change): Build {
  const original = readFileSync(new URL('./availability.ts', import.meta.url), 'utf8')
  const start = original.indexOf('export async function buildAvailabilityInput(')
  const end = original.indexOf('/**\n * The slots one host', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  let source = original.slice(start, end)
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source).replace(/\bexport /g, '')
  const bindings = {
    sql,
    selectDurationMinutes,
    toInstant,
    assertCachedCalendarSync,
    eventTypeNotFound: () => new DomainError('not_found', 'event_type_not_found'),
    earlier: (a: Temporal.Instant, b: Temporal.Instant) =>
      Temporal.Instant.compare(a, b) <= 0 ? a : b,
    later: (a: Temporal.Instant, b: Temporal.Instant) =>
      Temporal.Instant.compare(a, b) >= 0 ? a : b,
  }
  return new Function(...Object.keys(bindings), `${source}; return buildAvailabilityInput`)(
    ...Object.values(bindings),
  ) as Build
}

describe.skipIf(!serverUrl)('indexed booking limit availability queries', () => {
  let owned: TestDatabase
  let db: Db
  let host: { userId: string; organizationId: string; eventTypeId: string }

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'limit_plan' })
    db = createDb(owned.pool)
    const f = createFixtures(db)
    const hosts = []
    for (let i = 0; i < 31; i++) {
      const h = await f.host({ timeZone: 'UTC' })
      const eventTypeId = await f.eventType(h.organizationId, h.userId)
      hosts.push({ userId: h.userId, organizationId: h.organizationId, eventTypeId })
    }
    const first = hosts[0]
    if (!first) throw new Error('missing query-plan host')
    host = first
    await f.schedule(host.userId, { timeZone: 'UTC' })
    await owned.pool.query(
      `INSERT INTO bookings (organization_id,event_type_id,title,start_at,end_at,source)
       SELECT h."organizationId"::uuid,h."eventTypeId"::uuid,'Synthetic query-plan booking',
         '2025-01-01T00:00Z'::timestamptz + n * interval '2 hours',
         '2025-01-01T00:30Z'::timestamptz + n * interval '2 hours','api'
       FROM jsonb_to_recordset($1::jsonb)
         AS h("organizationId" text,"eventTypeId" text)
       CROSS JOIN generate_series(0,9999) AS n`,
      [JSON.stringify(hosts)],
    )
    await owned.pool.query(
      `INSERT INTO booking_hosts (booking_id,user_id)
       SELECT b.id,et.owner_user_id FROM bookings b
       JOIN event_types et ON et.id=b.event_type_id`,
    )
    await owned.pool.query('ANALYZE bookings; ANALYZE booking_hosts; ANALYZE event_types')
  }, 60_000)

  afterAll(async () => {
    await owned?.drop()
  })

  async function capture(limits: Limits, build: Build = buildAvailabilityInput) {
    await db
      .updateTable('event_types')
      .set({
        max_bookings_per_week: limits === 'week' ? 1000 : null,
        max_bookings_per_month: limits === 'month' ? 1000 : null,
      })
      .where('id', '=', host.eventTypeId)
      .execute()
    const queries: CompiledQuery[] = []
    const compiled = new WeakMap<QueryId, CompiledQuery>()
    const observed = db.withPlugin({
      transformQuery({ node, queryId }) {
        const query = new PostgresQueryCompiler().compileQuery(node, queryId)
        compiled.set(queryId, query)
        return node
      },
      async transformResult({ queryId, result }) {
        const query = compiled.get(queryId)
        if (query?.sql.includes('"booking_hosts" as "bh"')) queries.push(query)
        return result
      },
    })
    const input = await build(observed, {
      eventTypeId: host.eventTypeId,
      hostUserId: host.userId,
      rangeStart,
      rangeEnd,
      now,
    })
    expect(queries).toHaveLength(1)
    const query = queries[0]
    if (!query) throw new Error('missing production booking query')
    return { query, input }
  }

  async function assertIndexed(limits: Limits, build?: Build) {
    const { query, input } = await capture(limits, build)
    const explained = await db.executeQuery<{ 'QUERY PLAN': Explanation[] }>({
      ...query,
      sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
    })
    const explanation = explained.rows[0]?.['QUERY PLAN'][0]
    if (!explanation) throw new Error('missing production booking query plan')
    const nodes = planNodes(explanation.Plan)
    const indexes = nodes.flatMap((node) => (node['Index Name'] ? [node['Index Name']] : []))
    expect(indexes, 'short-window overlap uses the GiST index').toContain(
      'booking_hosts_no_overlap',
    )
    expect(
      nodes.filter(
        (node) => node['Relation Name'] === 'bookings' && node['Node Type'] === 'Seq Scan',
      ),
      'availability must not scan unrelated bookings',
    ).toEqual([])
    if (limits === 'none') {
      expect(query.sql, 'unlimited types omit the complete-period branch').not.toMatch(
        /\bunion all\b/i,
      )
      expect(indexes).not.toContain('bookings_event_type_start')
    } else {
      expect(query.sql).toMatch(/\bunion all\b/i)
      expect(indexes, 'complete periods use the event-type/start index').toContain(
        'bookings_event_type_start',
      )
    }
    const overlapping = Temporal.Instant.from('2026-11-02T12:00Z')
    expect(
      input?.bookings?.filter((booking) => booking.start.equals(overlapping)),
      'a booking found by both predicates consumes capacity once',
    ).toHaveLength(1)
    const fullPeriodOnly = Temporal.Instant.from(
      limits === 'month' ? '2026-10-02T12:00Z' : '2026-10-27T12:00Z',
    )
    expect(
      input?.bookings?.filter((booking) => booking.start.equals(fullPeriodOnly)),
      'only configured longer periods include bookings outside the overlap window',
    ).toHaveLength(limits === 'none' ? 0 : 1)
    return explanation
  }

  it.each<Limits>(['none', 'week', 'month'])(
    'uses bounded indexed plans with %s limits across 310,000 bookings',
    async (limits) => {
      await assertIndexed(limits)
    },
  )

  it('detects adding the full-period branch to unlimited event types', async () => {
    const copy = sourceCopy(['.$if(periodWindows.length > 0, (q) =>', '.$if(true, (q) =>'])
    await expect(assertIndexed('none', copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects counting overlapping bookings in both UNION ALL branches', async () => {
    const copy = sourceCopy([".where((eb) => eb.not(eb('bh.period', '&&', windowRange(eb))))", ''])
    await expect(assertIndexed('week', copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects the cross-table OR that scans unrelated booking history', async () => {
    const original = readFileSync(new URL('./availability.ts', import.meta.url), 'utf8')
    const start = original.indexOf('    hostBookings\n')
    const end = original.indexOf('\n      .execute(),', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const copy = sourceCopy([
      original.slice(start, end),
      `    hostBookings.where((eb) => eb.or([
        eb('bh.period', '&&', windowRange(eb)),
        eb.and([
          eb('b.event_type_id', '=', eventTypeId),
          eb('b.start_at', '>=', new Date(bookingWindow.start.epochMilliseconds)),
          eb('b.start_at', '<', new Date(bookingWindow.end.epochMilliseconds)),
        ]),
      ]))`,
    ])
    await expect(assertIndexed('month', copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
