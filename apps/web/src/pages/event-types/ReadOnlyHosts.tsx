import { useCallback } from 'react'
import { getActiveOrganizationMember } from '../../api/auth.ts'
import { MemberReadiness } from '../../components/team-members/MemberReadiness.tsx'
import { useMemberReadiness } from '../../components/team-members/member-readiness.ts'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { Me } from '../../session.tsx'
import type { EventTypeDraft } from './event-type-form.ts'

/** A member can review their own setup without opening the assignment directory. */
export function ReadOnlyHosts({
  draft,
  me,
  role,
  onReload,
}: {
  draft: EventTypeDraft
  me: Me
  role: string | null
  onReload: () => void
}) {
  const { t } = useI18n()
  const own = draft.hostUserIds.includes(me.user.id)
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!own || !role) return null
      const member = await getActiveOrganizationMember(signal)
      if (member.organizationId !== me.organization.id || member.userId !== me.user.id)
        throw new Error('Membership context changed')
      return member
    },
    [own, role, me.organization.id, me.user.id],
  )
  const [member, retryMember] = useLoad(load)
  const [readiness, retryReadiness] = useMemberReadiness(
    me.organization.id,
    me.user.id,
    role,
    member.status === 'ready' && member.data ? [member.data] : [],
  )
  return (
    <section className="panel" aria-labelledby="hosts-heading">
      <h2 id="hosts-heading">{t('Hosts')}</h2>
      <p>{t('Only team owners and admins can change host assignments.')}</p>
      <p>
        {t(
          draft.schedulingType === 'individual'
            ? 'Individual: one host'
            : draft.schedulingType === 'collective'
              ? 'Collective: every selected host is required'
              : 'Round robin: one available host',
        )}
      </p>
      {own && (
        <>
          <p>{t('You are a selected host.')}</p>
          {role &&
            (member.status === 'loading' ||
              (member.status === 'ready' && readiness.status === 'loading')) && (
              <p role="status">{t('Checking member configuration…')}</p>
            )}
          {(member.status === 'error' || readiness.status === 'error') && (
            <div role="alert">
              <p>{t('Could not check member configuration.')}</p>
              <button
                type="button"
                onClick={member.status === 'error' ? retryMember : retryReadiness}
              >
                {t('Retry checks')}
              </button>
            </div>
          )}
          {readiness.status === 'unavailable' && (
            <div role="alert">
              <p>
                {t(
                  'Your permission or team membership changed. Reload to check before trying again.',
                )}
              </p>
              <button type="button" onClick={onReload}>
                {t('Reload team')}
              </button>
            </div>
          )}
          {!role && <p className="hint">{t('Configuration not checked')}</p>}
          <MemberReadiness
            health={
              readiness.status === 'ready' && member.status === 'ready' && member.data
                ? readiness.data.get(member.data.id)
                : undefined
            }
            status={readiness.status}
            own
            canManage={false}
          />
        </>
      )}
    </section>
  )
}
