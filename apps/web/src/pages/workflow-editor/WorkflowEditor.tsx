import { type FormEvent, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { errorMessage, isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'
import { PATHS } from '../../paths.ts'
import { randomHex } from '../../random.ts'
import { useSession } from '../../session.tsx'
import { useConfirmLeave, useUnsavedChanges } from '../../unsaved-changes.tsx'
import { WorkflowConditionsFields, WorkflowRecipientsField } from './WorkflowAudienceFields.tsx'
import {
  type WorkflowContent,
  WorkflowDefinitionFields,
  WorkflowTranslations,
  WorkflowWebhookField,
} from './WorkflowDefinitionFields.tsx'
import { WorkflowPreviewPanel } from './WorkflowPreviewPanel.tsx'

type Workflow = Schemas['Workflow']
type WorkflowAction = Schemas['WorkflowAction']
type Email = Extract<WorkflowAction, { type: 'email' }>
type Webhook = Extract<WorkflowAction, { type: 'webhook' }>
type Draft = Pick<Workflow, 'name' | 'scope' | 'trigger' | 'conditions'> & {
  action: WorkflowAction
}
const defaultEmail: Email = { type: 'email', recipients: ['booker'] }
const defaultWebhook: Webhook = { type: 'webhook', webhookId: '' }

function workflowDraft(workflow: Workflow | null): Draft {
  return workflow
    ? {
        name: workflow.name,
        scope: workflow.scope,
        trigger: workflow.trigger,
        conditions: workflow.conditions,
        action: workflow.actions[0] ?? defaultEmail,
      }
    : {
        name: '',
        scope: { type: 'all_event_types' },
        trigger: { type: 'booking.created', delayMinutes: 0 },
        conditions: [],
        action: defaultEmail,
      }
}

export function WorkflowEditor({
  workflow,
  eventTypes,
  owner,
  organizationId,
  followUpHostNotesEnabled,
  reload,
}: {
  workflow: Workflow | null
  eventTypes: Schemas['EventType'][]
  owner: Schemas['WorkflowOwner']
  organizationId: string
  followUpHostNotesEnabled: boolean
  reload: () => void
}) {
  const { t, ui, locale } = useI18n()
  const { confirmReload } = useSession()
  const confirmLeave = useConfirmLeave()
  const navigate = useNavigate()
  const [original] = useState(() => workflowDraft(workflow))
  const [draft, setDraft] = useState(original)
  const [replaceText, setReplaceText] = useState(false)
  const [previewLocale, setPreviewLocale] = useState(locale)
  const [previewEventTypeId, setPreviewEventTypeId] = useState('')
  const [preview, setPreview] = useState<Schemas['WorkflowPreview'] | null>(null)
  const [busy, setBusy] = useState<'save' | 'preview' | null>(null)
  const [problem, setProblem] = useState<UiText | null>(null)
  const [block, setBlock] = useState<'stale' | 'context' | 'unavailable' | null>(null)
  const operation = useRef<AbortController | null>(null)
  const recovery = useRef<HTMLButtonElement>(null)
  const creationKey = useRef<string | null>(null)
  const actionDrafts = useRef({ email: defaultEmail, webhook: defaultWebhook })
  const hiddenText =
    !followUpHostNotesEnabled && draft.action.type === 'email' && !!draft.action.content

  useUnsavedChanges(
    block !== 'unavailable' && (replaceText || JSON.stringify(draft) !== JSON.stringify(original)),
  )
  useLayoutEffect(() => () => operation.current?.abort(), [])
  useLayoutEffect(() => {
    if (block) recovery.current?.focus()
  }, [block])

  function change(fields: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...fields }))
    setPreview(null)
    setProblem(null)
  }

  function changeText(content: WorkflowContent | undefined) {
    if (draft.action.type !== 'email') return
    change({
      action: { type: 'email', recipients: draft.action.recipients, ...(content && { content }) },
    })
  }

  function changeAction(type: WorkflowAction['type']) {
    const { action } = draft
    if (action.type === 'email') actionDrafts.current.email = action
    else actionDrafts.current.webhook = action
    change({ action: actionDrafts.current[type] })
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (operation.current || block) return
    const isPreview =
      (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'preview'
    const { name, scope, trigger, conditions, action } = draft
    if (action.type === 'email' && action.recipients.length === 0) {
      setProblem(msg('Choose at least one recipient.'))
      return
    }
    if (!isPreview && hiddenText && !replaceText) return
    const candidate = {
      name,
      scope,
      trigger,
      conditions,
      actions: [
        !followUpHostNotesEnabled && action.type === 'email'
          ? { type: 'email' as const, recipients: action.recipients }
          : action,
      ],
    }

    const controller = new AbortController()
    const { signal } = controller
    const header = { 'x-expected-organization-id': organizationId }
    operation.current = controller
    setBusy(isPreview ? 'preview' : 'save')
    setProblem(null)

    try {
      if (isPreview) {
        setPreview(null)
        const result = await unwrap(
          api.POST('/api/v1/workflows/preview', {
            params: { header },
            body: {
              ...candidate,
              owner,
              example: {
                locale: previewLocale,
                ...(previewEventTypeId && { eventTypeId: previewEventTypeId }),
              },
            },
            signal,
          }),
        )
        if (!signal.aborted) setPreview(result)
        return
      }

      if (workflow) {
        await unwrap(
          api.PATCH('/api/v1/workflows/{id}', {
            params: { path: { id: workflow.id }, header },
            body: { ...candidate, expectedRevision: workflow.revision },
            signal,
          }),
        )
      } else {
        creationKey.current ??= randomHex(16)
        await unwrap(
          api.POST('/api/v1/workflows', {
            params: { header },
            body: { ...candidate, owner, idempotencyKey: creationKey.current, enabled: false },
            signal,
          }),
        )
      }
      if (!signal.aborted) navigate(PATHS.workflows, { replace: true })
    } catch (error) {
      if (signal.aborted) return
      if (isOrganizationContextChanged(error)) setBlock('context')
      else if (error instanceof RequestError && error.code === 'workflow_revision_conflict')
        setBlock('stale')
      else if (error instanceof RequestError && (error.status === 403 || error.status === 404))
        setBlock('unavailable')
      else if (error instanceof RequestError && error.code === 'idempotency_key_reused')
        setProblem(
          msg(
            'A workflow may already have been saved. Check the workflow list before creating another.',
          ),
        )
      else
        setProblem(
          error instanceof RequestError && error.status === 400
            ? errorMessage(error)
            : msg(
                isPreview
                  ? 'Could not preview the workflow. Try again.'
                  : 'Could not save the workflow. Try again.',
              ),
        )
    } finally {
      if (!signal.aborted) {
        operation.current = null
        setBusy(null)
      }
    }
  }

  if (block === 'unavailable')
    return (
      <p className="alert alert-error" role="alert">
        {t('This workflow is unavailable.')}
      </p>
    )

  const { action } = draft

  return (
    <form className="editor workflow-editor" onSubmit={submit}>
      {block && (
        <div className="alert alert-error" role="alert">
          <p>
            {t(
              block === 'stale'
                ? 'This workflow changed. Review the latest version before trying again.'
                : 'Your space changed. Reload before making changes.',
            )}
          </p>
          <button
            ref={recovery}
            className="button button-small"
            type="button"
            onClick={block === 'context' ? confirmReload : () => confirmLeave() && reload()}
          >
            {t(block === 'context' ? 'Reload' : 'Reload workflow')}
          </button>
        </div>
      )}
      <fieldset
        className="form-fieldset workflow-fields"
        disabled={busy !== null || block !== null}
      >
        <section className="panel workflow-fields">
          <WorkflowDefinitionFields
            name={draft.name}
            scope={draft.scope}
            trigger={draft.trigger}
            eventTypes={eventTypes}
            onChange={change}
          />
          <WorkflowConditionsFields
            conditions={draft.conditions}
            scope={draft.scope}
            ownerKind={owner.kind}
            eventTypes={eventTypes}
            onChange={(conditions) => change({ conditions })}
          />
        </section>
        <section className="panel workflow-fields">
          <label className="field">
            <span>{t('Action')}</span>
            <select
              value={action.type}
              onChange={(event) => changeAction(event.target.value as WorkflowAction['type'])}
            >
              <option value="email">{t('Send email')}</option>
              <option value="webhook">{t('Send webhook')}</option>
            </select>
          </label>
          {action.type === 'email' ? (
            <>
              <WorkflowRecipientsField
                recipients={action.recipients}
                onChange={(recipients) => change({ action: { ...action, recipients } })}
              />
              {followUpHostNotesEnabled && (
                <WorkflowTranslations content={action.content} onChange={changeText} />
              )}
              {hiddenText && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={replaceText}
                    onChange={(event) => setReplaceText(event.target.checked)}
                  />
                  {t('Replace saved custom text with built-in text')}
                </label>
              )}
            </>
          ) : (
            <WorkflowWebhookField
              organizationId={organizationId}
              webhookId={action.webhookId}
              onChange={(webhookId) => change({ action: { ...action, webhookId } })}
            />
          )}
        </section>
        {problem && (
          <p className="alert alert-error" role="alert">
            {ui(problem)}
          </p>
        )}
        <div className="form-actions">
          <button
            className="button button-primary"
            type="submit"
            disabled={hiddenText && !replaceText}
          >
            {t(workflow ? 'Save changes' : 'Create workflow')}
          </button>
          <Link className="button" to={PATHS.workflows}>
            {t('Cancel')}
          </Link>
        </div>
        <WorkflowPreviewPanel
          locale={previewLocale}
          eventTypes={eventTypes}
          eventTypeId={previewEventTypeId}
          onEventTypeChange={(id) => {
            setPreviewEventTypeId(id)
            setPreview(null)
          }}
          onLocaleChange={(language) => {
            setPreviewLocale(language)
            setPreview(null)
          }}
          preview={preview}
          loading={busy === 'preview'}
        />
      </fieldset>
      {busy === 'save' && <p role="status">{t('Saving workflow…')}</p>}
    </form>
  )
}
