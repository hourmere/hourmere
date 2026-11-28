import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { api, type Schemas, unwrap } from '../api/client.ts'
import { RequestError } from '../api/errors.ts'
import { usePageTitle } from '../hooks.ts'
import { formatDuration } from '../i18n/duration.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { DetailList, locationLabel } from './BookingDetails.tsx'
import { PublicLanguageSwitcher } from './PublicLanguageSwitcher.tsx'
import { FocusHeading } from './PublicLayout.tsx'
import { offsetLabel, zoneName } from './time.ts'
import './departure-handoff.css'

type Offer = Schemas['DepartureHandoffParticipantOffer']
type Decision = Schemas['DepartureHandoffParticipantAnswer']['decision']
type OfferState =
  | { kind: 'unavailable' }
  | { kind: 'loading' }
  | { kind: 'ready'; offer: Offer }
  | { kind: 'recorded'; decision: Decision }
  | { kind: 'error'; detail: 'loadError' | 'uncertain' | 'rateLimited' }

const capabilityFragment =
  /^#token=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[A-Za-z0-9_-]{43})$/
const privateRequest = {
  credentials: 'omit',
  cache: 'no-store',
  referrerPolicy: 'no-referrer',
} as const

export function DepartureHandoffOfferPage() {
  const { hash, key, pathname, search, state } = useLocation()
  const navigate = useNavigate()
  const [link, setLink] = useState<{ fragmentKey: string; token: string | null } | null>(null)
  const captured = useRef<string | null>(null)
  const { t } = useI18n()
  usePageTitle('departureHandoff.title')

  // Hold the capability in memory and wait for the router address to be clean before
  // making a private request. A new fragment on this page starts a fresh visit.
  useEffect(() => {
    if (!hash && !search) {
      captured.current = null
      if (link && link.fragmentKey !== state?.fragmentKey) setLink(null)
      return
    }
    if (captured.current === key) return
    captured.current = key
    setLink({ fragmentKey: key, token: capabilityFragment.exec(hash)?.[1] ?? null })
    void navigate({ pathname }, { replace: true, state: { fragmentKey: key } })
  }, [hash, key, link, navigate, pathname, search, state])

  const token = link?.fragmentKey === state?.fragmentKey ? (link?.token ?? null) : null

  return (
    <div className="public">
      <header className="public-language">
        <PublicLanguageSwitcher />
      </header>
      <main id="main" className="public-main user-content">
        <div className="card public-card departure-handoff">
          {hash || search ? (
            <p role="status">{t('Loading…')}</p>
          ) : (
            <OfferVisit key={key} token={token} clearLink={setLink} />
          )}
        </div>
      </main>
    </div>
  )
}

function failureState(error: unknown, submitting = false): OfferState {
  if (error instanceof RequestError) {
    if (error.status === 404 || error.status === 400) return { kind: 'unavailable' }
    if (error.status === 429) return { kind: 'error', detail: 'rateLimited' }
  }
  return { kind: 'error', detail: submitting ? 'uncertain' : 'loadError' }
}

