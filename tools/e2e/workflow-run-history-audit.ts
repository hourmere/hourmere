import type { Page, Route } from '@playwright/test'
import type { components } from '../../apps/web/src/api/schema.d.ts'
import { admin as english } from '../../apps/web/src/i18n/catalogues/en/admin.ts'
import { admin as chinese } from '../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { workflowRunHistoryPath } from '../../apps/web/src/paths.ts'
import { AUDIT_NOW } from './audit-data.ts'
import type { FixtureApp } from './fixtures.ts'

export const workflowRunHistoryAuditPages = [
  { id: 'workflow-run-history', title: 'Workflow run history with mail outcomes' },
  { id: 'team-workflow-run-history', title: 'Team workflow run history final page' },
  { id: 'workflow-run-history-empty', title: 'Empty workflow run history' },
  { id: 'workflow-run-history-loading', title: 'Loading workflow run history' },
  { id: 'workflow-run-history-error', title: 'Workflow run history load error' },
  { id: 'workflow-run-history-forbidden', title: 'Workflow run history without permission' },
] as const

type Schemas = components['schemas']
export type WorkflowRunHistoryAuditPageId = (typeof workflowRunHistoryAuditPages)[number]['id']

export function isWorkflowRunHistoryAuditPage(id: string): id is WorkflowRunHistoryAuditPageId {
  return workflowRunHistoryAuditPages.some((entry) => entry.id === id)
}

const pending = new WeakMap<Page, () => Promise<void>>()

export async function leavePendingWorkflowRunHistoryAudit(page: Page, origin: string) {
  const release = pending.get(page)
  if (!release) return
  await page.goto(`${origin}/favicon.svg`)
  await release()
  pending.delete(page)
}

export const AUDIT_HISTORY_WORKFLOW_ID = '72600000-0000-4000-8000-000000000001'
export const AUDIT_HISTORY_WORKFLOW_NAME = 'Appointment follow-up / 预约跟进'
const historyEndpoint = `/api/v1/workflows/${AUDIT_HISTORY_WORKFLOW_ID}/runs`
const nextCursor = 'synthetic_next-history-page'

const suppressed: Schemas['WorkflowRunHistoryEntry'] = {
  workflowId: AUDIT_HISTORY_WORKFLOW_ID,
  revision: 2,
  trigger: 'after_end',
  dueAt: '2030-01-07T09:45:00.000Z',
  finishedAt: '2030-01-07T09:46:00.000Z',
  outcome: 'skipped',
  reason: 'budget_suppressed',
  sent: 0,
  rejected: 0,
  deliveryUnknown: 0,
  skipped: 1,
}
const completed: Schemas['WorkflowRunHistoryEntry'] = {
  ...suppressed,
  dueAt: '2030-01-07T09:30:00.000Z',
  finishedAt: '2030-01-07T09:33:00.000Z',
  outcome: 'completed',
  reason: null,
  sent: 1,
  deliveryUnknown: 1,
  skipped: 0,
}
const earlier: Schemas['WorkflowRunHistoryEntry'] = {
  ...completed,
  revision: 1,
  dueAt: '2030-01-06T09:30:00.000Z',
  finishedAt: '2030-01-06T09:31:00.000Z',
  deliveryUnknown: 0,
  rejected: 1,
}

