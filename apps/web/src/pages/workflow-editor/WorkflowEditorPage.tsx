import { useCallback, useState } from 'react'
import { Link, useParams } from 'react-router'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import { loadEventTypes } from '../../api/resources.ts'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { useLoad, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { PATHS } from '../../paths.ts'
import { useMe } from '../../session.tsx'
import { useTeamManagementAccess } from '../../team-management.tsx'
import { isTeamWorkflowCondition } from './WorkflowAudienceFields.tsx'
import { WorkflowEditor } from './WorkflowEditor.tsx'
import './workflow-editor.css'

export function WorkflowEditorPage({
  followUpHostNotesEnabled,
}: {
  followUpHostNotesEnabled: boolean
}) {
  const { t } = useI18n()
  const { id } = useParams()
  const [version, setVersion] = useState(0)
  const me = useMe()
  const access = useTeamManagementAccess()
  const { id: organizationId, personal } = me.organization
  const title = id ? 'Edit workflow' : 'New workflow'
  const inSession = me.principal.kind === 'session'
  const manage = inSession && (personal || (access.status === 'ready' && access.role !== null))
  usePageTitle(title)

  return (
    <>
      {manage && (
        <p className="breadcrumb">
          <Link to={PATHS.workflows}>{t('Workflows')}</Link>
        </p>
      )}
      <PageHeader title={t(title)} />
      {manage ? (
        <EditorLoad
          key={JSON.stringify([me.user.id, organizationId, personal, id, version])}
          id={id}
          ownerKind={personal ? 'personal' : 'team'}
          ownerId={personal ? me.user.id : organizationId}
          organizationId={organizationId}
          followUpHostNotesEnabled={followUpHostNotesEnabled}
          reload={() => setVersion((current) => current + 1)}
        />
      ) : inSession && access.status === 'loading' ? (
        <PageSkeleton label="Loading workflow editor…" />
      ) : inSession && access.status === 'error' ? (
        <EditorLoadError retry={access.reload} />
      ) : (
        <EditorUnavailable />
      )}
    </>
  )
}

function EditorLoad({
  id,
  ownerKind,
  ownerId,
  organizationId,
  followUpHostNotesEnabled,
  reload,
}: {
  id: string | undefined
  ownerKind: Schemas['WorkflowOwner']['kind']
  ownerId: string
  organizationId: string
  followUpHostNotesEnabled: boolean
  reload: () => void
}) {
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const workflow = id
          ? await unwrap(
              api.GET('/api/v1/workflows/{id}', {
                params: { path: { id } },
                signal,
                cache: 'no-store',
              }),
            )
          : null
        if (workflow) {
          if (
            workflow.id !== id ||
            workflow.owner.kind !== ownerKind ||
            workflow.owner.id !== ownerId ||
            (ownerKind === 'team' && !workflow.conditions.every(isTeamWorkflowCondition))
          )
            return null
        }
        signal.throwIfAborted()
        const eventTypes = (await loadEventTypes(signal)).filter(
          (event) =>
            event.organizationId === organizationId &&
            event.ownerUserId === (ownerKind === 'personal' ? ownerId : null) &&
            event.bookingMode === 'individual',
        )
        return { workflow, eventTypes }
      } catch (error) {
        if (error instanceof RequestError && (error.status === 403 || error.status === 404))
          return null
        throw error
      }
    },
    [id, ownerKind, ownerId, organizationId],
  )
  const [state, retry] = useLoad(load)

  if (state.status === 'loading') return <PageSkeleton label="Loading workflow editor…" />
  if (state.status === 'error') return <EditorLoadError retry={retry} />
  if (!state.data) return <EditorUnavailable />

  return (
    <WorkflowEditor
      {...state.data}
      owner={{ kind: ownerKind, id: ownerId }}
      organizationId={organizationId}
      followUpHostNotesEnabled={followUpHostNotesEnabled}
      reload={reload}
    />
  )
}

function EditorLoadError({ retry }: { retry: () => void }) {
  const { t } = useI18n()
  return (
    <div className="alert alert-error" role="alert">
      <p>{t('Could not load the workflow editor.')}</p>
      <button className="button button-small" type="button" onClick={retry}>
        {t('Try again')}
      </button>
    </div>
  )
}

function EditorUnavailable() {
  const { t } = useI18n()
  return (
    <p className="alert alert-error" role="alert">
      {t('This workflow is unavailable.')}
    </p>
  )
}
