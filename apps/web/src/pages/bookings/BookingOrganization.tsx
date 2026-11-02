import { useCallback, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { listOrganizations, setActiveOrganization } from '../../api/auth.ts'
import { api, unwrap } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { useLoad, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { PATHS } from '../../paths.ts'
import { type Me, useMe, useSession } from '../../session.tsx'
import { MissingRecord } from '../NotFound.tsx'

/** A mail link selects a space, but never grants membership or booking access. */
export function BookingOrganization({ organizationId }: { organizationId: string }) {
  const { t, ui } = useI18n()
  const me = useMe()
  const userId = me.user.id
  const currentOrganizationId = me.organization.id
  const personalOrganizationId = me.personalOrganizationId
  const { accept, beginContextSwitch, refresh } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  usePageTitle('Booking')

  const load = useCallback(
    async (signal: AbortSignal): Promise<Me | 'current' | 'missing'> => {
      if (organizationId === currentOrganizationId) return 'current'
      const personal = organizationId === personalOrganizationId
      if (!personal) {
        const organizations = await listOrganizations(signal)
        if (!organizations.some((organization) => organization.id === organizationId))
          return 'missing'
      }
      if (signal.aborted) throw signal.reason
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
        confirmed = true
        return current
      } catch (error) {
        // Membership can be withdrawn between the membership list and the switch.
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
      organizationId,
      currentOrganizationId,
      personalOrganizationId,
      userId,
      beginContextSwitch,
      refresh,
    ],
  )
  const [state, reload] = useLoad(load)

  useEffect(() => {
    if (state.status !== 'ready' || state.data === 'missing') return
    if (state.data !== 'current') accept(state.data)
    const search = new URLSearchParams(location.search)
    search.delete('organizationId')
    // Consume the hint so a later deliberate space switch does not jump back here.
    navigate({ pathname: location.pathname, search: search.toString() }, { replace: true })
  }, [state, accept, navigate, location.pathname, location.search])

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
