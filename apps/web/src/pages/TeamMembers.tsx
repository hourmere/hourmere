import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { type ListedOrganizationMember, listOrganizationMembers } from '../api/auth.ts'
import { errorMessage, RequestError } from '../api/errors.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { MemberReadiness } from '../components/team-members/MemberReadiness.tsx'
import { useMemberReadiness } from '../components/team-members/member-readiness.ts'
import {
  RemoveMemberButton,
  TeamMemberActions,
} from '../components/team-members/TeamMemberActions.tsx'
import {
  RoleManagementNotice,
  TeamMemberRoleButton,
} from '../components/team-members/TeamMemberRole.tsx'
import { useI18n } from '../i18n/runtime.tsx'
import type { MessageKey, UiText } from '../i18n/translate.ts'
import { PATHS } from '../paths.ts'
import { TeamInvitations } from './TeamInvitations.tsx'

const PAGE_SIZE = 20

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
}: {
  organizationId: string
  role: string | null
  currentUserId?: string
  onLeft?: () => void
  onReload?: () => void
}) {
  const { t } = useI18n()
  const [offset, setOffset] = useState(0)
  const [selectedMember, setSelectedMember] = useState<ListedOrganizationMember | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [roleReviewOpen, setRoleReviewOpen] = useState(false)
  const removalOpener = useRef<HTMLButtonElement | null>(null)
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
      <section className="panel" aria-labelledby="team-members-heading">
        <h2 id="team-members-heading">{t('Team members')}</h2>
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
              {state.data.members.map((member) => (
                <li key={member.id}>
                  <span className="user-content">
                    <BreakableText>
                      {member.user.name.trim() || t('Unnamed team member')}
                    </BreakableText>
                  </span>
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
                  <TeamMemberRoleButton
                    key={`${organizationId}:${member.id}:${role}:${currentUserId}`}
                    organizationId={organizationId}
                    member={member}
                    role={role}
                    currentUserId={currentUserId}
                    disabled={reviewOpen || selectedMember !== null || roleReviewOpen}
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
                    disabled={reviewOpen || selectedMember !== null || roleReviewOpen}
                    onSelect={(target, opener) => {
                      removalOpener.current = opener
                      setSelectedMember(target)
                    }}
                  />
                  <MemberReadiness
                    health={
                      readiness.status === 'ready' ? readiness.data.get(member.id) : undefined
                    }
                    status={readiness.status}
                    own={member.userId === currentUserId}
                    canManage={canManage}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="form-actions">
          {offset > 0 && (
            <button
              type="button"
              className="button button-small"
              disabled={state.status === 'loading' || roleReviewOpen}
              onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
            >
              {t('Previous members page')}
            </button>
          )}
          {state.status === 'ready' && offset + PAGE_SIZE < state.data.total && (
            <button
              type="button"
              className="button button-small"
              disabled={roleReviewOpen}
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
