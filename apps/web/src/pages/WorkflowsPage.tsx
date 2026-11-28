import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api, type Schemas, unwrap } from '../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../api/errors.ts'
import { EmptyState } from '../components/EmptyState.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageSkeleton } from '../components/PageSkeleton.tsx'
import { useLoad, usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { PATHS, workflowEditPath, workflowRunHistoryPath } from '../paths.ts'
import { useMe, useSession } from '../session.tsx'
import { useTeamManagementAccess } from '../team-management.tsx'
import { useTeamPagePermissions } from '../team-page-permissions.ts'

type Workflow = Schemas['Workflow']
type Owner = Schemas['WorkflowOwner']

const actions = {
  enable: {
    label: 'Enable',
    accessibleLabel: 'Enable {name}',
    prompt: 'Enable this workflow?',
    confirm: 'Enable workflow',
    success: 'Workflow enabled.',
  },
  disable: {
    label: 'Disable',
    accessibleLabel: 'Disable {name}',
    prompt: 'Disable this workflow? Runs picked up while it is disabled are skipped.',
    confirm: 'Disable workflow',
    success: 'Workflow disabled.',
  },
  delete: {
    label: 'Delete',
    accessibleLabel: 'Delete {name}',
    prompt: 'Delete this workflow? Pending runs will be canceled. This cannot be undone.',
    confirm: 'Delete workflow',
    success: 'Workflow deleted.',
  },
} as const

type Action = keyof typeof actions
type Selection = { action: Action; workflow: Workflow }
const failures = {
  stale: 'This workflow changed. Review the latest version before trying again.',
  context: 'Your space changed. Reload before making changes.',
  unavailable: 'This workflow is unavailable.',
  failed: 'Could not update this workflow. Review the list before trying again.',
} as const
type Notice = Action | keyof typeof failures

const sameOwner = (left: Owner, right: Owner) => left.kind === right.kind && left.id === right.id
const isAction = (notice: Notice): notice is Action => notice in actions

export default function WorkflowsPage() {
  const { t } = useI18n()
  const me = useMe()
  const access = useTeamManagementAccess()
  const permissions = useTeamPagePermissions()
  const pageStart = useRef<HTMLDivElement>(null)
  const { id: organizationId, personal } = me.organization
  const inSession = me.principal.kind === 'session'
  const fixed = inSession && (personal || (access.status === 'ready' && access.role !== null))
  const canRead = permissions.status === 'ready' ? permissions.allows('workflows.read') : fixed
  const canCreate = permissions.status === 'ready' ? permissions.allows('workflows.create') : fixed
  const canPreview = permissions.status === 'ready' && permissions.allows('workflows.preview')
  const focusPageStart = () => pageStart.current?.focus()
  usePageTitle('Workflows')

  return (
    <>
      <div ref={pageStart} tabIndex={-1}>
        <PageHeader title={t('Workflows')}>
          {(canCreate || canPreview) && (
            <Link className="button button-primary" to={PATHS.newWorkflow}>
              {t(canCreate ? 'New workflow' : 'Preview workflow')}
            </Link>
          )}
        </PageHeader>
      </div>
      {canRead ? (
        <WorkflowList
          key={`${me.user.id}:${organizationId}`}
          organizationId={organizationId}
          owner={
            personal ? { kind: 'personal', id: me.user.id } : { kind: 'team', id: organizationId }
          }
          focusPageStart={focusPageStart}
        />
      ) : permissions.status === 'fixed' && inSession && access.status === 'loading' ? (
        <PageSkeleton label="Loading workflows…" />
      ) : permissions.status === 'fixed' && access.status === 'error' ? (
        <ReadFailure retry={access.reload} />
      ) : canCreate || canPreview ? null : (
        <Unavailable />
      )}
    </>
  )
}

function Unavailable() {
  const { t } = useI18n()
  return (
    <p role="alert" className="alert alert-error">
      {t('Workflows are unavailable in this space.')}
    </p>
  )
}

function ReadFailure({ retry }: { retry: () => void }) {
  const { t } = useI18n()
  return (
    <div className="alert alert-error" role="alert">
      <p>{t('Could not load workflows.')}</p>
      <button className="button button-small" type="button" onClick={retry}>
        {t('Try again')}
      </button>
    </div>
  )
}

function WorkflowList({
  organizationId,
  owner,
  focusPageStart,
}: {
  organizationId: string
  owner: Owner
  focusPageStart: () => void
}) {
  const { t } = useI18n()
  const { confirmReload } = useSession()
  const [cursors, setCursors] = useState<string[]>([])
  const [version, setVersion] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const cursor = cursors.at(-1)
  const failure = notice && !isAction(notice) ? failures[notice] : null
  const success = notice && isAction(notice) ? actions[notice].success : null

  function moveTo(next: string[]) {
    setCursors(next)
    setNotice(null)
    focusPageStart()
  }

  function settled(result: Notice) {
    setNotice(result)
    if (result === 'delete') setCursors([])
    setVersion((current) => current + 1)
    focusPageStart()
  }

  return (
    <>
      {failure && (
        <div className="alert alert-error" role="alert">
          <p>{t(failure)}</p>
          {notice === 'context' && (
            <button className="button button-small" type="button" onClick={confirmReload}>
              {t('Reload')}
            </button>
          )}
        </div>
      )}
      {success && (
        <p className="alert alert-info" role="status">
          {t(success)}
        </p>
      )}
      {notice !== 'context' && (
        <WorkflowListPage
          key={JSON.stringify([cursor, version])}
          owner={owner}
          organizationId={organizationId}
          cursor={cursor}
          previous={cursors.length ? () => moveTo(cursors.slice(0, -1)) : undefined}
          next={(nextCursor) => moveTo([...cursors, nextCursor])}
          settled={settled}
        />
      )}
    </>
  )
}

async function applyAction(
  { action, workflow }: Selection,
  organizationId: string,
  signal: AbortSignal,
): Promise<Notice> {
  const path = { id: workflow.id }
  try {
    const current = await unwrap(
      api.GET('/api/v1/workflows/{id}', {
        params: { path },
        signal,
        cache: 'no-store',
      }),
    )
    signal.throwIfAborted()
    if (current.id !== workflow.id || !sameOwner(current.owner, workflow.owner))
      return 'unavailable'
    // The live enabled flag can change without a content revision. Keep the confirmation
    // bound to the state the person saw, and let the server reject later revision races.
    if (current.revision !== workflow.revision || current.enabled !== workflow.enabled)
      return 'stale'
    const params = { path, header: { 'x-expected-organization-id': organizationId } }
    const expectedRevision = workflow.revision
    if (action === 'delete') {
      await unwrap(
        api.DELETE('/api/v1/workflows/{id}', { params, body: { expectedRevision }, signal }),
      )
    } else {
      await unwrap(
        api.PATCH('/api/v1/workflows/{id}', {
          params,
          body: { expectedRevision, enabled: action === 'enable' },
          signal,
        }),
      )
    }
    return action
  } catch (error) {
    if (isOrganizationContextChanged(error)) return 'context'
    if (error instanceof RequestError) {
      if (error.code === 'workflow_revision_conflict') return 'stale'
      if (error.status === 403 || error.status === 404) return 'unavailable'
    }
    return 'failed'
  }
}

function WorkflowListPage({
  owner,
  organizationId,
  cursor,
  previous,
  next,
  settled,
}: {
  owner: Owner
  organizationId: string
  cursor: string | undefined
  previous: (() => void) | undefined
  next: (cursor: string) => void
  settled: (notice: Notice) => void
}) {
  const { t } = useI18n()
  const permissions = useTeamPagePermissions()
  const canViewRuns = permissions.status === 'fixed' || permissions.allows('workflows.read_runs')
  const canEdit = permissions.status === 'fixed' || permissions.allows('workflows.update')
  const canAct = (action: Action) =>
    permissions.status === 'fixed' || permissions.allows(`workflows.${action}`)
  const { kind, id } = owner
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const page = await unwrap(
          api.GET('/api/v1/workflows', {
            params: { query: { ownerKind: kind, ownerId: id, cursor } },
            signal,
            cache: 'no-store',
          }),
        )
        if (page.data.some((workflow) => !sameOwner(workflow.owner, { kind, id })))
          throw new Error('Unexpected workflow owner')
        return page
      } catch (error) {
        if (error instanceof RequestError && error.status === 403) return null
        throw error
      }
    },
    [kind, id, cursor],
  )
  const [page, retry] = useLoad(load)
  const [selected, setSelection] = useState<Selection | null>(null)
  const selection = selected && canAct(selected.action) ? selected : null
  const [busy, setBusy] = useState(false)
  const trigger = useRef<string | null>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const operation = useRef<AbortController | null>(null)
  const promptId = useId()

  useLayoutEffect(() => () => operation.current?.abort(), [])
  useEffect(() => {
    if (selection) cancel.current?.focus()
    else if (trigger.current) {
      document.getElementById(trigger.current)?.focus()
      trigger.current = null
    }
  }, [selection])

  async function confirm() {
    if (!selection || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    const result = await applyAction(selection, organizationId, controller.signal)
    if (!controller.signal.aborted) settled(result)
  }

  if (page.status === 'loading') return <PageSkeleton label="Loading workflows…" />
  if (page.status === 'error') return <ReadFailure retry={retry} />
  if (page.data === null) return <Unavailable />

  const { data, nextCursor } = page.data
  return (
    <>
      {data.length ? (
        <ul className="card-list plain-list">
          {data.map((workflow) => (
            <li key={workflow.id} className="panel card-item">
              <div className="card-main">
                <h2 id={`${promptId}-${workflow.id}`} className="card-title user-content">
                  {workflow.name}
                </h2>
                <p>{t(workflow.enabled ? 'Enabled' : 'Disabled')}</p>
              </div>
              {selection?.workflow.id === workflow.id ? (
                // biome-ignore lint/a11y/useSemanticElements: independent buttons, as in ConfirmAction
                <div
                  className="confirm"
                  role="group"
                  aria-labelledby={promptId}
                  aria-describedby={`${promptId}-${workflow.id}`}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && !busy) {
                      event.stopPropagation()
                      setSelection(null)
                    }
                  }}
                >
                  <p id={promptId}>{t(actions[selection.action].prompt)}</p>
                  <div className="confirm-buttons">
                    <button
                      className={`button button-small ${selection.action === 'delete' ? 'button-danger' : 'button-primary'}`}
                      type="button"
                      disabled={busy}
                      onClick={confirm}
                    >
                      {t(busy ? 'Updating workflow…' : actions[selection.action].confirm)}
                    </button>
                    <button
                      ref={cancel}
                      className="button button-small"
                      type="button"
                      disabled={busy}
                      onClick={() => setSelection(null)}
                    >
                      {t('Cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="card-actions">
                  {selection === null && (
                    <>
                      {canViewRuns && (
                        <Link
                          className="button button-small"
                          to={workflowRunHistoryPath(workflow.id)}
                          aria-label={t('Run history for {name}', { name: workflow.name })}
                        >
                          {t('Run history')}
                        </Link>
                      )}
                      <Link
                        className="button button-small"
                        to={workflowEditPath(workflow.id)}
                        aria-label={canEdit ? t('Edit {name}', { name: workflow.name }) : undefined}
                        aria-describedby={canEdit ? undefined : `${promptId}-${workflow.id}`}
                      >
                        {t(canEdit ? 'Edit' : 'Details')}
                      </Link>
                    </>
                  )}
                  {([workflow.enabled ? 'disable' : 'enable', 'delete'] as const)
                    .filter(canAct)
                    .map((action) => (
                      <button
                        key={action}
                        id={`${promptId}-${workflow.id}-${action}`}
                        className="button button-small"
                        type="button"
                        aria-label={t(actions[action].accessibleLabel, { name: workflow.name })}
                        disabled={selection !== null}
                        onClick={(event) => {
                          trigger.current = event.currentTarget.id
                          setSelection({ action, workflow })
                        }}
                      >
                        {t(actions[action].label)}
                      </button>
                    ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t('No workflows yet.')} />
      )}
      {(previous || nextCursor) && (
        <nav className="form-actions" aria-label={t('Workflow pages')}>
          <button
            className="button"
            type="button"
            onClick={previous}
            disabled={!previous || !!selection}
          >
            {t('Previous page')}
          </button>
          <button
            className="button"
            type="button"
            onClick={() => nextCursor && next(nextCursor)}
            disabled={!nextCursor || !!selection}
          >
            {t('Next page')}
          </button>
        </nav>
      )}
    </>
  )
}
