import { useId } from 'react'
import type { Schemas } from '../../api/client.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { useMe } from '../../session.tsx'

export function ManualRebooking({
  booking,
  expectedOrganizationId,
}: {
  booking: Schemas['TeamAdminBooking']
  expectedOrganizationId: string
}) {
  const { t } = useI18n()
  const me = useMe()
  const headingId = useId()
  if (!booking.hosts.some((host) => host.isCurrentMember === false)) return null
  const contextChanged = me.organization.personal || me.organization.id !== expectedOrganizationId
  const publicPath = booking.eventType?.publicBookingPath

  return (
    <section className="team-booking-cancel" aria-labelledby={headingId}>
      <h3 id={headingId}>{t('Book again with another host')}</h3>
      <p>
        {t(
          'A host has left the team, so this booking cannot be rescheduled. Hourmere does not automatically assign another host.',
        )}
      </p>
      <ol>
        <li>
          {booking.status === 'cancelled'
            ? t('This booking is already cancelled. Continue with the next step.')
            : new Date(booking.start).getTime() <= Date.now()
              ? t(
                  'This booking has already started. Wait until it ends or coordinate with the hosts offline.',
                )
              : t('An admin cancels this booking here before it starts.')}
        </li>
        <li>{t('Then ask the guest to book again from the event’s public booking page.')}</li>
      </ol>
      {contextChanged ? (
        <p role="alert">{t('Your team context changed. Reload before making changes.')}</p>
      ) : publicPath ? (
        <p>
          <a href={publicPath}>{t('Open public booking page')}</a>
        </p>
      ) : (
        <>
          <p>{t('The event is no longer bookable.')}</p>
          <p>
            {t(
              'Ask an admin to repair and reactivate the event, or create a new event, before the guest books again.',
            )}
          </p>
        </>
      )}
    </section>
  )
}
