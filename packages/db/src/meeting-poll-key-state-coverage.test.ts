import { describe, expect, it } from 'vitest'
import { assertMeetingPollKeyStateProtections } from './meeting-poll-key-state-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('meeting poll key state constraint coverage', () => {
  it('fails a protection assertion when any object created by 0084 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0084_meeting_poll_key_state.sql',
      assertions: assertMeetingPollKeyStateProtections,
    })
    expect(report.problems).toEqual([])
    expect(report.objects.map((object) => object.key).sort()).toEqual([
      'constraint public.meeting_poll_key_state.meeting_poll_key_state_fingerprint_length',
      'constraint public.meeting_poll_key_state.meeting_poll_key_state_pkey',
      'constraint public.meeting_poll_key_state.meeting_poll_key_state_singleton',
      'not_null public.meeting_poll_key_state.secret_fingerprint',
      'not_null public.meeting_poll_key_state.updated_at',
    ])
    expect(report.results.map((result) => result.status)).toEqual(Array(5).fill('covered'))
  }, 600_000)
})
