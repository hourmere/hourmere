import type { Page } from '@playwright/test'
import { revealEventSetting } from '../event-settings.ts'
import { selectPublicLanguage } from '../public-language.ts'
import {
  expect,
  REMINDER_INVITEE,
  REMINDER_NOTE,
  REMINDER_NOW,
  type ScheduledMessageState,
  test,
} from '../reminder-fixtures.ts'

async function chooseDay(page: Page, date: string) {
  await expect(page.locator('.calendar-grid[aria-busy="true"]')).toHaveCount(0)
  await page.locator(`button.day-available[data-day="${date}"]`).click()
  await page.locator('.slots button').first().click()
}

function expectedSchedule(start: string, end: string): ScheduledMessageState[] {
  return [
    { kind: 'reminder', at: Temporal.Instant.from(start).subtract({ minutes: 135 }) },
    { kind: 'follow_up', at: Temporal.Instant.from(end).add({ minutes: 90 }) },
  ].map(({ kind, at }) => ({
    kind,
    due: new Date(at.epochMilliseconds).toISOString(),
    queuedFor: new Date(at.epochMilliseconds).toISOString(),
    state: 'pending',
    attempts: 0,
  }))
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`${locale}: editor reminders and host-note follow-ups reach the mail sink only at rescheduled times`, async ({
    page,
    reminderApp: app,
  }) => {
    const zh = locale === 'zh-CN'
    await page.clock.setFixedTime(new Date(REMINDER_NOW))
    await app.signIn(locale)
    await page.goto(app.url + app.editorPath)
    await page
      .getByRole('combobox', { name: /^(Interface language|界面语言)$/ })
      .selectOption(locale)
    const editor = page.locator('.notifications-editor')
    await revealEventSetting(editor)
    const reminder = editor.locator('fieldset[id="notifications.reminders"] .notification-card')
    await reminder.getByLabel(zh ? '预设时间' : 'Timing preset', { exact: true }).selectOption('')
    await reminder
      .getByLabel(zh ? '会议开始前的分钟数' : 'Minutes before the meeting', { exact: true })
      .fill('135')
    await reminder.getByRole('checkbox', { name: zh ? '来宾' : 'Guests', exact: true }).uncheck()
    await editor
      .getByRole('button', { name: zh ? '添加会后消息' : 'Add follow-up', exact: true })
      .click()
    const followUp = editor.locator('fieldset[id="notifications.followUps"] .notification-card')
    await followUp.getByLabel(zh ? '预设时间' : 'Timing preset', { exact: true }).selectOption('')
    await followUp
      .getByLabel(zh ? '会议结束后的分钟数' : 'Minutes after the meeting', { exact: true })
      .fill('90')
    await followUp.getByRole('checkbox', { name: zh ? '来宾' : 'Guests', exact: true }).uncheck()
    await followUp
      .getByLabel(zh ? '主持人留言（可选）' : 'Host note (optional)', { exact: true })
      .fill(REMINDER_NOTE)
    const saving = page.waitForResponse(
      (r) =>
        r.request().method() === 'PATCH' && new URL(r.url()).pathname.includes('/event-types/'),
    )
    await page.getByRole('button', { name: zh ? '保存更改' : 'Save changes', exact: true }).click()
    expect((await saving).status()).toBe(200)
    await page.reload()
    await expect(
      page.getByLabel(zh ? '主持人留言（可选）' : 'Host note (optional)', { exact: true }),
    ).toHaveValue(REMINDER_NOTE)
    await expect(
      page.getByLabel(zh ? '会议开始前的分钟数' : 'Minutes before the meeting', { exact: true }),
    ).toHaveValue('135')

    await app.signOut()
    await page.goto(app.url + app.bookingPath)
    await selectPublicLanguage(page, locale)
    await chooseDay(page, '2030-05-09')
    await page.getByLabel(zh ? '你的姓名' : 'Your name', { exact: true }).fill('Reminder Invitee')
    await page.getByLabel(zh ? '邮箱' : 'Email', { exact: true }).fill(REMINDER_INVITEE)
    const creating = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/bookings'),
    )
    await page
      .getByRole('button', { name: zh ? '确认预约' : 'Confirm booking', exact: true })
      .click()
    const created = await creating
    expect(created.status()).toBe(201)
    const original = (await created.json()) as {
      booking: { id: string; start: string; end: string }
      manageToken: string
    }
    const originalSchedule = expectedSchedule(original.booking.start, original.booking.end)
    expect(await app.scheduled(original.booking.id)).toEqual(originalSchedule)
    expect(app.messages().length).toBe(0)

    // Move through the same private invitee link used in confirmation mail, before
    // either send time. Neither predecessor message may be delivered afterwards.
    await page.goto(`${app.url}/booking`)
    await page.evaluate((token) => {
      window.location.hash = new URLSearchParams({ token }).toString()
    }, original.manageToken)
    await page.getByRole('button', { name: zh ? '改期' : 'Reschedule', exact: true }).click()
    await chooseDay(page, '2030-05-10')
    const moving = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/reschedule'),
    )
    await page
      .getByRole('button', { name: zh ? '确认新时间' : 'Confirm new time', exact: true })
      .click()
    const movedResponse = await moving
    expect(movedResponse.status()).toBe(200)
    const moved = (await movedResponse.json()) as {
      booking: { id: string; start: string; end: string }
    }
    expect(moved.booking.id === original.booking.id).toBe(false)
    const schedule = expectedSchedule(moved.booking.start, moved.booking.end)
    expect(await app.scheduled(moved.booking.id)).toEqual(schedule)
    const reminderAt = schedule[0]?.due
    const followUpAt = schedule[1]?.due
    const oldFollowUpAt = originalSchedule[1]?.due
    if (!reminderAt || !followUpAt || !oldFollowUpAt) throw new Error('Expected both message times')
    await app.advance(oldFollowUpAt)
    expect(app.messages().length, 'Rescheduling suppresses both predecessor messages').toBe(0)
    expect((await app.scheduled(original.booking.id)).every((m) => m.state === 'skipped')).toBe(
      true,
    )

    await app.advance(Temporal.Instant.from(reminderAt).subtract({ milliseconds: 1 }).toString())
    expect(app.messages().length, 'A reminder never arrives before its exact due time').toBe(0)
    expect(await app.scheduled(moved.booking.id)).toEqual(schedule)
    await app.advance(reminderAt)
    const reminders = app.messages()
    expect(reminders.length).toBe(2)
    expect(reminders.map(({ message }) => message.to).sort()).toEqual([
      'reminder-host@hourmere.invalid',
      REMINDER_INVITEE,
    ])
    for (const { at, message } of reminders) {
      expect(Temporal.Instant.from(at).equals(Temporal.Instant.from(reminderAt))).toBe(true)
      expect(message.subject.startsWith(zh ? '提醒：' : 'Reminder:')).toBe(true)
      expect(message.text.includes(zh ? '会议即将开始' : 'is coming up.')).toBe(true)
      expect(
        message.text.includes(REMINDER_NOTE),
        'Host notes belong only in follow-up bodies',
      ).toBe(false)
    }
    await app.advance(Temporal.Instant.from(followUpAt).subtract({ milliseconds: 1 }).toString())
    expect(
      app.messages().length,
      'A follow-up never arrives before scheduled end plus offset',
    ).toBe(2)
    await app.advance(followUpAt)
    const followUps = app.messages().slice(2)
    expect(followUps.length).toBe(2)
    expect(followUps.map(({ message }) => message.to).sort()).toEqual([
      'reminder-host@hourmere.invalid',
      REMINDER_INVITEE,
    ])
    for (const { at, message } of followUps) {
      expect(Temporal.Instant.from(at).equals(Temporal.Instant.from(followUpAt))).toBe(true)
      expect(message.subject).toBe(
        zh
          ? '预约时段已结束：Reminder acceptance call'
          : 'Scheduled meeting time has ended: Reminder acceptance call',
      )
      expect(message.text.includes(zh ? '主持人留言' : 'Note from the host')).toBe(true)
      expect(message.text.includes(REMINDER_NOTE)).toBe(true)
      expect(message.html?.includes('&lt;b&gt;Plain text&lt;/b&gt;')).toBe(true)
      expect(message.text.includes('#token=')).toBe(false)
      expect(message.attachments).toBeUndefined()
    }
    await app.advance(Temporal.Instant.from(followUpAt).add({ minutes: 1 }).toString())
    expect(app.messages().length, 'Repeated worker wakes do not duplicate deliveries').toBe(4)
    expect(
      (await app.scheduled(moved.booking.id)).map(({ state, attempts }) => ({ state, attempts })),
    ).toEqual([
      { state: 'completed', attempts: 1 },
      { state: 'completed', attempts: 1 },
    ])
  })
}
