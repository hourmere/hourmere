import type { Selectable } from 'kysely'
import type {
  MeetingPollCapabilities,
  MeetingPollDeliveries,
  MeetingPollMailboxCounters,
  MeetingPollOperations,
  MeetingPollSlots,
  MeetingPolls,
  MeetingPollVoters,
  MeetingPollVotes,
} from './tables.ts'

/** Stored rows, including database-assigned defaults and resolved timestamps. */
export type MeetingPollRow = Selectable<MeetingPolls>
export type MeetingPollSlotRow = Selectable<MeetingPollSlots>
export type MeetingPollVoterRow = Selectable<MeetingPollVoters>
export type MeetingPollVoteRow = Selectable<MeetingPollVotes>
export type MeetingPollCapabilityRow = Selectable<MeetingPollCapabilities>
export type MeetingPollMailboxCounterRow = Selectable<MeetingPollMailboxCounters>
export type MeetingPollOperationRow = Selectable<MeetingPollOperations>
export type MeetingPollDeliveryRow = Selectable<MeetingPollDeliveries>
