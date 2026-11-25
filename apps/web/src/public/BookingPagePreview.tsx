import { useCallback, useId, useState } from 'react'
import { PreviewLanguage, useI18n } from '../i18n/runtime.tsx'
import type { PublicEventType, Slot, SlotLoader } from './api.ts'
import { BookingForm, type BookingFormValues, selectedLocation } from './BookingForm.tsx'
import {
  BookingDetailsStep,
  BookingEventInfo,
  BookingOptions,
  BookingSelectedTime,
  bookingHostTimeZone,
} from './BookingPageParts.tsx'
import { monthOf } from './calendar.ts'
import { now as currentTime, detectTimeZone, preferredLocale } from './env.ts'
import { PublicPreviewLayout } from './PublicLayout.tsx'
import { SlotPicker, type SlotPickerPosition } from './SlotPicker.tsx'
import { dateKeyIn } from './time.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR

function sampleSlot(start: number, duration: number): Slot {
  return {
    start: new Date(start).toISOString(),
    end: new Date(start + duration * 60_000).toISOString(),
  }
}

function sampleSlots(start: number, end: number, duration: number): Slot[] {
  const slots: Slot[] = []
  for (let day = Math.floor(start / DAY) * DAY; day < end; day += DAY) {
    const weekday = new Date(day).getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    for (const hour of [14, 16, 18]) {
      const instant = day + hour * HOUR
      if (instant >= start && instant + duration * 60_000 <= end) {
        slots.push(sampleSlot(instant, duration))
      }
    }
  }
  return slots
}

interface BookingPagePreviewProps {
  event: PublicEventType
  logoSrc?: string | undefined
}

/** An isolated booking flow with a local slot source and no submission capability. */
export function BookingPagePreview(props: BookingPagePreviewProps) {
  return (
    <PreviewLanguage>
      <PreviewBookingFlow {...props} />
    </PreviewLanguage>
  )
}

function PreviewBookingFlow({ event, logoSrc }: BookingPagePreviewProps) {
  const { t, formatLocale } = useI18n()
  const locale = formatLocale ?? preferredLocale()
  const noticeId = useId()
  const [now] = useState(currentTime)
  const [timeZone, setTimeZone] = useState(detectTimeZone)
  const [position, setPosition] = useState<SlotPickerPosition | null>(() => {
    const first = sampleSlots(now, now + 7 * DAY, event.durationMinutes)[0]
    if (!first) return null
    const day = dateKeyIn(Date.parse(first.start), timeZone)
    return { month: monthOf(day), day }
  })
  const [values, setValues] = useState<Omit<BookingFormValues, 'locationOptionId'>>({
    name: '',
    email: '',
    guests: [],
    answers: {},
  })
  const [durationChoice, setDurationChoice] = useState<{ default: number; minutes: number }>()
  const [locationChoice, setLocationChoice] = useState<{
    defaultId: string | undefined
    id: string
  }>()
  const [selectedStart, setSelectedStart] = useState<number | null>(null)
  const [returningToPicker, setReturningToPicker] = useState(false)
  const duration =
    durationChoice?.default === event.durationMinutes &&
    event.allowedDurationsMinutes?.includes(durationChoice.minutes)
      ? durationChoice.minutes
      : event.durationMinutes
  const locations = event.locations ?? []
  const defaultLocation = selectedLocation(locations)
  const chosenLocation =
    (locationChoice && locationChoice.defaultId === defaultLocation?.id
      ? selectedLocation(locations, locationChoice.id)
      : undefined) ?? defaultLocation
  const slot = selectedStart === null ? null : sampleSlot(selectedStart, duration)
  const load = useCallback<SlotLoader>(
    async (start, end) => sampleSlots(Date.parse(start), Date.parse(end), duration),
    [duration],
  )

  function changeTime() {
    setSelectedStart(null)
    setReturningToPicker(true)
  }

  function chooseLocation(id: string) {
    setLocationChoice({ defaultId: defaultLocation?.id, id })
  }

  return (
    <PublicPreviewLayout branding={event.branding} logoSrc={logoSrc}>
      <p className="alert alert-info preview-booking-notice" id={noticeId}>
        {t('These are sample times. Booking is disabled in the preview.')}
      </p>
      <div className="booking-layout">
        <BookingEventInfo
          event={event}
          team={!!event.team}
          durationMinutes={duration}
          chosenLocation={chosenLocation}
          headingLevel={2}
          showHostImage={false}
        >
          {slot && (
            <BookingSelectedTime
              slot={slot}
              hostTimeZone={bookingHostTimeZone(event)}
              timeZone={timeZone}
              locale={locale}
              onChangeTime={changeTime}
            />
          )}
        </BookingEventInfo>
        <div className="booking-main">
          {slot ? (
            <BookingDetailsStep>
              <BookingForm
                locations={event.locations}
                smsRemindersEnabled={event.smsRemindersEnabled}
                allowGuests={event.allowGuests}
                questions={event.questions}
                values={{ ...values, locationOptionId: chosenLocation?.id }}
                privateDetails
                onChange={({ locationOptionId, ...next }) => {
                  if (locationOptionId && locationOptionId !== chosenLocation?.id) {
                    chooseLocation(locationOptionId)
                    changeTime()
                  }
                  setValues(next)
                }}
                serverErrors={{}}
                formError={null}
                submissionDisabledBy={noticeId}
              />
            </BookingDetailsStep>
          ) : (
            <SlotPicker
              load={load}
              durationMinutes={duration}
              timeZone={timeZone}
              onTimeZoneChange={setTimeZone}
              locale={locale}
              now={now}
              selected={null}
              initialPosition={position}
              onPositionChange={setPosition}
              onSelect={(next) => setSelectedStart(Date.parse(next.start))}
              version={0}
              focusTitle={returningToPicker}
              afterTitle={
                <BookingOptions
                  event={event}
                  scoped
                  durationMinutes={duration}
                  locationOptionId={chosenLocation?.id}
                  onLocationChange={(id) => {
                    chooseLocation(id)
                    setValues((current) => ({ ...current, inviteePhone: '' }))
                  }}
                  onDurationChange={(minutes) =>
                    setDurationChoice({ default: event.durationMinutes, minutes })
                  }
                />
              }
            />
          )}
        </div>
      </div>
    </PublicPreviewLayout>
  )
}
