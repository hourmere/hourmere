import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  destinationBranch,
  detailsCheckBranches,
  latestDetailsCheckMigration,
} from '../../db/src/audit-details-check-source.ts'
import {
  slackAuditActions,
  slackAuditEvents,
  webhookAuditActions,
  webhookAuditEvents,
} from '../../db/src/audit-event-details-protections.ts'
import { WEBHOOK_EVENTS } from './service.ts'
import { SLACK_EVENTS } from './slack-format.ts'

// The database checks what a webhook or Slack destination audit event's `events` holds
// against copies of the code's catalogues. Adding, removing or renaming an event type, or
// changing a subscription limit, fails here until a new migration updates the check.
const destinations = [
  {
    name: 'webhook',
    firstAction: 'webhook.created',
    catalogue: WEBHOOK_EVENTS,
    actions: webhookAuditActions,
    suite: webhookAuditEvents,
    // The application's own limits, as written in the validation code.
    source: ['./service.ts', 'z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length)'],
  },
  {
    name: 'Slack',
    firstAction: 'slack_destination.created',
    catalogue: SLACK_EVENTS,
    actions: slackAuditActions,
    suite: slackAuditEvents,
    source: ['./slack.ts', '.array(z.enum(SLACK_EVENTS))\n  .min(1)\n  .max(SLACK_EVENTS.length)'],
  },
] as const

/** The event names and the upper bound that a destination branch of the check admits. */
function admitted(firstAction: string) {
  const { branches } = detailsCheckBranches(latestDetailsCheckMigration())
  const text = destinationBranch(branches, firstAction).text
  return {
    names: [...text.matchAll(/\(details->'events' \? '([^']*)'\)::int/g)].map((match) => match[1]),
    bounds: [
      ...text.matchAll(/jsonb_array_length\(details->'events'\) BETWEEN (\d+) AND (\d+)/g),
    ].map((match) => [Number(match[1]), Number(match[2])]),
  }
}

describe('audit event catalogues', () => {
  it.each(destinations)(
    'binds the $name branch of the details check to the code',
    (destination) => {
      const { names, bounds } = admitted(destination.firstAction)
      expect(names, 'one sum term per catalogue name').toHaveLength(new Set(names).size)
      expect([...names].sort()).toEqual([...destination.catalogue].sort())
      expect(bounds).toEqual([[1, destination.catalogue.length]])
      expect([...destination.suite]).toEqual([...destination.catalogue])
      const [file, limits] = destination.source
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toContain(limits)
    },
  )

  describe.skipIf(!process.env.DATABASE_URL)('on a migrated database', () => {
    let owned: TestDatabase
    beforeAll(async () => {
      owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
        tag: 'event_catalogue',
      })
    })
    afterAll(async () => {
      await owned?.drop()
    })
    const insert = (action: string, events: unknown) =>
      owned.pool.query(
        `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
         VALUES ('system', 'catalogue', 'none', $1, 'test', $2, $3::jsonb)`,
        [action, randomUUID(), JSON.stringify({ events })],
      )

    it.each(destinations)(
      'admits every $name event the code can subscribe to',
      async (destination) => {
        for (const action of destination.actions) {
          await expect(insert(action, [...destination.catalogue].sort())).resolves.toMatchObject({
            rowCount: 1,
          })
          for (const event of destination.catalogue)
            await expect(insert(action, [event]), `${action} ${event}`).resolves.toMatchObject({
              rowCount: 1,
            })
        }
      },
    )

    it('refuses for Slack every webhook event that Slack does not post', async () => {
      const webhookOnly = WEBHOOK_EVENTS.filter(
        (event) => !(SLACK_EVENTS as readonly string[]).includes(event),
      )
      for (const action of slackAuditActions)
        for (const event of webhookOnly)
          await expect(insert(action, [event]), `${action} ${event}`).rejects.toMatchObject({
            code: '23514',
            constraint: 'audit_events_details_check',
          })
    })
  })
})
