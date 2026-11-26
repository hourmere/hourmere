import { useCallback, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { loadProfile } from '../../api/resources.ts'
import { OrganizationContextConflict } from '../../components/OrganizationContextConflict.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { useLoad, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { PATHS } from '../../paths.ts'
import { useMe } from '../../session.tsx'
import { useTeamManagementAccess } from '../../team-management.tsx'
import { useCloseBookingPanel } from '../bookings/BookingPanel.tsx'
import { hostZone } from '../bookings/booking-format.ts'
import { type NoShowChange, withNoShowChange } from '../bookings/NoShowAttendees.tsx'
import { MissingRecord } from '../NotFound.tsx'
import { BookingDetail } from './TeamBookings.tsx'

type Detail =
  | { kind: 'booking'; booking: Schemas['TeamAdminBookingDetail']; timeZone: string }
  | { kind: 'missing' }
  | { kind: 'conflict'; error: unknown }

async function loadTeamBookingDetail(
  id: string,
  expectedOrganizationId: string,
  signal: AbortSignal,
): Promise<Detail> {
  try {
    const booking = await unwrap(
      api.GET('/api/v1/team/bookings/{id}', {
        params: {
          path: { id },
          header: { 'x-expected-organization-id': expectedOrganizationId },
        },
        signal,
      }),
    )
    const profile = await loadProfile(signal)
    return { kind: 'booking', booking, timeZone: hostZone(profile).timeZone }
  } catch (error) {
    if (isOrganizationContextChanged(error)) return { kind: 'conflict', error }
    if (error instanceof RequestError && [400, 403, 404].includes(error.status))
      return { kind: 'missing' }
    throw error
  }
}

/** Email deep links use only the current team's deliberately limited admin projection. */
export function TeamBookingDetailPage({
  id,
  embedded = false,
  onChanged,
  onClose,
  rowBooking,
  listConflict,
  onConflict,
  onRevoked,
  onRefresh,
  onCancelled,
  onNoShowChanged,
}: {
  id: string
  embedded?: boolean
  rowBooking?: Schemas['TeamAdminBooking']
  onChanged?: (booking: Schemas['TeamAdminBooking']) => void
  onClose?: () => void
  listConflict?: unknown
  onConflict?: (error: unknown) => void
  onRevoked?: () => void
  onRefresh?: () => void
  onCancelled?: (background?: boolean) => void
  onNoShowChanged?: (change: NoShowChange) => void
}) {
  const { t, ui } = useI18n()
  const me = useMe()
  const navigate = useNavigate()
  const closePanel = useCloseBookingPanel()
  const access = useTeamManagementAccess()
  const [expectedOrganizationId] = useState(me.organization.id)
  const [conflict, setConflict] = useState<unknown>(access.contextError)
  const [revoked, setRevoked] = useState(false)
  const load = useCallback(
    (signal: AbortSignal) => loadTeamBookingDetail(id, expectedOrganizationId, signal),
    [id, expectedOrganizationId],
  )
  const [state, reload] = useLoad(load)
  usePageTitle('Booking')
  if (revoked || (state.status === 'ready' && state.data.kind === 'missing'))
    return (
      <MissingRecord
        title={t('Booking not found')}
        message="This booking does not exist, or it is not one of yours."
        back={{ to: PATHS.bookings, label: 'Back to bookings' }}
        onBack={embedded ? closePanel : undefined}
      />
    )
  return (
    <div className="team-bookings-page">
      {!embedded && (
        <>
          <PageHeader title={t('Booking')} />
          <p>
            <Link to={PATHS.teamBookings}>{t('Team bookings')}</Link>
          </p>
        </>
      )}
      {state.status === 'loading' ? (
        <PageSkeleton label="Loading the booking…" />
      ) : state.status === 'error' ? (
        <div className="alert alert-error" role="alert">
          <p>
            {t('Could not load the booking.')} {ui(state.message)}
          </p>
          <button type="button" className="button button-small" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      ) : state.data.kind === 'conflict' ? (
        <OrganizationContextConflict error={state.data.error} />
      ) : state.data.kind === 'booking' ? (
        <>
          <OrganizationContextConflict error={conflict} />
          <BookingDetail
            embedded={embedded}
            booking={rowBooking ?? state.data.booking}
            teamsLocation={state.data.booking.location?.kind === 'microsoft_teams'}
            timeZone={state.data.timeZone}
            expectedOrganizationId={expectedOrganizationId}
            conflict={listConflict ?? conflict}
            onConflict={(error) => {
              setConflict(error)
              if (onConflict) onConflict(error)
              else access.reportContextChanged(error)
            }}
            onRevoked={() => {
              setRevoked(true)
              if (onRevoked) onRevoked()
              else access.revoke()
            }}
            onRefresh={onRefresh ?? reload}
            onNoShowChanged={(change) => {
              if (onNoShowChanged) {
                onNoShowChanged(change)
                return
              }
              if (state.data.kind === 'booking')
                onChanged?.(withNoShowChange(rowBooking ?? state.data.booking, change))
            }}
            onCancelled={(background) => {
              if (onCancelled) {
                onCancelled(background)
                return
              }
              if (state.data.kind === 'booking')
                onChanged?.({ ...(rowBooking ?? state.data.booking), status: 'cancelled' })
              reload()
            }}
            onClose={onClose ?? (() => navigate(PATHS.teamBookings))}
          />
        </>
      ) : null}
    </div>
  )
}
