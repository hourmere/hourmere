import type { Page, Route } from '@playwright/test'
import type { components, operations } from '../../apps/web/src/api/schema.d.ts'
import { admin as english } from '../../apps/web/src/i18n/catalogues/en/admin.ts'
import { admin as chinese } from '../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { PATHS, workflowEditPath } from '../../apps/web/src/paths.ts'
import { AUDIT_NOW } from './audit-data.ts'
import type { FixtureApp } from './fixtures.ts'

export const workflowEditorAuditPages = [
  { id: 'workflow-create', title: 'Create a personal workflow' },
  { id: 'team-workflow-edit', title: 'Edit a team workflow with a webhook' },
  { id: 'workflow-edit-built-in', title: 'Edit a workflow with built-in text only' },
  { id: 'workflow-edit-loading', title: 'Loading a workflow for editing' },
  { id: 'workflow-edit-forbidden', title: 'Workflow editor without permission' },
  { id: 'workflow-edit-error', title: 'Workflow editor load error' },
  { id: 'workflow-webhooks-loading', title: 'Loading workflow webhook endpoints' },
  { id: 'workflow-webhooks-empty', title: 'No eligible workflow webhook endpoints' },
  { id: 'workflow-webhooks-forbidden', title: 'Workflow webhook endpoints without permission' },
  { id: 'workflow-webhooks-error', title: 'Workflow webhook endpoints load error' },
  { id: 'workflow-preview-loading', title: 'Generating a workflow preview' },
  { id: 'workflow-preview', title: 'Rendered workflow preview' },
  { id: 'workflow-preview-fallback', title: 'Workflow preview with a locale fallback' },
  { id: 'workflow-preview-scope-mismatch', title: 'Workflow preview skipped by scope' },
  { id: 'workflow-preview-condition-false', title: 'Workflow preview skipped by conditions' },
  { id: 'workflow-preview-error', title: 'Workflow preview error' },
  { id: 'workflow-save-pending', title: 'Saving a workflow' },
  { id: 'workflow-save-stale', title: 'Workflow editor revision conflict' },
  { id: 'workflow-save-context-changed', title: 'Workflow editor space changed' },
  { id: 'workflow-save-error', title: 'Workflow editor save error' },
] as const

type Schemas = components['schemas']
type PreviewInput = operations['previewWorkflow']['requestBody']['content']['application/json']
export type WorkflowEditorAuditPageId = (typeof workflowEditorAuditPages)[number]['id']

export function isWorkflowEditorAuditPage(id: string): id is WorkflowEditorAuditPageId {
  return workflowEditorAuditPages.some((entry) => entry.id === id)
}

const pending = new WeakMap<Page, () => Promise<void>>()

export async function leavePendingWorkflowEditorAudit(page: Page, origin: string) {
  const release = pending.get(page)
  if (!release) return
  await page.goto(`${origin}/favicon.svg`)
  await release()
  pending.delete(page)
}

export const AUDIT_EDITOR_WORKFLOW_ID = '72500000-0000-4000-8000-000000000001'
export const AUDIT_EDITOR_WORKFLOW_NAME = 'Follow up after a consultation / 咨询后的跟进'
export const AUDIT_WORKFLOW_WEBHOOK_URL = `https://hourmere.invalid/${'syntheticWorkflowEndpoint'.repeat(7)}`
const webhookId = '72500000-0000-4000-8000-000000000002'
const createdId = '72500000-0000-4000-8000-000000000003'
const renderedSubject = 'Consultation follow-up / 咨询跟进'
const renderedText = `Thanks for joining the synthetic consultation.\n${'ConsultationFollowUp'.repeat(12)}`

