import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { auditActor, writeAuditEvent } from '@hourmere/db/audit'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { isUuid } from './organizations.ts'
import * as service from './scim-tokens.ts'
import { checkTeamManagementAccess, TeamManagementError } from './team-management.ts'

const serverUrl = process.env.DATABASE_URL
function sourceCopy(replacement?: [string, string]): typeof service {
  let source = readFileSync(new URL('./scim-tokens.ts', import.meta.url), 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0])).toBe(true)
    source = source.replace(replacement[0], replacement[1])
  }
  source = stripTypeScriptTypes(source.replace(/^import .*\n/gm, '')).replace(/\bexport /g, '')
  return new Function(
    'createHash',
    'randomBytes',
    'sql',
    'isUuid',
    'checkTeamManagementAccess',
    'TeamManagementError',
    'auditActor',
    'writeAuditEvent',
    `${source}; return {createScimToken,listScimTokens,rotateScimToken,revokeScimToken,authenticateScimToken}`,
  )(
    createHash,
    randomBytes,
    sql,
    isUuid,
    checkTeamManagementAccess,
    TeamManagementError,
    auditActor,
    writeAuditEvent,
  )
}

describe.skipIf(!serverUrl)('SCIM provisioning tokens', () => {
  let database: TestDatabase
  let db: Db
  const actor = { userId: randomUUID(), organizationId: randomUUID(), sessionId: randomUUID() }
  const other = { ...actor, organizationId: randomUUID(), sessionId: randomUUID() }
  beforeAll(async () => {
    database = await createTestDatabase(serverUrl as string)
    db = createDb(database.pool)
    await db
      .insertInto('auth.user')
      .values({
        id: actor.userId,
        name: 'SCIM owner',
        email: 'scim-owner@example.test',
        emailVerified: true,
      })
      .execute()
    for (const entry of [actor, other]) {
      await db
        .insertInto('auth.organization')
        .values({
          id: entry.organizationId,
          name: 'SCIM team',
          slug: entry.organizationId,
          createdAt: new Date(),
        })
        .execute()
      await db
        .insertInto('auth.member')
        .values({
          organizationId: entry.organizationId,
          userId: actor.userId,
          role: 'owner',
          createdAt: new Date(),
        })
        .execute()
      await db
        .insertInto('auth.session')
        .values({
          id: entry.sessionId,
          userId: actor.userId,
          activeOrganizationId: entry.organizationId,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 3600000),
          updatedAt: new Date(),
        })
        .execute()
    }
  })
  afterEach(async () => {
    await db.deleteFrom('scim_provisioning_tokens').execute()
  })
  afterAll(async () => {
    await database?.drop()
  })
  const auth = (secret: string, overrides = {}, implementation = service) =>
    implementation.authenticateScimToken(db, {
      path: `/scim/v2/${actor.organizationId}/Users`,
      organizationId: actor.organizationId,
      authorization: `Bearer ${secret}`,
      enabled: true,
      ...overrides,
    })
  async function create(implementation = service) {
    return implementation.createScimToken(db, { ...actor, name: 'Identity provider' })
  }
  async function hashOnly(implementation = service) {
    const result = await create(implementation)
    const stored = await db
      .selectFrom('scim_provisioning_tokens')
      .selectAll()
      .where('id', '=', result.token.id)
      .executeTakeFirstOrThrow()
    expect(
      stored.token_hash === createHash('sha256').update(result.secret).digest('base64url'),
    ).toBe(true)
    expect(JSON.stringify(stored).includes(result.secret)).toBe(false)
    const listed = await implementation.listScimTokens(db, actor)
    expect(JSON.stringify(listed).includes(result.secret)).toBe(false)
    expect(listed.tokens.find((t) => t.id === result.token.id)).not.toHaveProperty('token_hash')
  }
  it('stores only digests and returns secrets only at issuance', async () => {
    await hashOnly()
  })
  it('retains the connection and resource identity through rotation, revoke and replacement', async () => {
    const first = await create()
    const binding = (tokenId: string) =>
      db
        .selectFrom('scim_token_connections')
        .selectAll()
        .where('token_id', '=', tokenId)
        .executeTakeFirstOrThrow()
    const original = await binding(first.token.id)
    const resource = await db
      .insertInto('scim_users')
      .values({
        organization_id: actor.organizationId,
        connection_id: original.connection_id,
        user_name: 'rotation-identity',
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const rotated = await service.rotateScimToken(db, {
      ...actor,
      tokenId: first.token.id,
      overlapSeconds: 3600,
    })
    expect(rotated.token.id).toBe(first.token.id)
    expect(await binding(first.token.id)).toEqual(original)
    await service.revokeScimToken(db, { ...actor, tokenId: first.token.id })
    expect(await binding(first.token.id)).toEqual(original)
    const replacement = await create()
    expect((await binding(replacement.token.id)).connection_id).toBe(original.connection_id)
    expect(
      await db
        .selectFrom('scim_users')
        .selectAll()
        .where('id', '=', resource.id)
        .executeTakeFirst(),
    ).toEqual(resource)
  })
  it('allows only scoped SCIM requests and tracks use', async () => {
    const issued = await create()
    expect(await auth(issued.secret)).toEqual({
      tokenId: issued.token.id,
      organizationId: actor.organizationId,
    })
    for (const path of [
      '/api/v1/me',
      '/mcp',
      '/scim/v2',
      `/scim/v2/${other.organizationId}/Users`,
      `/scim/v2/${actor.organizationId}extra`,
    ])
      expect(await auth(issued.secret, { path })).toBeNull()
    expect(await auth(issued.secret, { enabled: false })).toBeNull()
    expect(await auth('hm_synthetic_api_key')).toBeNull()
    expect(
      await auth(issued.secret, {
        organizationId: other.organizationId,
        path: `/scim/v2/${other.organizationId}/Users`,
      }),
    ).toBeNull()
    expect(
      (await service.listScimTokens(db, actor)).tokens.find((t) => t.id === issued.token.id)
        ?.lastUsedAt,
    ).not.toBeNull()
  })
  it('isolates list, rotation and revoke across organizations', async () => {
    const issued = await create()
    expect(
      (await service.listScimTokens(db, other)).tokens.some((t) => t.id === issued.token.id),
    ).toBe(false)
    await expect(
      service.rotateScimToken(db, { ...other, tokenId: issued.token.id, overlapSeconds: 0 }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      service.revokeScimToken(db, { ...other, tokenId: issued.token.id }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(await auth(issued.secret)).not.toBeNull()
  })
  it('bounds overlap, retains the old secret until cutoff and revokes both', async () => {
    const first = await create()
    for (const overlapSeconds of [-1, 86401, 0.5])
      await expect(
        service.rotateScimToken(db, { ...actor, tokenId: first.token.id, overlapSeconds }),
      ).rejects.toMatchObject({ code: 'invalid_input' })
    const second = await service.rotateScimToken(db, {
      ...actor,
      tokenId: first.token.id,
      overlapSeconds: 3600,
    })
    expect(await auth(first.secret)).not.toBeNull()
    expect(await auth(second.secret)).not.toBeNull()
    await expect(
      service.rotateScimToken(db, { ...actor, tokenId: first.token.id, overlapSeconds: 3600 }),
    ).rejects.toMatchObject({ code: 'conflict' })
    await db
      .updateTable('scim_provisioning_tokens')
      .set({ previous_valid_until: new Date(0) })
      .where('id', '=', first.token.id)
      .execute()
    expect(await auth(first.secret)).toBeNull()
    const third = await service.rotateScimToken(db, {
      ...actor,
      tokenId: first.token.id,
      overlapSeconds: 0,
    })
    expect(await auth(second.secret)).toBeNull()
    const revoked = await service.revokeScimToken(db, { ...actor, tokenId: first.token.id })
    expect(await service.revokeScimToken(db, { ...actor, tokenId: first.token.id })).toEqual(
      revoked,
    )
    expect(await auth(third.secret)).toBeNull()
    await expect(
      service.rotateScimToken(db, { ...actor, tokenId: first.token.id, overlapSeconds: 0 }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })
  it('serializes rotate/rotate and rotate/revoke without resurrection', async () => {
    const first = await create()
    const rotations = await Promise.allSettled(
      [1, 2].map(() =>
        service.rotateScimToken(db, { ...actor, tokenId: first.token.id, overlapSeconds: 3600 }),
      ),
    )
    expect(rotations.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const fresh = await create()
    const raced = await Promise.allSettled([
      service.rotateScimToken(db, { ...actor, tokenId: fresh.token.id, overlapSeconds: 3600 }),
      service.revokeScimToken(db, { ...actor, tokenId: fresh.token.id }),
    ])
    expect(raced[1]?.status).toBe('fulfilled')
    expect(await auth(fresh.secret)).toBeNull()
    if (raced[0]?.status === 'fulfilled') expect(await auth(raced[0].value.secret)).toBeNull()
  })
  it('requires a live verified owner/admin session in the active nonpersonal team', async () => {
    for (const role of ['member', 'administrator']) {
      await db
        .updateTable('auth.member')
        .set({ role })
        .where('organizationId', '=', actor.organizationId)
        .execute()
      await expect(create()).rejects.toMatchObject({ code: 'forbidden' })
      await expect(service.listScimTokens(db, actor)).rejects.toMatchObject({ code: 'forbidden' })
    }
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('organizationId', '=', actor.organizationId)
      .execute()
    await expect(create()).rejects.toMatchObject({ code: 'forbidden' })
    await db
      .updateTable('auth.member')
      .set({ role: 'owner' })
      .where('organizationId', '=', actor.organizationId)
      .execute()
    await expect(
      service.createScimToken(db, { ...actor, sessionId: other.sessionId, name: 'no' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      service.createScimToken(db, { ...actor, sessionId: randomUUID(), name: 'no' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', actor.userId)
      .execute()
    await expect(create()).rejects.toMatchObject({ code: 'forbidden' })
    await db
      .updateTable('auth.user')
      .set({ emailVerified: true })
      .where('id', '=', actor.userId)
      .execute()
    for (const entry of [actor, other]) {
      await db
        .insertInto('auth.session')
        .values({
          id: entry.sessionId,
          userId: actor.userId,
          activeOrganizationId: entry.organizationId,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 3600000),
          updatedAt: new Date(),
        })
        .execute()
    }
  })
  it('rejects expired sessions, personal organizations and credential-shaped labels', async () => {
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', actor.sessionId)
      .execute()
    await expect(create()).rejects.toMatchObject({ code: 'forbidden' })
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date(Date.now() + 3600000) })
      .where('id', '=', actor.sessionId)
      .execute()
    await db
      .insertInto('personal_organizations')
      .values({ organization_id: other.organizationId, user_id: actor.userId })
      .execute()
    await expect(service.createScimToken(db, { ...other, name: 'personal' })).rejects.toMatchObject(
      { code: 'forbidden' },
    )
    await db
      .deleteFrom('personal_organizations')
      .where('organization_id', '=', other.organizationId)
      .execute()
    const issued = await create()
    const before = await service.listScimTokens(db, actor)
    await expect(
      service.createScimToken(db, { ...actor, name: issued.secret }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await service.listScimTokens(db, actor)).toEqual(before)
    expect(database.pool.totalCount).toBeLessThanOrEqual(10)
  })
  async function ownerProtection(implementation = service, rotationFirst = false) {
    const issued = await create()
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('organizationId', '=', actor.organizationId)
      .execute()
    try {
      if (rotationFirst)
        await expect(
          implementation.rotateScimToken(db, {
            ...actor,
            tokenId: issued.token.id,
            overlapSeconds: 0,
          }),
        ).rejects.toMatchObject({ code: 'forbidden' })
      await expect(
        implementation.createScimToken(db, { ...actor, name: 'Admin' }),
      ).rejects.toMatchObject({ code: 'forbidden' })
      await expect(
        implementation.rotateScimToken(db, {
          ...actor,
          tokenId: issued.token.id,
          overlapSeconds: 0,
        }),
      ).rejects.toMatchObject({ code: 'forbidden' })
      expect(
        (await implementation.listScimTokens(db, actor)).tokens.some(
          (t) => t.id === issued.token.id,
        ),
      ).toBe(true)
      expect(
        (await implementation.revokeScimToken(db, { ...actor, tokenId: issued.token.id }))
          .revokedAt,
      ).not.toBeNull()
    } finally {
      await db
        .updateTable('auth.member')
        .set({ role: 'owner' })
        .where('organizationId', '=', actor.organizationId)
        .execute()
    }
  }
  it('reserves issuance and rotation for owners while admins can list and revoke', async () => {
    await ownerProtection()
  })
  async function capProtection(implementation = service) {
    await db.deleteFrom('scim_provisioning_tokens').execute()
    for (let i = 0; i < service.SCIM_MAX_ACTIVE_TOKENS - 1; i++) await create()
    const raced = await Promise.allSettled([create(implementation), create(implementation)])
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(raced.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'conflict' },
    })
  }
  it('serializes the active cap and frees capacity after revocation', async () => {
    await capProtection()
    const first = (await service.listScimTokens(db, actor)).tokens[0]
    if (!first) throw new Error('Missing token fixture')
    await service.revokeScimToken(db, { ...actor, tokenId: first.id })
    await create()
  })
  async function attribution(implementation = service) {
    const issued = await create(implementation)
    expect(issued.token.createdByUserId).toBe(actor.userId)
    expect(issued.token.rotatedAt).toBeNull()
    const rotated = await implementation.rotateScimToken(db, {
      ...actor,
      tokenId: issued.token.id,
      overlapSeconds: 0,
    })
    expect(rotated.token.rotatedByUserId).toBe(actor.userId)
    expect(rotated.token.createdByUserId).toBe(actor.userId)
    expect(rotated.token.rotatedAt).not.toBeNull()
  }
  it('attributes creation and rotation without changing the creator', async () => {
    await attribution()
  })
  async function pagination(implementation = service) {
    await db.deleteFrom('scim_provisioning_tokens').execute()
    for (let i = 0; i < 3; i++) await create()
    const first = await implementation.listScimTokens(db, { ...actor, limit: 2 })
    expect(first.tokens).toHaveLength(2)
    expect(first.nextCursor).toBe(first.tokens[1]?.id)
    const second = await implementation.listScimTokens(db, {
      ...actor,
      limit: 2,
      after: first.nextCursor ?? undefined,
    })
    expect(second.tokens).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.tokens, ...second.tokens].map((t) => t.id)).size).toBe(3)
  }
  it('paginates metadata without duplicates and bounds input', async () => {
    await pagination()
    for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { after: 'bad' }])
      await expect(service.listScimTokens(db, { ...actor, ...input })).rejects.toMatchObject({
        code: 'invalid_input',
      })
    expect((await service.createScimToken(db, { ...actor, name: 'Ohm_sync' })).token.name).toBe(
      'Ohm_sync',
    )
  })
  it.each([
    ['owner', "ownerOnly && manager.role !== 'owner'", 'false'],
    ['owner rotation', "ownerOnly && manager.role !== 'owner'", 'false'],
    ['cap', 'Number(count.count) >= SCIM_MAX_ACTIVE_TOKENS', 'false'],
    ['creator', 'created_by_user_id: input.userId', 'created_by_user_id: null'],
    ['rotator', 'rotated_by_user_id: input.userId', 'rotated_by_user_id: null'],
    ['page', '.limit(limit + 1)', '.limit(1)'],
  ] as const)('detects %s source-copy protection mutation', async (protection, from, to) => {
    const verify =
      protection === 'owner rotation'
        ? (implementation: typeof service) => ownerProtection(implementation, true)
        : protection === 'owner'
          ? ownerProtection
          : protection === 'cap'
            ? capProtection
            : protection === 'page'
              ? pagination
              : attribution
    await expect(verify(sourceCopy([from, to]))).rejects.toMatchObject({ name: 'AssertionError' })
    await db.deleteFrom('scim_provisioning_tokens').execute()
    await verify(sourceCopy())
  })
  it.each([
    ['hash-only', "createHash('sha256').update(secret).digest('base64url')", "'A'.repeat(43)"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-copy anchor
    ['path', '!(input.path === base || input.path.startsWith(`${base}/`))', 'false'],
    ['flag', '!input.enabled', 'false'],
    ['overlap conflict', 'if (overlapping.active)', 'if (false)'],
    ['overlap limit', 'input.overlapSeconds > SCIM_MAX_OVERLAP_SECONDS', 'false'],
    ['revoke', 'coalesce(revoked_at, clock_timestamp())', 'clock_timestamp()'],
    [
      'one-time display',
      "'id',\n  'organization_id as organizationId',",
      "'token_hash', 'id',\n  'organization_id as organizationId',",
    ],
    [
      'organization',
      ".where('organization_id', '=', input.organizationId)\n    .where('revoked_at'",
      ".where('revoked_at'",
    ],
    ['expiry', "eb('previous_valid_until', '>', sql<Date>`clock_timestamp()`)", 'eb.val(true)'],
    [
      'authorization',
      'const manager = await checkTeamManagementAccess(',
      "const manager = await (async () => ({role: 'owner'})) (",
    ],
  ] as const)(
    'detects source-copy %s mutation and verifies restored source',
    async (protection, from, to) => {
      async function verify(implementation: typeof service) {
        if (protection === 'hash-only') return hashOnly(implementation)
        if (protection === 'one-time display') return hashOnly(implementation)
        const issued = await create()
        if (protection === 'overlap conflict') {
          await service.rotateScimToken(db, {
            ...actor,
            tokenId: issued.token.id,
            overlapSeconds: 3600,
          })
          await expect(
            implementation.rotateScimToken(db, {
              ...actor,
              tokenId: issued.token.id,
              overlapSeconds: 3600,
            }),
          ).rejects.toMatchObject({ code: 'conflict' })
        }
        if (protection === 'overlap limit')
          await expect(
            implementation.rotateScimToken(db, {
              ...actor,
              tokenId: issued.token.id,
              overlapSeconds: 86401,
            }),
          ).rejects.toMatchObject({ code: 'invalid_input' })
        if (protection === 'revoke') {
          await service.revokeScimToken(db, { ...actor, tokenId: issued.token.id })
          await db
            .updateTable('scim_provisioning_tokens')
            .set({ revoked_at: new Date(0) })
            .where('id', '=', issued.token.id)
            .execute()
          const again = await implementation.revokeScimToken(db, {
            ...actor,
            tokenId: issued.token.id,
          })
          expect(new Date(again.revokedAt as Date).getTime()).toBe(0)
        }
        if (protection === 'path')
          expect(await auth(issued.secret, { path: '/mcp' }, implementation)).toBeNull()
        if (protection === 'flag')
          expect(await auth(issued.secret, { enabled: false }, implementation)).toBeNull()
        if (protection === 'organization')
          expect(
            await auth(
              issued.secret,
              {
                organizationId: other.organizationId,
                path: `/scim/v2/${other.organizationId}/Users`,
              },
              implementation,
            ),
          ).toBeNull()
        if (protection === 'expiry') {
          await service.rotateScimToken(db, {
            ...actor,
            tokenId: issued.token.id,
            overlapSeconds: 1,
          })
          await db
            .updateTable('scim_provisioning_tokens')
            .set({ previous_valid_until: new Date(0) })
            .where('id', '=', issued.token.id)
            .execute()
          expect(await auth(issued.secret, {}, implementation)).toBeNull()
        }
        if (protection === 'authorization')
          await expect(
            implementation.listScimTokens(db, { ...actor, sessionId: randomUUID() }),
          ).rejects.toMatchObject({ code: 'forbidden' })
      }
      await expect(verify(sourceCopy([from, to]))).rejects.toMatchObject({
        name: 'AssertionError',
      })
      await verify(sourceCopy())
    },
  )
})
