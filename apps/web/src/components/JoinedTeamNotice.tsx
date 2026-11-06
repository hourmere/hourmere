import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useI18n } from '../i18n/runtime.tsx'
import { PATHS } from '../paths.ts'
import { type Notice, useMe, useSession } from '../session.tsx'

/** Consume the join handoff into this page visit, so history and reload cannot replay it. */
export function JoinedTeamNotice() {
  const { t, ui } = useI18n()
  const { notice, setNotice } = useSession()
  const me = useMe()
  const location = useLocation()
  const [joined, setJoined] = useState<{ notice: Notice; locationKey: string } | null>(null)
  const visible =
    joined &&
    joined.locationKey === location.key &&
    joined.notice.joinedTeam?.userId === me.user.id &&
    joined.notice.joinedTeam.organizationId === me.organization.id &&
    !me.organization.personal

  useEffect(() => {
    if (notice?.joinedTeam) {
      if (
        notice.path === location.pathname &&
        notice.joinedTeam.userId === me.user.id &&
        notice.joinedTeam.organizationId === me.organization.id &&
        !me.organization.personal
      )
        setJoined({ notice, locationKey: location.key })
      setNotice(null)
    } else if (joined && !visible) setJoined(null)
  }, [notice, setNotice, location.key, location.pathname, me, joined, visible])

  if (!visible) return null
  return (
    <div className="alert alert-info notice">
      <div className="user-content">
        <p role="status">{ui(joined.notice.message)}</p>
        <Link to={PATHS.availability}>{t('Review default availability')}</Link>
      </div>
      <button type="button" className="button button-small" onClick={() => setJoined(null)}>
        {t('Dismiss')}
      </button>
    </div>
  )
}
