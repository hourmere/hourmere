import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type AuditEvent,
  auditActor,
  auditDetails,
  withAuditRequest,
  writeAuditEvent,
} from './audit.ts'
import { createDb, type Db } from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
describe.skipIf(!serverUrl)('audit journal', () => {
  let owned: TestDatabase
  let db: Db
  const organizationId = randomUUID()
  const event: AuditEvent = {
    organizationId,
    actor: { type: 'user', id: randomUUID() },
    credential: { type: 'session', id: randomUUID() },
    action: 'membership.role_changed',
    targetType: 'membership',
    targetId: randomUUID(),
  }
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  it('preserves each credential identity and request context in a single insert', async () => {
    const principals = [
      { user: { id: 'u' }, kind: 'session', sessionId: 'session' },
      { user: { id: 'u' }, kind: 'api_key', apiKeyId: 'key', apiKeyScope: 'bookings' },
      { user: { id: 'u' }, kind: 'oauth', clientId: 'client', oauthConsentId: 'grant' },
    ] as const
    for (const principal of principals) {
      const identity = auditActor(principal)
      await withAuditRequest('server-request', () =>
        db.transaction().execute((trx) => writeAuditEvent(trx, { ...event, ...identity })),
      )
      const row = await db
        .selectFrom('audit_events')
        .selectAll()
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow()
      expect(row).toMatchObject({
        actor_type: identity.actor.type,
        actor_id: identity.actor.id,
        credential_type: identity.credential.type,
        credential_id: identity.credential.id ?? null,
        credential_scope: identity.credential.scope ?? null,
        oauth_client_id: identity.credential.clientId ?? null,
        oauth_grant_id: identity.credential.grantId ?? null,
        details: {},
        request_id: 'server-request',
      })
    }
  })
  it('rejects all non allow-listed details and nontransactional writes', async () => {
    await expect(writeAuditEvent(db, event)).rejects.toThrow('transaction')
    for (const key of ['email', 'token', 'password', 'answers', 'body']) {
      await expect(
        db
          .transaction()
          .execute((trx) => writeAuditEvent(trx, { ...event, details: { [key]: 'private' } })),
      ).rejects.toThrow('allow-listed')
    }
  })
  it('allows only action-specific details in both application and database', async () => {
    const cases = [
      ['membership.role_changed', { oldRole: 'member', newRole: 'admin' }],
      ['api_key.created', { scope: 'bookings' }],
      ['api_key.rotated', { scope: 'full' }],
      ...[
        'webhook.created',
        'webhook.updated',
        'webhook.deleted',
        'webhook.secret_rotated',
        'webhook.paused',
        'webhook.resumed',
      ].map((action) => [action, { events: ['booking.created'] }]),
      ['oauth.token_revoked', { familySize: 2 }],
      ['organization.branding_updated', { logo: 'uploaded' }],
      ['organization.branding_updated', { logo: 'selected', primaryColor: 'set' }],
      ['organization.branding_updated', { logo: 'removed', primaryColor: 'cleared' }],
      ['booking.attendee_no_show_changed', { attendeeId: randomUUID(), noShow: 'marked' }],
      ['booking.attendee_no_show_changed', { attendeeId: randomUUID(), noShow: 'unmarked' }],
    ] as [AuditEvent['action'], Record<string, unknown>][]
    for (const [action, details] of cases) {
      await db.transaction().execute((trx) => writeAuditEvent(trx, { ...event, action, details }))
      const row = await db
        .selectFrom('audit_events')
        .select('details')
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow()
      expect(row.details).toEqual(details)
    }
    for (const action of Object.keys(auditDetails) as AuditEvent['action'][]) {
      for (const key of [
        'unexpected',
        'email',
        'name',
        'secret',
        'url',
        'scope',
        'events',
        'oldRole',
        'newRole',
        'familySize',
        'logo',
        'primaryColor',
        'attendeeId',
        'noShow',
      ]) {
        if ((auditDetails[action] as readonly string[]).includes(key)) continue
        await expect(
          db.transaction().execute((trx) =>
            writeAuditEvent(trx, {
              ...event,
              action,
              details: { [key]: 'private' },
            }),
          ),
        ).rejects.toThrow('allow-listed')
        await expect(
          owned.pool.query(
            `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
           VALUES ('system', 'test', 'none', $1, 'test', 'test', $2::jsonb)`,
            [action, JSON.stringify({ [key]: 'private' })],
          ),
        ).rejects.toMatchObject({ constraint: 'audit_events_details_check' })
      }
    }
    // Branding details say what changed, never the colour, the image or its hash.
    for (const details of [
      {},
      { primaryColor: '#12AB34' },
      { logo: 'a'.repeat(64) },
      { logo: null },
      { logo: 1 },
      { primaryColor: ['set'] },
    ])
      await expect(
        owned.pool.query(
          `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
           VALUES ('system', 'test', 'none', 'organization.branding_updated', 'organization', 'test', $1::jsonb)`,
          [JSON.stringify(details)],
        ),
      ).rejects.toMatchObject({ constraint: 'audit_events_details_check' })
    // No-show details name the attendee by stored ID and the resulting state, nothing else.
    const attendeeId = randomUUID()
    await expect(
      db.transaction().execute((trx) =>
        writeAuditEvent(trx, {
          ...event,
          action: 'booking.attendee_no_show_changed',
          details: { attendeeId, noShow: 'marked', name: 'Private Invitee' },
        }),
      ),
    ).rejects.toThrow('allow-listed')
    for (const details of [
      {},
      { attendeeId },
      { noShow: 'marked' },
      { attendeeId, noShow: 'marked', email: 'invitee@example.com' },
      { attendeeId, noShow: 'marked', note: 'free text' },
      { attendeeId, noShow: true },
      { attendeeId, noShow: 'maybe' },
      { attendeeId, noShow: ['marked'] },
      { attendeeId, noShow: null },
      { attendeeId: attendeeId.toUpperCase(), noShow: 'marked' },
      { attendeeId: 'Private Invitee', noShow: 'marked' },
      { attendeeId: `${attendeeId} `, noShow: 'unmarked' },
      { attendeeId: [attendeeId], noShow: 'unmarked' },
      { attendeeId: null, noShow: 'unmarked' },
    ])
      await expect(
        owned.pool.query(
          `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
           VALUES ('system', 'test', 'none', 'booking.attendee_no_show_changed', 'booking', 'test', $1::jsonb)`,
          [JSON.stringify(details)],
        ),
        JSON.stringify(details),
      ).rejects.toMatchObject({ constraint: 'audit_events_details_check' })
  }, 30_000)
  it('rolls back the change when audit fails and the event when the change fails', async () => {
    const id = randomUUID()
    await expect(
      db.transaction().execute(async (trx) => {
        await trx
          .insertInto('auth.organization')
          .values({ id, name: 'rollback', slug: id, createdAt: new Date() })
          .execute()
        await writeAuditEvent(trx, {
          ...event,
          organizationId: id,
          details: { email: 'forbidden' },
        })
      }),
    ).rejects.toThrow()
    expect(
      await db.selectFrom('auth.organization').select('id').where('id', '=', id).execute(),
    ).toEqual([])
    await expect(
      db.transaction().execute(async (trx) => {
        await writeAuditEvent(trx, { ...event, organizationId: id })
        throw new Error('change failed')
      }),
    ).rejects.toThrow('change failed')
    expect(
      await db.selectFrom('audit_events').select('id').where('organization_id', '=', id).execute(),
    ).toEqual([])
  })
  it('enforces database actor and credential shapes and fails closed on insert errors', async () => {
    for (const bad of [
      { actor: { type: 'unknown', id: 'u' } },
      { actor: { type: 'user' } },
      { actor: { type: 'anonymous', id: 'u' } },
      { credential: { type: 'unknown' } },
      { credential: { type: 'api_key' } },
      { credential: { type: 'api_key', id: 'key', scope: 'admin' } },
      { credential: { type: 'oauth', grantId: 'grant' } },
      { credential: { type: 'none', id: 'secret' } },
      { actor: { type: 'external_oauth_client', id: 'foreign-user' } },
      // External callers never leave their credential identifiers in this journal.
      {
        actor: { type: 'external_oauth_client' },
        credential: { type: 'oauth', clientId: 'client', grantId: 'grant' },
      },
      { actor: { type: 'external_api_key' }, credential: { type: 'api_key', id: 'key' } },
      { actor: { type: 'external_api_key' }, credential: { type: 'session', id: 'session' } },
      { actor: { type: 'external_user', id: 'invitee' }, credential: { type: 'none' } },
      { actor: { type: 'external_user' }, credential: { type: 'session', id: 'session' } },
    ]) {
      await expect(
        db.transaction().execute((trx) => writeAuditEvent(trx, { ...event, ...bad } as AuditEvent)),
      ).rejects.toThrow()
    }
    for (const type of ['external_api_key', 'external_oauth_client', 'external_user'] as const)
      await db.transaction().execute((trx) =>
        writeAuditEvent(trx, {
          ...event,
          action: 'booking.created',
          actor: { type },
          credential: { type: 'none' },
        }),
      )
    const id = randomUUID()
    await expect(
      db.transaction().execute(async (trx) => {
        await trx
          .insertInto('auth.organization')
          .values({ id, name: 'rollback', slug: id, createdAt: new Date() })
          .execute()
        await writeAuditEvent(trx, { ...event, targetType: '' })
      }),
    ).rejects.toThrow()
    expect(
      await db.selectFrom('auth.organization').select('id').where('id', '=', id).execute(),
    ).toEqual([])
  })
  it('keeps simultaneous request contexts isolated', async () => {
    const ids = [randomUUID(), randomUUID()]
    await Promise.all(
      ids.map((requestId) =>
        withAuditRequest(requestId, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          await db
            .transaction()
            .execute((trx) => writeAuditEvent(trx, { ...event, targetId: requestId }))
        }),
      ),
    )
    for (const id of ids) {
      const row = await db
        .selectFrom('audit_events')
        .selectAll()
        .where('target_id', '=', id)
        .executeTakeFirstOrThrow()
      expect(row.request_id).toBe(id)
    }
  })
  it('isolates organizations and orders concurrent role changes without losing either', async () => {
    const org = randomUUID(),
      other = randomUUID()
    await Promise.all(
      [org, org, other].map((organizationId) =>
        db.transaction().execute((trx) => writeAuditEvent(trx, { ...event, organizationId })),
      ),
    )
    const rows = await db
      .selectFrom('audit_events')
      .selectAll()
      .where('organization_id', '=', org)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.id)).size).toBe(2)
    expect(
      rows.every((row) => row.organization_id === org && row.action === 'membership.role_changed'),
    ).toBe(true)
    expect((rows[0]?.occurred_at ?? '') <= (rows[1]?.occurred_at ?? '')).toBe(true)
    expect(owned.pool.totalCount).toBeLessThan(10)
  })
})
