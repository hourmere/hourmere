import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seriesBookingEmail } from '@hourmere/mail'
import {
  buildIcs,
  calendarBookingDescription,
  calendarResponseDescription,
  calendarSummary,
  type IcsAttendee,
} from '@hourmere/mail/ics'
import { CALENDAR_UID_DOMAIN } from '../packages/notifications/src/index.ts'
import {
  type SeriesCalendarMember,
  seriesCalendarSnapshot,
} from '../packages/notifications/src/series-calendar.ts'

const publicUrl = 'https://calendar-check.invalid'
const organizer = { name: 'Test Host', email: 'calendar@calendar-check.invalid' }
const attendee = { name: 'Test Booker', email: 'booker@calendar-check.invalid' }
const recipient = { ...attendee, role: 'booker', locale: null } as const
const ordinaryAttendees: readonly IcsAttendee[] = [
  { name: organizer.name, email: 'host@calendar-check.invalid', role: 'CHAIR' },
  { ...attendee, partstat: 'NEEDS-ACTION' },
]
const eventName = 'Calendar import check'
const firstStart = Temporal.Instant.from('2030-01-07T10:00:00Z')
const confirmationStamp = Temporal.Instant.from('2030-01-06T08:00:00Z')
const pending = new Set([2, 5])
const ready = (ordinal: number) => ({
  state: 'ready' as const,
  url: `${publicUrl}/meet/${ordinal}`,
})

function snapshot(
  action: Parameters<typeof seriesCalendarSnapshot>[0],
  members: readonly SeriesCalendarMember[],
  elapsedHours: number,
) {
  const { attachment, ordinals } = seriesCalendarSnapshot(
    action,
    members,
    recipient,
    eventName,
    attendee.name,
    new Date(confirmationStamp.add({ hours: elapsedHours }).epochMilliseconds),
  )
  if (!attachment) throw new Error(`Missing synthetic ${action.kind} attachment`)
  return { content: attachment.content, ordinals }
}

export function generateSeriesCalendarFixtures(): Readonly<Record<string, string>> {
  const series = (scenario: 'changes' | 'cancel') =>
    Array.from({ length: 12 }, (_, index): SeriesCalendarMember => {
      const start = firstStart.add({ hours: 7 * 24 * index })
      const ordinal = index + 1
      return {
        ordinal,
        rootId: `synthetic-series-${scenario}-${ordinal}`,
        depth: 0,
        start,
        end: start.add({ minutes: 30 }),
        state: 'confirmed',
        conference: pending.has(ordinal) ? { state: 'pending' } : ready(ordinal),
        organizer,
        hasProviderCopy: false,
      }
    })
  const changes = series('changes')
  const linkUpdate = changes
    .filter(({ ordinal }) => pending.has(ordinal))
    .map((member) => ({ ...member, conference: ready(member.ordinal) }))
  const moved = changes[5]
  if (!moved) throw new Error('Missing synthetic occurrence to move')
  const move = buildIcs({
    method: 'REQUEST',
    uid: `${moved.rootId}@${CALENDAR_UID_DOMAIN}`,
    sequence: moved.depth + 1,
    stamp: confirmationStamp.add({ hours: 2 }),
    start: moved.start.add({ hours: 2 }),
    end: moved.end.add({ hours: 2 }),
    summary: calendarSummary(eventName, organizer.name),
    description: [
      calendarBookingDescription(organizer.name),
      calendarResponseDescription('invitee'),
    ].join('\n\n'),
    location: ready(moved.ordinal).url,
    organizer,
    attendees: ordinaryAttendees,
  })

  // This recipient previously received eleven entries. The twelfth date appears only in the
  // cancellation body, even though it was one of the three affected by the tail cancellation.
  const tailSeries = series('cancel')
  const delivered = snapshot({ kind: 'confirmed' }, tailSeries.slice(0, 11), 0)
  const cancellation = tailSeries.map((member): SeriesCalendarMember => {
    if (member.ordinal < 10) return member
    const { conference: _, ...affected } = member
    return { ...affected, state: 'cancelled', affected: true }
  })
  const cancelledMail = seriesBookingEmail(
    'cancelled',
    {
      publicUrl,
      eventName,
      hostName: organizer.name,
      inviteeName: attendee.name,
      members: cancellation,
    },
    { role: 'booker', email: attendee.email, timeZone: 'UTC', token: 'synthetic' },
  )
  return {
    'confirmation.ics': snapshot({ kind: 'confirmed' }, changes, 0).content,
    'link-update.ics': snapshot(
      { kind: 'link_update', previousReportAt: new Date(confirmationStamp.epochMilliseconds) },
      linkUpdate,
      1,
    ).content,
    'single-move.ics': move,
    'tail-confirmation.ics': delivered.content,
    'tail-cancel.ics': snapshot(
      { kind: 'cancelled', previouslyDelivered: new Set(delivered.ordinals) },
      cancellation,
      3,
    ).content,
    'tail-cancel.txt': cancelledMail.text,
  }
}

if (import.meta.main) {
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-calendar-check-'))
  for (const [filename, content] of Object.entries(generateSeriesCalendarFixtures())) {
    writeFileSync(join(directory, filename), content, { flag: 'wx' })
  }
  process.stdout.write(`${directory}\n`)
}
