// Source-copy mutation checks: each protection of the audit log service is broken in a copy of
// its source, and a real assertion against Postgres must then fail. Files are never changed.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type * as AuditLog from './audit-log.ts'
import { createTestTeam, createTestUser, type TestTeam, type TestUser } from './testing.ts'

type Module = typeof AuditLog
const serverUrl = process.env.DATABASE_URL

async function sourceCopy(path: URL, before?: string, after = ''): Promise<unknown> {
  const original = readFileSync(path, 'utf8')
  if (before !== undefined) expect(original.includes(before), `anchor: ${before}`).toBe(true)
  const source = stripTypeScriptTypes(
    before === undefined ? original : original.replace(before, after),
  ).replace(/from '([^']+)'/g, (_, specifier: string) => {
    if (specifier.startsWith('node:')) return `from '${specifier}'`
    const resolved = specifier.startsWith('.')
      ? new URL(specifier, path).href
      : pathToFileURL(createRequire(path).resolve(specifier)).href
    return `from '${resolved}'`
  })
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}
const service = (before?: string, after?: string) =>
  sourceCopy(new URL('./audit-log.ts', import.meta.url), before, after) as Promise<Module>

const code = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'accepted',
    (error: { code?: string }) => error.code ?? String(error),
  )

describe.skipIf(!serverUrl)('audit log protections under source-copy mutation', () => {
  let testDb: TestDatabase
  let db: Db
  let owner: TestUser
  let admin: TestUser
  let member: TestUser
  let team: TestTeam
  let other: TestTeam
  const ctx = (principal: Principal) => ({ db, principal, now: () => Temporal.Now.instant() })
  const insert = (organizationId: string, extra: { daysAgo?: number; session?: string } = {}) =>
    sql`INSERT INTO audit_events (organization_id, occurred_at, actor_type, actor_id,
        credential_type, credential_id, action, target_type, target_id)
      VALUES (${organizationId},
        ${extra.daysAgo === undefined ? sql`clock_timestamp()` : sql`now() - make_interval(days => ${extra.daysAgo})`},
        'user', ${owner.id}, ${extra.session ? 'session' : 'none'}, ${extra.session ?? null},
        'organization.updated', 'organization', ${organizationId})`.execute(db)
  const count = async () =>
    (await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_events`.execute(db)).rows[0]?.n

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string, undefined, { tag: 'audit_mut' })
    db = createDb(testDb.pool)
    owner = await createTestUser(db, 'Owner')
    admin = await createTestUser(db, 'Admin')
    member = await createTestUser(db, 'Member')
    const outsider = await createTestUser(db, 'Outsider')
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

  // Each check passes on the real source and must fail on its mutation.
  const checks: Record<string, (m: Module) => Promise<void>> = {
    async sessionHidden(m) {
      const session = randomUUID()
      await insert(team.id, { session })
      const page = await m.listAuditEvents(ctx(team.as(owner)), {})
      expect(JSON.stringify(page).includes(session)).toBe(false)
    },
    async sessionTargetHidden(m) {
      const session = randomUUID()
      await sql`INSERT INTO audit_events (organization_id, actor_type, actor_id,
        credential_type, action, target_type, target_id)
        VALUES (${team.id}, 'user', ${owner.id}, 'none', 'session.revoked', 'session', ${session})`.execute(
        db,
      )
      const page = await m.listAuditEvents(ctx(team.as(owner)), {})
      expect(page.data[0]?.target).toEqual({ type: 'session', id: null })
      expect(JSON.stringify(page)).not.toContain(session)
    },
    async boundedCursor(m) {
      const actorId = '审'.repeat(256)
      await insert(team.id)
      await insert(team.id)
      await sql`UPDATE audit_events SET actor_id = ${actorId}`.execute(db)
      const filters = { actorType: 'user' as const, actorId, limit: 1 }
      const first = await m.listAuditEvents(ctx(team.as(owner)), filters)
      expect(first.nextCursor?.length).toBeLessThanOrEqual(1024)
      const second = await m.listAuditEvents(ctx(team.as(owner)), {
        ...filters,
        cursor: first.nextCursor ?? '',
      })
      expect(second.data).toHaveLength(1)
      expect(second.data[0]?.id).not.toBe(first.data[0]?.id)
    },
    async memberRefused(m) {
      await insert(team.id)
      expect(await code(m.listAuditEvents(ctx(team.as(member)), {}))).toBe(
        'team_management_access_denied',
      )
    },
    async memberBeforeValidation(m) {
      expect(
        await code(
          m.setAuditLogSettings(ctx(team.as(member)), null, {
            retention: 'days',
            retentionDays: 1,
          }),
        ),
      ).toBe('team_management_access_denied')
    },
    async organizationScoped(m) {
      await insert(other.id)
      expect((await m.listAuditEvents(ctx(team.as(owner)), {})).data).toEqual([])
    },
    async cursorBound(m) {
      await insert(team.id)
      await insert(team.id)
      const { nextCursor } = await m.listAuditEvents(ctx(team.as(owner)), { limit: 1 })
      expect(
        await code(
          m.listAuditEvents(ctx(team.as(owner)), {
            cursor: nextCursor ?? '',
            action: 'api_key.created',
          }),
        ),
      ).toBe('invalid_cursor')
    },
    async pagesDisjoint(m) {
      for (let i = 0; i < 3; i += 1) await insert(team.id)
      const first = await m.listAuditEvents(ctx(team.as(owner)), { limit: 2 })
      const second = await m.listAuditEvents(ctx(team.as(owner)), {
        limit: 2,
        cursor: first.nextCursor ?? '',
      })
      const ids = [...first.data, ...second.data].map((event) => event.id)
      expect(new Set(ids).size).toBe(3)
      expect(ids).toHaveLength(3)
    },
    async ownerOnlyRetention(m) {
      expect(
        await code(m.setAuditLogSettings(ctx(team.as(admin)), null, { retention: 'forever' })),
      ).toBe('insufficient_role')
    },
    async thirtyDayFloor(m) {
      await insert(team.id, { daysAgo: 31 })
      await insert(team.id, { daysAgo: 29 })
      await m.purgeAuditEvents(db, { instance: 1 })
      expect(await count()).toBe(1)
    },
    async changeInProgressSkipped(m) {
      await insert(team.id, { daysAgo: 100 })
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
        await m.purgeAuditEvents(db, { instance: 30 })
        await client.query('COMMIT')
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
      expect(await count()).toBe(1)
    },
    async lockedRowsSkipped(m) {
      await insert(team.id, { daysAgo: 100 })
      await insert(team.id, { daysAgo: 101 })
      const client = await testDb.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT id FROM audit_events ORDER BY occurred_at LIMIT 1 FOR UPDATE')
        expect((await m.purgeAuditEvents(db, { instance: 30 })).deleted).toBe(1)
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    },
  }
  const mutations: [keyof typeof checks, string, string][] = [
    [
      'sessionHidden',
      'apiKeyId: apiKey ? row.credential_id : null,',
      'apiKeyId: row.credential_id,',
    ],
    [
      'memberRefused',
      "if (roles.includes('admin')) return 'admin'",
      "if (roles.length) return 'admin'",
    ],
    [
      'organizationScoped',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text of the protection
      'const conditions = [sql`organization_id = ${organizationId}`]',
      'const conditions = [sql`true`]',
    ],
    [
      'sessionTargetHidden',
      "row.target_type === 'session' ? null : row.target_id",
      'row.target_id',
    ],
    ['boundedCursor', "createHash('sha256').update(normalized).digest('base64url')", 'normalized'],
    [
      'memberBeforeValidation',
      '  const organizationId = ctx.principal.organization.id\n  return teamWriteTransaction(',
      '  valid(AuditLogSettingsUpdate, input)\n  const organizationId = ctx.principal.organization.id\n  return teamWriteTransaction(',
    ],
    ['cursorBound', 'if (cursor.k !== key) throw new Error()', ''],
    ['pagesDisjoint', 'sql`(occurred_at, id) < (', 'sql`(occurred_at, id) <= ('],
    ['ownerOnlyRetention', "if (role !== 'owner')", 'if (false)'],
    ['thirtyDayFloor', 'Math.max(days, AUDIT_RETENTION_MIN_DAYS)', 'days'],
    ['changeInProgressSkipped', "if (!locked.rows[0]?.locked) return 'skipped'", ''],
    ['lockedRowsSkipped', 'FOR UPDATE SKIP LOCKED', 'FOR UPDATE'],
  ]

  it('passes every check on the unmodified source copy', async () => {
    const original = await service()
    for (const [name, check] of Object.entries(checks)) {
      await sql`DELETE FROM audit_events`.execute(db)
      await sql`DELETE FROM audit_log_settings`.execute(db)
      await expect(check(original), name).resolves.toBeUndefined()
    }
  })

  it.each(mutations)('kills the %s mutation', async (name, before, after) => {
    const mutated = await service(before, after)
    await expect(checks[name]?.(mutated)).rejects.toThrow()
  })

  it('kills widening the audit read scope in a copy of the operation registry', async () => {
    const path = new URL('../../auth/src/api-key-operations.ts', import.meta.url)
    const allowed = async (copy: Promise<unknown>) =>
      (
        (await copy) as {
          apiKeyOperation: (id: string) => { allowedScopes: readonly string[] } | undefined
        }
      ).apiKeyOperation('GET /api/v1/audit-events')?.allowedScopes
    const fullOnly = (scopes: readonly string[] | undefined) => expect(scopes).toEqual(['full'])
    fullOnly(await allowed(sourceCopy(path)))
    const widened = await allowed(
      sourceCopy(
        path,
        "audit_read: Object.freeze(['full'] as const)",
        "audit_read: Object.freeze(['full', 'read'] as const)",
      ),
    )
    expect(() => fullOnly(widened)).toThrow()
  })
})
