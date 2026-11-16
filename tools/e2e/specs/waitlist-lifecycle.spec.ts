import type { Page } from '@playwright/test'
import { revealEventSetting } from '../event-settings.ts'
import { expect, type FixtureApp, test } from '../fixtures.ts'

test.use({ waitlistSmtp: true })

for (const locale of ['en', 'zh-CN'] as const) {
  test.describe(`waitlist lifecycle in ${locale}`, () => {
    test.use({ locale })
    const zh = locale === 'zh-CN'
    const join = zh ? '加入候补名单' : 'Join the waitlist'
    const confirm = zh ? '确认邮箱' : 'Confirm email'
    const save = zh ? '保存更改' : 'Save changes'

    async function hostEditor(page: Page, app: FixtureApp) {
      await page.goto(`${app.url}/app/event-types`)
      await page
        .getByRole('combobox', { name: /^(Interface language|界面语言)$/ })
        .selectOption(locale)
      await page
        .getByRole('link', { name: zh ? '编辑 Fixture call' : 'Edit Fixture call', exact: true })
        .click()
    }

    async function joinFullDay(page: Page, app: FixtureApp, day: string, email: string) {
      await page.goto(app.url + app.personalPath)
      await expect(page.locator('.calendar-grid')).toHaveAttribute('aria-busy', 'false')
      for (let attempt = 0; attempt < 2; attempt++) {
        if (await page.locator(`[data-day="${day}"]`).count()) break
        await page
          .getByRole('button', { name: zh ? '上个月' : 'Previous month', exact: true })
          .click()
        await expect(page.locator('.calendar-grid')).toHaveAttribute('aria-busy', 'false')
      }
      await page.locator(`[data-day="${day}"]`).click()
      await page.getByRole('button', { name: join, exact: true }).click()
      await page.getByLabel(zh ? '邮箱' : 'Email', { exact: true }).fill(email)
      await page.getByLabel(zh ? /^你的姓名/ : /^Your name/).fill('Waitlist Lifecycle Invitee')
      await page.getByRole('checkbox').check()
      await page.getByRole('button', { name: join, exact: true }).click()
      await expect(
        page.getByRole('heading', {
          name: zh ? '请查收邮件并确认' : 'Check your email to confirm',
          exact: true,
        }),
      ).toBeVisible()
    }

    async function saveSettings(page: Page) {
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          new URL(response.url()).pathname.startsWith('/api/v1/event-types/'),
      )
      await page.getByRole('button', { name: save, exact: true }).click()
      expect((await saved).status()).toBe(200)
    }

    async function enable(page: Page, app: FixtureApp) {
      const day = await app.configureWaitlist('personal', false)
      await app.auditSignIn(true, locale)
      await hostEditor(page, app)
      await revealEventSetting(page.locator('#waitlist'))
      await page.locator('#waitlist').check()
      await saveSettings(page)
      await expect(page.locator('#waitlist')).toBeChecked()
      return day
    }

    test('host enables, invitee confirms, cancellation notifies and invitee books', async ({
      page,
      app,
    }) => {
      const day = await enable(page, app)
      await joinFullDay(page, app, day, 'waitlist-booking@hourmere.invalid')
      await app.openWaitlistVerification(page)
      await page.getByRole('button', { name: confirm, exact: true }).click()
      await expect(page.getByRole('status')).toContainText(
        zh ? '邮箱已确认' : 'Your email is confirmed',
      )
      const { bookingId } = await app.waitlistIds()
      const cancelled = await page.request.post(`${app.url}/api/v1/bookings/${bookingId}/cancel`, {
        headers: { Origin: app.url },
        data: {},
      })
      expect(cancelled.status()).toBe(200)
      await app.deliverWaitlistNotifications()
      expect(await app.waitlistState()).toEqual({
        states: ['notified'],
        acceptedEmails: 1,
        messages: 2,
      })
      await app.openWaitlistMailLink(page, 'booking')
      await page
        .getByLabel(zh ? '你的姓名' : 'Your name', { exact: true })
        .fill('Waitlist Lifecycle Invitee')
      await page
        .getByLabel(zh ? '邮箱' : 'Email', { exact: true })
        .fill('waitlist-booking@hourmere.invalid')
      await page
        .getByRole('button', { name: zh ? '确认预约' : 'Confirm booking', exact: true })
        .click()
      await expect(
        page.getByRole('heading', { name: zh ? '预约成功' : 'You’re booked', exact: true }),
      ).toBeVisible()
      expect(await app.rows()).toEqual(
        expect.arrayContaining([
          { source: 'api', status: 'cancelled' },
          { source: 'web', status: 'confirmed' },
        ]),
      )
      expect(await app.waitlistContacts()).toEqual([{ status: 'booked', cleared: false }])
    })

    test('disabling a confirmed entry after cancellation prevents notification', async ({
      page,
      app,
    }) => {
      const day = await enable(page, app)
      await joinFullDay(page, app, day, 'waitlist-confirmed-disable@hourmere.invalid')
      await app.openWaitlistVerification(page)
      await page.getByRole('button', { name: confirm, exact: true }).click()
      await expect(page.getByRole('status')).toContainText(
        zh ? '邮箱已确认' : 'Your email is confirmed',
      )
      expect(await app.waitlistContacts()).toEqual([{ status: 'active', cleared: false }])
      const { bookingId } = await app.waitlistIds()
      const cancelled = await page.request.post(`${app.url}/api/v1/bookings/${bookingId}/cancel`, {
        headers: { Origin: app.url },
        data: {},
      })
      expect(cancelled.status()).toBe(200)
      const before = (await app.waitlistState()).messages
      await hostEditor(page, app)
      await page.locator('#waitlist').uncheck()
      await saveSettings(page)
      await expect(page.locator('#waitlist')).not.toBeChecked()
      expect(await app.waitlistContacts()).toEqual([{ status: 'removed', cleared: true }])
      await app.deliverWaitlistNotifications()
      expect(await app.waitlistContacts()).toEqual([{ status: 'removed', cleared: true }])
      expect((await app.waitlistState()).messages).toBe(before)
    })

    test('leave clears details and disabling clears remaining entries without email', async ({
      page,
      app,
    }) => {
      const day = await enable(page, app)
      await joinFullDay(page, app, day, 'waitlist-leave@hourmere.invalid')
      await app.openWaitlistVerification(page)
      await page.getByRole('button', { name: confirm, exact: true }).click()
      await expect(page.getByRole('status')).toContainText(
        zh ? '邮箱已确认' : 'Your email is confirmed',
      )
      await app.openWaitlistMailLink(page, 'remove')
      await page
        .getByRole('button', { name: zh ? '退出候补名单' : 'Leave the waitlist', exact: true })
        .click()
      await expect(page.getByRole('status')).toContainText(
        zh ? '你已退出候补名单' : 'You have left the waitlist',
      )
      expect(await app.waitlistContacts()).toEqual([{ status: 'removed', cleared: true }])
      await joinFullDay(page, app, day, 'waitlist-disable@hourmere.invalid')
      expect((await app.waitlistContacts()).some((entry) => !entry.cleared)).toBe(true)
      const before = (await app.waitlistState()).messages
      await hostEditor(page, app)
      await page.locator('#waitlist').uncheck()
      await saveSettings(page)
      await expect(page.locator('#waitlist')).not.toBeChecked()
      await expect
        .poll(async () => (await app.waitlistContacts()).every((entry) => entry.cleared))
        .toBe(true)
      await app.deliverWaitlistNotifications()
      expect((await app.waitlistContacts()).every((entry) => entry.status === 'removed')).toBe(true)
      expect((await app.waitlistState()).messages).toBe(before)
    })
  })
}
