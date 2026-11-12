import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createScimToken, revokeScimToken, rotateScimToken } from '@hourmere/auth'
import { createDb, type Db, runMigrations } from '@hourmere/db'
import { auditActor, writeAuditEvent } from '@hourmere/db/audit'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createEventType, setAttendeeNoShow } from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { assertAuditEventListProtections } from '../../db/src/audit-event-details-protections.ts'
import { seedEarly } from '../../db/src/upgrade-path-seed-early.ts'
import { seedLater } from '../../db/src/upgrade-path-seed-later.ts'
import { snapshotSchema } from '../../db/src/upgrade-schema-snapshot.ts'
import { deliverWebhook } from './delivery.ts'
import {
  createWebhook,
  deleteWebhook,
  rotateWebhookSecret,
  updateWebhook,
  WEBHOOK_EVENTS,
} from './service.ts'
import {
  createSlackDestination,
  deleteSlackDestination,
  testSlackDestination,
  updateSlackDestination,
} from './slack.ts'
import { SLACK_EVENTS } from './slack-format.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0080_audit_event_details.sql'
const migrations = fileURLToPath(new URL('../../db/migrations/', import.meta.url))
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 5).toString('base64') }
const now = Temporal.Instant.from('2026-11-01T12:00Z')
const queue = { enqueue: async () => null }
const slackUrl = (team: string) =>
  `https://hooks.slack.com/services/T${team}/BUPGRADE/private-upgrade-secret`

/**
 * A journal as the application writes it today: webhook, Slack destination (including the
 * delivery worker's automatic pause), no-show, SCIM token and event-type rows come from their
 * services; the other detail shapes go through writeAuditEvent as their services call it.
 */
