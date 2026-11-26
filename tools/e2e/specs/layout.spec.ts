import { a11yFindings, scanA11y } from '../a11y.ts'
import { AUDIT_GUEST_NAME, AUDIT_HOST_NOTE, AUDIT_TEAM_NAME, AUDIT_TITLE } from '../audit-data.ts'
import { auditLocales, auditPages, openAuditPage, settleAuditLayout } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import { layoutViewports, measureKeyboard, measureLayout } from '../layout.ts'
import {
  type AuditLocale,
  type AuditReport,
  assertAuditFindings,
  writeAuditReport,
} from '../reports.ts'

// OAuth provider rate limits are process-wide, so a fresh app/database alone must
// not consume the five-per-minute dynamic-registration budget in matrix scans.
test.describe('successive isolated OAuth audit apps', () => {
  test.describe.configure({ mode: 'serial' })
  for (let attempt = 1; attempt <= 7; attempt++)
    test(`prepares consent in isolated app ${attempt}`, async ({ page, app }) => {
      await openAuditPage(page, app, 'oauth-consent')
      await expect(page.getByRole('button', { name: 'Allow access', exact: true })).toBeVisible()
      await expect(page.getByText('Synthetic audit connector', { exact: true })).toBeVisible()
    })
})

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
  { width: 375, height: 812 },
  { width: 320, height: 256 },
]) {
  test.describe(`page preparation ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, isMobile: viewport.width <= 480, hasTouch: viewport.width <= 480 })
    for (const locale of ['en-US', 'zh-CN'] as const)
      test(`prepare additional required page states ${locale}`, async ({ page, app }) => {
        const selectors = {
          host: '.host-header > .host-avatar',
          booking: '.event-title + .host-identity',
          'booking-form': '.details-step form input[type="email"]',
          'booking-confirmation': '.confirmation > .booking-details',
          'booking-time-zone': '.tz-panel [role="listbox"]:visible',
          'embedded-booking': '.public-embedded .event-title',
          'team-booking': '.event-host',
          'oauth-consent': 'button.button-primary',
        } as const
        for (const { id } of auditPages) {
          await openAuditPage(page, app, id, { locale })
          if (!(id in selectors)) continue
          const selector = selectors[id as keyof typeof selectors]
          await expect(page.locator(selector)).toBeVisible()
          if (id === 'host')
            await expect(page.locator('.host-header > .host-avatar + h1')).toBeVisible()
          if (['booking', 'booking-form', 'embedded-booking'].includes(id))
            await expect(page.locator('.event-title + .host-identity > .host-avatar')).toBeVisible()
          if (
            id === 'host' ||
            ['booking', 'booking-form', 'booking-confirmation', 'embedded-booking'].includes(id)
          ) {
            const avatar = page.locator('.host-avatar')
            await expect(avatar).toHaveAttribute('aria-hidden', 'true')
            const bounds = await avatar.boundingBox()
            const viewport = page.viewportSize()
            if (!bounds || !viewport) throw new Error('Host avatar must have visible bounds')
            expect(bounds.width).toBe(id === 'host' ? 64 : 48)
            expect(bounds.height).toBe(bounds.width)
            expect(bounds.x).toBeGreaterThanOrEqual(0)
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
          }
          if (id === 'booking-confirmation') {
            await expect(page.locator('.confirmation > h1 + .host-identity')).toBeVisible()
            const supportingDetails = page.locator('.confirmation-secondary > .booking-details')
            await expect(supportingDetails).toBeVisible()
            await expect(page.locator(selector).locator('dt')).toHaveText(
              locale === 'zh-CN' ? ['事项', '时间', '地点'] : ['What', 'When', 'Where'],
            )
            await expect(
              supportingDetails.locator('dt').filter({ hasText: /^(Host|主持人)$/ }),
            ).toBeVisible()
          }
          if (id === 'booking-form') {
            const zone = page.locator('.host-time-zone')
            await expect(zone.locator('wbr')).toHaveCount(1)
            // Chinese permits breaks inside Latin names unless each slash segment stays together.
            expect(
              await zone.locator('.time-zone-segment').evaluateAll((segments) => {
                // Also measure the longer name from the reported 1280px Chinese regression.
                const city = segments.at(-1)
                const original = city?.textContent ?? ''
                if (city) city.textContent = 'Los Angeles'
                try {
                  return segments.every((segment) => {
                    const range = document.createRange()
                    range.selectNodeContents(segment)
                    return range.getClientRects().length === 1
                  })
                } finally {
                  if (city) city.textContent = original
                }
              }),
            ).toBe(true)
          }
          if (id === 'team-booking') {
            await expect(page.locator(selector)).toHaveText(AUDIT_TEAM_NAME)
            await expect(page.locator('.event-title + .host-identity > .event-host')).toBeVisible()
            await expect(page.locator('.host-avatar')).toHaveCount(0)
          }
          if (id === 'oauth-consent')
            await expect(page.locator(selector)).toHaveText(/^(Allow access|允许访问)$/)
          const viewport = page.viewportSize()
          if (!viewport) throw new Error('UI audit requires a CSS viewport')
          const findings = await page.evaluate(measureLayout, viewport)
          expect(findings.some((finding) => finding.code === 'scan-error')).toBe(false)
          if (
            [
              'host',
              'booking',
              'booking-form',
              'booking-confirmation',
              'embedded-booking',
              'team-booking',
            ].includes(id)
          )
            expect(
              findings.filter((finding) =>
                ['document-overflow', 'element-overflow'].includes(finding.code),
              ),
            ).toEqual([])
        }
      })
  })
}

for (const viewport of [
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
]) {
  test.describe(`event types readiness caption at ${viewport.width}px`, () => {
    test.use({ viewport })
    for (const locale of ['en-US', 'zh-CN'] as const)
      test(`uses the available table width ${locale}`, async ({ page, app }) => {
        await openAuditPage(page, app, 'event-types', { locale })
        const table = page.locator('.table-event-types')
        await expect(table.locator('caption')).toHaveText(
          locale === 'zh-CN'
            ? '配置检查不保证有可约时段。当前可约时间以预约页为准。'
            : 'Configuration checks do not guarantee available times. Check the booking page for current availability.',
        )
        const widths = await table.evaluate((node) => {
          const caption = node.querySelector('caption')
          if (!caption) throw new Error('Event types readiness caption is missing')
          return {
            table: node.getBoundingClientRect().width,
            caption: caption.getBoundingClientRect().width,
          }
        })
        expect(widths.table).toBeGreaterThan(0)
        expect(widths.caption).toBeGreaterThanOrEqual(widths.table * 0.8)
      })
  })
}

test.describe('notification editor at 320px', () => {
  const viewport = { width: 320, height: 568 }
  test.use({ viewport, isMobile: true, hasTouch: true, notificationEditor: true })
  for (const locale of ['en-US', 'zh-CN'] as const)
    test(`saved reminder, follow-up and host note fit ${locale}`, async ({ page, app }) => {
      await openAuditPage(page, app, 'event-type-editor', { locale })
      const editor = page.locator('.notifications-editor')
      const reminders = editor.locator('fieldset[id="notifications.reminders"]')
      const followUps = editor.locator('fieldset[id="notifications.followUps"]')
      await expect(reminders.locator('.notification-card')).toHaveCount(1)
      await expect(followUps.locator('.notification-card')).toHaveCount(1)
      await expect(followUps.locator('.notification-card > legend')).toHaveText(
        locale === 'zh-CN' ? '会后消息 1' : 'Follow-up 1',
      )
      const note = followUps.getByRole('textbox', {
        name: locale === 'zh-CN' ? '主持人留言（可选）' : 'Host note (optional)',
        exact: true,
      })
      await expect(note).toBeVisible()
      await expect(note).toBeEditable()
      await expect(note).toHaveValue(AUDIT_HOST_NOTE)
      const locationGroup = page.locator('.event-settings-group').filter({
        has: page.locator('summary', {
          hasText: locale === 'zh-CN' ? '地点选项与视频会议' : 'Location options and conferencing',
        }),
      })
      const addLocation = locationGroup.getByRole('button', {
        name: locale === 'zh-CN' ? '添加地点选项' : 'Add location option',
        exact: true,
        includeHidden: true,
      })
      expect(await addLocation.evaluate((element) => element.getBoundingClientRect().height)).toBe(
        0,
      )
      await page.evaluate(settleAuditLayout)
      expect(await page.evaluate(measureLayout, viewport)).toEqual([])
      await locationGroup.locator('summary').click()
      await expect(addLocation).toBeVisible()
      expect(
        await addLocation.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(24)
      await page.evaluate(settleAuditLayout)
      expect(await page.evaluate(measureLayout, viewport)).toEqual([])
    })
})

test.describe('team administrator bookings at 320px', () => {
  const viewport = { width: 320, height: 568 }
  test.use({ viewport, isMobile: true, hasTouch: true })
  for (const locale of ['en-US', 'zh-CN'] as const)
    test(`supports long names, keyboard detail and focus return ${locale}`, async ({
      page,
      app,
    }) => {
      await openAuditPage(page, app, 'team-bookings', { locale })
      const opener = page
        .locator('.team-bookings-list')
        .getByRole('button', { name: AUDIT_TITLE, exact: true })
      await expect(opener).toBeVisible()
      await expect(page.locator('main').getByText(AUDIT_TEAM_NAME, { exact: true })).toBeVisible()
      const inspect = async () => {
        await page.evaluate(settleAuditLayout)
        expect(await page.evaluate(measureLayout, viewport)).toEqual([])
        const scan = await scanA11y(page)
        expect(a11yFindings('team-bookings', scan.violations, []).findings).toEqual([])
      }
      await inspect()
      const filters = page.locator('.team-bookings-filters')
      const filterToggle = filters.locator('summary')
      await filterToggle.focus()
      await page.keyboard.press('Enter')
      await expect(filters).toHaveAttribute('open', '')
      await expect(filters.locator('input[type="datetime-local"]')).toHaveCount(4)
      await inspect()
      await filterToggle.focus()
      await page.keyboard.press('Enter')
      await expect(filters).not.toHaveAttribute('open', '')
      await opener.focus()
      await page.keyboard.press('Enter')
      const panel = page.locator('.booking-detail-panel')
      const detail = page.locator('.team-booking-detail')
      await expect(panel).toBeVisible()
      await expect(panel).toHaveClass(/booking-detail-full-page/)
      // Phones get the detail as an ordinary page: no overlay, and the list is out of view.
      expect(await panel.evaluate((element) => getComputedStyle(element).position)).toBe('static')
      await expect(page.locator('.team-bookings-list table')).toBeHidden()
      await expect(detail).toBeVisible()
      const close = panel.getByRole('button', { name: /^(Close details|关闭详情)$/ })
      await expect(close).toBeFocused()
      await expect(page).toHaveURL(/\/app\/bookings\/[^/?]+$/)
      await expect(detail.locator('li').filter({ hasText: AUDIT_GUEST_NAME })).toBeVisible()
      await inspect()
      const cancel = detail.getByRole('button', { name: /^(Cancel booking…|取消预约…)$/ })
      await cancel.focus()
      await page.keyboard.press('Enter')
      await expect(detail.locator('form')).toBeVisible()
      await expect(detail.getByRole('textbox')).toBeFocused()
      await inspect()
      await detail.getByRole('button', { name: /^(Keep booking|保留预约)$/ }).focus()
      await page.keyboard.press('Enter')
      await expect(detail.locator('form')).toHaveCount(0)
      await expect(cancel).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(detail).toHaveCount(0)
      await expect(opener).toBeFocused()
      await page.keyboard.press('Enter')
      await close.focus()
      await page.keyboard.press('Enter')
      await expect(detail).toHaveCount(0)
      await expect(opener).toBeFocused()
    })
})

for (const viewport of [
  { width: 320, height: 568 },
  { width: 1280, height: 720 },
]) {
  for (const theme of ['light', 'dark'] as const) {
    const phone = viewport.width === 320
    test.describe(`booking polish ${viewport.width}px ${theme}`, () => {
      test.use({ viewport, colorScheme: theme, isMobile: phone, hasTouch: phone })
      for (const locale of ['en-US', 'zh-CN'] as const) {
        test(`keeps the booking states readable and operable ${locale}`, async ({ page, app }) => {
          const sizes = new Set<number>()
          for (const id of [
            'booking',
            'booking-time-zone',
            'booking-form',
            'booking-confirmation',
            'team-booking',
            'embedded-booking',
          ] as const) {
            await test.step(id, async () => {
              await openAuditPage(page, app, id, { locale })
              if (id !== 'booking-confirmation') {
                const facts = page.locator('.event-facts')
                await expect(facts.locator(':scope > li')).toHaveCount(3)
                await expect(
                  facts.locator(
                    ':scope > li > svg:first-child[aria-hidden="true"][focusable="false"]',
                  ),
                ).toHaveCount(3)
                if (id !== 'booking-form')
                  await expect(page.locator('.tz-caption > svg[aria-hidden="true"]')).toHaveCount(1)
                if (id !== 'embedded-booking') {
                  const surface = await page.locator('.booking-layout').evaluate((element) => {
                    const { left, width } = element.getBoundingClientRect()
                    return { left, width, border: getComputedStyle(element).borderTopWidth }
                  })
                  if (phone) {
                    expect(surface).toEqual({ left: 0, width: viewport.width, border: '0px' })
                  } else {
                    expect(surface.left).toBeGreaterThan(0)
                    expect(surface.border).toBe('1px')
                  }
                }
              }
              if (id === 'booking-form') {
                await expect(page.locator('.details-step h2')).toBeFocused()
                const actions = page.locator('.booking-form .booking-form-actions')
                const confirm = actions.getByRole('button', {
                  name: /^(Confirm booking|确认预约)$/,
                })
                await expect(actions).toHaveCSS('position', phone ? 'fixed' : 'static')
                if (phone) {
                  const bounds = await confirm.boundingBox()
                  if (!bounds) throw new Error('The confirmation control must have visible bounds')
                  expect(bounds.height).toBeGreaterThanOrEqual(44)
                  const bottom = await actions.evaluate(
                    (element) => element.getBoundingClientRect().bottom,
                  )
                  expect(bottom).toBeCloseTo(viewport.height, 0)
                }
                expect(await measureKeyboard(page)).toEqual([])
              }
              const stateSizes = await page.locator('.public').evaluate((root) =>
                [...root.querySelectorAll<HTMLElement>('*')].flatMap((element) => {
                  const text = [...element.childNodes].some(
                    (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
                  )
                  if (!text && !element.matches('input:not([type="hidden"]), select, textarea'))
                    return []
                  const rect = element.getBoundingClientRect()
                  const style = getComputedStyle(element)
                  return rect.width > 1 && rect.height > 1 && style.visibility === 'visible'
                    ? [Number.parseFloat(style.fontSize)]
                    : []
                }),
              )
              for (const size of stateSizes) sizes.add(size)
              expect(await page.evaluate(measureLayout, viewport)).toEqual([])
              const scan = await scanA11y(page)
              expect(a11yFindings(id, scan.violations, []).findings).toEqual([])
            })
          }
          expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12.8)
          expect(sizes.size).toBeGreaterThanOrEqual(5)
          expect(sizes.size).toBeLessThanOrEqual(6)
        })
      }
    })
  }
}

for (const viewport of layoutViewports) {
  const mobileViewport = viewport.width <= 480 || (viewport.width <= 960 && viewport.height <= 430)
  for (const theme of ['light', 'dark'] as const) {
    for (const locale of ['en-US', 'zh-CN', 'en-GB'] as const) {
      test.describe(`${viewport.width}x${viewport.height} ${theme} ${locale}`, () => {
        test.use({
          viewport,
          locale,
          colorScheme: theme,
          isMobile: mobileViewport,
          hasTouch: mobileViewport,
        })
        test('measure every page', async ({ page, app }) => {
          await page.emulateMedia({ colorScheme: theme })
          const reports: AuditReport[] = []
          for (const state of auditPages) {
            if (!(auditLocales(state.id) as readonly AuditLocale[]).includes(locale)) continue
            const report: AuditReport = {
              version: 1,
              kind: 'layout',
              page: state.id,
              theme,
              locale,
              viewport,
              findings: [],
            }
            let phase: 'navigate' | 'layout' | 'keyboard' = 'navigate'
            try {
              await openAuditPage(page, app, state.id, { locale })
              phase = 'layout'
              report.findings.push(...(await page.evaluate(measureLayout, viewport)))
              phase = 'keyboard'
              report.findings.push(...(await measureKeyboard(page)))
            } catch {
              report.findings.push({ code: 'scan-error', phase })
            }
            await writeAuditReport(report)
            reports.push(report)
          }
          assertAuditFindings(reports)
        })
      })
    }
  }
}
