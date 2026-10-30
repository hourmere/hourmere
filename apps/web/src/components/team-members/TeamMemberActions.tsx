import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { ListedOrganizationMember } from '../../api/auth.ts'
import type { Schemas } from '../../api/client.ts'
import { errorMessage, isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import {
  type DepartureHandling,
  getDepartureImpact,
  getRemovalHandling,
  leaveTeam,
  MemberActionError,
  removeMember,
} from '../../api/member-actions.ts'
import { browserTimeZone, zoned } from '../../format.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { bookingPath, eventTypePath, PATHS } from '../../paths.ts'
import { BreakableText } from '../BreakableText.tsx'
import './TeamMemberActions.css'

type Impact = Schemas['MemberDepartureImpact']
type Removal = Schemas['MemberRemoval']
type RemovalHandling = Schemas['MemberRemovalHandling']
type Booking = Impact['bookings']['data'][number]

function rolesFor(role: string | null) {
  const roles = role?.split(',').map((value) => value.trim()) ?? []
  return roles.length && roles.every((value) => ['owner', 'admin', 'member'].includes(value))
    ? roles
    : []
}

function mayManage(role: string | null) {
  const roles = rolesFor(role)
  return roles.includes('owner') || roles.includes('admin')
}

/** Unknown role tokens fail closed, and owner/self targets always use safe departure. */
export function RemoveMemberButton({
  member,
  role,
  currentUserId,
  onSelect,
  disabled = false,
}: {
  member: ListedOrganizationMember
  role: string | null
  currentUserId: string | undefined
  onSelect: (member: ListedOrganizationMember, opener: HTMLButtonElement) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const actor = rolesFor(role)
  const target = rolesFor(member.role)
  if (
    !currentUserId ||
    currentUserId.toLowerCase() === member.userId.toLowerCase() ||
    target.length === 0 ||
    target.includes('owner') ||
    (!actor.includes('owner') && !(actor.includes('admin') && !target.includes('admin')))
  )
    return null
  return (
    <button
      type="button"
      className="button button-small team-member-remove"
      disabled={disabled}
      aria-label={t('Remove member: {0}', {
        '0': member.user.name.trim() || t('Unnamed team member'),
      })}
      onClick={(event) => onSelect(member, event.currentTarget)}
    >
      {t('Remove member')}
    </button>
  )
}

export function TeamMemberActions({
  organizationId,
  currentUserId,
  role,
  selectedMember,
  onClose,
  onRemoved,
  onLeft,
  onReload,
  onReviewChange,
  removalOpener,
  disabled = false,
}: {
  organizationId: string
  currentUserId?: string
  role: string | null
  selectedMember: ListedOrganizationMember | null
  onClose: () => void
  onRemoved: () => void
  onLeft: () => void
  onReload: () => void
  onReviewChange?: (open: boolean) => void
  removalOpener?: HTMLElement | null
  disabled?: boolean
}) {
  const { t } = useI18n()
  const [leavingOrganization, setLeavingOrganization] = useState<string | null>(null)
  const [leftOrganization, setLeftOrganization] = useState<string | null>(null)
  const previousOrganization = useRef(organizationId)
  const leaveButton = useRef<HTMLButtonElement>(null)
  const leftFeedback = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const mode = selectedMember ? 'remove' : leavingOrganization === organizationId ? 'leave' : null
  const memberUserId = selectedMember?.userId ?? currentUserId

  useEffect(() => {
    if (previousOrganization.current !== organizationId) {
      previousOrganization.current = organizationId
      setLeavingOrganization(null)
      setLeftOrganization(null)
    }
  }, [organizationId])

  useEffect(() => {
    onReviewChange?.(mode !== null)
    return () => onReviewChange?.(false)
  }, [mode, onReviewChange])

  function close() {
    setLeavingOrganization(null)
    onClose()
    queueMicrotask(() => {
      if (opener.current?.isConnected) opener.current.focus()
      else if (leftFeedback.current) leftFeedback.current.focus()
      else leaveButton.current?.focus()
    })
  }

  return (
    <div className="team-member-actions">
      {currentUserId && leftOrganization !== organizationId && (
        <button
          ref={leaveButton}
          type="button"
          className="button button-small"
          disabled={mode !== null || disabled}
          onClick={() => {
            opener.current = leaveButton.current
            setLeavingOrganization(organizationId)
          }}
        >
          {t('Leave team')}
        </button>
      )}
      {leftOrganization === organizationId && mode === null && (
        <div ref={leftFeedback} tabIndex={-1}>
          <LeftTeamNotice onReload={onReload} />
        </div>
      )}
      {mode && memberUserId && (
        <DepartureReview
          key={`${organizationId}:${memberUserId}:${mode}:${role}`}
          organizationId={organizationId}
          memberUserId={memberUserId}
          viewerUserId={currentUserId}
          memberName={selectedMember?.user.name}
          mode={mode}
          canManage={mayManage(role)}
          onOpen={() => {
            if (selectedMember && removalOpener) {
              opener.current = removalOpener
              return
            }
            if (
              document.activeElement instanceof HTMLElement &&
              document.activeElement !== document.body
            )
              opener.current = document.activeElement
          }}
          onClose={close}
          onRemoved={onRemoved}
          onLeft={() => {
            setLeftOrganization(organizationId)
            onLeft()
          }}
          onReload={onReload}
        />
      )}
    </div>
  )
}

function LeftTeamNotice({ onReload }: { onReload: () => void }) {
  const { t } = useI18n()
  return (
    <div className="alert alert-success" role="status">
      <p>{t('You left the team. Reload to open your personal space.')}</p>
      <button type="button" className="button button-small" onClick={onReload}>
        {t('Reload team')}
      </button>
    </div>
  )
}

function ActionError({
  error,
  mode,
  onReload,
}: {
  error: unknown
  mode: 'leave' | 'remove'
  onReload: () => void
}) {
  const { t, ui } = useI18n()
  const request = error instanceof RequestError ? error : undefined
  let message = ui(errorMessage(error))
  if (request?.code === 'member_departure_owner_required')
    message = t(
      'The team must retain at least one owner. Ownership transfer is not available here.',
    )
  else if (request?.code === 'member_departure_blocked')
    message = t('You cannot leave while team events or bookings still need handling.')
  else if (request?.status === 403)
    message = t(
      mode === 'leave'
        ? 'Your permission or team membership changed. Reload to check before trying again.'
        : 'Your permission or this member’s team membership changed. Reload to check before trying again.',
    )
  const reload = isOrganizationContextChanged(error) || request?.status === 403
  return (
    <div role="alert" className="alert alert-error">
      <p>{message}</p>
      {reload && (
        <button type="button" className="button button-small" onClick={onReload}>
          {t('Reload team')}
        </button>
      )}
    </div>
  )
}

function cannotRetryWrite(error: unknown) {
  return (
    isOrganizationContextChanged(error) ||
    (error instanceof RequestError &&
      (error.status === 401 ||
        error.status === 403 ||
        error.code === 'member_departure_owner_required'))
  )
}

function DepartureReview({
  organizationId,
  memberUserId,
  viewerUserId,
  memberName,
  mode,
  canManage,
  onOpen,
  onClose,
  onRemoved,
  onLeft,
  onReload,
}: {
  organizationId: string
  memberUserId: string
  viewerUserId: string | undefined
  memberName?: string
  mode: 'leave' | 'remove'
  canManage: boolean
  onOpen: () => void
  onClose: () => void
  onRemoved: () => void
  onLeft: () => void
  onReload: () => void
}) {
  const { t } = useI18n()
  const [impact, setImpact] = useState<Impact | null>(null)
  const [departureHandling, setDepartureHandling] = useState<DepartureHandling>()
  const [left, setLeft] = useState(false)
  const [removal, setRemoval] = useState<Removal | null>(null)
  const [handling, setHandling] = useState<RemovalHandling | null>(null)
  const [pending, setPending] = useState<'preview' | 'more' | 'write' | 'handling' | null>(
    'preview',
  )
  const [error, setError] = useState<unknown>(null)
  const [impactError, setImpactError] = useState<unknown>(null)
  const [handlingError, setHandlingError] = useState<unknown>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const feedback = useRef<HTMLDivElement>(null)
  const active = useRef<AbortController | null>(null)
  const headingId = useId()

  const begin = useCallback(() => {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    return controller
  }, [])
  const current = useCallback((controller: AbortController) => {
    return active.current === controller && !controller.signal.aborted
  }, [])

  const loadImpact = useCallback(async () => {
    const controller = begin()
    setPending('preview')
    setError(null)
    setImpactError(null)
    try {
      const result = await getDepartureImpact(organizationId, memberUserId, {}, controller.signal)
      if (!current(controller)) return
      setImpact(result)
    } catch (err) {
      if (!current(controller)) return
      setError(err)
    }
    if (current(controller)) setPending(null)
  }, [begin, current, organizationId, memberUserId])

  useEffect(() => {
    void loadImpact()
    return () => active.current?.abort()
  }, [loadImpact])
  // The keyed review owns one opening and captures its opener before taking focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: opening focus happens once per review
  useEffect(() => {
    onOpen()
    heading.current?.focus()
  }, [])
  useEffect(() => {
    if (error || impactError || left || removal || handlingError) feedback.current?.focus()
  }, [error, impactError, left, removal, handlingError])

  async function moreImpact(kind: 'eventTypes' | 'bookings') {
    const cursor = impact?.[kind].nextCursor
    if (
      !impact ||
      !cursor ||
      pending !== null ||
      cannotRetryWrite(error) ||
      cannotRetryWrite(impactError)
    )
      return
    const controller = begin()
    setPending('more')
    setImpactError(null)
    heading.current?.focus()
    try {
      const result = await getDepartureImpact(
        organizationId,
        memberUserId,
        kind === 'eventTypes' ? { eventTypesCursor: cursor } : { bookingsCursor: cursor },
        controller.signal,
      )
      if (!current(controller)) return
      setImpact((previous) =>
        previous
          ? {
              ...previous,
              evaluatedAt: result.evaluatedAt,
              [kind]: {
                ...result[kind],
                data: [
                  ...previous[kind].data,
                  ...result[kind].data.filter(
                    (item) => !previous[kind].data.some((seen) => seen.id === item.id),
                  ),
                ],
              },
            }
          : result,
      )
    } catch (err) {
      if (!current(controller)) return
      setImpactError(err)
    }
    if (current(controller)) setPending(null)
  }

  async function loadHandling(operationId: string, cursor?: string) {
    const controller = begin()
    setPending('handling')
    setHandlingError(null)
    try {
      const result = await getRemovalHandling(
        organizationId,
        operationId,
        cursor,
        controller.signal,
      )
      if (!current(controller)) return
      setHandling((previous) =>
        cursor && previous
          ? {
              ...result,
              bookings: {
                ...result.bookings,
                data: [
                  ...previous.bookings.data,
                  ...result.bookings.data.filter(
                    (item) => !previous.bookings.data.some((seen) => seen.id === item.id),
                  ),
                ],
              },
            }
          : result,
      )
    } catch (err) {
      if (!current(controller)) return
      setHandlingError(err)
    }
    if (current(controller)) setPending(null)
  }

  async function confirm() {
    if (
      pending !== null ||
      left ||
      removal ||
      !impact ||
      cannotRetryWrite(error) ||
      cannotRetryWrite(impactError)
    )
      return
    const controller = begin()
    setPending('write')
    setError(null)
    setImpactError(null)
    setDepartureHandling(undefined)
    heading.current?.focus()
    try {
      if (mode === 'leave') {
        await leaveTeam(organizationId, controller.signal)
        if (!current(controller)) return
        setLeft(true)
        setPending(null)
        onLeft()
      } else {
        const result = await removeMember(organizationId, memberUserId, controller.signal)
        if (!current(controller)) return
        setRemoval(result)
        onRemoved()
        void loadHandling(result.operationId)
      }
    } catch (err) {
      if (!current(controller)) return
      if (err instanceof MemberActionError) {
        if (err.impact) setImpact(err.impact)
        setDepartureHandling(err.handling)
      }
      setError(err)
      setPending(null)
    }
  }

  function close() {
    if (pending === 'write') return
    active.current?.abort()
    onClose()
  }

  return (
    <section
      className="team-member-review"
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (pending !== 'write') close()
        }
      }}
    >
      <div className="team-member-review-header">
        <h3 id={headingId} ref={heading} tabIndex={-1}>
          {t(mode === 'leave' ? 'Review leaving this team' : 'Remove team member')}
        </h3>
        <button
          type="button"
          className="button button-small"
          disabled={pending === 'write'}
          onClick={close}
        >
          {t(removal || left ? 'Close details' : 'Cancel')}
        </button>
      </div>
      {memberName && (
        <p className="user-content">
          <BreakableText>{memberName.trim() || t('Unnamed team member')}</BreakableText>
        </p>
      )}
      {mode === 'remove' && !removal && (
        <div className="team-member-consequences">
          <p>{t('Access is revoked immediately after confirmation.')}</p>
          <p>{t('Future bookings are kept and still need handling.')}</p>
          <p>
            {t(
              'Individual and collective event types are deactivated. Round-robin event types are deactivated when no other current verified team host remains.',
            )}
          </p>
        </div>
      )}
      {pending === 'preview' && <p role="status">{t('Loading departure impact…')}</p>}
      <div ref={feedback} tabIndex={-1}>
        {left && <LeftTeamNotice onReload={onReload} />}
        {removal && (
          <div className="alert alert-success" role="status">
            <p>{t('Member removed. Access was revoked immediately.')}</p>
            <p>
              {t('{0} event types deactivated.', { '0': removal.deactivatedEventTypeIds.length })}
            </p>
          </div>
        )}
        {error != null && <ActionError error={error} mode={mode} onReload={onReload} />}
        {impactError != null && <ActionError error={impactError} mode={mode} onReload={onReload} />}
        {handlingError != null && (
          <div role="alert" className="alert alert-error">
            <p>{t('Could not load the handling list. The member is still removed.')}</p>
            <ActionError error={handlingError} mode={mode} onReload={onReload} />
            <button
              type="button"
              className="button button-small"
              onClick={() => {
                if (removal)
                  void loadHandling(removal.operationId, handling?.bookings.nextCursor ?? undefined)
              }}
            >
              {t('Retry handling list')}
            </button>
          </div>
        )}
      </div>
      {!impact && pending !== 'preview' && !cannotRetryWrite(error) && (
        <button type="button" className="button button-small" onClick={() => void loadImpact()}>
          {t('Try again')}
        </button>
      )}
      {!left && !removal && impact && (
        <>
          <ImpactList
            impact={impact}
            mode={mode}
            viewerUserId={viewerUserId}
            canManage={canManage}
            blocked={departureHandling !== undefined}
            busy={pending !== null || cannotRetryWrite(error) || cannotRetryWrite(impactError)}
            more={(kind) => void moreImpact(kind)}
          />
          <div className="form-actions">
            <button
              type="button"
              className="button button-small button-danger"
              disabled={
                pending !== null || cannotRetryWrite(error) || cannotRetryWrite(impactError)
              }
              onClick={() => void confirm()}
            >
              {t(
                mode === 'leave'
                  ? pending === 'write'
                    ? 'Leaving team…'
                    : 'Leave this team'
                  : pending === 'write'
                    ? 'Removing member…'
                    : 'Remove member',
              )}
            </button>
          </div>
        </>
      )}
      {removal && (
        <div className="team-member-handling">
          {removal.deactivatedEventTypeIds.length > 0 && (
            <>
              <h4>{t('Deactivated event types')}</h4>
              <p>
                {t(
                  'Repair the host assignments, then review and reactivate these event types when ready.',
                )}
              </p>
              <ul className="team-member-impact-list">
                {removal.deactivatedEventTypeIds.map((id) => (
                  <li key={id}>
                    <p className="user-content">
                      <BreakableText>
                        {impact?.eventTypes.data.find((eventType) => eventType.id === id)?.title ??
                          id}
                      </BreakableText>
                    </p>
                    <p className="hint">
                      {t('Event type ID')}: <BreakableText>{id}</BreakableText>
                    </p>
                    {canManage && <Link to={eventTypePath(id)}>{t('Manage event type')}</Link>}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h4>{t('Handling list')}</h4>
          <p>{t('Future bookings are kept and still need handling.')}</p>
          {pending === 'handling' && <p role="status">{t('Loading handling list…')}</p>}
          {handling && (
            <>
              <p>
                {t('{0} future or in-progress bookings', { '0': handling.bookings.totalCount })}
              </p>
              <BookingList
                bookings={handling.bookings.data}
                canManage={canManage}
                viewerUserId={viewerUserId}
              />
              {handling.bookings.nextCursor && (
                <button
                  type="button"
                  className="button button-small"
                  disabled={pending !== null}
                  onClick={() =>
                    void loadHandling(
                      removal.operationId,
                      handling.bookings.nextCursor ?? undefined,
                    )
                  }
                >
                  {t('More bookings')}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}

function ImpactList({
  impact,
  mode,
  viewerUserId,
  canManage,
  blocked,
  busy,
  more,
}: {
  impact: Impact
  mode: 'leave' | 'remove'
  viewerUserId: string | undefined
  canManage: boolean
  blocked: boolean
  busy: boolean
  more: (kind: 'eventTypes' | 'bookings') => void
}) {
  const { t } = useI18n()
  return (
    <div className="team-member-impact">
      <p>{t('{0} affected event types', { '0': impact.eventTypes.totalCount })}</p>
      <p>{t('{0} future or in-progress bookings', { '0': impact.bookings.totalCount })}</p>
      {impact.eventTypes.totalCount === 0 && impact.bookings.totalCount === 0 && (
        <p>{t('No affected event types or bookings.')}</p>
      )}
      {impact.eventTypes.totalCount > 0 && (
        <>
          <h4>{t('Affected event types')}</h4>
          <p>
            {t(
              mode === 'leave'
                ? canManage
                  ? 'Replace or remove yourself as a host before leaving.'
                  : 'Ask a team owner or admin to replace or remove you as a host.'
                : 'Replace or remove this member as a host where needed.',
            )}
          </p>
          {!canManage && <p>{t('Only team owners and admins can change team event types.')}</p>}
          {blocked && (
            <p>
              {t(
                'Disabled event types still need their host assignments repaired before you can leave.',
              )}
            </p>
          )}
          <ul className="team-member-impact-list">
            {impact.eventTypes.data.map((eventType) => (
              <li key={eventType.id}>
                <p className="user-content">
                  <strong>
                    <BreakableText>{eventType.title}</BreakableText>
                  </strong>
                  {!eventType.isActive && <> · {t('Disabled')}</>}
                </p>
                <p className="hint">
                  {t('Event type ID')}: <BreakableText>{eventType.id}</BreakableText>
                </p>
                <p>
                  {t(
                    eventType.reason === 'sole_host'
                      ? mode === 'leave'
                        ? 'You are the sole host for this event type.'
                        : 'This member is the sole host for this event type.'
                      : eventType.reason === 'round_robin_pool_member'
                        ? mode === 'leave'
                          ? 'You are in the round-robin host pool.'
                          : 'This member is in the round-robin host pool.'
                        : mode === 'leave'
                          ? 'You are a required host for this collective event type.'
                          : 'This member is a required host for this collective event type.',
                  )}
                </p>
                <p>
                  {t('{0} other current verified team hosts remain.', {
                    '0': eventType.remainingHostCount,
                  })}
                </p>
                {canManage && (
                  <Link to={eventTypePath(eventType.id)}>{t('Manage event type')}</Link>
                )}
              </li>
            ))}
          </ul>
          {impact.eventTypes.nextCursor && (
            <button
              type="button"
              className="button button-small"
              disabled={busy}
              onClick={() => more('eventTypes')}
            >
              {t('More event types')}
            </button>
          )}
        </>
      )}
      {impact.bookings.totalCount > 0 && (
        <>
          <h4>{t('Bookings needing handling')}</h4>
          <BookingList
            bookings={impact.bookings.data}
            canManage={canManage}
            viewerUserId={viewerUserId}
          />
          {impact.bookings.nextCursor && (
            <button
              type="button"
              className="button button-small"
              disabled={busy}
              onClick={() => more('bookings')}
            >
              {t('More bookings')}
            </button>
          )}
        </>
      )}
    </div>
  )
}

function BookingList({
  bookings,
  canManage,
  viewerUserId,
}: {
  bookings: Booking[]
  canManage: boolean
  viewerUserId: string | undefined
}) {
  const { t, locale } = useI18n()
  const format = zoned(browserTimeZone(), locale)
  return (
    <>
      {bookings.length > 0 && (
        <p>
          {canManage ? (
            <Link to={PATHS.teamBookings}>{t('Review team bookings')}</Link>
          ) : (
            t(
              'You can cancel your own hosted bookings before they start. Ask a team owner or admin for help with other team bookings.',
            )
          )}
        </p>
      )}
      <ul className="team-member-impact-list">
        {bookings.map((booking) => (
          <li key={booking.id}>
            <p className="user-content">
              <strong>
                <BreakableText>{booking.eventType?.title ?? t('Deleted event type')}</BreakableText>
              </strong>
            </p>
            <p className="hint">
              {t('Booking ID')}: <BreakableText>{booking.id}</BreakableText>
            </p>
            <p>
              <time dateTime={booking.start}>{format.dateTime(booking.start)}</time>
              {' – '}
              <time dateTime={booking.end}>{format.dateTime(booking.end)}</time>
            </p>
            <p>
              {t(
                booking.handling === 'wait_until_end_or_coordinate_offline'
                  ? 'Wait until the meeting ends or coordinate offline.'
                  : 'Coordinate cancellation with the hosts and attendees.',
              )}
            </p>
            {booking.handling === 'coordinate_cancellation' &&
              viewerUserId &&
              booking.hosts.some(
                (host) => host.userId.toLowerCase() === viewerUserId.toLowerCase(),
              ) && <Link to={bookingPath(booking.id)}>{t('Review your hosted booking')}</Link>}
            <dl className="team-member-booking-people">
              <dt>{t('Hosts')}</dt>
              <dd>
                {booking.hosts.map((host) => (
                  <span key={host.userId} className="user-content">
                    <BreakableText>{host.name}</BreakableText>
                  </span>
                ))}
              </dd>
              <dt>{t('People')}</dt>
              <dd>
                {booking.attendees.map((person) => (
                  <span key={person.email} className="user-content">
                    <BreakableText>{person.name}</BreakableText>
                    {' · '}
                    <a href={`mailto:${person.email}`}>
                      <BreakableText>{person.email}</BreakableText>
                    </a>
                  </span>
                ))}
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </>
  )
}
