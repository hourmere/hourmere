import { useCallback, useState } from 'react'
import { api, unwrap } from '../../api/client.ts'
import { useLoad } from '../../hooks.ts'
import type { EventTypeDraft } from './event-type-form.ts'

interface Props {
  draft: EventTypeDraft
  error?: string | undefined
  set: <K extends keyof EventTypeDraft>(name: K, value: EventTypeDraft[K]) => void
}

/** A paged directory, never another person's private schedules or email address. */
export function HostAssignment(props: Props) {
  if (props.draft.schedulingType === 'round_robin')
    return (
      <section className="panel" aria-labelledby="hosts-heading">
        <h2 id="hosts-heading">Hosts</h2>
        <p>
          This legacy scheduling mode can keep its existing configuration while you edit other
          details.
        </p>
      </section>
    )
  return <CurrentHostAssignment {...props} />
}

function CurrentHostAssignment({ draft, error, set }: Props) {
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
  const legacy = draft.schedulingType === 'round_robin'
  return (
    <section className="panel" aria-labelledby="hosts-heading">
      <h2 id="hosts-heading">Hosts</h2>
      {legacy ? (
        <p>
          This legacy scheduling mode can keep its existing configuration while you edit other
          details.
        </p>
      ) : (
        <>
          <label htmlFor="schedulingType">Scheduling</label>
          <select
            id="schedulingType"
            value={draft.schedulingType}
            onChange={(event) => {
              const mode = event.target.value as 'individual' | 'collective'
              set('schedulingType', mode)
              set('scheduleId', '')
              if (mode === 'individual') set('hostUserIds', draft.hostUserIds.slice(0, 1))
            }}
          >
            <option value="individual">Individual: one host</option>
            <option value="collective">Collective: every selected host is required</option>
          </select>
          <p id="hosts-hint">
            Choose one current verified team member, or two to eight for a collective meeting.
            Changing hosts affects new bookings; existing meetings retain their original hosts.
          </p>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {state.status === 'loading' && <p role="status">Loading team members…</p>}
          {state.status === 'error' && (
            <div role="alert">
              <p>
                Could not load team members. Only team owners and admins can assign hosts.{' '}
                {state.message}
              </p>
              <button type="button" onClick={reload}>
                Try again
              </button>
            </div>
          )}
          <fieldset id="hosts" aria-describedby="hosts-hint" aria-invalid={!!error}>
            <legend>Required hosts</legend>
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
                {member.name.trim() || 'Unnamed team member'}
              </label>
            ))}
            {draft.hostUserIds.some((id) => !members.some((member) => member.id === id)) && (
              <p>
                Some selected hosts are not on the loaded member pages. Load the next page to find
                them; a host who has left the team must be replaced before saving a host change.
              </p>
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
              Load more members
            </button>
          )}
        </>
      )}
    </section>
  )
}
