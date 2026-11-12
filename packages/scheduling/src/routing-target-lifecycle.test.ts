// Routing target lifecycle (docs/routing-forms.md, step a4) against real PostgreSQL in a
// throwaway database: target invalidation inside event-type deletion and updates and
// administrative member removal, health rederived on read, publication racing deletion and
// removal on separate connections in both orders, and the off state (with no form, the
// existing responses are byte-identical to the code without the routing calls). Protection
// scenarios take the module under test as a parameter; the source-copy controls at the end
// require each to fail a real assertion on a copy with that one protection removed.
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { type Principal, removeTeamMember } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as EventTypes from './event-types.ts'
import { leaveTeamMember } from './member-leave.ts'
import * as Service from './routing-form-service.ts'
import { refreshRoutingTargetHealth } from './routing-target-lifecycle.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type EventTypeFixture,
  testContext,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
type EventTypeModule = typeof EventTypes
type ServiceModule = typeof Service
type Remove = typeof removeTeamMember

const EVENT_TYPES = new URL('./event-types.ts', import.meta.url)
const SERVICE = new URL('./routing-form-service.ts', import.meta.url)
const REMOVAL = new URL('../../auth/src/team-member-removal.ts', import.meta.url)

/** Imports an isolated copy with exactly-once replacements; the shipped file is untouched. */
async function importCopy<T>(location: URL, ...replacements: (readonly [string, string])[]) {
  let source = readFileSync(location, 'utf8')
  for (const [from, to] of replacements) {
    expect(source.split(from), `mutation must match once: ${from}`).toHaveLength(2)
    source = source.replace(from, to)
  }
  const module = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(
    `data:text/javascript;base64,${Buffer.from(module).toString('base64')}`
  ) as Promise<T>
}

// Exact source text that the off comparison and the mutation controls remove or replace.
const UPDATE_REFRESH = `      // Routing targets on this event type follow its updated row, disabling included.
      await refreshRoutingTargetHealth(
        trx,
        row.organization_id,
        [row.id],
        new Date(ctx.now().epochMilliseconds),
      )
`
const DELETE_REFRESH =
  '    await refreshRoutingTargetHealth(trx, row.organization_id, [row.id], deletedAt)\n'
const REMOVAL_MARK = `  // Routing forms never block removal: their targets on a deactivated event type, fallback
  // included, are marked unavailable under the organization and event-type locks held here.
  await setRoutingTargetHealth(
    trx,
    actor.organizationId,
    deactivatedEventTypeIds.map((eventTypeId) => ({ eventTypeId, health: 'unavailable' })),
    new Date(),
  )
`
// A blocker a careless implementation might add: refuse deletion while a form targets it.
const DELETE_BLOCKER = `${DELETE_REFRESH}    if ((await sql\`SELECT 1 FROM routing_target_dependencies WHERE event_type_id = \${row.id}\`.execute(trx)).rows.length > 0)
      throw new DomainError('conflict', 'event_type_in_use', 'A routing form uses this event type')
`
const UNKNOWN_TARGET = `    // Stored by another release, say: this one cannot tell whether routing can use it.
    return { eventTypeId: null, health: 'unknown', reason: null }`
const UNREADABLE_RULE = `    if (target.ruleId === null) entry.unreadable = true
    else entry.health.targets.push({ ruleId: target.ruleId, ...targetHealth(target) })`
const PUBLISH_EVENT_LOCKS = `        await lockTargetEvents(
          trx,
          organizationId,
          targets.map((target) => target.eventTypeId),
        )
        const form = await findForm(trx, organizationId, id, true)`

/** Source copies load their own error classes, so failures compare by name and code. */
function described(error: unknown) {
  const e = error as { name?: string; kind?: string; code?: string; reason?: string }
  return { name: e?.name, kind: e?.kind, code: e?.code, reason: e?.reason }
}

async function succeeds<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    const { name, code } = described(error)
    return expect.unreachable(`expected success, got ${name} ${code}`)
  }
}

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }) as { value: T; error?: undefined },
    (error: unknown) => ({ error }) as { value?: undefined; error: unknown },
  )

const session = (principal: Principal, sessionId: string = randomUUID()): Principal => ({
  kind: 'session',
  sessionId,
  user: principal.user,
  organization: principal.organization,
})

