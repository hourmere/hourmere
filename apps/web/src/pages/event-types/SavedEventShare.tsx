import { isPublicTeamSlug, isReservedName } from '@hourmere/core/reserved'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import type { EventType, Profile, Schedule } from '../../api/resources.ts'
import { CopyButton } from '../../components/CopyButton.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import { PROFILE } from '../../limits.ts'
import {
  PATHS,
  publicPageUrl,
  publicTeamPageUrl,
  schedulePath,
  TEAM_LINK_SLUG_HINT,
} from '../../paths.ts'
import type { Me } from '../../session.tsx'
import { useTeamManagementAccess } from '../../team-management.tsx'
import { validSchedule } from '../availability/valid-default.ts'
import type { EditorReadiness } from './editor-readiness.ts'
import { teamReadinessBlocksSharing } from './event-readiness.ts'

/** Sharing always describes a saved server response, independently of the editable draft. */
export function SavedEventShare({
  event,
  me,
  profile,
  schedules,
  readiness,
  retryReadiness,
  disabled = false,
  focusVersion = 0,
}: {
  event: EventType
  me: Me
  profile: Profile | null
  schedules: Schedule[]
  readiness: EditorReadiness
  retryReadiness: () => void
  disabled?: boolean
  focusVersion?: number
}) {
  const { t } = useI18n()
  const access = useTeamManagementAccess()
  const canRetryUnavailable =
    me.principal.kind === 'session' && access.status === 'ready' && access.role !== null
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (focusVersion > 0) heading.current?.focus()
  }, [focusVersion])

  const personal = event.ownerUserId === me.user.id
  const team = event.ownerUserId === null && !me.organization.personal
  const handle = profile?.handle.toLowerCase() ?? ''
  const missingHandle = personal && (!PROFILE.handlePattern.test(handle) || isReservedName(handle))
  const effectiveSchedule = schedules.find((schedule) =>
    event.scheduleId ? schedule.id === event.scheduleId : schedule.isDefault,
  )
  const missingAvailability = personal && (!effectiveSchedule || !validSchedule(effectiveSchedule))
  const invalidTeamSlug = team && !isPublicTeamSlug(me.organization.slug)
  const invalidHosts =
    team &&
    !(
      (event.schedulingType === 'individual' && event.hosts.length === 1) ||
      (event.schedulingType === 'collective' &&
        event.hosts.length >= 2 &&
        event.hosts.length <= 8) ||
      (event.schedulingType === 'round_robin' && event.hosts.length >= 1 && event.hosts.length <= 8)
    )
  const item = readiness.status === 'ready' ? readiness.item : undefined
  const inactive = !event.isActive || item?.enablement === 'disabled'
  const needsActivation =
    event.schedulingType === 'round_robin' &&
    (!event.roundRobinActive || item?.activation === 'inactive')
  const reasons = item
    ? 'signals' in item
      ? item.signals.map((signal) => signal.reasonCode)
      : item.reasonCodes
    : []
  const checksBlocked = team && teamReadinessBlocksSharing(item)
  const hostAvailabilityMissing =
    item && item.summary !== 'partial_pool' && reasons.includes('default_schedule_required')
  const hostConfigurationMissing =
    item && item.summary !== 'partial_pool' && reasons.includes('host_configuration_required')
  const checksMissing =
    team &&
    (item?.completeness !== 'complete' ||
      item.summary === 'not_checked' ||
      item.summary === 'check_failed' ||
      reasons.some((reason) => reason === 'check_failed' || reason === 'check_not_performed'))
  // The service can prioritize enablement/activation over otherwise complete checks.
  const configurationNeedsReview =
    checksBlocked &&
    item &&
    (!['disabled', 'needs_activation'].includes(item.summary) ||
      reasons.some((reason) => reason !== 'activation_required'))
  const checksRetryable =
    item?.completeness !== 'complete' ||
    item.summary === 'check_failed' ||
    item.summary === 'not_checked' ||
    reasons.some((reason) => reason === 'check_failed' || reason === 'check_not_performed')
  const shareable =
    !disabled &&
    (personal || team) &&
    !missingHandle &&
    !missingAvailability &&
    !invalidTeamSlug &&
    !invalidHosts &&
    !hostAvailabilityMissing &&
    !hostConfigurationMissing &&
    !checksBlocked &&
    !inactive &&
    !event.isHidden &&
    !needsActivation
  const url = shareable
    ? personal && profile
      ? publicPageUrl(profile.handle, event.slug)
      : publicTeamPageUrl(me.organization.slug, event.slug)
    : null

  return (
    <section className="panel" aria-labelledby="view-and-share">
      <h2 id="view-and-share" ref={heading} tabIndex={-1}>
        {t('View and share')}
      </h2>
      {!disabled && checksMissing && (
        <p>
          {t(
            readiness.status === 'loading'
              ? 'Checking configuration…'
              : readiness.status === 'unavailable'
                ? 'Readiness checks are unavailable for this account.'
                : readiness.status === 'error' ||
                    item?.summary === 'check_failed' ||
                    reasons.includes('check_failed')
                  ? 'Configuration check failed'
                  : 'Configuration not checked',
          )}{' '}
          <a href="#saved-readiness-heading">{t('Review saved version readiness')}</a>
          {checksRetryable &&
            readiness.status !== 'loading' &&
            (readiness.status !== 'unavailable' || canRetryUnavailable) && (
              <button type="button" className="button button-small" onClick={retryReadiness}>
                {t('Retry checks')}
              </button>
            )}
        </p>
      )}
      {disabled ? (
        <p>{t('Your team context changed. Reload before making changes.')}</p>
      ) : url ? (
        <>
          <p>{t('This booking link uses the saved version. Unsaved changes are not included.')}</p>
          <p>
            {t('Open your booking page to check the available times, then copy its link to share.')}
          </p>
          <p className="mono user-content">{url}</p>
          <div className="form-actions">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="button button-primary"
            >
              {t('View booking page')}
              <span className="visually-hidden"> {t('(opens in a new tab)')}</span>
            </a>
            <CopyButton text={url} label={t('Copy booking link')} />
          </div>
        </>
      ) : (
        <ul>
          {inactive && (
            <li>
              {t('This event type is inactive. Enable it and save before sharing.')}{' '}
              <a href="#event-enablement">{t('Review enablement')}</a>
            </li>
          )}
          {event.isHidden && (
            <li>
              {t(
                team
                  ? 'Unlisted is not access control. Once this event type is bookable, anyone who knows or guesses its direct link can book it.'
                  : 'This event type is unlisted. Anyone with its direct link can still book it. Review visibility before sharing.',
              )}{' '}
              <a href="#event-visibility">{t('Review visibility')}</a>
            </li>
          )}
          {needsActivation && (
            <li>
              {t(
                'This round-robin event type is saved, but it is not activated. Activate it separately before sharing.',
              )}{' '}
              <a href="#round-robin-heading">{t('Review round-robin activation')}</a>
            </li>
          )}
          {missingHandle && (
            <li>
              {t('Set a booking username in Settings before sharing this event type.')}{' '}
              <Link to={PATHS.settings}>{t('Complete your profile')}</Link>
            </li>
          )}
          {missingAvailability && (
            <li>
              {t(
                event.scheduleId
                  ? 'Host availability needs attention before you share this event type.'
                  : 'Choose a default schedule with valid weekly hours. Other schedules do not complete this step.',
              )}{' '}
              <Link
                to={
                  event.scheduleId && effectiveSchedule
                    ? schedulePath(event.scheduleId)
                    : schedules.length === 0
                      ? PATHS.newSchedule
                      : PATHS.availability
                }
              >
                {t(event.scheduleId ? 'Review schedule' : 'Review default availability')}
              </Link>
            </li>
          )}
          {hostAvailabilityMissing && !missingAvailability && (
            <li>
              {t('Host availability needs attention before you share this event type.')}{' '}
              {personal ? (
                <Link to={PATHS.availability}>{t('Set working hours')}</Link>
              ) : (
                <a href="#hosts-heading">{t('Review hosts')}</a>
              )}
            </li>
          )}
          {hostConfigurationMissing && !missingHandle && (
            <li>
              {t('Host settings need attention.')}{' '}
              {personal ? (
                <Link to={PATHS.settings}>{t('Review profile')}</Link>
              ) : (
                <a href="#hosts-heading">{t('Review hosts')}</a>
              )}
            </li>
          )}
          {configurationNeedsReview && !hostAvailabilityMissing && !hostConfigurationMissing && (
            <li>
              {t('Configuration needs attention')}{' '}
              <a href="#saved-readiness-heading">{t('Review saved version readiness')}</a>
            </li>
          )}
          {invalidTeamSlug && (
            <li>
              {t(TEAM_LINK_SLUG_HINT)} <Link to={PATHS.settings}>{t('Settings')}</Link>
            </li>
          )}
          {invalidHosts && (
            <li>
              {t('Host settings need attention.')} <a href="#hosts-heading">{t('Review hosts')}</a>
            </li>
          )}
          {!personal && !team && (
            <li>
              {t('This event type has no public booking link in the current space.')}{' '}
              <Link to={PATHS.eventTypes}>{t('Back to event types')}</Link>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}
