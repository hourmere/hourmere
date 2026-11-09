import { type FormEvent, useCallback, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, unwrap } from '../../api/client.ts'
import { errorMessage, RequestError } from '../../api/errors.ts'
import { isNotFound, loadProfile, loadSchedules, type Schedule } from '../../api/resources.ts'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import { ErrorSummary, Field, type FieldErrors } from '../../components/forms.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { TimeZonePicker } from '../../components/TimeZonePicker.tsx'
import { flash, useFlash } from '../../flash.ts'
import { browserTimeZone } from '../../format.ts'
import { useLoad, useMounted, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'
import { PATHS, schedulePath } from '../../paths.ts'
import { useUnsavedChanges } from '../../unsaved-changes.tsx'
import { MissingRecord } from '../NotFound.tsx'
import { CopyDay } from './CopyDay.tsx'
import { IntervalsEditor } from './IntervalsEditor.tsx'
import {
  comparableOverrides,
  type Override,
  Overrides,
  overrideDraft,
  overrideErrors,
  overrideLabels,
  overridesBody,
} from './Overrides.tsx'
import {
  comparable,
  copyDay,
  type DayDraft,
  dayField,
  draftFromSchedule,
  intervalDraft,
  newScheduleDraft,
  type ScheduleDraft,
  scheduleLabels,
  scheduleServerErrors,
  summarize,
  toScheduleBody,
  validateSchedule,
  WEEKDAYS,
  type Weekday,
} from './weekly-hours.ts'

interface Loaded {
  schedule: Schedule | null
  overrides: Override[]
  version: string
  schedules: Schedule[]
  /** For a new schedule: the profile's zone, else the browser's. */
  defaultTimeZone: string
}

/** Creates a schedule (/app/availability/new) or edits one (/app/availability/:id). */
export function ScheduleEditorPage() {
  const { id } = useParams()
  // Starts over for another schedule, rather than showing the previous one while loading.
  return <ScheduleEditor key={id ?? 'new'} id={id} />
}

function ScheduleEditor({ id }: { id: string | undefined }) {
  const { t, uiText: ui } = useI18n()

  const load = useCallback(
    async (signal: AbortSignal): Promise<Loaded | 'missing'> => {
      const [schedules, profile] = await Promise.all([
        loadSchedules(signal),
        id === undefined ? loadProfile(signal) : null,
      ])
      let schedule: Schedule | null = null
      let overrides: Override[] = []
      let version = ''
      if (id !== undefined) {
        try {
          const snapshot = await unwrap(
            api.GET('/api/v1/schedules/{id}/availability', { params: { path: { id } }, signal }),
          )
          schedule = snapshot.schedule
          overrides = snapshot.overrides
          version = snapshot.version
        } catch (err) {
          if (isNotFound(err, 'schedule_not_found')) return 'missing'
          throw err
        }
      }
      return {
        schedule,
        overrides,
        version,
        schedules,
        defaultTimeZone: profile?.timeZone ?? browserTimeZone(),
      }
    },
    [id],
  )
  const [state, reload] = useLoad(load)
  usePageTitle(id === undefined ? 'New schedule' : 'Edit schedule')

  if (state.status === 'loading') return <PageSkeleton />
  if (state.status === 'error') {
    return (
      <>
        <PageHeader title={id === undefined ? t('New schedule') : t('Edit schedule')} />
        <div className="alert alert-error" role="alert">
          <p>
            {t('Could not load the schedule.')} {ui(state.message)}
          </p>
          <button type="button" className="button button-small" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      </>
    )
  }
  if (state.data === 'missing') {
    return (
      <MissingRecord
        title={t('Schedule not found')}
        message="This schedule does not exist, or it was deleted."
        back={{ to: PATHS.availability, label: 'Back to availability' }}
      />
    )
  }
  return <ScheduleForm {...state.data} />
}

function ScheduleForm({
  schedule,
  overrides,
  version: initialVersion,
  schedules,
  defaultTimeZone,
}: Loaded) {
  const { t, text, ui, uiText, locale, formatLocale } = useI18n()

  const navigate = useNavigate()
  const message = useFlash()
  const [saved, setSaved] = useState<Schedule | null>(schedule)
  const [baseline, setBaseline] = useState(() =>
    schedule ? draftFromSchedule(schedule) : newScheduleDraft(defaultTimeZone),
  )
  const [draft, setDraft] = useState(baseline)
  const [conflict, setConflict] = useState(false)
  const [latest, setLatest] = useState<{
    schedule: Schedule
    overrides: Override[]
    version: string
  } | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [version, setVersion] = useState(initialVersion)
  const [overrideBaseline, setOverrideBaseline] = useState(() => overrides.map(overrideDraft))
  const [overrideDrafts, setOverrideDrafts] = useState(overrideBaseline)
  const isFirst = schedules.length === 0
  const [makeDefault, setMakeDefault] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<UiText | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState(message ?? '')
  const statusRef = useRef<HTMLParagraphElement>(null)
  const mounted = useMounted()

  const dirty =
    comparable(draft) !== comparable(baseline) ||
    makeDefault ||
    comparableOverrides(overrideDrafts) !== comparableOverrides(overrideBaseline)
  useUnsavedChanges(dirty)

  const others = schedules.filter((s) => s.id !== saved?.id)

  function setDay(day: Weekday, change: Partial<DayDraft>) {
    setDraft((d) => ({ ...d, days: { ...d.days, [day]: { ...d.days[day], ...change } } }))
    setStatus('')
  }

  function set<K extends 'name' | 'timeZone'>(name: K, value: ScheduleDraft[K]) {
    setDraft((d) => ({ ...d, [name]: value }))
    setStatus('')
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setAttempt((n) => n + 1)
    setFormError(null)
    setStatus('')
    if (saving) return
    const problems = { ...validateSchedule(draft), ...overrideErrors(overrideDrafts) }
    setErrors(problems)
    if (Object.keys(problems).length > 0) return
    // Locked until the answer comes, so it cannot overwrite later edits (see EventTypeForm).
    setStatus('Saving…')
    statusRef.current?.focus()
    setSaving(true)
    const body = toScheduleBody(draft)
    try {
      if (saved) {
        const updated = await unwrap(
          api.PUT('/api/v1/schedules/{id}/availability', {
            params: { path: { id: saved.id } },
            body: {
              ...body,
              ...(makeDefault && { isDefault: true }),
              overrides: overridesBody(overrideDrafts),
              expectedVersion: version,
            },
          }),
        )
        if (!mounted.current) return
        const next = draftFromSchedule(updated.schedule)
        setSaved(updated.schedule)
        setVersion(updated.version)
        setMakeDefault(false)
        const nextOverrides = updated.overrides.map(overrideDraft)
        setOverrideBaseline(nextOverrides)
        setOverrideDrafts(nextOverrides)
        setBaseline(next)
        setDraft(next)
        setConflict(false)
        setLatest(null)
        setStatus('Saved.')
        statusRef.current?.focus()
      } else {
        const created = await unwrap(
          api.POST('/api/v1/schedules', {
            body: { ...body, ...(makeDefault && { isDefault: true }) },
          }),
        )
        // Left meanwhile: don't pull the person away from the page they are on now.
        if (!mounted.current) return
        setBaseline(draft)
        setMakeDefault(false)
        // On to the new schedule's page, where date overrides can be added.
        navigate(schedulePath(created.id), {
          replace: true,
          state: flash(msg('Created “{0}”.', { '0': created.name })),
        })
        return
      }
    } catch (err) {
      if (!mounted.current) return
      setStatus('')
      if (err instanceof RequestError && err.code === 'schedule_conflict') {
        setConflict(true)
        setLatest(null)
      }
      const mapped =
        err instanceof RequestError && err.code === 'schedule_conflict'
          ? {
              fields: {},
              message: msg(
                'This schedule changed in another tab or from an API, MCP or CLI client. Your changes are still here. Review the latest version before applying your draft again.',
              ),
            }
          : scheduleServerErrors(err)
      setErrors(mapped.fields)
      setFormError(
        Object.keys(mapped.fields).length > 0
          ? null
          : msg('Could not save the schedule. {0}', { '0': mapped.message ?? errorMessage(err) }),
      )
      setAttempt((n) => n + 1)
    }
    setSaving(false)
  }

  async function reviewLatest() {
    if (!saved || reviewing) return
    setReviewing(true)
    try {
      const snapshot = await unwrap(
        api.GET('/api/v1/schedules/{id}/availability', { params: { path: { id: saved.id } } }),
      )
      if (mounted.current) setLatest(snapshot)
    } catch (err) {
      if (mounted.current)
        setFormError(msg('Could not load the latest version. {0}', { '0': errorMessage(err) }))
    } finally {
      if (mounted.current) setReviewing(false)
    }
  }

  async function remove() {
    if (!saved) return
    await unwrap(api.DELETE('/api/v1/schedules/{id}', { params: { path: { id: saved.id } } }))
    if (!mounted.current) return
    setBaseline(draft)
    setOverrideBaseline(overrideDrafts)
    navigate(PATHS.availability, { state: flash(msg('Deleted “{0}”.', { '0': saved.name })) })
  }

  return (
    <>
      <p className="breadcrumb">
        <Link to={PATHS.availability}>{t('Availability')}</Link>
      </p>
      <PageHeader
        title={saved ? text('Edit “{0}”', { '0': saved.name }) : t('New schedule')}
        lede={
          saved
            ? t(
                'Save schedule details, weekly hours and date overrides together with Save changes.',
              )
            : t('Set your weekly hours in the time zone people can book you in.')
        }
      />
      {saved && (
        <p className="default-status">
          {saved.isDefault
            ? t('Event types use this schedule unless you choose another one for them.')
            : t('Event types use this schedule only where you choose it.')}
        </p>
      )}

      <form className="editor" onSubmit={submit} noValidate>
        <ErrorSummary
          errors={errors}
          labels={{ ...scheduleLabels(draft), ...overrideLabels(overrideDrafts) }}
          message={formError}
          attempt={attempt}
        />
        {conflict && (
          <section className="panel availability-conflict" aria-label={t('Latest saved version')}>
            <button
              type="button"
              className="button"
              disabled={reviewing || saving}
              onClick={reviewLatest}
            >
              {t('Review latest version')}
            </button>
            {latest && (
              <>
                <h2>{t('Latest saved version')}</h2>
                <p>
                  {latest.schedule.name} · {latest.schedule.timeZone}
                </p>
                <p>{summarize(latest.schedule.weeklyHours, locale)}</p>
                <ul>
                  {latest.overrides.map((o) => (
                    <li key={o.date}>
                      {new Intl.DateTimeFormat(formatLocale, {
                        weekday: 'short',
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        timeZone: 'UTC',
                        calendar: 'gregory',
                      }).format(new Date(`${o.date}T00:00:00Z`))}
                      :{' '}
                      {o.intervals.length
                        ? o.intervals.map((i) => `${i.start}–${i.end}`).join(', ')
                        : t('Unavailable all day')}
                    </li>
                  ))}
                </ul>
                <p>
                  {t(
                    'Applying your draft replaces the latest weekly hours and date overrides. Review both before saving.',
                  )}
                </p>
                <button
                  type="button"
                  className="button"
                  disabled={saving}
                  onClick={() => {
                    setVersion(latest.version)
                    setSaved(latest.schedule)
                    setBaseline(draftFromSchedule(latest.schedule))
                    setOverrideBaseline(latest.overrides.map(overrideDraft))
                    setConflict(false)
                    setLatest(null)
                    setFormError(null)
                  }}
                >
                  {t('Apply my draft to this version')}
                </button>
              </>
            )}
          </section>
        )}
        <fieldset className="form-fieldset" disabled={saving} role="presentation">
          <section className="panel" aria-labelledby="schedule-heading">
            <h2 id="schedule-heading">{t('Name and time zone')}</h2>
            <div className="field-grid">
              <Field
                id="name"
                label={t('Name')}
                error={errors.name}
                hint={text('For you only, e.g. “Working hours”.')}
              >
                {(props) => (
                  <input
                    {...props}
                    value={draft.name}
                    autoComplete="off"
                    onChange={(e) => set('name', e.target.value)}
                  />
                )}
              </Field>
              <Field
                id="timeZone"
                label={t('Time zone')}
                error={errors.timeZone}
                hint={text('The hours below are in this zone. Type to search, e.g. “Berlin”.')}
              >
                {(props) => (
                  <TimeZonePicker
                    value={draft.timeZone}
                    onChange={(v) => set('timeZone', v)}
                    control={props}
                  />
                )}
              </Field>
            </div>
            {((!saved && !isFirst) || (saved && !saved.isDefault)) && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={makeDefault}
                  onChange={(e) => {
                    setMakeDefault(e.target.checked)
                    setStatus('')
                  }}
                />
                {t('Make this my default schedule')}
              </label>
            )}
            {!saved && isFirst && (
              <p className="hint">{t('Your first schedule is your default schedule.')}</p>
            )}
          </section>

          <section className="panel" aria-labelledby="hours-heading">
            <h2 id="hours-heading">{t('Weekly hours')}</h2>
            <p className="hint">
              {t('An end time of 00:00 (12:00 AM) means midnight at the end of the day.')}
            </p>
            <ul className="week">
              {WEEKDAYS.map(({ day, label }) => {
                const d = draft.days[day]
                return (
                  <li key={day} className="weekday" id={dayField(day)} tabIndex={-1}>
                    <label className="checkbox weekday-toggle">
                      <input
                        type="checkbox"
                        checked={d.available}
                        onChange={(e) => {
                          const available = e.target.checked
                          setDay(day, {
                            available,
                            // Turning a day on starts with 9 to 5 if it had no hours.
                            ...(available &&
                              d.intervals.length === 0 && {
                                intervals: [intervalDraft()],
                              }),
                          })
                        }}
                      />
                      {ui(label)}
                    </label>
                    {d.available ? (
                      <IntervalsEditor
                        prefix={dayField(day)}
                        label={ui(label)}
                        intervals={d.intervals}
                        onChange={(intervals) => setDay(day, { intervals })}
                        errors={errors}
                      />
                    ) : (
                      <p className="muted weekday-off">{t('Unavailable')}</p>
                    )}
                    <CopyDay
                      source={day}
                      onCopy={(targets) => {
                        setDraft((d) => copyDay(d, day, targets))
                        setStatus('')
                      }}
                    />
                  </li>
                )
              })}
            </ul>
          </section>
          {saved && (
            <Overrides
              timeZone={draft.timeZone}
              drafts={overrideDrafts}
              onChange={(next) => {
                setOverrideDrafts(next)
                setStatus('')
              }}
              errors={errors}
            />
          )}
        </fieldset>

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={saving}>
            {saving ? t('Saving…') : saved ? t('Save changes') : t('Create schedule')}
          </button>
          <Link to={PATHS.availability} className="button">
            {saved ? t('Back to availability') : t('Cancel')}
          </Link>
          <p className="form-status" role="status" tabIndex={-1} ref={statusRef}>
            {uiText(status || (dirty && saved ? 'Unsaved changes' : ''))}
          </p>
        </div>
      </form>

      {!saved && (
        <section className="panel" aria-labelledby="overrides-heading">
          <h2 id="overrides-heading">{t('Date overrides')}</h2>
          <p className="muted">
            {t(
              'Create the schedule first; then you can change the hours of single dates, such as holidays.',
            )}
          </p>
        </section>
      )}

      {saved && <DeleteSchedule schedule={saved} others={others} onDelete={remove} />}
    </>
  )
}

