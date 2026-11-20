import type { Db, MeetingPollRow } from '@hourmere/db'
import { meetingPollDeadlineEmail } from '@hourmere/mail'
import { DomainError } from '@hourmere/scheduling/errors'
import { sql } from 'kysely'
import type { MeetingPollEmailDeps } from './meeting-polls.ts'

/** Follow the host order before taking a poll or delivery lock. */
export async function lockMeetingPollDeadlineRecipient(
  db: Db,
  organizationId: string,
  userId: string,
) {
  const { lockMeetingPollManager } = await import('@hourmere/scheduling/meeting-poll-delivery')
  try {
    return await lockMeetingPollManager(db, {
      organization: { id: organizationId },
      user: { id: userId },
    })
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'team_management_access_denied')
      throw error
    return undefined
  }
}

export async function prepareMeetingPollDeadlineMessage(
  db: Db,
  deps: MeetingPollEmailDeps,
  poll: MeetingPollRow,
  recipient: Awaited<ReturnType<typeof lockMeetingPollDeadlineRecipient>>,
) {
  if (!recipient || poll.created_by_user_id !== recipient.userId || poll.status !== 'closed') return
  const { manages } = await import('@hourmere/scheduling/meeting-poll-delivery')
  const event = await db
    .selectFrom('event_types')
    .select('owner_user_id')
    .where('id', '=', poll.event_type_id)
    .where('organization_id', '=', poll.organization_id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  if (!event || !manages(recipient, event.owner_user_id)) return

  const profile = await db
    .selectFrom('profiles')
    .select(['time_zone', 'locale'])
    .where('user_id', '=', recipient.userId)
    .executeTakeFirst()
  const { count } = await db
    .selectFrom('meeting_poll_voters')
    .select(sql<number>`count(*)::int`.as('count'))
    .where('poll_id', '=', poll.id)
    .where('verified_at', 'is not', null)
    .where('withdrawn_at', 'is', null)
    .where('ballot_submitted_at', 'is not', null)
    .executeTakeFirstOrThrow()
  return meetingPollDeadlineEmail({
    to: recipient.email,
    publicUrl: deps.publicUrl,
    organizationId: poll.organization_id,
    pollId: poll.id,
    pollTitle: poll.title,
    deadlineAt: poll.deadline_at,
    responseCount: count,
    timeZone: profile?.time_zone ?? poll.display_time_zone,
    language: profile?.locale,
    defaultLanguage: deps.defaultLanguage,
  })
}
