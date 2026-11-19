import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import type { UiText } from '../i18n/translate.ts'
import { failureMessage, optOutOfMeetingPollReminders, PublicRequestError } from './api.ts'
import { FocusHeading, PublicLayout } from './PublicLayout.tsx'

function fragmentToken(hash: string) {
  return /^#[A-Za-z0-9_-]{43}$/.test(hash) ? hash.slice(1) : null
}

/** Mail opens this page with an opaque fragment. Only the confirmation sends it. */
export function ReminderOptOutPage() {
  const { pathname, search, hash } = useLocation()
  const navigate = useNavigate()
  const [link, setLink] = useState(() => ({ token: fragmentToken(hash), visit: 0 }))
  const read = useRef(hash)
  useEffect(() => {
    if (hash && hash !== read.current) {
      setLink(({ visit }) => ({ token: fragmentToken(hash), visit: visit + 1 }))
    }
    read.current = hash
    if (hash || search) navigate(pathname, { replace: true })
  }, [hash, navigate, pathname, search])

  return (
    <PublicLayout>
      <Confirmation key={link.visit} token={link.token} />
    </PublicLayout>
  )
}

type State = 'ready' | 'saving' | 'done' | 'unavailable'

function Confirmation({ token }: { token: string | null }) {
  const { t, ui } = useI18n()
  const [state, setState] = useState<State>(token ? 'ready' : 'unavailable')
  const [error, setError] = useState<UiText>()
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  usePageTitle('Meeting poll reminders')

  async function confirm() {
    if (!token || request.current) return
    const controller = new AbortController()
    request.current = controller
    setError(undefined)
    setState('saving')
    try {
      await optOutOfMeetingPollReminders(token, controller.signal)
      if (!controller.signal.aborted) setState('done')
    } catch (failure) {
      if (controller.signal.aborted) return
      if (
        failure instanceof PublicRequestError &&
        failure.status === 404 &&
        failure.code === 'poll_not_found'
      ) {
        setState('unavailable')
      } else {
        setState('ready')
        setError(
          failure instanceof PublicRequestError && failure.status === 429
            ? failureMessage(failure)
            : 'We couldn’t stop reminders. Try again.',
        )
      }
    } finally {
      request.current = null
    }
  }

  return (
    <div className="card public-card">
      <FocusHeading key={state === 'saving' ? 'ready' : state}>
        {state === 'done' ? t('Meeting poll reminders turned off') : t('Meeting poll reminders')}
      </FocusHeading>
      {state === 'unavailable' && (
        <p>{t('Open the reminder opt-out link from your meeting poll email.')}</p>
      )}
      {(state === 'ready' || state === 'saving') && (
        <>
          <p>{t('Confirm to stop receiving reminders for this meeting poll.')}</p>
          {error && <p role="alert">{ui(error)}</p>}
          <button
            type="button"
            className="button button-primary"
            onClick={confirm}
            disabled={state === 'saving'}
          >
            {t('Stop reminders')}
          </button>
        </>
      )}
    </div>
  )
}
