import { describe, expect, it } from 'vitest'
import { assertMeetingPollReceiptTombstoneProtections } from './meeting-poll-receipt-tombstones-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('meeting poll receipt tombstone coverage', () => {
  it('fails a protection assertion when any object redefined by 0088 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0088_meeting_poll_receipt_tombstones.sql',
      assertions: assertMeetingPollReceiptTombstoneProtections,
    })
    expect(report.problems).toEqual([])
    expect(report.objects.map((object) => object.key)).toEqual([
      'trigger public.meeting_polls.meeting_polls_tombstones',
    ])
    expect(report.results.map((result) => result.status)).toEqual(['covered'])
  }, 600_000)
})
