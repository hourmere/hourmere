import { describe, expect, it } from 'vitest'
import { assertMeetingPollProtections } from './meeting-poll-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

const impliedOrganization = (via: string) =>
  `Redundant with ${via}, whose parent row has the same organization and cascades its deletion`
const targetKey =
  'FK target of the scoped composite FKs; the primary key already makes it unique, and it cannot be dropped while they exist'

/** Objects that are not protections on their own; every other object must fail an assertion. */
const allowList: Record<string, string> = {
  'constraint public.meeting_polls.meeting_polls_organization_id_fkey': impliedOrganization(
    'meeting_polls_event_fk (event types cascade from their organization)',
  ),
  'constraint public.meeting_poll_slots.meeting_poll_slots_organization_id_fkey':
    impliedOrganization('meeting_poll_slots_poll_fk'),
  'constraint public.meeting_poll_voters.meeting_poll_voters_organization_id_fkey':
    impliedOrganization('meeting_poll_voters_poll_fk'),
  'constraint public.meeting_poll_votes.meeting_poll_votes_organization_id_fkey':
    impliedOrganization('meeting_poll_votes_voter_fk'),
  'constraint public.meeting_poll_capabilities.meeting_poll_capabilities_organization_id_fkey':
    impliedOrganization('meeting_poll_capabilities_voter_fk'),
  'constraint public.meeting_poll_mailbox_counters.meeting_poll_mailbox_counters_organization_id_fkey':
    impliedOrganization('meeting_poll_mailbox_counters_poll_fk'),
  'constraint public.meeting_poll_deliveries.meeting_poll_deliveries_organization_id_fkey':
    impliedOrganization('meeting_poll_deliveries_poll_fk'),
  'constraint public.meeting_polls.meeting_polls_organization_id_id_key': targetKey,
  'constraint public.meeting_poll_slots.meeting_poll_slots_organization_id_poll_id_id_key':
    targetKey,
  'constraint public.meeting_poll_voters.meeting_poll_voters_organization_id_poll_id_id_key':
    targetKey,
}

describe.skipIf(!serverUrl)('meeting poll constraint coverage', () => {
  it('fails a protection assertion when any object created by 0071 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0071_meeting_polls.sql',
      assertions: assertMeetingPollProtections,
      allowList,
    })
    expect(report.problems).toEqual([])
    expect(report.results.filter((result) => result.status === 'covered')).toHaveLength(
      report.objects.length - Object.keys(allowList).length,
    )
  }, 600_000)
})
