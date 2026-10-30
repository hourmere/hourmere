import type { Page } from '@playwright/test'
import { prepareAuditLocale, settleAuditLayout } from '../audit-pages.ts'
import { expect, test } from '../fixtures.ts'
import { measureLayout } from '../layout.ts'

const viewport = { width: 320, height: 568 }

async function fits(page: Page) {
  await page.evaluate(settleAuditLayout)
  const findings = await page.evaluate(measureLayout, viewport)
  expect(
    findings.filter((finding) =>
      ['document-overflow', 'element-overflow', 'scan-error'].includes(finding.code),
    ),
    'Invitation form and pending rows fit the 320px viewport',
  ).toEqual([])
}

for (const locale of ['en-US', 'zh-CN'] as const) {
  const chinese = locale === 'zh-CN'
  test(`member invitation queues through the keyboard at 320px ${locale}`, async ({
    page,
    app,
  }) => {
    await app.auditSignIn(true, locale, 'team')
    await page.addInitScript(prepareAuditLocale, locale)
    await page.setViewportSize(viewport)
    await page.goto(`${app.url}/app/settings`)
    const form = page.getByRole('region', {
      name: chinese ? '邀请成员' : 'Invite member',
      exact: true,
    })
    const email = form.getByRole('textbox', { name: chinese ? '邮箱' : 'Email', exact: true })
    await expect(email).toBeVisible()
    await fits(page)
    await email.fill('invalid-address')
    await email.press('Enter')
    await expect(form.getByRole('alert')).toContainText(chinese ? '有效的邮箱' : 'valid email')
    await expect(email).toHaveValue('invalid-address')
    await fits(page)

    let prompted = false
    page.once('dialog', async (dialog) => {
      prompted = dialog.type() === 'confirm' && /未保存|unsaved/.test(dialog.message())
      await dialog.dismiss()
    })
    await page.getByRole('link', { name: chinese ? '预约' : 'Bookings', exact: true }).click()
    expect(prompted).toBe(true)
    await expect(email).toHaveValue('invalid-address')

    await email.fill('invited-member@hourmere.invalid')
    await email.focus()
    await page.keyboard.press('Tab')
    await expect(
      form.getByRole('button', { name: chinese ? '邀请成员' : 'Invite member', exact: true }),
    ).toBeFocused()
    const queued = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/auth/organization/invite-member',
    )
    await page.keyboard.press('Enter')
    const response = await queued
    expect(response.status()).toBe(200)
    const invitation = (await response.json()) as {
      id: string
      role: string
      delivery: { state: string }
    }
    expect(invitation.role).toBe('member')
    expect(invitation.delivery.state).toBe('queued')
    await expect(form.getByRole('status')).toHaveText(
      chinese ? '邀请已加入投递队列。' : 'Invitation queued for delivery.',
    )
    await expect(email).toHaveValue('')
    const pending = page.getByRole('region', {
      name: chinese ? '待接受的邀请' : 'Pending invitations',
      exact: true,
    })
    await expect(
      pending.getByText(chinese ? '等待发送' : 'Waiting to send', { exact: true }),
    ).toBeVisible()
    await expect(pending.getByRole('heading', { level: 3 })).toHaveText(
      chinese
        ? '发给 invited-member@hourmere.invalid 的邀请'
        : 'Invitation to invited-member@hourmere.invalid',
    )
    await fits(page)
  })
}
