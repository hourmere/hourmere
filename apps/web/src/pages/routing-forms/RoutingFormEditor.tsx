import {
  RoutingValidationError,
  validateRoutingFormConfig,
} from '@hourmere/scheduling/routing-form-config'
import { type FormEvent, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type { Schemas } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import { ErrorSummary, Field, type FieldErrors } from '../../components/forms.tsx'
import { OrganizationContextConflict } from '../../components/OrganizationContextConflict.tsx'
import { useMounted } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { PATHS, routingFormPath } from '../../paths.ts'
import { randomKey } from '../../public/api.ts'
import { useConfirmLeave, useUnsavedChanges } from '../../unsaved-changes.tsx'
import { RoutingFormPreview } from './RoutingFormPreview.tsx'
import { RoutingQuestionsEditor } from './RoutingQuestionsEditor.tsx'
import { RoutingRulesEditor } from './RoutingRulesEditor.tsx'
import {
  archiveRoutingForm,
  createRoutingForm,
  type RoutingDraft,
  type RoutingForm,
  saveRoutingForm,
} from './routing-form-api.ts'
import { useRoutingTargetEvents } from './routing-target-events.ts'
import { routingEventMappingErrors } from './routing-target-mappings.ts'

const titleField = 'routing-form-title'
const slugField = 'routing-form-slug'
const descriptionField = 'routing-form-description'
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const slugHint =
  'Use 1–64 lowercase letters, numbers, or hyphens. Start and end with a letter or number.'
const staleMessage =
  'This routing form changed elsewhere. Reload it and review your edits before trying again.'
const unavailableMessage = 'This routing form is unavailable.'
const deniedMessage = "You don't have permission to do that."
const saveFailure = 'Could not save the routing form.'
const archiveFailure = 'Could not archive the routing form.'

function targetFields(target: RoutingForm['fallback']): RoutingForm['fallback'] {
  if (target.kind === 'message') return { kind: target.kind, message: target.message }
  return {
    kind: target.kind,
    eventTypeId: target.eventTypeId,
    mappings: target.mappings.map(({ questionId, destination, options }) => ({
      questionId,
      destination:
        destination.kind === 'question'
          ? { kind: destination.kind, questionId: destination.questionId }
          : { kind: destination.kind },
      ...(options === undefined ? {} : { options }),
    })),
  }
}

function fieldsFrom(form: RoutingForm): RoutingDraft {
  return {
    title: form.title,
    slug: form.slug,
    description: form.description ?? '',
    // The read schema is additive. Send only fields accepted by the strict write schema.
    questions: form.questions.map((question) => {
      const { id, type, label, required } = question
      const fields = { id, type, label, required }
      return type === 'select'
        ? { ...fields, type, options: question.options.map(({ id, label }) => ({ id, label })) }
        : { ...fields, type }
    }),
    rules: form.rules.map(({ id, conditions, target }) => ({
      id,
      conditions: conditions.map((condition) => {
        const { questionId, operator } = condition
        return operator === 'equals'
          ? { questionId, operator, value: condition.value }
          : { questionId, operator, values: condition.values }
      }),
      target: targetFields(target),
    })),
    fallback: targetFields(form.fallback),
  }
}

function validate(draft: RoutingDraft): FieldErrors {
  const errors: FieldErrors = {}
  if (!draft.title.trim()) errors[titleField] = 'Enter a title.'
  if (!slugPattern.test(draft.slug.trim())) errors[slugField] = slugHint
  draft.questions.forEach((question, questionIndex) => {
    const path = `questions.${questionIndex}`
    if (!question.label.trim()) errors[`${path}.label`] = 'Enter a question label.'
    if (question.type !== 'select') return
    const labels = new Set<string>()
    question.options.forEach((option, optionIndex) => {
      const key = option.label.trim().normalize('NFC')
      const field = `${path}.options.${optionIndex}.label`
      if (!key) errors[field] = 'Enter an option label.'
      else if (labels.has(key)) errors[field] = 'Use a different label for each option.'
      labels.add(key)
    })
  })
  return errors
}

function configErrorMessage(error: RoutingValidationError): MessageKey {
  switch (error.reason) {
    case 'invalid_message':
      return 'Enter a message using supported text.'
    case 'not_found':
      return 'Choose an event type.'
    case 'invalid_mapping':
      if (error.field?.endsWith('.options')) return 'Map every answer option to a booking option.'
      if (error.field?.endsWith('.questionId')) return 'Choose a question from this form.'
      return 'Check the answer mapping and choose a unique booking field.'
  }
  if (error.field?.endsWith('.questionId')) return 'Choose a question from this form.'
  if (error.field?.endsWith('.conditions')) return 'Add at least one condition.'
  if (error.field?.endsWith('.value') || error.field?.endsWith('.values'))
    return 'Enter or select a valid answer to match.'
  if (error.field?.startsWith('questions.')) return 'Enter a label using supported text.'
  return 'Check the routing rule or fallback.'
}

type WriteIssue =
  | { context: unknown }
  | { message: MessageKey; reload?: boolean; blocked?: boolean }

function writeIssue(error: unknown, fallback: MessageKey): WriteIssue {
  if (isOrganizationContextChanged(error)) return { context: error }
  if (error instanceof RequestError) {
    if (error.status === 403) return { message: deniedMessage, blocked: true }
    if (error.code === 'routing_revision_conflict') return { message: staleMessage, reload: true }
    if (error.status === 404) return { message: unavailableMessage, reload: true }
    if (/^(?:rules|fallback)(?:\.|$)/.test(error.field ?? ''))
      return {
        message: 'This draft has rules or a fallback that reference a changed question or option.',
      }
  }
  return { message: fallback }
}

export function RoutingFormEditor({
  form,
  organizationId,
  personalOwnerId,
  reload,
}: {
  form?: RoutingForm
  organizationId: string
  personalOwnerId: string | null
  reload?: () => void
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const mounted = useMounted()
  const confirmLeave = useConfirmLeave()
  const inFlight = useRef(false)
  const defaultFallback = {
    kind: 'message' as const,
    message: t('No appointment is available for these answers.'),
  }
  const [busy, setBusy] = useState<'save' | 'archive' | null>(null)
  const [current, setCurrent] = useState(form)
  const [draft, setDraft] = useState<RoutingDraft>(() =>
    form
      ? fieldsFrom(form)
      : {
          title: '',
          slug: '',
          description: '',
          questions: [],
          rules: [],
          fallback: defaultFallback,
        },
  )
  const [baseline, setBaseline] = useState(draft)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [issue, setIssue] = useState<WriteIssue | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [saved, setSaved] = useState(false)
  const [pending, setPending] = useState<Schemas['CreateRoutingForm'] | null>(null)
  const blocked = Boolean(issue && ('context' in issue || issue.reload || issue.blocked))
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)
  useUnsavedChanges(dirty)
  const targets = [
    ...draft.rules.map((rule, index) => ({ path: `rules.${index}.target`, target: rule.target })),
    { path: 'fallback', target: draft.fallback },
  ]
  const events = useRoutingTargetEvents(
    organizationId,
    personalOwnerId,
    targets.map(({ target }) => target),
  )

  function change(patch: Partial<RoutingDraft>) {
    setDraft((value) => ({ ...value, ...patch }))
    setErrors({})
    setIssue(null)
    setSaved(false)
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current || blocked) return
    setAttempt((value) => value + 1)
    setIssue(null)
    setSaved(false)
    const problems = validate(draft)
    const { questions, rules } = draft
    const fallback = current ? draft.fallback : defaultFallback
    if (!Object.keys(problems).length) {
      try {
        validateRoutingFormConfig({ questions, rules, fallback })
        Object.assign(problems, routingEventMappingErrors(events, questions, targets))
      } catch (error) {
        if (!(error instanceof RoutingValidationError)) throw error
        problems[error.field ?? 'rules'] = configErrorMessage(error)
      }
    }
    setErrors(problems)
    if (Object.keys(problems).length) return

    const fields = { ...draft, fallback, slug: draft.slug.trim() }
    const create = current
      ? null
      : (pending ?? {
          title: fields.title,
          slug: fields.slug,
          description: fields.description,
          questions: fields.questions,
          fallback: fields.fallback,
          requestId: randomKey(),
        })
    inFlight.current = true
    setBusy('save')
    try {
      if (create) {
        const created = await createRoutingForm(organizationId, create)
        if (mounted.current)
          navigate(routingFormPath(created.id, organizationId), { replace: true })
      } else if (current) {
        const updated = await saveRoutingForm(
          organizationId,
          current.id,
          current.draftRevision,
          fields,
        )
        if (!mounted.current) return
        const next = fieldsFrom(updated)
        setCurrent(updated)
        setDraft(next)
        setBaseline(next)
        setSaved(true)
      }
    } catch (error) {
      if (!mounted.current) return
      const uncertain =
        !(error instanceof RequestError) ||
        error.status >= 500 ||
        error.status === 408 ||
        (pending !== null && error.status === 429)
      // Retry the same body and request ID even if the interface language changes.
      setPending(uncertain ? create : null)
      if (error instanceof RequestError && error.code === 'slug_taken')
        setErrors({ [slugField]: 'This address is already in use.' })
      else {
        setIssue(
          writeIssue(
            error,
            uncertain && create
              ? 'Could not confirm creation. Try again to recover this draft.'
              : saveFailure,
          ),
        )
      }
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(null)
    }
  }

  async function archive() {
    if (!current || inFlight.current || blocked) return
    inFlight.current = true
    setBusy('archive')
    setAttempt((value) => value + 1)
    setErrors({})
    setIssue(null)
    setSaved(false)
    try {
      await archiveRoutingForm(organizationId, current.id, current.draftRevision)
      if (mounted.current) navigate(PATHS.routingForms, { replace: true })
    } catch (error) {
      if (mounted.current) setIssue(writeIssue(error, archiveFailure))
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(null)
    }
  }

  return (
    <>
      <form className="editor" onSubmit={save} noValidate data-testid="routing-form-editor">
        {issue && 'context' in issue ? (
          <OrganizationContextConflict error={issue.context} />
        ) : (
          <ErrorSummary errors={errors} message={issue?.message} attempt={attempt} />
        )}
        {issue && 'reload' in issue && issue.reload && reload && (
          <div className="form-actions">
            <button type="button" className="button" onClick={() => confirmLeave() && reload()}>
              {t('Reload')}
            </button>
          </div>
        )}
        <fieldset className="form-fieldset" disabled={!!busy || blocked || !!pending}>
          <div className="panel">
            <Field id={titleField} label={t('Title')} error={errors[titleField]}>
              {(control) => (
                <input
                  {...control}
                  value={draft.title}
                  onChange={(event) => change({ title: event.target.value })}
                  maxLength={200}
                  required
                />
              )}
            </Field>
            <Field
              id={slugField}
              label={t('Form address')}
              hint={t(slugHint)}
              error={errors[slugField]}
            >
              {(control) => (
                <input
                  {...control}
                  value={draft.slug}
                  onChange={(event) => change({ slug: event.target.value })}
                  maxLength={64}
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
              )}
            </Field>
            <Field id={descriptionField} label={t('Description')} optional>
              {(control) => (
                <textarea
                  {...control}
                  value={draft.description ?? ''}
                  onChange={(event) => change({ description: event.target.value })}
                  maxLength={2000}
                  rows={3}
                />
              )}
            </Field>
          </div>
          <div className="panel">
            <h2>{t('Questions')}</h2>
            <RoutingQuestionsEditor
              questions={draft.questions}
              errors={errors}
              onChange={(questions) => change({ questions })}
            />
          </div>
          {current && (
            <div className="panel">
              <RoutingRulesEditor
                questions={draft.questions}
                rules={draft.rules}
                fallback={draft.fallback}
                onRulesChange={(rules) => change({ rules })}
                onFallbackChange={(fallback) => change({ fallback })}
                errors={errors}
                events={events}
              />
            </div>
          )}
        </fieldset>
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={!!busy || blocked}>
            {busy === 'save' ? t('Saving…') : t('Save draft')}
          </button>
          {saved && <span role="status">{t('Draft saved.')}</span>}
        </div>
      </form>
      {current && (
        <RoutingFormPreview
          key={current.draftRevision}
          form={current}
          organizationId={organizationId}
          dirty={dirty}
          disabled={!!busy || blocked}
          eventTitle={events.eventTitle}
          reload={reload}
        />
      )}
      {current && (
        <fieldset
          className="form-fieldset"
          disabled={busy === 'save' || blocked}
          data-testid="routing-form-archive"
        >
          <ConfirmAction
            className="button-danger"
            label="Archive routing form"
            prompt="Archive this routing form? Its public link will stop accepting submissions, and unsaved edits will be lost."
            confirmLabel="Archive form"
            busyLabel="Archiving…"
            failure={archiveFailure}
            onConfirm={archive}
          />
        </fieldset>
      )}
    </>
  )
}
