import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api, unwrap } from '../../api/client.ts'
import { MemberReadiness } from '../../components/team-members/MemberReadiness.tsx'
import {
  type MemberHealth,
  useMemberReadiness,
} from '../../components/team-members/member-readiness.ts'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { UiText } from '../../i18n/translate.ts'
import { PATHS } from '../../paths.ts'
import { type EventTypeDraft, hasAutomaticLocation } from './event-type-form.ts'

interface Props {
  organizationId: string
  currentUserId: string
  role: string | null
  effectiveReadiness?: boolean | undefined
  canListCandidates?: boolean
  canAssign?: boolean
  knownHosts?: { id: string; name: string }[] | undefined
  draft: EventTypeDraft
  error?: UiText | undefined
  organizerError?: UiText | undefined
  set: <K extends keyof EventTypeDraft>(name: K, value: EventTypeDraft[K]) => void
  onTeamsReadiness?: (observation: TeamsHostReadiness) => void
}

export type TeamsHostReadiness = {
  userId: string
  status: NonNullable<MemberHealth['microsoftTeams']> | 'checking'
}

interface Host {
  id: string
  memberId: string
  name: string
}

/** A paged directory, never another person's private schedules or email address. */
export function HostAssignment({
  organizationId,
  currentUserId,
  role,
  effectiveReadiness,
  canListCandidates = true,
  canAssign = true,
  knownHosts,
  draft,
  error,
  organizerError,
  set,
  onTeamsReadiness,
}: Props) {
  const { t, ui } = useI18n()
  const [after, setAfter] = useState<string | undefined>()
  const [previous, setPrevious] = useState<Host[]>([])
  const load = useCallback(
    async (signal: AbortSignal) =>
      canListCandidates
        ? unwrap(
            api.GET('/api/v1/event-type-hosts', {
              params: { query: { limit: 100, ...(after && { after }) } },
              signal,
            }),
          )
        : { data: [], nextAfter: null },
    [after, canListCandidates],
  )
  const [state, reload] = useLoad(load)
  const members = canListCandidates
    ? state.status === 'ready'
      ? [...previous, ...state.data.data]
      : previous
    : (knownHosts ?? []).map((host) => ({ ...host, memberId: '' }))
  const missing = canListCandidates
    ? draft.hostUserIds.filter((id) => !members.some((member) => member.id === id))
    : []
  const roles = role?.split(',').map((value) => value.trim()) ?? []
  const canReadTeam =
    effectiveReadiness ??
    (roles.every((value) => ['owner', 'admin', 'member'].includes(value)) &&
      (roles.includes('owner') || roles.includes('admin')))
  const selected = canReadTeam
    ? members.filter((member) => member.memberId && draft.hostUserIds.includes(member.id))
    : []
  const [readiness, retryReadiness] = useMemberReadiness(
    organizationId,
    currentUserId,
    role,
    selected.map((member) => ({ id: member.memberId })),
    effectiveReadiness,
  )
  const soloHostId = draft.schedulingType === 'individual' ? draft.hostUserIds[0] : undefined
  const soloMember = selected.find((member) => member.id === soloHostId)
  const teamsStatus =
    readiness.status === 'ready' && soloMember
      ? (readiness.data.get(soloMember.memberId)?.microsoftTeams ?? 'check_failed')
      : state.status === 'loading' || (soloMember && readiness.status === 'loading')
        ? 'checking'
        : 'check_failed'
  useEffect(() => {
    if (soloHostId) onTeamsReadiness?.({ userId: soloHostId, status: teamsStatus })
  }, [soloHostId, teamsStatus, onTeamsReadiness])
  return (
    <section className="panel" aria-labelledby="hosts-heading">
      <h2 id="hosts-heading">{t('Hosts')}</h2>
      <label htmlFor="schedulingType">{t('Scheduling')}</label>
      <select
        id="schedulingType"
        disabled={!canAssign}
        value={draft.schedulingType}
        onChange={(event) => {
          const mode = event.target.value as EventTypeDraft['schedulingType']
          set('schedulingType', mode)
          set('conferenceOrganizerUserId', '')
          set('scheduleId', '')
          if (mode === 'individual') set('hostUserIds', draft.hostUserIds.slice(0, 1))
        }}
      >
        <option value="individual">{t('Individual: one host')}</option>
        <option value="collective">{t('Collective: every selected host is required')}</option>
        <option value="round_robin">{t('Round robin: one available host')}</option>
      </select>
      <p id="hosts-hint">
        {t(
          'Choose one individual host, two to eight collective hosts, or one to eight round-robin pool members. Changes affect new bookings; existing meetings retain their original hosts.',
        )}
      </p>
      {error && (
        <p className="field-error" role="alert">
          {ui(error)}
        </p>
      )}
      {canListCandidates && state.status === 'loading' && (
        <p role="status">{t('Loading team members…')}</p>
      )}
      {canListCandidates && state.status === 'error' && (
        <div role="alert">
          <p>
            {t(
              effectiveReadiness === undefined
                ? 'Could not load team members. Only team owners and admins can assign hosts.'
                : 'Could not load team members.',
            )}{' '}
            {ui(state.message)}
          </p>
          <button
            type="button"
            onClick={() => {
              setPrevious([])
              setAfter(undefined)
              reload()
            }}
          >
            {t('Try again')}
          </button>
        </div>
      )}
      {selected.length > 0 && (
        <>
          <p className="hint">
            {t(
              'Configuration checks do not guarantee available times. Check the booking page for current availability.',
            )}{' '}
            {t('An external calendar is optional for basic bookings.')}
          </p>
          {readiness.status === 'loading' && (
            <p role="status">{t('Checking member configuration…')}</p>
          )}
          {readiness.status === 'error' && (
            <div role="alert">
              <p>{t('Could not check member configuration.')}</p>
              <button type="button" onClick={retryReadiness}>
                {t('Retry checks')}
              </button>
            </div>
          )}
          {readiness.status === 'unavailable' && (
            <p role="alert">
              {t(
                'Your permission or team membership changed. Reload to check before trying again.',
              )}
            </p>
          )}
        </>
      )}
      <fieldset
        id="hosts"
        aria-describedby="hosts-hint"
        aria-invalid={!!error}
        disabled={!canAssign}
      >
        <legend>
          {t(draft.schedulingType === 'round_robin' ? 'Host pool' : 'Required hosts')}
        </legend>
        {members.map((member) => (
          <div key={member.id}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.hostUserIds.includes(member.id)}
                onChange={(event) => {
                  set('scheduleId', '')
                  set(
                    'hostUserIds',
                    event.target.checked
                      ? draft.schedulingType === 'individual'
                        ? [member.id]
                        : [...draft.hostUserIds, member.id]
                      : draft.hostUserIds.filter((id) => id !== member.id),
                  )
                }}
              />
              <bdi>{member.name.trim() || t('Unnamed team member')}</bdi>
            </label>
            {canReadTeam && canListCandidates && draft.hostUserIds.includes(member.id) && (
              <>
                <MemberReadiness
                  health={
                    readiness.status === 'ready' ? readiness.data.get(member.memberId) : undefined
                  }
                  status={readiness.status}
                  own={member.id === currentUserId}
                  canManage={canReadTeam}
                />
                {member.id !== currentUserId && (
                  <p className="hint">
                    {t(
                      'Ask this member to review their personal working hours and calendars. Only they can change their private schedule.',
                    )}{' '}
                    <Link to={`${PATHS.settings}#team-members`}>{t('Review member setup')}</Link>
                  </p>
                )}
              </>
            )}
          </div>
        ))}
        {missing.length > 0 && (
          <>
            <p>
              {t(
                'Some selected hosts are not on the loaded member pages. Load the next page to find them; a host who has left the team must be replaced before saving a host change.',
              )}
            </p>
            {missing.map((id, index) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  set('scheduleId', '')
                  set(
                    'hostUserIds',
                    draft.hostUserIds.filter((value) => value !== id),
                  )
                }}
              >
                {t('Remove selected host {0}', { '0': index + 1 })}
              </button>
            ))}
          </>
        )}
      </fieldset>
      {hasAutomaticLocation(draft, 'google_meet') && draft.schedulingType === 'collective' && (
        <div>
          <label htmlFor="conferenceOrganizer">{t('Meeting organizer')}</label>
          <select
            id="conferenceOrganizer"
            disabled={!canAssign}
            value={draft.conferenceOrganizerUserId}
            aria-invalid={!!organizerError}
            onChange={(e) => set('conferenceOrganizerUserId', e.target.value)}
          >
            <option value="">{t('Choose an organizer')}</option>
            {members
              .filter((m) => draft.hostUserIds.includes(m.id))
              .map((m) => (
                <option key={m.id} value={m.id} dir={m.name.trim() ? 'auto' : undefined}>
                  {m.name.trim() || t('Unnamed team member')}
                </option>
              ))}
            {draft.conferenceOrganizerUserId &&
              !members.some((m) => m.id === draft.conferenceOrganizerUserId) && (
                <option value={draft.conferenceOrganizerUserId}>
                  {t('Selected organizer: load the member pages to check')}
                </option>
              )}
          </select>
          {organizerError && (
            <p role="alert" className="field-error">
              {ui(organizerError)}
            </p>
          )}
          <p className="hint">
            {t(
              'Choose one required host to create the Meet link. Existing bookings keep their organizer, invitation identity and original calendars.',
            )}
          </p>
        </div>
      )}
      {draft.locationKind === 'zoom' && draft.schedulingType !== 'individual' && (
        <p className="hint">
          {t('Automatic Zoom supports individual meetings with exactly one host.')}
        </p>
      )}
      {hasAutomaticLocation(draft, 'google_meet') && draft.schedulingType === 'round_robin' && (
        <p>
          {t(
            'The assigned available host creates the Meet link. Only pool members with an eligible Google calendar can receive new bookings.',
          )}
        </p>
      )}
      {canListCandidates && state.status === 'ready' && state.data.nextAfter && (
        <button
          type="button"
          onClick={() => {
            setPrevious(members)
            setAfter(state.data.nextAfter as string)
          }}
        >
          {t('Load more members')}
        </button>
      )}
    </section>
  )
}
