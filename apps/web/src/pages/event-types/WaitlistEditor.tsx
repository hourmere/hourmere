import { useCallback, useState } from 'react'
import { api, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import { FieldError, type FieldErrors } from '../../components/forms.tsx'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { useMe, useSession } from '../../session.tsx'
import { useTeamManagementAccess } from '../../team-management.tsx'

/** Contact details are requested only after current management access is confirmed. */
export function WaitlistEditor({
  enabled,
  supported,
  eventTypeId,
  savedVersion = 0,
  errors,
  disabled,
  onChange,
}: {
  enabled: boolean
  supported: boolean
  eventTypeId?: string
  savedVersion?: number
  errors: FieldErrors
  disabled: boolean
  onChange: (enabled: boolean) => void
}) {
  const { t } = useI18n()
  const me = useMe()
  const access = useTeamManagementAccess()
  const { confirmReload } = useSession()
  const [showEntries, setShowEntries] = useState(false)
  const canManage = me.organization.personal || (access.status === 'ready' && access.role !== null)
  const accessUnknown =
    access.status === 'error' || (access.status === 'ready' && access.roles === null)
  return (
    <section className="panel" aria-labelledby="waitlist-heading">
      <h2 id="waitlist-heading">{t('Booking waitlist')}</h2>
      {!canManage ? (
        <>
          <p>
            {t(
              access.status === 'loading'
                ? 'Checking waitlist management access…'
                : accessUnknown
                  ? 'Could not check waitlist management access. Try again.'
                  : 'Only team owners and admins can manage the waitlist.',
            )}
          </p>
          {accessUnknown && (
            <button
              type="button"
              className="button button-small"
              onClick={access.status === 'error' ? access.reload : confirmReload}
            >
              {t('Try again')}
            </button>
          )}
        </>
      ) : (
        <>
          <label className="checkbox">
            <input
              id="waitlist"
              type="checkbox"
              checked={enabled}
              disabled={disabled || (!supported && !enabled)}
              aria-describedby={`waitlist-hint${errors.waitlist ? ' waitlist-error' : ''}`}
              aria-invalid={errors.waitlist ? true : undefined}
              onChange={(e) => onChange(e.target.checked)}
            />
            {t('Let invitees join a waitlist when no times are available')}
          </label>
          <p className="hint" id="waitlist-hint">
            {t(
              'Eligible invitees are notified together. Nothing is reserved; the first successful booking wins. Turning this off removes the current entries without sending an email.',
            )}
          </p>
          {!supported && (
            <p className="hint">
              {t(
                'Waitlists are available only for one-on-one event types with a single host (not round-robin or collective).',
              )}
            </p>
          )}
          {errors.waitlist && <FieldError id="waitlist-error">{errors.waitlist}</FieldError>}
          {eventTypeId &&
            (showEntries ? (
              <WaitlistEntries
                key={`${eventTypeId}:${savedVersion}`}
                eventTypeId={eventTypeId}
                disabled={disabled}
              />
            ) : (
              <button
                type="button"
                className="button button-small"
                disabled={disabled}
                onClick={() => setShowEntries(true)}
              >
                {t('View waitlist entries')}
              </button>
            ))}
        </>
      )}
    </section>
  )
}

const stateLabels = {
  pending_verification: 'Pending verification',
  active: 'Waiting for a time',
  notified: 'Notified',
  booked: 'Booked',
  removed: 'Removed',
  expired: 'Expired',
} as const satisfies Record<string, MessageKey>

function WaitlistEntries({ eventTypeId, disabled }: { eventTypeId: string; disabled: boolean }) {
  const { t, locale } = useI18n()
  const me = useMe()
  const access = useTeamManagementAccess()
  const { confirmReload } = useSession()
  const [expectedOrganizationId] = useState(me.organization.id)
  const [after, setAfter] = useState<string | undefined>()
  const [version, setVersion] = useState(0)
  const [revoked, setRevoked] = useState(false)
  const [contextChanged, setContextChanged] = useState(false)
  const [removed, setRemoved] = useState<string[]>([])
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        return await unwrap(
          api.GET('/api/v1/event-types/{id}/waitlist/entries', {
            params: { path: { id: eventTypeId }, query: { after, limit: 20 } },
            headers: { 'X-Expected-Organization-Id': expectedOrganizationId },
            signal,
          }),
        )
      } catch (error) {
        if (!signal.aborted) {
          if (isOrganizationContextChanged(error)) setContextChanged(true)
          if (error instanceof RequestError && error.status === 403) {
            setRevoked(true)
            access.revoke()
          }
        }
        throw error
      }
    },
    [eventTypeId, after, expectedOrganizationId, access.revoke],
  )
  const [state, reload] = useLoad(load)
  const unavailable = revoked || contextChanged || disabled
  const format = (value: string, timeZone?: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timeZone && { timeZone }),
    }).format(new Date(value))

  async function remove(entryId: string) {
    try {
      await unwrap(
        api.DELETE('/api/v1/event-types/{id}/waitlist/entries/{entryId}', {
          params: { path: { id: eventTypeId, entryId } },
          headers: { 'X-Expected-Organization-Id': expectedOrganizationId },
        }),
      )
      // Erase contact details immediately, even if a later refresh fails.
      setRemoved((ids) => [...ids, entryId])
      setVersion((value) => value + 1)
    } catch (error) {
      if (isOrganizationContextChanged(error)) setContextChanged(true)
      if (error instanceof RequestError && error.status === 403) {
        setRevoked(true)
        access.revoke()
      }
      throw error
    }
  }

  return (
    <section aria-labelledby="waitlist-entries-heading">
      <h3 id="waitlist-entries-heading">{t('Waitlist entries')}</h3>
      {contextChanged || disabled ? (
        <>
          <p role="status">{t('Your team context changed. Reload before making changes.')}</p>
          <button type="button" className="button button-small" onClick={confirmReload}>
            {t('Reload')}
          </button>
        </>
      ) : revoked ? (
        <p role="status">{t('Could not check waitlist management access. Try again.')}</p>
      ) : state.status === 'loading' ? (
        <p role="status">{t('Loading waitlist entries…')}</p>
      ) : state.status === 'error' ? (
        <div role="alert">
          <p>{t('Could not load waitlist entries.')}</p>
          <button type="button" className="button button-small" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      ) : (
        <>
          <p className="hint">
            {t(
              '“Last notified” shows the latest time a mail server accepted a notification email, based on the records still retained. This does not confirm inbox delivery. Older notification records may have been cleared.',
            )}
          </p>
          {state.data.data.length === 0 ? (
            <p>{t('No waitlist entries.')}</p>
          ) : (
            <ul className="plain-list card-list">
              {state.data.data.map((entry) => {
                const erased = removed.includes(entry.id)
                const window = erased ? null : entry.preferredWindow
                return (
                  <li className="panel user-content" key={entry.id}>
                    <h4>
                      {erased
                        ? t('Contact details cleared')
                        : (entry.email ?? t('Contact details cleared'))}
                    </h4>
                    {!erased && entry.name && <p>{entry.name}</p>}
                    <dl className="details">
                      <dt>{t('Status')}</dt>
                      <dd>{t(stateLabels[erased ? 'removed' : entry.state])}</dd>
                      <dt>{t('Requested period')}</dt>
                      <dd>
                        {window ? (
                          <>
                            <time dateTime={window.start}>
                              {format(window.start, window.timeZone)}
                            </time>
                            {' – '}
                            <time dateTime={window.end}>{format(window.end, window.timeZone)}</time>{' '}
                            {window.timeZone}
                          </>
                        ) : (
                          t('Contact details cleared')
                        )}
                      </dd>
                      <dt>{t('Created')}</dt>
                      <dd>
                        <time dateTime={entry.createdAt}>{format(entry.createdAt)}</time>
                      </dd>
                      <dt>{t('Last notified')}</dt>
                      <dd>
                        {entry.lastNotifiedAt ? (
                          <time dateTime={entry.lastNotifiedAt}>
                            {format(entry.lastNotifiedAt)}
                          </time>
                        ) : (
                          t(
                            entry.state === 'pending_verification' || entry.state === 'active'
                              ? 'Not notified yet'
                              : 'Notification time unavailable',
                          )
                        )}
                      </dd>
                    </dl>
                    {!erased &&
                      ['pending_verification', 'active', 'notified'].includes(entry.state) && (
                        <ConfirmAction
                          key={version}
                          label={t('Remove entry')}
                          prompt={t(
                            'Remove this waitlist entry? Their contact details will be cleared. No email will be sent.',
                          )}
                          confirmLabel={t('Remove entry')}
                          busyLabel={t('Removing…')}
                          failure={t('Could not remove the waitlist entry.')}
                          onConfirm={() => remove(entry.id)}
                        />
                      )}
                  </li>
                )
              })}
            </ul>
          )}
          <div className="actions">
            {after && (
              <button
                type="button"
                className="button button-small"
                disabled={unavailable}
                onClick={() => setAfter(undefined)}
              >
                {t('Back to first page')}
              </button>
            )}
            {state.data.nextAfter && (
              <button
                type="button"
                className="button button-small"
                disabled={unavailable}
                onClick={() => setAfter(state.data.nextAfter ?? undefined)}
              >
                {t('Next page')}
              </button>
            )}
            <button
              type="button"
              className="button button-small"
              disabled={unavailable}
              onClick={reload}
            >
              {t('Refresh')}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
