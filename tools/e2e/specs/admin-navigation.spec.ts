import { accountMenuButton, accountMenuPanel } from '../account-menu.ts'
import { openAuditPage } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import { focusedMeasurement } from '../layout.ts'

test.use({ uiAudit: true })

for (const [locale, theme] of [
  ['en-US', 'light'],
  ['zh-CN', 'dark'],
] as const) {
  test(`admin navigation keeps keyboard access in ${locale} ${theme}`, async ({
    page,
    app,
  }, testInfo) => {
    const mobile = testInfo.project.name === 'mobile'
    if (mobile) await page.setViewportSize({ width: 320, height: 568 })
    await page.emulateMedia({ colorScheme: theme })
    await openAuditPage(page, app, 'event-types', { locale })
    const zh = locale === 'zh-CN'
    const integrationName = zh ? '集成' : 'Integrations'
    const nav = page.getByRole('navigation', { name: zh ? '主导航' : 'Main', exact: true })
    const integrations = nav.getByRole('region', { name: integrationName, exact: true })
    const toggle = nav.getByRole('button', { name: integrationName, exact: true })
    const account = accountMenuButton(page)
    const panel = accountMenuPanel(page)
    const language = panel.getByRole('combobox', { name: zh ? '界面语言' : 'Interface language' })
    const signOut = panel.getByRole('button', { name: zh ? '退出登录' : 'Sign out' })

    await expect(page.getByRole('banner').getByRole('combobox')).toHaveCount(0)
    await expect(account).toBeVisible()
    await expect(panel).toBeHidden()
    await expect(account).toHaveAttribute('aria-expanded', 'false')
    await account.press('Enter')
    await expect(account).toHaveAttribute('aria-expanded', 'true')
    await expect(panel.getByText('synthetic-host@hourmere.invalid', { exact: true })).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(language).toBeFocused()
    expect((await page.evaluate(focusedMeasurement)).finding).toBeUndefined()
    await page.keyboard.press('Tab')
    await expect(signOut).toBeFocused()
    expect((await page.evaluate(focusedMeasurement)).finding).toBeUndefined()
    if (mobile) {
      for (const control of [account, language, signOut, toggle]) {
        const bounds = await control.boundingBox()
        expect(bounds?.width).toBeGreaterThanOrEqual(44)
        expect(bounds?.height).toBeGreaterThanOrEqual(44)
      }
    }
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(account).toBeFocused()
    expect((await page.evaluate(focusedMeasurement)).finding).toBeUndefined()

    if (mobile) {
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(integrations.getByRole('link')).toHaveCount(0)
      await toggle.press('Enter')
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await page.keyboard.press('Tab')
      await expect(integrations.getByRole('link').first()).toBeFocused()
      expect((await page.evaluate(focusedMeasurement)).finding).toBeUndefined()
      await page.keyboard.press('Escape')
      await expect(toggle).toBeFocused()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.press('Space')
    } else await expect(toggle).toBeHidden()
    expect(
      await integrations
        .getByRole('link')
        .evaluateAll((links) => links.map((link) => link.getAttribute('href')).sort()),
    ).toEqual(['/app/api-keys', '/app/calendars', '/app/conferences', '/app/connected-apps'])
    const apiKeys = integrations.getByRole('link', { name: zh ? 'API 密钥' : 'API keys' })
    await apiKeys.press('Enter')
    await expect(page).toHaveURL(/\/app\/api-keys$/)
    await expect(page.getByRole('main')).toBeFocused()
    if (mobile) {
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(toggle).toHaveAttribute('aria-current', 'location')
    } else await expect(apiKeys).toHaveAttribute('aria-current', 'page')
  })
}