/** A fallback and one rule per entry; null means a message instead of an event target. */
function draft(rules: (string | null)[], fallback: string | null) {
  const question = randomUUID()
  const options = rules.map(() => randomUUID())
  const ruleIds = rules.map(() => randomUUID())
  return {
    ruleIds,
    input: {
      questions: [
        {
          id: question,
          type: 'select',
          label: 'Topic',
          required: true,
          options: options.map((id, i) => ({ id, label: `Topic ${i + 1}` })),
        },
      ],
      rules: rules.map((target, i) => ({
        id: ruleIds[i],
        conditions: [{ questionId: question, operator: 'equals', value: options[i] }],
        target:
          target === null
            ? { kind: 'message', message: 'Thank you' }
            : { kind: 'event', eventTypeId: target },
      })),
      fallback:
        fallback === null
          ? { kind: 'message', message: 'Thank you' }
          : { kind: 'event', eventTypeId: fallback },
    },
  }
}

const slug = () => `form-${randomUUID().slice(0, 8)}`

describe.skipIf(!serverUrl)('routing target lifecycle', () => {
  let owned: TestDatabase
  let db: Db
  let f: ReturnType<typeof createFixtures>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'routing_life' })
    db = createDb(owned.pool)
    f = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  /** A user acting by session in their personal organization. */
  async function personalSpace() {
    const user = await createTestUser(db, 'Routing author')
    const organizationId = user.principal.organization.id
    return {
      user,
      organizationId,
      ctx: testContext(db, session(user.principal)),
      event: (o: EventTypeFixture = {}) => f.eventType(organizationId, user.id, o),
    }
  }

  async function sessionRow(userId: string, organizationId: string) {
    const { id } = await db
      .insertInto('auth.session')
      .values({
        userId,
        token: randomBytes(24).toString('base64url'),
        activeOrganizationId: organizationId,
        expiresAt: sql<Date>`clock_timestamp() + interval '1 hour'`,
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  /**
   * A team whose owner removes `host`, and whose admin manages its forms. Three team events:
   * `single` hosted by `host` alone and `collective` with `host` and the admin are deactivated
   * by the removal; `pool` is round-robin over both and stays active.
   */
  async function teamSpace() {
    const owner = await createTestUser(db, 'Owner')
    const admin = await createTestUser(db, 'Admin')
    const host = await createTestUser(db, 'Departing host')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: host, role: 'member' },
    ])
    const ownerPrincipal = session(team.as(owner), await sessionRow(owner.id, team.id))
    const single = await f.eventType(team.id, null, { hosts: [{ userId: host.id }] })
    const collective = await f.eventType(team.id, null, {
      hosts: [{ userId: host.id }, { userId: admin.id }],
    })
    const pool = await f.eventType(team.id, null, {
      hosts: [{ userId: host.id }, { userId: admin.id }],
    })
    await sql`UPDATE event_types SET scheduling_type = 'collective' WHERE id = ${collective}`.execute(
      db,
    )
    await sql`UPDATE event_types SET scheduling_type = 'round_robin' WHERE id = ${pool}`.execute(db)
    return {
      team,
      owner,
      admin,
      host,
      single,
      collective,
      pool,
      adminCtx: testContext(db, session(team.as(admin))),
      remove: (remove: Remove = removeTeamMember) =>
        remove(db, ownerPrincipal, {
          teamId: team.id,
          memberUserId: host.id,
          expectedOrganizationId: team.id,
        }),
    }
  }

  async function publishedForm(
    ctx: ReturnType<typeof testContext>,
    rules: (string | null)[],
    fallback: string | null,
  ) {
    const { input, ruleIds } = draft(rules, fallback)
    const form = await Service.createRoutingForm(ctx, { slug: slug(), title: 'Routing', ...input })
    const { version } = await Service.publishRoutingForm(ctx, form.id, { expectedRevision: 1 })
    return { formId: form.id, versionId: version.id, ruleIds }
  }

  async function markers(versionId: string) {
    return Object.fromEntries(
      (
        await db
          .selectFrom('routing_target_dependencies')
          .select(['rule_id', 'event_type_id', 'health_code'])
          .where('version_id', '=', versionId)
          .execute()
      ).map((row) => [row.rule_id, row.health_code]),
    )
  }

  async function versionNumbers(formId: string) {
    return (
      await db
        .selectFrom('routing_form_versions')
        .select('version_number')
        .where('form_id', '=', formId)
        .orderBy('version_number')
        .execute()
    ).map((row) => row.version_number)
  }

  /** Every routing row of the organization except the health markers, for history checks. */
  async function history(organizationId: string) {
    const { rows } = await sql<{ history: unknown }>`
      SELECT jsonb_build_object(
        'forms', (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM routing_forms f
          WHERE f.organization_id = ${organizationId}),
        'versions', (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM routing_form_versions v
          WHERE v.organization_id = ${organizationId}),
        'dependencies', (SELECT jsonb_agg(to_jsonb(d) - 'health_code' - 'health_checked_at'
          ORDER BY d.version_id, d.rule_id) FROM routing_target_dependencies d
          WHERE d.organization_id = ${organizationId}),
        'snapshots', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.booking_id) FROM booking_routing b
          WHERE b.organization_id = ${organizationId})
      ) AS history`.execute(db)
    return rows[0]?.history
  }

  /** A routed booking's snapshot, which history must keep whatever happens to its target. */
  async function snapshot(
    organizationId: string,
    eventTypeId: string,
    formId: string,
    versionId: string,
  ) {
    const booking = await db
      .insertInto('bookings')
      .values({
        organization_id: organizationId,
        event_type_id: eventTypeId,
        start_at: '2020-01-01T09:00:00Z',
        end_at: '2020-01-01T09:30:00Z',
        title: 'Routed booking',
        source: 'web',
        status: 'confirmed',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('booking_routing')
      .values({
        booking_id: booking.id,
        organization_id: organizationId,
        form_id: formId,
        version_id: versionId,
        version_number: 1,
        matched_rule_id: 'fallback',
        resolved_rule_id: 'fallback',
        questions: JSON.stringify([]),
        answers: JSON.stringify({}),
      })
      .execute()
  }

  /** A connection holding `statement`'s row locks in an open transaction. */
  async function hold(statement: string, params: unknown[]) {
    const client: pg.PoolClient = await owned.pool.connect()
    await client.query('BEGIN')
    await client.query(statement, params)
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
      ?.pid as number
    let open = true
    return {
      pid,
      async commit() {
        open = false
        await client.query('COMMIT')
      },
      async close() {
        if (open) await client.query('ROLLBACK').catch(() => {})
        client.release()
      },
    }
  }

  /** Waits until a session waits behind `pid` and `count` sessions wait for locks in all. */
  async function blockedBy(pid: number, count = 1) {
    for (let attempt = 0; attempt < 500; attempt++) {
      const { rows } = await owned.pool.query<{ direct: number; waiting: number }>(
        `SELECT count(*) FILTER (WHERE $1 = ANY(pg_blocking_pids(pid)))::int AS direct,
                count(*) FILTER (WHERE cardinality(pg_blocking_pids(pid)) > 0)::int AS waiting
         FROM pg_stat_activity WHERE datname = current_database()`,
        [pid],
      )
      if ((rows[0]?.direct ?? 0) >= 1 && (rows[0]?.waiting ?? 0) >= count) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect.unreachable(`expected ${count} session(s) waiting behind a lock that ${pid} holds`)
  }

  /** Whether another transaction could lock this row for update right now. */
  async function lockable(table: 'routing_forms' | 'event_types', id: string) {
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id])
      return true
    } catch (error) {
      if ((error as { code?: string }).code === '55P03') return false
      throw error
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }

  const noDeadlock = (...results: { error?: unknown }[]) => {
    for (const result of results) expect(described(result.error).code).not.toBe('40P01')
  }

  // --- Protection scenarios (also run against each mutant below) ---------------------------

  /**
   * Deleting a rule target and then the fallback target succeeds, marks exactly those targets
   * unavailable, keeps every routing row and booking snapshot, and reads back as unavailable.
   */
  async function deletionInvalidatesWithoutBlocking(E: EventTypeModule) {
    const space = await personalSpace()
    const [ruleEvent, fallbackEvent, other] = [
      await space.event(),
      await space.event(),
      await space.event(),
    ]
    const form = await publishedForm(space.ctx, [ruleEvent, other], fallbackEvent)
    await snapshot(space.organizationId, ruleEvent, form.formId, form.versionId)
    const [rule, otherRule] = form.ruleIds as [string, string]
    const before = await history(space.organizationId)
    await succeeds(() => E.deleteEventType(space.ctx, ruleEvent))
    expect(await markers(form.versionId)).toEqual({
      [rule]: 'unavailable',
      [otherRule]: 'ok',
      fallback: 'ok',
    })
    await succeeds(() => E.deleteEventType(space.ctx, fallbackEvent))
    expect(await markers(form.versionId), 'the fallback target is invalidated too').toEqual({
      [rule]: 'unavailable',
      [otherRule]: 'ok',
      fallback: 'unavailable',
    })
    expect(await history(space.organizationId), 'no routing history goes with the event').toEqual(
      before,
    )
    expect((await Service.getRoutingForm(space.ctx, form.formId)).health).toEqual({
      versionId: form.versionId,
      status: 'unavailable',
      targets: [
        { ruleId: rule, eventTypeId: ruleEvent, health: 'unavailable', reason: 'deleted' },
        { ruleId: otherRule, eventTypeId: other, health: 'ok', reason: null },
        {
          ruleId: 'fallback',
          eventTypeId: fallbackEvent,
          health: 'unavailable',
          reason: 'deleted',
        },
      ],
    })
  }

  /** Disabling marks the targets unavailable, enabling marks them ok again, history intact. */
  async function disablingInvalidatesAndEnablingRestores(E: EventTypeModule) {
    const space = await personalSpace()
    const event = await space.event()
    const form = await publishedForm(space.ctx, [event], event)
    const [rule] = form.ruleIds as [string]
    const before = await history(space.organizationId)
    await succeeds(() => E.updateEventType(space.ctx, event, { isActive: false }))
    expect(await markers(form.versionId)).toEqual({
      [rule]: 'unavailable',
      fallback: 'unavailable',
    })
    expect((await Service.getRoutingForm(space.ctx, form.formId)).health?.targets).toEqual([
      { ruleId: rule, eventTypeId: event, health: 'unavailable', reason: 'disabled' },
      { ruleId: 'fallback', eventTypeId: event, health: 'unavailable', reason: 'disabled' },
    ])
    await succeeds(() => E.updateEventType(space.ctx, event, { isActive: true }))
    expect(await markers(form.versionId)).toEqual({ [rule]: 'ok', fallback: 'ok' })
    expect((await Service.getRoutingForm(space.ctx, form.formId)).health?.status).toBe('ok')
    expect(await history(space.organizationId)).toEqual(before)
  }

  /**
   * Administrative removal deactivates the departing host's single-host and collective events
   * and marks those targets (the fallback included) unavailable; the round-robin pool that
   * keeps a host stays ok. The form, created and published by an admin, is untouched.
   */
  async function removalInvalidatesWithoutBlocking(remove: Remove) {
    const t = await teamSpace()
    const form = await publishedForm(t.adminCtx, [t.single, t.pool], t.collective)
    const [single, pool] = form.ruleIds as [string, string]
    const before = await history(t.team.id)
    const removed = await succeeds(() => t.remove(remove))
    expect([...removed.deactivatedEventTypeIds].sort()).toEqual([t.single, t.collective].sort())
    expect(await markers(form.versionId), 'the fallback target is invalidated too').toEqual({
      [single]: 'unavailable',
      [pool]: 'ok',
      fallback: 'unavailable',
    })
    expect(await history(t.team.id)).toEqual(before)
    const health = (await Service.getRoutingForm(t.adminCtx, form.formId)).health
    expect(health?.status).toBe('unavailable')
    expect(health?.targets.map(({ ruleId, health, reason }) => [ruleId, health, reason])).toEqual([
      [single, 'unavailable', 'disabled'],
      [pool, 'ok', null],
      ['fallback', 'unavailable', 'disabled'],
    ])
  }

  /**
   * A target this release cannot read is `unknown`: neither unavailable nor missing, in `get`
   * and in `list`; a form with nothing published has no health at all, which is not unknown.
   */
  async function unknownIsNeitherBrokenNorMissing(S: ServiceModule) {
    const space = await personalSpace()
    const event = await space.event()
    const form = await publishedForm(space.ctx, [event], null)
    const rule = randomUUID()
    const unread = randomUUID()
    const { id: version } = await db
      .insertInto('routing_form_versions')
      .values({
        organization_id: space.organizationId,
        form_id: form.formId,
        version_number: 2,
        questions: JSON.stringify([]),
        // As a later release might store a kind this one does not know.
        rules: JSON.stringify([
          { id: rule, conditions: [], target: { kind: 'webhook', url: 'https://example.test' } },
          { id: unread, conditions: [], target: { kind: 'event', eventTypeId: 42 } },
        ]),
        fallback: JSON.stringify({ kind: 'message', message: 'Thank you' }),
        published_by_user_id: space.user.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .updateTable('routing_forms')
      .set({ published_version_id: version })
      .where('id', '=', form.formId)
      .execute()
    const read = await succeeds(() => S.getRoutingForm(space.ctx, form.formId))
    expect(read.health).toEqual({
      versionId: version,
      status: 'unknown',
      targets: [
        { ruleId: rule, eventTypeId: null, health: 'unknown', reason: null },
        { ruleId: unread, eventTypeId: null, health: 'unknown', reason: null },
        { ruleId: 'fallback', eventTypeId: null, health: 'ok', reason: null },
      ],
    })
    const draftOnly = await S.createRoutingForm(space.ctx, {
      slug: slug(),
      title: 'Draft only',
      ...draft([event], null).input,
    })
    expect(draftOnly.health).toBeNull()
    const listed = Object.fromEntries(
      (await succeeds(() => S.listRoutingForms(space.ctx))).data.map((entry) => [
        entry.id,
        entry.health,
      ]),
    )
    expect(listed).toEqual({ [form.formId]: 'unknown', [draftOnly.id]: null })
    // A missed invalidation cannot hide a broken target: a mixed version reads unavailable.
    await sql`UPDATE event_types SET is_active = false WHERE id = ${event}`.execute(db)
    const broken = await db
      .insertInto('routing_form_versions')
      .values({
        organization_id: space.organizationId,
        form_id: form.formId,
        version_number: 3,
        questions: JSON.stringify([]),
        rules: JSON.stringify([
          { id: rule, conditions: [], target: { kind: 'webhook' } },
          { id: unread, conditions: [], target: { kind: 'event', eventTypeId: event } },
        ]),
        fallback: JSON.stringify({ kind: 'message', message: 'Thank you' }),
        published_by_user_id: space.user.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .updateTable('routing_forms')
      .set({ published_version_id: broken.id })
      .where('id', '=', form.formId)
      .execute()
    expect((await S.getRoutingForm(space.ctx, form.formId)).health?.status).toBe('unavailable')
  }

  /**
   * Publication racing event deletion on separate connections, in both orders: whoever takes
   * the event first wins, nobody deadlocks, and the publication never holds the form while it
   * waits for the event (organization → event → form).
   */
  async function publishRacesDeletion(S: ServiceModule) {
    // Deletion first: the publication waits behind it, then refuses the deleted target.
    {
      const space = await personalSpace()
      const event = await space.event()
      const form = await publishedForm(space.ctx, [event], null)
      const [rule] = form.ruleIds as [string]
      const blocker = await hold('SELECT 1 FROM event_types WHERE id = $1 FOR UPDATE', [event])
      let racers: Promise<unknown> | undefined
      try {
        const deletion = settle(EventTypes.deleteEventType(space.ctx, event))
        await blockedBy(blocker.pid, 1)
        const publish = settle(
          S.publishRoutingForm(space.ctx, form.formId, { expectedRevision: 2 }),
        )
        const both = Promise.all([deletion, publish] as const)
        racers = both
        await blockedBy(blocker.pid, 2)
        expect(
          await lockable('routing_forms', form.formId),
          'a publication waiting for the event holds no form lock',
        ).toBe(true)
        await blocker.commit()
        const [deleted, published] = await both
        noDeadlock(deleted, published)
        expect(deleted.error).toBeUndefined()
        expect(described(published.error)).toMatchObject({
          code: 'invalid_routing_target',
          reason: 'deleted',
        })
        expect(await versionNumbers(form.formId)).toEqual([1])
        expect(await markers(form.versionId)).toEqual({ [rule]: 'unavailable' })
      } finally {
        await blocker.close()
        await racers
      }
    }
    // Publication first: deletion waits for its event share lock, then marks the new version.
    {
      const space = await personalSpace()
      const event = await space.event()
      const form = await publishedForm(space.ctx, [event], event)
      const [rule] = form.ruleIds as [string]
      const blocker = await hold('SELECT 1 FROM routing_forms WHERE id = $1 FOR UPDATE', [
        form.formId,
      ])
      let racers: Promise<unknown> | undefined
      try {
        const publish = settle(
          S.publishRoutingForm(space.ctx, form.formId, { expectedRevision: 2 }),
        )
        await blockedBy(blocker.pid, 1)
        expect(await lockable('event_types', event), 'publication holds the event first').toBe(
          false,
        )
        const deletion = settle(EventTypes.deleteEventType(space.ctx, event))
        const both = Promise.all([publish, deletion] as const)
        racers = both
        await blockedBy(blocker.pid, 2)
        await blocker.commit()
        const [published, deleted] = await both
        noDeadlock(published, deleted)
        expect(published.error).toBeUndefined()
        expect(deleted.error).toBeUndefined()
        expect(await versionNumbers(form.formId)).toEqual([1, 2])
        const current = (published.value as { version: { id: string } }).version.id
        expect(await markers(current)).toEqual({ [rule]: 'unavailable', fallback: 'unavailable' })
        // Only the current version is marked; history keeps its publication-time markers.
        expect(await markers(form.versionId)).toEqual({ [rule]: 'ok', fallback: 'ok' })
        expect((await S.getRoutingForm(space.ctx, form.formId)).health?.status).toBe('unavailable')
      } finally {
        await blocker.close()
        await racers
      }
    }
  }

  /** The same race against administrative removal, which takes the organization for update. */
  async function publishRacesRemoval(S: ServiceModule) {
    // Removal first: publication waits on the organization, then refuses the disabled target.
    {
      const t = await teamSpace()
      const form = await publishedForm(t.adminCtx, [t.single, t.pool], t.collective)
      const [single, pool] = form.ruleIds as [string, string]
      const blocker = await hold('SELECT 1 FROM event_types WHERE id = $1 FOR UPDATE', [t.single])
      let racers: Promise<unknown> | undefined
      try {
        const removal = settle(t.remove())
        await blockedBy(blocker.pid, 1)
        const publish = settle(
          S.publishRoutingForm(t.adminCtx, form.formId, { expectedRevision: 2 }),
        )
        const both = Promise.all([removal, publish] as const)
        racers = both
        await blockedBy(blocker.pid, 2)
        expect(await lockable('routing_forms', form.formId)).toBe(true)
        await blocker.commit()
        const [removed, published] = await both
        noDeadlock(removed, published)
        expect(removed.error).toBeUndefined()
        expect(described(published.error)).toMatchObject({
          code: 'invalid_routing_target',
          reason: 'disabled',
        })
        expect(await versionNumbers(form.formId)).toEqual([1])
        expect(await markers(form.versionId)).toEqual({
          [single]: 'unavailable',
          [pool]: 'ok',
          fallback: 'unavailable',
        })
      } finally {
        await blocker.close()
        await racers
      }
    }
    // Publication first: removal waits for the organization, then marks the new version.
    {
      const t = await teamSpace()
      const form = await publishedForm(t.adminCtx, [t.single, t.pool], t.collective)
      const [single, pool] = form.ruleIds as [string, string]
      const blocker = await hold('SELECT 1 FROM routing_forms WHERE id = $1 FOR UPDATE', [
        form.formId,
      ])
      let racers: Promise<unknown> | undefined
      try {
        const publish = settle(
          S.publishRoutingForm(t.adminCtx, form.formId, { expectedRevision: 2 }),
        )
        await blockedBy(blocker.pid, 1)
        const removal = settle(t.remove())
        const both = Promise.all([publish, removal] as const)
        racers = both
        await blockedBy(blocker.pid, 2)
        await blocker.commit()
        const [published, removed] = await both
        noDeadlock(published, removed)
        expect(published.error).toBeUndefined()
        expect(removed.error).toBeUndefined()
        const current = (published.value as { version: { id: string } }).version.id
        expect(await markers(current)).toEqual({
          [single]: 'unavailable',
          [pool]: 'ok',
          fallback: 'unavailable',
        })
      } finally {
        await blocker.close()
        await racers
      }
    }
  }

  // --- The shipped modules ----------------------------------------------------------------

  it('marks rule and fallback targets unavailable on deletion, without blocking it or losing history', () =>
    deletionInvalidatesWithoutBlocking(EventTypes))

  it('marks targets unavailable when their event type is disabled and ok when it is enabled again', () =>
    disablingInvalidatesAndEnablingRestores(EventTypes))

  it('marks the departing host’s deactivated targets unavailable, the fallback included', () =>
    removalInvalidatesWithoutBlocking(removeTeamMember))

  it('reports unknown targets as unknown, never as unavailable or as nothing published', () =>
    unknownIsNeitherBrokenNorMissing(Service))

  it('serializes publication with event deletion in both orders', () =>
    publishRacesDeletion(Service))

  it('serializes publication with member removal in both orders', () =>
    publishRacesRemoval(Service))

  it('follows a booking-mode change: read at once, marked by the next update or refresh', async () => {
    const space = await personalSpace()
    const event = await space.event()
    const form = await publishedForm(space.ctx, [event], null)
    const [rule] = form.ruleIds as [string]
    // No service changes booking mode yet; the storage guard serializes a direct change.
    await sql`UPDATE event_types SET booking_mode = 'group', group_capacity = 3 WHERE id = ${event}`.execute(
      db,
    )
    expect(await markers(form.versionId), 'nothing has marked it yet').toEqual({
      [rule]: 'ok',
    })
    expect((await Service.getRoutingForm(space.ctx, form.formId)).health?.targets[0]).toEqual({
      ruleId: rule,
      eventTypeId: event,
      health: 'unavailable',
      reason: 'group_booking',
    })
    // Any later update of the event type rederives eligibility from its whole row.
    await EventTypes.updateEventType(space.ctx, event, { title: 'Group intro' })
    expect(await markers(form.versionId)).toEqual({ [rule]: 'unavailable' })
    // A service that changes the mode refreshes in its own transaction, like this one.
    await db.transaction().execute(async (trx) => {
      await sql`SELECT 1 FROM event_types WHERE id = ${event} FOR UPDATE`.execute(trx)
      await sql`UPDATE event_types SET booking_mode = 'individual', group_capacity = NULL WHERE id = ${event}`.execute(
        trx,
      )
      await refreshRoutingTargetHealth(trx, space.organizationId, [event], new Date())
    })
    expect(await markers(form.versionId)).toEqual({ [rule]: 'ok' })
    expect((await Service.getRoutingForm(space.ctx, form.formId)).health?.status).toBe('ok')
  })

  it('keeps forms when their author leaves the team, and marks nothing', async () => {
    const t = await teamSpace()
    const form = await publishedForm(t.adminCtx, [t.single], null)
    const before = await history(t.team.id)
    const beforeMarkers = await markers(form.versionId)
    const sessionId = await sessionRow(t.admin.id, t.team.id)
    // The admin hosts the collective and pool events: remove those assignments first, as the
    // departure rules require.
    await db.deleteFrom('event_type_hosts').where('user_id', '=', t.admin.id).execute()
    await succeeds(() =>
      leaveTeamMember(testContext(db, session(t.team.as(t.admin), sessionId)), {
        teamId: t.team.id,
        expectedOrganizationId: t.team.id,
      }),
    )
    expect(await history(t.team.id)).toEqual(before)
    expect(await markers(form.versionId)).toEqual(beforeMarkers)
    // The owner, a current admin, still manages the form the departed admin created.
    const ownerCtx = testContext(db, session(t.team.as(t.owner)))
    expect((await Service.getRoutingForm(ownerCtx, form.formId)).health?.status).toBe('ok')
  })

  it('leaves event deletion, disabling and member removal responses byte-identical with no forms', async () => {
    // The code before this step: the same modules without the routing calls.
    const before = await importCopy<EventTypeModule>(
      EVENT_TYPES,
      [UPDATE_REFRESH, ''],
      [DELETE_REFRESH, ''],
    )
    const removalBefore = (
      await importCopy<{ removeTeamMember: Remove }>(REMOVAL, [REMOVAL_MARK, ''])
    ).removeTeamMember
    const routingRows = async () =>
      (
        await sql<{ count: number }>`SELECT (SELECT count(*) FROM routing_forms)
          + (SELECT count(*) FROM routing_form_versions)
          + (SELECT count(*) FROM routing_target_dependencies)
          + (SELECT count(*) FROM routing_receipts)
          + (SELECT count(*) FROM booking_routing) AS count`.execute(db)
      ).rows[0]?.count
    const rowsBefore = await routingRows()

    /** One run of the scenario; identifiers and instants that differ per run are replaced. */
    async function run(E: EventTypeModule, remove: Remove) {
      const space = await personalSpace()
      const [disabled, deleted] = [
        await space.event({ slug: `same-${randomUUID()}` }),
        await space.event({ slug: `same-${randomUUID()}` }),
      ]
      const t = await teamSpace()
      const replacements = new Map<string, string>([
        [space.user.id, '<user>'],
        [space.organizationId, '<organization>'],
        [disabled, '<disabled>'],
        [deleted, '<deleted>'],
        [t.single, '<single>'],
        [t.collective, '<collective>'],
        [t.host.id, '<host>'],
      ])
      const outcomes = [
        await settle(E.updateEventType(space.ctx, disabled, { isActive: false })),
        await settle(E.deleteEventType(space.ctx, deleted)),
        await settle(E.deleteEventType(space.ctx, deleted)),
        await settle(E.updateEventType(space.ctx, deleted, { isActive: true })),
        await settle(t.remove(remove)),
      ].map(({ value, error }) =>
        error === undefined
          ? { value }
          : { error: { ...described(error), message: (error as Error).message } },
      )
      let text = JSON.stringify(outcomes)
      for (const [id, name] of replacements) text = text.replaceAll(id, name)
      return text
        .replaceAll(/"same-[0-9a-f-]+"/g, '"<slug>"')
        .replaceAll(/"operationId":"[0-9a-f-]+"/g, '"operationId":"<operation>"')
        .replaceAll(/"\d{4}-\d\d-\d\dT[0-9:.]+Z"/g, '"<instant>"')
        .replaceAll(/"deactivatedEventTypeIds":\[[^\]]*\]/g, (list) =>
          list.replace(/\[(.*)\]/, (_, items: string) => `[${items.split(',').sort().join(',')}]`),
        )
    }
    const original = await run(before, removalBefore)
    const current = await run(EventTypes, removeTeamMember)
    expect(original).toContain('"<disabled>"')
    expect(original).toContain('event_type_not_found')
    expect(original).toContain('"<collective>"')
    expect(current).toBe(original)
    expect(await routingRows(), 'no routing row is written').toBe(rowsBefore)
  })

  // --- Source-copy mutation controls ------------------------------------------------------

  /**
   * Each mutant must fail a real assertion of the scenario that guards its protection. The
   * copy is made first, so a replacement that no longer matches fails the test instead of
   * counting as a kill.
   */
  async function killed<T>(copy: Promise<T>, scenario: (module: T) => Promise<unknown>) {
    const module = await copy
    await expect(scenario(module)).rejects.toMatchObject({ name: 'AssertionError' })
  }

  it('fails when deletion is blocked by a form targeting the event type', () =>
    killed(
      importCopy<EventTypeModule>(EVENT_TYPES, [DELETE_REFRESH, DELETE_BLOCKER]),
      deletionInvalidatesWithoutBlocking,
    ))

  it('fails when deletion does not invalidate its targets', () =>
    killed(
      importCopy<EventTypeModule>(EVENT_TYPES, [DELETE_REFRESH, '']),
      deletionInvalidatesWithoutBlocking,
    ))

  it('fails when disabling does not invalidate its targets', () =>
    killed(
      importCopy<EventTypeModule>(EVENT_TYPES, [UPDATE_REFRESH, '']),
      disablingInvalidatesAndEnablingRestores,
    ))

  it('fails when member removal does not invalidate its targets', () =>
    killed(importCopy<{ removeTeamMember: Remove }>(REMOVAL, [REMOVAL_MARK, '']), (copy) =>
      removalInvalidatesWithoutBlocking(copy.removeTeamMember),
    ))

  it('fails when an unknown target is reported as unavailable', () =>
    killed(
      importCopy<ServiceModule>(SERVICE, [
        UNKNOWN_TARGET,
        "    return { eventTypeId: null, health: 'unavailable', reason: 'not_found' }",
      ]),
      unknownIsNeitherBrokenNorMissing,
    ))

  it('fails when an unknown target is left out as if nothing were configured', () =>
    killed(
      importCopy<ServiceModule>(SERVICE, [
        UNREADABLE_RULE,
        `    const health = targetHealth(target)
    if (target.ruleId !== null && health.health !== 'unknown')
      entry.health.targets.push({ ruleId: target.ruleId, ...health })`,
      ]),
      unknownIsNeitherBrokenNorMissing,
    ))

  it('fails when publication takes the form lock before the event locks', () =>
    killed(
      importCopy<ServiceModule>(SERVICE, [
        PUBLISH_EVENT_LOCKS,
        `        const form = await findForm(trx, organizationId, id, true)
        await lockTargetEvents(
          trx,
          organizationId,
          targets.map((target) => target.eventTypeId),
        )`,
      ]),
      publishRacesDeletion,
    ))
})
