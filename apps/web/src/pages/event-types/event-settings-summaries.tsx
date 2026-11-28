import { Fragment, type ReactNode } from 'react'
import type { Schedule } from '../../api/resources.ts'
import { parseWhole } from '../../components/forms.tsx'
import { UserContentMessage } from '../../components/UserContent.tsx'
import { formatMinutes } from '../../i18n/duration.ts'
import type { useI18n } from '../../i18n/runtime.tsx'
import { locationLabel } from '../../public/BookingDetails.tsx'
import { type EventTypeDraft, orderedLocations } from './event-type-form.ts'

const schedulingLabels = {
  individual: 'Individual',
  collective: 'Collective',
  round_robin: 'Round robin',
} as const

export type EventSettingsSummary = string | { text: string; content: ReactNode }

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
  const separator = locale === 'zh-CN' ? '；' : ' · '
  const join = (...parts: (string | false | null)[]) => parts.filter(Boolean).join(separator)
  const minutes = (value: number) => formatMinutes(value, locale)
  const locations = orderedLocations(draft)
  const primaryLocation = locations.find((location) => location.id === draft.primaryLocationId)
  const defaultLocation = locations.find((location) => location.isDefault) ?? locations[0]
  function locationName(
    location: (typeof locations)[number],
    isDefault = false,
  ): EventSettingsSummary {
    const label = location.label?.trim()
    const name = label || ui(locationLabel(location.kind))
    const text = isDefault ? t('{value} (default location)', { value: name }) : name
    if (!label) return text
    return {
      text,
      content: isDefault ? (
        <UserContentMessage message="{value} (default location)" values={{ value: label }} />
      ) : (
        <bdi>{label}</bdi>
      ),
    }
  }
  function joinSummary(...input: EventSettingsSummary[]): EventSettingsSummary {
    const parts = input.filter(Boolean)
    const text = parts.map((part) => (typeof part === 'string' ? part : part.text)).join(separator)
    if (parts.every((part) => typeof part === 'string')) return text
    return {
      text,
      content: parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: segments display the current ordered draft and hold no state
        <Fragment key={index}>
          {index > 0 && separator}
          {typeof part === 'string' ? part : part.content}
        </Fragment>
      )),
    }
  }
  const duration = positiveWhole(draft.durationMinutes)
  const seats = positiveWhole(draft.groupCapacity)
  const hosts = draft.hostUserIds.length
  const questions = draft.questions.length
  const reminders = draft.notifications.reminders.length
  const followUps = draft.notifications.followUps.length
  const redirectParameters = draft.successRedirectParameters.length
  const redirect = draft.successRedirectUrl.trim()
  const redirectHost = redirect && redirectHostname(redirect)
  const scheduleName = draft.scheduleId
    ? schedules.find((option) => option.id === draft.scheduleId)?.name
    : schedules.find((option) => option.isDefault)?.name
  const schedule: EventSettingsSummary =
    !ownSchedule || draft.schedulingType !== 'individual'
      ? t('Host availability')
      : scheduleName === undefined
        ? t(draft.scheduleId ? 'A schedule that no longer exists' : 'No default schedule')
        : scheduleName && { text: scheduleName, content: <bdi>{scheduleName}</bdi> }
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
    basics: joinSummary(
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
        : joinSummary(
            ...locations.map((location) =>
              locationName(location, locations.length > 1 && location === defaultLocation),
            ),
            locations.some((location) => 'autoCreate' in location && location.autoCreate)
              ? t('Automatic meeting links')
              : '',
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
    timing: joinSummary(schedule, timingSummary || t('Default timing rules')),
  }
}
