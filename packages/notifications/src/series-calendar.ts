import {
  calendarSnapshotAttachment,
  calendarSummary,
  type IcsPerson,
  type SeriesEmailMember,
  seriesMemberDescription,
} from '@hourmere/mail'
import { CALENDAR_UID_DOMAIN } from './index.ts'

export interface SeriesCalendarMember extends SeriesEmailMember {
  ordinal: number
  rootId: string
  depth: number
  organizer: IcsPerson
  hasProviderCopy: boolean
}

type SnapshotAction =
  | { kind: 'confirmed' }
  | { kind: 'cancelled'; previouslyDelivered: ReadonlySet<number> }
  | { kind: 'link_update'; previousReportAt: Date | null }

/** The caller supplies current members, or the recipient's changed members for a link update. */
export function seriesCalendarSnapshot(
  action: SnapshotAction,
  members: readonly SeriesCalendarMember[],
  recipient: IcsPerson & { role: 'booker' | 'guest' | 'host'; locale: string | null },
  eventName: string,
  inviteeName: string,
  now: Date,
) {
  const cancelled = action.kind === 'cancelled'
  const included = members.filter((member) => {
    if (member.hasProviderCopy) return false
    if (cancelled)
      return (
        member.state === 'cancelled' &&
        member.affected &&
        action.previouslyDelivered.has(member.ordinal)
      )
    return (
      member.state === 'confirmed' &&
      (action.kind === 'confirmed' || member.conference?.state === 'ready')
    )
  })
  if (!included.length) return { attachment: undefined, ordinals: [] }

  // iCalendar timestamps have one-second precision.
  const latestStamp = Math.floor(now.getTime() / 1000)
  const earliestUpdateStamp =
    action.kind === 'link_update' && action.previousReportAt
      ? Math.floor(action.previousReportAt.getTime() / 1000) + 1
      : latestStamp
  const stamp = Temporal.Instant.fromEpochMilliseconds(
    Math.max(latestStamp, earliestUpdateStamp) * 1000,
  )
  const attachment = calendarSnapshotAttachment(
    included.map((member) => {
      const description = seriesMemberDescription(member, recipient.locale) || undefined
      return {
        uid: `${member.rootId}@${CALENDAR_UID_DOMAIN}`,
        sequence: member.depth + (cancelled ? 1 : 0),
        stamp,
        start: member.start,
        end: member.end,
        status: cancelled ? 'CANCELLED' : 'CONFIRMED',
        summary: calendarSummary(
          eventName,
          recipient.role === 'host' ? inviteeName : member.organizer.name,
          recipient.locale,
        ),
        description,
        location: member.conference?.state === 'ready' ? description : undefined,
        organizer: member.organizer,
        attendees: [{ name: recipient.name, email: recipient.email, rsvp: false }],
      }
    }),
  )
  return { attachment, ordinals: included.map((member) => member.ordinal) }
}
