import type { Page } from '@playwright/test'
import { scanA11y } from '../a11y.ts'
import { prepareAuditLocale, settleAuditLayout } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import { measureLayout } from '../layout.ts'

const longName = `Synthetic team ${'with a long name '.repeat(9)}`.trim()

async function auditShell(page: Page) {
  await page.evaluate(settleAuditLayout)
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('The shell audit requires a viewport')
  const findings = await page.evaluate(measureLayout, viewport)
  expect(findings).toEqual([])
  const scan = await scanA11y(page)
  expect(scan.passes).toBeGreaterThan(0)
  expect(
    scan.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? '')),
  ).toEqual([])
}

for (const locale of ['en-US', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test.describe(`${locale} ${theme}`, () => {
      test.use({ locale, colorScheme: theme })
      test('space menu fits narrow and desktop screens with keyboard and axe', async ({
        page,
        app,
      }) => {
        test.setTimeout(120_000)
        const { teamId, personalId } = await app.authorizeTeamSession()
        await page.addInitScript(prepareAuditLocale, locale)
        await page.goto(`${app.url}/api/health`)
        const organizationsResponse = await page.request.get(
          `${app.url}/api/auth/organization/list`,
        )
        expect(organizationsResponse.status()).toBe(200)
        const organizations: { id: string; name: string }[] = await organizationsResponse.json()
        const storedPersonalName = organizations.find(({ id }) => id === personalId)?.name
        expect(storedPersonalName).toBeTruthy()
        if (!storedPersonalName) throw new Error('The fixture requires a personal organization')
        // Use the existing owner endpoint against this fixture's disposable database.
        const renamed = await page.evaluate(
          async ({ teamId, name }) =>
            (
              await fetch('/api/auth/organization/update', {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'X-Expected-Organization-Id': teamId,
                },
                body: JSON.stringify({ organizationId: teamId, data: { name } }),
              })
            ).status,
          { teamId, name: longName },
        )
        expect(renamed).toBe(200)
        await page.goto(`${app.url}/app/settings`)
        const trigger = page.getByRole('button', { name: /^(Switch space|切换空间)/ })
        const personal = page.getByRole('menuitemradio', { name: /^(Personal|个人空间)( |$)/ })
        const team = page.getByRole('menuitemradio', { name: new RegExp(`^${longName}`) })
        const expectSpaces = async () => {
          await expect(team).toBeVisible()
          await expect(personal).toHaveCount(1)
          await expect(page.getByRole('menuitemradio')).toHaveCount(2)
          await expect(
            page.getByRole('menu').getByText(storedPersonalName, { exact: true }),
          ).toHaveCount(0)
        }
        for (const width of [320, 1280]) {
          await page.setViewportSize({ width, height: 720 })
          await expect(trigger).toContainText(longName)
          await expect(trigger).toContainText(/Owner|所有者/)
          await auditShell(page)
          await trigger.focus()
          await page.keyboard.press('ArrowDown')
          await expect(page.getByRole('menu')).toBeVisible()
          await expectSpaces()
          const focusRing = await page.locator('.space-menu button:focus').evaluate((button) => {
            const style = getComputedStyle(button)
            return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) }
          })
          expect(focusRing.style).toBe('solid')
          expect(focusRing.width).toBeGreaterThanOrEqual(2)
          await expect(team.locator('[title]')).toHaveAttribute('title', longName)
          await auditShell(page)
          await page.keyboard.press('Escape')
          await expect(page.getByRole('menu')).toHaveCount(0)
          await expect(trigger).toBeFocused()
          await page.keyboard.press('Enter')
          await page.keyboard.press('Home')
          await expect(personal).toBeFocused()
          await page.keyboard.press('Enter')
          await expect(trigger).toContainText(/Personal|个人/)
          await expect(trigger).toBeFocused()
          await page.keyboard.press('Enter')
          await expectSpaces()
          await page.keyboard.press('Escape')
          await page.reload()
          await expect(trigger).toContainText(/Personal|个人/)
          await trigger.focus()
          await page.keyboard.press('Enter')
          await expectSpaces()
          await team.focus()
          await page.keyboard.press('Enter')
          await expect(trigger).toContainText(longName)
          await expect(trigger).toBeFocused()
          await page.keyboard.press('Enter')
          await expectSpaces()
          await page.keyboard.press('Escape')
          await auditShell(page)
        }
      })
    })
  }
}
