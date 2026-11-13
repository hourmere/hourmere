// Routing-form configuration and publication services against real PostgreSQL in a throwaway
// database. Races use separate connections lined up on a held row lock. The protection
// scenarios take the service module as a parameter: they pass on the shipped module, and the
// source-copy mutation controls at the end require each of them to fail a real assertion on
// a copy with that one protection removed.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Principal } from '@hourmere/auth'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ServiceContext } from './context.ts'
import type { Question } from './questions.ts'
import * as Service from './routing-form-service.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type EventTypeFixture,
  type TestUser,
  testContext,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
type ServiceModule = typeof Service

/** Imports an isolated copy with exactly-once replacements; the shipped file is untouched. */
async function sourceCopy(...replacements: (readonly [string, string])[]): Promise<ServiceModule> {
  const location = new URL('./routing-form-service.ts', import.meta.url)
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
  ) as Promise<ServiceModule>
}

// Exact source text the mutation controls and instrumented copies replace.
const PUBLISH_LOCKED_CHECK = `        const form = await findForm(trx, organizationId, id, true)
        // Every write increments the revision, so at this revision the draft is the one read
        // above and its event types are locked; a concurrent publication has moved it on.
        assertRevision(form, expected)`
const PUBLISH_AUTHORIZE = `        // The organization boundary first, so membership is current once it is granted.
        await authorize(trx, ctx, true)`
const PUBLISH_EVENT_LOCKS = `        await lockTargetEvents(
          trx,
          organizationId,
          targets.map((target) => target.eventTypeId),
        )`
const PUBLISH_TARGET_READ = `          await loadRoutingTargetEvents(
            trx,
            dependencies.map((target) => target.eventTypeId),
          ),`
const PREVIEW_MATCH = '      const match = evaluateRoutingForm(config, answers)'
const RECEIPT_INSERT = `${PREVIEW_MATCH}
      await trx.insertInto('routing_receipts').values({
        organization_id: organizationId, form_id: form.id, version_id: form.published_version_id,
        token_hash: globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2),
        answers_ciphertext: Buffer.from(JSON.stringify(answers)),
        matched_rule_id: match.ruleId, resolved_rule_id: match.ruleId,
        resolved_target: JSON.stringify(match.target),
        expires_at: new Date(Date.now() + 1800000),
      }).execute()`

/** Source copies load their own error classes, so failures compare by name and code. */
async function failure(fn: () => Promise<unknown>) {
  let caught: unknown
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  if (!(caught instanceof Error)) return expect.unreachable('expected the operation to fail')
  const error = caught as Error & { kind?: string; code?: string; field?: string; reason?: string }
  return {
    name: error.name,
    kind: error.kind,
    code: error.code,
    field: error.field,
    reason: error.reason,
  }
}

/** Expected success, reported as an assertion so that a throwing mutant is not a crash. */
async function succeeds<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    const { name, code } = error as { name?: string; code?: string }
    return expect.unreachable(`expected success, got ${name} ${code}`)
  }
}

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }) as { value: T; error?: undefined },
    (error: unknown) => ({ error }) as { value?: undefined; error: unknown },
  )

const session = (principal: Principal): Principal => ({
  kind: 'session',
  sessionId: randomUUID(),
  user: principal.user,
  organization: principal.organization,
})

const bookingQuestions: Question[] = [
  { id: 'company', label: 'Company', type: 'short_text', required: false },
  { id: 'size', label: 'Size', type: 'select', required: true, options: ['Small', 'Large'] },
]

/** A two-question draft whose rule routes large companies to `target` (or a message). */
function draft(target: string | null, fallback: string | null = null) {
  const k = {
    company: randomUUID(),
    size: randomUUID(),
    small: randomUUID(),
    large: randomUUID(),
    rule: randomUUID(),
  }
  return {
    k,
    input: {
      questions: [
        { id: k.company, type: 'short_text', label: ' Company ', required: true },
        {
          id: k.size,
          type: 'select',
          label: 'Company size',
          options: [
            { id: k.small, label: '1–10' },
            { id: k.large, label: '200+' },
          ],
        },
      ],
      rules: [
        {
          id: k.rule,
          conditions: [{ questionId: k.size, operator: 'equals', value: k.large }],
          target:
            target === null
              ? { kind: 'message', message: 'Enterprise team' }
              : {
                  kind: 'event',
                  eventTypeId: target,
                  mappings: [
                    {
                      questionId: k.company,
                      destination: { kind: 'question', questionId: 'company' },
                    },
                  ],
                },
        },
      ],
      fallback:
        fallback === null
          ? { kind: 'message', message: 'Thank you' }
          : { kind: 'event', eventTypeId: fallback },
    },
  }
}

const slug = () => `form-${randomUUID().slice(0, 8)}`

