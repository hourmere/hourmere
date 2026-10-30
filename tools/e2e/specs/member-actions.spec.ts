import type { Page } from '@playwright/test'
import type { components } from '../../../apps/web/src/api/schema.d.ts'
import { scanA11y } from '../a11y.ts'
import { settleAuditLayout } from '../audit-pages.ts'
import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'
import { measureLayout } from '../layout.ts'

async function auditActions(page: Page) {
  await page.evaluate(settleAuditLayout)
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('The member actions audit requires a viewport')
  expect(await page.evaluate(measureLayout, viewport)).toEqual([])
  const scan = await scanA11y(page)
  expect(scan.passes).toBeGreaterThan(0)
  expect(
    scan.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? '')),
  ).toEqual([])
}

for (const language of ['en', 'zh-CN'] as const) {
  test(`member removal preserves a booking and its handling list in ${language}`, async ({
    page,
    app,
  }, testInfo) => {
    test.setTimeout(120_000)
    await page.goto(`${app.url}${app.collectivePath}`)
    await pickSlot(page, page)
    await fillInvitee(page)
    await page.getByRole('button', { name: 'Confirm booking', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
    const { teamId } = await app.authorizeTeamSession()
    const eventsResponse = await page.request.get(`${app.url}/api/v1/event-types`)
    expect(eventsResponse.ok()).toBe(true)
    const events = (await eventsResponse.json()) as {
      data: components['schemas']['EventType'][]
    }
    const collective = events.data.find((event) => event.schedulingType === 'collective')
    if (!collective) throw new Error('The fixture requires a collective event type')
    const title = `SyntheticLongEventTitle${'withoutSpaces'.repeat(10)}`
    const changed = await page.request.patch(`${app.url}/api/v1/event-types/${collective.id}`, {
      headers: { Origin: app.url, 'X-Expected-Organization-Id': teamId },
      data: { title },
    })
    expect(changed.ok()).toBe(true)
    await app.auditSignIn(true, language, 'team')
    const width = testInfo.project.name === 'mobile' ? 320 : 1280
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(`${app.url}/app/settings`)
    const remove = page.getByRole('button', {
      name: /^(Remove member: |移除成员：)Second Required Host$/,
    })
    await expect(remove).toBeVisible()
    await remove.focus()
    await page.keyboard.press('Enter')
    const preview = page.getByRole('region', { name: /^(Remove team member|移除团队成员)$/ })
    await expect(preview.getByRole('heading', { level: 3 })).toBeFocused()
    await expect(preview.getByText(title, { exact: true }).first()).toBeVisible()
    await expect(
      preview.getByText(/^(1 future or in-progress bookings|1 个未来或进行中的预约)$/),
    ).toBeVisible()
    await auditActions(page)
    await page.keyboard.press('Escape')
    await expect(preview).toHaveCount(0)
    await expect(remove).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(preview.getByText(title, { exact: true }).first()).toBeVisible()
    const removed = page.waitForResponse(
      (response) => response.url().endsWith('/removal') && response.request().method() === 'POST',
    )
    await preview.getByRole('button', { name: /^(Remove member|移除成员)$/ }).click()
    const response = await removed
    expect(response.status()).toBe(200)
    expect(response.request().headers()['x-expected-organization-id']).toBe(teamId)
    await expect(preview.locator('.alert-success[role="status"]')).toContainText(
      /Member removed|成员已移除/,
    )
    await expect(preview.getByRole('heading', { name: /^(Handling list|处理清单)$/ })).toBeVisible()
    await expect(preview.getByText(/Fixture Invitee/)).toBeVisible()
    await expect(
      preview.getByRole('link', { name: /^(Review team bookings|查看团队预约)$/ }),
    ).toBeVisible()
    await auditActions(page)
    expect(await app.rows()).toEqual([{ source: 'web', status: 'confirmed' }])
    expect(await app.hostCounts()).toEqual([2])
    const current = await page.request.get(`${app.url}/api/v1/event-types/${collective.id}`)
    expect(current.ok()).toBe(true)
    expect((await current.json()).isActive).toBe(false)
  })
}