async function writeJournal(db: Db) {
  // Webhooks: every action, with API-key and session attribution.
  const owner = await createTestUser(db, 'Webhook Owner')
  const ctx = { ...testContext(db, owner.principal, () => now), requestId: randomUUID() }
  const session = {
    ...ctx,
    principal: { ...owner.principal, kind: 'session' as const, sessionId: randomUUID() },
  }
  const all = await createWebhook(ctx, settings, {
    url: 'https://hooks.example.com/all-events?token=private-query',
    events: [...WEBHOOK_EVENTS].reverse(),
  })
  const one = await createWebhook(session, settings, {
    url: 'https://hooks.example.com/one-event',
    events: ['booking.cancelled'],
  })
  await updateWebhook(ctx, one.webhook.id, {
    events: ['booking.attendee_no_show_changed', 'booking.created'],
  })
  await updateWebhook(session, one.webhook.id, { isActive: false })
  await updateWebhook(ctx, one.webhook.id, { isActive: true, events: ['booking.rescheduled'] })
  await rotateWebhookSecret(ctx, settings, one.webhook.id)
  await deleteWebhook(session, all.webhook.id)

  // Slack destinations: every management action, then the delivery worker's automatic pause.
  const slackOwner = await createTestUser(db, 'Slack Owner')
  const slack = { ...testContext(db, slackOwner.principal, () => now), requestId: randomUUID() }
  const destination = await createSlackDestination(slack, settings, {
    url: slackUrl('ALL'),
    events: [...SLACK_EVENTS],
  })
  await updateSlackDestination(
    slack,
    destination.id,
    { events: ['booking.cancelled', 'booking.created'] },
    settings,
  )
  await updateSlackDestination(slack, destination.id, { isActive: false }, settings)
  await updateSlackDestination(slack, destination.id, { isActive: true }, settings)
  const sample = await testSlackDestination(slack, settings, destination.id, queue)
  await deliverWebhook(
    { db, ...settings, transport: async () => 410, now: () => now },
    sample.deliveryId,
    new AbortController().signal,
  )
  const leaver = await createTestUser(db, 'Slack Leaver')
  const leaving = { ...testContext(db, leaver.principal, () => now), requestId: randomUUID() }
  const removed = await createSlackDestination(leaving, settings, {
    url: slackUrl('ONE'),
    events: ['booking.reschedule_request_expired'],
  })
  await deleteSlackDestination(leaving, removed.id)

  // An attendee marked and unmarked as a no-show by the booking's host.
  const host = await createTestUser(db, 'No-show Host')
  const team = await createTestTeam(db, [{ user: host, role: 'owner' }])
  const bookingId = await createFixtures(db).booking(
    team.id,
    [host.id],
    '2026-10-30T09:00Z',
    '2026-10-30T09:30Z',
  )
  const attendee = await db
    .selectFrom('booking_attendees')
    .select('id')
    .where('booking_id', '=', bookingId)
    .executeTakeFirstOrThrow()
  const marking = { ...testContext(db, team.as(host), () => now), requestId: randomUUID() }
  await setAttendeeNoShow(marking, bookingId, attendee.id, true)
  await setAttendeeNoShow(marking, bookingId, attendee.id, false)

  // A SCIM provisioning token created, rotated and revoked by the team owner's session.
  const scimOwner = await createTestUser(db, 'SCIM Owner')
  const scimTeam = await createTestTeam(db, [{ user: scimOwner, role: 'owner' }])
  const signedIn = await db
    .insertInto('auth.session')
    .values({
      userId: scimOwner.id,
      activeOrganizationId: scimTeam.id,
      token: randomUUID(),
      // Sessions expire on the real clock, not the services' fixed one.
      expiresAt: new Date(Date.now() + 3_600_000),
      updatedAt: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const actor = { userId: scimOwner.id, organizationId: scimTeam.id, sessionId: signedIn.id }
  const { token } = await createScimToken(db, { ...actor, name: 'Upgrade IdP' })
  await rotateScimToken(db, { ...actor, tokenId: token.id, overlapSeconds: 0 })
  await revokeScimToken(db, { ...actor, tokenId: token.id })

  // An event type, then the remaining detail shapes through the application's writer.
  await createEventType(ctx, { slug: 'upgrade', title: 'Private title', durationMinutes: 30 })
  const sessionActor = auditActor({ kind: 'session', sessionId: randomUUID(), user: owner })
  const keyActor = auditActor({
    kind: 'api_key',
    apiKeyId: randomUUID(),
    apiKeyScope: 'bookings',
    user: owner,
  })
  const others: Parameters<typeof writeAuditEvent>[1][] = [
    {
      ...sessionActor,
      action: 'membership.role_changed',
      targetType: 'membership',
      targetId: randomUUID(),
      details: { oldRole: 'member', newRole: 'admin' },
      organizationId: team.id,
    },
    {
      ...sessionActor,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: randomUUID(),
      details: { scope: 'bookings' },
      organizationId: owner.principal.organization.id,
    },
    {
      ...sessionActor,
      action: 'api_key.revoked',
      targetType: 'api_key',
      targetId: randomUUID(),
      organizationId: owner.principal.organization.id,
    },
    {
      actor: { type: 'oauth_client', id: 'https://agent.example/metadata.json' },
      credential: {
        type: 'oauth',
        clientId: 'https://agent.example/metadata.json',
        grantId: randomUUID(),
      },
      action: 'oauth.token_revoked',
      targetType: 'oauth_grant',
      targetId: randomUUID(),
      details: { familySize: 3 },
      organizationId: team.id,
    },
    {
      ...keyActor,
      action: 'organization.branding_updated',
      targetType: 'organization',
      targetId: team.id,
      details: { logo: 'selected', primaryColor: 'set' },
      organizationId: team.id,
    },
    {
      actor: { type: 'anonymous' },
      credential: { type: 'none' },
      action: 'booking.created',
      targetType: 'booking',
      targetId: bookingId,
      organizationId: team.id,
    },
    {
      actor: { type: 'external_api_key' },
      credential: { type: 'none' },
      action: 'booking.cancelled',
      targetType: 'booking',
      targetId: bookingId,
      organizationId: team.id,
    },
    {
      ...sessionActor,
      action: 'session.revoked',
      targetType: 'session',
      targetId: randomUUID(),
      organizationId: owner.principal.organization.id,
    },
  ]
  for (const event of others)
    await db
      .transaction()
      .execute((trx) => writeAuditEvent(trx, { ...event, requestId: randomUUID() }))
  return { ctx, oneWebhook: one.webhook.id }
}

const insertDetails = (client: pg.Pool | pg.PoolClient, action: string, details: unknown) =>
  client.query(
    `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
     VALUES ('system', 'upgrade-test', 'none', $1, 'test', $2, $3::jsonb) RETURNING id`,
    [action, randomUUID(), JSON.stringify(details)],
  )
const detailsCheck = async (pool: pg.Pool) =>
  (
    await pool.query<{ definition: string; validated: boolean }>(
      `SELECT pg_get_constraintdef(oid) AS definition, convalidated AS validated FROM pg_constraint
       WHERE conrelid = 'audit_events'::regclass AND conname = 'audit_events_details_check'`,
    )
  ).rows

it.skipIf(!serverUrl)(
  '0080 keeps a journal written by the application, equals a fresh install and reruns as a no-op',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-audit-event-details-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrations))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      expect(files).toContain('0078_audit_actions_followups.sql')
      for (const file of files.filter((file) => file < '0013'))
        await copyFile(join(migrations, file), join(directory, file))
      upgraded = await createTestDatabase(serverUrl as string, directory, { tag: 'event_details' })
      const pool = upgraded.pool
      await seedEarly(pool)
      for (const file of files) await copyFile(join(migrations, file), join(directory, file))
      await runMigrations(pool, directory)
      await seedLater(pool)
      const db = createDb(pool)
      const { ctx, oneWebhook } = await writeJournal(db)
      // One row per change above: all six webhook and all six Slack destination actions.
      expect(
        (
          await pool.query<{ action: string; actor: string; n: number }>(
            `SELECT action, actor_type AS actor, count(*)::int AS n FROM audit_events
             GROUP BY action, actor_type ORDER BY action, actor_type`,
          )
        ).rows.map((row) => `${row.action} ${row.actor} ${row.n}`),
      ).toEqual([
        'api_key.created user 1',
        'api_key.revoked user 1',
        'booking.attendee_no_show_changed api_key 2',
        'booking.cancelled external_api_key 1',
        'booking.created anonymous 1',
        'event_type.created api_key 1',
        'membership.role_changed user 1',
        'oauth.token_revoked oauth_client 1',
        'organization.branding_updated api_key 1',
        'scim_token.created user 1',
        'scim_token.revoked user 1',
        'scim_token.rotated user 1',
        'session.revoked user 1',
        'slack_destination.created api_key 2',
        'slack_destination.deleted api_key 1',
        'slack_destination.paused api_key 1',
        'slack_destination.paused system 1',
        'slack_destination.resumed api_key 1',
        'slack_destination.tested api_key 1',
        'slack_destination.updated api_key 1',
        'webhook.created api_key 1',
        'webhook.created user 1',
        'webhook.deleted user 1',
        'webhook.paused user 1',
        'webhook.resumed api_key 1',
        'webhook.secret_rotated api_key 1',
        'webhook.updated api_key 2',
      ])

      // The predecessor's check accepts what 0080 refuses.
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await insertDetails(client, 'slack_destination.updated', { events: slackUrl('LEAK') })
        await insertDetails(client, 'webhook.paused', {
          events: [{ name: 'Private Invitee', email: 'invitee@example.com' }],
        })
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }

      // A row written outside the application that 0080 refuses stops the upgrade; the
      // transaction rolls back and the 0078 check stays.
      const previous = await detailsCheck(pool)
      const outside = (
        await insertDetails(pool, 'webhook.updated', {
          events: ['booking.created', 'booking.created'],
        })
      ).rows[0]?.id
      await copyFile(join(migrations, migration), join(directory, migration))
      const failure = await runMigrations(pool, directory).then(
        () => undefined,
        (error: unknown) => error as Error & { cause?: { code?: string; constraint?: string } },
      )
      expect(failure?.message).toBe(`migration ${migration} failed`)
      expect(failure?.cause).toMatchObject({
        code: '23514',
        constraint: 'audit_events_details_check',
      })
      expect(await detailsCheck(pool)).toEqual(previous)
      expect(
        (await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [migration])).rowCount,
      ).toBe(0)
      await pool.query('DELETE FROM audit_events WHERE id = $1', [outside])

      const tables = (
        await pool.query<{ schema: string; name: string }>(
          `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
           WHERE table_schema IN ('public','auth') AND table_type='BASE TABLE'
             AND table_name <> 'schema_migrations' ORDER BY 1,2`,
        )
      ).rows
      const records = async () => {
        const result: unknown[] = []
        for (const table of tables)
          result.push(
            (
              await pool.query(
                `SELECT to_jsonb(t)::text, xmin::text, ctid::text FROM "${table.schema}"."${table.name}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
              )
            ).rows,
          )
        return result
      }
      const before = await records()
      expect(await runMigrations(pool, directory)).toEqual([migration])
      expect(await records()).toEqual(before)
      const [check] = await detailsCheck(pool)
      expect(check?.validated).toBe(true)
      expect(check?.definition).not.toBe(previous[0]?.definition)
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'event_fresh' })
      expect(await snapshotSchema(pool)).toEqual(await snapshotSchema(fresh.pool))
      expect(await detailsCheck(fresh.pool)).toEqual(await detailsCheck(pool))
      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await records()).toEqual(before)

      // The application keeps writing after the upgrade, and the new check holds on both.
      await updateWebhook(ctx, oneWebhook, { isActive: false })
      await deleteWebhook(ctx, oneWebhook)
      await assertAuditEventListProtections(pool)
      await assertAuditEventListProtections(fresh.pool)
    } finally {
      try {
        await fresh?.drop()
        await upgraded?.drop()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  },
  180_000,
)
