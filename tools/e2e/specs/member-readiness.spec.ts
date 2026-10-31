import type { components } from '../../../apps/web/src/api/schema.d.ts'
import { scanA11y } from '../a11y.ts'
import { settleAuditLayout } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import { measureLayout } from '../layout.ts'

for (const language of ['en', 'zh-CN'] as const) {
  test(`member readiness supports configuration and keyboard navigation in ${language}`, async ({
    page,
    app,
  }, testInfo) => {
    test.setTimeout(90_000)
    await app.auditSignIn(true, language, 'team')
    await page.setViewportSize({
      width: testInfo.project.name === 'mobile' ? 320 : 1280,
      height: 1000,
    })
    let summaryRequests = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/member-readiness')) summaryRequests++
    })
    const response = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/member-readiness'),
    )
    await page.goto(`${app.url}/app/settings`)
    const summary = await response
    expect(summary.status()).toBe(200)
    const data = (await summary.json()) as components['schemas']['MemberReadinessPage']
    expect(data.members.length).toBeGreaterThan(1)
    const members = page.getByRole('region', { name: /^(Team members|团队成员)$/ })
    const rows = members.locator(':scope > ul.stack > li')
    const own = rows.filter({ hasText: 'Fixture Host' })
    const peer = rows.filter({ hasText: 'Second Required Host' })
    await expect(own.getByText(/^(Default schedule set|已设置默认时间表)$/)).toBeVisible()
    await expect(peer.getByRole('link')).toHaveCount(0)
    await expect(own).toContainText(/every team you belong to|所有团队共用/)
    await expect(members).toContainText(/do not guarantee available times|不保证有可约时段/)
    expect(summaryRequests).toBe(1)
    await page.evaluate(settleAuditLayout)
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('Expected the member readiness viewport')
    expect(await page.evaluate(measureLayout, viewport)).toEqual([])
    const accessibility = await scanA11y(page)
    expect(
      accessibility.violations.filter((item) =>
        ['serious', 'critical'].includes(item.impact ?? ''),
      ),
    ).toEqual([])
    const schedule = own.getByRole('link', {
      name: /^(Configure default schedule|配置默认时间表)$/,
    })
    await schedule.focus()
    await expect(schedule).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(own.getByRole('link', { name: /^(Configure calendars|配置日历)$/ })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(
      own.getByRole('link', { name: /^(Review conference accounts|检查会议账户)$/ }),
    ).toBeFocused()
    await schedule.press('Enter')
    await page.getByRole('link', { name: /^(New schedule|新日程)$/ }).click()
    const privateName = 'Synthetic personal default schedule'
    await page.getByRole('textbox', { name: /^(Name|名称)$/ }).fill(privateName)
    await page.getByRole('button', { name: /^(Create schedule|创建日程)$/ }).click()
    await page.getByRole('button', { name: /^(Make default|设为默认)$/ }).click()
    await expect(page.locator('.default-status .badge')).toContainText(/Default|默认/)
    const returned = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/member-readiness'),
    )
    await page.getByRole('link', { name: /^(Settings|设置)$/ }).click()
    expect((await returned).status()).toBe(200)
    await expect(own.getByText(/^(Default schedule set|已设置默认时间表)$/)).toBeVisible()
    await expect(members).not.toContainText(privateName)
    expect(summaryRequests).toBe(2)
  })
}
