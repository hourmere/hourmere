import { useCallback, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import { EmptyState } from '../../components/EmptyState.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { zoned } from '../../format.ts'
import { useLoad, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { meetingPollPath, PATHS } from '../../paths.ts'
import { useMe } from '../../session.tsx'
import { POLL_STATUS } from './poll-results-api.ts'

export function MeetingPollsPage() {
  const me = useMe()
  return <MeetingPollList key={me.organization.id} organizationId={me.organization.id} />
}

function MeetingPollList({ organizationId }: { organizationId: string }) {
  const { t } = useI18n()
  const [cursors, setCursors] = useState<string[]>([])
  const pageStart = useRef<HTMLDivElement>(null)
  const after = cursors.at(-1)
  usePageTitle('Meeting polls')

  function moveTo(next: string[]) {
    setCursors(next)
    pageStart.current?.focus()
  }

  return (
    <>
      <div ref={pageStart} tabIndex={-1}>
        <PageHeader title={t('Meeting polls')} />
      </div>
      <MeetingPollListPage
        key={after ?? ''}
        organizationId={organizationId}
        after={after}
        previous={cursors.length ? () => moveTo(cursors.slice(0, -1)) : undefined}
        next={(cursor) => moveTo([...cursors, cursor])}
      />
    </>
  )
}

function MeetingPollListPage({
  organizationId,
  after,
  previous,
  next,
}: {
  organizationId: string
  after: string | undefined
  previous: (() => void) | undefined
  next: (cursor: string) => void
}) {
  const { formatLocale, t } = useI18n()
  const load = useCallback(
    async (signal: AbortSignal): Promise<Schemas['MeetingPollHostPage'] | 'forbidden'> => {
      try {
        const result = await unwrap(
          api.GET('/api/v1/meeting-polls', {
            params: { query: after === undefined ? {} : { after } },
            signal,
            cache: 'no-store',
          }),
        )
        if (result.data.some((poll) => poll.organizationId !== organizationId))
          throw new RequestError(409, 'organization_context_changed', '')
        return result
      } catch (error) {
        if (error instanceof RequestError && error.status === 403) return 'forbidden'
        throw error
      }
    },
    [after, organizationId],
  )
  const [state, reload] = useLoad(load)

  if (state.status === 'loading') return <PageSkeleton label="Loading meeting polls…" />
  if (state.status === 'error')
    return (
      <div className="alert alert-error" role="alert">
        <p>{t('Could not load meeting polls.')}</p>
        <button className="button button-small" type="button" onClick={reload}>
          {t('Try again')}
        </button>
      </div>
    )
  if (state.data === 'forbidden')
    return (
      <p className="alert alert-error" role="alert">
        {t('Only team owners and admins can manage meeting polls in this space.')}
      </p>
    )

  const { data, nextAfter } = state.data
  return (
    <>
      <div className="form-actions">
        <Link className="button button-primary" to={PATHS.newMeetingPoll}>
          {t('Create meeting poll')}
        </Link>
      </div>
      {data.length ? (
        <ul className="card-list plain-list meeting-poll-list">
          {data.map((poll) => {
            const format = zoned(poll.displayTimeZone, formatLocale)
            return (
              <li className="panel card-item" key={poll.id}>
                <div className="card-main">
                  <h2 className="card-title">
                    <Link className="user-content" to={meetingPollPath(poll.id, organizationId)}>
                      <bdi>{poll.title}</bdi>
                    </Link>
                  </h2>
                  <p>{t(POLL_STATUS[poll.status] ?? 'Unknown')}</p>
                  <p className="muted">
                    {t('Voting deadline: {deadline} ({timeZone})', {
                      deadline: format.dateTime(poll.deadlineAt),
                      timeZone: format.timeZone,
                    })}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <EmptyState title={t('No meeting polls yet.')} />
      )}
      {(previous || nextAfter) && (
        <nav className="form-actions" aria-label={t('Meeting poll pages')}>
          <button className="button" type="button" onClick={previous} disabled={!previous}>
            {t('Previous page')}
          </button>
          <button
            className="button"
            type="button"
            onClick={() => nextAfter && next(nextAfter)}
            disabled={!nextAfter}
          >
            {t('Next page')}
          </button>
        </nav>
      )}
    </>
  )
}
