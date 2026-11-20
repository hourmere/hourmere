import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { type EventType, loadEventTypes, loadProfile } from '../../api/resources.ts'
import { EventTypeSelect } from '../../components/EventTypeSelect.tsx'
import { ErrorSummary, Field, type FieldErrors } from '../../components/forms.tsx'
import { OrganizationContextConflict } from '../../components/OrganizationContextConflict.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { TimeZonePicker } from '../../components/TimeZonePicker.tsx'
import { browserTimeZone, isKnownTimeZone, zoned } from '../../format.ts'
import { useLoad, useMounted, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { meetingPollPath, PATHS } from '../../paths.ts'
import type { Slot } from '../../public/api.ts'
import { dateKeyIn, offsetLabel } from '../../public/time.ts'
import { randomHex } from '../../random.ts'
import { type Me, useMe } from '../../session.tsx'
import { useTeamManagementAccess } from '../../team-management.tsx'
import { useUnsavedChanges } from '../../unsaved-changes.tsx'
import { MeetingLengthSelect } from '../event-types/HostTimeSelection.tsx'
import { MAX_POLL_CANDIDATES, PollCandidateTimes } from './PollCandidateTimes.tsx'
import { PollPublicLink } from './PollPublicLink.tsx'
import { pollDeadlineInstants, pollDeadlineLocal } from './poll-deadline.ts'
import {
  type CreatePollBody,
  createPoll,
  isUncertainPollWrite,
  PollCreateConflict,
} from './poll-host-api.ts'
import { pollTimeRange } from './poll-time.ts'
import './meeting-poll-create.css'

const HOUR = 60 * 60_000
const MAX_DEADLINE = 30 * 24 * HOUR
const DEADLINE = 'poll-create-deadline'
const CANDIDATES = 'poll-create-candidates'
const EVENT_CHANGED =
  'This event type changed. Reload event types and review your choices before creating the poll.'
const POSSIBLY_CREATED = 'The poll may have been created. Retry this submission to recover it.'
const GENERIC_ERROR = 'Could not create the meeting poll. Review your choices and try again.'

export function MeetingPollCreatePage() {
  const { t } = useI18n()
  const me = useMe()
  const access = useTeamManagementAccess()
  usePageTitle('Create meeting poll')
  return (
    <>
      <p className="breadcrumb">
        <Link to={PATHS.meetingPolls}>{t('Back to meeting polls')}</Link>
      </p>
      <PageHeader title={t('Create meeting poll')} />
      {me.principal.kind !== 'session' ? (
        <p className="alert alert-error" role="alert">
          {t('Use a browser session without an Authorization header.')}
        </p>
      ) : !me.organization.personal && access.status === 'loading' ? (
        <PageSkeleton label="Loading event types…" />
      ) : !me.organization.personal && access.status === 'error' ? (
        <SetupError retry={access.reload} />
      ) : !me.organization.personal && access.status === 'ready' && access.role === null ? (
        <PermissionDenied />
      ) : (
        <PollCreateSetup key={`${me.user.id}:${me.organization.id}`} me={me} />
      )}
    </>
  )
}

function SetupError({ retry }: { retry: () => void }) {
  const { t } = useI18n()
  return (
    <div className="alert alert-error" role="alert" data-testid="meeting-poll-create-load-error">
      <p>{t('Could not load your event types.')}</p>
      <button className="button button-small" type="button" onClick={retry}>
        {t('Try again')}
      </button>
    </div>
  )
}

function PermissionDenied() {
  const { t } = useI18n()
  return (
    <p className="alert alert-error" role="alert" data-testid="meeting-poll-create-denied">
      {t('Only team owners and admins can manage meeting polls in this space.')}
    </p>
  )
}

function PollCreateSetup({ me }: { me: Me }) {
  const [version, setVersion] = useState(0)
  return (
    <PollCreateLoad key={version} me={me} reload={() => setVersion((current) => current + 1)} />
  )
}

function PollCreateLoad({ me, reload }: { me: Me; reload: () => void }) {
  const { t } = useI18n()
  const { id: organizationId, personal, slug } = me.organization
  const userId = me.user.id
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [events, profile] = await Promise.all([loadEventTypes(signal), loadProfile(signal)])
      return {
        events: events.filter(
          (event) =>
            event.organizationId === organizationId &&
            event.ownerUserId === (personal ? userId : null) &&
            event.isActive &&
            event.bookingMode === 'individual',
        ),
        handle: personal ? profile?.handle : slug,
        timeZone: profile?.timeZone ?? browserTimeZone(),
      }
    },
    [organizationId, personal, slug, userId],
  )
  const [state, retry] = useLoad(load)
  if (state.status === 'loading') return <PageSkeleton label="Loading event types…" />
  if (state.status === 'error') return <SetupError retry={retry} />
  const { events, handle, timeZone } = state.data
  const first = events[0]
  if (!first)
    return (
      <p className="alert alert-info" data-testid="meeting-poll-create-empty">
        {t('No active individual event types are available for polls in this space.')}
      </p>
    )
  if (!handle)
    return (
      <div className="alert alert-error" role="alert" data-testid="meeting-poll-create-no-address">
        <p>{t('We could not load available times. Please try again.')}</p>
        <button className="button button-small" type="button" onClick={retry}>
          {t('Try again')}
        </button>
      </div>
    )
  return (
    <PollCreateForm
      organizationId={organizationId}
      events={events}
      first={first}
      handle={handle}
      team={!personal}
      initialZone={isKnownTimeZone(timeZone) ? timeZone : 'UTC'}
      reload={reload}
    />
  )
}

