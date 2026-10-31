import type { Page } from '@playwright/test'
import { scanA11y } from '../a11y.ts'
import { settleAuditLayout } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import { measureLayout } from '../layout.ts'
import { publicLanguageName } from '../public-language.ts'

async function expectMenuFits(page: Page, width: number, state: string) {
  await page.evaluate(settleAuditLayout)
  const findings = await page.evaluate(measureLayout, { width, height: 900 })
  expect(
    findings.filter(({ code }) => /overflow|clipped|scan-error/.test(code)),
    `${state} fits the viewport`,
  ).toEqual([])
  const targets = await page.getByRole('menuitemradio').evaluateAll((items) =>
    items.map((item) => {
      const box = item.getBoundingClientRect()
      return { width: box.width, height: box.height }
    }),
  )
  expect(targets.length, `${state}: menu remains open for measurement`).toBeGreaterThanOrEqual(2)
  expect(
    targets.every((target) => target.width >= 44 && target.height >= 44),
    `${state}: touch targets are at least 44px`,
  ).toBe(true)
  const scan = await scanA11y(page)
  expect(scan.passes, `${state} completed an axe scan`).toBeGreaterThan(0)
  expect(
    scan.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical'),
    `${state} has no serious or critical WCAG violations`,
  ).toEqual([])
}

for (const theme of ['light', 'dark'] as const) {
  for (const locale of ['en', 'zh-CN'] as const) {
    test.describe(`${theme} ${locale} compact public language`, () => {
      test.use({ colorScheme: theme, locale })
      test('menus fit public surfaces and preserve language across reloads', async ({
        page,
        app,
      }, testInfo) => {
        test.setTimeout(120_000)
        const mobile = testInfo.project.name === 'mobile'
        const widths = mobile ? [320, 375] : [1280]
        const surfaces = [
          { name: 'booking', path: app.personalPath },
          { name: 'host', path: app.personalPath.split('/').slice(0, 2).join('/') },
          { name: 'manage', path: '/booking' },
          { name: 'confirmation', path: '/sign-in/confirm' },
        ] as const
        const nativeName = locale === 'en' ? 'English' : '简体中文'
        const switched = locale === 'en' ? 'zh-CN' : 'en'
        const switchedName = switched === 'en' ? 'English' : '简体中文'
        // Set an initial preference once per surface, without overriding the user's reload.
        await page.goto(app.url + app.personalPath)
        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 })
          for (const { name, path } of surfaces) {
            const state = `${theme} ${locale} ${width}px ${path}`
            await test.step(state, async () => {
              await page.evaluate(
                (value) => localStorage.setItem('hourmere-language', value),
                locale,
              )
              await page
                .context()
                .addCookies([
                  { name: 'hourmere-language', value: locale, url: app.url, sameSite: 'Lax' },
                ])
              await page.goto(app.url + path)
              // Booking initially renders a loading PublicLayout, then mounts BookingFlow's
              // layout once the event arrives. Exercise the finished surface's controls.
              if (name === 'booking') {
                await expect(
                  page.getByRole('heading', { name: 'Fixture call', exact: true }),
                  state,
                ).toBeVisible()
                await expect(page.locator('.calendar-grid'), state).toHaveAttribute(
                  'aria-busy',
                  'false',
                )
              } else if (name === 'host') {
                await expect(page.locator('.host-header h1'), state).toHaveText('Fixture Host')
                await expect(
                  page.locator('.event-card-title').filter({ hasText: 'Fixture call' }),
                  state,
                ).toBeVisible()
              } else if (name === 'manage') {
                await expect(
                  page.getByRole('heading', { name: /^(Open your booking link|打开预约链接)$/ }),
                  state,
                ).toBeVisible()
              } else {
                await expect(page.locator('#incomplete'), state).toBeVisible()
              }
              await page.evaluate(settleAuditLayout)
              const trigger = page.getByRole('button', { name: publicLanguageName })
              await expect(trigger, `${state}: current language is visible`).toContainText(
                nativeName,
              )
              await expect(
                page.getByText(/^(Interface language|界面语言)$/, { exact: true }),
              ).toHaveCount(0)
              await trigger.focus()
              await page.keyboard.press('Enter')
              const current = page.getByRole('menuitemradio', { name: nativeName, exact: true })
              await expect(current, `${state}: selected language is announced`).toHaveAttribute(
                'aria-checked',
                'true',
              )
              await expect(
                current,
                `${state}: Enter opens with the current language focused`,
              ).toBeFocused()
              await page.keyboard.press('ArrowDown')
              await expect(current, `${state}: ArrowDown moves focus`).not.toBeFocused()
              await page.keyboard.press('Escape')
              await expect(page.getByRole('menu')).toHaveCount(0)
              await expect(trigger, `${state}: Escape returns focus to the trigger`).toBeFocused()
              await page.keyboard.press('Space')
              await expect(
                current,
                `${state}: Space opens with the current language focused`,
              ).toBeFocused()
              await expectMenuFits(page, width, state)
              await page.keyboard.press('Escape')
              if (mobile) await trigger.tap()
              else await trigger.click()
              const option = page.getByRole('menuitemradio', { name: switchedName, exact: true })
              if (mobile) await option.tap()
              else await option.click()
              await expect(trigger).toContainText(switchedName)
              await expect(
                trigger,
                `${state}: selection returns focus to the trigger`,
              ).toBeFocused()
              await expect(page.getByRole('menu')).toHaveCount(0)
              expect(await page.evaluate(() => localStorage.getItem('hourmere-language'))).toBe(
                switched,
              )
              await page.reload()
              await expect(page.getByRole('button', { name: publicLanguageName })).toContainText(
                switchedName,
              )
              await expect(
                page.locator('html'),
                `${state}: choice persists on reload`,
              ).toHaveAttribute('lang', switched)
            })
          }
        }
      })
    })
  }
}