/** Exercise the generated client while the fixture server stays hard-off. */
export async function mockWorkflowRunHistoryAudit(
  page: Page,
  app: FixtureApp,
  state: WorkflowRunHistoryAuditPageId,
) {
  const fixture = await app.auditState()
  const owner: Schemas['WorkflowOwner'] =
    state === 'team-workflow-run-history'
      ? { kind: 'team', id: fixture.teamOrganizationId }
      : { kind: 'personal', id: fixture.userId }
  const workflow: Schemas['Workflow'] = {
    id: AUDIT_HISTORY_WORKFLOW_ID,
    owner,
    name: AUDIT_HISTORY_WORKFLOW_NAME,
    enabled: true,
    revision: 2,
    scope: { type: 'all_event_types' },
    trigger: { type: 'after_end', offsetMinutes: 30 },
    conditions: [],
    actions: [{ type: 'email', recipients: ['booker', 'hosts'] }],
    createdAt: '2030-01-01T09:00:00.000Z',
    updatedAt: AUDIT_NOW,
  }
  const instance: Schemas['Instance'] = {
    hostedSignupUrl: 'https://hourmere.com',
    publicUrl: app.url,
    workflowsEnabled: true,
    signIn: { email: true, google: false, microsoft: false },
  }
  const list = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.abort()
    const query = new URL(route.request().url()).searchParams
    if (query.get('ownerKind') !== owner.kind || query.get('ownerId') !== owner.id)
      return route.fulfill({ status: 403, json: { error: 'insufficient_role' } })
    return route.fulfill({
      json: { data: [workflow], nextCursor: null } satisfies Schemas['WorkflowPage'],
    })
  }
  const history = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.abort()
    if (state === 'workflow-run-history-loading') return
    if (state === 'workflow-run-history-error') return route.abort()
    if (state === 'workflow-run-history-forbidden')
      return route.fulfill({ status: 404, json: { error: 'workflow_not_found' } })
    const cursor = new URL(route.request().url()).searchParams.get('cursor')
    let result: Schemas['WorkflowRunHistoryPage']
    if (state === 'workflow-run-history-empty') result = { data: [], nextCursor: null }
    else if (cursor === null) result = { data: [suppressed, completed], nextCursor }
    else if (cursor === nextCursor) result = { data: [earlier], nextCursor: null }
    else return route.fulfill({ status: 400, json: { error: 'invalid_cursor' } })
    return route.fulfill({ json: result })
  }
  const matches = (path: string) => (url: URL) => url.origin === app.url && url.pathname === path
  const mocks: [string | ((url: URL) => boolean), (route: Route) => Promise<void>][] = [
    [`${app.url}/api/v1/instance`, (route) => route.fulfill({ json: instance })],
    [matches('/api/v1/workflows'), list],
    [matches(historyEndpoint), history],
  ]
  for (const [url, handler] of mocks) await page.route(url, handler)
  return async () => {
    for (const [url, handler] of mocks) await page.unroute(url, handler)
  }
}

export async function openWorkflowRunHistoryAuditPage(
  page: Page,
  app: FixtureApp,
  state: WorkflowRunHistoryAuditPageId,
  locale: 'en' | 'zh-CN',
) {
  const copy = (key: keyof typeof english & keyof typeof chinese) =>
    locale === 'zh-CN' ? chinese[key] : english[key]
  const release = await mockWorkflowRunHistoryAudit(page, app, state)
  const path = workflowRunHistoryPath(AUDIT_HISTORY_WORKFLOW_ID)
  try {
    await Promise.all([
      state === 'workflow-run-history-loading' && page.waitForRequest(app.url + historyEndpoint),
      page.goto(app.url + path),
    ])
    const main = page.getByRole('main')
    await main.getByRole('heading', { name: copy('Run history'), exact: true }).waitFor()
    const waitForText = (key: Parameters<typeof copy>[0]) =>
      main.getByText(copy(key), { exact: true }).waitFor()
    switch (state) {
      case 'workflow-run-history-loading':
        await main.getByRole('status', { name: copy('Loading run history…') }).waitFor()
        pending.set(page, release)
        break
      case 'workflow-run-history-empty':
        await waitForText('No finished runs yet.')
        break
      case 'workflow-run-history-error':
        await waitForText('Could not load run history.')
        break
      case 'workflow-run-history-forbidden':
        await waitForText('Run history is unavailable in this space.')
        break
      case 'team-workflow-run-history':
        await main.getByRole('button', { name: copy('Next page'), exact: true }).press('Enter')
        await main.locator(`time[datetime="${earlier.finishedAt}"]`).waitFor()
        break
      case 'workflow-run-history':
        await waitForText('Mail budget limit reached')
        break
    }
    return path
  } finally {
    if (!pending.has(page)) await release()
  }
}
