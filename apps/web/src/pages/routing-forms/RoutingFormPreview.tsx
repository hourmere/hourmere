import {
  ROUTING_FORM_LIMITS,
  RoutingValidationError,
  validateRoutingAnswers,
} from '@hourmere/scheduling/routing-form-config'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import type { Schemas } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { ErrorSummary, Field, type FieldErrors } from '../../components/forms.tsx'
import { OrganizationContextConflict } from '../../components/OrganizationContextConflict.tsx'
import { UserContentLines } from '../../components/UserContent.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import { previewRoutingForm, type RoutingForm } from './routing-form-api.ts'

type Answers = Schemas['PreviewRoutingForm']['answers']
type Result = Schemas['RoutingFormPreview']
type EventTitle = (id: string) => string | undefined
type PreviewState =
  | { status: 'idle' | 'loading' | 'denied' | 'error' | 'stale' }
  | { status: 'result'; result: Result }
  | { status: 'context'; error: unknown }

const answerId = (questionId: string) => `routing-preview-answer-${questionId}`

export function RoutingFormPreview({
  dirty,
  ...props
}: {
  form: RoutingForm
  organizationId: string
  dirty: boolean
  disabled: boolean
  eventTitle: EventTitle
  reload: (() => void) | undefined
}) {
  const { t } = useI18n()
  return (
    <section
      className="panel"
      aria-labelledby="routing-preview-title"
      data-testid="routing-preview"
    >
      <h2 id="routing-preview-title">{t('Preview saved draft')}</h2>
      {dirty ? (
        <>
          <p className="muted" id="routing-preview-unsaved" role="status">
            {t('Save your changes before running a preview.')}
          </p>
          <button
            type="button"
            className="button"
            disabled
            aria-describedby="routing-preview-unsaved"
          >
            {t('Run preview')}
          </button>
        </>
      ) : (
        <PreviewFields {...props} />
      )}
    </section>
  )
}

