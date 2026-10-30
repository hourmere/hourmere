import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { listOrganizationMembers } from '../api/auth.ts'
import { api, type Schemas, unwrap } from '../api/client.ts'
import { errorMessage, RequestError } from '../api/errors.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { browserTimeZone, zoned } from '../format.ts'
import { useI18n } from '../i18n/runtime.tsx'
import type { MessageKey, UiText } from '../i18n/translate.ts'
import { PATHS } from '../paths.ts'

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
  return [state, retry] as const
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
}: {
  organizationId: string
  role: string | null
}) {
  const { t } = useI18n()
  const [offset, setOffset] = useState(0)
  const load = useCallback(
    (signal: AbortSignal) => listOrganizationMembers(organizationId, offset, PAGE_SIZE, signal),
    [organizationId, offset],
  )
  const [state, retry] = useTeamPage(load)
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
              disabled={state.status === 'loading'}
              onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
            >
              {t('Previous members page')}
            </button>
          )}
          {state.status === 'ready' && offset + PAGE_SIZE < state.data.total && (
            <button
              type="button"
              className="button button-small"
              onClick={() => setOffset((value) => value + PAGE_SIZE)}
            >
              {t('Next members page')}
            </button>
          )}
        </div>
      </section>
      {canManage && <PendingInvitations organizationId={organizationId} />}
    </>
  )
}

const deliveryLabels: Record<Schemas['TeamInvitationSummary']['delivery']['state'], MessageKey> = {
  queued: 'Submitted',
  sending: 'Submitting to the mail server',
  smtp_accepted: 'Accepted by the mail server',
  failed: 'Submission failed',
  skipped: 'Submission skipped',
  unknown: 'Submission status unknown',
}

function PendingInvitations({ organizationId }: { organizationId: string }) {
  const { t, locale } = useI18n()
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const cursor = cursors[cursors.length - 1]
  const load = useCallback(
    (signal: AbortSignal) =>
      unwrap(
        api.GET('/api/v1/team/invitations', {
          headers: { 'X-Expected-Organization-Id': organizationId },
          params: { query: { limit: PAGE_SIZE, ...(cursor && { cursor }) } },
          signal,
        }),
      ),
    [cursor, organizationId],
  )
  const [state, retry] = useTeamPage(load)
  const invitations =
    state.status === 'ready' ? state.data.data.filter((item) => item.status === 'pending') : []
  const fmt = zoned(browserTimeZone(), locale)
  return (
    <section className="panel" aria-labelledby="pending-invitations-heading">
      <h2 id="pending-invitations-heading">{t('Pending invitations')}</h2>
      <p className="hint">{t('Mail server acceptance does not confirm receipt in the inbox.')}</p>
      <PageFeedback
        state={state}
        retry={retry}
        loading="Loading pending invitations…"
        failed="Could not load pending invitations."
        denied="You do not have permission to view pending invitations."
      />
      {state.status === 'ready' && (
        <>
          {invitations.length === 0 && <p>{t('No pending invitations on this page.')}</p>}
          <ul className="stack">
            {invitations.map((invitation, index) => (
              <li key={invitation.id}>
                <h3>{t('Invitation {0}', { '0': index + 1 })}</h3>
                <dl className="details">
                  <dt>{t('Status')}</dt>
                  <dd>{t('Pending')}</dd>
                  <dt>{t('Mail submission')}</dt>
                  <dd>{t(deliveryLabels[invitation.delivery.state])}</dd>
                  <dt>{t('Expires')}</dt>
                  <dd>
                    <time dateTime={invitation.expiresAt}>
                      {fmt.dateTime(invitation.expiresAt)}
                    </time>
                  </dd>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="form-actions">
        {cursors.length > 1 && (
          <button
            type="button"
            className="button button-small"
            disabled={state.status === 'loading'}
            onClick={() => setCursors((value) => value.slice(0, -1))}
          >
            {t('Previous invitations page')}
          </button>
        )}
        {state.status === 'ready' && state.data.nextCursor && (
          <button
            type="button"
            className="button button-small"
            onClick={() => setCursors((value) => [...value, state.data.nextCursor ?? undefined])}
          >
            {t('Next invitations page')}
          </button>
        )}
      </div>
    </section>
  )
}
