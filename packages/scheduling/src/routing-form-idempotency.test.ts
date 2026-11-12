// Idempotent routing form creation and publication (docs/routing-forms.md, step a3b) against
// real PostgreSQL in a throwaway database, with two input checks of the configuration
// services: unknown field names are never echoed, and enabling or disabling never revalidates
// the draft. Races run their two requests on two separate pools, lined up on a held lock. The
// protection scenarios take the service module as a parameter: they pass on the shipped
// module, and the source-copy mutation controls at the end require each of them to fail a
// real assertion on a copy with that one protection removed.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Service from './routing-form-service.ts'
import { createTestTeam, createTestUser, type TestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
type ServiceModule = typeof Service

/** Imports an isolated copy with exactly-once replacements; the shipped file is untouched. */
async function sourceCopy(...replacements: (readonly [string, string])[]): Promise<ServiceModule> {
  const location = new URL('./routing-form-service.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  for (const [from, to] of replacements) {
    expect(source.split(from), `mutation must match once: ${from}`).toHaveLength(2)
    source = source.replace(from, () => to)
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

// Exact source text the mutation controls replace.
const KEY_LOCK = `  await sql\`SELECT pg_advisory_xact_lock(hashtextextended(\${key}, 0))\`.execute(trx)\n`
const CREATE_LOOKUP = `        // After admission, which already serializes the organization's creations, and before
        // the insert, so a retry meets neither the slug it took nor the quota.
        if (operation) {
          const previous = await lockedOperation(trx, operation)
          if (previous) return loadForm(trx, organizationId, previous.form_id)
        }
`
const CREATE_ADMISSION = '        await lockFormAdmission(trx, organizationId)\n'
const PUBLISH_LOOKUP = `        // Before any revision check: a successful first attempt has moved the revision on.
        if (operation) {
          const previous = await lockedOperation(trx, operation)
          if (previous)
            return {
              form: await loadForm(trx, organizationId, previous.form_id),
              version: await loadVersion(
                trx,
                organizationId,
                previous.form_id,
                previous.version_id as string,
              ),
            }
        }
`
const PUBLISH_UNLOCKED_CHECK = `        const unlocked = await findForm(trx, organizationId, id, false)
        assertRevision(unlocked, expected)
`

/** The error a call throws, read by its properties. */
async function caught(fn: () => Promise<unknown>) {
  let error: unknown
  try {
    await fn()
  } catch (thrown) {
    error = thrown
  }
  if (!(error instanceof Error)) return expect.unreachable('expected the operation to fail')
  return error as Error & { kind?: string; code?: string; field?: string }
}

/** The error's name, kind, code and field, compared by value. */
async function failure(fn: () => Promise<unknown>) {
  const { name, kind, code, field } = await caught(fn)
  return { name, kind, code, field }
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

const oauth = (principal: Principal): Principal => ({
  kind: 'oauth',
  oauthConsentId: randomUUID(),
  clientId: 'synthetic-agent',
  scopes: ['mcp'],
  user: principal.user,
  organization: principal.organization,
})

/** A valid draft: one required text question, one rule and a message fallback. */
function content() {
  const question = randomUUID()
  return {
    questions: [{ id: question, type: 'short_text', label: 'Company', required: true }],
    rules: [
      {
        id: randomUUID(),
        conditions: [{ questionId: question, operator: 'equals', value: 'Acme' }],
        target: { kind: 'message', message: 'Thanks, Acme' },
      },
    ],
    fallback: { kind: 'message', message: 'Thank you' },
  }
}

const slug = () => `form-${randomUUID().slice(0, 8)}`

describe.skipIf(!serverUrl)('idempotent routing form configuration writes', () => {
  let owned: TestDatabase
  let db: Db
  // Two more small pools: racing requests never share a connection or a pool.
  let racePools: pg.Pool[]
  let first: Db
  let second: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'routing_replay' })
    db = createDb(owned.pool)
    racePools = [0, 1].map(() => new pg.Pool({ connectionString: owned.url, max: 2 }))
    first = createDb(racePools[0] as pg.Pool)
    second = createDb(racePools[1] as pg.Pool)
  })
  afterAll(async () => {
    await first?.destroy()
    await second?.destroy()
    await owned?.drop()
  })

  /** A user acting by session in their personal organization. */
  async function personalSpace() {
    const user = await createTestUser(db, 'Routing author')
    const principal = session(user.principal)
    return {
      user,
      principal,
      organizationId: user.principal.organization.id,
      ctx: testContext(db, principal),
    }
  }

  /** A team with an owner and an admin, each acting by session. */
  async function teamSpace() {
    const owner = await createTestUser(db, 'Owner')
    const admin = await createTestUser(db, 'Admin')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
    ])
    return {
      team,
      owner,
      admin,
      as: (user: TestUser, credential = session) => testContext(db, credential(team.as(user))),
    }
  }

  /** A full API key of `user` in `organizationId`, stored so that writes can recheck it. */
  async function apiKey(user: TestUser, organization: Principal['organization']) {
    const now = new Date()
    const { id } = await db
      .insertInto('auth.apikey')
      .values({
        configId: 'default',
        referenceId: user.id,
        key: randomUUID(),
        createdAt: now,
        updatedAt: now,
        metadata: JSON.stringify({ scope: 'full', organizationId: organization.id }),
        enabled: true,
        rateLimitEnabled: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return testContext(db, {
      kind: 'api_key',
      apiKeyId: id,
      apiKeyScope: 'full',
      user: user.principal.user,
      organization,
    })
  }

  async function counts(organizationId: string) {
    const { rows } = await owned.pool.query<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM routing_forms WHERE organization_id = $1) AS forms,
              (SELECT count(*)::int FROM routing_form_versions WHERE organization_id = $1) AS versions,
              (SELECT count(*)::int FROM routing_form_operations WHERE organization_id = $1) AS operations`,
      [organizationId],
    )
    return rows[0]
  }

  /** The form row's tuple identity: any write to it changes xmin. */
  async function tuple(formId: string) {
    const { rows } = await owned.pool.query<{ xmin: string }>(
      'SELECT xmin::text FROM routing_forms WHERE id = $1',
      [formId],
    )
    return rows[0]?.xmin
  }

  /** A connection holding `statement`'s locks in an open transaction. */
  async function hold(statement: string, params: unknown[]) {
    const client: pg.PoolClient = await owned.pool.connect()
    let pid: number
    try {
      await client.query('BEGIN')
      await client.query(statement, params)
      pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid as number
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
      throw error
    }
    let open = true
    return {
      pid,
      async commit() {
        open = false
        await client.query('COMMIT')
      },
      async rollback() {
        open = false
        await client.query('ROLLBACK')
      },
      async close() {
        if (open) await client.query('ROLLBACK').catch(() => {})
        client.release()
      },
    }
  }

  /**
   * Waits until a session waits for a lock that `pid` holds and `count` sessions of this
   * database wait for locks in all: a second request can queue behind the first.
   */
  async function blockedBy(pid: number, count: number) {
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

  // --- Protection scenarios (also run against each mutant below) ---------------------------

  /** A creation retried with its key returns the form it created and creates nothing more. */
  async function createReplayReturnsTheSameForm(S: ServiceModule) {
    const space = await personalSpace()
    const requestId = randomUUID()
    const input = { requestId, slug: slug(), title: 'Replay', ...content() }
    const created = await succeeds(() => S.createRoutingForm(space.ctx, input))
    expect(await succeeds(() => S.createRoutingForm(space.ctx, structuredClone(input)))).toEqual(
      created,
    )
    // The key compares in lowercase, and the input after validation: surrounding blanks and
    // an omitted optional field are the same request.
    expect(
      await succeeds(() =>
        S.createRoutingForm(space.ctx, {
          ...input,
          requestId: requestId.toUpperCase(),
          title: '  Replay ',
          description: null,
        }),
      ),
    ).toEqual(created)
    expect(await counts(space.organizationId)).toEqual({ forms: 1, versions: 0, operations: 1 })
    // A retry after a later save returns the same form as it is now, without writing it.
    const edited = await S.updateRoutingForm(space.ctx, created.id, {
      expectedRevision: 1,
      title: 'Edited',
    })
    const before = await tuple(created.id)
    expect(await succeeds(() => S.createRoutingForm(space.ctx, input))).toEqual(edited)
    expect(await tuple(created.id)).toBe(before)
    // Without the key the same input is a new request, and its slug is taken.
    expect(
      await failure(() => S.createRoutingForm(space.ctx, { ...input, requestId: undefined })),
    ).toMatchObject({ code: 'slug_taken' })
    expect(await counts(space.organizationId)).toEqual({ forms: 1, versions: 0, operations: 1 })
  }

  /** The key of a creation with any field changed, or used to publish, is refused. */
  async function createChangedInputConflicts(S: ServiceModule) {
    const space = await personalSpace()
    const requestId = randomUUID()
    const base = { requestId, slug: slug(), title: 'Original', description: 'About', ...content() }
    const created = await S.createRoutingForm(space.ctx, base)
    const question = base.questions[0] as Record<string, unknown>
    const rule = base.rules[0] as { conditions: Record<string, unknown>[] }
    const changes: [string, Record<string, unknown>][] = [
      ['slug', { slug: slug() }],
      ['title', { title: 'Changed' }],
      ['description', { description: 'Changed' }],
      ['description removed', { description: null }],
      ['questions', { questions: [{ ...question, label: 'Organisation' }] }],
      ['rules', { rules: [{ ...rule, conditions: [{ ...rule.conditions[0], value: 'Globex' }] }] }],
      ['fallback', { fallback: { kind: 'message', message: 'Changed' } }],
    ]
    for (const [field, change] of changes)
      expect(
        await failure(() => S.createRoutingForm(space.ctx, { ...base, ...change })),
        field,
      ).toMatchObject({ kind: 'conflict', code: 'idempotency_key_reused' })
    expect(
      await failure(() =>
        S.publishRoutingForm(space.ctx, created.id, { expectedRevision: 1, requestId }),
      ),
      'the key of a creation used to publish',
    ).toMatchObject({ code: 'idempotency_key_reused' })
    expect(await counts(space.organizationId)).toEqual({ forms: 1, versions: 0, operations: 1 })
    expect(await S.getRoutingForm(space.ctx, created.id)).toEqual(created)
  }

  /**
   * A publication retried with its key returns the version it published instead of
   * `routing_revision_conflict`, writes nothing, and keeps doing so after later publications.
   */
  async function publishRetryReturnsTheSameVersion(S: ServiceModule) {
    const space = await personalSpace()
    const form = await S.createRoutingForm(space.ctx, {
      slug: slug(),
      title: 'Publish',
      ...content(),
    })
    const requestId = randomUUID()
    const published = await succeeds(() =>
      S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1, requestId }),
    )
    expect(published.form.draftRevision).toBe(2)
    const before = await tuple(form.id)
    const retried = await succeeds(() =>
      S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1, requestId }),
    )
    // The same objects, field order included.
    expect(JSON.stringify(retried)).toBe(JSON.stringify(published))
    expect(await tuple(form.id)).toBe(before)
    expect(await counts(space.organizationId)).toEqual({ forms: 1, versions: 1, operations: 1 })
    // After a later publication the retry still returns its own version, with the form as
    // it is now.
    await S.updateRoutingForm(space.ctx, form.id, { expectedRevision: 2, title: 'Second' })
    const next = await S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 3 })
    const late = await succeeds(() =>
      S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1, requestId }),
    )
    expect(late.version).toEqual(published.version)
    expect(late.form).toEqual(next.form)
    expect(late.form.publishedVersionId).toBe(next.version.id)
    // Without the key the same input is stale.
    expect(
      await failure(() => S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1 })),
    ).toMatchObject({ code: 'routing_revision_conflict' })
    expect(await counts(space.organizationId)).toEqual({ forms: 1, versions: 2, operations: 1 })
  }

  /** The key of a publication with another revision or form, or used to create, is refused. */
  async function publishChangedInputConflicts(S: ServiceModule) {
    const space = await personalSpace()
    const form = await S.createRoutingForm(space.ctx, { slug: slug(), title: 'One', ...content() })
    const other = await S.createRoutingForm(space.ctx, { slug: slug(), title: 'Two', ...content() })
    const requestId = randomUUID()
    await S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1, requestId })
    for (const [label, operation] of [
      [
        'the current revision',
        () => S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 2, requestId }),
      ],
      [
        'another form',
        () => S.publishRoutingForm(space.ctx, other.id, { expectedRevision: 1, requestId }),
      ],
      [
        'a creation',
        () =>
          S.createRoutingForm(space.ctx, { requestId, slug: slug(), title: 'New', ...content() }),
      ],
    ] as const)
      expect(await failure(operation), label).toMatchObject({
        kind: 'conflict',
        code: 'idempotency_key_reused',
      })
    expect(await counts(space.organizationId)).toEqual({ forms: 2, versions: 1, operations: 1 })
    expect((await S.getRoutingForm(space.ctx, form.id)).draftRevision).toBe(2)
    expect((await S.getRoutingForm(space.ctx, other.id)).publishedVersionId).toBeNull()
  }

  /**
   * A key is scoped to the acting credential: another admin, and the same user through an
   * OAuth grant or an API key, never match it, whatever their input.
   */
  async function keysOfOtherActorsNeverMatch(S: ServiceModule) {
    const space = await teamSpace()
    const requestId = randomUUID()
    const input = { requestId, slug: slug(), title: 'Shared key', ...content() }
    const byAdmin = await S.createRoutingForm(space.as(space.admin), input)
    // The owner's identical request is a new request: it meets the slug the first one took.
    expect(await failure(() => S.createRoutingForm(space.as(space.owner), input))).toMatchObject({
      code: 'slug_taken',
    })
    const organization = space.team.as(space.admin).organization
    const others = [
      space.as(space.owner),
      space.as(space.admin, oauth),
      await apiKey(space.admin, organization),
    ]
    const ids = [byAdmin.id]
    for (const ctx of others)
      ids.push((await succeeds(() => S.createRoutingForm(ctx, { ...input, slug: slug() }))).id)
    expect(new Set(ids).size).toBe(4)
    // Publication: another actor's same input is stale, and its next revision publishes.
    const key = randomUUID()
    const initial = await S.publishRoutingForm(space.as(space.admin), byAdmin.id, {
      expectedRevision: 1,
      requestId: key,
    })
    expect(
      await failure(() =>
        S.publishRoutingForm(space.as(space.owner), byAdmin.id, {
          expectedRevision: 1,
          requestId: key,
        }),
      ),
    ).toMatchObject({ code: 'routing_revision_conflict' })
    for (const [revision, ctx] of others.entries()) {
      const { version } = await succeeds(() =>
        S.publishRoutingForm(ctx, byAdmin.id, { expectedRevision: revision + 2, requestId: key }),
      )
      expect(version.versionNumber).toBe(revision + 2)
      expect(version.id).not.toBe(initial.version.id)
    }
    expect(await counts(space.team.id)).toEqual({ forms: 4, versions: 4, operations: 8 })
  }

  /** One user's key in their personal organization never matches it in a team. */
  async function keysOfOtherOrganizationsNeverMatch(S: ServiceModule) {
    const user = await createTestUser(db, 'Two spaces')
    const team = await createTestTeam(db, [{ user, role: 'owner' }])
    const personal = testContext(db, session(user.principal))
    const inTeam = testContext(db, session(team.as(user)))
    const input = { requestId: randomUUID(), slug: slug(), title: 'Same key', ...content() }
    const mine = await succeeds(() => S.createRoutingForm(personal, input))
    const ours = await succeeds(() => S.createRoutingForm(inTeam, input))
    expect(ours.id).not.toBe(mine.id)
    const publication = { expectedRevision: 1, requestId: randomUUID() }
    const versions = [
      await succeeds(() => S.publishRoutingForm(personal, mine.id, publication)),
      await succeeds(() => S.publishRoutingForm(inTeam, ours.id, publication)),
    ].map(({ version }) => version.formId)
    expect(versions).toEqual([mine.id, ours.id])
    expect(await counts(user.principal.organization.id)).toEqual({
      forms: 1,
      versions: 1,
      operations: 2,
    })
    expect(await counts(team.id)).toEqual({ forms: 1, versions: 1, operations: 2 })
  }

  /**
   * A retry waits for a version cleanup that is deleting its record: once the cleanup
   * commits, the record is gone with its version and the retry is an ordinary stale request;
   * once it rolls back, the retry returns the version.
   */
  async function replayWaitsForVersionCleanup(S: ServiceModule) {
    for (const outcome of ['commit', 'rollback'] as const) {
      const space = await personalSpace()
      const form = await S.createRoutingForm(space.ctx, {
        slug: slug(),
        title: 'Cleanup',
        ...content(),
      })
      const publication = { expectedRevision: 1, requestId: randomUUID() }
      const published = await S.publishRoutingForm(space.ctx, form.id, publication)
      await S.updateRoutingForm(space.ctx, form.id, { expectedRevision: 2, title: 'Next' })
      await S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 3 })
      // The superseded version, deleted in a transaction left open.
      const cleanup = await hold('DELETE FROM routing_form_versions WHERE id = $1', [
        published.version.id,
      ])
      let retry: Promise<{ value?: { version: { id: string } }; error?: unknown }> | undefined
      try {
        retry = settle(
          S.publishRoutingForm(testContext(first, space.principal), form.id, publication),
        )
        await blockedBy(cleanup.pid, 1)
        await cleanup[outcome]()
        const result = await retry
        if (outcome === 'commit') {
          expect((result.error as { code?: string })?.code).toBe('routing_revision_conflict')
          expect(await counts(space.organizationId)).toEqual({
            forms: 1,
            versions: 1,
            operations: 0,
          })
        } else expect(result.value?.version).toEqual(published.version)
      } finally {
        await cleanup.close()
        await retry
      }
    }
  }

  /** Two retries of one publication, on two pools and lined up on the form lock, write once. */
  async function concurrentPublishRetriesWriteOnce(S: ServiceModule) {
    const space = await personalSpace()
    const form = await S.createRoutingForm(space.ctx, { slug: slug(), title: 'Race', ...content() })
    const requestId = randomUUID()
    const blocker = await hold('SELECT 1 FROM routing_forms WHERE id = $1 FOR UPDATE', [form.id])
    let racers: Promise<{ value?: unknown; error?: unknown }[]> | undefined
    try {
      racers = Promise.all(
        [first, second].map((pool) =>
          settle(
            S.publishRoutingForm(testContext(pool, space.principal), form.id, {
              expectedRevision: 1,
              requestId,
            }),
          ),
        ),
      )
      await blockedBy(blocker.pid, 2)
      await blocker.commit()
      const results = await racers
      expect(results.map((result) => (result.error as { code?: string })?.code)).toEqual([
        undefined,
        undefined,
      ])
      expect(JSON.stringify(results[0]?.value)).toBe(JSON.stringify(results[1]?.value))
      expect(await counts(space.organizationId)).toEqual({ forms: 1, versions: 1, operations: 1 })
    } finally {
      await blocker.close()
      await racers
    }
  }

  /** Two retries of one creation, on two pools and lined up on form admission, create once. */
  async function concurrentCreateRetriesWriteOnce(S: ServiceModule) {
    const space = await personalSpace()
    const input = { requestId: randomUUID(), slug: slug(), title: 'Race', ...content() }
    const blocker = await hold(
      `SELECT pg_advisory_xact_lock(hashtextextended('hourmere.routing-form-quota:' || $1::uuid::text, 0))`,
      [space.organizationId],
    )
    let racers: Promise<{ value?: unknown; error?: unknown }[]> | undefined
    try {
      racers = Promise.all(
        [first, second].map((pool) =>
          settle(S.createRoutingForm(testContext(pool, space.principal), input)),
        ),
      )
      await blockedBy(blocker.pid, 2)
      await blocker.commit()
      const results = await racers
      expect(results.map((result) => (result.error as { code?: string })?.code)).toEqual([
        undefined,
        undefined,
      ])
      expect(results[0]?.value).toEqual(results[1]?.value)
      expect(await counts(space.organizationId)).toEqual({ forms: 1, versions: 0, operations: 1 })
    } finally {
      await blocker.close()
      await racers
    }
  }

  /** No unknown field name reaches an error, at the top level or nested. */
  async function unknownFieldsAreNeverEchoed(S: ServiceModule) {
    const MARK = 'zqxUnknownField'
    // Spread in, so that each object literal carries a field no type declares.
    const extra: Record<string, number> = { [MARK]: 1 }
    const space = await personalSpace()
    const base = content()
    const form = await S.createRoutingForm(space.ctx, { slug: slug(), title: 'Echo', ...base })
    const question = base.questions[0] as { id: string }
    const rule = base.rules[0] as { conditions: Record<string, unknown>[]; target: object }
    const select = {
      id: randomUUID(),
      type: 'select',
      label: 'Size',
      required: false,
      options: [{ id: randomUUID(), label: 'Small', ...extra }],
    }
    const event = (mapping: Record<string, unknown>) => ({
      kind: 'event',
      eventTypeId: randomUUID(),
      mappings: [mapping],
    })
    const create = (change: Record<string, unknown>) => () =>
      S.createRoutingForm(space.ctx, { slug: slug(), title: 'Echo', ...base, ...change })
    const cases: [string, () => Promise<unknown>][] = [
      ['create', create({ ...extra })],
      ['create with a key', create({ requestId: randomUUID(), ...extra })],
      ['question', create({ questions: [{ ...question, ...extra }] })],
      ['option', create({ questions: [question, select] })],
      ['rule', create({ rules: [{ ...rule, ...extra }] })],
      [
        'condition',
        create({ rules: [{ ...rule, conditions: [{ ...rule.conditions[0], ...extra }] }] }),
      ],
      ['rule target', create({ rules: [{ ...rule, target: { ...rule.target, ...extra } }] })],
      ['fallback', create({ fallback: { kind: 'message', message: 'm', ...extra } })],
      [
        'mapping',
        create({
          fallback: event({
            questionId: question.id,
            destination: { kind: 'inviteeName' },
            ...extra,
          }),
        }),
      ],
      [
        'mapping destination',
        create({
          fallback: event({
            questionId: question.id,
            destination: { kind: 'inviteeName', ...extra },
          }),
        }),
      ],
      ['update', () => S.updateRoutingForm(space.ctx, form.id, { expectedRevision: 1, ...extra })],
      [
        'update of a draft field',
        () =>
          S.updateRoutingForm(space.ctx, form.id, {
            expectedRevision: 1,
            fallback: { kind: 'message', message: 'm', ...extra },
          }),
      ],
      [
        'publish',
        () =>
          S.publishRoutingForm(space.ctx, form.id, {
            expectedRevision: 1,
            requestId: randomUUID(),
            ...extra,
          }),
      ],
      [
        'archive',
        () => S.archiveRoutingForm(space.ctx, form.id, { expectedRevision: 1, ...extra }),
      ],
      ['preview', () => S.previewRoutingForm(space.ctx, form.id, { answers: {}, ...extra })],
      [
        'preview answers',
        () => S.previewRoutingForm(space.ctx, form.id, { answers: { [MARK]: 'x' } }),
      ],
    ]
    for (const [label, operation] of cases) {
      const error = await caught(operation)
      expect(error.kind, label).toBe('invalid')
      // The message, the field and every other own property, the stack included.
      const dump = `${JSON.stringify(error, Object.getOwnPropertyNames(error))} ${error.message} ${error.field}`
      expect(dump, label).not.toContain(MARK)
    }
    expect(await counts(space.organizationId)).toEqual({ forms: 1, versions: 0, operations: 0 })
    expect((await S.getRoutingForm(space.ctx, form.id)).draftRevision).toBe(1)
  }

  /**
   * Enabling and disabling keep the stored draft as it is, so a draft that a stricter later
   * validator refuses cannot block an urgent disable; a draft field still revalidates it all.
   */
  async function disableKeepsTheDraftUnvalidated(S: ServiceModule) {
    const space = await personalSpace()
    const form = await S.createRoutingForm(space.ctx, {
      slug: slug(),
      title: 'Urgent',
      ...content(),
    })
    await S.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1 })
    await S.updateRoutingForm(space.ctx, form.id, { expectedRevision: 2, enabled: true })
    // Readable by shape, refused by today's validator (a blank title).
    const stale = {
      title: '   ',
      questions: [],
      rules: [],
      fallback: { kind: 'message', message: 'x' },
    }
    await db
      .updateTable('routing_forms')
      .set({ draft: JSON.stringify(stale) })
      .where('id', '=', form.id)
      .execute()
    const disabled = await succeeds(() =>
      S.updateRoutingForm(space.ctx, form.id, { expectedRevision: 3, enabled: false }),
    )
    expect(disabled).toMatchObject({ enabled: false, draftRevision: 4, title: '   ' })
    const enabled = await succeeds(() =>
      S.updateRoutingForm(space.ctx, form.id, { expectedRevision: 4, enabled: true, slug: slug() }),
    )
    expect(enabled).toMatchObject({ enabled: true, draftRevision: 5, title: '   ' })
    const { rows } = await owned.pool.query('SELECT draft FROM routing_forms WHERE id = $1', [
      form.id,
    ])
    expect(rows[0]?.draft).toEqual(stale)
    expect(
      await failure(() =>
        S.updateRoutingForm(space.ctx, form.id, { expectedRevision: 5, description: 'Notes' }),
      ),
    ).toMatchObject({ code: 'invalid_routing_form', field: 'title' })
  }

  describe('creation', () => {
    it('returns the form a retry created, as it is now, and writes nothing more', () =>
      createReplayReturnsTheSameForm(Service))
    it('refuses the key with any field changed, or for a publication', () =>
      createChangedInputConflicts(Service))
    it('creates once when two retries race on two connections', () =>
      concurrentCreateRetriesWriteOnce(Service))
  })

  describe('publication', () => {
    it('returns the version a retry published instead of a revision conflict', () =>
      publishRetryReturnsTheSameVersion(Service))
    it('refuses the key with another revision or form, or for a creation', () =>
      publishChangedInputConflicts(Service))
    it('publishes once when two retries race on two connections', () =>
      concurrentPublishRetriesWriteOnce(Service))
    it('publishes once in unstaged rounds of two retries on two connections', async () => {
      for (let round = 0; round < 10; round++) {
        const space = await personalSpace()
        const form = await Service.createRoutingForm(space.ctx, {
          slug: slug(),
          title: `Round ${round}`,
          ...content(),
        })
        const requestId = randomUUID()
        // Both settle before any assertion, so no request outlives a failed round.
        const results = await Promise.all(
          [first, second].map((pool) =>
            settle(
              Service.publishRoutingForm(testContext(pool, space.principal), form.id, {
                expectedRevision: 1,
                requestId,
              }),
            ),
          ),
        )
        expect(results.map((result) => (result.error as { code?: string })?.code)).toEqual([
          undefined,
          undefined,
        ])
        expect(results[0]?.value).toEqual(results[1]?.value)
        expect(await counts(space.organizationId)).toEqual({ forms: 1, versions: 1, operations: 1 })
      }
    })
  })

  describe('scope and lifecycle', () => {
    it('never matches a key of another actor or credential', () =>
      keysOfOtherActorsNeverMatch(Service))
    it('never matches a key of the same user in another organization', () =>
      keysOfOtherOrganizationsNeverMatch(Service))
    it('waits for a version cleanup that removes the record of a retry', () =>
      replayWaitsForVersionCleanup(Service))

    it('answers a retry for an archived form as routing_form_not_found', async () => {
      const space = await personalSpace()
      const creation = { requestId: randomUUID(), slug: slug(), title: 'Gone', ...content() }
      const form = await Service.createRoutingForm(space.ctx, creation)
      const publication = { expectedRevision: 1, requestId: randomUUID() }
      await Service.publishRoutingForm(space.ctx, form.id, publication)
      await Service.archiveRoutingForm(space.ctx, form.id, { expectedRevision: 2 })
      expect(await failure(() => Service.createRoutingForm(space.ctx, creation))).toMatchObject({
        code: 'routing_form_not_found',
      })
      expect(
        await failure(() => Service.publishRoutingForm(space.ctx, form.id, publication)),
      ).toMatchObject({ code: 'routing_form_not_found' })
      expect(await counts(space.organizationId)).toEqual({ forms: 1, versions: 1, operations: 2 })
    })

    it('rechecks the actor before answering a retry', async () => {
      const space = await teamSpace()
      const admin = space.as(space.admin)
      const creation = { requestId: randomUUID(), slug: slug(), title: 'Demoted', ...content() }
      const form = await Service.createRoutingForm(admin, creation)
      const publication = { expectedRevision: 1, requestId: randomUUID() }
      await Service.publishRoutingForm(admin, form.id, publication)
      await db
        .updateTable('auth.member')
        .set({ role: 'member' })
        .where('organizationId', '=', space.team.id)
        .where('userId', '=', space.admin.id)
        .execute()
      for (const operation of [
        () => Service.createRoutingForm(admin, creation),
        () => Service.publishRoutingForm(admin, form.id, publication),
      ])
        expect(await failure(operation)).toMatchObject({ code: 'team_management_access_denied' })
    })

    it('refuses a requestId that is not a UUID, naming the field', async () => {
      const space = await personalSpace()
      const form = await Service.createRoutingForm(space.ctx, {
        slug: slug(),
        title: 'Keys',
        ...content(),
      })
      for (const requestId of ['abc', '', 42, null, `${randomUUID()}x`]) {
        expect(
          await failure(() =>
            Service.createRoutingForm(space.ctx, {
              requestId,
              slug: slug(),
              title: 'Bad key',
              ...content(),
            }),
          ),
        ).toMatchObject({ code: 'invalid_routing_form', field: 'requestId' })
        expect(
          await failure(() =>
            Service.publishRoutingForm(space.ctx, form.id, { expectedRevision: 1, requestId }),
          ),
        ).toMatchObject({ code: 'invalid_routing_form', field: 'requestId' })
      }
      expect(await counts(space.organizationId)).toEqual({ forms: 1, versions: 0, operations: 0 })
    })
  })

  describe('input checks', () => {
    it('never echoes an unknown field name, at the top level or nested', () =>
      unknownFieldsAreNeverEchoed(Service))
    it('enables and disables without revalidating the draft', () =>
      disableKeepsTheDraftUnvalidated(Service))
  })

  // --- Source-copy mutation controls --------------------------------------------------------

  it.each([
    {
      name: 'creation fingerprint covering the slug',
      replacements: [['{ slug, draft })', '{ draft })']],
      scenario: createChangedInputConflicts,
    },
    {
      name: 'publication fingerprint covering expectedRevision',
      replacements: [['    expectedRevision: expected,\n  })', '  })']],
      scenario: publishChangedInputConflicts,
    },
    {
      name: 'fingerprint comparison of a retry',
      replacements: [
        [
          'if (previous !== undefined && !previous.request_fingerprint.equals(operation.fingerprint))',
          'if (false)',
        ],
      ],
      scenario: createChangedInputConflicts,
    },
    {
      name: 'actor scope of the key lookup',
      replacements: [["    .where('actor_scope_digest', '=', operation.actor)\n", '']],
      scenario: keysOfOtherActorsNeverMatch,
    },
    {
      name: 'organization scope of the key lookup',
      replacements: [["    .where('organization_id', '=', operation.organizationId)\n", '']],
      scenario: keysOfOtherOrganizationsNeverMatch,
    },
    {
      name: 'share lock on the record a retry reads',
      replacements: [['    .forShare()\n    .executeTakeFirst()', '    .executeTakeFirst()']],
      scenario: replayWaitsForVersionCleanup,
    },
    {
      name: 'publication lookup before the unlocked revision check (looked up after it)',
      replacements: [
        [PUBLISH_LOOKUP, ''],
        [PUBLISH_UNLOCKED_CHECK, `${PUBLISH_UNLOCKED_CHECK}${PUBLISH_LOOKUP}`],
      ],
      scenario: publishRetryReturnsTheSameVersion,
    },
    {
      name: 'publication record',
      replacements: [
        ['        if (operation) await recordOperation(trx, operation, form.id, version.id)\n', ''],
      ],
      scenario: publishRetryReturnsTheSameVersion,
    },
    {
      name: 'creation record',
      replacements: [
        ['        if (operation) await recordOperation(trx, operation, id, null)\n', ''],
      ],
      scenario: createReplayReturnsTheSameForm,
    },
    {
      name: 'request-key lock (concurrent publication retries both write)',
      replacements: [[KEY_LOCK, '']],
      scenario: concurrentPublishRetriesWriteOnce,
    },
    {
      name: 'creation lookup after form admission (before it, without the request-key lock)',
      replacements: [
        [KEY_LOCK, ''],
        [`${CREATE_ADMISSION}${CREATE_LOOKUP}`, `${CREATE_LOOKUP}${CREATE_ADMISSION}`],
      ],
      scenario: concurrentCreateRetriesWriteOnce,
    },
    {
      // The reviewer's mutation of the configuration services' unknown-field check.
      name: 'unknown field name kept out of the error message',
      replacements: [
        [
          "    throw invalidForm(undefined, 'has an unknown field')\n",
          `    throw invalidForm(undefined, \`has an unknown field \${Object.keys(value).find((key) => !keys.includes(key))}\`)\n`,
        ],
      ],
      scenario: unknownFieldsAreNeverEchoed,
    },
    {
      name: 'disable without draft revalidation (every update revalidates)',
      replacements: [
        [
          '        const draft = DRAFT_FIELDS.some((key) => fields[key] !== undefined)\n',
          '        const draft = true\n',
        ],
      ],
      scenario: disableKeepsTheDraftUnvalidated,
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
