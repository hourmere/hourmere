import type { Dialog, Page, Route } from '@playwright/test'
import type { components } from '../../apps/web/src/api/schema.d.ts'
import { admin as englishAdmin } from '../../apps/web/src/i18n/catalogues/en/admin.ts'
import { common as englishCommon } from '../../apps/web/src/i18n/catalogues/en/common.ts'
import { admin as chineseAdmin } from '../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { common as chineseCommon } from '../../apps/web/src/i18n/catalogues/zh-CN/common.ts'
import { PATHS, routingFormPath } from '../../apps/web/src/paths.ts'
import { AUDIT_NOW } from './audit-data.ts'
import type { FixtureApp } from './fixtures.ts'

const english = { ...englishCommon, ...englishAdmin }
const chinese = { ...chineseCommon, ...chineseAdmin }

export const routingFormManagerAuditPages = [
  { id: 'routing-manager-off', title: 'Routing manager unavailable while off' },
  { id: 'routing-manager-list', title: 'Routing form list' },
  { id: 'routing-manager-team-list', title: 'Team routing form list' },
  { id: 'routing-manager-list-empty', title: 'Empty routing form list' },
  { id: 'routing-manager-list-loading', title: 'Routing form list loading' },
  { id: 'routing-manager-list-denied', title: 'Routing form list without permission' },
  { id: 'routing-manager-list-error', title: 'Routing form list load error' },
  { id: 'routing-manager-new', title: 'New routing form' },
  { id: 'routing-manager-creation-retry', title: 'Unconfirmed routing form creation' },
  { id: 'routing-manager-edit', title: 'Routing question and option editor' },
  { id: 'routing-manager-edit-loading', title: 'Routing form draft loading' },
  { id: 'routing-manager-edit-denied', title: 'Routing form draft without permission' },
  { id: 'routing-manager-edit-error', title: 'Routing form draft load error' },
  { id: 'routing-manager-edit-missing', title: 'Unavailable routing form draft' },
  { id: 'routing-manager-context-changed', title: 'Routing form space changed' },
  { id: 'routing-manager-invalid', title: 'Routing form validation errors' },
  { id: 'routing-manager-saving', title: 'Routing form save in progress' },
  { id: 'routing-manager-saved', title: 'Routing draft saved' },
  { id: 'routing-manager-save-error', title: 'Routing form save error' },
  { id: 'routing-manager-stale', title: 'Routing form draft revision conflict' },
  { id: 'routing-manager-archive-confirm', title: 'Confirm routing form archive' },
  { id: 'routing-manager-archiving', title: 'Routing form archive in progress' },
  { id: 'routing-manager-archive-error', title: 'Routing form archive error' },
] as const

export type RoutingFormManagerAuditPageId = (typeof routingFormManagerAuditPages)[number]['id']

export function isRoutingFormManagerAuditPage(id: string): id is RoutingFormManagerAuditPageId {
  return routingFormManagerAuditPages.some((entry) => entry.id === id)
}

const activeMocks = new WeakMap<Page, () => Promise<void>>()

export async function leaveRoutingFormManagerAudit(page: Page, origin: string) {
  const release = activeMocks.get(page)
  if (!release) return
  // Finish scanning unsaved drafts and pending requests before leaving their document.
  const handleDialog = (dialog: Dialog) =>
    dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()
  page.on('dialog', handleDialog)
  try {
    await page.goto(`${origin}/favicon.svg`)
  } finally {
    page.off('dialog', handleDialog)
    activeMocks.delete(page)
    await release()
  }
}

const summary = {
  id: '72100000-0000-4000-8000-000000000001',
  slug: 'appointment-enquiries',
  title: 'Appointment enquiries / 预约咨询',
  draftRevision: 2,
  enabled: false,
  publishedVersionId: null,
  publishedVersionNumber: null,
  createdAt: AUDIT_NOW,
  updatedAt: AUDIT_NOW,
  health: null,
} satisfies components['schemas']['RoutingFormList']['data'][number]
const draft: components['schemas']['RoutingForm'] = {
  ...summary,
  description: 'Tell us what you would like to discuss. / 请告诉我们你希望讨论什么。',
  questions: [
    {
      id: '72100000-0000-4000-8000-000000000002',
      type: 'select',
      label: 'What would you like to discuss? / 你希望讨论什么？',
      required: true,
      options: [
        { id: '72100000-0000-4000-8000-000000000003', label: 'New project / 新项目' },
        { id: '72100000-0000-4000-8000-000000000004', label: 'Existing project / 现有项目' },
      ],
    },
    {
      id: '72100000-0000-4000-8000-000000000005',
      type: 'email',
      label: 'Contact email / 联系邮箱',
      required: false,
    },
  ],
  rules: [],
  fallback: { kind: 'message', message: 'Please contact the office. / 请联系办公室。' },
}

