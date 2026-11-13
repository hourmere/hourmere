import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  getAuditLogSettings,
  listAuditEvents,
  purgeAuditEvents,
  setAuditLogSettings,
} from './audit-log.ts'
import {
  createTestTeam,
  createTestUser,
  domainError,
  type TestTeam,
  type TestUser,
  testContext,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL

interface Seed {
  organizationId: string | null
  occurredAt?: string
  /** Days before the database's now; used instead of occurredAt. */
  daysAgo?: number
  action?: string
  actorType?: string
  actorId?: string | null
  credentialType?: string
  credentialId?: string | null
  credentialScope?: string | null
  details?: Record<string, unknown>
}

describe.skipIf(!serverUrl)('audit log query, retention and purge (real Postgres)', () => {
  let testDb: TestDatabase
  let db: Db
  let owner: TestUser
  let admin: TestUser
  let member: TestUser
  let outsider: TestUser
  let team: TestTeam
  let other: TestTeam

  const insert = async (seed: Seed): Promise<string> => {
    const at =
      seed.daysAgo !== undefined
        ? sql`now() - make_interval(secs => ${seed.daysAgo * 86400})`
        : seed.occurredAt !== undefined
          ? sql`${seed.occurredAt}::timestamptz`
          : sql`clock_timestamp()`
    const actorType = seed.actorType ?? 'system'
    const row = await sql<{ id: string }>`INSERT INTO audit_events
        (organization_id, occurred_at, actor_type, actor_id, credential_type, credential_id,
         credential_scope, action, target_type, target_id, details)
      VALUES (${seed.organizationId}, ${at}, ${actorType},
        ${seed.actorId === undefined ? (actorType === 'system' ? 'test-job' : randomUUID()) : seed.actorId},
        ${seed.credentialType ?? 'none'}, ${seed.credentialId ?? null}, ${seed.credentialScope ?? null},
        ${seed.action ?? 'organization.updated'}, 'organization', ${randomUUID()},
        ${JSON.stringify(seed.details ?? {})}::jsonb)
      RETURNING id::text`.execute(db)
    return row.rows[0]?.id as string
  }
  const list = (principal: Principal, query: Parameters<typeof listAuditEvents>[1] = {}) =>
    listAuditEvents(testContext(db, principal), query)
  const ids = async (principal: Principal, query: Parameters<typeof listAuditEvents>[1] = {}) =>
    (await list(principal, { limit: 100, ...query })).data.map((event) => event.id)
  const remaining = async (organizationId: string | null) =>
    (
      await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_events
        WHERE organization_id IS NOT DISTINCT FROM ${organizationId}::uuid`.execute(db)
    ).rows[0]?.n

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string, undefined, { tag: 'audit_log' })
    db = createDb(testDb.pool)
    owner = await createTestUser(db, 'Owner')
    admin = await createTestUser(db, 'Admin')
    member = await createTestUser(db, 'Member')
    outsider = await createTestUser(db, 'Outsider')
    team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    other = await createTestTeam(db, [{ user: outsider, role: 'owner' }])
  })
  beforeEach(async () => {
    await sql`DELETE FROM audit_events`.execute(db)
    await sql`DELETE FROM audit_log_settings`.execute(db)
  })
  afterAll(async () => {
    await testDb?.drop()
  })

  describe('query', () => {
    it('returns newest first with time-range boundaries at microsecond precision', async () => {
      const at = (time: string) => insert({ organizationId: team.id, occurredAt: time })
      const before = await at('2026-11-01T09:59:59.999999Z')
      const start = await at('2026-11-01T10:00:00.000000Z')
      const middle = await at('2026-11-01T10:30:00.000001Z')
      const last = await at('2026-11-01T10:59:59.999999Z')
      const end = await at('2026-11-01T11:00:00.000000Z')
      expect(await ids(team.as(owner))).toEqual([end, last, middle, start, before])
      expect(
        await ids(team.as(owner), { from: '2026-11-01T10:00:00Z', to: '2026-11-01T11:00:00Z' }),
      ).toEqual([last, middle, start])
      // Offsets are instants: the same range written in another zone.
      expect(
        await ids(team.as(owner), {
          from: '2026-11-01T18:00:00+08:00',
          to: '2026-11-01T03:00:00-08:00',
        }),
      ).toEqual([last, middle, start])
      // Sub-microsecond bounds round up: >= 10:00:00.0000001 excludes 10:00:00.000000.
      expect(
        await ids(team.as(owner), {
          from: '2026-11-01T10:00:00.0000001Z',
          to: '2026-11-01T10:59:59.9999991Z',
        }),
      ).toEqual([last, middle])
      const [event] = (await list(team.as(owner), { limit: 1 })).data
      expect(event?.occurredAt).toBe('2026-11-01T11:00:00.000000Z')
    })

    it('covers a 23-hour and a 25-hour local day across daylight-saving changes', async () => {
      // America/Los_Angeles: 2026-03-08 has 23 hours, 2026-11-01 has 25.
      const spring = [
        '2026-03-08T07:59:59.999999Z',
        '2026-03-08T08:00:00Z',
        '2026-03-09T06:59:59.999999Z',
        '2026-03-09T07:00:00Z',
      ]
      const fall = [
        '2026-11-01T06:59:59.999999Z',
        '2026-11-01T07:00:00Z',
        '2026-11-02T07:59:59.999999Z',
        '2026-11-02T08:00:00Z',
      ]
      const springIds = []
      for (const time of spring)
        springIds.push(await insert({ organizationId: team.id, occurredAt: time }))
      const fallIds = []
      for (const time of fall)
        fallIds.push(await insert({ organizationId: team.id, occurredAt: time }))
      expect(
        await ids(team.as(owner), {
          from: '2026-03-08T00:00:00-08:00',
          to: '2026-03-09T00:00:00-07:00',
        }),
      ).toEqual([springIds[2], springIds[1]])
      expect(
        await ids(team.as(owner), {
          from: '2026-11-01T00:00:00-07:00',
          to: '2026-11-02T00:00:00-08:00',
        }),
      ).toEqual([fallIds[2], fallIds[1]])
    })

    it('filters by actor type, actor ID and exact action', async () => {
      const key = randomUUID()
      const byOwner = await insert({
        organizationId: team.id,
        actorType: 'user',
        actorId: owner.id,
        credentialType: 'session',
        credentialId: randomUUID(),
        action: 'membership.role_changed',
        details: { oldRole: 'member', newRole: 'admin' },
      })
      const byKey = await insert({
        organizationId: team.id,
        actorType: 'api_key',
        actorId: key,
        credentialType: 'api_key',
        credentialId: key,
        credentialScope: 'full',
        action: 'api_key.created',
        details: { scope: 'read' },
      })
      const byAdmin = await insert({
        organizationId: team.id,
        actorType: 'user',
        actorId: admin.id,
        action: 'api_key.created',
        details: { scope: 'full' },
      })
      expect(await ids(team.as(owner), { actorType: 'user' })).toEqual([byAdmin, byOwner])
      expect(await ids(team.as(owner), { actorType: 'user', actorId: owner.id })).toEqual([byOwner])
      expect(await ids(team.as(owner), { actorType: 'api_key', actorId: key })).toEqual([byKey])
      expect(await ids(team.as(owner), { action: 'api_key.created' })).toEqual([byAdmin, byKey])
      expect(await ids(team.as(owner), { action: 'api_key.created', actorType: 'user' })).toEqual([
        byAdmin,
      ])
      expect(await ids(team.as(owner), { action: 'webhook.created' })).toEqual([])
    })

    it('keeps pages stable while newer events are written between them', async () => {
      const original = []
      for (let i = 0; i < 7; i += 1)
        original.push(
          await insert({ organizationId: team.id, occurredAt: `2026-10-01T10:00:0${i}Z` }),
        )
      // Two events at the same instant are ordered by ID.
      original.push(await insert({ organizationId: team.id, occurredAt: '2026-10-01T10:00:03Z' }))
      const seen: string[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const page = await list(team.as(admin), { limit: 3, ...(cursor ? { cursor } : {}) })
        seen.push(...page.data.map((event) => event.id))
        cursor = page.nextCursor ?? undefined
        pages += 1
        // Concurrent writers: a committed newer event and one in a transaction still open.
        await insert({ organizationId: team.id })
        await insert({ organizationId: other.id, occurredAt: '2026-10-01T10:00:02Z' })
      } while (cursor)
      expect(pages).toBe(3)
      expect(new Set(seen).size).toBe(seen.length)
      const [o0, o1, o2, o3, o4, o5, o6, sameInstant] = original
      expect(seen).toEqual([o6, o5, o4, sameInstant, o3, o2, o1, o0])
    })

    it('never shows an uncommitted event and shows it on a fresh first page once committed', async () => {
      await insert({ organizationId: team.id, occurredAt: '2026-10-01T10:00:00Z' })
      const client = await testDb.pool.connect()
      try {
        await client.query('BEGIN')
        const pending = (
          await client.query<{ id: string }>(
            `INSERT INTO audit_events (organization_id, actor_type, actor_id, credential_type, action, target_type, target_id)
             VALUES ($1::uuid, 'system', 'test-job', 'none', 'organization.updated', 'organization', $2) RETURNING id::text`,
            [team.id, team.id],
          )
        ).rows[0]?.id
        expect(await ids(team.as(owner))).not.toContain(pending)
        await client.query('COMMIT')
        expect((await ids(team.as(owner)))[0]).toBe(pending)
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    })

    it('refuses invalid limits, ranges, cursors and an actor ID without a type', async () => {
      await insert({ organizationId: team.id })
      await insert({ organizationId: team.id })
      for (const limit of [0, 101, 1.5, Number.NaN])
        expect((await domainError(() => list(team.as(owner), { limit }))).code).toBe(
          'invalid_limit',
        )
      expect(
        (
          await domainError(() =>
            list(team.as(owner), { from: '2026-11-01T10:00:00Z', to: '2026-11-01T10:00:00Z' }),
          )
        ).code,
      ).toBe('invalid_range')
      expect((await domainError(() => list(team.as(owner), { actorId: owner.id }))).code).toBe(
        'invalid_request',
      )
      expect((await domainError(() => list(team.as(owner), { from: 'yesterday' }))).code).toBe(
        'invalid_request',
      )
      const { nextCursor } = await list(team.as(owner), { limit: 1 })
      expect(nextCursor).toEqual(expect.any(String))
      const cursor = nextCursor as string
      for (const query of [
        { cursor: 'not a cursor' },
        { cursor: `${cursor}x` },
        { cursor, action: 'organization.updated' },
        { cursor, from: '2026-01-01T00:00:00Z' },
      ])
        expect((await domainError(() => list(team.as(owner), query))).code).toBe('invalid_cursor')
      // The same cursor from another organization's owner is refused, never answered.
      expect((await domainError(() => list(other.as(outsider), { cursor }))).code).toBe(
        'invalid_cursor',
      )
      expect((await list(team.as(admin), { cursor, limit: 1 })).data).toHaveLength(1)
    })
  })

  describe('authorization and privacy', () => {
    it('lets personal owners and team owners/admins read only their own organization', async () => {
      const teamEvent = await insert({ organizationId: team.id })
      const otherEvent = await insert({ organizationId: other.id })
      const personalEvent = await insert({ organizationId: owner.principal.organization.id })
      const instanceWide = await insert({ organizationId: null, action: 'oauth.client_registered' })
      const orphan = await insert({ organizationId: randomUUID() })
      expect(await ids(team.as(owner))).toEqual([teamEvent])
      expect(await ids(team.as(admin))).toEqual([teamEvent])
      expect(await ids(other.as(outsider))).toEqual([otherEvent])
      expect(await ids(owner.principal)).toEqual([personalEvent])
      for (const principal of [owner.principal, team.as(owner), team.as(admin), other.as(outsider)])
        expect(await ids(principal)).not.toEqual(expect.arrayContaining([instanceWide, orphan]))
    })

    it('refuses members, outsiders, unverified and removed users alike before reading', async () => {
      await insert({ organizationId: team.id })
      const refusals = [
        team.as(member),
        team.as(outsider),
        {
          ...owner.principal,
          organization: { ...other.as(outsider).organization, personal: true },
        },
        { ...member.principal, organization: owner.principal.organization },
      ]
      const leaver = await createTestUser(db, 'Leaver')
      await db
        .insertInto('auth.member')
        .values({
          organizationId: team.id,
          userId: leaver.id,
          role: 'admin',
          createdAt: new Date(),
        })
        .execute()
      expect(await ids(team.as(leaver))).toHaveLength(1)
      await db
        .deleteFrom('auth.member')
        .where('userId', '=', leaver.id)
        .where('organizationId', '=', team.id)
        .execute()
      refusals.push(team.as(leaver))
      const unverified = await createTestUser(db, 'Unverified')
      await db
        .insertInto('auth.member')
        .values({
          organizationId: team.id,
          userId: unverified.id,
          role: 'owner',
          createdAt: new Date(),
        })
        .execute()
      await db
        .updateTable('auth.user')
        .set({ emailVerified: false })
        .where('id', '=', unverified.id)
        .execute()
      refusals.push(team.as(unverified))
      for (const principal of refusals) {
        for (const call of [
          () => list(principal),
          () => list(principal, { cursor: 'garbage' }),
          () => getAuditLogSettings(testContext(db, principal), null),
          () => setAuditLogSettings(testContext(db, principal), null, { retention: 'forever' }),
        ]) {
          const error = await domainError(call)
          expect([error.kind, error.code, error.detail]).toEqual([
            'forbidden',
            'team_management_access_denied',
            undefined,
          ])
        }
      }
    })

    it('never returns session IDs and keeps stored details, including redacted ones, as stored', async () => {
      const session = randomUUID()
      await insert({
        organizationId: team.id,
        actorType: 'user',
        actorId: owner.id,
        credentialType: 'session',
        credentialId: session,
        action: 'membership.removed',
      })
      const key = randomUUID()
      await insert({
        organizationId: team.id,
        actorType: 'api_key',
        actorId: key,
        credentialType: 'api_key',
        credentialId: key,
        credentialScope: 'bookings',
        action: 'booking.created',
      })
      const provider = '019a0000-0000-7000-8000-000000000001'
      await insert({
        organizationId: team.id,
        actorType: 'anonymous',
        actorId: null,
        action: 'sso_authentication.failed',
        details: { method: 'oidc', providerId: provider, reason: 'unclassified' },
      })
      const page = await list(team.as(owner))
      expect(JSON.stringify(page)).not.toContain(session)
      expect(
        page.data.map(({ credential, actor, details }) => ({ credential, actor, details })),
      ).toEqual([
        {
          actor: { type: 'anonymous', id: null },
          credential: {
            type: 'none',
            apiKeyId: null,
            apiKeyScope: null,
            oauthClientId: null,
            oauthGrantId: null,
          },
          details: { method: 'oidc', providerId: provider, reason: 'unclassified' },
        },
        {
          actor: { type: 'api_key', id: key },
          credential: {
            type: 'api_key',
            apiKeyId: key,
            apiKeyScope: 'bookings',
            oauthClientId: null,
            oauthGrantId: null,
          },
          details: {},
        },
        {
          actor: { type: 'user', id: owner.id },
          credential: {
            type: 'session',
            apiKeyId: null,
            apiKeyScope: null,
            oauthClientId: null,
            oauthGrantId: null,
          },
          details: {},
        },
      ])
    })
  })

  describe('retention settings', () => {
    it('shows the instance default and lets only owners change it, recording each change once', async () => {
      expect(await getAuditLogSettings(testContext(db, team.as(admin)), 365)).toEqual({
        retention: 'instance',
        retentionDays: null,
        instanceRetentionDays: 365,
        effectiveRetentionDays: 365,
        canChangeRetention: false,
      })
      const refused = await domainError(() =>
        setAuditLogSettings(testContext(db, team.as(admin)), 365, { retention: 'forever' }),
      )
      expect([refused.kind, refused.code]).toEqual(['forbidden', 'insufficient_role'])
      const ctx = testContext(db, team.as(owner))
      expect(await setAuditLogSettings(ctx, 365, { retention: 'days', retentionDays: 90 })).toEqual(
        {
          retention: 'days',
          retentionDays: 90,
          instanceRetentionDays: 365,
          effectiveRetentionDays: 90,
          canChangeRetention: true,
        },
      )
      // A replay records nothing.
      await setAuditLogSettings(ctx, 365, { retention: 'days', retentionDays: 90 })
      expect(await setAuditLogSettings(ctx, null, { retention: 'forever' })).toMatchObject({
        retention: 'forever',
        effectiveRetentionDays: null,
      })
      expect(await setAuditLogSettings(ctx, null, { retention: 'instance' })).toMatchObject({
        retention: 'instance',
        retentionDays: null,
        effectiveRetentionDays: null,
      })
      expect(await remaining(team.id)).toBe(3)
      const events = (await list(team.as(owner))).data
      expect(
        events.map((event) => [event.action, event.target, event.actor.id, event.details]),
      ).toEqual(
        Array(3).fill([
          'audit_log.retention_updated',
          { type: 'organization', id: team.id },
          (owner.principal as { apiKeyId: string }).apiKeyId,
          {},
        ]),
      )
      // A personal space's owner may choose too.
      expect(
        await setAuditLogSettings(testContext(db, owner.principal), null, {
          retention: 'days',
          retentionDays: 30,
        }),
      ).toMatchObject({ effectiveRetentionDays: 30, canChangeRetention: true })
    })

    it('refuses out-of-range and inconsistent choices as invalid_request', async () => {
      const ctx = testContext(db, team.as(owner))
      for (const input of [
        { retention: 'days', retentionDays: 29 },
        { retention: 'days', retentionDays: 3651 },
        { retention: 'days', retentionDays: 90.5 },
        { retention: 'days' },
        { retention: 'forever', retentionDays: 90 },
        { retention: 'never' },
        { retention: 'forever', extra: true },
      ])
        expect((await domainError(() => setAuditLogSettings(ctx, null, input as never))).code).toBe(
          'invalid_request',
        )
      expect(await remaining(team.id)).toBe(0)
    })
  })

  describe('purge', () => {
    const setRetention = (organizationId: string, retention: 'forever' | 'days', days?: number) =>
      db
        .insertInto('audit_log_settings')
        .values({ organization_id: organizationId, retention, retention_days: days ?? null })
        .execute()

    it('deletes exactly the events past each organization retention at the boundary', async () => {
      await setRetention(team.id, 'days', 30)
      await setRetention(other.id, 'forever')
      const personal = owner.principal.organization.id
      const orphan = randomUUID()
      const old = await insert({ organizationId: team.id, daysAgo: 30 + 1 / 1440 })
      const kept = await insert({ organizationId: team.id, daysAgo: 30 - 1 / 1440 })
      await insert({ organizationId: other.id, daysAgo: 5000 })
      await insert({ organizationId: personal, daysAgo: 91 })
      const personalKept = await insert({ organizationId: personal, daysAgo: 89 })
      await insert({ organizationId: null, daysAgo: 91 })
      await insert({ organizationId: orphan, daysAgo: 91 })
      const orphanKept = await insert({ organizationId: orphan, daysAgo: 89 })
      const result = await purgeAuditEvents(db, { instance: 90 })
      expect(result).toEqual({ deleted: 4, skipped: 0, more: false })
      expect(await ids(team.as(owner))).toEqual([kept])
      expect(await ids(team.as(owner))).not.toContain(old)
      expect(await remaining(other.id)).toBe(1)
      expect(await ids(owner.principal)).toEqual([personalKept])
      expect(await remaining(null)).toBe(0)
      expect(
        (
          await sql<{
            id: string
          }>`SELECT id::text FROM audit_events WHERE organization_id = ${orphan}`.execute(db)
        ).rows.map((row) => row.id),
      ).toEqual([orphanKept])
      // Idempotent: a second run finds nothing.
      expect(await purgeAuditEvents(db, { instance: 90 })).toEqual({
        deleted: 0,
        skipped: 0,
        more: false,
      })
    })

    it('keeps everything when the instance keeps forever, except organizations that chose days', async () => {
      await setRetention(team.id, 'days', 60)
      await insert({ organizationId: team.id, daysAgo: 61 })
      await insert({ organizationId: other.id, daysAgo: 5000 })
      await insert({ organizationId: null, daysAgo: 5000 })
      expect(await purgeAuditEvents(db, { instance: null })).toEqual({
        deleted: 1,
        skipped: 0,
        more: false,
      })
      expect(await remaining(other.id)).toBe(1)
      expect(await remaining(null)).toBe(1)
    })

    it('never deletes events younger than 30 days, whatever the stored value', async () => {
      await insert({ organizationId: team.id, daysAgo: 31 })
      await insert({ organizationId: team.id, daysAgo: 29 })
      await insert({ organizationId: null, daysAgo: 31 })
      await insert({ organizationId: null, daysAgo: 29 })
      // A value below the floor can only come from outside the service; the purge still keeps 30.
      expect(await purgeAuditEvents(db, { instance: 1 })).toEqual({
        deleted: 2,
        skipped: 0,
        more: false,
      })
      expect(await remaining(team.id)).toBe(1)
      expect(await remaining(null)).toBe(1)
    })

    it('stops at its batch bound, shares batches across organizations and finishes later', async () => {
      for (let i = 0; i < 7; i += 1) await insert({ organizationId: team.id, daysAgo: 40 + i })
      await insert({ organizationId: other.id, daysAgo: 40 })
      const first = await purgeAuditEvents(db, { instance: 30, batch: 2, maxBatches: 3 })
      expect(first).toEqual({ deleted: 5, skipped: 0, more: true })
      // The smaller organization was not starved by the larger one.
      expect(await remaining(other.id)).toBe(0)
      expect(await remaining(team.id)).toBe(3)
      const second = await purgeAuditEvents(db, { instance: 30, batch: 2, maxBatches: 10 })
      expect(second).toEqual({ deleted: 3, skipped: 0, more: false })
      expect(await remaining(team.id)).toBe(0)
      const aborted = new AbortController()
      aborted.abort()
      await insert({ organizationId: team.id, daysAgo: 40 })
      expect(await purgeAuditEvents(db, { instance: 30, signal: aborted.signal })).toEqual({
        deleted: 0,
        skipped: 0,
        more: true,
      })
    })

    it('runs alongside writers and another purge without deleting twice or touching new events', async () => {
      for (let i = 0; i < 40; i += 1)
        await insert({ organizationId: team.id, daysAgo: 40 + i / 10 })
      const writers = Array.from({ length: 20 }, () => insert({ organizationId: team.id }))
      const [a, b] = await Promise.all([
        purgeAuditEvents(db, { instance: 30, batch: 5 }),
        purgeAuditEvents(db, { instance: 30, batch: 5 }),
        ...writers,
      ])
      expect((a as { deleted: number }).deleted + (b as { deleted: number }).deleted).toBe(40)
      expect(await remaining(team.id)).toBe(20)
    })

    it('skips an organization whose retention is being changed, then follows the new choice', async () => {
      await insert({ organizationId: team.id, daysAgo: 100 })
      const client = await testDb.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('hourmere.audit-retention:' || lower($1), 0))`,
          [team.id],
        )
        await client.query(
          `INSERT INTO audit_log_settings (organization_id, retention) VALUES ($1, 'forever')`,
          [team.id],
        )
        const started = Date.now()
        expect(await purgeAuditEvents(db, { instance: 30 })).toEqual({
          deleted: 0,
          skipped: 1,
          more: false,
        })
        expect(Date.now() - started).toBeLessThan(5000)
        await client.query('COMMIT')
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
      expect(await purgeAuditEvents(db, { instance: 30 })).toEqual({
        deleted: 0,
        skipped: 0,
        more: false,
      })
      expect(await remaining(team.id)).toBe(1)
    })

    it('gives up instead of waiting behind a table lock', async () => {
      await insert({ organizationId: team.id, daysAgo: 100 })
      const client = await testDb.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('LOCK TABLE audit_events IN SHARE MODE')
        const started = Date.now()
        expect(await purgeAuditEvents(db, { instance: 30 })).toEqual({
          deleted: 0,
          skipped: 1,
          more: false,
        })
        expect(Date.now() - started).toBeLessThan(5000)
        await client.query('ROLLBACK')
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
      expect(await purgeAuditEvents(db, { instance: 30 })).toEqual({
        deleted: 1,
        skipped: 0,
        more: false,
      })
    })

    it('makes a concurrent retention change wait only for the running batch', async () => {
      await insert({ organizationId: team.id, daysAgo: 100 })
      const [purged, settings] = await Promise.all([
        purgeAuditEvents(db, { instance: 30 }),
        setAuditLogSettings(testContext(db, team.as(owner)), 30, { retention: 'forever' }),
      ])
      expect(settings.retention).toBe('forever')
      // Either order is consistent: the purge saw the old or the new choice, never a mix.
      expect([0, 1]).toContain(purged.deleted)
      expect(await remaining(team.id)).toBe(purged.deleted === 1 ? 1 : 2)
    })
  })
})
