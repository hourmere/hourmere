import { type ReactNode, useId } from 'react'
import { TimeZoneName } from '../components/TimeZonePicker.tsx'
import { UserContentList, UserContentMessage } from '../components/UserContent.tsx'
import { isKnownTimeZone } from '../format.ts'
import { formatDuration } from '../i18n/duration.ts'
import { formatList } from '../i18n/formatting.ts'
import { useI18n } from '../i18n/runtime.tsx'
import type { OneTimeBookingPage, PublicEventType, Slot } from './api.ts'
import { locationLabel } from './BookingDetails.tsx'
import { BookingFactIcon } from './BookingFactIcon.tsx'
import type { BookingLocationOption } from './BookingForm.tsx'
import { EventDescription } from './EventDescription.tsx'
import { FocusHeading, HostAvatar } from './PublicLayout.tsx'
import { formatDate, formatTime, formatTimeRange, offsetAt, offsetLabel, zoneName } from './time.ts'

type BookingEvent = PublicEventType | OneTimeBookingPage['eventType']

export function bookingHostTimeZone(event: BookingEvent) {
  return event.schedulingType !== 'round_robin' && !event.hosts ? event.host.timeZone : undefined
}

export function BookingEventInfo({
  event,
  durationMinutes,
  chosenLocation,
  team,
  showHostImage = true,
  headingLevel = 1,
  children,
}: {
  event: BookingEvent
  durationMinutes: number
  chosenLocation: BookingLocationOption | undefined
  team: boolean
  showHostImage?: boolean
  headingLevel?: 1 | 2
  children?: ReactNode
}) {
  const { t, ui, locale: displayLocale } = useI18n()
  const hostTimeZone = bookingHostTimeZone(event)
  const location = chosenLocation ?? event.location
  const Heading = headingLevel === 1 ? 'h1' : 'h2'
  const requiredHosts = event.hosts?.map(({ name, timeZone }) => ({
    name,
    detail: zoneName(timeZone),
  }))
  const requiredHostLabels = requiredHosts?.map((host) => t('{name} ({detail})', host))
  return (
    <aside className="event-info" aria-label={t('About this event')}>
      <Heading className="event-title" dir={event.title ? 'auto' : undefined}>
        {event.title || t('Booking')}
      </Heading>
      <div className="host-identity">
        {!team && (
          <HostAvatar name={event.host.name} image={showHostImage ? event.host.image : undefined} />
        )}
        <p className="event-host" dir="auto">
          {event.team?.name ?? event.host.name}
        </p>
      </div>
      {event.schedulingType === 'round_robin' && (
        <p className="event-description">
          {t('An available team member will be assigned when you book.')}
        </p>
      )}
      {requiredHosts && requiredHostLabels && (
        <p className="event-description">
          <UserContentMessage
            message="Required hosts: {hosts}"
            values={{ hosts: formatList(requiredHostLabels, displayLocale) }}
            renderValues={{
              hosts: (
                <UserContentList
                  values={requiredHostLabels}
                  renderValue={(value, index) => {
                    const host = requiredHosts[index]
                    if (!host) return value
                    return (
                      <UserContentMessage
                        message="{name} ({detail})"
                        values={{ name: host.name }}
                        otherValues={{ detail: host.detail }}
                      />
                    )
                  }}
                />
              ),
            }}
          />
        </p>
      )}
      <ul className="event-facts">
        <li>
          <BookingFactIcon name="clock" />
          <span>{formatDuration(durationMinutes, displayLocale)}</span>
        </li>
        {location && (
          <li>
            <BookingFactIcon name="pin" />
            <span className="user-content" dir={chosenLocation?.label == null ? undefined : 'auto'}>
              {chosenLocation?.label ?? ui(locationLabel(location.kind))}
            </span>
          </li>
        )}
        {hostTimeZone && (
          <li className="user-content">
            <BookingFactIcon name="globe" />
            <TimeZoneName
              className="host-time-zone"
              name={zoneName(hostTimeZone)}
              label={t("Host's time zone: {zone}", { zone: zoneName(hostTimeZone) })}
            />
          </li>
        )}
      </ul>
      {event.description && <EventDescription>{event.description}</EventDescription>}
      {children}
    </aside>
  )
}

