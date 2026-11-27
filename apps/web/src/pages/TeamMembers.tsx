import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { type ListedOrganizationMember, listOrganizationMembers } from '../api/auth.ts'
import { errorMessage, RequestError } from '../api/errors.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { MemberReadiness } from '../components/team-members/MemberReadiness.tsx'
import {
  type ManagedMembership,
  useMemberReadiness,
} from '../components/team-members/member-readiness.ts'
import {
  RemoveMemberButton,
  TeamMemberActions,
} from '../components/team-members/TeamMemberActions.tsx'
import {
  RoleManagementNotice,
  TeamMemberRoleButton,
} from '../components/team-members/TeamMemberRole.tsx'
import { UserContentMessage } from '../components/UserContent.tsx'
import { useI18n } from '../i18n/runtime.tsx'
import type { MessageKey, UiText } from '../i18n/translate.ts'
import { PATHS } from '../paths.ts'
import { SsoRecoveryNomination } from './sso/SsoRecoveryEnrollment.tsx'
import { TeamInvitations } from './TeamInvitations.tsx'

const PAGE_SIZE = 20

const membershipBlockers: Record<ManagedMembership['blockers'][number], MessageKey> = {
  scim_suspension: 'Your identity provider suspended this membership.',
  local_suspension: 'A team administrator suspended this membership.',
  local_removal: 'A previous team removal is blocking readmission.',
}

type PageState<T> =
  | { status: 'loading' | 'denied' }
  | { status: 'error'; message: UiText }
  | { status: 'ready'; data: T }

/** Paging replaces the observation; aborted responses cannot restore an older page. */
function useTeamPage<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [result, setResult] = useState<{ load: typeof load; state: PageState<T> }>()
  const [version, setVersion] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: version requests a fresh page after failure
  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ load, state: { status: 'ready', data } })
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            load,
            state:
              error instanceof RequestError && error.status === 403
                ? { status: 'denied' }
                : { status: 'error', message: errorMessage(error) },
          })
      },
    )
    return () => controller.abort()
  }, [load, version])
  const state: PageState<T> = result?.load === load ? result.state : { status: 'loading' }
  const retry = () => {
    setResult(undefined)
    setVersion((value) => value + 1)
  }
  const update = (transform: (data: T) => T) => {
    setResult((previous) =>
      previous?.load === load && previous.state.status === 'ready'
        ? { load, state: { status: 'ready', data: transform(previous.state.data) } }
        : previous,
    )
  }
  return [state, retry, update] as const
}

function PageFeedback<T>({
  state,
  retry,
  loading,
  failed,
  denied,
}: {
  state: PageState<T>
  retry: () => void
  loading: MessageKey
  failed: MessageKey
  denied: MessageKey
}) {
  const { t, ui } = useI18n()
  if (state.status === 'loading') return <p role="status">{t(loading)}</p>
  if (state.status === 'ready') return null
  return (
    <div role="alert" className="alert alert-error">
      <p>{t(state.status === 'denied' ? denied : failed)}</p>
      {state.status === 'error' && <p>{ui(state.message)}</p>}
      <button type="button" className="button button-small" onClick={retry}>
        {t('Try again')}
      </button>
    </div>
  )
}