/**
 * Deleting follows the API's rule: the default schedule can only go when it is the last one
 * (409 schedule_is_default otherwise), so event types always have hours to fall back to.
 */
function DeleteSchedule({
  schedule,
  others,
  onDelete,
}: {
  schedule: Schedule
  others: Schedule[]
  onDelete: () => Promise<void>
}) {
  const { t } = useI18n()

  const defaultHint = t(
    'This is your default schedule. To delete it, first make another schedule the default on the {0}.',
  ).split('{0}')
  const blocked = schedule.isDefault && others.length > 0
  return (
    <section className="panel panel-danger" aria-labelledby="delete-heading">
      <h2 id="delete-heading">{t('Delete this schedule')}</h2>
      {blocked ? (
        <p>
          {defaultHint[0]}
          <Link to={PATHS.availability}>{t('availability page')}</Link>
          {defaultHint[1]}
        </p>
      ) : (
        <>
          <p>
            {schedule.isDefault
              ? t('This is your only schedule: without it, your event types offer no times.')
              : t('Event types that use it switch to your default schedule.')}{' '}
            {t('Its date overrides are deleted with it.')}
          </p>
          <ConfirmAction
            label={t('Delete schedule')}
            prompt={t('Delete “{0}”? This cannot be undone.', { '0': schedule.name })}
            confirmLabel={t('Delete schedule')}
            busyLabel={t('Deleting…')}
            failure={t('Could not delete the schedule.')}
            onConfirm={onDelete}
          />
        </>
      )}
    </section>
  )
}