type Attempt = { body: CreatePollBody; key: string }
type Completion = { pollId: string | null; publicLink: string | null; recovered: boolean }
type Issue = { message: MessageKey; refresh?: boolean } | { context: RequestError }

function PollCreateForm({
  organizationId,
  events,
  first,
  handle,
  team,
  initialZone,
  reload,
}: {
  organizationId: string
  events: EventType[]
  first: EventType
  handle: string
  team: boolean
  initialZone: string
  reload: () => void
}) {
  const { t, formatLocale } = useI18n()
  const mounted = useMounted()
  const inFlight = useRef(false)
  const issueFocus = useRef<HTMLDivElement>(null)
  const [event, setEvent] = useState(first)
  const [duration, setDuration] = useState(first.durationMinutes)
  const [timeZone, setTimeZone] = useState(initialZone)
  const [zoneInput, setZoneInput] = useState(initialZone)
  const [date, setDate] = useState(() => dateKeyIn(Date.now(), initialZone))
  const [deadline, setDeadline] = useState('')
  const [deadlineOffset, setDeadlineOffset] = useState('')
  const [admission, setAdmission] = useState<CreatePollBody['admissionMode']>('invited')
  const [visibility, setVisibility] = useState<NonNullable<CreatePollBody['visibility']>>('private')
  const [selected, setSelected] = useState<Slot[]>([])
  const [stale, setStale] = useState<number[]>([])
  const [pickerVersion, setPickerVersion] = useState(0)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [submissions, setSubmissions] = useState(0)
  const [issue, setIssue] = useState<Issue | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Attempt | null>(null)
  const [completion, setCompletion] = useState<Completion | null>(null)
  const hideLink = useCallback(() => {
    setCompletion((current) => (current ? { ...current, publicLink: null } : current))
  }, [])
  const blocked = issue && ('context' in issue || issue.refresh)
  const disabled = busy || Boolean(pending || blocked)
  const format = zoned(timeZone, formatLocale)
  const deadlineOptions = pollDeadlineInstants(deadline, timeZone)
  const deadlineAt = deadlineOptions.length === 1 ? deadlineOptions[0] : deadlineOffset
  useUnsavedChanges(
    !completion &&
      Boolean(
        deadline ||
          event !== first ||
          duration !== first.durationMinutes ||
          selected.length ||
          initialZone !== zoneInput ||
          admission !== 'invited' ||
          visibility !== 'private',
      ),
  )
  useEffect(() => {
    if (issue) issueFocus.current?.focus()
  }, [issue])

  function changeZone(zone: string) {
    setZoneInput(zone)
    if (!isKnownTimeZone(zone) || zone === timeZone) return
    setTimeZone(zone)
    const today = dateKeyIn(Date.now(), zone)
    if (date && date < today) setDate(today)
    if (deadlineAt) {
      setDeadline(pollDeadlineLocal(Date.parse(deadlineAt), zone))
      setDeadlineOffset(deadlineAt)
    }
  }

  function changeLength(minutes: number) {
    setDuration(minutes)
    setSelected([])
    setStale([])
  }

  function toggle(slot: Slot) {
    if (selected.some(({ start }) => start === slot.start)) {
      setSelected(selected.filter(({ start }) => start !== slot.start))
      const remainingStale = stale.filter((start) => start !== Date.parse(slot.start))
      setStale(remainingStale)
      if (stale.length > 0 && remainingStale.length === 0) setIssue(null)
    } else if (selected.length < MAX_POLL_CANDIDATES) {
      setSelected([...selected, slot].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)))
    }
  }

  function submit(eventSubmit: FormEvent<HTMLFormElement>) {
    eventSubmit.preventDefault()
    if (disabled || inFlight.current || stale.length) return
    const nextErrors: FieldErrors = {}
    if (selected.length < 2) nextErrors[CANDIDATES] = 'Choose 2–20 candidate times.'
    if (zoneInput !== timeZone) nextErrors['poll-create-zone'] = 'Choose an IANA time zone.'
    const now = Date.now()
    const deadlineMillis = Date.parse(deadlineAt ?? '')
    const earliest = Date.parse(selected[0]?.start ?? '')
    if (!deadlineAt) {
      nextErrors[DEADLINE] =
        deadlineOptions.length > 1
          ? 'This local time occurs twice. Choose its UTC offset.'
          : 'Choose a valid deadline in the display time zone.'
    } else if (deadlineMillis - now < HOUR || deadlineMillis - now > MAX_DEADLINE) {
      nextErrors[DEADLINE] = 'The deadline must be 1 hour to 30 days from now.'
    } else if (
      earliest <= deadlineMillis ||
      earliest - deadlineMillis < event.minimumNoticeMinutes * 60_000
    ) {
      nextErrors[DEADLINE] =
        'The deadline must be before every candidate and leave the event’s minimum notice.'
    }
    setErrors(nextErrors)
    setSubmissions((value) => value + 1)
    if (Object.keys(nextErrors).length || !deadlineAt) return
    void save({
      key: randomHex(16),
      body: {
        eventTypeId: event.id,
        durationMinutes: duration,
        candidateStarts: selected.map(({ start }) => start),
        deadlineAt,
        displayTimeZone: timeZone,
        admissionMode: admission,
        visibility,
      },
    })
  }

  async function save(attempt: Attempt) {
    if (inFlight.current || blocked) return
    inFlight.current = true
    setBusy(true)
    setIssue(null)
    let sent = false
    try {
      // Replays must reach the receipt before any event or time validation can refuse them.
      if (!pending) {
        const current = await unwrap(
          api.GET('/api/v1/event-types/{id}', {
            params: { path: { id: event.id } },
            cache: 'no-store',
          }),
        )
        if (!mounted.current) return
        if (current.organizationId !== organizationId)
          throw new RequestError(409, 'organization_context_changed', '')
        if (
          current.id !== event.id ||
          current.updatedAt !== event.updatedAt ||
          current.ownerUserId !== event.ownerUserId ||
          current.bookingMode !== 'individual' ||
          !current.isActive
        ) {
          setIssue({ message: EVENT_CHANGED, refresh: true })
          return
        }
      }
      sent = true
      const result = await createPoll(organizationId, attempt.body, attempt.key)
      if (!mounted.current) return
      setPending(null)
      setCompletion({ pollId: result.poll.id, publicLink: result.publicLink, recovered: false })
    } catch (error) {
      if (!mounted.current) return
      if (error instanceof RequestError && isOrganizationContextChanged(error)) {
        setIssue({ context: error })
      } else if (sent && isUncertainPollWrite(error)) {
        setPending(attempt)
        setIssue({ message: POSSIBLY_CREATED })
      } else if (error instanceof RequestError && error.status === 429) {
        setIssue({ message: 'Too many requests. Please wait and try again later.' })
      } else {
        if (error instanceof PollCreateConflict && error.code === 'poll_already_created') {
          if (error.pollId === undefined) {
            setPending(attempt)
            setIssue({ message: POSSIBLY_CREATED })
          } else {
            setPending(null)
            setCompletion({ pollId: error.pollId, recovered: true, publicLink: null })
          }
        } else if (error instanceof PollCreateConflict && error.code === 'slot_unavailable') {
          setPending(null)
          setStale(error.unavailableStarts.map(Date.parse))
          setPickerVersion((value) => value + 1)
          setIssue({
            message: 'Some selected times are no longer offered. Review your candidate times.',
          })
        } else if (
          error instanceof RequestError &&
          ((error.code === 'event_type_not_found' && !pending) ||
            [
              'poll_event_changed',
              'event_type_inactive',
              'poll_event_unsupported',
              'invalid_duration',
            ].includes(error.code ?? ''))
        ) {
          setPending(null)
          setIssue({ message: EVENT_CHANGED, refresh: true })
        } else if (error instanceof RequestError && error.status === 403) {
          setIssue({
            message: team
              ? 'Only team owners and admins can manage meeting polls in this space.'
              : "You don't have permission to do that.",
          })
        } else {
          setIssue({
            message: sent ? GENERIC_ERROR : 'Could not check the saved event type. Try again.',
          })
        }
      }
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  if (completion)
    return (
      <CreatedPoll
        completion={completion}
        organizationId={organizationId}
        publicMode={admission === 'public_link'}
        hideLink={hideLink}
      />
    )

  return (
    <form
      className="panel stack meeting-poll-create"
      data-testid="meeting-poll-create"
      onSubmit={submit}
      noValidate
    >
      <ErrorSummary
        errors={errors}
        labels={{
          [DEADLINE]: 'Voting deadline',
          [CANDIDATES]: 'Available times',
          'poll-create-zone': 'Display time zone',
        }}
        attempt={submissions}
      />
      <fieldset className="form-fieldset stack" disabled={disabled}>
        <legend className="visually-hidden">{t('Create meeting poll')}</legend>
        <div className="meeting-poll-create-fields">
          <EventTypeSelect
            id="poll-create-event"
            eventTypes={events}
            value={event.id}
            onChange={(id) => {
              const next = events.find((item) => item.id === id)
              if (!next) return
              setEvent(next)
              changeLength(next.durationMinutes)
            }}
          />
          <Field id="poll-create-duration" label={t('Meeting length')}>
            {(control) => (
              <MeetingLengthSelect
                control={control}
                allowed={event.allowedDurationsMinutes}
                value={duration}
                onChange={changeLength}
              />
            )}
          </Field>
          <Field
            id="poll-create-zone"
            label={t('Display time zone')}
            error={errors['poll-create-zone']}
          >
            {(control) => (
              <TimeZonePicker control={control} value={zoneInput} onChange={changeZone} />
            )}
          </Field>
          <Field id="poll-create-date" label={t('Availability date ({zone})', { zone: timeZone })}>
            {(control) => (
              <input
                {...control}
                type="date"
                min={dateKeyIn(Date.now(), timeZone)}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            )}
          </Field>
        </div>
        <p className="hint">
          {t('Choose 2–20 available times. Proposing times does not reserve them.')}
        </p>
        {date && (
          <PollCandidateTimes
            key={`${event.id}:${duration}:${timeZone}:${date}:${pickerVersion}`}
            handle={handle}
            slug={event.slug}
            team={team}
            timeZone={timeZone}
            date={date}
            durationMinutes={duration}
            disabled={disabled}
            selected={selected}
            onSelect={toggle}
          />
        )}
        {selected.length > 0 && (
          <fieldset>
            <legend>{t('Selected times')}</legend>
            <ul className="plain-list meeting-poll-create-selected">
              {selected.map((slot) => {
                const label = pollTimeRange(format, slot.start, slot.end)
                return (
                  <li key={slot.start}>
                    <span>
                      {label}{' '}
                      {stale.includes(Date.parse(slot.start)) && (
                        <strong>{t('No longer offered')}</strong>
                      )}
                    </span>
                    <button
                      className="button button-small"
                      type="button"
                      aria-label={t('Remove {time}', { time: label })}
                      onClick={() => toggle(slot)}
                    >
                      {t('Remove time')}
                    </button>
                  </li>
                )
              })}
            </ul>
          </fieldset>
        )}
        <Field
          id={DEADLINE}
          label={t('Voting deadline')}
          hint={t(
            'Set the deadline 1 hour to 30 days from now. Leave the event’s minimum notice before the earliest candidate.',
          )}
          error={errors[DEADLINE]}
        >
          {(control) => (
            <input
              {...control}
              required
              type="datetime-local"
              value={deadline}
              onChange={(e) => {
                setDeadline(e.target.value)
                setDeadlineOffset('')
              }}
            />
          )}
        </Field>
        {deadlineOptions.length > 1 && (
          <Field
            id="poll-create-deadline-offset"
            label={t('This local time occurs twice. Choose its UTC offset.')}
          >
            {(control) => (
              <select
                {...control}
                required
                value={deadlineOffset}
                onChange={(e) => setDeadlineOffset(e.target.value)}
              >
                <option value="">{t('Choose…')}</option>
                {deadlineOptions.map((instant) => (
                  <option key={instant} value={instant}>
                    {offsetLabel(timeZone, Date.parse(instant))}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field
          id="poll-create-admission"
          label={t('Admission')}
          hint={t(
            admission === 'invited'
              ? 'Only the people you invite by email can join.'
              : 'Anyone with the link can request to join without signing in. They must verify their email address to vote.',
          )}
        >
          {(control) => (
            <select
              {...control}
              value={admission}
              onChange={(e) =>
                setAdmission(e.target.value === 'public_link' ? 'public_link' : 'invited')
              }
            >
              <option value="invited">{t('Invitation only')}</option>
              <option value="public_link">{t('Public link')}</option>
            </select>
          )}
        </Field>
        <Field
          id="poll-create-visibility"
          label={t('Visibility')}
          hint={
            <>
              {t('Voters see their own choices. Hosts can see the roster and individual votes.')}{' '}
              {visibility === 'aggregate' &&
                t(
                  'Verified voters see totals for each time. In small groups, totals can reveal another person’s choices.',
                )}
            </>
          }
        >
          {(control) => (
            <select
              {...control}
              value={visibility}
              onChange={(e) =>
                setVisibility(e.target.value === 'aggregate' ? 'aggregate' : 'private')
              }
            >
              <option value="private">{t('Private votes')}</option>
              <option value="aggregate">{t('Share vote totals')}</option>
            </select>
          )}
        </Field>
        <p className="hint">{t('Admission and visibility are fixed after creation.')}</p>
        <p className="hint">
          {t('This poll has 40 places.')}{' '}
          {t(
            'Verified voters, active invitations and unexpired public sign-ups each reserve a place.',
          )}
        </p>
      </fieldset>
      {issue &&
        ('context' in issue ? (
          <OrganizationContextConflict error={issue.context} />
        ) : (
          <div
            className="alert alert-error"
            ref={issueFocus}
            role="alert"
            tabIndex={-1}
            data-testid="meeting-poll-create-error"
          >
            <p>{t(issue.message)}</p>
            {issue.refresh && (
              <button className="button button-small" type="button" onClick={reload}>
                {t('Reload event types')}
              </button>
            )}
          </div>
        ))}
      <div className="form-actions">
        {pending ? (
          <button
            className="button button-primary"
            type="button"
            disabled={busy || Boolean(blocked)}
            onClick={() => void save(pending)}
          >
            {t(busy ? 'Creating meeting poll…' : 'Retry creation')}
          </button>
        ) : (
          <button
            className="button button-primary"
            type="submit"
            disabled={disabled || stale.length > 0}
          >
            {t(busy ? 'Creating meeting poll…' : 'Create meeting poll')}
          </button>
        )}
      </div>
    </form>
  )
}

function CreatedPoll({
  completion,
  organizationId,
  publicMode,
  hideLink,
}: {
  completion: Completion
  organizationId: string
  publicMode: boolean
  hideLink: () => void
}) {
  const { t } = useI18n()
  const heading = useRef<HTMLHeadingElement>(null)
  const { pollId, publicLink, recovered } = completion
  useEffect(() => {
    if (!publicLink) heading.current?.focus()
  }, [publicLink])
  return (
    <div className="stack" data-testid="meeting-poll-created">
      <section className="panel" aria-labelledby="poll-created-heading">
        <h2 id="poll-created-heading" tabIndex={-1} ref={heading}>
          {t(
            pollId === null
              ? 'This poll was already created and has since been deleted.'
              : recovered
                ? 'Your poll was already created.'
                : 'Meeting poll created',
          )}
        </h2>
        {recovered && publicMode && pollId && (
          <p>
            {t(
              'The public link was shown only in the original response. Open the poll to rotate the link.',
            )}
          </p>
        )}
        {pollId && (
          <Link className="button button-primary" to={meetingPollPath(pollId, organizationId)}>
            {t('Open meeting poll')}
          </Link>
        )}
      </section>
      {publicLink && <PollPublicLink link={publicLink} onDismiss={hideLink} />}
    </div>
  )
}
