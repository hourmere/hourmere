import { useCallback, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { api, type Schemas, unwrap } from '../api/client.ts'
import { RequestError } from '../api/errors.ts'
import { EmptyState } from '../components/EmptyState.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageSkeleton } from '../components/PageSkeleton.tsx'
import { useLoad, usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import type { MessageKey } from '../i18n/translate.ts'
import { PATHS } from '../paths.ts'
import { useMe } from '../session.tsx'
import { useTeamManagementAccess } from '../team-management.tsx'
import { useTeamPagePermissions } from '../team-page-permissions.ts'

type Run = Schemas['WorkflowRunHistoryEntry']

const triggers = {
  'booking.created': 'Booking created',
  'booking.cancelled': 'Booking canceled',
  'booking.rescheduled': 'Booking rescheduled',
  before_start: 'Before booking starts',
  after_end: 'After booking ends',
} as const satisfies Record<Run['trigger'], MessageKey>

const outcomes = {
  completed: 'Completed',
  retired: 'Retired',
  skipped: 'Skipped',
} as const satisfies Record<Run['outcome'], MessageKey>

const reasons = {
  condition_false: 'Workflow conditions did not match',
  existing_notification: 'An existing notification takes precedence',
  minimum_gap: 'Too little time before the scheduled run',
  offset_not_future: 'Scheduled time had already passed',
  expired: 'Run expired',
  budget_suppressed: 'Mail budget limit reached',
  render_limit: 'Email exceeded the size limit',
  workflow_disabled: 'Workflow was disabled',
  instance_disabled: 'Workflows were disabled on this instance',
} as const satisfies Record<NonNullable<Run['reason']>, MessageKey>

export default function WorkflowRunHistoryPage() {
  const { t } = useI18n()
  const me = useMe()
  const access = useTeamManagementAccess()
  const permissions = useTeamPagePermissions()
  const { id } = useParams()
  const { id: organizationId, personal } = me.organization
  const inSession = me.principal.kind === 'session'
  const canRead =
    permissions.status === 'ready'
      ? permissions.allows('workflows.read_runs')
      : inSession && (personal || (access.status === 'ready' && access.role !== null))
  const heading = useRef<HTMLHeadingElement>(null)
  usePageTitle('Run history')

  return (
    <>
      {canRead && (
        <p className="breadcrumb">
          <Link to={PATHS.workflows}>{t('Workflows')}</Link>
        </p>
      )}
      <PageHeader title={t('Run history')} headingRef={heading} />
      {canRead && id ? (
        <History
          key={JSON.stringify([me.user.id, organizationId, personal, id])}
          id={id}
          focusHeading={() => heading.current?.focus()}
        />
      ) : permissions.status === 'fixed' && inSession && access.status === 'loading' ? (
        <PageSkeleton label="Loading run history…" />
      ) : permissions.status === 'fixed' && inSession && access.status === 'error' ? (
        <LoadError retry={access.reload} />
      ) : (
        <Unavailable />
      )}
    </>
  )
}

function Unavailable() {
  const { t } = useI18n()
  return (
    <p className="alert alert-error" role="alert">
      {t('Run history is unavailable in this space.')}
    </p>
  )
}

function LoadError({ retry }: { retry: () => void }) {
  const { t } = useI18n()
  return (
    <div className="alert alert-error" role="alert">
      <p>{t('Could not load run history.')}</p>
      <button className="button button-small" type="button" onClick={retry}>
        {t('Try again')}
      </button>
    </div>
  )
}

function History({ id, focusHeading }: { id: string; focusHeading: () => void }) {
  const [cursors, setCursors] = useState<string[]>([])
  const [attempt, setAttempt] = useState(0)
  const cursor = cursors.at(-1)

  return (
    <HistoryPage
      key={JSON.stringify([cursor, attempt])}
      id={id}
      cursor={cursor}
      previous={
        cursors.length
          ? () => {
              setCursors(cursors.slice(0, -1))
              focusHeading()
            }
          : undefined
      }
      next={(nextCursor) => {
        setCursors([...cursors, nextCursor])
        focusHeading()
      }}
      retry={() => {
        setAttempt((value) => value + 1)
        focusHeading()
      }}
    />
  )
}

function HistoryPage({
  id,
  cursor,
  previous,
  next,
  retry,
}: {
  id: string
  cursor: string | undefined
  previous: (() => void) | undefined
  next: (cursor: string) => void
  retry: () => void
}) {
  const { t, formatLocale } = useI18n()
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const page = await unwrap(
          api.GET('/api/v1/workflows/{id}/runs', {
            params: { path: { id }, query: { cursor } },
            signal,
            cache: 'no-store',
          }),
        )
        if (page.data.some((run) => run.workflowId !== id.toLowerCase())) return null
        return page
      } catch (error) {
        if (error instanceof RequestError && (error.status === 403 || error.status === 404))
          return null
        throw error
      }
    },
    [id, cursor],
  )
  const [page] = useLoad(load)
  if (page.status === 'loading') return <PageSkeleton label="Loading run history…" />
  if (page.status === 'error') return <LoadError retry={retry} />
  if (!page.data) return <Unavailable />

  const { data, nextCursor } = page.data
  const date = new Intl.DateTimeFormat(formatLocale, { dateStyle: 'medium', timeStyle: 'short' })
  const number = new Intl.NumberFormat(formatLocale)
  return (
    <>
      {data.length ? (
        <ul className="card-list plain-list">
          {data.map((run, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: history has no row IDs and this list is remounted for each page.
            <li key={index} className="panel card-item">
              <div className="card-main">
                <h2 className="card-title">
                  {t(
                    Object.hasOwn(triggers, run.trigger)
                      ? triggers[run.trigger]
                      : 'Unknown trigger',
                  )}
                </h2>
                <dl className="details">
                  <dt>{t('Outcome')}</dt>
                  <dd>
                    {t(Object.hasOwn(outcomes, run.outcome) ? outcomes[run.outcome] : 'Unknown')}
                  </dd>
                  {run.reason !== null && (
                    <>
                      <dt>{t('Reason')}</dt>
                      <dd>
                        {t(Object.hasOwn(reasons, run.reason) ? reasons[run.reason] : 'Unknown')}
                      </dd>
                    </>
                  )}
                  <dt>{t('Workflow revision')}</dt>
                  <dd>{number.format(run.revision)}</dd>
                  <dt>{t('Scheduled for')}</dt>
                  <dd>
                    <time dateTime={run.dueAt}>{date.format(new Date(run.dueAt))}</time>
                  </dd>
                  <dt>{t('Finished at')}</dt>
                  <dd>
                    <time dateTime={run.finishedAt}>{date.format(new Date(run.finishedAt))}</time>
                  </dd>
                </dl>
              </div>
              <dl className="details">
                <dt>{t('Sent')}</dt>
                <dd>{number.format(run.sent)}</dd>
                <dt>{t('Rejected')}</dt>
                <dd>{number.format(run.rejected)}</dd>
                <dt>{t('Send outcome unknown')}</dt>
                <dd>{number.format(run.deliveryUnknown)}</dd>
                <dt>{t('Recipients skipped')}</dt>
                <dd>{number.format(run.skipped)}</dd>
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t('No finished runs yet.')} />
      )}
      {(previous || nextCursor !== null) && (
        <nav className="form-actions" aria-label={t('Run history pages')}>
          <button className="button" type="button" onClick={previous} disabled={!previous}>
            {t('Previous page')}
          </button>
          <button
            className="button"
            type="button"
            disabled={nextCursor === null}
            onClick={() => nextCursor !== null && next(nextCursor)}
          >
            {t('Next page')}
          </button>
        </nav>
      )}
    </>
  )
}
