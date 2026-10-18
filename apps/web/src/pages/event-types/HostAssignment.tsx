import { useCallback, useState } from 'react'
import { api, unwrap } from '../../api/client.ts'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { UiText } from '../../i18n/translate.ts'
import type { EventTypeDraft } from './event-type-form.ts'

interface Props {
  draft: EventTypeDraft
  error?: UiText | undefined
  set: <K extends keyof EventTypeDraft>(name: K, value: EventTypeDraft[K]) => void
}

/** A paged directory, never another person's private schedules or email address. */
export function HostAssignment({ draft, error, set }: Props) {
  const { t, ui } = useI18n()
  const [after, setAfter] = useState<string | undefined>()
  const [previous, setPrevious] = useState<{ id: string; name: string }[]>([])
  const load = useCallback(
    (signal: AbortSignal) =>
      unwrap(
        api.GET('/api/v1/event-type-hosts', {
          params: { query: { limit: 100, ...(after && { after }) } },
          signal,
        }),
      ),
    [after],
  )
  const [state, reload] = useLoad(load)
  const members = state.status === 'ready' ? [...previous, ...state.data.data] : previous
  const missing = draft.hostUserIds.filter((id) => !members.some((member) => member.id === id))
  return (
    <section className="panel" aria-labelledby="hosts-heading">
      <h2 id="hosts-heading">{t('Hosts')}</h2>
      <label htmlFor="schedulingType">{t('Scheduling')}</label>
      <select
        id="schedulingType"
        value={draft.schedulingType}
        onChange={(event) => {
          const mode = event.target.value as EventTypeDraft['schedulingType']
          set('schedulingType', mode)
          set('scheduleId', '')
          if (mode === 'individual') set('hostUserIds', draft.hostUserIds.slice(0, 1))
        }}
      >
        <option value="individual">{t('Individual: one host')}</option>
        <option value="collective">{t('Collective: every selected host is required')}</option>
        <option value="round_robin">{t('Round robin: one available host')}</option>
      </select>
      <p id="hosts-hint">
        {t(
          'Choose one individual host, two to eight collective hosts, or one to eight round-robin pool members. Changes affect new bookings; existing meetings retain their original hosts.',
        )}
      </p>
      {error && (
        <p className="field-error" role="alert">
          {ui(error)}
        </p>
      )}
      {state.status === 'loading' && <p role="status">{t('Loading team members…')}</p>}
      {state.status === 'error' && (
        <div role="alert">
          <p>
            {t('Could not load team members. Only team owners and admins can assign hosts.')}{' '}
            {ui(state.message)}
          </p>
          <button type="button" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      )}
      <fieldset id="hosts" aria-describedby="hosts-hint" aria-invalid={!!error}>
        <legend>
          {t(draft.schedulingType === 'round_robin' ? 'Host pool' : 'Required hosts')}
        </legend>
        {members.map((member) => (
          <label key={member.id} className="checkbox">
            <input
              type="checkbox"
              checked={draft.hostUserIds.includes(member.id)}
              onChange={(event) => {
                set('scheduleId', '')
                set(
                  'hostUserIds',
                  event.target.checked
                    ? draft.schedulingType === 'individual'
                      ? [member.id]
                      : [...draft.hostUserIds, member.id]
                    : draft.hostUserIds.filter((id) => id !== member.id),
                )
              }}
            />
            {member.name.trim() || t('Unnamed team member')}
          </label>
        ))}
        {missing.length > 0 && (
          <>
            <p>
              {t(
                'Some selected hosts are not on the loaded member pages. Load the next page to find them; a host who has left the team must be replaced before saving a host change.',
              )}
            </p>
            {missing.map((id, index) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  set('scheduleId', '')
                  set(
                    'hostUserIds',
                    draft.hostUserIds.filter((value) => value !== id),
                  )
                }}
              >
                {t('Remove selected host {0}', { '0': index + 1 })}
              </button>
            ))}
          </>
        )}
      </fieldset>
      {state.status === 'ready' && state.data.nextAfter && (
        <button
          type="button"
          onClick={() => {
            setPrevious(members)
            setAfter(state.data.nextAfter as string)
          }}
        >
          {t('Load more members')}
        </button>
      )}
    </section>
  )
}
