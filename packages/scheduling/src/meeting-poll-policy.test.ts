import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_GUESTS } from './bookings.ts'
import { MEETING_POLL_LIMITS, MEETING_POLL_RETENTION } from './meeting-poll-policy.ts'

const source = readFileSync(new URL('./meeting-poll-policy.ts', import.meta.url), 'utf8')
const expected = {
  minCandidates: 2,
  maxCandidates: 20,
  maxEnrollments: 40,
  minAttendees: 1,
  maxAttendees: MAX_GUESTS + 1,
  pendingExpirySeconds: 3600,
  maxPendingPerIp: 3,
  minDeadlineSeconds: 3600,
  maxDeadlineSeconds: 2592000,
  reminderLeadSeconds: 86400,
  resendCooldownSeconds: 900,
  maxResendsPerMailbox: 3,
  recoveryCooldownSeconds: 900,
  maxRecoveriesPerCredential: 3,
  requestWindowSeconds: 60,
  admissionRequestsPerWindow: 10,
  readRequestsPerWindow: 120,
  ballotRequestsPerWindow: 30,
}
const retention = {
  sweepSeconds: 3600,
  batchSize: 500,
  deletedReceiptDays: 90,
  deliveryMaxAttempts: 5,
  deliveryLeaseSeconds: 300,
}

function verify(copy: string) {
  const body = copy
    .replace(/^import .*\n/m, '')
    .replaceAll('export const ', 'const ')
    .replaceAll(' as const', '')
  const policy = new Function(
    'MAX_GUESTS',
    `${body}; return { limits: MEETING_POLL_LIMITS, retention: MEETING_POLL_RETENTION }`,
  )(MAX_GUESTS)
  expect(policy.limits).toEqual(expected)
  expect(policy.retention).toEqual(retention)
}

describe('meeting poll admission and cleanup contract', () => {
  it('pins the initial limits and bounded cleanup schedule', () => {
    expect(MEETING_POLL_LIMITS).toEqual(expected)
    expect(MEETING_POLL_RETENTION).toEqual(retention)
    expect(MEETING_POLL_LIMITS.maxEnrollments * MEETING_POLL_LIMITS.maxCandidates).toBe(800)
    verify(source)
  })

  it.each(Object.keys({ ...expected, ...retention }))(
    'rejects a changed %s in a source copy',
    (key) => {
      const pattern = new RegExp(`(${key}: )[^,]+,`)
      expect(source).toMatch(pattern)
      const changed = source.replace(pattern, '$199999,')
      expect(changed).not.toBe(source)
      expect(() => verify(changed)).toThrowError(
        expect.objectContaining({ name: 'AssertionError' }),
      )
      verify(source)
    },
  )
})
