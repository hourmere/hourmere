import type { Page, Route } from '@playwright/test'
import type { components } from '../../apps/web/src/api/schema.d.ts'
import { common as english } from '../../apps/web/src/i18n/catalogues/en/common.ts'
import { common as chinese } from '../../apps/web/src/i18n/catalogues/zh-CN/common.ts'
import {
  AUDIT_BOOKING_END,
  AUDIT_BOOKING_START,
  AUDIT_CONFIRMATION_EMAIL,
  AUDIT_DESCRIPTION,
  AUDIT_HOST_TIME_ZONE,
  AUDIT_NOW,
  AUDIT_TITLE,
} from './audit-data.ts'

type Schemas = components['schemas']
const pendingMocks = new WeakMap<Page, () => Promise<void>>()

export async function leavePendingRoutingFormAudit(page: Page, origin: string) {
  const release = pendingMocks.get(page)
  if (!release) return
  // Disabling interception would otherwise resume paused requests in the measured document.
  await page.goto(`${origin}/favicon.svg`)
  await release()
  pendingMocks.delete(page)
}

const routingContinuationAuditPages = [
  { id: 'routing-continuation-loading', title: 'Routing continuation loading' },
  { id: 'routing-continuation-unavailable', title: 'Unavailable routing continuation' },
  { id: 'routing-continuation-load-error', title: 'Routing continuation load error' },
  { id: 'routing-continuation', title: 'Routing continuation calendar' },
  { id: 'routing-continuation-slots-loading', title: 'Routing continuation times loading' },
  { id: 'routing-continuation-slots-empty', title: 'Routing continuation with no available times' },
  { id: 'routing-continuation-slots-error', title: 'Routing continuation times error' },
  { id: 'routing-continuation-slots', title: 'Routing continuation day with available times' },
  { id: 'routing-continuation-details', title: 'Routing continuation with prefilled details' },
  { id: 'routing-continuation-invalid', title: 'Routing continuation validation errors' },
  { id: 'routing-continuation-booking', title: 'Routing continuation booking submission' },
  { id: 'routing-continuation-booking-error', title: 'Routing continuation booking error' },
  { id: 'routing-continuation-confirmation', title: 'Routing continuation confirmation' },
] as const

export const routingFormAuditPages = [
  { id: 'routing-form', title: 'Public routing form' },
  { id: 'team-routing-form', title: 'Public team routing form' },
  { id: 'routing-form-loading', title: 'Routing form loading' },
  { id: 'routing-form-unavailable', title: 'Unavailable routing form' },
  { id: 'routing-form-load-error', title: 'Routing form load error' },
  { id: 'routing-form-invalid', title: 'Routing form validation errors' },
  { id: 'routing-form-changed', title: 'Routing form publication changed' },
  { id: 'routing-form-submitting', title: 'Routing form submitting' },
  { id: 'routing-form-submit-error', title: 'Routing form submission error' },
  { id: 'routing-form-message', title: 'Routing form message outcome' },
  ...routingContinuationAuditPages,
] as const

export type RoutingFormAuditPageId = (typeof routingFormAuditPages)[number]['id']
type RoutingContinuationAuditPageId = (typeof routingContinuationAuditPages)[number]['id']

export function isRoutingFormAuditPage(id: string): id is RoutingFormAuditPageId {
  return routingFormAuditPages.some((entry) => entry.id === id)
}

function isRoutingContinuationAuditPage(
  id: RoutingFormAuditPageId,
): id is RoutingContinuationAuditPageId {
  return routingContinuationAuditPages.some((entry) => entry.id === id)
}

type AuditLanguage = 'en' | 'zh-CN'

const copy = (locale: AuditLanguage, key: keyof typeof english & keyof typeof chinese) =>
  locale === 'zh-CN' ? chinese[key] : english[key]

const enabledInstance = (origin: string): Schemas['Instance'] => ({
  hostedSignupUrl: 'https://hourmere.com',
  publicUrl: origin,
  routingFormsEnabled: true,
  signIn: { email: true, google: false, microsoft: false },
})

