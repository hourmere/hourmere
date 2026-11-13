import { type FormEvent, useCallback, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, unwrap } from '../../api/client.ts'
import { type EventType, loadEventTypes, loadProfile } from '../../api/resources.ts'
import { ErrorSummary, Field, type FieldErrors } from '../../components/forms.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { TimeZonePicker } from '../../components/TimeZonePicker.tsx'
import { browserTimeZone, isKnownTimeZone, zoned } from '../../format.ts'
import { useLoad, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { PATHS } from '../../paths.ts'
import {
  classifyFailure,
  type Failure,
  onlyOutsideHours,
  reasonHost,
  reasonText,
  type Troubleshooting,
  type TroubleshootSlot,
} from './troubleshoot-model.ts'

interface Request {
  eventTypeId: string
  date: string
  timeZone: string
}

/** Today's date in `timeZone`, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: isKnownTimeZone(timeZone) ? timeZone : 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: string) => parts.find((value) => value.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

async function loadSetup(signal: AbortSignal) {
  const [eventTypes, profile] = await Promise.all([loadEventTypes(signal), loadProfile(signal)])
  return { eventTypes, timeZone: profile?.timeZone ?? browserTimeZone() }
}

export function TroubleshootPage() {
  const { t, ui } = useI18n()
  usePageTitle('Troubleshoot availability')
  const [setup, reload] = useLoad(loadSetup)
  return (
    <>
      <PageHeader
        title={t('Troubleshoot availability')}
        lede={t(
          'Pick an event type and a day to see which times can be booked, and why the others cannot.',
        )}
      >
        <Link to={PATHS.availability} className="button">
          {t('Back to availability')}
        </Link>
      </PageHeader>
      {setup.status === 'loading' && <PageSkeleton label="Loading event types…" />}
      {setup.status === 'error' && (
        <div className="alert alert-error" role="alert">
          <p>
            {t('Could not load your event types.')} {ui(setup.message)}
          </p>
          <button type="button" className="button" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      )}
      {setup.status === 'ready' &&
        (setup.data.eventTypes.length === 0 ? (
          <p className="alert alert-info">
            {t('There are no event types in this space to check.')}
          </p>
        ) : (
          <TroubleshootForm eventTypes={setup.data.eventTypes} timeZone={setup.data.timeZone} />
        ))}
    </>
  )
}

function TroubleshootForm({ eventTypes, timeZone }: { eventTypes: EventType[]; timeZone: string }) {
  const { t } = useI18n()
  const [params] = useSearchParams()
  const requested = params.get('eventTypeId')
  const initialZone = isKnownTimeZone(timeZone) ? timeZone : 'UTC'
  const [draft, setDraft] = useState<Request>(() => ({
    eventTypeId: eventTypes.some((event) => event.id === requested)
      ? (requested as string)
      : (eventTypes[0]?.id ?? ''),
    date: todayIn(initialZone),
    timeZone: initialZone,
  }))
  const [request, setRequest] = useState<Request | null>(null)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [attempt, setAttempt] = useState(0)
  const set = (field: keyof Request, value: string) =>
    setDraft((current) => ({ ...current, [field]: value }))
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next: FieldErrors = {}
    if (!validDate(draft.date)) next.date = 'Enter a valid date.'
    if (!isKnownTimeZone(draft.timeZone)) next.timeZone = 'Choose an IANA time zone.'
    setErrors(next)
    setAttempt((value) => value + 1)
    if (Object.keys(next).length === 0) setRequest({ ...draft })
  }
  return (
    <>
      <form onSubmit={submit} noValidate className="panel stack">
        <ErrorSummary
          errors={errors}
          attempt={attempt}
          labels={{ date: 'Date', timeZone: 'Time zone' }}
        />
        <Field id="eventTypeId" label={t('Event type')}>
          {(control) => (
            <select
              {...control}
              value={draft.eventTypeId}
              onChange={(event) => set('eventTypeId', event.target.value)}
            >
              {eventTypes.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.title}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="date" label={t('Date')} error={errors.date}>
          {(control) => (
            <input
              {...control}
              type="date"
              value={draft.date}
              onChange={(event) => set('date', event.target.value)}
            />
          )}
        </Field>
        <Field id="timeZone" label={t('Time zone')} error={errors.timeZone}>
          {(control) => (
            <TimeZonePicker
              control={control}
              value={draft.timeZone}
              onChange={(value) => set('timeZone', value)}
            />
          )}
        </Field>
        <button type="submit" className="button button-primary">
          {t('Check this day')}
        </button>
      </form>
      {request && <TroubleshootResult key={JSON.stringify(request)} request={request} />}
    </>
  )
}

type Outcome = { ok: true; data: Troubleshooting } | { ok: false; failure: Failure }

function TroubleshootResult({ request }: { request: Request }) {
  const { t, ui } = useI18n()
  const load = useCallback(
    async (signal: AbortSignal): Promise<Outcome> => {
      try {
        const data = await unwrap(
          api.GET('/api/v1/event-types/{id}/availability-troubleshooting', {
            params: {
              path: { id: request.eventTypeId },
              query: { date: request.date, timeZone: request.timeZone },
            },
            signal,
          }),
        )
        return { ok: true, data }
      } catch (error) {
        const failure = classifyFailure(error)
        if (failure.kind === 'error') throw error
        return { ok: false, failure }
      }
    },
    [request],
  )
  const [state, reload] = useLoad(load)
  if (state.status === 'loading') return <PageSkeleton label="Checking this day…" />
  if (state.status === 'error')
    return (
      <div className="alert alert-error" role="alert">
        <p>
          {t('Could not check this day.')} {ui(state.message)}
        </p>
        <button type="button" className="button" onClick={reload}>
          {t('Try again')}
        </button>
      </div>
    )
  if (!state.data.ok) {
    const { failure } = state.data
    if (failure.kind === 'no_access')
      return (
        <p className="alert alert-info" data-testid="troubleshoot-no-access">
          {t(
            'You cannot troubleshoot this event type with your current access. Only its owner, or a team owner or admin, can see why times are unavailable.',
          )}
        </p>
      )
    if (failure.kind === 'calendars_unreadable')
      return (
        <div className="alert alert-info" role="status">
          <p>
            {t(
              'Connected calendars could not be read just now, so this day cannot be explained yet. Try again shortly.',
            )}
          </p>
          <button type="button" className="button" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      )
    if (failure.kind === 'location_unavailable')
      return (
        <p className="alert alert-info">
          {t(
            'The default location of this event type cannot be offered right now, so no times can be checked.',
          )}
        </p>
      )
    return (
      <p className="alert alert-error" role="alert">
        {failure.kind === 'invalid' && failure.code === 'range_too_long'
          ? t('This day has too many possible start times to check at once.')
          : t('This day could not be checked. Check the date and time zone.')}
      </p>
    )
  }
  return <DayReport data={state.data.data} />
}

function DayReport({ data }: { data: Troubleshooting }) {
  const { t, locale } = useI18n()
  const [hideOutside, setHideOutside] = useState(true)
  const format = zoned(data.timeZone, locale)
  const available = data.slots.filter((slot) => slot.status === 'available').length
  const hidden = hideOutside ? data.slots.filter(onlyOutsideHours).length : 0
  const shown = hideOutside ? data.slots.filter((slot) => !onlyOutsideHours(slot)) : data.slots
  return (
    <section className="panel stack" aria-labelledby="troubleshoot-day">
      <h2 id="troubleshoot-day">{format.longDate(data.rangeStart)}</h2>
      <p>
        {t('{available} of {total} possible times can be booked. Times are shown in {zone}.', {
          available,
          total: data.slots.length,
          zone: data.timeZone,
        })}
      </p>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={hideOutside}
          onChange={(event) => setHideOutside(event.target.checked)}
        />
        {t('Hide times that are only outside the available hours')}
      </label>
      {hidden > 0 && (
        <p className="hint">
          {t('{count} times outside the available hours are hidden.', { count: hidden })}
        </p>
      )}
      {data.slots.length === 0 ? (
        <p>{t('There are no possible start times on this day.')}</p>
      ) : (
        <ul className="card-list" aria-label={t('Times on this day')}>
          {shown.map((slot) => (
            <li key={`${slot.start}/${slot.end}`} className="card-item">
              <SlotRow slot={slot} data={data} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function SlotRow({ slot, data }: { slot: TroubleshootSlot; data: Troubleshooting }) {
  const { t, locale } = useI18n()
  const format = zoned(data.timeZone, locale)
  return (
    <div className="card-main">
      <h3 className="card-title">
        {format.timeRange(slot.start, slot.end)}
        {slot.status === 'available' ? (
          <span className="badge badge-success">{t('Bookable')}</span>
        ) : (
          <span className="badge">{t('Not bookable')}</span>
        )}
      </h3>
      {slot.reasons.length > 0 && (
        <ul className="troubleshoot-reasons">
          {slot.reasons.map((reason) => {
            const host = reasonHost(reason, data.hosts)
            const partial = reason.start !== slot.start || reason.end !== slot.end
            return (
              <li key={`${reason.code}/${reason.hostUserId ?? ''}/${reason.start}/${reason.end}`}>
                {host.kind === 'named' && <strong>{t('{name}:', { name: host.name })}</strong>}
                {host.kind === 'unnamed' && <strong>{t('A team host:')}</strong>}
                {host.kind !== 'none' && !locale.startsWith('zh') && ' '}
                {t(reasonText(reason.code))}
                {partial && (
                  <span className="muted">
                    {' '}
                    {t('(affects {range})', { range: format.timeRange(reason.start, reason.end) })}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
