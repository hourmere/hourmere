import type { Page, Route } from '@playwright/test'
import type { components } from '../../apps/web/src/api/schema.d.ts'
import { admin as english } from '../../apps/web/src/i18n/catalogues/en/admin.ts'
import { admin as chinese } from '../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { PATHS } from '../../apps/web/src/paths.ts'
import { AUDIT_NOW } from './audit-data.ts'
import type { FixtureApp } from './fixtures.ts'

export const workflowAuditPages = [
  { id: 'workflows', title: 'Personal workflows' },
  { id: 'team-workflows', title: 'Team workflows' },
  { id: 'workflows-empty', title: 'Empty workflow list' },
  { id: 'workflows-loading', title: 'Loading workflows' },
  { id: 'workflows-forbidden', title: 'Workflow list without permission' },
  { id: 'workflows-error', title: 'Workflow list load error' },
  { id: 'workflows-enable-confirm', title: 'Confirm enabling a workflow' },
  { id: 'workflows-disable-confirm', title: 'Confirm disabling a workflow' },
  { id: 'workflows-delete-confirm', title: 'Confirm deleting a workflow' },
  { id: 'workflows-updating', title: 'Updating a workflow' },
  { id: 'workflows-enabled', title: 'Workflow enabled' },
  { id: 'workflows-disabled', title: 'Workflow disabled' },
  { id: 'workflows-deleted', title: 'Workflow deleted' },
  { id: 'workflows-stale', title: 'Workflow revision conflict' },
  { id: 'workflows-context-changed', title: 'Workflow space changed' },
  { id: 'workflows-unavailable', title: 'Workflow unavailable during update' },
  { id: 'workflows-update-error', title: 'Workflow update error' },
] as const

type Schemas = components['schemas']
export type WorkflowAuditPageId = (typeof workflowAuditPages)[number]['id']

export function isWorkflowAuditPage(id: string): id is WorkflowAuditPageId {
  return workflowAuditPages.some((entry) => entry.id === id)
}

const pending = new WeakMap<Page, () => Promise<void>>()

export async function leavePendingWorkflowAudit(page: Page, origin: string) {
  const release = pending.get(page)
  if (!release) return
  await page.goto(`${origin}/favicon.svg`)
  await release()
  pending.delete(page)
}

export const AUDIT_WORKFLOW_NAME = 'SyntheticAppointmentFollowUp'.repeat(6)
const draftName = 'Draft workflow / 工作流草稿'
const changedName = 'Updated appointment follow-up / 更新后的预约跟进'
const workflowId = '72400000-0000-4000-8000-000000000001'
const draftId = '72400000-0000-4000-8000-000000000002'

function matchesList(origin: string) {
  return (url: URL) => url.origin === origin && url.pathname === '/api/v1/workflows'
}

/** Exercise the generated client without changing the server's workflow availability. */
export async function mockWorkflowAudit(page: Page, app: FixtureApp, state: WorkflowAuditPageId) {
  const fixture = await app.auditState()
  const team = state === 'team-workflows'
  const organizationId = team ? fixture.teamOrganizationId : fixture.organizationId
  const owner: Schemas['WorkflowOwner'] = {
    kind: team ? 'team' : 'personal',
    id: team ? organizationId : fixture.userId,
  }
  const workflow: Schemas['Workflow'] = {
    id: workflowId,
    owner,
    name: AUDIT_WORKFLOW_NAME,
    enabled: true,
    revision: 2,
    scope: { type: 'all_event_types' },
    trigger: { type: 'after_end', offsetMinutes: 30 },
    actions: [{ type: 'email', recipients: ['booker'] }],
    conditions: [],
    createdAt: AUDIT_NOW,
    updatedAt: AUDIT_NOW,
  }
  const rows = [
    workflow,
    { ...workflow, id: draftId, name: draftName, enabled: false, revision: 1 },
  ]
  const list = async (route: Route) => {
    const query = new URL(route.request().url()).searchParams
    if (query.get('ownerKind') !== owner.kind || query.get('ownerId') !== owner.id)
      return route.fulfill({ status: 403, json: { error: 'insufficient_role' } })
    if (state === 'workflows-loading') return
    if (state === 'workflows-error') return route.abort()
    if (state === 'workflows-forbidden')
      return route.fulfill({ status: 403, json: { error: 'insufficient_role' } })
    const data = state === 'workflows-empty' ? [] : rows
    return route.fulfill({ json: { data, nextCursor: null } satisfies Schemas['WorkflowPage'] })
  }
  const detail = async (route: Route) => {
    const request = route.request()
    const index = rows.findIndex(({ id }) => request.url().endsWith(`/${id}`))
    const row = rows[index]
    if (!row || state === 'workflows-unavailable')
      return route.fulfill({ status: 404, json: { error: 'workflow_not_found' } })
    if (request.method() === 'GET') return route.fulfill({ json: row })

    const body = request.postDataJSON() as { expectedRevision: number; enabled?: boolean }
    if ((await request.headerValue('x-expected-organization-id')) !== organizationId)
      return route.fulfill({ status: 409, json: { error: 'organization_context_changed' } })
    if (state === 'workflows-updating') return
    if (state === 'workflows-update-error') return route.abort()
    if (state === 'workflows-context-changed')
      return route.fulfill({ status: 409, json: { error: 'organization_context_changed' } })
    if (state === 'workflows-stale' || body.expectedRevision !== row.revision) {
      rows[index] = { ...row, name: changedName, revision: row.revision + 1 }
      return route.fulfill({ status: 409, json: { error: 'workflow_revision_conflict' } })
    }
    if (request.method() === 'DELETE') {
      rows.splice(index, 1)
      return route.fulfill({ status: 204 })
    }
    if (request.method() === 'PATCH' && typeof body.enabled === 'boolean') {
      rows[index] = { ...row, enabled: body.enabled }
      return route.fulfill({ json: rows[index] })
    }
    return route.abort()
  }

  const instance: Schemas['Instance'] = {
    hostedSignupUrl: 'https://hourmere.com',
    publicUrl: app.url,
    workflowsEnabled: true,
    signIn: { email: true, google: false, microsoft: false },
  }
  const mocks: [string | ((url: URL) => boolean), (route: Route) => Promise<void>][] = [
    [`${app.url}/api/v1/instance`, (route) => route.fulfill({ json: instance })],
    [matchesList(app.url), list],
    [`${app.url}/api/v1/workflows/${workflowId}`, detail],
    [`${app.url}/api/v1/workflows/${draftId}`, detail],
  ]
  for (const [url, handler] of mocks) await page.route(url, handler)
  return async () => {
    for (const [url, handler] of mocks) await page.unroute(url, handler)
  }
}

