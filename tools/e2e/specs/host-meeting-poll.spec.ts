import type { components } from '../../../apps/web/src/api/schema.d.ts'
import { admin as english } from '../../../apps/web/src/i18n/catalogues/en/admin.ts'
import { admin as chinese } from '../../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { meetingPollPath, PATHS } from '../../../apps/web/src/paths.ts'
import { openAuditPage } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'

test.use({ uiAudit: true })

test('shows private results and conditional scheduling on desktop and phone', async ({
  page,
  app,
  isMobile,
}) => {
  const copy = isMobile ? chinese : english
  if (isMobile) await page.setViewportSize({ width: 320, height: 844 })
  const locale = isMobile ? 'zh-CN' : 'en-US'
  await openAuditPage(page, app, 'host-poll-conditional', { locale })
  await expect(
    page.getByText(
      copy[
        'Verified voters can see totals. In a small poll, subtracting their own vote can reveal how someone else voted.'
      ],
    ),
  ).toBeVisible()
  const matrix = page.getByRole('region', { name: copy['Votes by voter and time'] })
  await expect(matrix.getByRole('table')).toBeVisible()
  await expect(matrix.getByText(copy['Currently unavailable'])).toBeVisible()
  await matrix.focus()
  await expect(matrix).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const acknowledgment = page.getByRole('checkbox', {
    name: copy['I acknowledge the selected conditional votes.'],
  })
  const schedule = page.getByRole('button', { name: copy['Schedule meeting'], exact: true })
  await expect(schedule).toBeDisabled()
  await acknowledgment.press('Space')
  await expect(schedule).toBeEnabled()
  await openAuditPage(page, app, 'host-poll-scheduled', { locale })
  await expect(page.getByTestId('meeting-poll-booking-link')).toHaveAttribute(
    'href',
    /^\/app\/bookings\//,
  )
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await openAuditPage(page, app, 'host-poll-other-space', { locale })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('manages a poll created through REST using the real host page', async ({ page, app }) => {
  const fixture = await app.auditState()
  await app.auditSignIn(true)
  const now = Temporal.Now.instant()
  const start = now.add({ hours: 48 })
  const range = new URLSearchParams({
    start: start.toString(),
    end: start.add({ hours: 168 }).toString(),
  })
  const response = await page.request.get(
    `${app.url}/api/v1/public${fixture.bookingPath}/slots?${range}`,
  )
  expect(response.status()).toBe(200)
  const { data } = (await response.json()) as { data: { start: string }[] }
  expect(data.length).toBeGreaterThanOrEqual(2)
  const created = await page.request.post(`${app.url}/api/v1/meeting-polls`, {
    headers: {
      origin: app.url,
      'x-expected-organization-id': fixture.organizationId,
      'idempotency-key': crypto.randomUUID(),
    },
    data: {
      eventTypeId: fixture.eventTypeId,
      candidateStarts: data.slice(0, 2).map((slot) => slot.start),
      deadlineAt: now.add({ hours: 24 }).toString(),
      displayTimeZone: 'UTC',
      admissionMode: 'invited',
    },
  })
  expect(created.status()).toBe(201)
  const { poll } = (await created.json()) as components['schemas']['MeetingPollLink']

  await page.goto(app.url + PATHS.meetingPolls)
  const pollLink = page.getByRole('link', { name: poll.title, exact: true })
  await expect(pollLink).toHaveAttribute('href', meetingPollPath(poll.id, fixture.organizationId))
  await pollLink.press('Enter')
  await expect(page.getByRole('heading', { name: 'Poll results' })).toBeVisible()
  await page.getByRole('button', { name: 'Close voting…', exact: true }).press('Enter')
  await expect(page.getByRole('button', { name: 'Go back', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Close voting', exact: true }).press('Enter')
  await expect(page.getByText('Voting closed', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel poll…', exact: true }).press('Enter')
  await page.getByRole('button', { name: 'Cancel poll', exact: true }).press('Enter')
  await expect(page.getByText('Canceled', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Delete poll…', exact: true }).press('Enter')
  await page.getByRole('button', { name: 'Delete poll', exact: true }).press('Enter')
  await expect(page.getByText('No meeting polls yet.')).toBeVisible()
})
