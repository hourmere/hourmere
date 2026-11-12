import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { type AuditAction, withAuditRequest, writeAuditEvent } from '@hourmere/db/audit'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createScimToken, revokeScimToken, rotateScimToken } from './scim-tokens.ts'

const serverUrl = process.env.DATABASE_URL
const actions: AuditAction[] = ['scim_token.created', 'scim_token.rotated', 'scim_token.revoked']

describe.skipIf(!serverUrl)('SCIM provisioning token audit events', () => {
  let database: TestDatabase
  let db: Db
  beforeAll(async () => {
    database = await createTestDatabase(serverUrl as string)
    db = createDb(database.pool)
  })
  afterAll(async () => {
    await database?.drop()
  })
  /** A team with an owner and an admin, each signed in to it. */
  async function team() {
    const organizationId = randomUUID()
    await db
      .insertInto('auth.organization')
      .values({
        id: organizationId,
        name: 'SCIM team',
        slug: organizationId,
        createdAt: new Date(),
      })
      .execute()
    const member = async (role: 'owner' | 'admin') => {
      const userId = randomUUID()
      const sessionId = randomUUID()
      await db
        .insertInto('auth.user')
        .values({
          id: userId,
          name: `SCIM ${role}`,
          email: `${userId}@example.test`,
          emailVerified: true,
        })
        .execute()
      await db
        .insertInto('auth.member')
        .values({ organizationId, userId, role, createdAt: new Date() })
        .execute()
      await db
        .insertInto('auth.session')
        .values({
          id: sessionId,
          userId,
          activeOrganizationId: organizationId,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 3600000),
          updatedAt: new Date(),
        })
        .execute()
      return { organizationId, userId, sessionId }
    }
    return { organizationId, owner: await member('owner'), admin: await member('admin') }
  }
  const events = async (organizationId: string) =>
    (
      await database.pool.query(
        `SELECT * FROM audit_events WHERE organization_id = $1 AND action LIKE 'scim_token.%' ORDER BY id`,
        [organizationId],
      )
    ).rows
  const stored = async (id: string) =>
    (await database.pool.query('SELECT * FROM scim_provisioning_tokens WHERE id = $1', [id]))
      .rows[0]

  it('records creation, rotation and revocation with the session and the token ID only', async () => {
    const t = await team()
    const requestId = randomUUID()
    const { created, rotated, revoked } = await withAuditRequest(requestId, async () => {
      const created = await createScimToken(db, { ...t.owner, name: 'Private IdP label' })
      // The request may spell the token ID in any case; the event keeps the stored ID.
      const rotated = await rotateScimToken(db, {
        ...t.owner,
        tokenId: created.token.id.toUpperCase(),
        overlapSeconds: 60,
      })
      const revoked = await revokeScimToken(db, { ...t.admin, tokenId: created.token.id })
      return { created, rotated, revoked }
    })
    expect(revoked.revokedAt).not.toBeNull()
    const rows = await events(t.organizationId)
    const common = {
      organization_id: t.organizationId,
      actor_type: 'user',
      credential_type: 'session',
      credential_scope: null,
      oauth_client_id: null,
      oauth_grant_id: null,
      target_type: 'scim_token',
      target_id: created.token.id,
      details: {},
      request_id: requestId,
    }
    expect(rows).toMatchObject([
      {
        ...common,
        action: 'scim_token.created',
        actor_id: t.owner.userId,
        credential_id: t.owner.sessionId,
      },
      {
        ...common,
        action: 'scim_token.rotated',
        actor_id: t.owner.userId,
        credential_id: t.owner.sessionId,
      },
      {
        ...common,
        action: 'scim_token.revoked',
        actor_id: t.admin.userId,
        credential_id: t.admin.sessionId,
      },
    ])
    const serialized = JSON.stringify(rows)
    for (const secret of [created.secret, rotated.secret, 'Private IdP label'])
      expect(serialized.includes(secret)).toBe(false)
  })

  it('records nothing for a repeated revocation or a refused change', async () => {
    const t = await team()
    const { token } = await createScimToken(db, { ...t.owner, name: 'Repeated' })
    await revokeScimToken(db, { ...t.owner, tokenId: token.id })
    await revokeScimToken(db, { ...t.admin, tokenId: token.id })
    await Promise.all([
      revokeScimToken(db, { ...t.owner, tokenId: token.id }),
      revokeScimToken(db, { ...t.admin, tokenId: token.id }),
    ])
    // Two first revocations race: exactly one of them revokes and records.
    const raced = await createScimToken(db, { ...t.owner, name: 'Raced' })
    await Promise.all([
      revokeScimToken(db, { ...t.owner, tokenId: raced.token.id }),
      revokeScimToken(db, { ...t.admin, tokenId: raced.token.id }),
    ])
    const overlapping = await createScimToken(db, { ...t.owner, name: 'Overlapping' })
    await rotateScimToken(db, { ...t.owner, tokenId: overlapping.token.id, overlapSeconds: 3600 })
    const before = (await events(t.organizationId)).length
    const other = await team()
    for (const [code, refused] of [
      // Rotating a revoked token, or again during an active overlap.
      ['conflict', () => rotateScimToken(db, { ...t.owner, tokenId: token.id, overlapSeconds: 0 })],
      [
        'conflict',
        () => rotateScimToken(db, { ...t.owner, tokenId: overlapping.token.id, overlapSeconds: 0 }),
      ],
      // Admins may revoke but neither issue nor rotate.
      ['forbidden', () => createScimToken(db, { ...t.admin, name: 'Refused' })],
      [
        'forbidden',
        () => rotateScimToken(db, { ...t.admin, tokenId: overlapping.token.id, overlapSeconds: 0 }),
      ],
      // Another team's token does not exist for this caller.
      ['not_found', () => revokeScimToken(db, { ...other.owner, tokenId: overlapping.token.id })],
    ] as const)
      await expect(refused()).rejects.toMatchObject({ code })
    const rows = await events(t.organizationId)
    expect(rows).toHaveLength(before)
    expect(rows.map((row) => [row.action, row.target_id])).toEqual([
      ['scim_token.created', token.id],
      ['scim_token.revoked', token.id],
      ['scim_token.created', raced.token.id],
      ['scim_token.revoked', raced.token.id],
      ['scim_token.created', overlapping.token.id],
      ['scim_token.rotated', overlapping.token.id],
    ])
    expect(await events(other.organizationId)).toEqual([])
  })

  it('rolls back the token change when its event cannot be written', async () => {
    const t = await team()
    const { token } = await createScimToken(db, { ...t.owner, name: 'Kept' })
    const before = await stored(token.id)
    await database.pool.query(`CREATE FUNCTION reject_scim_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
      CREATE TRIGGER reject_scim_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_scim_audit()`)
    try {
      await expect(createScimToken(db, { ...t.owner, name: 'Rolled back' })).rejects.toThrow(
        'audit unavailable',
      )
      await expect(
        rotateScimToken(db, { ...t.owner, tokenId: token.id, overlapSeconds: 0 }),
      ).rejects.toThrow('audit unavailable')
      await expect(revokeScimToken(db, { ...t.owner, tokenId: token.id })).rejects.toThrow(
        'audit unavailable',
      )
    } finally {
      await database.pool.query(
        'DROP TRIGGER reject_scim_audit ON audit_events; DROP FUNCTION reject_scim_audit()',
      )
    }
    expect(await stored(token.id)).toEqual(before)
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int AS n FROM scim_provisioning_tokens WHERE organization_id = $1',
          [t.organizationId],
        )
      ).rows[0].n,
    ).toBe(1)
    expect((await events(t.organizationId)).map((row) => row.action)).toEqual([
      'scim_token.created',
    ])
  })

  it('rejects any detail key in the application and the database', async () => {
    for (const action of actions)
      for (const details of [{ name: 'IdP' }, { secret: 'scim_x' }, { scope: 'full' }]) {
        await expect(
          db.transaction().execute((trx) =>
            writeAuditEvent(trx, {
              organizationId: randomUUID(),
              actor: { type: 'user', id: randomUUID() },
              credential: { type: 'session', id: randomUUID() },
              action,
              targetType: 'scim_token',
              targetId: randomUUID(),
              details,
            }),
          ),
        ).rejects.toThrow('allow-listed')
        await expect(
          database.pool.query(
            `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
             VALUES ('system', 'test', 'none', $1, 'scim_token', 'test', $2::jsonb)`,
            [action, JSON.stringify(details)],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'audit_events_details_check' })
      }
  })
})