export async function openWorkflowAuditPage(
  page: Page,
  app: FixtureApp,
  state: WorkflowAuditPageId,
  locale: 'en' | 'zh-CN',
) {
  const copy = (key: keyof typeof english & keyof typeof chinese) =>
    locale === 'zh-CN' ? chinese[key] : english[key]
  const release = await mockWorkflowAudit(page, app, state)
  const path = PATHS.workflows
  try {
    await Promise.all([
      state === 'workflows-loading' &&
        page.waitForRequest((request) => matchesList(app.url)(new URL(request.url()))),
      page.goto(app.url + path),
    ])
    const main = page.getByRole('main')
    await main.getByRole('heading', { name: copy('Workflows'), exact: true }).waitFor()
    const waitForText = (text: string) => main.getByText(text, { exact: true }).waitFor()
    switch (state) {
      case 'workflows-empty':
        await waitForText(copy('No workflows yet.'))
        break
      case 'workflows-loading':
        await main.getByRole('status', { name: copy('Loading workflows…') }).waitFor()
        pending.set(page, release)
        break
      case 'workflows-forbidden':
        await waitForText(copy('Workflows are unavailable in this space.'))
        break
      case 'workflows-error':
        await waitForText(copy('Could not load workflows.'))
        break
      default: {
        await waitForText(AUDIT_WORKFLOW_NAME)
        if (state === 'workflows' || state === 'team-workflows') break
        const enable = state === 'workflows-enable-confirm' || state === 'workflows-enabled'
        const remove = state === 'workflows-delete-confirm' || state === 'workflows-deleted'
        const label = enable ? 'Enable {name}' : remove ? 'Delete {name}' : 'Disable {name}'
        await main
          .getByRole('button', {
            name: copy(label).replace('{name}', enable ? draftName : AUDIT_WORKFLOW_NAME),
            exact: true,
          })
          .press('Enter')
        const confirm = main.getByRole('button', {
          name: copy(enable ? 'Enable workflow' : remove ? 'Delete workflow' : 'Disable workflow'),
          exact: true,
        })
        await confirm.waitFor()
        if (state.endsWith('-confirm')) break
        await confirm.press('Enter')
        if (state === 'workflows-updating') {
          await waitForText(copy('Updating workflow…'))
          pending.set(page, release)
        } else if (
          state === 'workflows-enabled' ||
          state === 'workflows-disabled' ||
          state === 'workflows-deleted'
        ) {
          const notice =
            state === 'workflows-enabled'
              ? 'Workflow enabled.'
              : state === 'workflows-disabled'
                ? 'Workflow disabled.'
                : 'Workflow deleted.'
          await waitForText(copy(notice))
          await waitForText(draftName)
        } else if (state === 'workflows-stale') {
          await waitForText(
            copy('This workflow changed. Review the latest version before trying again.'),
          )
          await waitForText(changedName)
        } else if (state === 'workflows-context-changed') {
          await waitForText(copy('Your space changed. Reload before making changes.'))
        } else if (state === 'workflows-unavailable') {
          await waitForText(copy('This workflow is unavailable.'))
        } else {
          await waitForText(
            copy('Could not update this workflow. Review the list before trying again.'),
          )
        }
      }
    }
    return path
  } finally {
    if (!pending.has(page)) await release()
  }
}
