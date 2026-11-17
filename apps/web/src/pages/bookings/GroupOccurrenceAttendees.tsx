import { useCallback, useId, useState } from 'react'
import { api, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged } from '../../api/errors.ts'
import { BreakableText } from '../../components/BreakableText.tsx'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import { OrganizationContextConflict } from '../../components/OrganizationContextConflict.tsx'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { answerText } from './booking-format.ts'

/** Private host/team-manager panel. Never mounted on invitee or public pages. */
export function GroupOccurrenceAttendees({
  occurrenceId,
  expectedOrganizationId,
  disabled = false,
  onCancelled,
  questions = [],
}: {
  occurrenceId: string
  expectedOrganizationId: string
  questions?: readonly { id: string; label: string }[]
  disabled?: boolean
  onCancelled?: () => void
}) {
  const { t, locale } = useI18n()
  const heading = useId()
  const [conflict, setConflict] = useState<unknown>(null)
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        return await unwrap(
          api.GET('/api/v1/group-occurrences/{id}/attendees', {
            params: { path: { id: occurrenceId } },
            headers: { 'X-Expected-Organization-Id': expectedOrganizationId },
            signal,
          }),
        )
      } catch (error) {
        if (!signal.aborted && isOrganizationContextChanged(error)) setConflict(error)
        throw error
      }
    },
    [occurrenceId, expectedOrganizationId],
  )
  const [state, reload] = useLoad(load)
  async function cancelOccurrence() {
    try {
      await unwrap(
        api.POST('/api/v1/group-occurrences/{id}/cancel', {
          params: { path: { id: occurrenceId } },
          headers: { 'X-Expected-Organization-Id': expectedOrganizationId },
          body: {},
        }),
      )
      reload()
      onCancelled?.()
    } catch (error) {
      if (isOrganizationContextChanged(error)) setConflict(error)
      throw error
    }
  }
  return (
    <section className="panel" aria-labelledby={heading}>
      <h2 id={heading}>{t('Session attendee list')}</h2>
      <p className="hint">
        {t(
          'Only the host and authorized team administrators can see this list. Invitees cannot see each other.',
        )}
      </p>
      {disabled || conflict ? (
        <>
          <p role="status">{t('Your team context changed. Reload before making changes.')}</p>
          <OrganizationContextConflict error={conflict} />
        </>
      ) : state.status === 'loading' ? (
        <p role="status">{t('Loading attendees…')}</p>
      ) : state.status === 'error' ? (
        <div role="alert">
          <p>{t('Could not load the attendee list.')}</p>
          <button type="button" className="button" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      ) : (
        <>
          <p>
            {t('{active} of {capacity} seats booked', {
              active: state.data.activeSeats,
              capacity: state.data.capacity,
            })}
          </p>
          <ul className="plain-list stack">
            {state.data.attendees.map((person) => (
              <li key={person.bookingId} className="user-content">
                <h3>
                  <BreakableText>{person.name}</BreakableText>
                </h3>
                <p>
                  <BreakableText>{person.email}</BreakableText>
                </p>
                <p>
                  {t(person.status === 'cancelled' ? 'Cancelled' : 'Confirmed')}
                  {person.noShowMarkedAt && <> · {t('No-show')}</>}
                </p>
                <dl className="details details-stacked">
                  {Object.entries(person.responses).map(([question, answer]) => (
                    <div key={question} className="detail-pair">
                      <dt>{questions.find((item) => item.id === question)?.label ?? question}</dt>
                      <dd className="multiline">
                        {typeof answer === 'boolean'
                          ? t(answer ? 'Yes' : 'No')
                          : answerText(answer, locale)}
                      </dd>
                    </div>
                  ))}
                </dl>
                {Object.keys(person.responses).length === 0 && (
                  <p className="muted">{t('No answers to extra questions.')}</p>
                )}
              </li>
            ))}
          </ul>
          {state.data.attendees.length === 0 && <p>{t('No attendees in this session.')}</p>}
          <button type="button" className="button" onClick={reload}>
            {t('Refresh')}
          </button>
          {state.data.state === 'open' && new Date(state.data.start).getTime() > Date.now() && (
            <ConfirmAction
              label={t('Cancel whole session…')}
              prompt={t(
                'Cancel every active seat in this session? All affected invitees will be notified.',
              )}
              confirmLabel={t('Cancel whole session')}
              busyLabel={t('Cancelling…')}
              failure={t('Could not cancel the session.')}
              onConfirm={cancelOccurrence}
            />
          )}
        </>
      )}
    </section>
  )
}
