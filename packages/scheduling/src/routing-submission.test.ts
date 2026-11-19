import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as Service from './routing-form-service.ts'
import { openRoutingAnswers, routingTokenDigest } from './routing-receipt-crypto.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = Temporal.Instant.from('2030-10-07T13:43:12.345Z')
const routingSecret = randomBytes(32).toString('base64url')
const answer = 'Synthetic lead answer'
const instanceLock =
  "SELECT pg_advisory_xact_lock(hashtextextended('hourmere.routing-receipt-admission', 0))"

async function sourceCopy(mutate: (source: string) => string): Promise<typeof Service> {
  const location = new URL('./routing-form-service.ts', import.meta.url)
  const original = readFileSync(location, 'utf8')
  const start = original.indexOf('export async function submitRoutingForm(')
  expect(start).toBeGreaterThan(-1)
  const submission = original.slice(start)
  const changed = mutate(submission)
  expect(changed).not.toBe(submission)
  const source = original.slice(0, start) + changed
  const module = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(module).toString('base64')}`) as Promise<
    typeof Service
  >
}

it('pins the absolute receipt lifetime and live receipt ceilings', () => {
  expect(Service.ROUTING_RECEIPT_LIMITS).toEqual({
    lifetimeMinutes: 30,
    perForm: 100,
    perInstance: 10_000,
  })
})

it('refuses routing before reading input, accessing the database or reading the clock when off', async () => {
  const rejectAccess = () => expect.unreachable('routing accessed a dependency while off')
  const inaccessible = new Proxy({}, { get: rejectAccess, ownKeys: rejectAccess })
  for (const routingFormsEnabled of [undefined, false]) {
    const ctx = {
      ...(routingFormsEnabled === false ? { routingFormsEnabled } : {}),
      get db(): Db {
        return rejectAccess()
      },
      get routingSecret(): string {
        return rejectAccess()
      },
      now: rejectAccess,
    }
    await expect(
      Service.submitRoutingForm(
        ctx,
        inaccessible as { organizationId: string; formId: string },
        inaccessible,
      ),
    ).rejects.toMatchObject({ code: 'routing_forms_disabled' })
  }
})

describe.skipIf(!serverUrl)('routing submission receipts and admission', () => {
  let owned: TestDatabase
  let db: Db
  let secondPool: pg.Pool
  let secondDb: Db
  let fixtures: ReturnType<typeof createFixtures>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'routing_submit' })
    db = createDb(owned.pool)
    secondPool = createPool(owned.url)
    secondDb = createDb(secondPool)
    fixtures = createFixtures(db)
  })

  afterEach(async () => {
    await db.deleteFrom('routing_receipts').execute()
  })

  afterAll(async () => {
    try {
      await secondPool?.end()
    } finally {
      await owned?.drop()
    }
  })

  /** A published form of either organization type, enabled explicitly through the fixture. */
  async function published(kind: 'event' | 'message' = 'event', team = false) {
    const user = await createTestUser(db, 'Routing test author')
    const author = team
      ? (await createTestTeam(db, [{ user, role: 'owner' }])).as(user)
      : user.principal
    const principal = {
      kind: 'session' as const,
      sessionId: randomUUID(),
      user: author.user,
      organization: author.organization,
    }
    const ctx = testContext(db, principal, () => now)
    const organizationId = principal.organization.id
    const eventId = await fixtures.eventType(organizationId, team ? null : user.id, {
      hosts: [{ userId: user.id }],
    })
    const questionId = randomUUID()
    const target =
      kind === 'event'
        ? {
            kind,
            eventTypeId: eventId,
            mappings: [{ questionId, destination: { kind: 'inviteeName' } }],
          }
        : { kind, message: 'We will be in touch.' }
    const { id: formId } = await Service.createRoutingForm(ctx, {
      slug: `form-${randomUUID()}`,
      title: 'Qualification',
      questions: [{ id: questionId, type: 'short_text', label: 'Name', required: true }],
      fallback: target,
    })
    const publication = await Service.publishRoutingForm(ctx, formId, { expectedRevision: 1 })
    await Service.updateRoutingForm(ctx, formId, {
      expectedRevision: publication.form.draftRevision,
      enabled: true,
    })
    const versionId = publication.version.id
    return {
      ctx,
      eventId,
      userId: user.id,
      form: { organizationId, formId },
      questionId,
      versionId,
      input: { versionId, answers: { [questionId]: `  ${answer}  ` } },
      target,
    }
  }

  type Fixture = Awaited<ReturnType<typeof published>>

  function context(connection = db, at = now) {
    return { db: connection, routingFormsEnabled: true, routingSecret, now: () => at }
  }

  function submit(fixture: Fixture, service = Service, connection = db, at = now) {
    return service.submitRoutingForm(context(connection, at), fixture.form, fixture.input)
  }

  async function receipts() {
    return db.selectFrom('routing_receipts').selectAll().execute()
  }

  async function seed(
    fixture: Fixture,
    count: number,
    expiresAt = now.add({ minutes: 20 }),
    bookingId: string | null = null,
  ) {
    await owned.pool.query(
      `INSERT INTO routing_receipts (organization_id, form_id, version_id, token_hash,
                                     matched_rule_id, resolved_rule_id, resolved_target,
                                     created_at, expires_at, consumed_booking_id)
       SELECT $1, $2, $3, encode(sha256(uuidv7()::text::bytea), 'hex'),
              'fallback', 'fallback', $4, $5, $6, $7
       FROM generate_series(1, $8::int)`,
      [
        fixture.form.organizationId,
        fixture.form.formId,
        fixture.versionId,
        JSON.stringify(fixture.target),
        now.subtract({ minutes: 10 }).toString(),
        expiresAt.toString(),
        bookingId,
        count,
      ],
    )
  }

  async function liveCount() {
    const { rows } = await owned.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM routing_receipts WHERE expires_at > $1 AND consumed_booking_id IS NULL',
      [now.toString()],
    )
    return rows[0]?.count
  }

  /** Queue both service transactions before releasing the database lock they contend for. */
  async function race(
    first: Fixture,
    second: Fixture,
    lock: string,
    parameters: string[],
    service = Service,
  ) {
    const lockHolder = await owned.pool.connect()
    let open = false
    let running: Promise<PromiseSettledResult<Service.RoutingSubmissionResult>[]> | undefined
    try {
      await lockHolder.query('BEGIN')
      open = true
      const { rows } = await lockHolder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await lockHolder.query(lock, parameters)
      running = Promise.allSettled([submit(first, service), submit(second, service, secondDb)])
      let waiters = 0
      for (let attempt = 0; attempt < 200; attempt++) {
        const status = await owned.pool.query<{ direct: number; waiting: number }>(
          `SELECT count(*) FILTER (WHERE $1 = ANY(pg_blocking_pids(pid)))::int AS direct,
                  count(*) FILTER (WHERE cardinality(pg_blocking_pids(pid)) > 0)::int AS waiting
           FROM pg_stat_activity WHERE datname = current_database()`,
          [rows[0]?.pid],
        )
        waiters = (status.rows[0]?.direct ?? 0) > 0 ? (status.rows[0]?.waiting ?? 0) : 0
        if (waiters === 2) break
        await delay(10)
      }
      expect(waiters, 'both submissions wait in the database').toBe(2)
      await lockHolder.query('COMMIT')
      open = false
      return await running
    } finally {
      try {
        if (open) await lockHolder.query('ROLLBACK')
      } finally {
        lockHolder.release()
      }
      await running
    }
  }

  function oneWinner(results: PromiseSettledResult<Service.RoutingSubmissionResult>[]) {
    expect(
      results.filter((result) => result.status === 'fulfilled'),
      'one receipt minted',
    ).toHaveLength(1)
    expect(results).toContainEqual({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'rate_limited' }),
    })
  }

  async function invalidInputs(fixture: Fixture, service = Service) {
    for (const input of [
      {
        versionId: fixture.versionId,
        answers: { [fixture.questionId]: { nested: { value: answer } } },
      },
      { ...fixture.input, answers: { ...fixture.input.answers, unknown: answer } },
      {
        versionId: fixture.versionId,
        answers: { [fixture.questionId]: `${' '.repeat(500)}x` },
      },
      { ...fixture.input, unknown: answer },
    ]) {
      const result = await service.submitRoutingForm(context(), fixture.form, input).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(result).toMatchObject({ kind: 'invalid' })
      expect(JSON.stringify(result)).not.toContain(answer)
      expect(await receipts()).toEqual([])
    }
  }

  it('stores a version-pinned continuation with encrypted normalized answers and an absolute expiry', async () => {
    const fixture = await published('event', true)
    const result = await submit(fixture)
    expect(result).toEqual({
      kind: 'continuation',
      routeToken: expect.any(String),
      expiresAt: '2030-10-07T14:13:12.345Z',
    })
    if (result.kind !== 'continuation') return expect.unreachable('expected a continuation')
    const rows = await receipts()
    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (!row?.answers_ciphertext) return expect.unreachable('expected encrypted answers')
    expect(row).toMatchObject({
      organization_id: fixture.form.organizationId,
      form_id: fixture.form.formId,
      version_id: fixture.versionId,
      matched_rule_id: 'fallback',
      resolved_rule_id: 'fallback',
      resolved_target: fixture.target,
      expires_at: new Date(result.expiresAt),
      created_at: new Date(now.epochMilliseconds),
      consumed_booking_id: null,
      token_hash: routingTokenDigest(routingSecret, 'continuation', result.routeToken),
    })
    expect(row.token_hash).not.toBe(createHash('sha256').update(result.routeToken).digest('hex'))
    expect(row.token_hash).not.toBe(result.routeToken)
    expect(row.answers_ciphertext.includes(answer)).toBe(false)
    expect(
      openRoutingAnswers(
        routingSecret,
        'continuation',
        { ...fixture.form, versionId: fixture.versionId, receiptId: row.id },
        row.answers_ciphertext,
      ),
    ).toEqual({ [fixture.questionId]: answer })
  })

  it('uses the database clock for production issuance and expiry', async () => {
    const fixture = await published()
    const databaseTime = async () =>
      (await owned.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]?.now
    const before = await databaseTime()
    const result = await Service.submitRoutingForm(
      { db, routingFormsEnabled: true, routingSecret },
      fixture.form,
      fixture.input,
    )
    const after = await databaseTime()
    const [row] = await receipts()
    if (!before || !after || !row || result.kind !== 'continuation')
      return expect.unreachable('expected a continuation and database timestamps')
    const created = new Date(row.created_at).getTime()
    expect(created).toBeGreaterThanOrEqual(before.getTime())
    expect(created).toBeLessThanOrEqual(after.getTime())
    expect(Date.parse(result.expiresAt) - created).toBe(30 * 60 * 1000)
  })

  it('refuses a cross-organization form or version without minting a receipt', async () => {
    const fixture = await published()
    const other = await published('event', true)
    await expect(
      Service.submitRoutingForm(
        context(),
        { ...fixture.form, organizationId: other.form.organizationId },
        fixture.input,
      ),
    ).rejects.toMatchObject({ code: 'routing_form_not_found' })
    await expect(
      Service.submitRoutingForm(context(), fixture.form, {
        ...fixture.input,
        versionId: other.versionId,
      }),
    ).rejects.toMatchObject({ code: 'routing_form_changed' })
    expect(await receipts()).toEqual([])
  })

  it('returns only the chosen message without storing a receipt or mutating routing data', async () => {
    const fixture = await published('message')
    const before = await Service.getRoutingForm(fixture.ctx, fixture.form.formId)
    expect(await submit(fixture)).toEqual({ kind: 'message', message: 'We will be in touch.' })
    expect(await Service.getRoutingForm(fixture.ctx, fixture.form.formId)).toEqual(before)
    expect(await receipts()).toEqual([])
    expect(await db.selectFrom('booking_routing').select('booking_id').execute()).toEqual([])
  })

  it('rejects nested values, unknown keys and overlong raw text before storage', async () => {
    await invalidInputs(await published())
  })

  it('does not count receipts expired exactly now or live receipts already consumed', async () => {
    const fixture = await published()
    const { organizationId } = fixture.form
    const booking = await fixtures.booking(
      organizationId,
      [fixture.userId],
      now.add({ hours: 1 }).toString(),
      now.add({ hours: 2 }).toString(),
      { eventTypeId: fixture.eventId },
    )
    await seed(fixture, 99, now.add({ milliseconds: 1 }))
    await seed(fixture, 1, now)
    await seed(fixture, 1, now.add({ minutes: 20 }), booking)
    expect(await submit(fixture)).toMatchObject({ kind: 'continuation' })
    expect(await liveCount()).toBe(100)
    expect(await receipts()).toHaveLength(102)
    await expect(submit(fixture)).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('serializes the final form admission across independent connections', async () => {
    const fixture = await published()
    await seed(fixture, 99)
    oneWinner(
      await race(fixture, fixture, 'SELECT 1 FROM routing_forms WHERE id = $1 FOR UPDATE', [
        fixture.form.formId,
      ]),
    )
    expect(await liveCount()).toBe(100)
  })

  async function instanceRace(service = Service) {
    const seedForm = await published()
    const first = await published()
    const second = await published('event', true)
    await seed(seedForm, 9999)
    oneWinner(await race(first, second, instanceLock, [], service))
    expect(await liveCount()).toBe(10_000)
  }

  it('serializes the final instance admission across forms in different organizations', async () => {
    await instanceRace()
  })

  it('detects an instance count taken before the advisory lock in a source copy', async () => {
    const mutation = await sourceCopy((source) => {
      const lock = source.match(
        / {6}await sql`SELECT pg_advisory_xact_lock\(hashtextextended\('hourmere\.routing-receipt-admission', 0\)\)`\.execute\(\s*trx,?\s*\)\n/,
      )
      expect(lock).not.toBeNull()
      if (!lock) return source
      return source
        .replace(lock[0], '')
        .replace('      const expiresAt = ', `${lock[0]}      const expiresAt = `)
    })
    await expect(instanceRace(mutation)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('one receipt minted'),
    })
  })

  it('detects skipped pre-storage answer validation in a source copy', async () => {
    const mutation = await sourceCopy((source) =>
      source.replace(
        'const answers = validateRoutingAnswers(config.questions, fields.answers)',
        'const answers = {}',
      ),
    )
    await expect(invalidInputs(await published(), mutation)).rejects.toMatchObject({
      name: 'AssertionError',
      actual: undefined,
    })
  })
})
