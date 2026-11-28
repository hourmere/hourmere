import type { Page } from '@playwright/test'
import { scanA11y } from '../a11y.ts'
import { expect, test } from '../fixtures.ts'

const teamBookings = '/app/team/bookings'
const teamBookingApi = '/api/v1/team/bookings'
const bulkApi = `${teamBookingApi}/bulk-cancellations`
const previewPath = `${bulkApi}/preview`
const confirmPath = `${bulkApi}/*/confirm`
const statusPath = (id: string) => `${bulkApi}/${id}`

function row(page: Page, event: string) {
  return page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: event, exact: true }) })
}

async function expectViewportFit(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(page.viewportSize()?.width ?? 0)
  const dialog = page.getByRole('dialog')
  await expect
    .poll(() =>
      dialog.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return (
          box.left >= -1 &&
          box.right <= window.innerWidth + 1 &&
          element.scrollWidth <= element.clientWidth + 1
        )
      }),
    )
    .toBe(true)
}

test.describe('team booking bulk cancellation enabled', () => {
  test.use({ teamBookingBulkEnabled: true })

  test('previews exact entries, recovers a lost receipt, and retries an unsuccessful booking', async ({
    page,
    app,
  }, testInfo) => {
    const mobile = testInfo.project.name === 'mobile'
    const zh = mobile
    const ui = (english: string, chinese: string) => (zh ? chinese : english)
    if (mobile) await page.setViewportSize({ width: 320, height: 568 })
    await page.emulateMedia({ colorScheme: mobile ? 'dark' : 'light' })
    const titles = ['Cancel this fixture', 'Retry this fixture', 'Paid successor fixture']
    const [successful, unsuccessful, paid] = await app.teamBookingBulk.seed(titles, {
      paidIndex: 2,
    })
    if (!successful || !unsuccessful || !paid) throw new Error('Three bulk targets are required')
    const ids = [successful.id, unsuccessful.id, paid.id]
    await app.teamBookingBulk.blockCancellation(unsuccessful.id)
    await app.auditSignIn(true, zh ? 'zh-CN' : 'en', 'team')
    await page.goto(`${app.url}${teamBookings}?status=confirmed`)

    const start = page.getByRole('button', {
      name: ui('Select bookings to cancel', '选择要取消的预约'),
      exact: true,
    })
    await start.press('Enter')
    const choose = row(page, successful.title).getByRole('checkbox')
    await choose.press('Space')
    await expect(choose).toBeChecked()
    await page
      .getByRole('button', { name: ui('Select this page', '选择本页'), exact: true })
      .press('Enter')
    await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(3)

    const review = page.getByRole('button', {
      name: ui('Review cancellation', '查看取消预览'),
      exact: true,
    })
    const preview = page.getByRole('dialog', {
      name: ui('Review bulk cancellation', '确认批量取消'),
      exact: true,
    })
    const confirm = preview.getByRole('button', {
      name: ui('Cancel 2 bookings', '取消 2 条预约'),
      exact: true,
    })
    const unsupported = ui(
      'Unsupported booking (including paid or imported bookings)',
      '不支持批量取消的预约（包括涉及付款的预约或导入记录）',
    )
    await review.press('Enter')
    await expect(preview.getByRole('heading', { level: 2 })).toBeFocused()
    await expect(preview).toContainText('FixtureTeam')
    await expect(preview).toContainText('UTC')
    await expect(preview).toContainText(ui('Confirmed', '已确认'))
    for (const title of titles) await expect(preview).toContainText(title)
    await expect(preview).toContainText(unsupported)
    await expect(confirm).toBeEnabled()
    await expectViewportFit(page)
    expect(await preview.evaluate((dialog) => getComputedStyle(dialog).colorScheme)).toBe(
      mobile ? 'dark' : 'light',
    )
    const scan = await scanA11y(page)
    expect(scan.passes).toBeGreaterThan(0)
    expect(
      scan.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical'),
    ).toEqual([])

    await page.keyboard.press('Escape')
    await expect(preview).toHaveCount(0)
    await expect(review).toBeFocused()
    expect(await app.teamBookingBulk.statuses(ids)).toEqual(['confirmed', 'confirmed', 'confirmed'])
    await review.press('Enter')
    await expect(confirm).toBeEnabled()

    const submissions: { id: string; bodyless: boolean; status: number }[] = []
    const dropResponse = Promise.withResolvers<void>()
    let batchId = ''
    let checkedUnresolved = false
    await page.route(`${app.url}${confirmPath}`, async (route) => {
      const request = route.request()
      const id = new URL(request.url()).pathname.split('/').at(-2) ?? ''
      const response = await route.fetch({ maxRedirects: 0 })
      submissions.push({ id, bodyless: request.postData() === null, status: response.status() })
      if (submissions.length === 1) {
        batchId = id
        await dropResponse.promise
        await route.abort('connectionreset')
      } else {
        await route.fulfill({ response })
      }
    })
    await page.route(`${app.url}${bulkApi}/*`, async (route) => {
      if (
        route.request().method() === 'GET' &&
        new URL(route.request().url()).pathname === statusPath(batchId) &&
        !checkedUnresolved
      ) {
        // An inconclusive status read during recovery leaves the original submission retryable.
        checkedUnresolved = true
        return route.fulfill({ status: 404, json: { error: 'bulk_cancellation_not_found' } })
      }
      return route.fallback()
    })

    const results = page.getByRole('dialog', {
      name: ui('Bulk cancellation status', '批量取消状态'),
      exact: true,
    })
    try {
      await confirm.press('Enter')
      await expect(results.getByRole('heading')).toBeFocused()
      await expect(results.getByRole('status')).toContainText(
        ui('Checking whether your cancellation was accepted…', '正在检查取消请求是否已受理…'),
      )
    } finally {
      dropResponse.resolve()
    }
    await results
      .getByRole('button', { name: ui('Retry submission', '重试提交'), exact: true })
      .press('Enter')

    const completion = ui('Bulk cancellation completed', '批量取消已完成')
    const counts = ui(
      '1 cancelled, 0 pending, 2 skipped or failed.',
      '已取消 1 条，待处理 0 条，已跳过或处理失败 2 条。',
    )
    const status = results.getByRole('status')
    await expect(status).toHaveAttribute('aria-atomic', 'true')
    await expect(status.filter({ hasText: completion })).toBeVisible()
    await expect(status.filter({ hasText: counts })).toBeVisible()
    await expect(results).toContainText(
      zh ? '无法处理这条预约' : /could not process|could not be processed/i,
    )
    await expect(results).toContainText(unsupported)
    await expectViewportFit(page)
    expect(checkedUnresolved).toBe(true)
    expect(submissions).toHaveLength(2)
    expect(submissions[0]).toEqual({ id: batchId, bodyless: true, status: 202 })
    expect(submissions[1]).toMatchObject({ id: batchId, bodyless: true })
    expect([200, 202]).toContain(submissions[1]?.status)
    expect(await app.teamBookingBulk.effects(batchId)).toEqual({
      audit: [
        { action: 'booking.bulk_cancellation_admitted', target_id: batchId },
        { action: 'booking.bulk_cancellation_completed', target_id: batchId },
        { action: 'booking.cancelled', target_id: successful.id },
      ],
      items: [
        { booking_id: successful.id, outcome: 'cancelled' },
        { booking_id: unsuccessful.id, outcome: 'processing_failed' },
        { booking_id: paid.id, outcome: 'booking_not_supported' },
      ],
      refunds: 0,
    })

    const close = results.getByRole('button', { name: ui('Close', '关闭'), exact: true })
    await close.press('Enter')
    await expect(row(page, successful.title)).toHaveCount(0)
    await expect(row(page, paid.title)).toBeVisible()
    await page.reload()
    const view = page.getByRole('button', {
      name: ui('View bulk cancellation', '查看批量取消'),
      exact: true,
    })
    await view.click()
    await expect(results.getByRole('status').filter({ hasText: counts })).toBeVisible()
    await close.click()

    await app.teamBookingBulk.unblockCancellation()
    await start.click()
    await row(page, unsuccessful.title).getByRole('checkbox').check()
    await review.click()
    await preview
      .getByRole('button', { name: ui('Cancel 1 booking', '取消 1 条预约'), exact: true })
      .click()
    await expect(
      results.getByRole('status').filter({
        hasText: ui(
          '1 cancelled, 0 pending, 0 skipped or failed.',
          '已取消 1 条，待处理 0 条，已跳过或处理失败 0 条。',
        ),
      }),
    ).toBeVisible()
    expect(submissions).toHaveLength(3)
    expect(submissions[2]?.id).not.toBe(batchId)
    expect(await app.teamBookingBulk.statuses(ids)).toEqual(['cancelled', 'cancelled', 'confirmed'])
  })

  test('keeps selection on the newest page and abandons an old preview when filters change', async ({
    app,
    page,
  }) => {
    const titles = Array.from({ length: 26 }, (_, index) => `Selection fixture ${index + 1}`)
    await app.teamBookingBulk.seed(titles)
    await app.authorizeTeamSession()
    await page.goto(`${app.url}${teamBookings}`)

    const start = page.getByRole('button', { name: 'Select bookings to cancel', exact: true })
    const review = page.getByRole('button', { name: 'Review cancellation', exact: true })
    const first = row(page, 'Selection fixture 1').getByRole('checkbox')
    await start.click()
    await first.check()
    await expect(first).toBeChecked()
    await page.getByRole('button', { name: 'Show more bookings', exact: true }).click()
    const last = row(page, 'Selection fixture 26').getByRole('checkbox')
    await expect(last).toBeVisible()
    await expect(first).toHaveCount(0)
    await expect(review).toBeDisabled()
    await last.check()

    const requested = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    await page.route(
      `${app.url}${previewPath}`,
      async (route) => {
        try {
          // Let the real server issue a preview, then release the response to the old view.
          const response = await route.fetch({ maxRedirects: 0 })
          expect(response.status()).toBe(200)
          requested.resolve()
          await release.promise
          await route.fulfill({ response })
        } finally {
          finished.resolve()
        }
      },
      { times: 1 },
    )
    await review.click()
    await requested.promise
    try {
      await expect(page.getByRole('button', { name: 'Loading…', exact: true })).toBeDisabled()
      await page.locator('.team-bookings-filters summary').click()
      await page.getByLabel('Order', { exact: true }).selectOption('desc')
      await Promise.all([
        page.waitForResponse((response) => {
          const url = new URL(response.url())
          return url.pathname === teamBookingApi && url.searchParams.get('order') === 'desc'
        }),
        page.getByRole('button', { name: 'Apply filters', exact: true }).click(),
      ])
    } finally {
      release.resolve()
    }
    await finished.promise
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(row(page, 'Selection fixture 26')).toBeVisible()
    if (await start.isVisible()) await start.click()
    await expect(review).toBeDisabled()
    await expect(last).not.toBeChecked()
    await last.check()
    await page.getByRole('button', { name: 'Refresh bookings', exact: true }).click()
    await expect(last).not.toBeChecked()
    await expect(review).toBeDisabled()
    await last.check()
    await page.reload()
    await expect(row(page, 'Selection fixture 26')).toBeVisible()
    if (await start.isVisible()) await start.click()
    await expect(last).not.toBeChecked()
    await expect(review).toBeDisabled()
  })

  test('withdraws a prepared confirmation when the current administrator loses access', async ({
    app,
    page,
  }) => {
    const [booking] = await app.teamBookingBulk.seed(['Revoked fixture'])
    if (!booking) throw new Error('One bulk target is required')
    await app.teamBookingBulk.setActorRole('admin')
    const { teamId } = await app.authorizeTeamSession()
    await page.goto(`${app.url}${teamBookings}`)
    await page.getByRole('button', { name: 'Select bookings to cancel', exact: true }).click()
    await row(page, booking.title).getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Review cancellation', exact: true }).click()
    const confirm = page.getByRole('button', { name: 'Cancel 1 booking', exact: true })
    await expect(confirm).toBeEnabled()

    await page.route(
      `${app.url}${confirmPath}`,
      async (route) => {
        await app.teamBookingBulk.setActorRole('member')
        await route.continue()
      },
      { times: 1 },
    )
    const rejected = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/confirm'),
    )
    await confirm.click()
    const response = await rejected
    expect(response.status()).toBe(403)
    expect(response.request().headers()['x-expected-organization-id']).toBe(teamId)
    await expect(
      page.getByRole('heading', { name: 'Team bookings access is no longer available.' }),
    ).toBeFocused()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const denied = await page.request.get(`${app.url}${teamBookingApi}?bulkSelection=true`, {
      headers: { 'X-Expected-Organization-Id': teamId },
    })
    expect(denied.status()).toBe(403)
    expect(await denied.json()).toMatchObject({ error: 'team_management_access_denied' })
    expect(await app.teamBookingBulk.statuses([booking.id])).toEqual(['confirmed'])
  })
})

test('keeps bulk cancellation off by default and still offers single cancellation', async ({
  app,
  page,
}) => {
  const [booking] = await app.teamBookingBulk.seed(['Single cancellation fixture'])
  if (!booking) throw new Error('One booking is required')
  const { teamId } = await app.authorizeTeamSession()
  await page.goto(`${app.url}${teamBookings}`)
  await expect(row(page, booking.title)).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Select bookings to cancel', exact: true }),
  ).toHaveCount(0)
  const ordinary = await page.request.get(`${app.url}${teamBookingApi}?bulkSelection=true`, {
    headers: { 'X-Expected-Organization-Id': teamId },
  })
  expect(ordinary.status()).toBe(200)
  expect((await ordinary.json()).bulkPageToken === undefined).toBe(true)
  await row(page, booking.title).getByRole('button', { name: booking.title, exact: true }).click()
  const detail = page.locator('.team-booking-detail')
  await detail.getByRole('button', { name: 'Cancel booking…', exact: true }).click()
  await detail.getByRole('button', { name: 'Cancel booking', exact: true }).click()
  await expect(row(page, booking.title)).toContainText('Cancelled')
  expect(await app.teamBookingBulk.statuses([booking.id])).toEqual(['cancelled'])
})
