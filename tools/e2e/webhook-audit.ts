import type { Page, Route } from '@playwright/test'
import type { components, operations } from '../../apps/web/src/api/schema.d.ts'
import { admin as englishAdmin } from '../../apps/web/src/i18n/catalogues/en/admin.ts'
import { common as englishCommon } from '../../apps/web/src/i18n/catalogues/en/common.ts'
import { admin as chineseAdmin } from '../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { common as chineseCommon } from '../../apps/web/src/i18n/catalogues/zh-CN/common.ts'
import { PATHS } from '../../apps/web/src/paths.ts'
import { AUDIT_NOW } from './audit-data.ts'
import type { FixtureApp } from './fixtures.ts'

const english = { ...englishCommon, ...englishAdmin }
const chinese = { ...chineseCommon, ...chineseAdmin }

export const webhookAuditPages = [
  // Identical long origins must fit while their IDs and configured states distinguish the rows.
  { id: 'webhooks-list', title: 'Team webhook endpoints with a shared destination origin' },
  // The full event list exercises checkbox labels, grouping and narrow-screen control wrapping.
  { id: 'webhooks-create', title: 'Create webhook with all event choices available' },
  { id: 'webhooks-edit', title: 'Edit webhook with a stored workflow subscription' },
  // Each confirmation has different consequences and needs a clear label and safe focus target.
  { id: 'webhooks-rotate-confirm', title: 'Confirm replacing a webhook signing secret' },
  { id: 'webhooks-delete-confirm', title: 'Confirm permanently deleting a webhook' },
  // A representative unbroken string exercises wrapping next to the explicit copy control.
  { id: 'webhooks-secret', title: 'One-time webhook signing secret with a synthetic marker' },
  // Long IDs, localized times, all outcomes and the page action exercise wrapping and reading order.
  { id: 'webhook-delivery-history', title: 'Webhook deliveries with all four outcomes' },
  // A successful empty read has different copy and actions from a pagination failure.
  { id: 'webhook-delivery-history-empty', title: 'Webhook history with no retained deliveries' },
  // Check that the cursor error is announced and its recovery action stays reachable.
  {
    id: 'webhook-delivery-history-invalid-cursor',
    title: 'Webhook history with a rejected cursor',
  },
] as const

export type WebhookAuditPageId = (typeof webhookAuditPages)[number]['id']
type Webhook = components['schemas']['Webhook']
type Delivery = components['schemas']['WebhookDelivery']
type DeliveryPage =
  operations['listWebhookDeliveries']['responses'][200]['content']['application/json']

export function isWebhookAuditPage(id: string): id is WebhookAuditPageId {
  return webhookAuditPages.some((entry) => entry.id === id)
}

const id = '72200000-0000-4000-8000-000000000001'
const origin = `https://${'longwebhookreceiver'.repeat(3)}.hourmere.invalid`
const events: Webhook['events'] = [
  'booking.created',
  'booking.rescheduled',
  'booking.cancelled',
  'booking.reschedule_requested',
  'booking.reschedule_request_expired',
  'booking.attendee_no_show_changed',
  'workflow.executed',
]
const apiPath = '/api/v1/webhooks'
const deliveryPath = `${apiPath}/${id}/deliveries`

const pendingDelivery: Delivery = {
  id: '72300000-0000-4000-8000-000000000004',
  eventId: '72400000-0000-4000-8000-000000000004',
  bookingId: '72500000-0000-4000-8000-000000000001',
  eventType: 'booking.reschedule_request_expired',
  status: 'pending',
  attempts: 2,
  httpStatus: 503,
  lastError: 'http_error',
  createdAt: '2030-01-07T09:45:00.000Z',
  lastAttemptAt: '2030-01-07T09:55:00.000Z',
  deliveredAt: null,
}
const history: DeliveryPage = {
  data: [
    pendingDelivery,
    {
      ...pendingDelivery,
      id: '72300000-0000-4000-8000-000000000003',
      eventId: '72400000-0000-4000-8000-000000000003',
      status: 'delivered',
      eventType: 'workflow.executed',
      httpStatus: 204,
      lastError: null,
      deliveredAt: pendingDelivery.lastAttemptAt,
    },
    {
      ...pendingDelivery,
      id: '72300000-0000-4000-8000-000000000002',
      eventId: '72400000-0000-4000-8000-000000000002',
      eventType: 'booking.attendee_no_show_changed',
      status: 'failed',
      attempts: 13,
      httpStatus: null,
      lastError: 'transport_error',
    },
    {
      ...pendingDelivery,
      id: '72300000-0000-4000-8000-000000000001',
      eventId: '72400000-0000-4000-8000-000000000001',
      eventType: 'booking.created',
      status: 'skipped',
      attempts: 0,
      httpStatus: null,
      lastError: 'disabled',
      lastAttemptAt: null,
    },
  ],
  nextAfter: '72300000-0000-4000-8000-000000000001',
}

