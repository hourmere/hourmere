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
import { validDefault } from '../availability/valid-default.ts'

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
  const { t, ui, locale } = useI18n()
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<UiText | null>(null)
  const [calendarSkipped, skipCalendar] = useRememberedFlag(me.user.id, 'calendar-skipped')
  const [completionDismissed, dismissCompletion] = useRememberedFlag(
    me.user.id,
    'completion-dismissed',
  )
  const [inactiveDismissed, dismissInactive] = useRememberedFlag(me.user.id, 'inactive-dismissed')
  const submitting = useRef(false)
  const mounted = useMounted()
  const profileDone = profile !== null && me.user.name.trim().length > 0
  const availabilityDone = schedules.some(validDefault)
  const personalEvents = eventTypes.filter((event) => event.ownerUserId === me.user.id)
  const activeEvent = personalEvents.find((event) => event.isActive)
  const firstEvent = personalEvents[0]
  const eventDone = personalEvents.length > 0
  const url =
    profile && activeEvent && availabilityDone
      ? publicPageUrl(profile.handle, activeEvent.slug)
      : null
  // The link is ready from current booking data; viewing/copying needs no stored task flag.
  // An empty display name still needs attention, but the public page can use the username.
  const shareDone = url !== null
  const currentStep = [profileDone, availabilityDone, eventDone, shareDone].indexOf(false)

  if (!me.organization.personal) return null
  if (profileDone && availabilityDone && firstEvent && !activeEvent) {
    return inactiveDismissed ? null : (
      <aside className="alert alert-info" aria-label={t('No active event type')}>
        <p>
          {t('You have no active event type. Activate one when you are ready to accept bookings.')}
        </p>
        <div className="form-actions">
          <Link to={eventTypePath(firstEvent.id)}>{t('Review event type')}</Link>
          <button type="button" className="button button-small" onClick={dismissInactive}>
            {t('Dismiss')}
          </button>
        </div>
      </aside>
    )
  }
  if (currentStep === -1) {
    return completionDismissed ? null : (
      <section className="panel setup-guide" aria-labelledby="personal-setup-complete-heading">
        <h2 id="personal-setup-complete-heading">{t('Your booking page is ready')}</h2>
        <p>
          {t('Open your booking page to check the available times, then copy its link to share.')}
        </p>
        {url && <BookingShareActions url={url} />}
        <button type="button" className="button button-small" onClick={dismissCompletion}>
          {t('Dismiss')}
        </button>
      </section>
    )
  }

  async function confirmAvailability() {
    if (submitting.current) return
    submitting.current = true
    setSaving(true)
    setFailure(null)
    try {
      await unwrap(
        api.POST('/api/v1/schedules/default', {
          body: { language: locale === 'zh-CN' ? 'zh-CN' : 'en' },
        }),
      )
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
        <SetupStep title={t('Profile')} done={profileDone} current={currentStep === 0}>
          {profileDone ? (
            <p>{t('Your display name and booking address are set.')}</p>
          ) : (
            <>
              <p>{t('Choose your display name, handle and time zone in Settings.')}</p>
              {!me.user.name.trim() && (
                <p>
                  {t(
                    'Without a display name, your booking page, emails and calendar invitations show your handle instead.',
                  )}
                </p>
              )}
              <Link to={PATHS.settings}>{t('Complete your profile')}</Link>
            </>
          )}
        </SetupStep>
        <SetupStep
          title={t('Default availability')}
          done={availabilityDone}
          current={currentStep === 1}
        >
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
        <SetupStep title={t('First event type')} done={eventDone} current={currentStep === 2}>
          <p>{t('An event type sets the meeting length and gives invitees a booking link.')}</p>
          {personalEvents.length === 0 && (
            <Link to={PATHS.newEventType} className="button">
              {t('Create your first event type')}
            </Link>
          )}
        </SetupStep>
        <SetupStep title={t('View and share')} done={shareDone} current={currentStep === 3}>
          <p>
            {t('Open your booking page to check the available times, then copy its link to share.')}
          </p>
          {url ? (
            <BookingShareActions url={url} />
          ) : !activeEvent && personalEvents[0] ? (
            <Link to={eventTypePath(personalEvents[0].id)}>
              {t('Activate your first event type')}
            </Link>
          ) : (
            <p className="hint">
              {t(
                'Your link will appear after you set up a profile, valid default availability and an active event type.',
              )}
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
              <button type="button" className="button button-small" onClick={skipCalendar}>
                {t('Skip for now')}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

function BookingShareActions({ url }: { url: string }) {
  const { t } = useI18n()
  return (
    <>
      <p className="mono user-content">{url}</p>
      <div className="form-actions">
        <a href={url} target="_blank" rel="noreferrer">
          {t('View booking page')}
          <span className="visually-hidden"> {t('(opens in a new tab)')}</span>
        </a>
        <CopyButton text={url} label={t('Copy booking link')} />
      </div>
    </>
  )
}

/** Local browser preferences are optional and isolated to the signed-in person. */
function useRememberedFlag(userId: string, preference: string) {
  const key = `hourmere-personal-setup:${userId}:${preference}`
  function read() {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  }
  const [saved, setSaved] = useState(() => ({ key, value: read() }))
  const value = saved.key === key ? saved.value : read()
  function remember() {
    setSaved({ key, value: true })
    try {
      localStorage.setItem(key, '1')
    } catch {
      // Keep the choice for this visit when browser storage is unavailable.
    }
  }
  return [value, remember] as const
}

function SetupStep({
  title,
  done,
  current,
  children,
}: {
  title: string
  done: boolean
  current: boolean
  children: ReactNode
}) {
  const { t } = useI18n()
  return (
    <li aria-current={current ? 'step' : undefined}>
      <div className="setup-step-heading">
        <h3>{title}</h3>
        <span className={done ? 'badge badge-success' : 'badge'}>
          {done ? t('Complete') : current ? t('Next step') : t('To do')}
        </span>
      </div>
      {children}
    </li>
  )
}
