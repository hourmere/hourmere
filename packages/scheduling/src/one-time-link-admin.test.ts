import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as Links from './one-time-links.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
type LinkModule = typeof Links
async function sourceCopy(replacement?: readonly [string, string]): Promise<LinkModule> {
  const location = new URL('./one-time-links.ts', import.meta.url)
  const original = readFileSync(location, 'utf8')
  if (replacement) expect(original.includes(replacement[0]), 'mutation must match').toBe(true)
  const source = stripTypeScriptTypes(
    replacement ? original.replace(...replacement) : original,
  ).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('node:') ? specifier : specifier.startsWith('.') ? new URL(specifier, location).href : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}
function safeMetadata(value: unknown, token: string) {
  const serialized = JSON.stringify(value)
  expect(serialized.includes(token)).toBe(false)
  expect(serialized.includes(createHash('sha256').update(token).digest('hex'))).toBe(false)
  expect(/token|tokenHash|token_hash|"url"/.test(serialized)).toBe(false)
}
const session = (principal: Principal): Principal => ({
  kind: 'session',
  sessionId: randomUUID(),
  user: principal.user,
  organization: principal.organization,
})

describe.skipIf(!serverUrl)('one-time link administration', () => {
  let owned: TestDatabase
  let db: Db
  let fixtures: ReturnType<typeof createFixtures>
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'one_time_admin' })
    db = createDb(owned.pool)
    fixtures = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function setup() {
    const user = await createTestUser(db)
    const ctx = testContext(db, session(user.principal))
    const eventTypeId = await fixtures.eventType(user.principal.organization.id, user.id)
    return { user, ctx, eventTypeId }
  }
  async function keyContext(
    s: Awaited<ReturnType<typeof setup>>,
    scope: 'full' | 'read' | 'bookings',
  ) {
    const key = await db
      .insertInto('auth.apikey')
      .values({
        configId: 'default',
        referenceId: s.user.id,
        key: createHash('sha256').update(randomBytes(32)).digest('hex'),
        createdAt: new Date(),
        updatedAt: new Date(),
        enabled: true,
        metadata: JSON.stringify({ scope, organizationId: s.ctx.principal.organization.id }),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return testContext(db, {
      ...s.user.principal,
      kind: 'api_key',
      apiKeyId: key.id,
      apiKeyScope: scope,
    })
  }
  async function verifyRetry(module = Links) {
    const s = await setup()
    const input = {
      eventTypeId: s.eventTypeId,
      idempotencyKey: randomUUID(),
      prefill: { name: '  Grace  ', email: 'GRACE@example.com' },
      expiresAt: '2090-11-05T01:30:00-04:00',
    }
    const first = await module.createOneTimeBookingLink(s.ctx, input)
    const normalized = {
      ...input,
      prefill: { name: 'Grace', email: 'grace@example.com' },
      expiresAt: '2090-11-05T05:30:00.000Z',
    }
    await expect(module.createOneTimeBookingLink(s.ctx, normalized)).rejects.toMatchObject({
      code: 'one_time_link_already_created',
    })
    const page = await module.listOneTimeBookingLinks(s.ctx, { eventTypeId: s.eventTypeId })
    expect(page.data).toHaveLength(1)
    expect(page.data[0]?.id).toBe(first.id)
    safeMetadata(page, first.token)
    return { s, input, first }
  }
  it('keeps credential-bound retry markers across isolated service imports without retaining a raw response', async () => {
    const { s, input, first } = await verifyRetry()
    const reloaded = await sourceCopy()
    await expect(reloaded.createOneTimeBookingLink(s.ctx, input)).rejects.toMatchObject({
      code: 'one_time_link_already_created',
    })
    await expect(
      reloaded.createOneTimeBookingLink(s.ctx, { ...input, prefill: { name: 'Changed' } }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    const fresh = await Links.createOneTimeBookingLink(s.ctx, {
      ...input,
      idempotencyKey: randomUUID(),
    })
    expect(fresh.id === first.id).toBe(false)
    const otherCredential = testContext(db, session(s.user.principal))
    expect((await Links.createOneTimeBookingLink(otherCredential, input)).id === first.id).toBe(
      false,
    )
    await Links.revokeManagedOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId, id: first.id })
    await expect(Links.createOneTimeBookingLink(s.ctx, input)).rejects.toMatchObject({
      code: 'one_time_link_already_created',
    })
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', s.user.id)
      .execute()
    await expect(Links.createOneTimeBookingLink(s.ctx, input)).rejects.toMatchObject({
      code: 'insufficient_role',
    })
  })
  it('serializes concurrent retry requests and rejects invalid keys before issuing capabilities', async () => {
    const s = await setup()
    const input = { eventTypeId: s.eventTypeId, idempotencyKey: randomUUID() }
    const outcomes = await Promise.allSettled(
      Array.from({ length: 3 }, () => Links.createOneTimeBookingLink(s.ctx, input)),
    )
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(
      outcomes.filter(
        (result) =>
          result.status === 'rejected' && result.reason.code === 'one_time_link_already_created',
      ),
    ).toHaveLength(2)
    for (const key of ['', 'a b', '\n', 'x'.repeat(256)])
      await expect(
        Links.createOneTimeBookingLink(s.ctx, { ...input, idempotencyKey: key }),
      ).rejects.toMatchObject({ code: 'invalid_idempotency_key' })
  })
  async function verifyCredentialBinding(module = Links) {
    const s = await setup()
    const input = { eventTypeId: s.eventTypeId, idempotencyKey: randomUUID() }
    const first = await module.createOneTimeBookingLink(s.ctx, input)
    const second = await module
      .createOneTimeBookingLink(testContext(db, session(s.user.principal)), input)
      .catch(() => null)
    expect(second === null).toBe(false)
    expect(first.id === second?.id).toBe(false)
    expect(first.token === second?.token).toBe(false)
    expect(
      (await module.listOneTimeBookingLinks(s.ctx, { eventTypeId: s.eventTypeId })).data,
    ).toHaveLength(2)
  }
  it('binds creation retry markers to the exact credential as well as user and organization', async () => {
    await verifyCredentialBinding()
  })
  async function verifyScope(module = Links) {
    const s = await setup()
    const ctx = await keyContext(s, 'bookings')
    const link = await module.createOneTimeBookingLink(ctx, { eventTypeId: s.eventTypeId })
    await expect(
      module.listOneTimeBookingLinks(ctx, { eventTypeId: s.eventTypeId }),
    ).rejects.toMatchObject({ error: 'insufficient_scope' })
    await expect(
      module.getOneTimeBookingLink(ctx, { eventTypeId: s.eventTypeId, id: link.id }),
    ).rejects.toMatchObject({ error: 'insufficient_scope' })
    expect(
      (
        await module.revokeManagedOneTimeBookingLink(ctx, {
          eventTypeId: s.eventTypeId,
          id: link.id,
        })
      )?.state,
    ).toBe('revoked')
  }
  it('permits metadata reads only to full/read keys and rechecks persisted keys', async () => {
    const s = await setup()
    const link = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    for (const scope of ['full', 'read'] as const) {
      const ctx = await keyContext(s, scope)
      safeMetadata(
        await Links.getOneTimeBookingLink(ctx, { eventTypeId: s.eventTypeId, id: link.id }),
        link.token,
      )
      if (scope === 'read')
        await expect(
          Links.revokeManagedOneTimeBookingLink(ctx, { eventTypeId: s.eventTypeId, id: link.id }),
        ).rejects.toMatchObject({ error: 'insufficient_scope' })
      if (ctx.principal.kind === 'api_key') {
        await db
          .updateTable('auth.apikey')
          .set({ enabled: false })
          .where('id', '=', ctx.principal.apiKeyId)
          .execute()
        await expect(
          Links.listOneTimeBookingLinks(ctx, { eventTypeId: s.eventTypeId }),
        ).rejects.toMatchObject({ name: 'InvalidApiKeyError' })
      }
    }
    await verifyScope()
  })
  async function verifyWriteScope(module = Links) {
    const s = await setup()
    for (const scope of ['full', 'bookings'] as const) {
      const ctx = await keyContext(s, scope)
      const link = await module.createOneTimeBookingLink(ctx, { eventTypeId: s.eventTypeId })
      expect(
        (
          await module.revokeManagedOneTimeBookingLink(ctx, {
            eventTypeId: s.eventTypeId,
            id: link.id,
          })
        )?.state,
      ).toBe('revoked')
    }
    const read = await keyContext(s, 'read')
    await expect(
      module.createOneTimeBookingLink(read, { eventTypeId: s.eventTypeId }),
    ).rejects.toMatchObject({ error: 'insufficient_scope' })
    await expect(
      module.revokeManagedOneTimeBookingLink(read, {
        eventTypeId: s.eventTypeId,
        id: randomUUID(),
      }),
    ).rejects.toMatchObject({ error: 'insufficient_scope' })
  }
  it('allows full/bookings writes while denying read keys on create and revoke', async () => {
    await verifyWriteScope()
  })
  async function verifyReadKeyStatus(module = Links) {
    const s = await setup()
    const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    const ctx = await keyContext(s, 'full')
    if (ctx.principal.kind !== 'api_key') throw new Error('Expected an API key principal')
    await db
      .updateTable('auth.apikey')
      .set({ enabled: false })
      .where('id', '=', ctx.principal.apiKeyId)
      .execute()
    await expect(
      module.listOneTimeBookingLinks(ctx, { eventTypeId: s.eventTypeId }),
    ).rejects.toMatchObject({ name: 'InvalidApiKeyError' })
    await expect(
      module.getOneTimeBookingLink(ctx, { eventTypeId: s.eventTypeId, id: link.id }),
    ).rejects.toMatchObject({ name: 'InvalidApiKeyError' })
    await expect(
      module.revokeManagedOneTimeBookingLink(ctx, { eventTypeId: s.eventTypeId, id: link.id }),
    ).rejects.toMatchObject({ name: 'InvalidApiKeyError' })
  }
  it('rechecks revoked credentials on list, detail and managed revoke', async () => {
    await verifyReadKeyStatus()
  })
  async function verifyProjection(module = Links) {
    const s = await setup()
    const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    safeMetadata(
      await module.listOneTimeBookingLinks(s.ctx, { eventTypeId: s.eventTypeId }),
      link.token,
    )
    safeMetadata(
      await module.getOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId, id: link.id }),
      link.token,
    )
    safeMetadata(
      await module.revokeManagedOneTimeBookingLink(s.ctx, {
        eventTypeId: s.eventTypeId,
        id: link.id,
      }),
      link.token,
    )
  }
  it('returns only safe metadata on list/get/revoke', async () => {
    await verifyProjection()
  })
  async function verifyNoLogs(module = Links) {
    const calls: unknown[][] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        calls.push(args)
      }),
    )
    try {
      const s = await setup()
      const input = { eventTypeId: s.eventTypeId, idempotencyKey: randomUUID() }
      const link = await module.createOneTimeBookingLink(s.ctx, input)
      await module.listOneTimeBookingLinks(s.ctx, { eventTypeId: s.eventTypeId })
      await module.getOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId, id: link.id })
      await module.revokeManagedOneTimeBookingLink(s.ctx, {
        eventTypeId: s.eventTypeId,
        id: link.id,
      })
      const error = await module.createOneTimeBookingLink(s.ctx, input).catch((error: unknown) => {
        expect(error).toMatchObject({ code: 'one_time_link_already_created' })
        return error
      })
      const serializedLogs = JSON.stringify(calls)
      const hash = createHash('sha256').update(link.token).digest('hex')
      expect(serializedLogs.includes(link.token)).toBe(false)
      expect(serializedLogs.includes(hash)).toBe(false)
      expect(String(error).includes(link.token)).toBe(false)
      expect(String(error).includes(hash)).toBe(false)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  }
  it('keeps issued capabilities and their hashes out of captured logs and retry errors', async () => {
    await verifyNoLogs()
  })
  async function verifyEventFilter(module = Links) {
    const s = await setup()
    const other = await fixtures.eventType(s.ctx.principal.organization.id, s.user.id)
    const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: other })
    expect(
      (await module.listOneTimeBookingLinks(s.ctx, { eventTypeId: s.eventTypeId })).data,
    ).toHaveLength(0)
    await expect(
      module.getOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId, id: link.id }),
    ).rejects.toMatchObject({ code: 'one_time_link_not_found' })
    expect(
      await module.revokeManagedOneTimeBookingLink(s.ctx, {
        eventTypeId: s.eventTypeId,
        id: link.id,
      }),
    ).toBeNull()
  }
  it('binds every read and revocation to the requested event and current organization', async () => {
    await verifyEventFilter()
    const s = await setup()
    const foreign = await setup()
    const link = await Links.createOneTimeBookingLink(foreign.ctx, {
      eventTypeId: foreign.eventTypeId,
    })
    await expect(
      Links.getOneTimeBookingLink(s.ctx, { eventTypeId: foreign.eventTypeId, id: link.id }),
    ).rejects.toMatchObject({ code: 'event_type_not_found' })
    expect(
      await Links.revokeManagedOneTimeBookingLink(s.ctx, {
        eventTypeId: s.eventTypeId,
        id: link.id,
      }),
    ).toBeNull()
  })
  it('paginates deterministically with bounded pages and validates cursors', async () => {
    const s = await setup()
    for (let i = 0; i < 3; i++)
      await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    const first = await Links.listOneTimeBookingLinks(s.ctx, {
      eventTypeId: s.eventTypeId,
      limit: 2,
    })
    const second = await Links.listOneTimeBookingLinks(s.ctx, {
      eventTypeId: s.eventTypeId,
      limit: 2,
      after: first.nextAfter as string,
    })
    expect(first.data).toHaveLength(2)
    expect(second.data).toHaveLength(1)
    expect(second.nextAfter).toBeNull()
    expect(new Set([...first.data, ...second.data].map((link) => link.id)).size).toBe(3)
    await expect(
      Links.listOneTimeBookingLinks(s.ctx, { eventTypeId: s.eventTypeId, limit: 101 }),
    ).rejects.toMatchObject({ code: 'invalid_limit' })
    await expect(
      Links.listOneTimeBookingLinks(s.ctx, { eventTypeId: s.eventTypeId, after: 'bad' }),
    ).rejects.toMatchObject({ code: 'invalid_cursor' })
  })
  async function verifyExpiry(module = Links) {
    const s = await setup()
    const row = await db
      .insertInto('one_time_booking_links')
      .values({
        organization_id: s.ctx.principal.organization.id,
        event_type_id: s.eventTypeId,
        creator_user_id: s.user.id,
        token_hash: createHash('sha256').update(randomBytes(32)).digest('hex'),
        expires_at: sql<Date>`clock_timestamp()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const get = await module.getOneTimeBookingLink(s.ctx, {
      eventTypeId: s.eventTypeId,
      id: row.id,
    })
    expect(get.state).toBe('expired')
    const revoked = await module.revokeManagedOneTimeBookingLink(s.ctx, {
      eventTypeId: s.eventTypeId,
      id: row.id,
    })
    expect(revoked?.state).toBe('expired')
    expect(revoked?.revokedAt).toBeNull()
  }
  it('derives expiry at the database boundary and respects repeated DST wall-clock instants', async () => {
    await verifyExpiry()
    const s = await setup()
    const before = await Links.createOneTimeBookingLink(s.ctx, {
      eventTypeId: s.eventTypeId,
      expiresAt: '2090-11-05T01:30:00-04:00',
    })
    const after = await Links.createOneTimeBookingLink(s.ctx, {
      eventTypeId: s.eventTypeId,
      expiresAt: '2090-11-05T01:30:00-05:00',
    })
    expect(Date.parse(after.expiresAt as string) - Date.parse(before.expiresAt as string)).toBe(
      3_600_000,
    )
    const beforeSpring = Temporal.ZonedDateTime.from('2090-03-12T01:30[America/New_York]')
    const afterSpring = beforeSpring.add({ hours: 1 })
    expect(afterSpring.hour).toBe(3)
    const springLink = await Links.createOneTimeBookingLink(s.ctx, {
      eventTypeId: s.eventTypeId,
      expiresAt: afterSpring.toInstant().toString(),
    })
    expect(
      Date.parse(springLink.expiresAt as string) - Number(beforeSpring.epochMilliseconds),
    ).toBe(3_600_000)
  })
  async function verifyTeamOwnership(module = Links) {
    const owner = await createTestUser(db)
    const creator = await createTestUser(db)
    const outsider = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: creator, role: 'admin' },
      { user: outsider, role: 'member' },
    ])
    const eventTypeId = await fixtures.eventType(team.id, null)
    const ctx = (user: typeof owner) => testContext(db, session(team.as(user)))
    const link = await module.createOneTimeBookingLink(ctx(creator), { eventTypeId })
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', creator.id)
      .execute()
    await expect(
      module.listOneTimeBookingLinks(ctx(creator), { eventTypeId }),
    ).rejects.toMatchObject({ code: 'insufficient_role' })
    await expect(
      module.listOneTimeBookingLinks(ctx(outsider), { eventTypeId }),
    ).rejects.toMatchObject({ code: 'insufficient_role' })
    await db.deleteFrom('auth.user').where('id', '=', creator.id).execute()
    expect(
      (await module.listOneTimeBookingLinks(ctx(owner), { eventTypeId })).data[0]?.creatorUserId,
    ).toBe(creator.id)
    const first = await module.revokeManagedOneTimeBookingLink(ctx(owner), {
      eventTypeId,
      id: link.id,
    })
    expect(first?.state).toBe('revoked')
    expect(
      await module.revokeManagedOneTimeBookingLink(ctx(owner), { eventTypeId, id: link.id }),
    ).toEqual(first)
    await expect(module.resolveOneTimeBookingLink({ db }, link.token)).rejects.toMatchObject({
      code: 'one_time_link_not_found',
    })
  }
  it('retains team-owned links when their creating admin leaves or is deleted', async () => {
    await verifyTeamOwnership()
  })
  async function verifyUsed(module = Links) {
    const s = await setup()
    let updates = 0
    s.ctx.db = db.withPlugin({
      transformQuery(args) {
        if (args.node.kind === 'UpdateQueryNode') updates++
        return args.node
      },
      async transformResult(args) {
        return args.result
      },
    })
    const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    let bookingId: string | undefined
    const used = await db.transaction().execute(async (trx) => {
      const booking = await trx
        .insertInto('bookings')
        .values({
          organization_id: s.ctx.principal.organization.id,
          event_type_id: s.eventTypeId,
          start_at: '2090-01-01T10:00Z',
          end_at: '2090-01-01T10:30Z',
          title: 'Consumed',
          source: 'web',
          manage_token_hash: randomBytes(32),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      bookingId = booking.id
      return module.claimOneTimeBookingLink(trx, link.token, booking.id)
    })
    expect(used.bookingId).toBe(bookingId)
    expect(used.usedAt === null).toBe(false)
    const detail = await module.getOneTimeBookingLink(s.ctx, {
      eventTypeId: s.eventTypeId,
      id: link.id,
    })
    const page = await module.listOneTimeBookingLinks(s.ctx, { eventTypeId: s.eventTypeId })
    for (const metadata of [detail, page.data[0]]) {
      expect(metadata).toMatchObject({ state: 'used', bookingId, usedAt: used.usedAt })
      safeMetadata(metadata, link.token)
    }
    updates = 0
    const revoked = await module.revokeManagedOneTimeBookingLink(s.ctx, {
      eventTypeId: s.eventTypeId,
      id: link.id,
    })
    expect(revoked?.state).toBe('used')
    expect(revoked?.bookingId).toBe(used.bookingId)
    expect(revoked?.usedAt).toBe(used.usedAt)
    expect(revoked?.revokedAt).toBeNull()
    expect(updates).toBe(0)
  }
  it('reports used state and booking evidence without attempting to revoke it', async () => {
    await verifyUsed()
  })
  async function mutation(
    replacement: readonly [string, string],
    assertion: (module: LinkModule) => Promise<unknown>,
  ) {
    const module = await sourceCopy(replacement)
    let failure: unknown
    try {
      await assertion(module)
    } catch (error) {
      failure = error
    }
    expect(
      failure instanceof Error && failure.name === 'AssertionError',
      'mutation must fail a real assertion',
    ).toBe(true)
  }
  it('mutation: durable retry marker', async () => {
    await mutation(
      ['const id = idempotentLinkId(ctx, input.idempotencyKey)', 'const id = undefined'],
      verifyRetry,
    )
  })
  it('mutation: credential-bound retry marker', async () => {
    await mutation(['        credential,\n        key,', '        key,'], verifyCredentialBinding)
  })
  it('mutation: read key scope', async () => {
    await mutation(
      [
        "if (ctx.principal.kind === 'api_key' && ctx.principal.apiKeyScope === 'bookings')",
        'if (false)',
      ],
      verifyScope,
    )
  })
  it('mutation: booking-write key scope', async () => {
    await mutation(
      [
        "if (ctx.principal.kind === 'api_key' && ctx.principal.apiKeyScope === 'read')",
        'if (false)',
      ],
      verifyWriteScope,
    )
  })
  it('mutation: persisted credential checks on metadata and revocation', async () => {
    await mutation(
      [
        "if (ctx.principal.kind === 'api_key') await requireActiveApiKey(db, ctx.principal, Date.now)",
        '',
      ],
      verifyReadKeyStatus,
    )
  })
  it('mutation: capability logging', async () => {
    await mutation(
      [
        'return { ...toLink(row, false), token }',
        'console.error(token)\n    return { ...toLink(row, false), token }',
      ],
      verifyNoLogs,
    )
  })
  it('mutation: team ownership survives creator departure', async () => {
    await mutation(
      [
        ".where('event_type_id', '=', eventTypeId)\n    .where('organization_id', '=', ctx.principal.organization.id)",
        ".where('event_type_id', '=', eventTypeId)\n    .where('organization_id', '=', ctx.principal.organization.id)\n    .where('creator_user_id', '=', ctx.principal.user.id)",
      ],
      verifyTeamOwnership,
    )
  })
  it('mutation: managed revocation changes active state', async () => {
    await mutation(
      [
        ".set({ revoked_at: sql<Date>`clock_timestamp()`, state: 'revoked' })",
        '.set({ updated_at: sql<Date>`clock_timestamp()` })',
      ],
      verifyTeamOwnership,
    )
  })
  it('mutation: current event management authority on metadata reads', async () => {
    await mutation(['await authorizedEvent(db, ctx, eventTypeId)', 'void 0'], async (module) => {
      const owner = await createTestUser(db)
      const member = await createTestUser(db)
      const team = await createTestTeam(db, [
        { user: owner, role: 'owner' },
        { user: member, role: 'member' },
      ])
      const eventTypeId = await fixtures.eventType(team.id, null)
      const ctx = testContext(db, session(team.as(member)))
      await expect(module.listOneTimeBookingLinks(ctx, { eventTypeId })).rejects.toMatchObject({
        code: 'insufficient_role',
      })
    })
  })
  it('mutation: duplicate create payload binding', async () => {
    await mutation(['if (!same)', 'if (false)'], async (module) => {
      const s = await setup()
      const input = { eventTypeId: s.eventTypeId, idempotencyKey: randomUUID() }
      await module.createOneTimeBookingLink(s.ctx, input)
      await expect(
        module.createOneTimeBookingLink(s.ctx, { ...input, prefill: { name: 'Changed' } }),
      ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    })
  })
  it('mutation: metadata whitelist', async () => {
    await mutation(
      [
        'id: row.id,\n    organizationId: row.organization_id,',
        "tokenHash: 'unsafe digest',\n    id: row.id,\n    organizationId: row.organization_id,",
      ],
      verifyProjection,
    )
  })
  it('mutation: requested event filter', async () => {
    await mutation(
      [
        ".where('event_type_id', '=', eventTypeId)\n    .where('organization_id'",
        ".where('organization_id'",
      ],
      verifyEventFilter,
    )
  })
  it('mutation: wall-time expired state', async () => {
    await mutation(
      [
        "state: row.state === 'active' && expired ? 'expired'",
        "state: row.state === 'active' && false ? 'expired'",
      ],
      verifyExpiry,
    )
  })
  it('mutation: terminal revocation guard', async () => {
    await mutation(["if (row.state === 'active' && !row.expired)", 'if (true)'], verifyUsed)
  })
  it('mutation: consuming booking reference in administrative metadata', async () => {
    await mutation(['bookingId: row.booking_id,', 'bookingId: null,'], verifyUsed)
  })
})
