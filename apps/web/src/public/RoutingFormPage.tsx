import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import { useParams } from 'react-router'
import type { Schemas } from '../api/client.ts'
import { goTo } from '../browser.ts'
import { useMounted, usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { literal, msg, type UiText } from '../i18n/translate.ts'
import { codeOf, getRoutingForm, PublicRequestError, submitRoutingForm } from './api.ts'
import { FocusHeading, PublicLayout, PublicStatus } from './PublicLayout.tsx'
import './routing-form.css'
import { isAllowedText, LIMITS } from './validation.ts'

type Form = Schemas['PublicRoutingForm']
type Question = Form['questions'][number]
type Answers = Record<string, string>
type State =
  | { status: 'loading' }
  | { status: 'load-error'; previous?: Form }
  | { status: 'unavailable' }
  | { status: 'form'; form: Form; changed: boolean }
  | { status: 'message'; message: string }

// Mirror the routing API's answer envelope and invitee email rule. The server validates again.
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/u
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

function validate(question: Question, value: string): UiText | undefined {
  const text = value.trim()
  if (value.length > LIMITS.short_text)
    return msg('Enter {count} characters or fewer.', { count: LIMITS.short_text })
  if (!isAllowedText(text) || BIDI_CONTROLS.test(text))
    return 'Remove unsupported characters from your answer.'
  if (text === '') {
    if (!question.required) return undefined
    return question.type === 'select' ? 'Choose one of the available options.' : 'Enter an answer.'
  }
  if (question.type === 'select' && !question.options.some(({ id }) => id === value))
    return 'Choose one of the available options.'
  if (question.type === 'email' && (text.length > LIMITS.email || !EMAIL.test(text)))
    return 'Enter a valid email address.'
}

function compatibleAnswers(answers: Answers, previous: Form, form: Form): Answers {
  const types = new Map(previous.questions.map(({ id, type }) => [id, type]))
  const kept: Answers = {}
  for (const question of form.questions) {
    const value = answers[question.id]
    if (value === undefined || question.type !== types.get(question.id)) continue
    if (question.type === 'select' && !question.options.some(({ id }) => id === value)) continue
    kept[question.id] = value
  }
  return kept
}

function unavailable(error: unknown) {
  return (
    (error instanceof PublicRequestError && error.status === 404) ||
    codeOf(error) === 'routing_unavailable'
  )
}

function RoutingQuestion({
  question,
  id,
  value,
  error,
  disabled,
  onChange,
}: {
  question: Question
  id: string
  value: string
  error: UiText | undefined
  disabled: boolean
  onChange: (value: string) => void
}) {
  const { t, ui } = useI18n()
  const description = [!question.required && `${id}-optional`, error && `${id}-error`]
    .filter(Boolean)
    .join(' ')
  const control = {
    id,
    value,
    required: question.required,
    disabled,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': description || undefined,
  }
  return (
    <div className="field">
      <div className="routing-form-label">
        <label htmlFor={id}>{question.label}</label>
        {!question.required && (
          <span className="optional" id={`${id}-optional`}>
            {t('Optional')}
          </span>
        )}
      </div>
      {question.type === 'select' ? (
        <select {...control} onChange={(event) => onChange(event.currentTarget.value)}>
          <option value="">{t('Select an option')}</option>
          {question.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          {...control}
          type={question.type === 'email' ? 'email' : 'text'}
          maxLength={LIMITS.short_text}
          spellCheck={false}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {ui(error)}
        </p>
      )}
    </div>
  )
}

export function RoutingFormPage() {
  const { handle = '', teamSlug, slug = '' } = useParams<'handle' | 'teamSlug' | 'slug'>()
  const { t } = useI18n()
  const headingId = useId()
  const changedNoticeId = `${headingId}-changed`
  const [state, setState] = useState<State>({ status: 'loading' })
  const [answers, setAnswers] = useState<Answers>({})
  const [errors, setErrors] = useState<Record<string, UiText | undefined>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(false)
  const mounted = useMounted()
  const requests = useRef<AbortController>(null)
  const invalidControl = useRef<string>(undefined)

  useEffect(() => {
    const id = invalidControl.current
    if (id && errors[id]) document.getElementById(`${headingId}-${id}`)?.focus()
    invalidControl.current = undefined
  }, [errors, headingId])

  const load = useCallback(
    async (previous?: Form) => {
      const signal = requests.current?.signal
      if (!signal || signal.aborted) return
      setState({ status: 'loading' })
      try {
        const form = await getRoutingForm(
          teamSlug === undefined ? { handle, slug } : { teamSlug, slug },
          signal,
        )
        if (signal.aborted || !mounted.current) return
        if (previous) setAnswers((draft) => compatibleAnswers(draft, previous, form))
        setState({ status: 'form', form, changed: previous !== undefined })
      } catch (error) {
        if (signal.aborted || !mounted.current) return
        if (unavailable(error)) {
          setAnswers({})
          setState({ status: 'unavailable' })
        } else {
          setState({ status: 'load-error', ...(previous && { previous }) })
        }
      }
    },
    [handle, mounted, slug, teamSlug],
  )

  useEffect(() => {
    const controller = new AbortController()
    requests.current = controller
    void load()
    return () => controller.abort()
  }, [load])

  async function submit(event: FormEvent<HTMLFormElement>, form: Form) {
    event.preventDefault()
    const signal = requests.current?.signal
    if (submitting || !signal || signal.aborted) return
    setSubmitError(false)
    const body: Schemas['RoutingSubmission'] = { versionId: form.versionId, answers: {} }
    const nextErrors: Record<string, UiText> = {}
    for (const question of form.questions) {
      const value = answers[question.id] ?? ''
      const error = validate(question, value)
      if (error) nextErrors[question.id] = error
      else if (value.trim()) body.answers[question.id] = value.trim()
    }
    invalidControl.current = Object.keys(nextErrors)[0]
    setErrors(nextErrors)
    if (invalidControl.current) return

    setSubmitting(true)
    try {
      const address = teamSlug === undefined ? { handle, slug } : { teamSlug, slug }
      const outcome = await submitRoutingForm(address, body, signal)
      if (signal.aborted || !mounted.current) return
      setAnswers({})
      if (outcome.kind === 'message') setState({ status: 'message', message: outcome.message })
      else goTo(outcome.continuationUrl)
    } catch (error) {
      if (signal.aborted || !mounted.current) return
      if (codeOf(error) === 'routing_form_changed') {
        await load(form)
      } else if (unavailable(error)) {
        setAnswers({})
        setState({ status: 'unavailable' })
      } else {
        setSubmitError(true)
      }
    } finally {
      if (!signal.aborted && mounted.current) setSubmitting(false)
    }
  }

  const titles = {
    loading: 'Loading form…',
    'load-error': 'We couldn’t load this form. Try again.',
    unavailable: 'This form is unavailable',
    message: 'Thank you',
  } as const
  usePageTitle(state.status === 'form' ? literal(state.form.title) : titles[state.status])

  return (
    <PublicLayout>
      <div className="card public-card routing-form-card">
        {state.status === 'loading' && <PublicStatus>{t(titles.loading)}</PublicStatus>}
        {state.status === 'load-error' && (
          <>
            <FocusHeading>{t(titles['load-error'])}</FocusHeading>
            <button type="button" className="button" onClick={() => void load(state.previous)}>
              {t('Try again')}
            </button>
          </>
        )}
        {state.status === 'unavailable' && (
          <>
            <FocusHeading>{t(titles.unavailable)}</FocusHeading>
            <p>{t('Check the link you were given.')}</p>
          </>
        )}
        {state.status === 'message' && (
          <>
            <FocusHeading>{t(titles.message)}</FocusHeading>
            <p className="routing-form-copy">{state.message}</p>
          </>
        )}
        {state.status === 'form' && (
          <>
            <FocusHeading
              key={state.form.versionId}
              id={headingId}
              describedBy={state.changed ? changedNoticeId : undefined}
            >
              {state.form.title}
            </FocusHeading>
            {state.form.description && (
              <p className="routing-form-copy">{state.form.description}</p>
            )}
            {state.changed && (
              <p className="alert alert-info" id={changedNoticeId} role="status">
                {t('This form has changed. Review your answers before continuing.')}
              </p>
            )}
            <form
              className="stack"
              aria-labelledby={headingId}
              autoComplete="off"
              method="post"
              noValidate
              onSubmit={(event) => void submit(event, state.form)}
            >
              {Object.values(errors).some(Boolean) && (
                <p className="alert" role="alert">
                  {t('Review the highlighted answers.')}
                </p>
              )}
              {state.form.questions.map((question) => (
                <RoutingQuestion
                  key={question.id}
                  question={question}
                  id={`${headingId}-${question.id}`}
                  value={answers[question.id] ?? ''}
                  error={errors[question.id]}
                  disabled={submitting}
                  onChange={(value) => {
                    setAnswers((draft) => ({ ...draft, [question.id]: value }))
                    if (errors[question.id]) {
                      setErrors((current) => ({
                        ...current,
                        [question.id]: validate(question, value),
                      }))
                    }
                  }}
                />
              ))}
              {submitError && (
                <p className="alert" role="alert">
                  {t('We couldn’t submit your answers. Try again.')}
                </p>
              )}
              <button type="submit" className="button primary" aria-disabled={submitting}>
                {t('Continue')}
              </button>
              <div className="routing-form-progress" role="status">
                {submitting ? t('Submitting…') : ''}
              </div>
            </form>
          </>
        )}
      </div>
    </PublicLayout>
  )
}
