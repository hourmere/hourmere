import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { api, type Schemas, unwrap } from '../api/client.ts'
import { RequestError } from '../api/errors.ts'
import { usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import type { MessageKey } from '../i18n/translate.ts'
import { availableTimeZones, detectTimeZone } from './env.ts'
import { FocusHeading, PublicLayout } from './PublicLayout.tsx'
import { type Answer, answerError } from './validation.ts'
import { rememberVisitorTimeZone, visitorTimeZone } from './visitor-time-zone.ts'
import './meeting-poll.css'

type Poll = Schemas['PublicMeetingPoll']
type Ballot = NonNullable<Schemas['MeetingPollOwnBallot']>
type Vote = Ballot['votes'][number]['value']
type Entry = 'public' | 'voter' | 'recover' | 'optOut'
const choices = ['yes', 'if_need_be', 'no'] as const
const choiceKeys = {
  yes: 'meetingPoll.yes',
  if_need_be: 'meetingPoll.ifNeedBe',
  no: 'meetingPoll.no',
} as const

/** Both ends include a date and offset: fall-back hours and midnight are unambiguous. */
export function pollInstantLabel(instant: string, timeZone: string, locale?: string) {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'longOffset',
  }).format(new Date(instant))
}

/** Mail capabilities enter only through a fragment and remain only in page memory. */
export function MeetingPollPage({ entry = 'public' }: { entry?: Entry }) {
  // Changing entry routes starts a new capability lifetime, even without a fragment.
  return <PollEntry key={entry} entry={entry} />
}

function PollEntry({ entry }: { entry: Entry }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [link, setLink] = useState(() => ({ token: location.hash.slice(1), visit: 0 }))
  const seen = useRef<string | null>(location.hash)
  useEffect(() => {
    if (!location.hash) {
      seen.current = null
      return
    }
    if (location.hash !== seen.current) {
      setLink((current) => ({ token: location.hash.slice(1), visit: current.visit + 1 }))
    }
    seen.current = location.hash
    navigate({ pathname: location.pathname }, { replace: true })
  }, [location.hash, location.pathname, navigate])
  return (
    <PollVisit
      key={`${entry}:${link.visit}:${link.token}`}
      entry={entry}
      initialToken={link.token}
    />
  )
}