/** Render dashboard states using synthetic same-origin responses and the real signed-in shell. */
export async function openWebhookAuditPage(
  page: Page,
  app: FixtureApp,
  state: WebhookAuditPageId,
  locale: 'en' | 'zh-CN',
) {
  const t = (key: keyof typeof english & keyof typeof chinese) =>
    locale === 'zh-CN' ? chinese[key] : english[key]
  const fixture = await app.auditState()
  const organizationId =
    state === 'webhooks-list' ? fixture.teamOrganizationId : fixture.organizationId
  const endpoint: Webhook = {
    id,
    organizationId,
    url: `${origin}/synthetic-receiver`,
    events,
    isActive: true,
    createdAt: AUDIT_NOW,
    updatedAt: AUDIT_NOW,
  }
  const paused: Webhook = {
    ...endpoint,
    id: '72200000-0000-4000-8000-000000000002',
    url: `${origin}/another-synthetic-receiver`,
    events: ['booking.created'],
    isActive: false,
  }
  const matchesWebhooks = (url: URL) =>
    url.origin === app.url && (url.pathname === apiPath || url.pathname.startsWith(`${apiPath}/`))
  const webhooks = async (route: Route) => {
    const request = route.request()
    if ((await request.headerValue('x-expected-organization-id')) !== organizationId)
      return route.fulfill({ status: 409, json: { error: 'organization_context_changed' } })
    const { pathname, searchParams } = new URL(request.url())
    if (pathname === apiPath && request.method() === 'GET')
      return route.fulfill({ json: [endpoint, paused] })
    if (pathname === deliveryPath && request.method() === 'GET') {
      if (searchParams.has('after')) {
        return route.fulfill({ status: 400, json: { error: 'invalid_cursor' } })
      }
      return route.fulfill({
        json: state === 'webhook-delivery-history-empty' ? { data: [], nextAfter: null } : history,
      })
    }
    if (
      state === 'webhooks-secret' &&
      pathname === `${apiPath}/${id}/rotate-secret` &&
      request.method() === 'POST'
    )
      return route.fulfill({ json: { secret: 'syntheticauditmarker'.repeat(4) } })
    return route.abort()
  }
  const instanceUrl = `${app.url}/api/v1/instance`
  const instance = (route: Route) =>
    route.fulfill({
      json: {
        hostedSignupUrl: 'https://hourmere.com',
        publicUrl: app.url,
        signIn: { email: true, google: false, microsoft: false },
        workflowsEnabled: state === 'webhooks-create',
      } satisfies components['schemas']['Instance'],
    })

  await page.route(instanceUrl, instance)
  await page.route(matchesWebhooks, webhooks)
  try {
    await page.goto(app.url + PATHS.settings)
    const main = page.getByRole('main')
    const button = (key: Parameters<typeof t>[0]) =>
      main.getByRole('button', { name: t(key), exact: true })
    await button('Webhooks').press('Enter')
    const list = main.locator('.webhook-list')
    await list.getByText(origin, { exact: true }).first().waitFor()
    if (state === 'webhooks-list') {
      await list.getByText(paused.id, { exact: true }).waitFor()
      await list.getByText(t('Enabled'), { exact: true }).waitFor()
      await list.getByText(t('Paused'), { exact: true }).waitFor()
    } else if (state === 'webhooks-create') {
      await button('Add webhook').press('Enter')
      const form = main.locator('.webhook-create')
      await form
        .getByRole('heading', { name: t('Create webhook') })
        .and(form.locator(':focus'))
        .waitFor()
      await form.getByLabel(t('Destination URL'), { exact: true }).waitFor()
      await form
        .getByRole('checkbox', { name: t('Workflow executed'), checked: false, exact: true })
        .waitFor()
    } else if (
      state === 'webhook-delivery-history' ||
      state === 'webhook-delivery-history-empty' ||
      state === 'webhook-delivery-history-invalid-cursor'
    ) {
      await list
        .locator('.webhook-endpoint')
        .filter({ hasText: id })
        .getByRole('button', { name: t('Delivery history'), exact: true })
        .press('Enter')
      const panel = main.locator('.webhook-history')
      await panel
        .getByRole('heading', { name: t('Delivery history'), exact: true })
        .and(panel.locator(':focus'))
        .waitFor()
      if (state === 'webhook-delivery-history-empty') {
        await panel.getByText(t('No deliveries retained in the last 30 days.')).waitFor()
      } else {
        await panel.locator(`time[datetime="${pendingDelivery.createdAt}"]`).first().waitFor()
        const older = button('Load older deliveries')
        await older.waitFor()
        if (state === 'webhook-delivery-history-invalid-cursor') {
          await older.press('Enter')
          await panel
            .getByText(
              t(
                'This delivery history page is no longer available. Refresh history to start again.',
              ),
            )
            .waitFor()
        }
      }
    } else {
      await list
        .locator('.webhook-endpoint')
        .filter({ hasText: id })
        .getByRole('button', { name: t('Edit webhook'), exact: true })
        .press('Enter')
      const editor = main.locator('.webhook-editor')
      await editor
        .getByRole('heading', { name: t('Edit webhook') })
        .and(editor.locator(':focus'))
        .waitFor()
      await editor
        .getByRole('checkbox', { name: t('Workflow executed'), checked: true, exact: true })
        .waitFor()
      if (state !== 'webhooks-edit') {
        const remove = state === 'webhooks-delete-confirm'
        await button(remove ? 'Delete webhook…' : 'Rotate signing secret…').press('Enter')
        const confirmation = main.locator('.webhook-confirm')
        await confirmation
          .getByRole('button', { name: t('Go back'), exact: true })
          .and(confirmation.locator(':focus'))
          .waitFor()
        const confirm = confirmation.getByRole('button', {
          name: t(remove ? 'Delete webhook' : 'Rotate signing secret'),
          exact: true,
        })
        await confirm.waitFor()
        if (state === 'webhooks-secret') {
          await confirm.press('Enter')
          const disclosure = main.locator('.webhook-secret')
          await disclosure
            .getByRole('heading', { name: t('Signing secret'), exact: true })
            .and(disclosure.locator(':focus'))
            .waitFor()
          await disclosure
            .getByRole('button', { name: t('Copy signing secret'), exact: true })
            .waitFor()
        }
      }
    }
    return PATHS.settings
  } finally {
    await page.unroute(matchesWebhooks, webhooks)
    await page.unroute(instanceUrl, instance)
  }
}