export function BookingSelectedTime({
  slot,
  hostTimeZone,
  timeZone,
  locale,
  directFlow = false,
  submitting = false,
  onChangeTime,
}: {
  slot: Slot
  hostTimeZone: string | undefined
  timeZone: string
  locale: string
  directFlow?: boolean
  submitting?: boolean
  onChangeTime: () => void
}) {
  const { t } = useI18n()
  // Keep the breakable space and opening bracket outside the no-wrap numeric offset.
  const chosenOffset = offsetLabel(timeZone, Date.parse(slot.start))
  const chosenZoneLabel = t(' ({offset})', { offset: chosenOffset })
  const chosenOffsetAt = chosenZoneLabel.lastIndexOf(chosenOffset)

  return (
    <div className="chosen-time">
      {directFlow ? (
        <p>
          {[slot.start, slot.end].map((instant, index) => (
            <span key={instant}>
              {index > 0 && (
                <>
                  <br />
                  <span aria-hidden="true">– </span>
                </>
              )}
              <time dateTime={instant}>
                {t('{date}, {time}', {
                  date: formatDate(Date.parse(instant), timeZone, locale),
                  time: formatTime(Date.parse(instant), timeZone, locale),
                })}
              </time>
              <span className="muted">
                {t(' ({zone}, {offset})', {
                  zone: zoneName(timeZone),
                  offset: offsetLabel(timeZone, Date.parse(instant)),
                })}
              </span>
            </span>
          ))}
        </p>
      ) : (
        <p>
          <strong>{formatDate(Date.parse(slot.start), timeZone, locale)}</strong>
          <br />
          {formatTimeRange(Date.parse(slot.start), Date.parse(slot.end), timeZone, locale)}
          <br />
          <span className="muted">
            {zoneName(timeZone)}
            {chosenZoneLabel.slice(0, chosenOffsetAt)}
            <span className="time-offset">{chosenZoneLabel.slice(chosenOffsetAt)}</span>
          </span>
        </p>
      )}
      {hostTimeZone &&
        isKnownTimeZone(hostTimeZone) &&
        offsetAt(Date.parse(slot.start), hostTimeZone) !==
          offsetAt(Date.parse(slot.start), timeZone) && (
          <p className="host-local-time user-content">
            {t("That's {time} for the host", {
              time: t('{date}, {time}', {
                date: formatDate(Date.parse(slot.start), hostTimeZone, locale),
                time: formatTime(Date.parse(slot.start), hostTimeZone, locale),
              }),
            })}
          </p>
        )}
      <button
        type="button"
        className="button button-small"
        onClick={onChangeTime}
        disabled={submitting}
      >
        {t('Change time')}
      </button>
    </div>
  )
}

export function BookingOptions({
  event,
  durationMinutes,
  locationOptionId,
  onLocationChange,
  onDurationChange,
  showWaitlistHint = false,
  scoped = false,
}: {
  event: BookingEvent
  durationMinutes: number
  locationOptionId: string | undefined
  onLocationChange: (id: string) => void
  onDurationChange: (minutes: number) => void
  showWaitlistHint?: boolean
  scoped?: boolean
}) {
  const id = useId()
  const prefix = scoped ? `${id}-` : ''
  const { t, ui, locale: displayLocale } = useI18n()

  return (
    <>
      {(event.locations?.length ?? 0) > 1 && (
        <fieldset className="duration-picker">
          <legend>{t('Meeting location')}</legend>
          <div className="duration-options">
            {event.locations?.map((option) => (
              <label key={option.id} className="duration-option">
                <input
                  type="radio"
                  name={`${prefix}slotLocation`}
                  value={option.id}
                  checked={locationOptionId === option.id}
                  onChange={() => onLocationChange(option.id)}
                />
                <span dir={option.label == null ? undefined : 'auto'}>
                  {option.label ?? ui(locationLabel(option.kind))}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {(event.allowedDurationsMinutes?.length ?? 0) > 1 && (
        <fieldset className="duration-picker">
          <legend>{t('Meeting length')}</legend>
          <div className="duration-options">
            {event.allowedDurationsMinutes?.map((minutes) => (
              <label key={minutes} className="duration-option">
                <input
                  type="radio"
                  name={`${prefix}durationMinutes`}
                  value={minutes}
                  checked={durationMinutes === minutes}
                  onChange={() => onDurationChange(minutes)}
                />
                <span>{formatDuration(minutes, displayLocale)}</span>
              </label>
            ))}
          </div>
          {showWaitlistHint && durationMinutes !== event.durationMinutes && (
            <p className="hint">
              {t('To join the waitlist, choose the default meeting length ({duration}).', {
                duration: formatDuration(event.durationMinutes, displayLocale),
              })}
            </p>
          )}
        </fieldset>
      )}
    </>
  )
}

export function BookingDetailsStep({
  children,
  headingId,
}: {
  children: ReactNode
  headingId?: string
}) {
  const generatedId = useId()
  const id = headingId ?? generatedId
  const { t } = useI18n()
  return (
    <section className="details-step" aria-labelledby={id}>
      <FocusHeading level={2} id={id} className="step-title">
        {t('Your details')}
      </FocusHeading>
      {children}
    </section>
  )
}