function PollVisit({ entry, initialToken }: { entry: Entry; initialToken: string }) {
  const { t, locale, formatLocale } = useI18n()
  usePageTitle('meetingPoll.title')
  const [token, setToken] = useState(initialToken)
  const [poll, setPoll] = useState<Poll | null>(null)
  const [loading, setLoading] = useState(entry !== 'optOut' && entry !== 'recover' && !!token)
  const [unavailable, setUnavailable] = useState(!token && entry !== 'recover')
  const [error, setError] = useState<MessageKey | null>(null)
  const [notice, setNotice] = useState<MessageKey | null>(null)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const alive = useRef(true)
  const [reload, setReload] = useState(0)
  const [blocked, setBlocked] = useState(false)
  const [recovery, setRecovery] = useState(entry === 'recover')
  const [checkEmail, setCheckEmail] = useState(false)
  const [optedOut, setOptedOut] = useState(false)
  const [pollId, setPollId] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [zone, setZone] = useState(() => visitorTimeZone(detectTimeZone()))
  const [votes, setVotes] = useState<Record<string, Vote>>({})
  const [responses, setResponses] = useState<Record<string, Answer>>({})
  const [consent, setConsent] = useState(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  function acceptBallot(ballot: Ballot | null) {
    setVotes(Object.fromEntries(ballot?.votes.map((vote) => [vote.slotId, vote.value]) ?? []))
    setResponses((ballot?.responses ?? {}) as Record<string, Answer>)
    setConsent(!!ballot?.consentedAt)
    if (ballot) setName(ballot.voter.name)
  }

  // Reload is explicit after uncertain writes: never automatically repeat a submission.
  // biome-ignore lint/correctness/useExhaustiveDependencies: acceptBallot only uses state setters; reload is an explicit refresh.
  useEffect(() => {
    if (!token || entry === 'optOut' || entry === 'recover') return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    unwrap(
      api.POST('/api/v1/public/meeting-polls/read', {
        body: { token },
        signal: controller.signal,
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      }),
    ).then(
      (data) => {
        if (controller.signal.aborted) return
        setPoll(data)
        setPollId(data.id)
        acceptBallot(data.ownBallot)
        setNotice(data.ownBallot?.submittedAt ? 'meetingPoll.saved' : null)
        setUnavailable(false)
        setBlocked(false)
        setLoading(false)
      },
      (err: unknown) => {
        if (controller.signal.aborted) return
        setPoll(null)
        setLoading(false)
        if (err instanceof RequestError && err.status === 404) setUnavailable(true)
        else
          setError(
            err instanceof RequestError && err.status === 429
              ? 'meetingPoll.rateLimited'
              : 'meetingPoll.loadError',
          )
      },
    )
    return () => controller.abort()
  }, [token, entry, reload])

  async function perform(action: () => Promise<void>, ballotWrite = false) {
    if (lock.current || (ballotWrite && blocked)) return
    lock.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (err) {
      if (!alive.current) return
      if (err instanceof RequestError && err.status === 404) {
        setUnavailable(true)
        setPoll(null)
      } else if (err instanceof RequestError && err.status === 429)
        setError('meetingPoll.rateLimited')
      else if (err instanceof RequestError && err.code === 'poll_full') setError('meetingPoll.full')
      else if (err instanceof RequestError && err.code === 'poll_changed') {
        setError('meetingPoll.stale')
        setBlocked(true)
      } else if (
        err instanceof RequestError &&
        (err.code === 'poll_closed' || err.code === 'poll_canceled')
      ) {
        setError('meetingPoll.closed')
        setBlocked(true)
      } else if (err instanceof RequestError && err.status === 400) setError('meetingPoll.invalid')
      else {
        setError(ballotWrite ? 'meetingPoll.uncertain' : 'meetingPoll.loadError')
        if (ballotWrite) setBlocked(true)
      }
    } finally {
      lock.current = false
      if (alive.current) setBusy(false)
    }
  }

  const own = poll?.ownBallot
  const readOnly = poll?.readOnly || poll?.status !== 'open'
  const verified = own?.voter.status === 'verified' || own?.voter.status === 'withdrawn'
  const canVote = !!own && verified && !readOnly
  const needsVerification = entry === 'voter' && !verified && !readOnly
  const zones = [...new Set([zone, ...availableTimeZones()])].sort()
  const label = (instant: string) => pollInstantLabel(instant, zone, formatLocale)
  const zonePicker = (
    <label className="poll-field">
      <span>{t('meetingPoll.timeZone')}</span>
      <select
        value={zone}
        onChange={(event) => {
          setNotice(null)
          setZone(event.target.value)
          rememberVisitorTimeZone(event.target.value)
        }}
        disabled={busy}
      >
        {zones.map((value) => (
          <option key={value} value={value}>
            {value.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
    </label>
  )

  function submitBallot(event: FormEvent) {
    event.preventDefault()
    if (!poll || !own || !canVote) return
    if (
      !consent ||
      poll.candidates.some((slot) => !votes[slot.id]) ||
      poll.questions.some((question) => answerError(question, responses[question.id]))
    ) {
      setError('meetingPoll.invalid')
      return
    }
    const changed = !!own.submittedAt
    void perform(async () => {
      const ballot = await unwrap(
        api.POST('/api/v1/public/meeting-polls/vote', {
          body: {
            token,
            votes: poll.candidates.map((slot) => ({
              slotId: slot.id,
              value: votes[slot.id] as Vote,
            })),
            consent: true,
            responses,
            name,
            timeZone: zone,
            locale,
            expectedBallotRevision: own.ballotRevision,
          },
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        }),
      )
      if (!alive.current) return
      setPoll({ ...poll, ownBallot: ballot, counts: null })
      acceptBallot(ballot)
      setNotice(changed ? 'meetingPoll.changed' : 'meetingPoll.saved')
    }, true)
  }

  return (
    <PublicLayout>
      <div
        className="card public-card meeting-poll"
        aria-busy={busy || loading}
        data-poll-state={
          loading
            ? 'loading'
            : unavailable
              ? 'unavailable'
              : checkEmail
                ? 'check-email'
                : recovery
                  ? 'recover'
                  : optedOut
                    ? 'opted-out'
                    : entry === 'optOut'
                      ? 'opt-out'
                      : error
                        ? 'error'
                        : readOnly
                          ? 'closed'
                          : needsVerification
                            ? 'verify'
                            : own?.voter.status === 'withdrawn'
                              ? 'withdrawn'
                              : notice === 'meetingPoll.saved' || notice === 'meetingPoll.changed'
                                ? 'saved'
                                : own
                                  ? 'ballot'
                                  : 'enroll'
        }
      >
        <FocusHeading>
          {poll?.title ?? t(entry === 'optOut' ? 'meetingPoll.optOutTitle' : 'meetingPoll.title')}
        </FocusHeading>
        {loading ? (
          <p role="status">{t('meetingPoll.loading')}</p>
        ) : unavailable ? (
          <>
            <p>{t('meetingPoll.unavailable')}</p>
            <p>{t('meetingPoll.unavailableHelp')}</p>
          </>
        ) : (
          <>
            {error && <p role="alert">{t(error)}</p>}
            <p role="status" aria-live="polite">
              {busy ? t('meetingPoll.saving') : notice ? t(notice) : ''}
            </p>
            {(blocked || (own?.voter.status === 'verified' && !readOnly)) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setNotice(null)
                  setReload((value) => value + 1)
                }}
              >
                {t('meetingPoll.reload')}
              </button>
            )}
            {!poll && !recovery && entry !== 'optOut' && error && (
              <button type="button" onClick={() => setReload((value) => value + 1)}>
                {t('meetingPoll.retry')}
              </button>
            )}
            {checkEmail ? (
              <>
                <FocusHeading level={2}>{t('meetingPoll.checkEmail')}</FocusHeading>
                <p>{t('meetingPoll.checkEmailHelp')}</p>
              </>
            ) : recovery ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void perform(async () => {
                    await unwrap(
                      api.POST('/api/v1/public/meeting-polls/recover', {
                        body: { pollId, email },
                        cache: 'no-store',
                        referrerPolicy: 'no-referrer',
                      }),
                    )
                    if (alive.current) setCheckEmail(true)
                  })
                }}
              >
                <h2>{t('meetingPoll.recover')}</h2>
                <label className="poll-field">
                  <span>{t('meetingPoll.pollId')}</span>
                  <input
                    required
                    maxLength={100}
                    value={pollId}
                    onChange={(event) => setPollId(event.target.value)}
                  />
                </label>
                <label className="poll-field">
                  <span>{t('meetingPoll.email')}</span>
                  <input
                    required
                    type="email"
                    autoComplete="email"
                    maxLength={320}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
                <button disabled={busy} type="submit">
                  {t('meetingPoll.recoverSubmit')}
                </button>
              </form>
            ) : entry === 'optOut' ? (
              optedOut ? (
                <p role="status">{t('meetingPoll.optedOut')}</p>
              ) : (
                <>
                  <p>{t('meetingPoll.optOutHelp')}</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await unwrap(
                          api.POST('/api/v1/public/meeting-polls/reminder-opt-out', {
                            body: { token },
                            cache: 'no-store',
                            referrerPolicy: 'no-referrer',
                          }),
                        )
                        if (alive.current) setOptedOut(true)
                      })
                    }
                  >
                    {t('meetingPoll.optOut')}
                  </button>
                </>
              )
            ) : (
              poll && (
                <>
                  <p>
                    {t(
                      poll.visibility === 'aggregate'
                        ? 'meetingPoll.aggregate'
                        : 'meetingPoll.private',
                    )}
                  </p>
                  <p>{t('meetingPoll.deadline', { date: label(poll.deadlineAt) })}</p>
                  {zonePicker}
                  {readOnly && (
                    <p role="status">
                      {t(
                        poll.status === 'scheduled'
                          ? 'meetingPoll.scheduled'
                          : poll.status === 'canceled'
                            ? 'meetingPoll.canceled'
                            : 'meetingPoll.closed',
                      )}
                    </p>
                  )}
                  {own?.voter.status === 'withdrawn' && (
                    <p role="status">{t('meetingPoll.withdrawn')}</p>
                  )}
                  <p>
                    {t(
                      new Intl.PluralRules(locale).select(poll.candidates.length) === 'one'
                        ? 'meetingPoll.optionsOne'
                        : 'meetingPoll.optionsOther',
                      { count: poll.candidates.length },
                    )}
                  </p>
                  <form onSubmit={submitBallot}>
                    {poll.candidates.map((slot) => {
                      const count =
                        poll.visibility === 'aggregate' && own?.voter.status === 'verified'
                          ? poll.counts?.find((item) => item.slotId === slot.id)
                          : undefined
                      return (
                        <fieldset
                          key={slot.id}
                          className="poll-option"
                          disabled={!canVote || busy || blocked}
                        >
                          <legend>
                            {label(slot.startAt)} – {label(slot.endAt)}
                          </legend>
                          {poll.chosenSlotId === slot.id && <p>{t('meetingPoll.chosen')}</p>}
                          <div className="poll-choices">
                            {choices.map((value) => (
                              <label key={value}>
                                <input
                                  type="radio"
                                  name={`slot-${slot.id}`}
                                  value={value}
                                  required
                                  checked={votes[slot.id] === value}
                                  onChange={() => {
                                    setNotice(null)
                                    setVotes((current) => ({ ...current, [slot.id]: value }))
                                  }}
                                />
                                {t(choiceKeys[value])}
                              </label>
                            ))}
                          </div>
                          {count && (
                            <p className="poll-counts">
                              {t('meetingPoll.countYes', { count: count.yes })} ·{' '}
                              {t('meetingPoll.countIfNeedBe', { count: count.ifNeedBe })} ·{' '}
                              {t('meetingPoll.countNo', { count: count.no })}
                            </p>
                          )}
                        </fieldset>
                      )
                    })}
                    {own && verified && (
                      <fieldset
                        className="poll-ballot-fields"
                        disabled={!canVote || busy || blocked}
                      >
                        <label className="poll-field">
                          <span>{t('meetingPoll.name')}</span>
                          <input
                            required
                            maxLength={200}
                            autoComplete="name"
                            value={name}
                            onChange={(event) => {
                              setNotice(null)
                              setName(event.target.value)
                            }}
                          />
                        </label>
                        {poll.questions.map((question) => (
                          <PollQuestion
                            key={question.id}
                            question={question}
                            value={responses[question.id]}
                            onChange={(value) => {
                              setNotice(null)
                              setResponses((current) => ({ ...current, [question.id]: value }))
                            }}
                          />
                        ))}
                        <p>{t('meetingPoll.selectionHelp')}</p>
                        <label className="poll-consent">
                          <input
                            type="checkbox"
                            required
                            checked={consent}
                            onChange={(event) => {
                              setNotice(null)
                              setConsent(event.target.checked)
                            }}
                          />
                          {t('meetingPoll.consent')}
                        </label>
                        {canVote && (
                          <button type="submit">
                            {t(
                              own.voter.status === 'withdrawn'
                                ? 'meetingPoll.reactivate'
                                : 'meetingPoll.save',
                            )}
                          </button>
                        )}
                      </fieldset>
                    )}
                  </form>
                  {own && !readOnly && own.voter.status !== 'withdrawn' && (
                    <button
                      type="button"
                      disabled={busy || blocked}
                      onClick={() =>
                        void perform(async () => {
                          const ballot = await unwrap(
                            api.POST('/api/v1/public/meeting-polls/withdraw', {
                              body: { token, expectedBallotRevision: own.ballotRevision },
                              cache: 'no-store',
                              referrerPolicy: 'no-referrer',
                            }),
                          )
                          if (!alive.current) return
                          setPoll({ ...poll, ownBallot: ballot, counts: null })
                          acceptBallot(ballot)
                          setNotice(null)
                        }, true)
                      }
                    >
                      {t('meetingPoll.withdraw')}
                    </button>
                  )}
                  {needsVerification && (
                    <>
                      <p>{t('meetingPoll.verifyHelp')}</p>
                      <button
                        type="button"
                        disabled={busy || blocked}
                        onClick={() =>
                          void perform(async () => {
                            const result = await unwrap(
                              api.POST('/api/v1/public/meeting-polls/verify', {
                                body: { token },
                                cache: 'no-store',
                                referrerPolicy: 'no-referrer',
                              }),
                            )
                            if (!alive.current) return
                            if (result.votingToken) setToken(result.votingToken)
                            else setReload((value) => value + 1)
                          }, true)
                        }
                      >
                        {t('meetingPoll.verify')}
                      </button>
                    </>
                  )}
                  {!own &&
                    entry === 'public' &&
                    !readOnly &&
                    poll.admissionMode === 'public_link' && (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault()
                          void perform(async () => {
                            await unwrap(
                              api.POST('/api/v1/public/meeting-polls/enroll', {
                                body: { publicToken: token, name, email, timeZone: zone, locale },
                                cache: 'no-store',
                                referrerPolicy: 'no-referrer',
                              }),
                            )
                            if (alive.current) setCheckEmail(true)
                          })
                        }}
                      >
                        <label className="poll-field">
                          <span>{t('meetingPoll.name')}</span>
                          <input
                            required
                            autoComplete="name"
                            maxLength={200}
                            value={name}
                            onChange={(event) => {
                              setNotice(null)
                              setName(event.target.value)
                            }}
                          />
                        </label>
                        <label className="poll-field">
                          <span>{t('meetingPoll.email')}</span>
                          <input
                            required
                            type="email"
                            autoComplete="email"
                            maxLength={320}
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                          />
                        </label>
                        <button type="submit" disabled={busy}>
                          {t('meetingPoll.enroll')}
                        </button>
                      </form>
                    )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setError(null)
                      setRecovery(true)
                    }}
                  >
                    {t('meetingPoll.recover')}
                  </button>
                </>
              )
            )}
          </>
        )}
      </div>
    </PublicLayout>
  )
}