const title = 'Appointment questions / 预约问题'
const changedTitle = 'Updated appointment questions / 更新后的预约问题'
const textLabel = 'What would you like to discuss? / 你想讨论哪些内容？'
const emailLabel = 'Contact email / 联系邮箱'
const selectLabel = 'Which type of appointment would you prefer? / 你希望预约哪类会谈？'
const optionId = '72000000-0000-4000-8000-000000000005'
const form: Schemas['PublicRoutingForm'] = {
  versionId: '72000000-0000-4000-8000-000000000001',
  title,
  description:
    'Answer these questions so we can point you to the right appointment. / 请回答以下问题，以便我们为你推荐合适的预约。',
  questions: [
    {
      id: '72000000-0000-4000-8000-000000000002',
      type: 'short_text',
      label: textLabel,
      required: true,
    },
    {
      id: '72000000-0000-4000-8000-000000000003',
      type: 'email',
      label: emailLabel,
      required: true,
    },
    {
      id: '72000000-0000-4000-8000-000000000004',
      type: 'select',
      label: selectLabel,
      required: true,
      options: [
        { id: optionId, label: 'Initial consultation / 初次咨询' },
        {
          id: '72000000-0000-4000-8000-000000000006',
          label: 'Follow-up and next steps for an existing project / 现有项目的后续沟通与安排',
        },
      ],
    },
  ],
}
const changedForm: Schemas['PublicRoutingForm'] = {
  ...form,
  versionId: '72000000-0000-4000-8000-000000000007',
  title: changedTitle,
  questions: [
    ...form.questions,
    {
      id: '72000000-0000-4000-8000-000000000008',
      type: 'short_text',
      label: 'What would you like us to prepare? / 希望我们提前准备什么？',
      required: false,
    },
  ],
}
const message = {
  kind: 'message',
  message: 'Please contact our reception team. / 请联系前台团队。',
} satisfies Schemas['RoutingSubmissionResponse']

function reply(
  route: Route,
  status: number,
  json:
    | Schemas['PublicRoutingForm']
    | Schemas['RoutingSubmissionResponse']
    | Schemas['RoutingContinuation']
    | Schemas['RoutingContinuationSlots']
    | Schemas['RoutedBookingResult']
    | Schemas['Error'],
) {
  return route.fulfill({
    status,
    json,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  })
}

/** Exercise the real UI against synthetic responses without enabling routing on the server. */
export async function openRoutingFormAuditPage(
  page: Page,
  origin: string,
  id: RoutingFormAuditPageId,
  locale: AuditLanguage,
): Promise<string> {
  if (isRoutingContinuationAuditPage(id))
    return openRoutingContinuationAuditPage(page, origin, id, locale)
  const team = id === 'team-routing-form'
  const path = `/route/${team ? 'team/' : ''}fixture-host/layout-audit`
  const metadataUrl = `${origin}/api/v1/public/-/routing/${team ? 'teams/' : ''}fixture-host/layout-audit`
  let changed = false
  const mocks: [string, (route: Route) => Promise<void>][] = [
    [`${origin}/api/v1/instance`, (route) => route.fulfill({ json: enabledInstance(origin) })],
    [
      metadataUrl,
      async (route) => {
        if (id === 'routing-form-loading') return // Keep the metadata request pending for the scan.
        if (id === 'routing-form-load-error') return route.abort()
        if (id === 'routing-form-unavailable')
          return reply(route, 404, { error: 'routing_form_not_found' })
        return reply(route, 200, changed ? changedForm : form)
      },
    ],
    [
      `${metadataUrl}/route`,
      async (route) => {
        if (id === 'routing-form-submitting') return // Keep the submission pending for the scan.
        if (id === 'routing-form-submit-error') return route.abort()
        if (id === 'routing-form-changed') {
          changed = true
          return reply(route, 409, { error: 'routing_form_changed' })
        }
        return reply(route, 200, message)
      },
    ],
  ]
  const release = async () => {
    for (const [url, handler] of mocks) await page.unroute(url, handler)
  }

  try {
    for (const [url, handler] of mocks) await page.route(url, handler)
    await Promise.all([
      id === 'routing-form-loading' && page.waitForRequest(metadataUrl),
      page.goto(origin + path),
    ])
    const t = (key: Parameters<typeof copy>[1]) => copy(locale, key)
    const main = page.getByRole('main')
    const heading = (name: string) => main.getByRole('heading', { name, exact: true })
    switch (id) {
      case 'routing-form-loading':
        await main
          .getByRole('status')
          .filter({ hasText: t('Loading form…') })
          .waitFor()
        pendingMocks.set(page, release)
        return path
      case 'routing-form-unavailable':
        await heading(t('This form is unavailable')).waitFor()
        return path
      case 'routing-form-load-error':
        await main.getByText(t('We couldn’t load this form. Try again.'), { exact: true }).waitFor()
        return path
    }

    await heading(title).waitFor()
    const fields = main.getByRole('form', { name: title })
    const text = fields.getByLabel(textLabel, { exact: true })
    const email = fields.getByLabel(emailLabel, { exact: true })
    const select = fields.getByLabel(selectLabel, { exact: true })
    const submit = fields.getByRole('button', { name: t('Continue'), exact: true })
    await submit.waitFor()
    if (id === 'routing-form' || id === 'team-routing-form') return path

    if (id === 'routing-form-invalid') {
      await submit.press('Enter')
      await main
        .getByRole('alert')
        .filter({ hasText: t('Review the highlighted answers.') })
        .waitFor()
      return path
    }

    await text.fill('Synthetic appointment enquiry')
    await email.fill('routing-invitee@hourmere.invalid')
    await select.selectOption(optionId)
    await Promise.all([
      id === 'routing-form-submitting' && page.waitForRequest(`${metadataUrl}/route`),
      submit.press('Enter'),
    ])
    switch (id) {
      case 'routing-form-changed':
        await heading(changedTitle).waitFor()
        await main
          .getByText(t('This form has changed. Review your answers before continuing.'), {
            exact: true,
          })
          .waitFor()
        break
      case 'routing-form-submitting':
        await main
          .getByRole('status')
          .filter({ hasText: t('Submitting…') })
          .waitFor()
        pendingMocks.set(page, release)
        break
      case 'routing-form-submit-error':
        await main
          .getByText(t('We couldn’t submit your answers. Try again.'), { exact: true })
          .waitFor()
        break
      case 'routing-form-message':
        await main.getByText(message.message, { exact: true }).waitFor()
        break
    }
    return path
  } finally {
    if (!pendingMocks.has(page)) await release()
  }
}