describe.skipIf(!serverUrl)('routing form configuration services', () => {
  let owned: TestDatabase
  let db: Db
  let f: ReturnType<typeof createFixtures>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'routing_service' })
    db = createDb(owned.pool)
    f = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  /** A user acting by session in their personal organization, with event types there. */
  async function personalSpace() {
    const user = await createTestUser(db, 'Routing author')
    const organizationId = user.principal.organization.id
    return {
      user,
      organizationId,
      ctx: testContext(db, session(user.principal)),
      event: (o: EventTypeFixture = {}) =>
        f.eventType(organizationId, user.id, { questions: bookingQuestions, ...o }),
    }
  }

  /** A team with an owner, an admin and an ordinary member, each acting by session. */
  async function teamSpace() {
    const owner = await createTestUser(db, 'Owner')
    const admin = await createTestUser(db, 'Admin')
    const member = await createTestUser(db, 'Member')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const as = (user: TestUser) => testContext(db, session(team.as(user)))
    return {
      team,
      owner,
      admin,
      member,
      as,
      event: (o: EventTypeFixture = {}) =>
        f.eventType(team.id, null, {
          questions: bookingQuestions,
          hosts: [{ userId: admin.id }],
          ...o,
        }),
    }
  }

  async function versions(formId: string) {
    return db
      .selectFrom('routing_form_versions')
      .selectAll()
      .where('form_id', '=', formId)
      .orderBy('version_number')
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
      client,
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

  /**
   * Waits until a session waits for a lock that `pid` holds and `count` sessions of this
   * database wait for locks in all: a second waiter for the same row queues behind the first.
   */
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

  async function routingRowCounts() {
    const { rows } = await owned.pool.query<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM routing_forms) AS forms,
              (SELECT count(*)::int FROM routing_form_versions) AS versions,
              (SELECT count(*)::int FROM routing_target_dependencies) AS dependencies,
              (SELECT count(*)::int FROM routing_receipts) AS receipts,
              (SELECT count(*)::int FROM booking_routing) AS booking_routing,
              (SELECT count(*)::int FROM bookings) AS bookings,
              (SELECT count(*)::int FROM audit_events) AS audit_events`,
    )
    return rows[0]
  }

  // --- Protection scenarios (also run against each mutant below) ---------------------------

  /** Two publications of one revision, lined up on the form lock: exactly one wins. */
  async function concurrentPublishHasOneWinner(S: ServiceModule) {
    const space = await personalSpace()
    const event = await space.event()
    const form = await S.createRoutingForm(space.ctx, {
      slug: slug(),
      title: 'Race',
      ...draft(event).input,
    })
    const blocker = await hold('SELECT 1 FROM routing_forms WHERE id = $1 FOR UPDATE', [form.id])
    let racers: Promise<{ value?: unknown; error?: unknown }[]> | undefined
    try {
      racers = Promise.all([
        settle(S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1 })),
        settle(S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1 })),
      ])
      await blockedBy(blocker.pid, 2)
      await blocker.commit()
      const results = await racers
      const winners = results.filter((result) => result.value !== undefined)
      const losers = results.filter((result) => result.error !== undefined)
      expect(winners).toHaveLength(1)
      expect(losers.map((loser) => (loser.error as { code?: string }).code)).toEqual([
        'routing_revision_conflict',
      ])
      const stored = await versions(form.id)
      expect(stored.map((version) => version.version_number)).toEqual([1])
      const current = await S.getRoutingForm(space.ctx, form.id)
      expect(current.publishedVersionId).toBe(stored[0]?.id)
      expect(current.draftRevision).toBe(2)
    } finally {
      await blocker.close()
      await racers
    }
  }

  /** A save at an old revision is refused, sequentially and when two saves race. */
  async function staleSaveIsRejected(S: ServiceModule) {
    const space = await personalSpace()
    const form = await S.createRoutingForm(space.ctx, {
      slug: slug(),
      title: 'First',
      ...draft(null).input,
    })
    const saved = await succeeds(() =>
      S.updateRoutingForm(space.ctx, form.id, { expectedRevision: 1, title: 'Second' }),
    )
    expect(saved.draftRevision).toBe(2)
    expect(
      await failure(() =>
        S.updateRoutingForm(space.ctx, form.id, { expectedRevision: 1, title: 'Lost update' }),
      ),
    ).toMatchObject({ kind: 'conflict', code: 'routing_revision_conflict' })
    const blocker = await hold('SELECT 1 FROM routing_forms WHERE id = $1 FOR UPDATE', [form.id])
    let racers: Promise<{ value?: unknown; error?: unknown }[]> | undefined
    try {
      racers = Promise.all(
        ['Third', 'Fourth'].map((title) =>
          settle(S.updateRoutingForm(space.ctx, form.id, { expectedRevision: 2, title })),
        ),
      )
      await blockedBy(blocker.pid, 2)
      await blocker.commit()
      const results = await racers
      expect(results.filter((result) => result.value !== undefined)).toHaveLength(1)
      expect(results.map((result) => (result.error as { code?: string })?.code)).toContain(
        'routing_revision_conflict',
      )
    } finally {
      await blocker.close()
      await racers
    }
    const current = await S.getRoutingForm(space.ctx, form.id)
    expect(current.draftRevision).toBe(3)
    expect(['Third', 'Fourth']).toContain(current.title)
  }

  /** Archiving at an old revision is refused and leaves the form live. */
  async function staleArchiveIsRejected(S: ServiceModule) {
    const space = await personalSpace()
    const form = await S.createRoutingForm(space.ctx, {
      slug: slug(),
      title: 'Archive me',
      ...draft(null).input,
    })
    await S.updateRoutingForm(space.ctx, form.id, { expectedRevision: 1, title: 'Edited' })
    expect(
      await failure(() => S.archiveRoutingForm(space.ctx, form.id, { expectedRevision: 1 })),
    ).toMatchObject({ code: 'routing_revision_conflict' })
    expect((await succeeds(() => S.getRoutingForm(space.ctx, form.id))).title).toBe('Edited')
    await succeeds(() => S.archiveRoutingForm(space.ctx, form.id, { expectedRevision: 2 }))
    expect(await failure(() => S.getRoutingForm(space.ctx, form.id))).toMatchObject({
      code: 'routing_form_not_found',
    })
  }

  /**
   * Publication waits for the organization lock (held here as membership management holds
   * it) before it locks the target event type or the form.
   */
  async function publishWaitsOnTheOrganizationFirst(S: ServiceModule) {
    const space = await personalSpace()
    const event = await space.event()
    const form = await S.createRoutingForm(space.ctx, {
      slug: slug(),
      title: 'Lock order',
      ...draft(event).input,
    })
    const blocker = await hold('SELECT 1 FROM auth.organization WHERE id = $1 FOR UPDATE', [
      space.organizationId,
    ])
    let publish: Promise<{ value?: unknown; error?: unknown }> | undefined
    try {
      publish = settle(S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1 }))
      await blockedBy(blocker.pid)
      expect(await lockable('event_types', event)).toBe(true)
      expect(await lockable('routing_forms', form.id)).toBe(true)
      await blocker.commit()
      expect((await publish).error).toBeUndefined()
    } finally {
      await blocker.close()
      await publish
    }
    expect((await versions(form.id)).map((version) => version.version_number)).toEqual([1])
  }

  /**
   * An event type turned into a group event after the draft was saved, while the publication
   * waits for it, is refused inside the publication's transaction. The publication waits on
   * the event type before it locks the form.
   */
  async function groupTargetChangedAfterSaveIsRejected(S: ServiceModule) {
    const space = await personalSpace()
    const event = await space.event()
    const form = await S.createRoutingForm(space.ctx, {
      slug: slug(),
      title: 'Group race',
      ...draft(event).input,
    })
    const blocker = await hold('SELECT 1 FROM event_types WHERE id = $1 FOR UPDATE', [event])
    let publish: Promise<{ value?: unknown; error?: unknown }> | undefined
    try {
      publish = settle(S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1 }))
      await blockedBy(blocker.pid)
      expect(await lockable('routing_forms', form.id)).toBe(true)
      await blocker.client.query(
        "UPDATE event_types SET booking_mode = 'group', group_capacity = 3 WHERE id = $1",
        [event],
      )
      await blocker.commit()
      const { error } = await publish
      expect(error).toMatchObject({
        code: 'invalid_routing_target',
        field: 'rules.0.target',
        reason: 'group_booking',
      })
    } finally {
      await blocker.close()
      await publish
    }
    expect(await versions(form.id)).toEqual([])
    expect((await S.getRoutingForm(space.ctx, form.id)).publishedVersionId).toBeNull()
  }

  /** A team admin demoted while their publication waits for the organization is refused. */
  async function membershipIsRecheckedInsidePublish(S: ServiceModule) {
    const space = await teamSpace()
    const event = await space.event()
    const admin = space.as(space.admin)
    const form = await S.createRoutingForm(admin, {
      slug: slug(),
      title: 'Demotion race',
      ...draft(event).input,
    })
    const blocker = await hold('SELECT 1 FROM auth.organization WHERE id = $1 FOR UPDATE', [
      space.team.id,
    ])
    let publish: Promise<{ value?: unknown; error?: unknown }> | undefined
    try {
      publish = settle(S.publishRoutingForm(admin, form.id, { expectedRevision: 1 }))
      await blockedBy(blocker.pid)
      await blocker.client.query(
        `UPDATE auth.member SET role = 'member' WHERE "organizationId" = $1 AND "userId" = $2`,
        [space.team.id, space.admin.id],
      )
      await blocker.commit()
      expect((await publish).error).toMatchObject({
        kind: 'forbidden',
        code: 'team_management_access_denied',
      })
    } finally {
      await blocker.close()
      await publish
    }
    expect(await versions(form.id)).toEqual([])
  }

  /** Dependencies are generated for every event target, the fallback included. */
  async function dependenciesCoverEveryEventTarget(S: ServiceModule) {
    const space = await personalSpace()
    const sales = await space.event()
    const support = await space.event()
    const { input, k } = draft(sales, support)
    const messageRule = {
      id: randomUUID(),
      conditions: [{ questionId: k.size, operator: 'equals', value: k.small }],
      target: { kind: 'message', message: 'Self-serve' },
    }
    const form = await S.createRoutingForm(space.ctx, {
      slug: slug(),
      title: 'Dependencies',
      ...input,
      rules: [...input.rules, messageRule],
    })
    const { version } = await succeeds(() =>
      S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1 }),
    )
    const rows = await db
      .selectFrom('routing_target_dependencies')
      .select(['organization_id', 'rule_id', 'event_type_id', 'health_code'])
      .where('version_id', '=', version.id)
      .orderBy('rule_id')
      .execute()
    expect(rows).toEqual(
      [
        { rule_id: k.rule, event_type_id: sales },
        { rule_id: 'fallback', event_type_id: support },
      ]
        .map((row) => ({ ...row, organization_id: space.organizationId, health_code: 'ok' }))
        .sort((a, b) => a.rule_id.localeCompare(b.rule_id)),
    )
  }

  /** Published versions keep their IDs and content; IDs keep one meaning across history. */
  async function historyAndIdsStayStable(S: ServiceModule) {
    const space = await personalSpace()
    const event = await space.event()
    const { input, k } = draft(event)
    const form = await S.createRoutingForm(space.ctx, { slug: slug(), title: 'History', ...input })
    const first = await succeeds(() =>
      S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1 }),
    )
    const [v1] = await versions(form.id)
    // Renaming and reordering keep identity.
    const renamed = [
      { ...input.questions[1], label: 'Team size' },
      { ...input.questions[0], label: 'Organisation' },
    ]
    await S.updateRoutingForm(space.ctx, form.id, { expectedRevision: 2, questions: renamed })
    const second = await succeeds(() =>
      S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 3 }),
    )
    expect(second.form.id).toBe(form.id)
    expect(second.version.id).not.toBe(first.version.id)
    expect(second.version.versionNumber).toBe(2)
    expect(second.form.publishedVersionId).toBe(second.version.id)
    const stored = await versions(form.id)
    expect(stored.map((version) => version.id)).toEqual([first.version.id, second.version.id])
    expect(stored[0]).toEqual(v1)
    expect((v1?.questions as { label: string }[] | undefined)?.map((q) => q.label)).toEqual([
      'Company',
      'Company size',
    ])
    // A changed type needs a new ID.
    const retyped = [{ ...input.questions[0], type: 'email' }, input.questions[1]]
    await S.updateRoutingForm(space.ctx, form.id, { expectedRevision: 4, questions: retyped })
    expect(
      await failure(() => S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 5 })),
    ).toMatchObject({ code: 'invalid_routing_form', field: 'questions.0.id' })
    // An option cannot move to another question.
    const large = input.questions[1]?.options?.[1]
    const moved = [
      {
        id: randomUUID(),
        type: 'select',
        label: 'Region',
        options: [{ id: k.small, label: 'EU' }],
      },
      input.questions[0],
      { ...input.questions[1], options: [large] },
    ]
    await S.updateRoutingForm(space.ctx, form.id, {
      expectedRevision: 5,
      questions: moved,
      rules: [],
    })
    expect(
      await failure(() => S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 6 })),
    ).toMatchObject({ code: 'invalid_routing_form', field: 'questions.0.options.0.id' })
    // Dropping an option publishes; bringing its ID back later does not.
    await S.updateRoutingForm(space.ctx, form.id, {
      expectedRevision: 6,
      questions: [input.questions[0], { ...input.questions[1], options: [large] }],
    })
    await succeeds(() => S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 7 }))
    await S.updateRoutingForm(space.ctx, form.id, {
      expectedRevision: 8,
      questions: input.questions,
    })
    expect(
      await failure(() => S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 9 })),
    ).toMatchObject({ code: 'invalid_routing_form', field: 'questions.1.options.0.id' })
    expect((await versions(form.id)).map((version) => version.version_number)).toEqual([1, 2, 3])
  }

  /** Preview writes nothing, in a read-only transaction. */
  async function previewWritesNothing(S: ServiceModule) {
    const space = await personalSpace()
    const event = await space.event()
    const { input, k } = draft(event)
    const form = await S.createRoutingForm(space.ctx, { slug: slug(), title: 'Preview', ...input })
    await S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1 })
    const before = await routingRowCounts()
    const row = () =>
      db
        .selectFrom('routing_forms')
        .select(['draft_revision', 'updated_at', 'draft'])
        .where('id', '=', form.id)
        .executeTakeFirstOrThrow()
    const formBefore = await row()
    // Every statement the preview sends, recorded on its own pool.
    const statements: string[] = []
    const pool = createPool(owned.url)
    pool.on('connect', (client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown
      client.query = ((...args: unknown[]) => {
        const [text] = args
        statements.push(typeof text === 'string' ? text : String((text as { text?: string }).text))
        return query(...args)
      }) as typeof client.query
    })
    try {
      const ctx = testContext(createDb(pool), session(space.user.principal))
      const preview = await succeeds(() =>
        S.previewRoutingForm(ctx, form.id, { answers: { [k.company]: 'Acme', [k.size]: k.large } }),
      )
      expect(preview).toMatchObject({ matchedRuleId: k.rule, resolvedRuleId: k.rule })
    } finally {
      await pool.end()
    }
    expect(statements[0]).toBe('start transaction read only')
    expect(statements.at(-1)).toBe('commit')
    expect(
      statements.filter((text) =>
        /^\s*(insert|update|delete|merge)\b|\bfor\s+(update|no key update|share|key share)\b/i.test(
          text,
        ),
      ),
    ).toEqual([])
    expect(await routingRowCounts()).toEqual(before)
    expect(await row()).toEqual(formBefore)
  }

  // --- Behaviour on the shipped module ------------------------------------------------------

  describe('drafts', () => {
    it('creates, reads, lists, updates and archives drafts with optimistic revisions', async () => {
      const space = await personalSpace()
      const { input, k } = draft(null)
      const created = await Service.createRoutingForm(space.ctx, {
        slug: 'qualify',
        title: '  Qualification 東京 ',
        description: 'Tell us about you.\nWe route you to the right team.',
        ...input,
      })
      expect(created).toMatchObject({
        slug: 'qualify',
        title: 'Qualification 東京',
        description: 'Tell us about you.\nWe route you to the right team.',
        draftRevision: 1,
        enabled: false,
        publishedVersionId: null,
        publishedVersionNumber: null,
      })
      // The shared validator normalizes the draft (trimmed labels, defaulted flags).
      expect(created.questions[0]).toEqual({
        id: k.company,
        type: 'short_text',
        label: 'Company',
        required: true,
      })
      expect(created.createdAt).toMatch(/Z$/)
      expect(await Service.getRoutingForm(space.ctx, created.id)).toEqual(created)

      const updated = await Service.updateRoutingForm(space.ctx, created.id, {
        expectedRevision: 1,
        slug: 'qualify-leads',
        // Undefined is not given; null removes the description.
        title: undefined,
        description: null,
      })
      expect(updated).toMatchObject({
        id: created.id,
        slug: 'qualify-leads',
        title: 'Qualification 東京',
        description: null,
        draftRevision: 2,
        questions: created.questions,
        rules: created.rules,
      })
      // Only the given draft fields change; the stored draft is validated as a whole.
      expect(
        await failure(() =>
          Service.updateRoutingForm(space.ctx, created.id, {
            expectedRevision: 2,
            questions: [],
          }),
        ),
      ).toMatchObject({ code: 'invalid_routing_form', field: 'rules.0.conditions.0.questionId' })
      expect((await Service.getRoutingForm(space.ctx, created.id)).draftRevision).toBe(2)

      await Service.archiveRoutingForm(space.ctx, created.id, { expectedRevision: 2 })
      for (const operation of [
        () => Service.getRoutingForm(space.ctx, created.id),
        () => Service.updateRoutingForm(space.ctx, created.id, { expectedRevision: 3, title: 'x' }),
        () => Service.archiveRoutingForm(space.ctx, created.id, { expectedRevision: 3 }),
        () => Service.publishRoutingForm(space.ctx, created.id, { expectedRevision: 3 }),
        () => Service.previewRoutingForm(space.ctx, created.id, { answers: {} }),
      ])
        expect(await failure(operation)).toMatchObject({ code: 'routing_form_not_found' })
      const archived = await db
        .selectFrom('routing_forms')
        .select(['archived_at', 'enabled', 'draft_revision'])
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow()
      expect(archived).toMatchObject({ enabled: false, draft_revision: 3 })
      expect(archived.archived_at).not.toBeNull()
      // An archived form keeps its slug.
      expect(
        await failure(() =>
          Service.createRoutingForm(space.ctx, { slug: 'qualify-leads', title: 'Again', ...input }),
        ),
      ).toMatchObject({ kind: 'conflict', code: 'slug_taken' })
    })

    it('lists live forms newest first with organization-scoped cursors', async () => {
      const space = await personalSpace()
      const other = await personalSpace()
      const ids: string[] = []
      for (const title of ['One', 'Two', 'Three']) {
        const form = await Service.createRoutingForm(space.ctx, {
          slug: slug(),
          title,
          ...draft(null).input,
        })
        ids.push(form.id)
      }
      await Service.createRoutingForm(other.ctx, {
        slug: slug(),
        title: 'Other',
        ...draft(null).input,
      })
      const archived = await Service.createRoutingForm(space.ctx, {
        slug: slug(),
        title: 'Gone',
        ...draft(null).input,
      })
      await Service.archiveRoutingForm(space.ctx, archived.id, { expectedRevision: 1 })
      const first = await Service.listRoutingForms(space.ctx, { limit: 2 })
      expect(first.data.map((form) => form.title)).toEqual(['Three', 'Two'])
      expect(first.data[0]).not.toHaveProperty('questions')
      expect(first.nextCursor).toEqual(expect.any(String))
      const second = await Service.listRoutingForms(space.ctx, {
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      })
      expect(second).toEqual({ data: [expect.objectContaining({ id: ids[0] })], nextCursor: null })
      expect(
        await failure(() =>
          Service.listRoutingForms(other.ctx, { cursor: first.nextCursor ?? undefined }),
        ),
      ).toMatchObject({ code: 'invalid_cursor' })
      for (const limit of [0, 101, 1.5])
        expect(await failure(() => Service.listRoutingForms(space.ctx, { limit }))).toMatchObject({
          code: 'invalid_limit',
        })
    })

    it('refuses unknown fields, bad slugs, titles and revisions with the field named', async () => {
      const space = await personalSpace()
      const { input } = draft(null)
      const cases: [Record<string, unknown>, string | undefined][] = [
        // The unknown key itself is not echoed.
        [{ slug: slug(), title: 'T', ...input, owner: 'x' }, undefined],
        [{ slug: 'Not A Slug', title: 'T', ...input }, 'slug'],
        [{ slug: slug(), title: '   ', ...input }, 'title'],
        [{ slug: slug(), title: 'x'.repeat(201), ...input }, 'title'],
        [{ slug: slug(), title: 'T', ...input, description: 'x'.repeat(2001) }, 'description'],
        [
          { slug: slug(), title: 'T', ...input, fallback: { kind: 'url', url: 'x' } },
          'fallback.kind',
        ],
      ]
      for (const [given, field] of cases)
        expect(
          await failure(() =>
            Service.createRoutingForm(
              space.ctx,
              given as unknown as Service.CreateRoutingFormInput,
            ),
          ),
        ).toMatchObject({ kind: 'invalid', field })
      const form = await Service.createRoutingForm(space.ctx, {
        slug: slug(),
        title: 'T',
        ...input,
      })
      for (const expectedRevision of [undefined, 0, '1', 1.5])
        expect(
          await failure(() =>
            Service.updateRoutingForm(space.ctx, form.id, { expectedRevision, title: 'U' }),
          ),
        ).toMatchObject({ code: 'invalid_routing_form', field: 'expectedRevision' })
      expect(
        await failure(() =>
          Service.updateRoutingForm(space.ctx, form.id, { expectedRevision: 1, enabled: 'yes' }),
        ),
      ).toMatchObject({ field: 'enabled' })
      expect(await failure(() => Service.getRoutingForm(space.ctx, 'not-a-uuid'))).toMatchObject({
        code: 'routing_form_not_found',
      })
    })

    it('enables only a published form; publication leaves enabled as it is', async () => {
      const space = await personalSpace()
      const form = await Service.createRoutingForm(space.ctx, {
        slug: slug(),
        title: 'Enable',
        ...draft(null).input,
      })
      expect(
        await failure(() =>
          Service.updateRoutingForm(space.ctx, form.id, { expectedRevision: 1, enabled: true }),
        ),
      ).toMatchObject({ kind: 'conflict', code: 'routing_form_not_published' })
      const { form: published } = await Service.publishRoutingForm(space.ctx, form.id, {
        expectedRevision: 1,
      })
      expect(published).toMatchObject({ enabled: false, draftRevision: 2 })
      const enabled = await Service.updateRoutingForm(space.ctx, form.id, {
        expectedRevision: 2,
        enabled: true,
      })
      expect(enabled).toMatchObject({ enabled: true, draftRevision: 3 })
      const republished = await Service.publishRoutingForm(space.ctx, form.id, {
        expectedRevision: 3,
      })
      expect(republished.form).toMatchObject({ enabled: true, publishedVersionNumber: 2 })
      await Service.archiveRoutingForm(space.ctx, form.id, { expectedRevision: 4 })
      expect(
        await db
          .selectFrom('routing_forms')
          .select('enabled')
          .where('id', '=', form.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ enabled: false })
    })

    it('maps the form quotas to routing_form_limit_reached', async () => {
      const space = await personalSpace()
      await owned.pool.query(
        `INSERT INTO routing_forms (organization_id, slug, created_by_user_id, draft)
         SELECT $1, 'filler-' || n, $2, '{}'::jsonb FROM generate_series(1, 100) n`,
        [space.organizationId, space.user.id],
      )
      expect(
        await failure(() =>
          Service.createRoutingForm(space.ctx, {
            slug: slug(),
            title: 'One too many',
            ...draft(null).input,
          }),
        ),
      ).toMatchObject({ kind: 'conflict', code: 'routing_form_limit_reached' })
    })

    it('maps the version quota to routing_form_version_limit_reached', async () => {
      const space = await personalSpace()
      const form = await Service.createRoutingForm(space.ctx, {
        slug: slug(),
        title: 'Many versions',
        ...draft(null).input,
      })
      await owned.pool.query(
        `INSERT INTO routing_form_versions
           (organization_id, form_id, version_number, questions, rules, fallback, published_by_user_id)
         SELECT $1, $2, n, '[]', '[]', '{"kind":"message","message":"Old"}', $3
         FROM generate_series(1, 1000) n`,
        [space.organizationId, form.id, space.user.id],
      )
      expect(
        await failure(() =>
          Service.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1 }),
        ),
      ).toMatchObject({ kind: 'conflict', code: 'routing_form_version_limit_reached' })
      expect(await versions(form.id)).toHaveLength(1000)
    })

    it('rejects stale saves, including a save racing another', () => staleSaveIsRejected(Service))
    it('rejects stale archives', () => staleArchiveIsRejected(Service))
  })

  describe('authority', () => {
    it('lets current team owners and admins manage any team form, and refuses members', async () => {
      const space = await teamSpace()
      const owner = space.as(space.owner)
      const admin = space.as(space.admin)
      const member = space.as(space.member)
      const event = await space.event()
      const form = await Service.createRoutingForm(owner, {
        slug: slug(),
        title: 'Team form',
        ...draft(event).input,
      })
      // The creator is attribution, not authority: an admin edits and publishes it.
      await Service.updateRoutingForm(admin, form.id, { expectedRevision: 1, title: 'By admin' })
      await Service.publishRoutingForm(admin, form.id, { expectedRevision: 2 })
      const operations = [
        () => Service.createRoutingForm(member, { slug: slug(), title: 'T', ...draft(null).input }),
        () => Service.getRoutingForm(member, form.id),
        () => Service.getRoutingForm(member, randomUUID()),
        () => Service.listRoutingForms(member),
        () => Service.updateRoutingForm(member, form.id, { expectedRevision: 3, title: 'x' }),
        () => Service.archiveRoutingForm(member, form.id, { expectedRevision: 3 }),
        () => Service.publishRoutingForm(member, form.id, { expectedRevision: 3 }),
        () => Service.previewRoutingForm(member, form.id, { answers: {} }),
      ]
      for (const operation of operations)
        expect(await failure(operation)).toMatchObject({
          kind: 'forbidden',
          code: 'team_management_access_denied',
        })
      expect((await Service.getRoutingForm(owner, form.id)).title).toBe('By admin')
      // A former admin loses authority at once.
      await db
        .updateTable('auth.member')
        .set({ role: 'member' })
        .where('organizationId', '=', space.team.id)
        .where('userId', '=', space.admin.id)
        .execute()
      expect(await failure(() => Service.getRoutingForm(admin, form.id))).toMatchObject({
        code: 'team_management_access_denied',
      })
    })

    it('keeps forms inside their organization', async () => {
      const space = await personalSpace()
      const team = await teamSpace()
      const form = await Service.createRoutingForm(space.ctx, {
        slug: slug(),
        title: 'Mine',
        ...draft(null).input,
      })
      const elsewhere = team.as(team.owner)
      for (const operation of [
        () => Service.getRoutingForm(elsewhere, form.id),
        () => Service.updateRoutingForm(elsewhere, form.id, { expectedRevision: 1, title: 'x' }),
        () => Service.publishRoutingForm(elsewhere, form.id, { expectedRevision: 1 }),
        () => Service.previewRoutingForm(elsewhere, form.id, { answers: {} }),
      ])
        expect(await failure(operation)).toMatchObject({ code: 'routing_form_not_found' })
      expect((await Service.listRoutingForms(elsewhere)).data).toEqual([])
      // A target in another organization is refused like a missing one.
      const foreign = await team.event()
      const stray = await Service.createRoutingForm(space.ctx, {
        slug: slug(),
        title: 'Stray',
        ...draft(foreign).input,
      })
      expect(
        await failure(() =>
          Service.publishRoutingForm(space.ctx, stray.id, { expectedRevision: 1 }),
        ),
      ).toMatchObject({ code: 'invalid_routing_target', reason: 'not_found' })
    })

    it('allows reads with a read key and needs a full key for writes and preview', async () => {
      const space = await personalSpace()
      const form = await Service.createRoutingForm(space.ctx, {
        slug: slug(),
        title: 'Scoped',
        ...draft(null).input,
      })
      const key = (apiKeyScope: 'read' | 'bookings'): ServiceContext =>
        testContext(db, {
          ...space.user.principal,
          kind: 'api_key',
          apiKeyScope,
          apiKeyId: randomUUID(),
        } as Principal)
      const read = key('read')
      expect((await Service.getRoutingForm(read, form.id)).id).toBe(form.id)
      expect((await Service.listRoutingForms(read)).data).toHaveLength(1)
      const writes = (ctx: ServiceContext) => [
        () => Service.createRoutingForm(ctx, { slug: slug(), title: 'T', ...draft(null).input }),
        () => Service.updateRoutingForm(ctx, form.id, { expectedRevision: 1, title: 'x' }),
        () => Service.archiveRoutingForm(ctx, form.id, { expectedRevision: 1 }),
        () => Service.publishRoutingForm(ctx, form.id, { expectedRevision: 1 }),
        () => Service.previewRoutingForm(ctx, form.id, { answers: {} }),
      ]
      for (const operation of writes(read))
        expect(await failure(operation)).toMatchObject({ name: 'ApiKeyScopeError' })
      const bookings = key('bookings')
      for (const operation of [
        () => Service.getRoutingForm(bookings, form.id),
        () => Service.listRoutingForms(bookings),
        ...writes(bookings),
      ])
        expect(await failure(operation)).toMatchObject({ name: 'ApiKeyScopeError' })
      expect((await Service.getRoutingForm(space.ctx, form.id)).draftRevision).toBe(1)
    })

    it('rechecks a full key, the actor and the personal owner inside writes', async () => {
      const space = await personalSpace()
      const now = new Date()
      const { id: apiKeyId } = await db
        .insertInto('auth.apikey')
        .values({
          configId: 'default',
          referenceId: space.user.id,
          key: randomUUID(),
          createdAt: now,
          updatedAt: now,
          metadata: JSON.stringify({ scope: 'full', organizationId: space.organizationId }),
          enabled: true,
          rateLimitEnabled: false,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const keyed = testContext(db, {
        kind: 'api_key',
        apiKeyId,
        apiKeyScope: 'full',
        user: space.user.principal.user,
        organization: space.user.principal.organization,
      })
      const event = await space.event()
      const form = await Service.createRoutingForm(keyed, {
        slug: slug(),
        title: 'By key',
        ...draft(event).input,
      })
      const { version } = await Service.publishRoutingForm(keyed, form.id, { expectedRevision: 1 })
      expect(version.versionNumber).toBe(1)
      await db
        .updateTable('auth.apikey')
        .set({ enabled: false })
        .where('id', '=', apiKeyId)
        .execute()
      // A key disabled after the request was resolved cannot write.
      for (const operation of [
        () => Service.updateRoutingForm(keyed, form.id, { expectedRevision: 2, title: 'x' }),
        () => Service.publishRoutingForm(keyed, form.id, { expectedRevision: 2 }),
        () => Service.archiveRoutingForm(keyed, form.id, { expectedRevision: 2 }),
        () => Service.createRoutingForm(keyed, { slug: slug(), title: 'T', ...draft(null).input }),
      ])
        expect(await failure(operation)).toMatchObject({ name: 'InvalidApiKeyError' })
      expect((await Service.getRoutingForm(space.ctx, form.id)).draftRevision).toBe(2)
      // Another user cannot act in this personal organization.
      const stranger = await createTestUser(db, 'Stranger')
      const intruder = testContext(
        db,
        session({ ...stranger.principal, organization: space.user.principal.organization }),
      )
      expect(await failure(() => Service.getRoutingForm(intruder, form.id))).toMatchObject({
        code: 'team_management_access_denied',
      })
      // An unverified actor manages nothing.
      await db
        .updateTable('auth.user')
        .set({ emailVerified: false })
        .where('id', '=', space.user.id)
        .execute()
      for (const operation of [
        () => Service.getRoutingForm(space.ctx, form.id),
        () => Service.updateRoutingForm(space.ctx, form.id, { expectedRevision: 2, title: 'x' }),
      ])
        expect(await failure(operation)).toMatchObject({ code: 'team_management_access_denied' })
    })
  })

  describe('publication', () => {
    it('publishes the draft as an immutable version and generates its dependencies', async () => {
      const space = await personalSpace()
      const event = await space.event()
      const { input, k } = draft(event)
      const form = await Service.createRoutingForm(space.ctx, {
        slug: slug(),
        title: 'Go',
        ...input,
      })
      const { form: published, version } = await Service.publishRoutingForm(space.ctx, form.id, {
        expectedRevision: 1,
      })
      expect(version).toMatchObject({
        formId: form.id,
        versionNumber: 1,
        questions: form.questions,
        rules: form.rules,
        fallback: form.fallback,
      })
      expect(version.publishedAt).toMatch(/Z$/)
      expect(published).toMatchObject({
        id: form.id,
        draftRevision: 2,
        publishedVersionId: version.id,
        publishedVersionNumber: 1,
        // The draft stays as it was.
        questions: form.questions,
      })
      const [row] = await versions(form.id)
      expect(row).toMatchObject({
        id: version.id,
        organization_id: space.organizationId,
        published_by_user_id: space.user.id,
        questions: form.questions,
        rules: form.rules,
        fallback: form.fallback,
      })
      expect(
        await db
          .selectFrom('routing_target_dependencies')
          .select(['rule_id', 'event_type_id', 'health_code'])
          .where('version_id', '=', version.id)
          .execute(),
      ).toEqual([{ rule_id: k.rule, event_type_id: event, health_code: 'ok' }])
      // A stale publication writes nothing.
      expect(
        await failure(() =>
          Service.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1 }),
        ),
      ).toMatchObject({ code: 'routing_revision_conflict' })
      expect(await versions(form.id)).toHaveLength(1)
    })

    it('has exactly one winner when publications of one revision race', () =>
      concurrentPublishHasOneWinner(Service))
    it('waits for the organization lock before locking events or the form', () =>
      publishWaitsOnTheOrganizationFirst(Service))
    it('rechecks a group-mode change made after the draft save inside its transaction', () =>
      groupTargetChangedAfterSaveIsRejected(Service))
    it('rechecks current membership inside its transaction', () =>
      membershipIsRecheckedInsidePublish(Service))
    it('generates dependencies for every event target, the fallback included', () =>
      dependenciesCoverEveryEventTarget(Service))
    it('keeps published versions, their IDs and question identities stable', () =>
      historyAndIdsStayStable(Service))

    it('rechecks targets and mappings changed after the draft save', async () => {
      const space = await personalSpace()
      const set = (id: string, change: Record<string, unknown>) =>
        db.updateTable('event_types').set(change).where('id', '=', id).execute()
      const cases: {
        change: (event: string) => Promise<unknown>
        field: string
        reason: string
        fallback?: boolean
      }[] = [
        {
          change: (e) => set(e, { is_active: false }),
          field: 'rules.0.target',
          reason: 'disabled',
        },
        {
          change: (e) => set(e, { deleted_at: new Date() }),
          field: 'rules.0.target',
          reason: 'deleted',
        },
        {
          change: (e) => set(e, { questions: JSON.stringify(bookingQuestions.slice(1)) }),
          field: 'rules.0.target.mappings.0',
          reason: 'unknown_destination',
        },
        {
          change: (e) => set(e, { booking_mode: 'group', group_capacity: 4 }),
          field: 'fallback',
          reason: 'group_booking',
          fallback: true,
        },
      ]
      for (const { change, field, reason, fallback } of cases) {
        const sales = await space.event()
        const support = await space.event()
        const form = await Service.createRoutingForm(space.ctx, {
          slug: slug(),
          title: 'Changed later',
          ...draft(sales, support).input,
        })
        await change(fallback ? support : sales)
        expect(
          await failure(() =>
            Service.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1 }),
          ),
        ).toMatchObject({ code: 'invalid_routing_target', field, reason })
        expect(await versions(form.id)).toEqual([])
      }
    })

    it('rejects a payment-requiring projection read in its transaction', async () => {
      const space = await personalSpace()
      const event = await space.event()
      const form = await Service.createRoutingForm(space.ctx, {
        slug: slug(),
        title: 'Paid later',
        ...draft(event).input,
      })
      // Event types have no price setting yet (docs/payments.md). A copy whose publication
      // reads a synthetic payment requirement, as a later price setting would project it.
      const paid = await sourceCopy(
        [PUBLISH_TARGET_READ, PUBLISH_TARGET_READ.replace('loadRoutingTargetEvents(', 'paid(')],
        [
          '/** Each event target with its rule identity',
          `async function paid(db, ids) {
  globalThis.routingPaidProjection.push(db.isTransaction)
  const events = await loadRoutingTargetEvents(db, ids)
  for (const event of events.values()) event.payment = 'required'
  return events
}
/** Each event target with its rule identity`,
        ],
      )
      const seen: boolean[] = []
      Object.assign(globalThis, { routingPaidProjection: seen })
      try {
        expect(
          await failure(() => paid.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1 })),
        ).toMatchObject({
          code: 'invalid_routing_target',
          field: 'rules.0.target',
          reason: 'payment_required',
        })
      } finally {
        Reflect.deleteProperty(globalThis, 'routingPaidProjection')
      }
      expect(seen).toEqual([true])
      expect(await versions(form.id)).toEqual([])
      // The shipped publication reads no payment requirement and publishes.
      await Service.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1 })
    })

    it('publishes a team form to single-host, round-robin and collective team events', async () => {
      const space = await teamSpace()
      const owner = space.as(space.owner)
      for (const schedulingType of ['individual', 'round_robin', 'collective']) {
        const event = await space.event()
        await db
          .updateTable('event_types')
          .set({ scheduling_type: schedulingType })
          .where('id', '=', event)
          .execute()
        const form = await Service.createRoutingForm(owner, {
          slug: slug(),
          title: schedulingType,
          ...draft(event).input,
        })
        const { version } = await Service.publishRoutingForm(owner, form.id, {
          expectedRevision: 1,
        })
        expect(version.versionNumber).toBe(1)
      }
    })
  })

  describe('preview', () => {
    it('explains the first match and resolves broken targets to the fallback', async () => {
      const space = await personalSpace()
      const sales = await space.event()
      const support = await space.event()
      const { input, k } = draft(sales, support)
      const second = {
        id: randomUUID(),
        conditions: [
          { questionId: k.company, operator: 'equals', value: 'Acme' },
          { questionId: k.size, operator: 'one_of', values: [k.small, k.large] },
        ],
        target: { kind: 'message', message: 'Hello Acme' },
      }
      const form = await Service.createRoutingForm(space.ctx, {
        slug: slug(),
        title: 'Preview',
        ...input,
        rules: [...input.rules, second],
      })
      const preview = (answers: Record<string, string>) =>
        Service.previewRoutingForm(space.ctx, form.id, { answers })
      expect(await preview({ [k.company]: 'Acme', [k.size]: k.small })).toEqual({
        draftRevision: 1,
        matchedRuleId: second.id,
        resolvedRuleId: second.id,
        target: { kind: 'message', message: 'Hello Acme' },
        unavailableTargets: [],
        rules: [
          { ruleId: k.rule, matched: false, conditions: [{ questionId: k.size, matched: false }] },
          {
            ruleId: second.id,
            matched: true,
            conditions: [
              { questionId: k.company, matched: true },
              { questionId: k.size, matched: true },
            ],
          },
        ],
      })
      expect(await preview({ [k.company]: 'Other', [k.size]: k.large })).toMatchObject({
        matchedRuleId: k.rule,
        resolvedRuleId: k.rule,
        target: { kind: 'event', eventTypeId: sales },
        rules: [{ ruleId: k.rule, matched: true }],
      })
      // A broken matched target goes straight to the fallback, not to a later rule.
      await db
        .updateTable('event_types')
        .set({ is_active: false })
        .where('id', '=', sales)
        .execute()
      expect(await preview({ [k.company]: 'Acme', [k.size]: k.large })).toMatchObject({
        matchedRuleId: k.rule,
        resolvedRuleId: 'fallback',
        target: { kind: 'event', eventTypeId: support },
        unavailableTargets: [{ ruleId: k.rule, reason: 'disabled' }],
      })
      await db
        .updateTable('event_types')
        .set({ deleted_at: new Date() })
        .where('id', '=', support)
        .execute()
      expect(await preview({ [k.company]: 'Other', [k.size]: k.small })).toMatchObject({
        matchedRuleId: 'fallback',
        resolvedRuleId: null,
        target: null,
        unavailableTargets: [{ ruleId: 'fallback', reason: 'deleted' }],
      })
      expect(
        await failure(() => preview({ [k.company]: 'Acme', [randomUUID()]: 'x' })),
      ).toMatchObject({ code: 'invalid_routing_answers' })
      expect(await failure(() => preview({ [k.size]: k.small }))).toMatchObject({
        code: 'invalid_routing_answers',
        field: `answers.${k.company}`,
      })
    })

    it('writes no receipt, answers or other row', () => previewWritesNothing(Service))
  })

  // --- Source-copy mutation controls --------------------------------------------------------

  it.each([
    {
      name: 'publish revision check under the form lock',
      replacements: [
        [PUBLISH_LOCKED_CHECK, PUBLISH_LOCKED_CHECK.replace('assertRevision(form, expected)', '')],
      ],
      scenario: concurrentPublishHasOneWinner,
    },
    {
      name: 'stale-revision check of a draft save',
      replacements: [
        [
          `        const form = await findForm(trx, organizationId, id, true)
        assertRevision(form, expected)
        const draft = DRAFT_FIELDS.some(`,
          `        const form = await findForm(trx, organizationId, id, true)
        const draft = DRAFT_FIELDS.some(`,
        ],
      ],
      scenario: staleSaveIsRejected,
    },
    {
      name: 'stale-revision check of an archive',
      replacements: [
        [
          `      const form = await findForm(trx, organizationId, id, true)
      assertRevision(form, expected)
      await trx
        .updateTable('routing_forms')
        .set({
          archived_at`,
          `      const form = await findForm(trx, organizationId, id, true)
      await trx
        .updateTable('routing_forms')
        .set({
          archived_at`,
        ],
      ],
      scenario: staleArchiveIsRejected,
    },
    {
      name: 'in-transaction target revalidation',
      replacements: [['        validateRoutingTargets(\n', '        ;(() => {})(\n']],
      scenario: groupTargetChangedAfterSaveIsRejected,
    },
    {
      name: 'target read after the event type locks (read before them)',
      replacements: [
        [
          PUBLISH_EVENT_LOCKS,
          `        const early = await loadRoutingTargetEvents(
          ctx.db,
          targets.map((target) => target.eventTypeId),
        )
${PUBLISH_EVENT_LOCKS}`,
        ],
        [PUBLISH_TARGET_READ, '          early,'],
      ],
      scenario: groupTargetChangedAfterSaveIsRejected,
    },
    {
      name: 'organization lock before the form lock',
      replacements: [
        [PUBLISH_AUTHORIZE, ''],
        [PUBLISH_LOCKED_CHECK, `${PUBLISH_LOCKED_CHECK}\n        await authorize(trx, ctx, true)`],
      ],
      scenario: publishWaitsOnTheOrganizationFirst,
    },
    {
      name: 'event type locks before the form lock',
      replacements: [
        [PUBLISH_EVENT_LOCKS, ''],
        [PUBLISH_LOCKED_CHECK, `${PUBLISH_LOCKED_CHECK}\n${PUBLISH_EVENT_LOCKS}`],
      ],
      scenario: groupTargetChangedAfterSaveIsRejected,
    },
    {
      // Membership read on another connection, unlocked, before the transaction. The mutant
      // then waits only at the version insert's foreign-key lock on the organization row,
      // after which it publishes for a demoted admin.
      name: 'membership check inside the publish transaction',
      replacements: [[PUBLISH_AUTHORIZE, '        await authorize(ctx.db, ctx, false)']],
      scenario: membershipIsRecheckedInsidePublish,
    },
    {
      name: 'fallback dependency',
      replacements: [
        [
          '              dependencies.map((dependency) => ({',
          '              dependencies.filter((d) => d.ruleId !== FALLBACK_RULE_ID).map((dependency) => ({',
        ],
      ],
      scenario: dependenciesCoverEveryEventTarget,
    },
    {
      name: 'ID stability across published versions',
      replacements: [['        await assertStableIdentities(trx, form, config)\n', '']],
      scenario: historyAndIdsStayStable,
    },
    {
      name: 'read-only preview (preview writes a receipt in a writable transaction)',
      replacements: [
        [".setAccessMode('read only')", ".setAccessMode('read write')"],
        [PREVIEW_MATCH, RECEIPT_INSERT],
      ],
      scenario: previewWritesNothing,
    },
    {
      name: 'side-effect-free preview (preview writes a receipt)',
      replacements: [[PREVIEW_MATCH, RECEIPT_INSERT]],
      scenario: previewWritesNothing,
    },
  ] as {
    name: string
    replacements: [string, string][]
    scenario: (S: ServiceModule) => Promise<void>
  }[])(
    'detects a removed $name',
    async ({ replacements, scenario }) => {
      await scenario(Service)
      const copy = await sourceCopy(...replacements)
      await expect(scenario(copy)).rejects.toMatchObject({ name: 'AssertionError' })
      expect(owned.pool.totalCount).toBeLessThanOrEqual(10)
    },
    60_000,
  )
})