function PollQuestion({
  question,
  value,
  onChange,
}: {
  question: Schemas['Question']
  value: Answer | undefined
  onChange: (value: Answer) => void
}) {
  const { t } = useI18n()
  const id = `poll-question-${question.id}`
  const text = typeof value === 'string' ? value : ''
  const label = (
    <span>
      {question.label}
      {question.required && <span> · {t('meetingPoll.required')}</span>}
    </span>
  )
  if (question.type === 'multi_select')
    return (
      <fieldset>
        <legend>{label}</legend>
        {question.options?.map((option) => (
          <label key={option} className="poll-consent">
            <input
              type="checkbox"
              checked={Array.isArray(value) && value.includes(option)}
              onChange={(event) => {
                const items = Array.isArray(value) ? value : []
                onChange(
                  event.target.checked
                    ? [...items, option]
                    : items.filter((item) => item !== option),
                )
              }}
            />
            {option}
          </label>
        ))}
      </fieldset>
    )
  if (question.type === 'checkbox')
    return (
      <label className="poll-consent">
        <input
          type="checkbox"
          required={question.required}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
    )
  return (
    <label htmlFor={id} className="poll-field">
      {label}
      {question.type === 'long_text' ? (
        <textarea
          id={id}
          required={question.required}
          maxLength={5000}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : question.type === 'select' ? (
        <select
          id={id}
          required={question.required}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="" />
          {question.options?.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={question.type === 'phone' ? 'tel' : 'text'}
          required={question.required}
          maxLength={question.type === 'phone' ? 32 : 500}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  )
}