/** Provide synthetic workflow responses while the fixture server stays hard-off. */
export async function mockWorkflowEditorAudit(
  page: Page,
  app: FixtureApp,
  state: WorkflowEditorAuditPageId,
) {
  const fixture = await app.auditState()
  const team = state === 'team-workflow-edit'
  const webhookAction = team || state.startsWith('workflow-webhooks-')
  const organizationId = team ? fixture.teamOrganizationId : fixture.organizationId
  const owner: Schemas['WorkflowOwner'] = {
    kind: team ? 'team' : 'personal',
    id: team ? organizationId : fixture.userId,
  }
  const instance: Schemas['Instance'] = {
    hostedSignupUrl: 'https://hourmere.com',
    publicUrl: app.url,
    workflowsEnabled: true,
    followUpHostNotesEnabled: state !== 'workflow-edit-built-in',
    signIn: { email: true, google: false, microsoft: false },
  }
  const endpoint: Schemas['Webhook'] = {
    id: webhookId,
    organizationId,
    isActive: true,
    events: ['workflow.executed'],
    url: AUDIT_WORKFLOW_WEBHOOK_URL,
    createdAt: AUDIT_NOW,
    updatedAt: AUDIT_NOW,
  }
  const workflow: Schemas['Workflow'] = {
    id: AUDIT_EDITOR_WORKFLOW_ID,
    owner,
    name: AUDIT_EDITOR_WORKFLOW_NAME,
    enabled: false,
    revision: 2,
    scope: { type: 'all_event_types' },
    trigger: { type: 'after_end', offsetMinutes: 30 },
    conditions: team
      ? [{ field: 'guest_count', operator: 'at_least', value: 1 }]
      : [
          {
            field: 'booking_source',
            operator: 'equals',
            value: state === 'workflow-preview-condition-false' ? 'api' : 'web',
          },
        ],
    actions: webhookAction
      ? [{ type: 'webhook', webhookId }]
      : [
          {
            type: 'email',
            recipients: ['booker', 'hosts'],
            content: { en: { subject: renderedSubject, body: renderedText } },
          },
        ],
    createdAt: AUDIT_NOW,
    updatedAt: AUDIT_NOW,
  }
  const rows = new Map([[workflow.id, workflow]])
  const stale = { ...workflow, revision: 3, name: 'Recently updated workflow / 最近更新的工作流' }
  const matchOwner = (actual: Schemas['WorkflowOwner']) =>
    actual.kind === owner.kind && actual.id === owner.id
  const expectedOrganization = async (route: Route) =>
    (await route.request().headerValue('x-expected-organization-id')) === organizationId
  const deny = (route: Route) =>
    route.fulfill({ status: 403, json: { error: 'team_management_access_denied' } })
  const contextChanged = (route: Route) =>
    route.fulfill({ status: 409, json: { error: 'organization_context_changed' } })
  const collection = async (route: Route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      const query = new URL(request.url()).searchParams
      if (query.get('ownerKind') !== owner.kind || query.get('ownerId') !== owner.id)
        return deny(route)
      return route.fulfill({
        json: { data: [...rows.values()], nextCursor: null } satisfies Schemas['WorkflowPage'],
      })
    }
    if (request.method() !== 'POST') return route.abort()
    if (!(await expectedOrganization(route))) return contextChanged(route)
    const {
      owner: requested,
      name,
      scope,
      trigger,
      actions,
      conditions,
      enabled,
    } = request.postDataJSON() as Schemas['CreateWorkflowInput']
    if (!matchOwner(requested)) return deny(route)
    const record: Schemas['Workflow'] = {
      ...workflow,
      id: createdId,
      revision: 1,
      name,
      scope,
      trigger,
      actions,
      conditions: conditions ?? [],
      enabled: enabled ?? false,
    }
    rows.set(record.id, record)
    return route.fulfill({ status: 201, json: record })
  }
  const detail = async (route: Route) => {
    const request = route.request()
    const id = new URL(request.url()).pathname.split('/').at(-1)
    const row = id ? rows.get(id) : undefined
    if (!row) return route.fulfill({ status: 404, json: { error: 'workflow_not_found' } })
    if (request.method() === 'GET') {
      if (state === 'workflow-edit-loading') return
      if (state === 'workflow-edit-forbidden') return deny(route)
      if (state === 'workflow-edit-error') return route.abort()
      return route.fulfill({ json: row })
    }
    if (request.method() !== 'PATCH') return route.abort()
    if (!(await expectedOrganization(route)) || state === 'workflow-save-context-changed')
      return contextChanged(route)
    if (state === 'workflow-save-pending') return
    if (state === 'workflow-save-error') return route.abort()
    const { expectedRevision, name, scope, trigger, actions, conditions, enabled } =
      request.postDataJSON() as Schemas['UpdateWorkflowInput']
    if (state === 'workflow-save-stale' || expectedRevision !== row.revision) {
      rows.set(row.id, stale)
      return route.fulfill({ status: 409, json: { error: 'workflow_revision_conflict' } })
    }
    const record: Schemas['Workflow'] = {
      ...row,
      name: name ?? row.name,
      scope: scope ?? row.scope,
      trigger: trigger ?? row.trigger,
      conditions: conditions ?? row.conditions,
      actions: actions ?? row.actions,
      enabled: enabled ?? row.enabled,
      revision: row.revision + 1,
    }
    rows.set(record.id, record)
    return route.fulfill({ json: record })
  }
  const preview = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.abort()
    if (!(await expectedOrganization(route))) return contextChanged(route)
    if (state === 'workflow-preview-loading') return
    if (state === 'workflow-preview-error') return route.abort()
    const body = route.request().postDataJSON() as PreviewInput
    if (!matchOwner(body.owner)) return deny(route)
    const action = body.actions[0]
    const locale = body.example?.locale ?? 'en'
    const custom = action?.type === 'email' && locale === 'en' ? action.content?.en : undefined
    const fallback = state === 'workflow-preview-fallback'
    const result: Schemas['WorkflowPreview'] = {
      synthetic: true,
      match:
        state === 'workflow-preview-scope-mismatch'
          ? 'scope_mismatch'
          : state === 'workflow-preview-condition-false'
            ? 'condition_false'
            : 'matched',
      emails:
        action?.type === 'email'
          ? action.recipients.map((recipientClass) => ({
              recipientClass,
              locale,
              templateLocale: locale,
              contentSource: custom ? 'custom' : 'built_in',
              subject: custom?.subject ?? renderedSubject,
              text: custom?.body ?? renderedText,
              html: '<p>Synthetic preview</p>',
              ...(fallback && { fallback: 'missing_translation' }),
            }))
          : [],
      estimates: {
        emailRecipientClasses: action?.type === 'email' ? action.recipients.length : 0,
        webhookDeliveriesPerMatch: action?.type === 'webhook' ? 1 : 0,
      },
    }
    return route.fulfill({ json: result })
  }

  const workflowUrl = `${app.url}/api/v1/workflows`
  const routes = new Map<string | ((url: URL) => boolean), (route: Route) => Promise<void>>([
    [`${app.url}/api/v1/instance`, (route) => route.fulfill({ json: instance })],
    [(url) => `${url.origin}${url.pathname}` === workflowUrl, collection],
    [`${workflowUrl}/${workflow.id}`, detail],
    [`${workflowUrl}/${createdId}`, detail],
    [`${workflowUrl}/preview`, preview],
    [
      `${app.url}/api/v1/webhooks`,
      async (route) => {
        if (!(await expectedOrganization(route))) return contextChanged(route)
        if (state === 'workflow-webhooks-loading') return
        if (state === 'workflow-webhooks-error') return route.abort()
        if (state === 'workflow-webhooks-forbidden') return deny(route)
        return route.fulfill({ json: state === 'workflow-webhooks-empty' ? [] : [endpoint] })
      },
    ],
  ])
  for (const [url, handler] of routes) await page.route(url, handler)
  return async () => {
    for (const [url, handler] of routes) {
      if (page.isClosed()) return
      await page.unroute(url, handler)
    }
  }
}

