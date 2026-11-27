import { useCallback, useEffect } from 'react'
import { useLocation } from 'react-router'
import { setActiveOrganization } from '../../api/auth.ts'
import { api, unwrap } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { useLoad, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { PATHS } from '../../paths.ts'
import { type Me, useMe, useSession } from '../../session.tsx'
import { MissingRecord } from '../NotFound.tsx'
import { TeamBookingDetailPage } from '../team-bookings/TeamBookingDetail.tsx'

type Destination = { organizationId: string; access: 'host' | 'team_admin' }

/** Resolve access before issuing any session-wide space switch. */
export function BookingOrganization({
  id,
  rememberSpace,
}: {
  id: string
  rememberSpace: (organizationId: string, access: 'host' | 'team_admin') => void
}) {
  const { t, ui } = useI18n()
  const me = useMe()
  const location = useLocation()
  const userId = me.user.id
  const currentOrganizationId = me.organization.id
  const personalOrganizationId = me.personalOrganizationId
  const { accept, beginContextSwitch, refresh } = useSession()
  usePageTitle('Booking')

  const resolve = useCallback(
    async (signal: AbortSignal): Promise<Destination | 'team_admin' | 'missing'> => {
      let resolved: Destination
      try {
        resolved = await unwrap(
          api.GET('/api/v1/bookings/{id}/organization', {
            params: { path: { id } },
            signal,
          }),
        )
      } catch (error) {
        if (error instanceof RequestError && [400, 404].includes(error.status)) return 'missing'
        throw error
      }
      if (signal.aborted) throw signal.reason
      const { organizationId, access } = resolved
      if (organizationId === currentOrganizationId) {
        if (access === 'team_admin') rememberSpace(organizationId, access)
        return access === 'team_admin' ? 'team_admin' : 'missing'
      }
      // Preserve the authorized destination for a refresh after a committed switch
      // whose response is lost. This history hint grants no server-side access.
      rememberSpace(organizationId, access)
      return resolved
    },
    [id, currentOrganizationId, rememberSpace],
  )
  const [resolution, reload] = useLoad(resolve)
  const destination = resolution.status === 'ready' ? resolution.data : null
  const saved = location.state?.bookingSpace
  // Commit the history hint before a session refresh can remount the page in the
  // destination space. Router navigation and session updates use separate transitions.
  const confirmedDestination =
    destination &&
    typeof destination === 'object' &&
    saved?.userId === userId &&
    saved?.id === id &&
    saved?.organizationId === destination.organizationId &&
    saved?.access === destination.access
      ? destination
      : null
  const switchSpace = useCallback(
    async (signal: AbortSignal): Promise<Me | 'missing' | null> => {
      if (!confirmedDestination) return null
      const { organizationId } = confirmedDestination
      const personal = organizationId === personalOrganizationId
      const release = beginContextSwitch()
      let confirmed = false
      try {
        // Once issued, observe the switch's outcome even when navigation aborts this
        // page. Cancelling the fetch cannot undo a server-side context change.
        await setActiveOrganization(
          { organizationId: personal ? null : organizationId },
          undefined,
          currentOrganizationId,
        )
        const current = await unwrap(api.GET('/api/v1/me', { signal }))
        if (current.user.id !== userId || current.organization.id !== organizationId)
          throw new Error('The selected context could not be confirmed')
        if (signal.aborted) throw signal.reason
        confirmed = true
        return current
      } catch (error) {
        // Membership can be withdrawn between resolution and the switch.
        if (error instanceof RequestError && [400, 403, 404].includes(error.status))
          return 'missing'
        throw error
      } finally {
        release()
        // A failed response can still follow a committed switch. Reconcile after any
        // uncertain outcome or navigation, using a fresh read of the current session.
        // A newer deliberate switch defers this read and confirms its own context.
        if (!confirmed || signal.aborted) void refresh({ fresh: true })
      }
    },
    [
      confirmedDestination,
      currentOrganizationId,
      personalOrganizationId,
      userId,
      beginContextSwitch,
      refresh,
    ],
  )
  const [handoff] = useLoad(switchSpace)

  useEffect(() => {
    if (
      handoff.status === 'ready' &&
      handoff.data &&
      handoff.data !== 'missing' &&
      handoff.data.organization.id === confirmedDestination?.organizationId
    )
      accept(handoff.data)
  }, [handoff, confirmedDestination, accept])

  if (destination === 'team_admin') return <TeamBookingDetailPage id={id} />

  const error =
    resolution.status === 'error' ? resolution : handoff.status === 'error' ? handoff : null
  if (error) {
    return (
      <>
        <PageHeader title={t('Booking')} />
        <div className="alert alert-error" role="alert">
          <p>
            {t('Could not load the booking.')} {ui(error.message)}
          </p>
          <button type="button" className="button button-small" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      </>
    )
  }
  if (destination === 'missing' || (handoff.status === 'ready' && handoff.data === 'missing')) {
    return (
      <MissingRecord
        title={t('Booking not found')}
        message="This booking does not exist, or it is not one of yours."
        back={{ to: PATHS.bookings, label: 'Back to bookings' }}
      />
    )
  }
  return <PageSkeleton label="Loading the booking…" />
}
