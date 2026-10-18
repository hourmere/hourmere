import { isPublicTeamSlug } from '@hourmere/core/reserved'
import { type FormEvent, useCallback, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, unwrap } from '../../api/client.ts'
import { errorMessage } from '../../api/errors.ts'
import {
  type EventType,
  isNotFound,
  loadProfile,
  loadSchedules,
  type Profile,
  type Schedule,
} from '../../api/resources.ts'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import { ErrorSummary, Field, type FieldErrors, parseWhole } from '../../components/forms.tsx'
import { flash } from '../../flash.ts'
import { formatMinutes } from '../../format.ts'
import { useLoad, useMounted, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'
import { EVENT_TYPE, RULES } from '../../limits.ts'
import { PATHS, publicPageUrl, publicTeamPageUrl, TEAM_LINK_SLUG_HINT } from '../../paths.ts'
import { type Me, useMe } from '../../session.tsx'
import { useUnsavedChanges } from '../../unsaved-changes.tsx'
import { MissingRecord } from '../NotFound.tsx'
import {
  comparable,
  draftFromEventType,
  type EventTypeDraft,
  emptyDraft,
  fieldLabels,
  LOCATION_KINDS,
  type LocationKind,
  serverErrors,
  slugify,
  toInput,
  validateDraft,
} from './event-type-form.ts'
import { QuestionsEditor } from './QuestionsEditor.tsx'

interface Loaded {
  eventType: EventType | null
  schedules: Schedule[]
  profile: Profile | null
}

/** Creates an event type (/app/event-types/new) or edits one (/app/event-types/:id). */
export function EventTypeEditorPage() {
  const { id } = useParams()
  // Starts over for another event type, rather than showing the previous one while loading.
  return <EventTypeEditor key={id ?? 'new'} id={id} />
}

function EventTypeEditor({ id }: { id: string | undefined }) {
  const { t, ui } = useI18n()

  const load = useCallback(
    async (signal: AbortSignal): Promise<Loaded | 'missing'> => {
      const [eventType, schedules, profile] = await Promise.all([
        id === undefined
          ? null
          : unwrap(api.GET('/api/v1/event-types/{id}', { params: { path: { id } }, signal })).catch(
              (err: unknown) => {
                if (isNotFound(err, 'event_type_not_found')) return 'missing' as const
                throw err
              },
            ),
        loadSchedules(signal),
        loadProfile(signal),
      ])
      if (eventType === 'missing') return 'missing'
      return { eventType, schedules, profile }
    },
    [id],
  )
  const [state, reload] = useLoad(load)
  usePageTitle(id === undefined ? 'New event type' : 'Edit event type')

  if (state.status === 'loading') return <p role="status">{t('Loading…')}</p>
  if (state.status === 'error') {
    return (
      <>
        <h1>{id === undefined ? t('New event type') : t('Edit event type')}</h1>
        <div className="alert alert-error" role="alert">
          <p>
            {t('Could not load the event type.')} {ui(state.message)}
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
        title={t('Event type not found')}
        message="This event type does not exist, or it was deleted."
        back={{ to: PATHS.eventTypes, label: 'Back to event types' }}
      />
    )
  }
  return <EventTypeForm {...state.data} />
}

function EventTypeForm({ eventType, schedules, profile }: Loaded) {
  const { t, ui, locale: displayLocale } = useI18n()

  const me = useMe()
  const navigate = useNavigate()
  const [saved, setSaved] = useState<EventType | null>(eventType)
  const [baseline, setBaseline] = useState(() =>
    eventType ? draftFromEventType(eventType) : emptyDraft(),
  )
  const [draft, setDraft] = useState(baseline)
  // On a new event type the slug follows the title until it is edited by hand.
  const [slugTouched, setSlugTouched] = useState(eventType !== null)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<UiText | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<UiText>('')
  const statusRef = useRef<HTMLParagraphElement>(null)
  const mounted = useMounted()

  const dirty = comparable(draft) !== comparable(baseline)
  useUnsavedChanges(dirty)

  const editing = saved !== null
  const title = editing ? msg('Edit “{0}”', { '0': saved.title }) : 'New event type'

  function set<K extends keyof EventTypeDraft>(name: K, value: EventTypeDraft[K]) {
    setDraft((d) => ({ ...d, [name]: value }))
    setStatus('')
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setAttempt((n) => n + 1)
    setFormError(null)
    setStatus('')
    const problems = validateDraft(draft)
    setErrors(problems)
    if (Object.keys(problems).length > 0) return
    // The fields are locked until the answer comes, so it cannot overwrite later edits.
    // Focus moves off them first (a disabled field drops it) to the status, which says so.
    setStatus('Saving…')
    statusRef.current?.focus()
    setSaving(true)
    const body = toInput(draft)
    try {
      if (saved) {
        const updated = await unwrap(
          api.PATCH('/api/v1/event-types/{id}', { params: { path: { id: saved.id } }, body }),
        )
        // Left meanwhile: the answer is for a page that is gone.
        if (!mounted.current) return
        const next = draftFromEventType(updated)
        setSaved(updated)
        setBaseline(next)
        setDraft(next)
        setStatus('Saved.')
        statusRef.current?.focus()
      } else {
        const created = await unwrap(api.POST('/api/v1/event-types', { body }))
        // Left meanwhile: don't pull the person away from the page they are on now.
        if (!mounted.current) return
        setBaseline(draft)
        navigate(PATHS.eventTypes, { state: flash(msg('Created “{0}”.', { '0': created.title })) })
        return
      }
    } catch (err) {
      if (!mounted.current) return
      setStatus('')
      const mapped = serverErrors(err, draft)
      setErrors(mapped.fields)
      setFormError(
        Object.keys(mapped.fields).length > 0
          ? null
          : msg('Could not save the event type. {0}', { '0': mapped.message ?? errorMessage(err) }),
      )
      setAttempt((n) => n + 1)
    }
    setSaving(false)
  }

  async function remove() {
    if (!saved) return
    await unwrap(api.DELETE('/api/v1/event-types/{id}', { params: { path: { id: saved.id } } }))
    if (!mounted.current) return
    setBaseline(draft)
    navigate(PATHS.eventTypes, { state: flash(msg('Deleted “{0}”.', { '0': saved.title })) })
  }

  const slugPreview = bookingLinkPreview(me, profile, draft.slug.trim(), saved?.schedulingType)
  const duration = parseWhole(draft.durationMinutes)

  return (
    <>
      <p className="breadcrumb">
        <Link to={PATHS.eventTypes}>{t('Event types')}</Link>
      </p>
      <h1>{ui(title)}</h1>
      <form className="editor" onSubmit={submit} noValidate>
        <ErrorSummary
          errors={errors}
          labels={fieldLabels(draft)}
          message={ui(formError)}
          attempt={attempt}
        />

        <fieldset className="form-fieldset" disabled={saving} role="presentation">
          <section className="panel" aria-labelledby="basics-heading">
            <h2 id="basics-heading">{t('Basics')}</h2>
            <div className="stack">
              <Field
                id="title"
                label={t('Title')}
                error={errors.title}
                hint={t('For example “Intro call”.')}
              >
                {(props) => (
                  <input
                    {...props}
                    value={draft.title}
                    autoComplete="off"
                    onChange={(e) => {
                      const value = e.target.value
                      setDraft((d) => ({
                        ...d,
                        title: value,
                        ...(!slugTouched && { slug: slugify(value) }),
                      }))
                      setStatus('')
                    }}
                  />
                )}
              </Field>
              <Field
                id="slug"
                label={t('Booking link')}
                error={errors.slug}
                hint={
                  <>
                    {t('Lowercase letters, digits and hyphens.')}{' '}
                    <span className="mono preview">{slugPreview}</span>
                  </>
                }
              >
                {(props) => (
                  <input
                    {...props}
                    className="mono"
                    value={draft.slug}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(e) => {
                      setSlugTouched(true)
                      set('slug', e.target.value)
                    }}
                  />
                )}
              </Field>
              <Field
                id="description"
                label={t('Description')}
                optional
                error={errors.description}
                hint={t('Shown on the booking page. Line breaks are kept.')}
              >
                {(props) => (
                  <textarea
                    {...props}
                    rows={4}
                    value={draft.description}
                    onChange={(e) => set('description', e.target.value)}
                  />
                )}
              </Field>
              <div className="field-grid">
                <MinutesField
                  id="durationMinutes"
                  label={t('Duration')}
                  value={draft.durationMinutes}
                  error={errors.durationMinutes}
                  onChange={(v) => set('durationMinutes', v)}
                  rule={RULES.durationMinutes}
                />
                <Field
                  id="position"
                  label={t('Position')}
                  error={errors.position}
                  hint={t('Lower numbers come first on your booking page.')}
                >
                  {(props) => (
                    <input
                      {...props}
                      inputMode="numeric"
                      value={draft.position}
                      onChange={(e) => set('position', e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={draft.isActive}
                  onChange={(e) => set('isActive', e.target.checked)}
                />
                {t('Active: invitees can book it')}
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={draft.isHidden}
                  onChange={(e) => set('isHidden', e.target.checked)}
                  aria-describedby="hidden-hint"
                />
                {t('Hide from your booking page')}
              </label>
              <p className="hint" id="hidden-hint">
                {t('Anyone with the direct link can still book it. This does not restrict access.')}
              </p>
            </div>
          </section>

          <section className="panel" aria-labelledby="location-heading">
            <h2 id="location-heading">{t('Location')}</h2>
            <LocationFields draft={draft} errors={errors} set={set} />
          </section>

          <section className="panel" aria-labelledby="questions-heading">
            <h2 id="questions-heading">{t('Booking form')}</h2>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.allowGuests}
                onChange={(e) => set('allowGuests', e.target.checked)}
                aria-describedby="guests-hint"
              />
              {t('Allow invitees to add guests')}
            </label>
            <p className="hint" id="guests-hint">
              {t(
                'Guests receive confirmation emails and calendar invitations. Off by default; changing this does not remove guests from existing bookings.',
              )}
            </p>
            <QuestionsEditor
              questions={draft.questions}
              onChange={(questions) => set('questions', questions)}
              errors={errors}
            />
          </section>

          <section className="panel" aria-labelledby="rules-heading">
            <h2 id="rules-heading">{t('When people can book')}</h2>
            <div className="stack">
              <Field
                id="scheduleId"
                label={t('Schedule')}
                error={errors.scheduleId}
                hint={
                  schedules.length === 0 ? (
                    <>
                      {t('You have no schedule yet, so no times are offered.')}{' '}
                      <Link to={PATHS.newSchedule}>{t('Set your availability')}</Link>.
                    </>
                  ) : (
                    <>
                      {t('The weekly hours times are offered in.')}{' '}
                      <Link to={PATHS.availability}>{t('Manage schedules')}</Link>
                    </>
                  )
                }
              >
                {(props) => (
                  <select
                    {...props}
                    value={draft.scheduleId}
                    onChange={(e) => set('scheduleId', e.target.value)}
                  >
                    <option value="">
                      {t('Your default schedule')}
                      {defaultName(schedules) ? ` (${defaultName(schedules)})` : ''}
                    </option>
                    {schedules.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                    {draft.scheduleId && !schedules.some((s) => s.id === draft.scheduleId) && (
                      <option value={draft.scheduleId}>
                        {t('A schedule that no longer exists')}
                      </option>
                    )}
                  </select>
                )}
              </Field>
              <div className="field-grid">
                <MinutesField
                  id="slotStepMinutes"
                  label={t('Start times every')}
                  optional
                  value={draft.slotStepMinutes}
                  error={errors.slotStepMinutes}
                  onChange={(v) => set('slotStepMinutes', v)}
                  rule={RULES.slotStepMinutes}
                  empty={
                    duration
                      ? `every ${formatMinutes(duration, displayLocale)} (the duration)`
                      : t('the duration')
                  }
                />
                <MinutesField
                  id="minimumNoticeMinutes"
                  label={t('Minimum notice')}
                  value={draft.minimumNoticeMinutes}
                  error={errors.minimumNoticeMinutes}
                  onChange={(v) => set('minimumNoticeMinutes', v)}
                  rule={RULES.minimumNoticeMinutes}
                  extra="How far ahead a meeting must be booked."
                />
                <Field
                  id="bookingWindowDays"
                  label={t('Booking window')}
                  optional
                  error={errors.bookingWindowDays}
                  hint={t('Days ahead people can book, {0}–{1}. Empty: no limit.', {
                    '0': RULES.bookingWindowDays.min,
                    '1': RULES.bookingWindowDays.max,
                  })}
                >
                  {(props) => (
                    <input
                      {...props}
                      inputMode="numeric"
                      value={draft.bookingWindowDays}
                      onChange={(e) => set('bookingWindowDays', e.target.value)}
                    />
                  )}
                </Field>
                <Field
                  id="maxBookingsPerDay"
                  label={t('Daily limit')}
                  optional
                  error={errors.maxBookingsPerDay}
                  hint={t('Bookings per day, {0}–{1}. Empty: no limit.', {
                    '0': RULES.maxBookingsPerDay.min,
                    '1': RULES.maxBookingsPerDay.max,
                  })}
                >
                  {(props) => (
                    <input
                      {...props}
                      inputMode="numeric"
                      value={draft.maxBookingsPerDay}
                      onChange={(e) => set('maxBookingsPerDay', e.target.value)}
                    />
                  )}
                </Field>
                <MinutesField
                  id="bufferBeforeMinutes"
                  label={t('Buffer before')}
                  value={draft.bufferBeforeMinutes}
                  error={errors.bufferBeforeMinutes}
                  onChange={(v) => set('bufferBeforeMinutes', v)}
                  rule={RULES.bufferBeforeMinutes}
                  extra="Free time kept before each meeting."
                />
                <MinutesField
                  id="bufferAfterMinutes"
                  label={t('Buffer after')}
                  value={draft.bufferAfterMinutes}
                  error={errors.bufferAfterMinutes}
                  onChange={(v) => set('bufferAfterMinutes', v)}
                  rule={RULES.bufferAfterMinutes}
                  extra="Free time kept after each meeting."
                />
              </div>
            </div>
          </section>
        </fieldset>

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={saving}>
            {saving ? t('Saving…') : editing ? t('Save changes') : t('Create event type')}
          </button>
          <Link to={PATHS.eventTypes} className="button">
            {editing ? t('Back to event types') : t('Cancel')}
          </Link>
          <p className="form-status" role="status" tabIndex={-1} ref={statusRef}>
            {ui(status || (dirty && editing ? 'Unsaved changes' : ''))}
          </p>
        </div>
      </form>

      {saved && (
        <section className="panel panel-danger" aria-labelledby="delete-heading">
          <h2 id="delete-heading">{t('Delete this event type')}</h2>
          <p>
            {t(
              'Its booking link stops working at once. Bookings already made are kept, and you can still see them under Bookings.',
            )}
          </p>
          <ConfirmAction
            label={t('Delete event type')}
            prompt={t('Delete “{0}”? This cannot be undone.', { '0': saved.title })}
            confirmLabel={t('Delete event type')}
            busyLabel={t('Deleting…')}
            failure={t('Could not delete the event type.')}
            onConfirm={remove}
          />
        </section>
      )}
    </>
  )
}

const defaultName = (schedules: Schedule[]) => schedules.find((s) => s.isDefault)?.name

/** What the booking link will be, or why there is none yet. */
function bookingLinkPreview(
  me: Me,
  profile: Profile | null,
  slug: string,
  schedulingType: EventType['schedulingType'] = 'individual',
): string {
  if (!me.organization.personal && schedulingType !== 'individual')
    return 'Public booking links for this scheduling mode are not available yet.'
  if (!me.organization.personal && !isPublicTeamSlug(me.organization.slug))
    return TEAM_LINK_SLUG_HINT
  if (!me.organization.personal) return publicTeamPageUrl(me.organization.slug, slug || 'your-link')
  if (!profile) return 'Choose your handle in Settings to get booking links.'
  return publicPageUrl(profile.handle, slug || 'your-link')
}

/** A whole number of minutes, with what it amounts to (e.g. "= 1 day 4 h"). */
function MinutesField({
  id,
  label,
  value,
  error,
  onChange,
  rule,
  optional = false,
  empty,
  extra,
}: {
  id: string
  label: string
  value: string
  error: UiText | undefined
  onChange: (value: string) => void
  rule: { min: number; max: number }
  optional?: boolean
  /** What an empty field means, for optional ones. */
  empty?: string
  extra?: string
}) {
  const { t, ui, locale: displayLocale } = useI18n()

  const minutes = parseWhole(value)
  const amount =
    minutes === null
      ? optional && empty
        ? msg('Empty: {0}.', { '0': empty })
        : ''
      : Number.isSafeInteger(minutes) && minutes >= 60
        ? `= ${formatMinutes(minutes, displayLocale)}.`
        : ''
  return (
    <Field
      id={id}
      label={t('{0} (minutes)', { '0': label })}
      optional={optional}
      error={ui(error)}
      hint={`${extra ? `${extra} ` : ''}${rule.min}–${rule.max.toLocaleString('en')}. ${ui(amount)}`.trim()}
    >
      {(props) => (
        <input
          {...props}
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  )
}

function LocationFields({
  draft,
  errors,
  set,
}: {
  draft: EventTypeDraft
  errors: FieldErrors
  set: <K extends keyof EventTypeDraft>(name: K, value: EventTypeDraft[K]) => void
}) {
  const { t, ui } = useI18n()

  return (
    <div className="stack">
      <Field
        id="location-kind"
        label={t('Where the meeting happens')}
        error={ui(errors['location-kind'])}
      >
        {(props) => (
          <select
            {...props}
            value={draft.locationKind}
            onChange={(e) => set('locationKind', e.target.value as LocationKind | '')}
          >
            {LOCATION_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {ui(k.label)}
              </option>
            ))}
          </select>
        )}
      </Field>
      {draft.locationKind === 'phone' && (
        <Field
          id="location-phone"
          label={t('Your phone number')}
          error={ui(errors['location-phone'])}
          hint={t('In international format, e.g. +14155550123. Invitees see it after booking.')}
        >
          {(props) => (
            <input
              {...props}
              type="tel"
              autoComplete="tel"
              value={draft.phone}
              onChange={(e) => set('phone', e.target.value)}
            />
          )}
        </Field>
      )}
      {draft.locationKind === 'in_person' && (
        <Field
          id="location-address"
          label={t('Address')}
          error={ui(errors['location-address'])}
          hint={t('Up to {0} characters on one line.', { '0': EVENT_TYPE.addressMaxLength })}
        >
          {(props) => (
            <input
              {...props}
              autoComplete="street-address"
              value={draft.address}
              onChange={(e) => set('address', e.target.value)}
            />
          )}
        </Field>
      )}
      {draft.locationKind === 'link' && (
        <Field
          id="location-url"
          label={t('Meeting link')}
          error={ui(errors['location-url'])}
          hint={t('An https:// or http:// link, e.g. to your video room.')}
        >
          {(props) => (
            <input
              {...props}
              type="url"
              inputMode="url"
              value={draft.url}
              onChange={(e) => set('url', e.target.value)}
            />
          )}
        </Field>
      )}
    </div>
  )
}
