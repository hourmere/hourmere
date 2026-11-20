import { useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { listOrganizations, setActiveOrganization } from '../../api/auth.ts'
import { api, unwrap } from '../../api/client.ts'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { useLoad, useMounted, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { bookingPath, PATHS } from '../../paths.ts'
import { useMe, useSession } from '../../session.tsx'
import { useConfirmLeave } from '../../unsaved-changes.tsx'
import { MissingRecord } from '../NotFound.tsx'
import { MeetingPollResults } from './MeetingPollResults.tsx'

const backTo = { to: PATHS.meetingPolls, label: 'Back to meeting polls' }
const organizationIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export function HostMeetingPollRoute() {
  const { id = '' } = useParams()
  const [query] = useSearchParams()
  const me = useMe()
  const navigate = useNavigate()
  const organizations = query.getAll('organizationId')
  const target = organizations[0]?.toLowerCase() ?? me.organization.id
  if (organizations.length > 1 || !organizationIdPattern.test(target)) return <Unavailable />
  if (target !== me.organization.id) {
    if (me.principal.kind !== 'session') return <Unavailable />
    return <PollSpace key={`${id}:${target}`} organizationId={target} />
  }
  return (
    <MeetingPollResults
      key={`${target}:${id}`}
      id={id}
      organizationId={target}
      backTo={backTo.to}
      bookingLink={bookingPath}
      onDeleted={() => navigate(backTo.to, { replace: true })}
    />
  )
}

function Unavailable() {
  return (
    <MissingRecord
      title="Meeting polls"
      message="This meeting poll is unavailable."
      back={backTo}
    />
  )
}

function PollSpace({ organizationId }: { organizationId: string }) {
  const { t } = useI18n()
  const me = useMe()
  const { accept, beginContextSwitch, refresh } = useSession()
  const confirmLeave = useConfirmLeave()
  const mounted = useMounted()
  const [memberships, reload] = useLoad(listOrganizations)
  const [switching, setSwitching] = useState(false)
  const [failed, setFailed] = useState(false)
  const inFlight = useRef(false)
  usePageTitle('Meeting polls')

  const personal = me.personalOrganizationId === organizationId
  const name = personal
    ? t('Personal')
    : memberships.status === 'ready'
      ? memberships.data.find(({ id }) => id === organizationId)?.name
      : undefined

  async function openSpace() {
    if (inFlight.current || !confirmLeave()) return
    inFlight.current = true
    setSwitching(true)
    setFailed(false)
    const release = beginContextSwitch()
    let accepted = false
    try {
      await setActiveOrganization(
        { organizationId: personal ? null : organizationId },
        undefined,
        me.organization.id,
      )
      const current = await unwrap(api.GET('/api/v1/me', { cache: 'no-store' }))
      if (
        !mounted.current ||
        current.user.id !== me.user.id ||
        current.organization.id !== organizationId
      )
        return
      accept(current)
      accepted = true
    } catch {
      // The session switch may have committed even if its response was lost.
    } finally {
      release()
      inFlight.current = false
      if (mounted.current) {
        setSwitching(false)
        if (!accepted) setFailed(true)
      }
      if (!accepted) void refresh({ fresh: true })
    }
  }

  if (!name && memberships.status === 'ready') return <Unavailable />
  return (
    <>
      <PageHeader title={t('Meeting polls')} lede={t('This poll belongs to another space.')} />
      {name ? (
        <div className="form-actions">
          <button
            type="button"
            className="button button-primary meeting-poll-space-switch"
            onClick={() => void openSpace()}
            disabled={switching}
          >
            {switching ? t('Switching space…') : t('Switch to {space}', { space: name })}
          </button>
        </div>
      ) : memberships.status === 'loading' ? (
        <PageSkeleton label="Loading spaces…" />
      ) : (
        <div className="alert alert-error" role="alert">
          <p>{t('Could not open the space for this poll.')}</p>
          <button type="button" className="button button-small" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      )}
      {failed && (
        <p className="alert alert-error" role="alert">
          {t('Could not open the space for this poll.')}
        </p>
      )}
      <p>
        <Link to={backTo.to}>{t('Back to meeting polls')}</Link>
      </p>
    </>
  )
}