function PreviewFields({
  form,
  organizationId,
  disabled,
  eventTitle,
  reload,
}: {
  form: RoutingForm
  organizationId: string
  disabled: boolean
  eventTitle: EventTitle
  reload: (() => void) | undefined
}) {
  const { t } = useI18n()
  const { questions } = form
  const [answers, setAnswers] = useState<Answers>({})
  const [state, setState] = useState<PreviewState>({ status: 'idle' })
  const [errors, setErrors] = useState<FieldErrors>({})
  const [attempt, setAttempt] = useState(0)
  const inFlight = useRef<AbortController | null>(null)
  useEffect(() => () => inFlight.current?.abort(), [])
  const blocked = disabled || state.status === 'stale' || state.status === 'context'

  function markAnswerError(field: string | undefined) {
    const question = questions.find(({ id }) => `answers.${id}` === field)
    if (!question) {
      setState({ status: 'error' })
      return
    }
    const blank = !answers[question.id]?.trim()
    const message =
      blank && question.required
        ? 'Answer this required question.'
        : question.type === 'email'
          ? 'Enter a valid email address.'
          : question.type === 'select'
            ? 'Select a current option.'
            : 'Enter an answer using supported text.'
    setErrors({ [answerId(question.id)]: message })
  }

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (blocked || inFlight.current) return
    setAttempt((value) => value + 1)
    setErrors({})
    setState({ status: 'idle' })
    try {
      validateRoutingAnswers(questions, answers)
    } catch (error) {
      if (!(error instanceof RoutingValidationError)) throw error
      markAnswerError(error.field)
      return
    }

    const request = new AbortController()
    inFlight.current = request
    setState({ status: 'loading' })
    try {
      const result = await previewRoutingForm(organizationId, form.id, answers, request.signal)
      if (request.signal.aborted) return
      setState(
        result.draftRevision === form.draftRevision
          ? { status: 'result', result }
          : { status: 'stale' },
      )
    } catch (error) {
      if (request.signal.aborted) return
      if (isOrganizationContextChanged(error)) {
        setState({ status: 'context', error })
      } else if (error instanceof RequestError && error.code === 'invalid_routing_answers') {
        // The sample already passed the same validator against the loaded revision.
        setState({ status: 'stale' })
      } else if (error instanceof RequestError && (error.status === 401 || error.status === 403)) {
        setState({ status: 'denied' })
      } else {
        setState({ status: 'error' })
      }
    } finally {
      inFlight.current = null
    }
  }

  return (
    <>
      <p className="muted">{t('Use sample answers to see which rule and destination apply.')}</p>
      <form noValidate onSubmit={run}>
        <ErrorSummary errors={errors} attempt={attempt} />
        <fieldset className="form-fieldset" disabled={blocked || state.status === 'loading'}>
          {questions.map((question) => {
            const id = answerId(question.id)
            const value = answers[question.id] ?? ''
            const change = (next: string) => {
              setAnswers((current) => ({ ...current, [question.id]: next || null }))
              setErrors({})
              setState({ status: 'idle' })
            }
            return (
              <Field
                key={question.id}
                id={id}
                label={<bdi className="user-content">{question.label}</bdi>}
                optional={!question.required}
                error={errors[id]}
              >
                {(control) =>
                  question.type === 'select' ? (
                    <select
                      {...control}
                      required={question.required}
                      value={value}
                      onChange={(event) => change(event.target.value)}
                    >
                      <option value="">{t('Select an option')}</option>
                      {question.options.map((option) => (
                        <option key={option.id} value={option.id} dir="auto">
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      {...control}
                      autoComplete="off"
                      inputMode={question.type === 'email' ? 'email' : undefined}
                      dir={question.type === 'email' ? 'ltr' : 'auto'}
                      maxLength={ROUTING_FORM_LIMITS.textAnswerLength}
                      required={question.required}
                      value={value}
                      onChange={(event) => change(event.target.value)}
                    />
                  )
                }
              </Field>
            )
          })}
          <div className="form-actions">
            <button type="submit" className="button">
              {t('Run preview')}
            </button>
          </div>
        </fieldset>
      </form>
      {state.status === 'loading' && (
        <p role="status" data-testid="routing-preview-loading">
          {t('Running preview…')}
        </p>
      )}
      {state.status === 'context' && <OrganizationContextConflict error={state.error} />}
      {state.status === 'denied' && (
        <p className="alert alert-error" role="alert" data-testid="routing-preview-denied">
          {t("You don't have permission to do that.")}
        </p>
      )}
      {state.status === 'error' && (
        <p className="alert alert-error" role="alert" data-testid="routing-preview-error">
          {t('Could not preview the saved draft.')}
        </p>
      )}
      {state.status === 'stale' && (
        <div className="alert alert-error" role="alert" data-testid="routing-preview-stale">
          <p>{t('The saved draft changed. Reload it before running another preview.')}</p>
          {reload && (
            <button type="button" className="button button-small" onClick={reload}>
              {t('Reload')}
            </button>
          )}
        </div>
      )}
      {state.status === 'result' && (
        <PreviewResult result={state.result} form={form} eventTitle={eventTitle} />
      )}
    </>
  )
}

function PreviewResult({
  result,
  form,
  eventTitle,
}: {
  result: Result
  form: RoutingForm
  eventTitle: EventTitle
}) {
  const { t } = useI18n()
  const ruleNumbers = new Map(form.rules.map(({ id }, index) => [id, index + 1]))
  const questionLabels = new Map(form.questions.map(({ id, label }) => [id, label]))
  const title = result.target?.kind === 'event' ? eventTitle(result.target.eventTypeId) : undefined
  function ruleLabel(id: string) {
    if (id === 'fallback') return t('Fallback')
    const number = ruleNumbers.get(id)
    return number === undefined ? t('Unavailable rule') : t('Rule {number}', { number })
  }

  return (
    <div className="routing-preview-result" data-testid="routing-preview-result">
      <h3>{t('Preview result')}</h3>
      <div role="status">
        <p>{t('Matched: {rule}.', { rule: ruleLabel(result.matchedRuleId) })}</p>
        {result.resolvedRuleId ? (
          <p>{t('Destination used: {rule}.', { rule: ruleLabel(result.resolvedRuleId) })}</p>
        ) : (
          <p>{t('No destination is available for these answers.')}</p>
        )}
      </div>
      {result.target?.kind === 'message' && (
        <p className="user-content routing-preview-message">
          <UserContentLines text={result.target.message} />
        </p>
      )}
      {result.target?.kind === 'event' && (
        <p>{title ? <bdi className="user-content">{title}</bdi> : t('Book an event')}</p>
      )}
      {result.unavailableTargets.map(({ ruleId }) => (
        <p key={ruleId}>{t('Destination unavailable: {rule}.', { rule: ruleLabel(ruleId) })}</p>
      ))}
      {result.rules.length > 0 && (
        <ol aria-label={t('Evaluated rules')}>
          {result.rules.map(({ ruleId, matched, conditions }) => (
            <li key={ruleId}>
              <strong>{ruleLabel(ruleId)}</strong> {matched ? t('Matched') : t('Did not match')}
              <ul>
                {conditions.map(({ questionId, matched }, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: this immutable trace has no condition IDs, and a question may appear more than once.
                  <li key={`${questionId}:${index}`}>
                    <bdi className="user-content">
                      {questionLabels.get(questionId) ?? t('Unavailable question')}
                    </bdi>{' '}
                    {matched ? t('Matched') : t('Did not match')}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
