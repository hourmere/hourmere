import { admin as englishAdmin } from '../../../apps/web/src/i18n/catalogues/en/admin.ts'
import { common as englishCommon } from '../../../apps/web/src/i18n/catalogues/en/common.ts'
import { admin as chineseAdmin } from '../../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { common as chineseCommon } from '../../../apps/web/src/i18n/catalogues/zh-CN/common.ts'
import { PATHS } from '../../../apps/web/src/paths.ts'
import { a11yFindings, scanA11y } from '../a11y.ts'
import { type AuditLocale, prepareAuditLocale, settleAuditLayout } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import { measureLayout } from '../layout.ts'
import {
  emptyEndpointId,
  fixtureDeliveryId,
  historyEndpointId,
  historyPrivateMarker,
} from '../webhook-delivery-fixtures.ts'

test.use({ uiAudit: true })

test('reads retained webhook delivery states, recovers a cursor, and switches endpoints', async ({
  page,
  app,
  isMobile,
}) => {
  const copy = isMobile
    ? { ...chineseCommon, ...chineseAdmin }
    : { ...englishCommon, ...englishAdmin }
  const locale = isMobile ? 'zh-CN' : 'en-US'
  const space = isMobile ? 'team' : undefined
  if (isMobile) await page.setViewportSize({ width: 320, height: 844 })
  await page.emulateMedia({ colorScheme: isMobile ? 'dark' : 'light' })
  await app.auditSignIn(true, locale, space)
  await page.addInitScript<AuditLocale>(prepareAuditLocale, locale)
  const fixture = await app.seedWebhookHistory(await app.auditState(), space)
  const activePath = `/api/v1/webhooks/${historyEndpointId}/deliveries`
  const emptyPath = `/api/v1/webhooks/${emptyEndpointId}/deliveries`
  const requests: { path: string; after: string | null; openingSpaceMatches: boolean }[] = []
  const firstRead = Promise.withResolvers<void>()
  let rejectCursor = false
  let failRefresh = false
  await page.route(
    (url) => url.origin === app.url && (url.pathname === activePath || url.pathname === emptyPath),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const after = url.searchParams.get('after')
      requests.push({
        path: url.pathname,
        after,
        openingSpaceMatches:
          (await request.headerValue('x-expected-organization-id')) === fixture.organizationId,
      })
      await firstRead.promise
      if (rejectCursor && after !== null) {
        rejectCursor = false
        // Trigger the production route's invalid_cursor error with a same-origin request.
        url.searchParams.set('after', 'invalid-synthetic-cursor')
        return route.continue({ url: url.href })
      }
      if (failRefresh && after === null) {
        failRefresh = false
        return route.fulfill({ status: 502, json: { message: historyPrivateMarker } })
      }
      return route.continue()
    },
  )

  try {
    await page.goto(app.url + PATHS.settings)
    const main = page.getByRole('main')
    const button = (name: string) => main.getByRole('button', { name, exact: true })
    const opener = (id: string) =>
      main
        .locator('.webhook-endpoint')
        .filter({ hasText: id })
        .getByRole('button', { name: copy['Delivery history'], exact: true })
    const history = main.locator('.webhook-history')
    const heading = history.getByRole('heading', { name: copy['Delivery history'], exact: true })
    const rows = history.getByRole('listitem')
    const older = button(copy['Load older deliveries'])
    const noRetained = history.getByText(copy['No deliveries retained in the last 30 days.'], {
      exact: true,
    })

    await button(copy.Webhooks).press('Enter')
    const initialResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === activePath && response.status() === 200,
    )
    const activeOpener = opener(historyEndpointId)
    if (isMobile) await activeOpener.tap()
    else await activeOpener.press('Enter')
    await expect(heading).toBeFocused()
    await expect(history.getByText(copy['Loading deliveries…'], { exact: true })).toBeVisible()
    await expect(noRetained).toHaveCount(0)
    firstRead.resolve()
    const data = await (await initialResponse).json()
    expect(JSON.stringify(data).includes(historyPrivateMarker)).toBe(false)
    expect(
      data.data.some((row: object) =>
        Object.keys(row).some((key) => /payload|signature|headers|secret/i.test(key)),
      ),
    ).toBe(false)

    await expect(rows).toHaveCount(50)
    const pending = rows.nth(0)
    await expect(pending.getByText(copy['webhook.delivery.pending'], { exact: true })).toBeVisible()
    await expect(pending.getByText('503', { exact: true })).toBeVisible()
    await expect(pending.getByText('2', { exact: true })).toBeVisible()
    await expect(pending.getByText(copy['HTTP error'], { exact: true })).toBeVisible()
    const date = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone: 'UTC',
    })
    await expect(pending.locator(`time[datetime="${fixture.createdAt.toISOString()}"]`)).toHaveText(
      date.format(fixture.createdAt),
    )
    await expect(
      pending.locator(`time[datetime="${fixture.lastAttemptAt.toISOString()}"]`),
    ).toBeVisible()
    const delivered = rows.nth(1)
    await expect(delivered.getByText(copy.Delivered, { exact: true })).toBeVisible()
    await expect(delivered.getByText('204', { exact: true })).toBeVisible()
    await expect(
      delivered.locator(`time[datetime="${fixture.deliveredAt.toISOString()}"]`),
    ).toBeVisible()
    await expect(rows.nth(2).getByText(copy.Failed, { exact: true })).toBeVisible()
    await expect(rows.nth(3).getByText(copy.Skipped, { exact: true })).toBeVisible()
    expect(
      await main.evaluate((node, marker) => node.innerHTML.includes(marker), historyPrivateMarker),
    ).toBe(false)

    const viewport = page.viewportSize()
    if (!viewport) throw new Error('Webhook history test requires a CSS viewport')
    await page.evaluate(settleAuditLayout)
    expect(await page.evaluate(measureLayout, viewport)).toEqual([])
    const scan = await scanA11y(page)
    expect(a11yFindings('webhook-delivery-history', scan.violations, []).findings).toEqual([])

    rejectCursor = true
    if (isMobile) await older.tap()
    else await older.press('Enter')
    await expect(history.getByRole('alert')).toHaveText(
      copy['This delivery history page is no longer available. Refresh history to start again.'],
    )
    const refresh = button(copy['Refresh history'])
    if (!isMobile) await expect(refresh).toBeFocused()
    failRefresh = true
    await refresh.press('Enter')
    await expect(
      history.getByText(copy['Could not load webhook deliveries.'], { exact: true }),
    ).toBeVisible()
    await expect(noRetained).toHaveCount(0)
    expect(
      await main.evaluate((node, marker) => node.innerHTML.includes(marker), historyPrivateMarker),
    ).toBe(false)

    await button(copy['Try again']).press('Enter')
    await expect(rows).toHaveCount(50)
    await older.press('Enter')
    await expect(rows).toHaveCount(51)
    await expect(rows.nth(50).getByText(fixtureDeliveryId(2), { exact: true })).toBeVisible()
    if (!isMobile) await expect(rows.nth(50)).toBeFocused()
    await expect(older).not.toBeVisible()

    await button(copy.Close).press('Enter')
    await expect(activeOpener).toBeFocused()
    await opener(emptyEndpointId).press('Enter')
    await expect(noRetained).toBeVisible()
    await expect(rows).toHaveCount(0)
    expect(requests).toEqual(
      [
        [activePath, null],
        [activePath, fixtureDeliveryId(3)],
        [activePath, null],
        [activePath, null],
        [activePath, fixtureDeliveryId(3)],
        [emptyPath, null],
      ].map(([path, after]) => ({ path, after, openingSpaceMatches: true })),
    )
  } finally {
    firstRead.resolve()
  }
})
