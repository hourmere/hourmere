import { useId } from 'react'
import { CopyButton } from '../components/CopyButton.tsx'
import { type CalendarEvent, googleCalendarUrl, icsDataUrl, outlookCalendarUrl } from './ics.ts'

/** Download an .ics file, or open the event in Google Calendar or Outlook. Nothing secret in any. */
export function AddToCalendar({ event }: { event: CalendarEvent }) {
  const headingId = useId()
  return (
    <section className="add-to-calendar" aria-labelledby={headingId}>
      <h2 id={headingId}>Add to your calendar</h2>
      <ul className="calendar-links">
        <li>
          <a className="button button-small" href={icsDataUrl(event)} download="booking.ics">
            Download .ics file
          </a>
        </li>
        <li>
          <a
            className="button button-small"
            href={googleCalendarUrl(event)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Google Calendar
          </a>
        </li>
        <li>
          <a
            className="button button-small"
            href={outlookCalendarUrl(event)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Outlook
          </a>
        </li>
      </ul>
    </section>
  )
}

/**
 * The invitee's manage link, shown once: the token exists only in this page's memory (the
 * API returns it once and stores only its hash), never in the address bar or in storage.
 */
export function ManageLink({ token, intro }: { token: string; intro: string }) {
  const headingId = useId()
  const inputId = useId()
  const url = `${window.location.origin}/booking#token=${encodeURIComponent(token)}`
  return (
    <section className="panel manage-link" aria-labelledby={headingId}>
      <h2 id={headingId}>Save your link to change or cancel</h2>
      <p>
        {intro} It is shown only this once on this page, and anyone who has it can change your
        booking, so keep it private.
      </p>
      <label htmlFor={inputId} className="visually-hidden">
        Your link to change or cancel this booking
      </label>
      <div className="secret">
        <input id={inputId} readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <CopyButton text={url} label="Copy link" />
      </div>
    </section>
  )
}
