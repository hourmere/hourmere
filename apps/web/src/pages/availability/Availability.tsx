import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { api, unwrap } from '../../api/client.ts'
import { errorMessage } from '../../api/errors.ts'
import { loadSchedules, type Schedule } from '../../api/resources.ts'
import { useFlash } from '../../flash.ts'
import { useLoad, usePageTitle } from '../../hooks.ts'
import { PATHS, schedulePath } from '../../paths.ts'
import { summarize } from './weekly-hours.ts'

export function AvailabilityPage() {
  usePageTitle('Availability')
  const [state, reload] = useLoad(loadSchedules)
  const message = useFlash()
  const [status, setStatus] = useState('')

  return (
    <>
      <div className="page-header">
        <h1>Availability</h1>
        <Link to={PATHS.newSchedule} className="button button-primary">
          New schedule
        </Link>
      </div>
      <p className="lede">
        Schedules are the weekly hours people can book you in. Event types use your default schedule
        unless you choose another one for them.
      </p>
      <p className="flash" role="status">
        {status || message}
      </p>

      {state.status === 'loading' && <p role="status">Loading schedules…</p>}
      {state.status === 'error' && (
        <div className="alert alert-error" role="alert">
          <p>Could not load your schedules. {state.message}</p>
          <button type="button" className="button button-small" onClick={reload}>
            Try again
          </button>
        </div>
      )}
      {state.status === 'ready' &&
        (state.data.length === 0 ? (
          <div className="empty">
            <p>
              You have no schedule yet, so your event types offer no times. Start with your working
              hours; you can change them any time.
            </p>
            <p>
              <Link to={PATHS.newSchedule}>Set your weekly hours</Link>
            </p>
          </div>
        ) : (
          <section aria-labelledby="schedules-heading">
            <h2 id="schedules-heading" className="visually-hidden">
              Your schedules
            </h2>
            <ul className="card-list">
              {state.data.map((schedule) => (
                <li key={schedule.id} className="card-item">
                  <ScheduleCard
                    schedule={schedule}
                    onDefault={() => {
                      setStatus(`“${schedule.name}” is now your default schedule.`)
                      reload()
                    }}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
    </>
  )
}

function ScheduleCard({ schedule, onDefault }: { schedule: Schedule; onDefault: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const edit = useRef<HTMLAnchorElement>(null)

  async function makeDefault() {
    setBusy(true)
    setError(null)
    try {
      await unwrap(
        api.PATCH('/api/v1/schedules/{id}', {
          params: { path: { id: schedule.id } },
          body: { isDefault: true },
        }),
      )
      onDefault()
      // The button goes away; keep focus in this card.
      edit.current?.focus()
    } catch (err) {
      setError(`Could not make it the default. ${errorMessage(err)}`)
    }
    setBusy(false)
  }

  return (
    <>
      <div className="card-main">
        <h3 className="card-title">
          <Link to={schedulePath(schedule.id)}>{schedule.name}</Link>
          {schedule.isDefault && <span className="badge badge-success">Default</span>}
        </h3>
        <p className="muted">{schedule.timeZone.replaceAll('_', ' ')}</p>
        <p>{summarize(schedule.weeklyHours)}</p>
      </div>
      <div className="card-actions">
        {!schedule.isDefault && (
          <button
            type="button"
            className="button button-small"
            onClick={makeDefault}
            disabled={busy}
            aria-label={`Make default: ${schedule.name}`}
          >
            {busy ? 'Saving…' : 'Make default'}
          </button>
        )}
        <Link
          ref={edit}
          to={schedulePath(schedule.id)}
          className="button button-small"
          aria-label={`Edit ${schedule.name}`}
        >
          Edit
        </Link>
      </div>
      {error && (
        <p className="alert alert-error card-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
