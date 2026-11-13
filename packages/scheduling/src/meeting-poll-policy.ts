import { MAX_GUESTS } from './bookings.ts'

/** Shared admission contract for future poll services; no admission surface is enabled here. */
export const MEETING_POLL_LIMITS = {
  minCandidates: 2,
  maxCandidates: 20,
  maxEnrollments: 40,
  minAttendees: 1,
  maxAttendees: MAX_GUESTS + 1,
  pendingExpirySeconds: 60 * 60,
  maxPendingPerIp: 3,
  minDeadlineSeconds: 60 * 60,
  maxDeadlineSeconds: 30 * 24 * 60 * 60,
  reminderLeadSeconds: 24 * 60 * 60,
  resendCooldownSeconds: 15 * 60,
  maxResendsPerMailbox: 3,
  recoveryCooldownSeconds: 15 * 60,
  maxRecoveriesPerCredential: 3,
  requestWindowSeconds: 60,
  admissionRequestsPerWindow: 10,
  readRequestsPerWindow: 120,
  ballotRequestsPerWindow: 30,
} as const

/** Cleanup worker contract, implemented in the later cleanup/delivery steps. */
export const MEETING_POLL_RETENTION = {
  sweepSeconds: 60 * 60,
  batchSize: 500,
  deletedReceiptDays: 90,
  deliveryMaxAttempts: 5,
  deliveryLeaseSeconds: 5 * 60,
} as const
