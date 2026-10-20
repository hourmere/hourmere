import { type FormEvent, useCallback, useState } from 'react'
import { api, type Schemas, unwrap } from '../api/client.ts'
import { RequestError } from '../api/errors.ts'
import { loadProfile } from '../api/resources.ts'
import { ErrorSummary, Field, type FieldErrors } from '../components/forms.tsx'
import { TimeZonePicker } from '../components/TimeZonePicker.tsx'
import { isKnownTimeZone } from '../format.ts'
import { useLoad, usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'

interface Filters {
  startDate: string
  endDate: string
  timeZone: string
}

/** Date-only arithmetic uses UTC; the reporting time zone decides only what 'today' means. */
export function initialActivityFilters(timeZone: string, now = new Date()): Filters {
  if (!isKnownTimeZone(timeZone)) timeZone = 'UTC'
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: string) => parts.find((value) => value.type === type)?.value ?? ''
  const endDate = `${part('year')}-${part('month')}-${part('day')}`
  const start = new Date(`${endDate}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - 29)
  return { startDate: start.toISOString().slice(0, 10), endDate, timeZone }
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function AnalyticsPage() {
  const { t, ui } = useI18n()

  usePageTitle('Booking activity')
  const [profile, reload] = useLoad(loadProfile)
  return (
    <>
      <h1>{t('Booking activity')}</h1>
      <p>
        {t(
          'Booking actions by the day they were recorded, rather than the meeting date. These counts describe currently retained bookings; deleting data can change history.',
        )}
      </p>
      {profile.status === 'loading' && <p role="status">{t('Loading reporting preferences…')}</p>}
      {profile.status === 'error' && (
        <div className="alert alert-error" role="alert">
          <p>
            {t('Could not load reporting preferences.')} {ui(profile.message)}
          </p>
          <button type="button" className="button" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      )}
      {profile.status === 'ready' && <ActivityForm timeZone={profile.data?.timeZone ?? 'UTC'} />}
    </>
  )
}

function ActivityForm({ timeZone }: { timeZone: string }) {
  const { t } = useI18n()

  const [filters, setFilters] = useState(() => initialActivityFilters(timeZone))
  const [draft, setDraft] = useState(filters)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [attempt, setAttempt] = useState(0)
  const set = (field: keyof Filters, value: string) =>
    setDraft((current) => ({ ...current, [field]: value }))
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next: FieldErrors = {}
    if (!validDate(draft.startDate)) next.startDate = 'Enter a valid start date.'
    if (!validDate(draft.endDate)) next.endDate = 'Enter a valid end date.'
    if (!next.startDate && !next.endDate) {
      const days =
        (Date.parse(`${draft.endDate}T00:00:00Z`) - Date.parse(`${draft.startDate}T00:00:00Z`)) /
        86_400_000
      if (days < 0 || days >= 90)
        next.endDate = 'Choose at most 90 calendar days, with the end on or after the start.'
    }
    if (!isKnownTimeZone(draft.timeZone)) next.timeZone = 'Choose an IANA time zone.'
    setErrors(next)
    setAttempt((value) => value + 1)
    if (Object.keys(next).length === 0) setFilters({ ...draft })
  }
  return (
    <>
      <form onSubmit={submit} noValidate className="panel">
        <ErrorSummary
          errors={errors}
          attempt={attempt}
          labels={{ startDate: 'Start date', endDate: 'End date', timeZone: 'Reporting time zone' }}
        />
        <Field id="startDate" label={t('Start date')} error={errors.startDate}>
          {(control) => (
            <input
              {...control}
              type="date"
              value={draft.startDate}
              onChange={(event) => set('startDate', event.target.value)}
            />
          )}
        </Field>
        <Field
          id="endDate"
          label={t('End date')}
          hint={t('Both dates are included, up to 90 local days.')}
          error={errors.endDate}
        >
          {(control) => (
            <input
              {...control}
              type="date"
              value={draft.endDate}
              onChange={(event) => set('endDate', event.target.value)}
            />
          )}
        </Field>
        <Field id="timeZone" label={t('Reporting time zone')} error={errors.timeZone}>
          {(control) => (
            <TimeZonePicker
              control={control}
              value={draft.timeZone}
              onChange={(value) => set('timeZone', value)}
            />
          )}
        </Field>
        <button type="submit" className="button button-primary">
          {t('Update report')}
        </button>
      </form>
      <ActivityReport key={JSON.stringify(filters)} filters={filters} />
    </>
  )
}

function ActivityReport({ filters }: { filters: Filters }) {
  const { t, ui, locale: displayLocale } = useI18n()

  const load = useCallback(
    async (signal: AbortSignal): Promise<Schemas['BookingActivity'] | null> => {
      try {
        return await unwrap(
          api.GET('/api/v1/analytics/bookings', { params: { query: filters }, signal }),
        )
      } catch (error) {
        if (error instanceof RequestError && error.status === 403) return null
        throw error
      }
    },
    [filters],
  )
  const [report, reload] = useLoad(load)
  if (report.status === 'loading') return <p role="status">{t('Loading booking activity…')}</p>
  if (report.status === 'error')
    return (
      <div className="alert alert-error" role="alert">
        <p>
          {t('Could not load booking activity.')} {ui(report.message)}
        </p>
        <button type="button" className="button" onClick={reload}>
          {t('Try again')}
        </button>
      </div>
    )
  if (report.data === null)
    return (
      <p className="alert alert-info">
        {t(
          'Booking activity is available to personal account owners and team owners or admins. Your current team role does not permit this report.',
        )}
      </p>
    )
  const data = report.data
  return (
    <section className="panel" aria-labelledby="activity-summary">
      <h2 id="activity-summary">
        {data.startDate} {t('to')} {data.endDate}
      </h2>
      <p>
        {t('Reporting time zone:')} {data.timeZone}
        {t('. Days can have 23 or 25 hours when the clocks change.')}
      </p>
      <dl className="details">
        <dt>{t('Bookings created')}</dt>
        <dd>{new Intl.NumberFormat(displayLocale).format(data.totals.created)}</dd>
        <dt>{t('Reschedules')}</dt>
        <dd>{new Intl.NumberFormat(displayLocale).format(data.totals.rescheduled)}</dd>
        <dt>{t('Cancellations')}</dt>
        <dd>{new Intl.NumberFormat(displayLocale).format(data.totals.cancelled)}</dd>
      </dl>
      <p className="hint">
        {t(
          'Creations count the initial booking once. Reschedules count each move. Cancellations exclude the old booking withdrawn during a move. These are activity counts, without visitor or conversion tracking.',
        )}
      </p>
      {data.totals.created + data.totals.rescheduled + data.totals.cancelled === 0 && (
        <p>{t('No booking activity was recorded in this range.')}</p>
      )}
      <div className="table-container">
        <table className="table table-analytics">
          <caption>{t('Daily booking activity')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('Date')}</th>
              <th scope="col">{t('Bookings created')}</th>
              <th scope="col">{t('Reschedules')}</th>
              <th scope="col">{t('Cancellations')}</th>
            </tr>
          </thead>
          <tbody>
            {data.data.map((day) => (
              <tr key={day.date}>
                <th scope="row" data-label={t('Date')}>
                  {day.date}
                </th>
                <td data-label={t('Bookings created')}>
                  <div className="table-value">
                    {new Intl.NumberFormat(displayLocale).format(day.created)}
                  </div>
                </td>
                <td data-label={t('Reschedules')}>
                  <div className="table-value">
                    {new Intl.NumberFormat(displayLocale).format(day.rescheduled)}
                  </div>
                </td>
                <td data-label={t('Cancellations')}>
                  <div className="table-value">
                    {new Intl.NumberFormat(displayLocale).format(day.cancelled)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
