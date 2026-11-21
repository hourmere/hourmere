import { type ReactNode, useCallback } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { EmptyState } from '../../components/EmptyState.tsx'
import { OrganizationContextConflict } from '../../components/OrganizationContextConflict.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { useLoad, usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { PATHS, routingFormPath } from '../../paths.ts'
import { useMe } from '../../session.tsx'
import { useTeamManagementAccess } from '../../team-management.tsx'
import { RoutingFormEditor } from './RoutingFormEditor.tsx'
import { getRoutingForm, listRoutingForms } from './routing-form-api.ts'

const formId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export function RoutingFormsPage() {
  const { t } = useI18n()
  const me = useMe()
  usePageTitle('Routing forms')
  return (
    <>
      <PageHeader title={t('Routing forms')} />
      <ManagerAccess list>
        <RoutingFormList
          key={`${me.user.id}:${me.organization.id}`}
          organizationId={me.organization.id}
        />
      </ManagerAccess>
    </>
  )
}

export function NewRoutingFormPage() {
  const { t } = useI18n()
  const me = useMe()
  usePageTitle('New routing form')
  return (
    <div data-testid="routing-form-new">
      <BackToList />
      <PageHeader title={t('New routing form')} />
      <ManagerAccess>
        <RoutingFormEditor
          key={`${me.user.id}:${me.organization.id}`}
          organizationId={me.organization.id}
          personalOwnerId={me.organization.personal ? me.user.id : null}
        />
      </ManagerAccess>
    </div>
  )
}

export function EditRoutingFormPage() {
  const { t } = useI18n()
  const me = useMe()
  const { id = '' } = useParams()
  const [query] = useSearchParams()
  const spaces = query.getAll('organizationId')
  const organizationId = me.organization.id
  usePageTitle('Edit routing form')
  return (
    <>
      <BackToList />
      <PageHeader title={t('Edit routing form')} />
      <ManagerAccess>
        {formId.test(id) &&
        (spaces.length === 0 || (spaces.length === 1 && spaces[0] === organizationId)) ? (
          <RoutingFormEdit
            key={`${me.user.id}:${organizationId}:${id}`}
            id={id}
            organizationId={organizationId}
            personalOwnerId={me.organization.personal ? me.user.id : null}
          />
        ) : (
          <UnavailableForm />
        )}
      </ManagerAccess>
    </>
  )
}

function BackToList() {
  const { t } = useI18n()
  return (
    <p className="breadcrumb">
      <Link to={PATHS.routingForms}>{t('Back to routing forms')}</Link>
    </p>
  )
}

function ManagerAccess({ list = false, children }: { list?: boolean; children: ReactNode }) {
  const { t } = useI18n()
  const me = useMe()
  const access = useTeamManagementAccess()
  if (me.principal.kind !== 'session')
    return (
      <Denied list={list}>{t('Use a browser session without an Authorization header.')}</Denied>
    )
  if (me.organization.personal) return children
  if (access.status === 'loading') return <Loading list={list} />
  if (access.status === 'error') return <LoadError list={list} retry={access.reload} />
  if (!access.role)
    return (
      <Denied list={list}>
        {t('Only team owners and admins can manage routing forms in this space.')}
      </Denied>
    )
  return children
}

function Loading({ list }: { list: boolean }) {
  return (
    <div data-testid={list ? 'routing-forms-loading' : 'routing-form-loading'}>
      <PageSkeleton label={list ? 'Loading routing forms…' : 'Loading routing form…'} />
    </div>
  )
}

function Denied({ list, children }: { list: boolean; children: ReactNode }) {
  return (
    <p
      className="alert alert-error"
      role="alert"
      data-testid={list ? 'routing-forms-denied' : 'routing-form-denied'}
    >
      {children}
    </p>
  )
}

function LoadError({ list, retry }: { list: boolean; retry: () => void }) {
  const { t } = useI18n()
  return (
    <div
      className="alert alert-error"
      role="alert"
      data-testid={list ? 'routing-forms-error' : 'routing-form-error'}
    >
      <p>{list ? t('Could not load routing forms.') : t('Could not load this routing form.')}</p>
      <button type="button" className="button button-small" onClick={retry}>
        {t('Try again')}
      </button>
    </div>
  )
}

function UnavailableForm() {
  const { t } = useI18n()
  return <p data-testid="routing-form-missing">{t('This routing form is unavailable.')}</p>
}

function loadResult<T>(request: Promise<T>) {
  return request.then(
    (value) => ({ value }) as const,
    (error: unknown) => {
      if (error instanceof RequestError) return { error } as const
      throw error
    },
  )
}

function RoutingFormList({ organizationId }: { organizationId: string }) {
  const { t } = useI18n()
  const load = useCallback(
    (signal: AbortSignal) => loadResult(listRoutingForms(organizationId, signal)),
    [organizationId],
  )
  const [state, retry] = useLoad(load)
  if (state.status === 'loading') return <Loading list />
  if (state.status === 'error') return <LoadError list retry={retry} />
  if ('error' in state.data) return <LoadFailure list error={state.data.error} retry={retry} />

  const { data } = state.data.value
  return (
    <>
      <div className="form-actions">
        <Link to={PATHS.newRoutingForm} className="button button-primary">
          {t('New routing form')}
        </Link>
      </div>
      {data.length ? (
        <ul className="card-list plain-list" data-testid="routing-forms-list">
          {data.map((form) => (
            <li className="panel card-item" key={form.id}>
              <div className="card-main">
                <h2 className="card-title">
                  <Link className="user-content" to={routingFormPath(form.id, organizationId)}>
                    {form.title}
                  </Link>
                </h2>
                <p className="muted user-content">{form.slug}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div data-testid="routing-forms-empty">
          <EmptyState title={t('No routing forms yet.')} />
        </div>
      )}
    </>
  )
}

function RoutingFormEdit({
  organizationId,
  id,
  personalOwnerId,
}: {
  organizationId: string
  id: string
  personalOwnerId: string | null
}) {
  const load = useCallback(
    (signal: AbortSignal) => loadResult(getRoutingForm(organizationId, id, signal)),
    [organizationId, id],
  )
  const [state, reload] = useLoad(load)
  if (state.status === 'loading') return <Loading list={false} />
  if (state.status === 'error') return <LoadError list={false} retry={reload} />
  if ('error' in state.data) {
    if (state.data.error.status === 404) return <UnavailableForm />
    return <LoadFailure list={false} error={state.data.error} retry={reload} />
  }

  const form = state.data.value
  return (
    <RoutingFormEditor
      key={form.draftRevision}
      organizationId={organizationId}
      personalOwnerId={personalOwnerId}
      form={form}
      reload={reload}
    />
  )
}

function LoadFailure({ list, error, retry }: { list: boolean; error: unknown; retry: () => void }) {
  const { t } = useI18n()
  if (isOrganizationContextChanged(error)) return <OrganizationContextConflict error={error} />
  if (error instanceof RequestError && error.status === 403)
    return <Denied list={list}>{t("You don't have permission to do that.")}</Denied>
  return <LoadError list={list} retry={retry} />
}