const continuationPrefill = {
  inviteeName: 'Synthetic routing invitee',
  inviteeEmail: AUDIT_CONFIRMATION_EMAIL,
  responses: { agenda: 'Synthetic project planning / 示例项目规划' },
}
const continuation: Schemas['RoutingContinuation'] = {
  eventType: {
    title: AUDIT_TITLE,
    description: AUDIT_DESCRIPTION,
    durationMinutes: 30,
    allowedDurationsMinutes: [30, 45],
    host: { name: 'Synthetic host', timeZone: AUDIT_HOST_TIME_ZONE },
    location: { kind: 'in_person' },
    locations: null,
    questions: [{ id: 'agenda', type: 'long_text', label: textLabel, required: true }],
    allowGuests: true,
    smsRemindersEnabled: false,
  },
  prefill: continuationPrefill,
  expiresAt: '2030-01-07T10:30:00.000Z',
}
const continuationSlot = { start: AUDIT_BOOKING_START, end: AUDIT_BOOKING_END }
const routedBooking: Schemas['RoutedBookingResult'] = {
  booking: {
    ...continuationSlot,
    id: '72000000-0000-4000-8000-000000000009',
    eventTypeId: '72000000-0000-4000-8000-000000000010',
    title: AUDIT_TITLE,
    status: 'confirmed',
    source: 'web',
    createdAt: AUDIT_NOW,
    cancelledAt: null,
    cancelReason: null,
    rescheduledFromId: null,
    location: { kind: 'in_person', address: 'Synthetic interview room' },
    attendees: [
      {
        name: continuationPrefill.inviteeName,
        email: continuationPrefill.inviteeEmail,
        locale: null,
        timeZone: 'UTC',
        isBooker: true,
      },
    ],
    responses: continuationPrefill.responses,
  },
  manageToken: 'hm_synthetic_routing_booking_manage',
}