export function TeamMembers({
  organizationId,
  role,
  currentUserId,
  onLeft = () => {},
  onReload = () => {},
  canNominateRecoveryOwner = false,
}: {
  organizationId: string
  role: string | null
  currentUserId?: string
  onLeft?: () => void
  onReload?: () => void
  canNominateRecoveryOwner?: boolean
}) {
  const { t } = useI18n()
  const { hash, key } = useLocation()
  const section = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: repeat navigation to the same anchor requests focus again
  useEffect(() => {
    if (hash !== '#team-members') return
    // The shell also focuses main after navigation; apply this destination afterwards.
    const timer = setTimeout(() => {
      section.current?.scrollIntoView?.({ block: 'start' })
      heading.current?.focus({ preventScroll: true })
    }, 0)
    return () => clearTimeout(timer)
  }, [hash, key])
  const [offset, setOffset] = useState(0)
  const [selectedMember, setSelectedMember] = useState<ListedOrganizationMember | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [roleReviewOpen, setRoleReviewOpen] = useState(false)
  const [nomineeId, setNomineeId] = useState<string | null>(null)
  const removalOpener = useRef<HTMLButtonElement | null>(null)
  const nominationOpener = useRef<HTMLButtonElement | null>(null)
  const nominating = canNominateRecoveryOwner && nomineeId !== null
  useEffect(() => {
    if (!nominating && nominationOpener.current) {
      nominationOpener.current.focus()
      nominationOpener.current = null
    }
  }, [nominating])
  const load = useCallback(
    (signal: AbortSignal) => listOrganizationMembers(organizationId, offset, PAGE_SIZE, signal),
    [organizationId, offset],
  )
  const [state, retry, update] = useTeamPage(load)
  const [readiness, retryReadiness] = useMemberReadiness(
    organizationId,
    currentUserId,
    role,
    state.status === 'ready' ? state.data.members : [],
  )
  const roles = role?.split(',').map((value) => value.trim()) ?? []
  const canManage =
    roles.every((value) => ['owner', 'admin', 'member'].includes(value)) &&
    (roles.includes('owner') || roles.includes('admin'))
  const labels: Record<string, string> = {
    owner: t('Owner'),
    admin: t('Admin'),
    member: t('Member'),
  }

  return (
    <>
      <section
        id="team-members"
        className="panel"
        aria-labelledby="team-members-heading"
        ref={section}
      >
        <h2 id="team-members-heading" ref={heading} tabIndex={-1}>
          {t('Team members')}
        </h2>
        <p className="hint">{t('Pending invitations are not members or hosts.')}</p>
        <p className="hint">
          {t(
            'Configuration checks do not guarantee available times. Check the booking page for current availability.',
          )}{' '}
          {t('A missing default schedule is a configuration gap, not a report of no free time.')}{' '}
          {t('An external calendar is optional for basic bookings.')}
        </p>
        <RoleManagementNotice />
        {canManage && (
          <p>
            <Link className="button" to={PATHS.eventTypes}>
              {t('Manage team events')}
            </Link>
          </p>
        )}
        <PageFeedback
          state={state}
          retry={retry}
          loading="Loading team members…"
          failed="Could not load team members."
          denied="You do not have permission to view team members."
        />
        {state.status === 'ready' && (
          <>
            {state.data.members.length > 0 && currentUserId && role && (
              <>
                {readiness.status === 'loading' && (
                  <p role="status">{t('Checking member configuration…')}</p>
                )}
                {readiness.status === 'error' && (
                  <div role="alert" className="alert alert-error">
                    <p>{t('Could not check member configuration.')}</p>
                    <button type="button" className="button button-small" onClick={retryReadiness}>
                      {t('Retry checks')}
                    </button>
                  </div>
                )}
                {readiness.status === 'ready' &&
                  [...readiness.data.values()].some((health) =>
                    Object.values(health).some((value) =>
                      ['check_failed', 'not_checked'].includes(value),
                    ),
                  ) && (
                    <button type="button" className="button button-small" onClick={retryReadiness}>
                      {t('Retry checks')}
                    </button>
                  )}
                {readiness.status === 'unavailable' && (
                  <div role="alert" className="alert alert-error">
                    <p>
                      {t(
                        'Your permission or team membership changed. Reload to check before trying again.',
                      )}
                    </p>
                    <button type="button" className="button button-small" onClick={onReload}>
                      {t('Reload team')}
                    </button>
                  </div>
                )}
              </>
            )}
            <p role="status">{t('{0} joined members', { '0': state.data.total })}</p>
            {state.data.members.length === 0 && <p>{t('No team members found.')}</p>}
            <ul className="stack">
              {state.data.members.map((member) => {
                const own = member.userId === currentUserId
                const managedMembership =
                  (own || canManage) && readiness.status === 'ready'
                    ? readiness.managedMemberships.get(member.id)
                    : undefined
                const blockers =
                  managedMembership?.blockers.filter((blocker) =>
                    Object.hasOwn(membershipBlockers, blocker),
                  ) ?? []
                return (
                  <li key={member.id}>
                    <div>
                      <span className="user-content" dir="auto">
                        <BreakableText>
                          {member.user.name.trim() || t('Unnamed team member')}
                        </BreakableText>
                      </span>
                      {own && (
                        <>
                          {' · '}
                          <span className="badge">{t('You')}</span>
                        </>
                      )}
                      {' · '}
                      <span className="user-content">
                        <BreakableText>
                          {member.role
                            .split(',')
                            .map((value) => {
                              const role = value.trim()
                              return Object.hasOwn(labels, role) ? labels[role] : role
                            })
                            .join(', ')}
                        </BreakableText>
                      </span>
                      {managedMembership && (
                        <>
                          {' · '}
                          <span className="badge">{t('Managed by your identity provider')}</span>
                        </>
                      )}
                    </div>
                    {canManage && member.user.email && (
                      <div className="hint user-content" dir="ltr">
                        <BreakableText>{member.user.email}</BreakableText>
                      </div>
                    )}
                    {blockers.length > 0 && (
                      <ul className="hint">
                        {blockers.map((blocker) => (
                          <li key={blocker}>{t(membershipBlockers[blocker])}</li>
                        ))}
                      </ul>
                    )}
                    <TeamMemberRoleButton
                      key={`${organizationId}:${member.id}:${role}:${currentUserId}`}
                      organizationId={organizationId}
                      member={member}
                      role={role}
                      currentUserId={currentUserId}
                      disabled={
                        reviewOpen || selectedMember !== null || roleReviewOpen || nominating
                      }
                      scimSuspended={blockers.includes('scim_suspension')}
                      onReviewChange={setRoleReviewOpen}
                      onChanged={(updated) =>
                        update((data) => ({
                          ...data,
                          members: data.members.map((item) =>
                            item.id === updated.id ? { ...item, role: updated.role } : item,
                          ),
                        }))
                      }
                      onReload={onReload}
                    />
                    <RemoveMemberButton
                      member={member}
                      role={role}
                      currentUserId={currentUserId}
                      disabled={
                        reviewOpen || selectedMember !== null || roleReviewOpen || nominating
                      }
                      onSelect={(target, opener) => {
                        removalOpener.current = opener
                        setSelectedMember(target)
                      }}
                    />
                    {canNominateRecoveryOwner &&
                      member.role.split(',').some((value) => value.trim() === 'owner') && (
                        <div className="form-actions">
                          <button
                            type="button"
                            className="button button-small button-wrap user-content"
                            disabled={
                              reviewOpen || selectedMember !== null || roleReviewOpen || nominating
                            }
                            onClick={(event) => {
                              nominationOpener.current = event.currentTarget
                              setNomineeId(member.userId)
                            }}
                          >
                            <UserContentMessage
                              message="Nominate {name} for SSO recovery"
                              values={{ name: member.user.name.trim() || t('Unnamed team member') }}
                            />
                          </button>
                        </div>
                      )}
                    {nominating && nomineeId === member.userId && (
                      <SsoRecoveryNomination
                        nominee={{
                          userId: member.userId,
                          name: member.user.name.trim() || t('Unnamed team member'),
                        }}
                        onClose={() => setNomineeId(null)}
                      />
                    )}
                    <MemberReadiness
                      health={
                        readiness.status === 'ready' ? readiness.data.get(member.id) : undefined
                      }
                      status={readiness.status}
                      own={own}
                      canManage={canManage}
                    />
                    {canManage && (
                      <Link
                        to={`${PATHS.eventTypes}?hostUserId=${encodeURIComponent(member.userId)}`}
                      >
                        {t('View hosted team events')}
                      </Link>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}
        <div className="form-actions">
          {offset > 0 && (
            <button
              type="button"
              className="button button-small"
              disabled={state.status === 'loading' || roleReviewOpen || nominating}
              onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
            >
              {t('Previous members page')}
            </button>
          )}
          {state.status === 'ready' && offset + PAGE_SIZE < state.data.total && (
            <button
              type="button"
              className="button button-small"
              disabled={roleReviewOpen || nominating}
              onClick={() => setOffset((value) => value + PAGE_SIZE)}
            >
              {t('Next members page')}
            </button>
          )}
        </div>
        <TeamMemberActions
          key={organizationId}
          organizationId={organizationId}
          currentUserId={currentUserId}
          role={role}
          disabled={roleReviewOpen}
          selectedMember={selectedMember?.organizationId === organizationId ? selectedMember : null}
          onClose={() => {
            setSelectedMember(null)
            setReviewOpen(false)
          }}
          onRemoved={retry}
          onLeft={onLeft}
          onReload={onReload}
          onReviewChange={setReviewOpen}
          removalOpener={removalOpener.current}
        />
      </section>
      {canManage && <TeamInvitations organizationId={organizationId} />}
    </>
  )
}
