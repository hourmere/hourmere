import { type ReactNode, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api, unwrap } from '../../api/client.ts'
import { errorMessage } from '../../api/errors.ts'
import type { EventType, Profile, Schedule } from '../../api/resources.ts'
import { CopyButton } from '../../components/CopyButton.tsx'
import { useMounted } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { UiText } from '../../i18n/translate.ts'
import { eventTypePath, PATHS, publicPageUrl } from '../../paths.ts'
import type { Me } from '../../session.tsx'
import { draftFromSchedule, validateSchedule, WEEKDAYS } from '../availability/weekly-hours.ts'

/** A default with usable weekly hours, rather than merely any schedule on the account. */
function validDefault(schedule: Schedule): boolean {
  if (!schedule.isDefault) return false
  try {
    const hours = schedule.weeklyHours
    if (Object.keys(hours).some((day) => !WEEKDAYS.some((weekday) => weekday.day === day)))
      return false
    // The editor uses 00:00 for end-of-day; the API must store that as 24:00.
    if (Object.values(hours).some((intervals) => intervals.some((hour) => hour.end === '00:00')))
      return false
    const draft = draftFromSchedule(schedule)
    return (
      Object.keys(validateSchedule(draft)).length === 0 &&
      Object.values(hours).some((intervals) => intervals.length > 0)
    )
  } catch {
    return false
  }
}

/** Derived from personal account data; no completed-task records or required calendar grant. */
export function PersonalSetupGuide({
  me,
  profile,
  schedules,
  eventTypes,
  reload,
}: {
  me: Me
  profile: Profile | null
  schedules: Schedule[]
  eventTypes: EventType[]
  reload: () => void
}) {
  const { t, ui } = useI18n()
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<UiText | null>(null)
  const [calendarSkipped, setCalendarSkipped] = useState(false)
  const submitting = useRef(false)
  const mounted = useMounted()
  const profileDone = profile !== null && me.user.name.trim().length > 0
  const availabilityDone = schedules.some(validDefault)
  const personalEvents = eventTypes.filter((event) => event.ownerUserId === me.user.id)
  const activeEvent = personalEvents.find((event) => event.isActive)
  const shareDone = profileDone && availabilityDone && activeEvent !== undefined
  const url = profile && activeEvent ? publicPageUrl(profile.handle, activeEvent.slug) : null

  if (!me.organization.personal || shareDone) return null

  async function confirmAvailability() {
    if (submitting.current) return
    submitting.current = true
    setSaving(true)
    setFailure(null)
    try {
      await unwrap(api.POST('/api/v1/schedules/default', { body: {} }))
      if (mounted.current) reload()
    } catch (error) {
      if (mounted.current) setFailure(errorMessage(error))
    } finally {
      submitting.current = false
      if (mounted.current) setSaving(false)
    }
  }

  return (
    <section className="panel setup-guide" aria-labelledby="personal-setup-heading">
      <h2 id="personal-setup-heading">{t('Set up your booking page')}</h2>
      <p>{t('Complete these steps at your own pace. You can keep using the app as you go.')}</p>
      <ol className="setup-steps">
        <SetupStep title={t('Profile')} done={profileDone}>
          {profileDone ? (
            <p>{t('Your display name and booking address are set.')}</p>
          ) : (
            <>
              <p>{t('Choose your display name, booking username and time zone in Settings.')}</p>
              {!me.user.name.trim() && (
                <p>
                  {t(
                    'Without a display name, your booking page, emails and calendar invitations show your username instead.',
                  )}
                </p>
              )}
              <Link to={PATHS.settings}>{t('Complete your profile')}</Link>
            </>
          )}
        </SetupStep>
        <SetupStep title={t('Default availability')} done={availabilityDone}>
          {availabilityDone ? (
            <p>{t('Your default schedule has weekly hours ready for bookings.')}</p>
          ) : schedules.length === 0 ? (
            <>
              <p>
                {t('Start with Monday–Friday, 09:00–17:00 in your profile time zone: {0}.', {
                  '0': profile?.timeZone ?? t('not set'),
                })}
              </p>
              {!profileDone && <p>{t('Complete your profile before confirming these hours.')}</p>}
              <button
                type="button"
                className="button button-small"
                disabled={!profileDone || saving}
                onClick={() => void confirmAvailability()}
              >
                {saving ? t('Saving…') : t('Use Monday–Friday, 09:00–17:00')}
              </button>
              <p className="hint">{t('You can change these hours later in Availability.')}</p>
            </>
          ) : (
            <>
              <p>
                {t(
                  'Choose a default schedule with valid weekly hours. Other schedules do not complete this step.',
                )}
              </p>
              <Link to={PATHS.availability}>{t('Review default availability')}</Link>
            </>
          )}
          {failure && !availabilityDone && (
            <div className="alert alert-error" role="alert">
              <p>
                {t('Could not confirm your default availability.')} {ui(failure)}
              </p>
              <button type="button" className="button button-small" onClick={reload}>
                {t('Refresh setup status')}
              </button>
            </div>
          )}
        </SetupStep>
        <SetupStep title={t('First event type')} done={personalEvents.length > 0}>
          <p>{t('An event type sets the meeting length and gives invitees a booking link.')}</p>
          {personalEvents.length === 0 && (
            <Link to={PATHS.newEventType} className="button">
              {t('Create your first event type')}
            </Link>
          )}
        </SetupStep>
        <SetupStep title={t('View and share')} done={shareDone}>
          <p>
            {t('Open your booking page to check the available times, then copy its link to share.')}
          </p>
          {url ? (
            <div className="form-actions">
              <a href={url} target="_blank" rel="noreferrer">
                {t('View booking page')}
                <span className="visually-hidden"> {t('(opens in a new tab)')}</span>
              </a>
              <CopyButton text={url} label={t('Copy booking link')} />
            </div>
          ) : !activeEvent && personalEvents[0] ? (
            <Link to={eventTypePath(personalEvents[0].id)}>
              {t('Activate your first event type')}
            </Link>
          ) : (
            <p className="hint">
              {t('Your link will appear after you create an active event type and a profile.')}
            </p>
          )}
        </SetupStep>
      </ol>
      <div className="setup-calendar">
        <h3>{t('Calendar connection (optional)')}</h3>
        {calendarSkipped ? (
          <p role="status">{t('Skipped for now. You can connect a calendar later.')}</p>
        ) : (
          <>
            <p>{t('You can take bookings without connecting an external calendar.')}</p>
            <div className="form-actions">
              <Link to={PATHS.calendars}>{t('Connect a calendar')}</Link>
              <button
                type="button"
                className="button button-small"
                onClick={() => setCalendarSkipped(true)}
              >
                {t('Skip for now')}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

function SetupStep({
  title,
  done,
  children,
}: {
  title: string
  done: boolean
  children: ReactNode
}) {
  const { t } = useI18n()
  return (
    <li>
      <div className="setup-step-heading">
        <h3>{title}</h3>
        <span className={done ? 'badge badge-success' : 'badge'}>
          {done ? t('Complete') : t('Missing')}
        </span>
      </div>
      {children}
    </li>
  )
}