async function openRoutingContinuationAuditPage(
  page: Page,
  origin: string,
  id: RoutingContinuationAuditPageId,
  locale: AuditLanguage,
): Promise<string> {
  const path = '/route/continue'
  const endpoint = `${origin}/api/v1/routing-continuations`
  const t = (key: Parameters<typeof copy>[1]) => copy(locale, key)
  const error = { error: 'internal_error' }
  const mocks: [string, (route: Route) => Promise<void>][] = [
    [`${origin}/api/v1/instance`, (route) => route.fulfill({ json: enabledInstance(origin) })],
    [
      `${endpoint}/resolve`,
      async (route) => {
        if (id === 'routing-continuation-loading') return
        if (id === 'routing-continuation-unavailable')
          return reply(route, 409, { error: 'routing_unavailable' })
        if (id === 'routing-continuation-load-error') return reply(route, 500, error)
        return reply(route, 200, continuation)
      },
    ],
    [
      `${endpoint}/slots`,
      async (route) => {
        if (id === 'routing-continuation-slots-loading') return
        if (id === 'routing-continuation-slots-error') return reply(route, 500, error)
        return reply(route, 200, {
          slots: id === 'routing-continuation-slots-empty' ? [] : [continuationSlot],
        })
      },
    ],
    [
      `${endpoint}/bookings`,
      async (route) => {
        if (id === 'routing-continuation-booking') return
        if (id === 'routing-continuation-booking-error') return reply(route, 500, error)
        return reply(route, 201, routedBooking)
      },
    ],
  ]
  const release = async () => {
    for (const [url, handler] of mocks) await page.unroute(url, handler)
  }

  try {
    for (const [url, handler] of mocks) await page.route(url, handler)
    await page.goto(`${origin}/favicon.svg`)
    // Open the synthetic handoff in a fresh document without passing a capability to goto.
    await Promise.all([
      page.waitForRequest(`${endpoint}/resolve`),
      page.evaluate(
        ({ path, token }) => {
          window.setTimeout(() => {
            const fragment = new URLSearchParams({ token })
            window.location.replace(`${path}#${fragment}`)
          }, 0)
        },
        { path, token: 'hm_synthetic_routing_continuation_audit' },
      ),
    ])
    await page.waitForFunction(() => window.location.hash === '')
    const main = page.getByRole('main')
    const heading = (name: string) => main.getByRole('heading', { name, exact: true })
    const status = (text: string) => main.getByRole('status').filter({ hasText: text })
    const alert = (text: string) => main.getByRole('alert').filter({ hasText: text })
    const serverError = t('Something went wrong on our side. Try again in a moment.')
    switch (id) {
      case 'routing-continuation-loading':
        await status(t('Loading…')).waitFor()
        pendingMocks.set(page, release)
        return path
      case 'routing-continuation-unavailable':
        await heading(t('This booking link is unavailable')).waitFor()
        return path
      case 'routing-continuation-load-error':
        await alert(serverError).waitFor()
        return path
      case 'routing-continuation-slots-loading':
        await status(t('Loading available times…')).waitFor()
        pendingMocks.set(page, release)
        return path
      case 'routing-continuation-slots-empty':
        await status(t('No available times this month.')).waitFor()
        return path
      case 'routing-continuation-slots-error':
        await alert(serverError).waitFor()
        return path
    }

    await heading(AUDIT_TITLE).waitFor()
    const day = main.locator('button.day-available').first()
    await day.waitFor()
    if (id === 'routing-continuation') return path

    await day.press('Enter')
    const slot = main.locator('.slots button').first()
    await slot.waitFor()
    if (id === 'routing-continuation-slots') return path

    await slot.press('Enter')
    await heading(t('Your details')).waitFor()
    if (id === 'routing-continuation-details') return path

    const confirm = main.getByRole('button', { name: t('Confirm booking'), exact: true })
    if (id === 'routing-continuation-invalid') {
      await main.getByLabel(t('Your name'), { exact: true }).fill('')
      await confirm.press('Enter')
      await alert(t('Please check the form')).waitFor()
      return path
    }

    await Promise.all([page.waitForRequest(`${endpoint}/bookings`), confirm.press('Enter')])
    switch (id) {
      case 'routing-continuation-booking':
        await main.getByRole('button', { name: t('Booking…'), exact: true }).waitFor()
        pendingMocks.set(page, release)
        break
      case 'routing-continuation-booking-error':
        await alert(serverError).waitFor()
        break
      case 'routing-continuation-confirmation':
        await heading(t('You’re booked')).waitFor()
        break
    }
    return path
  } finally {
    if (!pendingMocks.has(page)) await release()
  }
}
