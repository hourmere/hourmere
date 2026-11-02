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
import { hostZone } from '../bookings/booking-format.ts'
import { MissingRecord } from '../NotFound.tsx'
import { BookingDetail } from './TeamBookings.tsx'

type Detail =
  | { kind: 'booking'; booking: Schemas['TeamAdminBooking']; timeZone: string }
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
export function TeamBookingDetailPage({ id }: { id: string }) {
  const { t, ui } = useI18n()
  const me = useMe()
  const navigate = useNavigate()
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
      />
    )
  return (
    <div className="team-bookings-page">
      <PageHeader title={t('Booking')} />
      <p>
        <Link to={PATHS.teamBookings}>{t('Team bookings')}</Link>
      </p>
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
            booking={state.data.booking}
            timeZone={state.data.timeZone}
            expectedOrganizationId={expectedOrganizationId}
            conflict={conflict}
            onConflict={(error) => {
              setConflict(error)
              access.reportContextChanged(error)
            }}
            onRevoked={() => {
              setRevoked(true)
              access.revoke()
            }}
            onRefresh={reload}
            onCancelled={reload}
            onClose={() => navigate(PATHS.teamBookings)}
          />
        </>
      ) : null}
    </div>
  )
}
