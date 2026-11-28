import {
  RoutingValidationError,
  validateRoutingFormConfig,
} from '@hourmere/scheduling/routing-form-config'
import { type FormEvent, useEffect, useRef, useState } from 'react'
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
import { routingFormPermissions, useTeamPagePermissions } from '../../team-page-permissions.ts'
import { useUnsavedChanges } from '../../unsaved-changes.tsx'
import { RoutingFormPreview } from './RoutingFormPreview.tsx'
import { RoutingFormPublication, type RoutingPublicationAction } from './RoutingFormPublication.tsx'
import { RoutingQuestionsEditor } from './RoutingQuestionsEditor.tsx'
import { RoutingRulesEditor } from './RoutingRulesEditor.tsx'
import {
  archiveRoutingForm,
  createRoutingForm,
  getRoutingForm,
  publishRoutingForm,
  type RoutingDraft,
  type RoutingForm,
  saveRoutingForm,
  setRoutingFormEnabled,
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
const publicationFailures = {
  publish: 'Could not publish the routing form.',
  disable: 'Could not disable the routing form.',
  enable: 'Could not re-enable the routing form.',
} as const

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

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function reconcileDraft(draft: RoutingDraft, baseline: RoutingDraft, latest: RoutingDraft) {
  const next = { ...latest }
  let overlap = false
  for (const key of Object.keys(baseline) as (keyof RoutingDraft)[]) {
    if (sameValue(draft[key], baseline[key])) continue
    overlap ||= !sameValue(latest[key], baseline[key]) && !sameValue(draft[key], latest[key])
    Object.assign(next, { [key]: draft[key] })
  }
  return { next, overlap }
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
    if (error.status === 401 || error.status === 403)
      return { message: deniedMessage, blocked: true }
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
}: {
  form?: RoutingForm
  organizationId: string
  personalOwnerId: string | null
}) {
  const { t } = useI18n()
  const permissions = useTeamPagePermissions()
  const navigate = useNavigate()
  const mounted = useMounted()
  const inFlight = useRef(false)
  const reloadRequest = useRef<AbortController | null>(null)
  useEffect(() => () => reloadRequest.current?.abort(), [])
  const defaultFallback = {
    kind: 'message' as const,
    message: t('No appointment is available for these answers.'),
  }
  const [busy, setBusy] = useState<'save' | 'archive' | 'reload' | RoutingPublicationAction | null>(
    null,
  )
  const [current, setCurrent] = useState(form)
  const canSave =
    permissions.status === 'fixed' ||
    permissions.allows(current ? routingFormPermissions.update : routingFormPermissions.create)
  const canPreview =
    permissions.status === 'fixed' || permissions.allows(routingFormPermissions.preview)
  const canPublish =
    permissions.status === 'fixed' || permissions.allows(routingFormPermissions.publish)
  const canArchive =
    permissions.status === 'fixed' || permissions.allows(routingFormPermissions.archive)
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
  const [pendingPublication, setPendingPublication] = useState<
    Schemas['PublishRoutingForm'] | null
  >(null)
  const [publicationStatus, setPublicationStatus] = useState<RoutingPublicationAction | null>(null)
  const [publishedNumber, setPublishedNumber] = useState<number | null>(null)
  const [reloaded, setReloaded] = useState(false)
  const [overlap, setOverlap] = useState(false)
  const blocked = Boolean(issue && ('context' in issue || issue.reload || issue.blocked))
  const dirty = !sameValue(draft, baseline)
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
    setReloaded(false)
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSave || inFlight.current || blocked) return
    if (
      overlap &&
      dirty &&
      !window.confirm(t('Save your edits over the fields that also changed in the latest draft?'))
    )
      return
    setAttempt((value) => value + 1)
    setIssue(null)
    setSaved(false)
    setReloaded(false)
    setPublicationStatus(null)
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
        setOverlap(false)
        setPendingPublication(null)
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

  async function reloadCurrent() {
    if (!current || inFlight.current) return
    const request = new AbortController()
    reloadRequest.current = request
    inFlight.current = true
    setBusy('reload')
    setAttempt((value) => value + 1)
    setSaved(false)
    setReloaded(false)
    setPublicationStatus(null)
    try {
      const latest = await getRoutingForm(organizationId, current.id, request.signal)
      if (!mounted.current) return
      const nextBaseline = fieldsFrom(latest)
      const merged = reconcileDraft(draft, baseline, nextBaseline)
      setCurrent(latest)
      setBaseline(nextBaseline)
      setDraft(merged.next)
      setOverlap(overlap || merged.overlap)
      setErrors({})
      setIssue(null)
      events.retry()
      if (latest.draftRevision !== current.draftRevision) setPendingPublication(null)
      setReloaded(true)
    } catch (error) {
      if (!mounted.current) return
      const failure = writeIssue(error, 'Could not load this routing form.')
      setIssue('context' in failure ? failure : { ...failure, reload: true })
    } finally {
      reloadRequest.current = null
      inFlight.current = false
      if (mounted.current) setBusy(null)
    }
  }

  async function changePublication(action: RoutingPublicationAction) {
    if (action === 'publish' ? !canPublish : !canSave) return
    if (!current || inFlight.current || blocked || (action === 'publish' && dirty)) return
    const body =
      action === 'publish'
        ? (pendingPublication ?? {
            expectedRevision: current.draftRevision,
            requestId: randomKey(),
          })
        : null
    inFlight.current = true
    setBusy(action)
    setAttempt((value) => value + 1)
    setErrors({})
    setIssue(null)
    setSaved(false)
    setReloaded(false)
    setPublicationStatus(null)
    try {
      const publication = body ? await publishRoutingForm(organizationId, current.id, body) : null
      const updated = publication
        ? publication.form
        : await setRoutingFormEnabled(
            organizationId,
            current.id,
            current.draftRevision,
            action === 'enable',
          )
      if (!mounted.current) return
      setCurrent(updated)
      setPendingPublication(null)
      if (publication) {
        const next = fieldsFrom(updated)
        setDraft(next)
        setBaseline(next)
        setOverlap(false)
      }
      setPublishedNumber(publication?.version.versionNumber ?? null)
      setPublicationStatus(action)
    } catch (error) {
      if (!mounted.current) return
      const uncertain =
        !(error instanceof RequestError) ||
        error.status >= 500 ||
        error.status === 408 ||
        (pendingPublication !== null && error.status === 429)
      if (body) setPendingPublication(uncertain ? body : null)
      if (
        action === 'publish' &&
        error instanceof RequestError &&
        error.code === 'invalid_routing_target'
      ) {
        events.retry()
        const target = targets.find(
          ({ path }) => error.field === path || error.field?.startsWith(`${path}.`),
        )
        if (target) {
          setErrors({ [`${target.path}.kind`]: 'Check the routing rule or fallback.' })
          setIssue({ message: 'Review the highlighted destination before publishing.' })
        } else {
          setIssue({ message: publicationFailures.publish })
        }
      } else {
        setIssue(
          writeIssue(
            error,
            uncertain && body
              ? 'Could not confirm publication. Try publishing again to recover the result.'
              : publicationFailures[action],
          ),
        )
      }
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(null)
    }
  }

  function repair(ruleId: string) {
    const index = draft.rules.findIndex((rule) => rule.id === ruleId)
    if (ruleId === 'fallback' || index !== -1) {
      const path = ruleId === 'fallback' ? 'fallback' : `rules.${index}.target`
      document.getElementById(`${path}.kind`)?.focus()
    }
  }

  async function archive() {
    if (!canArchive || !current || inFlight.current || blocked) return
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
        {issue && 'reload' in issue && issue.reload && current && (
          <div className="form-actions">
            <button type="button" className="button" disabled={!!busy} onClick={reloadCurrent}>
              {t('Reload')}
            </button>
          </div>
        )}
        {busy === 'reload' && <p role="status">{t('Loading routing form…')}</p>}
        {reloaded && (
          <p role="status" data-testid="routing-form-reloaded">
            {dirty
              ? t('The draft was reloaded. Your unsaved edits are still here.')
              : t('Routing form reloaded.')}
          </p>
        )}
        {overlap && dirty && (
          <p className="alert">
            {t(
              'The latest draft changed some of the same fields. Review your edits before saving.',
            )}
          </p>
        )}
        <fieldset className="form-fieldset" disabled={!canSave || !!busy || blocked || !!pending}>
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
        {canSave && (
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={!!busy || blocked}>
              {busy === 'save' ? t('Saving…') : t('Save draft')}
            </button>
            {saved && <span role="status">{t('Draft saved.')}</span>}
          </div>
        )}
      </form>
      {current && canPreview && (
        <RoutingFormPreview
          key={current.draftRevision}
          form={current}
          organizationId={organizationId}
          dirty={dirty}
          disabled={!!busy || blocked}
          eventTitle={events.eventTitle}
          reload={reloadCurrent}
        />
      )}
      {current && (
        <RoutingFormPublication
          form={current}
          draft={draft}
          dirty={dirty}
          disabled={!!busy || blocked}
          canPublish={canPublish}
          canEditDraft={canSave}
          busy={busy === 'publish' || busy === 'disable' || busy === 'enable' ? busy : null}
          status={publicationStatus}
          publishedNumber={publishedNumber}
          events={events.list}
          onPublish={() => changePublication('publish')}
          onSetEnabled={(enabled) => changePublication(enabled ? 'enable' : 'disable')}
          onRepair={repair}
        />
      )}
      {current && canArchive && (
        <fieldset
          className="form-fieldset"
          disabled={(!!busy && busy !== 'archive') || blocked}
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
