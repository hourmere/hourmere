import type { Schedule } from '../../api/resources.ts'
import { parseWhole } from '../../components/forms.tsx'
import { formatMinutes } from '../../i18n/duration.ts'
import type { useI18n } from '../../i18n/runtime.tsx'
import { locationLabel } from '../../public/BookingDetails.tsx'
import { type EventTypeDraft, orderedLocations } from './event-type-form.ts'

const schedulingLabels = {
  individual: 'Individual',
  collective: 'Collective',
  round_robin: 'Round robin',
} as const

function positiveWhole(value: string) {
  const number = parseWhole(value)
  return number !== null && Number.isSafeInteger(number) && number > 0 ? number : null
}

function redirectHostname(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Display the current draft, including settings in closed groups. */
export function eventSettingsSummaries(
  draft: EventTypeDraft,
  schedules: Schedule[],
  ownSchedule: boolean,
  { t, ui, locale }: Pick<ReturnType<typeof useI18n>, 't' | 'ui' | 'locale'>,
) {
  const join = (...parts: (string | false | null)[]) =>
    parts.filter(Boolean).join(locale === 'zh-CN' ? '；' : ' · ')
  const minutes = (value: number) => formatMinutes(value, locale)
  const locations = orderedLocations(draft)
  const primaryLocation = locations.find((location) => location.id === draft.primaryLocationId)
  const defaultLocation = locations.find((location) => location.isDefault) ?? locations[0]
  const locationName = (location: (typeof locations)[number]) =>
    location.label?.trim() || ui(locationLabel(location.kind))
  const duration = positiveWhole(draft.durationMinutes)
  const seats = positiveWhole(draft.groupCapacity)
  const hosts = draft.hostUserIds.length
  const questions = draft.questions.length
  const reminders = draft.notifications.reminders.length
  const followUps = draft.notifications.followUps.length
  const redirectParameters = draft.successRedirectParameters.length
  const redirect = draft.successRedirectUrl.trim()
  const redirectHost = redirect && redirectHostname(redirect)
  const schedule =
    ownSchedule && draft.schedulingType === 'individual'
      ? draft.scheduleId
        ? (schedules.find((option) => option.id === draft.scheduleId)?.name ??
          t('A schedule that no longer exists'))
        : (schedules.find((option) => option.isDefault)?.name ?? t('No default schedule'))
      : t('Host availability')
  const timing = (value: string, label: Parameters<typeof t>[0], multiplier = 1) => {
    const amount = positiveWhole(value)
    return amount === null ? null : t(label, { value: minutes(amount * multiplier) })
  }
  const limit = (value: string, label: Parameters<typeof t>[0]) => {
    const count = positiveWhole(value)
    return count === null ? null : t(label, { count })
  }
  const timingSummary = join(
    timing(draft.slotStepMinutes, 'Starts every {value}'),
    timing(draft.minimumNoticeMinutes, '{value} notice'),
    timing(draft.bookingWindowDays, '{value} booking window', 1440),
    timing(draft.bufferBeforeMinutes, '{value} buffer before'),
    timing(draft.bufferAfterMinutes, '{value} buffer after'),
    limit(draft.maxBookingsPerDay, 'Daily limit {count}'),
    limit(draft.maxBookingsPerWeek, 'Weekly limit {count}'),
    limit(draft.maxBookingsPerMonth, 'Monthly limit {count}'),
    timing(draft.rescheduleCutoffMinutes, '{value} reschedule deadline'),
    timing(draft.cancelCutoffMinutes, '{value} cancellation deadline'),
  )

  return {
    basics: join(
      duration === null ? t('Duration not set') : minutes(duration),
      primaryLocation ? locationName(primaryLocation) : t('No location'),
    ),
    visibility: join(
      t(draft.isActive ? 'Active' : 'Inactive'),
      t(draft.isHidden ? 'Unlisted' : 'Listed'),
      t(draft.description.trim() ? 'Description added' : 'No description'),
      draft.position.trim() !== '' && t('Position {value}', { value: draft.position.trim() }),
    ),
    group:
      draft.bookingMode === 'group'
        ? seats === null
          ? t('Group: multiple invitees per session')
          : t('{count} seats per session', { count: seats })
        : t('One invitee per session'),
    durations:
      draft.allowedDurationsMinutes.length <= 1
        ? t('No additional durations')
        : join(...draft.allowedDurationsMinutes.map(minutes)),
    hosts: join(
      t(schedulingLabels[draft.schedulingType]),
      t(hosts === 1 ? '{count} host selected' : '{count} hosts selected', { count: hosts }),
    ),
    locations:
      locations.length === 0
        ? t('No location')
        : join(
            ...locations.map((location) => {
              const name = locationName(location)
              return locations.length > 1 && location === defaultLocation
                ? t('{value} (default location)', { value: name })
                : name
            }),
            locations.some((location) => 'autoCreate' in location && location.autoCreate) &&
              t('Automatic meeting links'),
          ),
    waitlist: t(draft.waitlistEnabled ? 'Enabled' : 'Disabled'),
    notifications: join(
      t(reminders === 1 ? '{count} reminder' : '{count} reminders', { count: reminders }),
      t(followUps === 1 ? '{count} follow-up' : '{count} follow-ups', { count: followUps }),
      draft.smsRemindersEnabled && t('SMS reminders'),
    ),
    bookingForm: join(
      t(questions === 1 ? '{count} question' : '{count} questions', { count: questions }),
      t(draft.allowGuests ? 'Guests allowed' : 'Guests off'),
    ),
    afterBooking: redirect
      ? join(
          redirectHost ? t('Continue to {value}', { value: redirectHost }) : t('URL entered'),
          redirectParameters > 0 &&
            t(redirectParameters === 1 ? '{count} URL parameter' : '{count} URL parameters', {
              count: redirectParameters,
            }),
          draft.includeInviteePersonalData && t('Invitee name and email allowed'),
          draft.allowEmbedParent && t('Can open embed parent'),
        )
      : t('Booking confirmation'),
    timing: join(schedule, timingSummary || t('Default timing rules')),
  }
}