export async function openWorkflowEditorAuditPage(
  page: Page,
  app: FixtureApp,
  state: WorkflowEditorAuditPageId,
  locale: 'en' | 'zh-CN',
) {
  const copy = locale === 'zh-CN' ? chinese : english
  const release = await mockWorkflowEditorAudit(page, app, state)
  const create = state === 'workflow-create'
  const path = create ? PATHS.newWorkflow : workflowEditPath(AUDIT_EDITOR_WORKFLOW_ID)
  try {
    await Promise.all([
      state === 'workflow-edit-loading' &&
        page.waitForRequest(`${app.url}/api/v1/workflows/${AUDIT_EDITOR_WORKFLOW_ID}`),
      state === 'workflow-webhooks-loading' && page.waitForRequest(`${app.url}/api/v1/webhooks`),
      page.goto(app.url + path),
    ])
    const main = page.getByRole('main')
    await main
      .getByRole('heading', { name: copy[create ? 'New workflow' : 'Edit workflow'] })
      .waitFor()
    const notice = (text: string) => main.getByText(text, { exact: true }).waitFor()
    const button = (name: string) => main.getByRole('button', { name, exact: true })
    switch (state) {
      case 'workflow-edit-loading':
        await main.getByRole('status', { name: copy['Loading workflow editor…'] }).waitFor()
        pending.set(page, release)
        break
      case 'workflow-edit-forbidden':
        await notice(copy['This workflow is unavailable.'])
        break
      case 'workflow-edit-error':
        await notice(copy['Could not load the workflow editor.'])
        break
      case 'workflow-create':
        await main.getByLabel(copy['Workflow name'], { exact: true }).waitFor()
        break
      case 'workflow-edit-built-in':
        await main
          .getByLabel(copy['Replace saved custom text with built-in text'], { exact: true })
          .waitFor()
        break
      case 'team-workflow-edit':
        await main
          .getByRole('combobox', { name: copy['Webhook endpoint'], exact: true })
          .locator('option:checked')
          .filter({ hasText: AUDIT_WORKFLOW_WEBHOOK_URL })
          .waitFor({ state: 'attached' })
        break
      case 'workflow-webhooks-loading':
        await notice(copy['Loading webhook endpoints…'])
        pending.set(page, release)
        break
      case 'workflow-webhooks-empty':
        await notice(copy['No active endpoints subscribe to workflow deliveries.'])
        break
      case 'workflow-webhooks-forbidden':
        await notice(copy['Webhook endpoints are unavailable.'])
        break
      case 'workflow-webhooks-error':
        await notice(copy['Could not load webhook endpoints.'])
        break
      default: {
        const preview = state.startsWith('workflow-preview')
        const pendingState =
          state === 'workflow-save-pending' || state === 'workflow-preview-loading'
        if (preview)
          await main
            .getByRole('combobox', { name: copy['Preview language'], exact: true })
            .selectOption(state === 'workflow-preview-fallback' ? 'zh-CN' : 'en')
        await Promise.all([
          pendingState &&
            page.waitForRequest(
              (request) =>
                request.method() === (preview ? 'POST' : 'PATCH') &&
                request.url() ===
                  `${app.url}/api/v1/workflows/${preview ? 'preview' : AUDIT_EDITOR_WORKFLOW_ID}`,
            ),
          button(copy[preview ? 'Preview workflow' : 'Save changes']).press('Enter'),
        ])
        if (pendingState) pending.set(page, release)
        await main.getByText(copy[resultMessages[state]], { exact: true }).first().waitFor()
      }
    }
    return path
  } finally {
    if (!pending.has(page)) await release()
  }
}

const resultMessages = {
  'workflow-preview-loading': 'Generating preview…',
  'workflow-preview': 'The example booking matches this workflow.',
  'workflow-preview-fallback': 'Built-in text is used because a custom translation is missing.',
  'workflow-preview-scope-mismatch': 'Skipped: the example booking is outside the workflow scope.',
  'workflow-preview-condition-false':
    'Skipped: the example booking does not meet the workflow conditions.',
  'workflow-preview-error': 'Could not preview the workflow. Try again.',
  'workflow-save-pending': 'Saving workflow…',
  'workflow-save-stale': 'This workflow changed. Review the latest version before trying again.',
  'workflow-save-context-changed': 'Your space changed. Reload before making changes.',
  'workflow-save-error': 'Could not save the workflow. Try again.',
} as const
