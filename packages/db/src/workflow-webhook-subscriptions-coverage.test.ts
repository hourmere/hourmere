import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import {
  destinationBranch,
  detailsCheckBranches,
  latestDetailsCheckMigration,
} from './audit-details-check-source.ts'
import {
  webhookAuditEvents,
  workflowWebhookAuditEvents,
} from './audit-event-details-protections.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0143_workflow_webhook_subscriptions.sql'
const subscriptionsRefused = { code: '23514', constraint: 'webhooks_events_check' }
const auditDetailsRefused = { code: '23514', constraint: 'audit_events_details_check' }

it('preserves the latest predecessor audit details CASE with only the webhook kind expansion', () => {
  const predecessor = latestDetailsCheckMigration(migration)
  const previous = detailsCheckBranches(predecessor)
  const webhook = destinationBranch(previous.branches, 'webhook.created')
  const bound = "jsonb_array_length(details->'events') BETWEEN 1 AND 6"
  const branchEnd = '        ELSE false END)'
  expect(webhook.text).toContain(bound)
  expect(webhook.text).toContain(branchEnd)

  const expanded = webhook.text
    .replace(bound, "jsonb_array_length(details->'events') BETWEEN 1 AND 7")
    .replace(branchEnd, `          + (details->'events' ? 'workflow.executed')::int\n${branchEnd}`)
  expect(detailsCheckBranches(migration), `widened CASE from ${predecessor}`).toEqual({
    ...previous,
    branches: previous.branches.map((branch) =>
      branch === webhook ? { ...webhook, text: expanded } : branch,
    ),
  })
})

async function insertOrganization(pool: pg.Pool) {
  const organization = randomUUID()
  await pool.query(
    `INSERT INTO auth.organization (id, name, slug, "createdAt")
     VALUES ($1, 'Subscription fixture', $2, now())`,
    [organization, `fixture-${organization}`],
  )
  return organization
}

function insertSubscription(
  pool: pg.Pool,
  organization: string,
  name: string,
  events: readonly string[],
  active = true,
) {
  return pool.query<{ id: string }>(
    `INSERT INTO webhooks (organization_id, url, events, is_active, secret_ciphertext)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [organization, `https://webhooks.example/${name}`, events, active, Buffer.alloc(60, 0xa5)],
  )
}

function insertAudit(
  pool: pg.Pool,
  organization: string,
  action: string,
  targetType: string,
  targetId: string,
  details: object,
  actorType = 'user',
) {
  return pool.query(
    `INSERT INTO audit_events
       (organization_id, actor_type, actor_id, credential_type, action, target_type, target_id, details)
     VALUES ($1, $2, $3, 'none', $4, $5, $6, $7)`,
    [organization, actorType, randomUUID(), action, targetType, targetId, details],
  )
}

function setEvents(pool: pg.Pool, id: string, events: readonly string[]) {
  return pool.query('UPDATE webhooks SET events = $1 WHERE id = $2 RETURNING events', [events, id])
}

async function assertSubscriptionAndAuditChecks(pool: pg.Pool) {
  const organization = await insertOrganization(pool)
  const endpoint = insertSubscription(pool, organization, 'all-events', webhookAuditEvents)
  await expect(endpoint).resolves.toMatchObject({ rowCount: 1 })
  const id = (await endpoint).rows[0]?.id as string
  await expect(setEvents(pool, id, workflowWebhookAuditEvents)).resolves.toMatchObject({
    rows: [{ events: workflowWebhookAuditEvents }],
  })
  for (const events of [
    [],
    [...workflowWebhookAuditEvents, workflowWebhookAuditEvents[0]],
    ['booking.unknown'],
  ]) {
    await expect(setEvents(pool, id, events)).rejects.toMatchObject(subscriptionsRefused)
  }

  const webhookAudit = (events: readonly string[]) =>
    insertAudit(pool, organization, 'webhook.updated', 'webhook', id, { events })
  await expect(webhookAudit(workflowWebhookAuditEvents)).resolves.toMatchObject({ rowCount: 1 })
  for (const events of [
    [],
    ['workflow.executed', 'workflow.executed'],
    ['workflow.executed', 'booking.unknown'],
  ]) {
    await expect(webhookAudit(events)).rejects.toMatchObject(auditDetailsRefused)
  }
  await expect(
    insertAudit(
      pool,
      organization,
      'slack_destination.updated',
      'slack_destination',
      randomUUID(),
      {
        events: ['workflow.executed'],
      },
    ),
  ).rejects.toMatchObject(auditDetailsRefused)
}

async function seedPredecessor(pool: pg.Pool) {
  const organization = await insertOrganization(pool)
  for (const [name, events, active] of [
    [
      'reschedule-requests',
      ['booking.reschedule_requested', 'booking.reschedule_request_expired'],
      true,
    ],
    ['attendee-attendance', ['booking.attendee_no_show_changed'], true],
    ['all-booking-events', webhookAuditEvents, false],
  ] as const) {
    const { rows } = await insertSubscription(pool, organization, name, events, active)
    await insertAudit(pool, organization, 'webhook.created', 'webhook', rows[0]?.id as string, {
      events,
    })
  }
  await insertAudit(
    pool,
    organization,
    'scim_user.updated',
    'scim_user',
    randomUUID(),
    { operations: ['replace', 'add', 'replace'] },
    'scim_token',
  )
}

async function snapshotRows(pool: pg.Pool) {
  return {
    webhooks: (
      await pool.query(
        'SELECT to_jsonb(w) AS row, xmin::text, ctid::text FROM webhooks w ORDER BY id',
      )
    ).rows,
    audit: (
      await pool.query(
        'SELECT to_jsonb(a) AS row, xmin::text, ctid::text FROM audit_events a ORDER BY id',
      )
    ).rows,
  }
}

describe.skipIf(!serverUrl)('workflow webhook subscription migration', () => {
  it('fails protection assertions when either replacement check is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration,
      assertions: assertSubscriptionAndAuditChecks,
    })
    expect(report.problems).toEqual([])
    expect(report.results.map(({ key, status }) => [key, status])).toEqual([
      ['constraint public.audit_events.audit_events_details_check', 'covered'],
      ['constraint public.webhooks.webhooks_events_check', 'covered'],
    ])
  }, 600_000)

  it('preserves existing rows, matches a fresh install and reruns as a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-workflow-webhooks-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql') && file < migration) {
          await copyFile(join(migrationsDir, file), join(directory, file))
        }
      }
      upgraded = await createTestDatabase(serverUrl as string, directory, {
        tag: 'workflow_hook_up',
      })
      await seedPredecessor(upgraded.pool)
      const before = await snapshotRows(upgraded.pool)
      expect(before.webhooks).toHaveLength(3)
      expect(before.audit).toHaveLength(4)

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([migration])
      expect(await snapshotRows(upgraded.pool)).toEqual(before)

      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'workflow_new' })
      expect(await snapshotSchema(fresh.pool)).toEqual(await snapshotSchema(upgraded.pool))
      const ledger = (await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name'))
        .rows
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await snapshotRows(upgraded.pool)).toEqual(before)
      expect(
        (await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(ledger)

      await assertSubscriptionAndAuditChecks(upgraded.pool)
      await assertSubscriptionAndAuditChecks(fresh.pool)
    } finally {
      await Promise.all([
        upgraded?.drop(),
        fresh?.drop(),
        rm(directory, { recursive: true, force: true }),
      ])
    }
  }, 120_000)
})
