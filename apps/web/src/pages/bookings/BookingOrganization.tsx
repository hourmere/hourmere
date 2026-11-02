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

  const load = useCallback(
    async (signal: AbortSignal): Promise<Me | 'team_admin' | 'missing'> => {
      let resolved: { organizationId: string; access: 'host' | 'team_admin' }
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
      const personal = organizationId === personalOrganizationId
      if (signal.aborted) throw signal.reason
      // Preserve the authorized destination for a refresh after a committed switch
      // whose response is lost. This history hint grants no server-side access.
      rememberSpace(organizationId, access)
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
      id,
      currentOrganizationId,
      personalOrganizationId,
      userId,
      beginContextSwitch,
      refresh,
      rememberSpace,
    ],
  )
  const [state, reload] = useLoad(load)

  useEffect(() => {
    // Commit the consumed history entry before accept remounts the organization tree.
    const saved = location.state?.bookingSpace
    if (
      state.status === 'ready' &&
      typeof state.data === 'object' &&
      saved?.userId === userId &&
      saved?.id === id &&
      saved?.organizationId === state.data.organization.id
    )
      accept(state.data)
  }, [state, accept, location.state, userId, id])

  if (state.status === 'ready' && state.data === 'team_admin')
    return <TeamBookingDetailPage id={id} />

  if (state.status === 'error') {
    return (
      <>
        <PageHeader title={t('Booking')} />
        <div className="alert alert-error" role="alert">
          <p>
            {t('Could not load the booking.')} {ui(state.message)}
          </p>
          <button type="button" className="button button-small" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      </>
    )
  }
  if (state.status === 'ready' && state.data === 'missing') {
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