function OfferVisit({
  token,
  clearLink,
}: {
  token: string | null
  clearLink: (link: null) => void
}) {
  const { t } = useI18n()
  const [state, setState] = useState<OfferState>({ kind: token ? 'loading' : 'unavailable' })
  const [attempt, setAttempt] = useState(0)
  const [decision, setDecision] = useState<Decision>()
  const [submitting, setSubmitting] = useState(false)
  const submission = useRef<AbortController | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is incremented on explicit retry.
  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    const { signal } = controller
    // Let a discarded Strict Mode mount cancel before issuing its request.
    void Promise.resolve().then(async () => {
      if (signal.aborted) return
      try {
        const offer = await unwrap(
          api.POST('/api/v1/booking-handoffs/offer', {
            ...privateRequest,
            body: { token },
            signal,
          }),
        )
        if (!signal.aborted) setState({ kind: 'ready', offer })
      } catch (error) {
        if (signal.aborted) return
        const failure = failureState(error)
        if (failure.kind === 'unavailable') clearLink(null)
        setState(failure)
      }
    })
    return () => controller.abort()
  }, [attempt, clearLink, token])

  useEffect(() => () => submission.current?.abort(), [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token || !decision || state.kind !== 'ready' || submission.current) return
    const controller = new AbortController()
    submission.current = controller
    setSubmitting(true)
    try {
      const saved = await unwrap(
        api.POST('/api/v1/booking-handoffs/answer', {
          ...privateRequest,
          body: { token, version: state.offer.version, decision },
          signal: controller.signal,
        }),
      )
      if (controller.signal.aborted) return
      clearLink(null)
      setState({ kind: 'recorded', decision: saved.decision })
    } catch (error) {
      if (controller.signal.aborted) return
      const failure = failureState(error, true)
      if (failure.kind === 'unavailable') clearLink(null)
      setState(failure)
    } finally {
      submission.current = null
      if (!controller.signal.aborted) setSubmitting(false)
    }
  }

  function readAgain() {
    setDecision(undefined)
    setState({ kind: 'loading' })
    setAttempt((previous) => previous + 1)
  }

  switch (state.kind) {
    case 'loading':
      return <p role="status">{t('Loading…')}</p>
    case 'unavailable':
      return (
        <>
          <FocusHeading describedBy="handoff-recovery">
            {t('departureHandoff.unavailable')}
          </FocusHeading>
          <p id="handoff-recovery">{t('departureHandoff.recovery')}</p>
        </>
      )
    case 'error':
      return (
        <>
          <FocusHeading describedBy="handoff-error">{t('departureHandoff.title')}</FocusHeading>
          <p id="handoff-error">{t(`departureHandoff.${state.detail}`)}</p>
          <button type="button" className="button" onClick={readAgain}>
            {t('departureHandoff.readAgain')}
          </button>
        </>
      )
    case 'recorded':
      return (
        <>
          <FocusHeading describedBy="handoff-recorded">
            {t(
              state.decision === 'accept'
                ? 'departureHandoff.accepted'
                : 'departureHandoff.declined',
            )}
          </FocusHeading>
          <p id="handoff-recorded">
            {state.decision === 'accept' ? (
              <>
                {t('departureHandoff.allMustAccept')} {t('departureHandoff.currentUntilComplete')}
              </>
            ) : (
              t('departureHandoff.refused')
            )}
          </p>
        </>
      )
    case 'ready': {
      const { current, proposed, expiresAt, role, answers } = state.offer
      return (
        <>
          <FocusHeading preserveFocus>{t('departureHandoff.title')}</FocusHeading>
          <p>
            {t('departureHandoff.allMustAccept')} {t('departureHandoff.currentUntilComplete')}
          </p>
          <p>{t('departureHandoff.privateLink')}</p>
          <p>
            {t('departureHandoff.deadline')} <HandoffTime at={expiresAt} zone={proposed.timeZone} />
          </p>
          <div className="departure-handoff-terms">
            <BookingTerms heading={t('departureHandoff.current')} terms={current} />
            <BookingTerms heading={t('departureHandoff.proposed')} terms={proposed} />
          </div>
          {role === 'booker' && answers.length > 0 && (
            <section>
              <h2>{t('departureHandoff.answers')}</h2>
              <dl className="departure-handoff-answers">
                {answers.map(({ label, value }, index) => (
                  // Questions may share a label. The terms preserve their fixed order.
                  // biome-ignore lint/suspicious/noArrayIndexKey: read-only immutable list without IDs
                  <div key={index}>
                    <dt>
                      <bdi>{label}</bdi>
                    </dt>
                    <dd>
                      {typeof value === 'boolean' ? (
                        t(value ? 'meetingPoll.yes' : 'meetingPoll.no')
                      ) : Array.isArray(value) ? (
                        <ul>
                          {value.map((answer) => (
                            <li key={answer}>
                              <bdi>{answer}</bdi>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <bdi>{value}</bdi>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          <form method="post" onSubmit={submit}>
            <fieldset disabled={submitting}>
              <legend>{t('departureHandoff.decision')}</legend>
              {(['accept', 'decline'] as const).map((choice) => (
                <label className="choice" key={choice}>
                  <input
                    type="radio"
                    name="handoff-decision"
                    value={choice}
                    checked={decision === choice}
                    onChange={() => setDecision(choice)}
                  />
                  <span>{t(`departureHandoff.${choice}`)}</span>
                </label>
              ))}
            </fieldset>
            <button
              type="submit"
              className="button button-primary"
              disabled={!decision || submitting}
            >
              {t('departureHandoff.submit')}
            </button>
            {submitting && <p role="status">{t('departureHandoff.submitting')}</p>}
          </form>
        </>
      )
    }
  }
}

function HandoffTime({ at, zone }: { at: string; zone: string }) {
  const { formatLocale } = useI18n()
  const date = new Date(at)
  const label = new Intl.DateTimeFormat(formatLocale, {
    timeZone: zone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
  return (
    <time dateTime={at}>
      {label} <bdi dir="ltr">{offsetLabel(zone, date.getTime())}</bdi>
    </time>
  )
}

function BookingTerms({ heading, terms }: { heading: string; terms: Offer['current'] }) {
  const { locale, t, ui } = useI18n()
  const { start, end, timeZone, hostName, location } = terms
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60_000)
  return (
    <section>
      <h2>{heading}</h2>
      <DetailList
        items={[
          [
            'When',
            <div key="when">
              <HandoffTime at={start} zone={timeZone} />
              <br />
              <HandoffTime at={end} zone={timeZone} />
              <br />
              <bdi>{zoneName(timeZone)}</bdi>
            </div>,
          ],
          ['departureHandoff.duration', formatDuration(minutes, locale)],
          ['Host', hostName ? <bdi key="host">{hostName}</bdi> : t('Unknown')],
          [
            'Where',
            <div key="where">
              {ui(locationLabel(location?.kind ?? ''))}
              {location?.kind === 'in_person' && location.address && (
                <div>
                  <bdi>{location.address}</bdi>
                </div>
              )}
            </div>,
          ],
        ]}
      />
    </section>
  )
}
