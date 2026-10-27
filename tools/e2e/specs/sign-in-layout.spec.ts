import type { Page } from '@playwright/test'
import { scanA11y } from '../a11y.ts'
import { prepareAuditLocale, settleAuditLayout } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import { measureLayout } from '../layout.ts'

const viewport = { width: 320, height: 568 }
const address = `synthetic-${'a'.repeat(54)}@${'b'.repeat(63)}.invalid`

async function expectFitsAndAccessible(page: Page, state: string) {
  await page.evaluate(settleAuditLayout)
  const findings = await page.evaluate(measureLayout, viewport)
  expect(
    findings.filter((finding) =>
      ['document-overflow', 'element-overflow', 'scan-error'].includes(finding.code),
    ),
    `${state} fits the 320px viewport`,
  ).toEqual([])
  // Scanner errors reject the test too; an empty/failed scan is not a passing audit.
  const scan = await scanA11y(page)
  expect(scan.passes, `${state} completed an axe scan`).toBeGreaterThan(0)
  expect(
    scan.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? '')),
    `${state} has no serious or critical WCAG violations`,
  ).toEqual([])
}

for (const theme of ['light', 'dark'] as const) {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    test.describe(`${theme} ${locale}`, () => {
      test.use({ colorScheme: theme, locale })
      test('sign-in link actions and feedback fit 320px with axe', async ({ page, app }) => {
        test.setTimeout(90_000)
        const chinese = locale === 'zh-CN'
        const names = {
          email: chinese ? '邮箱' : 'Email',
          send: chinese ? '通过邮件发送登录链接' : 'Email me a sign-in link',
          sent: chinese ? '查看邮件' : 'Check your email',
          resend: chinese ? '重新发送链接' : 'Resend link',
          change: chinese ? '更换邮箱' : 'Change email',
          pending: chinese ? '正在重新发送…' : 'Resending…',
          success: chinese
            ? '我们已收到新的登录链接请求。如果此邮箱可以登录，请检查收件箱。'
            : 'We received your new sign-in link request. Check your inbox if this address can sign in.',
          limited: chinese
            ? '请求过多，请稍后重试。'
            : 'Too many requests. Please wait and try again later.',
          failed: chinese
            ? '无法重新发送链接，请重试。'
            : 'Could not resend the link. Please try again.',
        }
        await page.setViewportSize(viewport)
        await page.emulateMedia({ colorScheme: theme })
        await page.addInitScript(prepareAuditLocale, locale)
        const next = '/app/settings?tab=profile'
        await page.goto(`${app.url}/sign-in?${new URLSearchParams({ next })}`)
        await page.getByRole('textbox', { name: names.email, exact: true }).fill(address)
        // The first request exercises the real endpoint in the web-only disposable app.
        // Only subsequent responses are controlled; no mail worker or provider runs.
        await page.getByRole('button', { name: names.send, exact: true }).click()
        const sent = page.getByRole('heading', { name: names.sent, exact: true })
        const resend = page.getByRole('button', { name: names.resend, exact: true })
        const change = page.getByRole('button', { name: names.change, exact: true })
        await expect(sent).toBeVisible()
        await expect(sent).toBeFocused()
        await expect(resend).toBeEnabled()
        await expect(change).toBeEnabled()
        await expectFitsAndAccessible(page, 'Sent screen')

        let outcome: 'pending' | 'success' | 'limited' | 'unavailable' | 'failed' = 'pending'
        let finishPending: (() => void) | undefined
        const completePending = () => {
          if (!finishPending) throw new Error('Resend request has not started')
          finishPending()
          finishPending = undefined
        }
        await page.route(`${app.url}/api/auth/sign-in/magic-link`, async (route) => {
          if (outcome === 'pending')
            await new Promise<void>((resolve) => {
              finishPending = resolve
            })
          if (outcome === 'failed') await route.abort('failed')
          else
            await route.fulfill({
              status: outcome === 'limited' ? 429 : outcome === 'unavailable' ? 503 : 200,
              contentType: 'application/json',
              body: JSON.stringify(
                outcome === 'limited' ? { code: 'RATE_LIMITED' } : { status: true },
              ),
            })
        })
        await resend.click()
        await expect(resend).toBeDisabled()
        await expect(page.getByRole('status')).toHaveText(names.pending)
        await expectFitsAndAccessible(page, 'Resend progress')
        await expect.poll(() => typeof finishPending).toBe('function')
        outcome = 'success'
        completePending()
        await expect(page.getByRole('status')).toHaveText(names.success)
        await expect(resend).toBeEnabled()
        await expect(resend).toBeFocused()
        await expectFitsAndAccessible(page, 'Resend success')

        outcome = 'pending'
        await resend.click()
        await expect(page.getByRole('status')).toHaveText(names.pending)
        const language = page.getByRole('combobox', {
          name: chinese ? '界面语言' : 'Interface language',
          exact: true,
        })
        await language.focus()
        await expect.poll(() => typeof finishPending).toBe('function')
        outcome = 'success'
        completePending()
        await expect(page.getByRole('status')).toHaveText(names.success)
        await expect(language).toBeFocused()

        outcome = 'limited'
        await resend.click()
        await expect(page.getByRole('alert')).toHaveText(names.limited)
        await expect(resend).toBeEnabled()
        await expectFitsAndAccessible(page, 'Resend rate limit')

        outcome = 'failed'
        await resend.click()
        await expect(page.getByRole('alert')).toHaveText(names.failed)
        await expect(resend).toBeEnabled()
        await expectFitsAndAccessible(page, 'Resend network failure')

        outcome = 'success'
        await resend.click()
        await expect(page.getByRole('status')).toHaveText(names.success)
        await expect(resend).toBeFocused()
        await expectFitsAndAccessible(page, 'Successful retry')

        await change.click()
        const email = page.getByRole('textbox', { name: names.email, exact: true })
        await expect(email).toHaveValue(address)
        await expect(email).toBeFocused()
        expect(new URL(page.url()).searchParams.get('next')).toBe(next)
        await expectFitsAndAccessible(page, 'Change-email form')

        const send = page.locator('form button[type="submit"]')
        for (const failure of ['limited', 'unavailable', 'failed'] as const) {
          // Start fresh so each failure exercises the first request on a new form.
          await page.reload()
          await email.fill(address)
          outcome = 'pending'
          await send.focus()
          await page.keyboard.press('Enter')
          await expect(send).toBeDisabled()
          await expect.poll(() => typeof finishPending).toBe('function')
          outcome = failure
          completePending()
          await expect(page.getByRole('alert')).toBeVisible()
          if (failure === 'limited') await expect(page.getByRole('alert')).toHaveText(names.limited)
          await expect(send).toBeEnabled()
          await expect(send).toBeFocused()
          await expectFitsAndAccessible(page, `First-send ${failure}`)
        }

        // A pending first send must not pull focus back from a control the person chose.
        await page.reload()
        await email.fill(address)
        outcome = 'pending'
        await send.focus()
        await page.keyboard.press('Enter')
        await expect(send).toBeDisabled()
        await language.focus()
        await expect.poll(() => typeof finishPending).toBe('function')
        outcome = 'failed'
        completePending()
        await expect(page.getByRole('alert')).toBeVisible()
        await expect(send).toBeEnabled()
        await expect(language).toBeFocused()
      })
    })
  }
}
