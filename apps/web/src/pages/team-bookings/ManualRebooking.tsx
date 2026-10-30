import { useEffect, useId, useRef, useState } from 'react'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { publicTeamPageUrl } from '../../paths.ts'
import { useMe } from '../../session.tsx'

type PageState =
  | { source: string; status: 'loading' | 'unavailable' | 'error' }
  | { source: string; status: 'ready'; url: string }

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
  const controller = useRef<AbortController | null>(null)
  const [page, setPage] = useState<PageState | null>(null)
  const eventId = booking.eventType?.id
  const deleted = !booking.eventType?.title
  const organizationId = me.organization.id
  const teamSlug = me.organization.slug
  const personal = me.organization.personal
  const contextChanged = personal || organizationId !== expectedOrganizationId
  const source = JSON.stringify([
    booking.id,
    eventId,
    deleted,
    expectedOrganizationId,
    organizationId,
    teamSlug,
    personal,
  ])
  const current = page?.source === source ? page : null

  // biome-ignore lint/correctness/useExhaustiveDependencies: changing this detail's bound context cancels its previous lookup
  useEffect(() => {
    return () => {
      controller.current?.abort()
      controller.current = null
    }
  }, [source])

  async function findPage() {
    if (controller.current || deleted || !eventId || contextChanged) return
    const request = new AbortController()
    controller.current = request
    const active = () => !request.signal.aborted && controller.current === request
    setPage({ source, status: 'loading' })
    try {
      const event = await unwrap(
        api.GET('/api/v1/event-types/{id}', {
          params: { path: { id: eventId } },
          signal: request.signal,
        }),
      )
      if (!active()) return
      if (
        event.id !== eventId ||
        event.ownerUserId !== null ||
        event.organizationId !== expectedOrganizationId ||
        event.organizationId !== organizationId ||
        !event.isActive
      ) {
        setPage({ source, status: 'unavailable' })
        return
      }
      const publicPage = await unwrap(
        api.GET('/api/v1/public/teams/{handle}/{slug}', {
          params: { path: { handle: teamSlug, slug: event.slug } },
          signal: request.signal,
        }),
      )
      if (!active()) return
      if (
        publicPage.handle !== teamSlug ||
        publicPage.team?.slug !== teamSlug ||
        publicPage.slug !== event.slug
      ) {
        setPage({ source, status: 'unavailable' })
        return
      }
      setPage({ source, status: 'ready', url: publicTeamPageUrl(teamSlug, event.slug) })
    } catch (error) {
      if (!active()) return
      setPage({
        source,
        status: error instanceof RequestError && error.status === 404 ? 'unavailable' : 'error',
      })
    } finally {
      if (controller.current === request) controller.current = null
    }
  }

  return (
    <section className="team-booking-cancel" aria-labelledby={headingId}>
      <h3 id={headingId}>{t('Book again with another host')}</h3>
      <p>
        {t(
          'If a host has left the team, this booking cannot be rescheduled. Hourmere does not automatically assign another host.',
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
      <div role="status">
        {deleted || current?.status === 'unavailable' ? (
          <p>
            {t(
              'The public booking page is unavailable. Ask an admin to repair and reactivate the event, or create a new event, before the guest books again.',
            )}
          </p>
        ) : !contextChanged && current?.status === 'ready' ? (
          <p>
            <a href={current.url}>{t('Open public booking page')}</a>
          </p>
        ) : null}
      </div>
      {contextChanged && (
        <p role="alert">{t('Your team context changed. Reload before making changes.')}</p>
      )}
      {!deleted && !contextChanged && (
        <>
          {current?.status === 'error' && (
            <p role="alert">
              {t('Could not confirm whether the public booking page is available. Try again.')}
            </p>
          )}
          <button
            type="button"
            className="button"
            onClick={findPage}
            aria-disabled={current?.status === 'loading'}
          >
            {current?.status === 'loading'
              ? t('Checking public booking page…')
              : current?.status === 'error'
                ? t('Try again')
                : current
                  ? t('Check public booking page again')
                  : t('Find public booking page')}
          </button>
        </>
      )}
    </section>
  )
}
