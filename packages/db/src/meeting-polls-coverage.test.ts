import { describe, expect, it } from 'vitest'
import { assertMeetingPollProtections } from './meeting-poll-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

const targetKey = (...fks: string[]) =>
  `Referenced by ${fks.join(', ')}: DROP CONSTRAINT fails with 2BP01 while ${fks.length > 1 ? 'those FKs depend' : 'that FK depends'} on its index, so it cannot be removed alone; the primary key already makes it unique`

/** Objects that are not protections on their own; every other object must fail an assertion. */
const allowList: Record<string, string> = {
  'constraint public.meeting_polls.meeting_polls_organization_id_id_key': targetKey(
    'meeting_poll_slots_poll_fk',
    'meeting_poll_voters_poll_fk',
    'meeting_poll_mailbox_counters_poll_fk',
    'meeting_poll_operations_poll_fk',
    'meeting_poll_deliveries_poll_fk',
  ),
  'constraint public.meeting_poll_slots.meeting_poll_slots_organization_id_poll_id_id_key':
    targetKey('meeting_polls_chosen_slot_fk', 'meeting_poll_votes_slot_fk'),
  'constraint public.meeting_poll_voters.meeting_poll_voters_organization_id_poll_id_id_key':
    targetKey(
      'meeting_poll_votes_voter_fk',
      'meeting_poll_capabilities_voter_fk',
      'meeting_poll_deliveries_voter_fk',
    ),
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
