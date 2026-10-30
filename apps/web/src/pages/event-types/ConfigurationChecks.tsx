import { Link } from 'react-router'
import type { EventType } from '../../api/resources.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { eventTypePath, PATHS, schedulePath } from '../../paths.ts'
import type { EventReadiness, SelfEventReadiness } from './event-readiness.ts'

type Fix = NonNullable<SelfEventReadiness['signals'][number]['fixKind']> | 'edit_event'
type Issue = { label: MessageKey; fix: Fix | null }
const reasons: Record<string, MessageKey> = {
  default_schedule_required: 'Working hours are missing.',
  host_configuration_required: 'Host settings need attention.',
  host_pool_degraded: 'Some hosts need attention',
  calendar_attention_required: 'Calendar sync needs attention',
  sync_not_ready: 'Selected calendars are waiting for a successful sync.',
  optional_feature_attention_required: 'Automatic meeting settings need attention.',
  unsupported_conflict_provider: 'Selected calendars cannot provide conflict checks.',
}

/** Enablement and activation are separate axes; the main summary can mask these checks. */
function configuration(item: EventReadiness | undefined) {
  const issues: Issue[] = []
  const fixes = new Set<Fix>()
  let unknown = item?.completeness !== 'complete' || item?.summary === 'not_checked'
  let failed = item?.summary === 'check_failed'
  if (item && 'signals' in item) {
    const signals = item.signals.filter(
      (signal) =>
        signal.id !== 'slot_observation' &&
        signal.id !== 'event_enablement' &&
        signal.reasonCode !== 'activation_required',
    )
    unknown ||= signals.length === 0
    for (const signal of signals) {
      if (signal.fixKind) fixes.add(signal.fixKind)
      unknown ||= signal.state === 'not_checked' || signal.state === 'check_failed'
      failed ||= signal.state === 'check_failed'
      if (
        signal.state === 'configuration_blocker' ||
        signal.state === 'dependency_unavailable' ||
        signal.reasonCode === 'host_pool_degraded' ||
        signal.reasonCode === 'unsupported_conflict_provider'
      )
        issues.push({
          label: reasons[signal.reasonCode ?? ''] ?? 'Configuration needs attention',
          fix: signal.fixKind,
        })
    }
  } else if (item) {
    unknown ||= item.summary === 'not_checked' || item.reasonCodes.includes('check_not_performed')
    failed ||= item.reasonCodes.includes('check_failed')
    for (const reason of item.reasonCodes) {
      if (
        reason === 'activation_required' ||
        reason === 'check_failed' ||
        reason === 'check_not_performed'
      )
        continue
      issues.push({ label: reasons[reason] ?? 'Configuration needs attention', fix: null })
    }
  }
  const partial = item?.summary === 'partial_pool'
  unknown ||=
    !issues.length &&
    (item?.summary === 'configuration_blocked' || item?.summary === 'dependency_unavailable')
  const label: MessageKey = failed
    ? 'Configuration check failed'
    : unknown
      ? 'Configuration not checked'
      : partial
        ? 'Some hosts need attention'
        : issues.length
          ? issues.every(
              (issue) =>
                issue.label === 'Calendar sync needs attention' ||
                issue.label === 'Selected calendars are waiting for a successful sync.',
            )
            ? 'Calendar sync needs attention'
            : 'Configuration needs attention'
          : 'Configuration checks passed'
  return {
    issues,
    fixes,
    unknown: unknown || failed,
    label,
    passed: !unknown && !failed && !partial && !issues.length,
  }
}

export function ConfigurationChecks({
  event,
  item,
  status,
  retry,
}: {
  event: EventType
  item: EventReadiness | undefined
  status: 'loading' | 'error' | 'ready'
  retry: () => void
}) {
  const { t } = useI18n()
  if (status !== 'ready')
    return (
      <div className="table-value event-checks">
        <span className="badge" role="status">
          {t(status === 'loading' ? 'Checking configuration…' : 'Configuration check failed')}
        </span>
        <button type="button" className="button button-small" onClick={retry}>
          {t('Retry checks')}
        </button>
      </div>
    )
  const result = configuration(item)
  const teamFixes = item && 'fixKinds' in item ? item.fixKinds : []
  const activationOnlyEdit =
    item &&
    'reasonCodes' in item &&
    item.activation === 'inactive' &&
    item.reasonCodes.every((reason) =>
      [
        'activation_required',
        'default_schedule_required',
        'calendar_attention_required',
        'check_not_performed',
        'check_failed',
      ].includes(reason),
    )
  const fixes = new Set<Fix>([
    ...result.fixes,
    ...teamFixes.filter(
      (fix) => fix !== 'retry_summary' && !(fix === 'edit_event' && activationOnlyEdit),
    ),
  ])
  const entries: Record<
    Exclude<Fix, 'retry_summary' | 'ask_member'>,
    { path: string; label: MessageKey }
  > = {
    event_editor: { path: eventTypePath(event.id), label: 'Review event settings' },
    edit_event: { path: eventTypePath(event.id), label: 'Review event settings' },
    self_availability: { path: PATHS.availability, label: 'Set working hours' },
    self_schedule: {
      path: event.scheduleId ? schedulePath(event.scheduleId) : PATHS.availability,
      label: 'Review schedule',
    },
    self_calendars: { path: PATHS.calendars, label: 'Review calendar sync' },
    self_identity: { path: PATHS.signIn, label: 'Sign in to verify your identity' },
    self_profile: { path: PATHS.settings, label: 'Review profile' },
    self_conferences: { path: PATHS.conferences, label: 'Review conference accounts' },
  }
  return (
    <div className="table-value event-checks">
      <span className={`badge${result.passed ? ' badge-success' : ''}`}>{t(result.label)}</span>
      {result.issues.length > 0 && (
        <ul className="event-check-issues">
          {[...new Set(result.issues.map((issue) => issue.label))].map((label) => (
            <li key={label}>{t(label)}</li>
          ))}
        </ul>
      )}
      {fixes.has('ask_member') && (
        <>
          <span>{t('Ask the hosts to review their personal working hours and calendars.')}</span>
          <Link to={`${eventTypePath(event.id)}#hosts`}>{t('Review hosts')}</Link>
        </>
      )}
      {[...fixes].map((fix) => {
        if (fix === 'retry_summary' || fix === 'ask_member') return null
        if (!Object.hasOwn(entries, fix)) return null
        const entry = entries[fix]
        return (
          <Link key={fix} to={entry.path}>
            {t(entry.label)}
          </Link>
        )
      })}
      {(result.unknown || teamFixes.includes('retry_summary')) && (
        <button type="button" className="button button-small" onClick={retry}>
          {t('Retry checks')}
        </button>
      )}
    </div>
  )
}