export async function openRoutingFormManagerAuditPage(
  page: Page,
  app: FixtureApp,
  id: RoutingFormManagerAuditPageId,
  locale: 'en' | 'zh-CN',
) {
  const t = (key: keyof typeof english & keyof typeof chinese) =>
    locale === 'zh-CN' ? chinese[key] : english[key]
  const fixture = await app.auditState()
  const list = id.includes('-list') || id === 'routing-manager-off'
  const creating = id === 'routing-manager-new' || id === 'routing-manager-creation-retry'
  const loading = id.endsWith('-loading')
  const pending = loading || id === 'routing-manager-saving' || id === 'routing-manager-archiving'
  const dirty = id === 'routing-manager-invalid' || id === 'routing-manager-creation-retry'
  const path = list
    ? PATHS.routingForms
    : creating
      ? PATHS.newRoutingForm
      : routingFormPath(draft.id, fixture.organizationId)
  const apiPath = `/api/v1/routing-forms${list || creating ? '' : `/${draft.id}`}`
  const matchesDraft = (url: URL) => url.origin === app.url && url.pathname === apiPath
  const handleDraft = async (route: Route) => {
    const method = route.request().method()
    if (method === 'GET') {
      if (loading) return
      if (id.endsWith('-denied'))
        return route.fulfill({ status: 403, json: { error: 'team_management_access_denied' } })
      if (id.endsWith('-missing'))
        return route.fulfill({ status: 404, json: { error: 'routing_form_not_found' } })
      if (id === 'routing-manager-context-changed')
        return route.fulfill({ status: 409, json: { error: 'organization_context_changed' } })
      if (id.endsWith('-error') && (id.includes('-list') || id.includes('-edit')))
        return route.abort()
      return route.fulfill({
        json: list ? { data: id.endsWith('-empty') ? [] : [summary], nextCursor: null } : draft,
      })
    }
    if (pending) return
    if (id === 'routing-manager-saved')
      return route.fulfill({ json: { ...draft, draftRevision: draft.draftRevision + 1 } })
    if (id === 'routing-manager-stale')
      return route.fulfill({ status: 409, json: { error: 'routing_revision_conflict' } })
    return route.abort()
  }
  const instanceUrl = `${app.url}/api/v1/instance`
  const handleInstance = (route: Route) =>
    route.fulfill({
      json: {
        hostedSignupUrl: 'https://hourmere.com',
        publicUrl: app.url,
        routingFormsEnabled: id !== 'routing-manager-off',
        signIn: { email: true, google: false, microsoft: false },
      } satisfies components['schemas']['Instance'],
    })
  const release = async () => {
    await page.unroute(instanceUrl, handleInstance)
    await page.unroute(matchesDraft, handleDraft)
  }

  try {
    await page.route(instanceUrl, handleInstance)
    await page.route(matchesDraft, handleDraft)
    if (pending || dirty) activeMocks.set(page, release)
    await Promise.all([
      loading && page.waitForRequest((request) => matchesDraft(new URL(request.url()))),
      page.goto(app.url + path),
    ])
    const main = page.getByRole('main')
    const prefix = list ? 'routing-forms' : 'routing-form'
    if (id === 'routing-manager-off') {
      await main.getByRole('heading', { name: t('Page not found') }).waitFor()
    } else if (id === 'routing-manager-context-changed') {
      await main.getByText(t('Your team context changed. Reload before making changes.')).waitFor()
    } else if (list || loading || id.includes('-edit-')) {
      await main.getByTestId(`${prefix}-${id.split('-').at(-1)}`).waitFor()
    } else {
      const editor = main.getByTestId('routing-form-editor')
      await editor.waitFor()
      const save = editor.getByRole('button', { name: t('Save draft'), exact: true })
      if (id === 'routing-manager-invalid') {
        await editor.getByLabel(t('Title'), { exact: true }).fill('')
        await save.press('Enter')
        await editor
          .getByRole('alert')
          .getByRole('link', { name: t('Enter a title.') })
          .waitFor()
      } else if (id === 'routing-manager-creation-retry') {
        await editor.getByLabel(t('Title'), { exact: true }).fill(draft.title)
        await editor.getByLabel(t('Form address'), { exact: true }).fill(draft.slug)
        await save.press('Enter')
        await editor
          .getByText(t('Could not confirm creation. Try again to recover this draft.'))
          .waitFor()
      } else if (id.includes('-archive-') || id === 'routing-manager-archiving') {
        await main
          .getByRole('button', { name: t('Archive routing form'), exact: true })
          .press('Enter')
        const confirm = main.getByRole('button', { name: t('Archive form'), exact: true })
        await confirm.waitFor()
        if (id !== 'routing-manager-archive-confirm') {
          await confirm.press('Enter')
          if (pending) await main.getByRole('button', { name: t('Archiving…') }).waitFor()
          else await editor.getByText(t('Could not archive the routing form.')).waitFor()
        }
      } else if (id !== 'routing-manager-edit' && id !== 'routing-manager-new') {
        await save.press('Enter')
        if (pending) await editor.getByRole('button', { name: t('Saving…') }).waitFor()
        else if (id === 'routing-manager-saved') await editor.getByText(t('Draft saved.')).waitFor()
        else if (id === 'routing-manager-stale')
          await editor
            .getByText(
              t(
                'This routing form changed elsewhere. Reload it and review your edits before trying again.',
              ),
            )
            .waitFor()
        else await editor.getByText(t('Could not save the routing form.')).waitFor()
      }
    }
    return path
  } finally {
    if (!activeMocks.has(page)) await release()
  }
}
