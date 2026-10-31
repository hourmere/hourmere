import { Link } from 'react-router'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { PATHS } from '../../paths.ts'
import type { MemberHealth } from './member-readiness.ts'
import './MemberReadiness.css'

const scheduleLabels: Record<MemberHealth['defaultSchedule'], MessageKey> = {
  satisfied: 'Default schedule set',
  configuration_blocker: 'No default schedule',
  not_applicable: 'Default schedule not checked',
  dependency_unavailable: 'Default schedule needs attention',
  not_checked: 'Default schedule not checked',
  check_failed: 'Default schedule check failed',
}
const calendarLabels: Record<MemberHealth['selectedCalendars'], MessageKey> = {
  satisfied: 'Selected calendar checks passed',
  not_applicable: 'No external conflict calendar required for basic bookings',
  configuration_blocker: 'Selected calendars need attention',
  dependency_unavailable: 'Selected calendars need attention',
  not_checked: 'Selected calendars not checked',
  check_failed: 'Selected calendar check failed',
}
const conferenceLabels: Record<MemberHealth['conferenceAccounts'], MessageKey> = {
  connected: 'Conference account connected',
  not_connected: 'No conference account connected; basic bookings do not require one',
  attention_required: 'Conference accounts need attention',
  check_failed: 'Conference account check failed',
}

export function MemberReadiness({
  health,
  own,
  canManage,
  status,
}: {
  health: MemberHealth | undefined
  own: boolean
  canManage: boolean
  status: 'loading' | 'error' | 'unavailable' | 'ready'
}) {
  const { t } = useI18n()
  return (
    <section className="member-readiness" aria-label={t('Member readiness')}>
      {status === 'ready' &&
        (health && (own || canManage) ? (
          <ul className="member-readiness-health">
            <li>{t(scheduleLabels[health.defaultSchedule] ?? 'Default schedule not checked')}</li>
            <li>
              {t(calendarLabels[health.selectedCalendars] ?? 'Selected calendars not checked')}
            </li>
            <li>
              {t(conferenceLabels[health.conferenceAccounts] ?? 'Conference accounts not checked')}
            </li>
          </ul>
        ) : (
          <p className="hint">
            {t(
              !own && !canManage
                ? 'Only team owners and admins can view other members’ readiness.'
                : 'Configuration not checked',
            )}
          </p>
        ))}
      {own && (
        <>
          <p className="hint">
            {t('Your default schedule is reused in every team you belong to.')}
          </p>
          <div className="member-readiness-links">
            <Link to={PATHS.availability}>{t('Configure default schedule')}</Link>
            <Link to={PATHS.calendars}>{t('Configure calendars')}</Link>
            <Link to={PATHS.conferences}>{t('Review conference accounts')}</Link>
          </div>
        </>
      )}
    </section>
  )
}
