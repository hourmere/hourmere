import type { FrameLocator, Page } from '@playwright/test'
import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'

test.use({ automaticMeet: true, multiHostMeet: true })
async function confirm(page: Page, scope: Page | FrameLocator, label: string) {
  const pending = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/bookings'),
  )
  await scope.getByRole('button', { name: label, exact: true }).click()
  const result = (await (await pending).json()) as {
    booking: { conference?: { status: string; errorCode: string | null } }
  }
  expect(result.booking.conference).toMatchObject({ status: 'pending', errorCode: null })
}
for (const language of ['en', 'zh-CN'] as const) {
  const zh = language === 'zh-CN'
  test(`collective Meet requires an explicit organizer and keeps the bilingual draft (${language})`, async ({
    page,
    app,
  }) => {
    await app.authorizeHost('owner')
    await page.goto(`${app.url}/app/event-types/new`)
    await page.getByLabel('Title', { exact: true }).fill('Multi browser Meet')
    await page.getByLabel('Scheduling', { exact: true }).selectOption('collective')
    await page.getByLabel('Second Required Host', { exact: true }).check()
    await page.getByLabel('Third Unconnected Host', { exact: true }).check()
    await page.getByLabel('Where the meeting happens', { exact: true }).selectOption('google_meet')
    await page
      .getByRole('checkbox', {
        name: 'Create a unique Google Meet link for each booking',
        exact: true,
      })
      .check()
    await page.getByRole('button', { name: 'Create event type', exact: true }).click()
    await expect(
      page
        .getByText('Choose the meeting organizer from the required hosts.', { exact: true })
        .first(),
    ).toBeVisible()
    await page
      .getByLabel('Meeting organizer', { exact: true })
      .selectOption({ label: 'Second Required Host' })
    if (zh)
      await page
        .getByRole('combobox', { name: 'Interface language', exact: true })
        .selectOption('zh-CN')
    await expect(page.getByLabel(zh ? '标题' : 'Title', { exact: true })).toHaveValue(
      'Multi browser Meet',
    )
    await page
      .getByRole('button', { name: zh ? '创建活动类型' : 'Create event type', exact: true })
      .click()
    await expect(
      page.getByRole('heading', { name: zh ? '活动类型' : 'Event types', exact: true }),
    ).toBeVisible()
    await page.goto(`${app.url}/team/FixtureTeam/multi-browser-meet`)
    await pickSlot(page, page)
    await fillInvitee(page)
    await confirm(page, page, zh ? '确认预约' : 'Confirm booking')
    await expect(
      page.getByRole('heading', {
        name: zh ? '时段已保留，会议链接待生成' : 'Time reserved; meeting link pending',
        exact: true,
      }),
    ).toBeVisible()
    await app.advanceMeet('success')
    await expect(
      page.getByRole('link', { name: zh ? '加入 Google Meet' : 'Join Google Meet', exact: true }),
    ).toBeVisible()
    const state = await app.multiMeetState()
    expect(state).toMatchObject({
      organizerName: 'Second Required Host',
      mirrors: ['not_configured', 'ready'],
      ordinarySafe: true,
      requests: 4,
      pinnedInvitation: true,
      copies: 2,
    })
  })
  test(`collective shared link and private copy status preserve public/embed privacy (${language})`, async ({
    page,
    app,
  }) => {
    await page.addInitScript((l) => localStorage.setItem('hourmere-language', l), language)
    let privateReads = 0
    page.on('request', (request) => {
      const p = new URL(request.url()).pathname
      if (['/api/v1/me', '/api/v1/profile'].includes(p) || p.startsWith('/api/auth/'))
        privateReads++
    })
    await page.goto(`${app.parentUrl}/collective?language=${language}`)
    await page.getByRole('button', { name: 'Book a meeting', exact: true }).click()
    const frame = page.getByRole('dialog').locator('iframe').contentFrame()
    for (let n = 0; n < 4; n++) {
      await expect(frame.locator('.calendar-grid[aria-busy="true"]')).toHaveCount(0)
      const days = frame.locator('button.day-available')
      if (await days.count()) {
        await days.last().click()
        await frame.locator('.slots button').first().click()
        break
      }
      await frame.getByRole('button', { name: zh ? '下个月' : 'Next month', exact: true }).click()
    }
    await frame
      .getByLabel(zh ? '你的姓名' : 'Your name', { exact: true })
      .fill('Synthetic browser invitee')
    await frame
      .getByLabel(zh ? '邮箱' : 'Email', { exact: true })
      .fill('fixture-invitee@hourmere.invalid')
    await confirm(page, frame, zh ? '确认预约' : 'Confirm booking')
    await app.advanceMeet('success')
    await expect(
      frame.getByRole('link', { name: zh ? '加入 Google Meet' : 'Join Google Meet', exact: true }),
    ).toBeVisible()
    expect(privateReads).toBe(0)
    const messages = await page.evaluate(
      () => (window as unknown as { fixtureMessages: unknown[] }).fixtureMessages,
    )
    expect(
      messages.every(
        (m) =>
          !JSON.stringify(m).match(
            /token|meet\.google|calendarCopy|organizer_user|invitation_organizer/i,
          ),
      ),
    ).toBe(true)
    await app.authorizeHost('owner')
    await page.goto(app.url + (await app.meetState()).hostBookingPath)
    await expect(
      page.getByRole('heading', { name: zh ? '我的日历副本' : 'My calendar copy', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByText(zh ? '您的原日历副本已更新。' : 'Your original calendar copy is up to date.', {
        exact: true,
      }),
    ).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true)
  })
}
test('round-robin Meet uses the actual winner and never creates pool mirrors', async ({
  page,
  app,
}) => {
  await page.goto(app.url + app.roundRobinPath)
  await pickSlot(page, page)
  await fillInvitee(page)
  await confirm(page, page, 'Confirm booking')
  await expect(
    page.getByRole('heading', { name: 'Time reserved; meeting link pending', exact: true }),
  ).toBeVisible()
  await app.advanceMeet('success')
  await expect(page.getByRole('link', { name: 'Join Google Meet', exact: true })).toBeVisible()
  const assigned = await app.roundRobinState(),
    state = await app.multiMeetState()
  expect(state.organizerName).toBe(assigned.assignedNames[0])
  expect(state.mirrors).toEqual([])
  expect(state.copies).toBe(1)
})
test('a host safely reconciles a failed ordinary copy without replacing its ready Meet', async ({
  page,
  app,
}) => {
  await page.goto(app.url + app.collectivePath)
  await pickSlot(page, page)
  await fillInvitee(page)
  await confirm(page, page, 'Confirm booking')
  await expect(
    page.getByRole('heading', { name: 'Time reserved; meeting link pending', exact: true }),
  ).toBeVisible()
  app.loseMirrorResponse()
  await app.advanceMeet('success')
  expect((await app.multiMeetState()).mirrors).toEqual(['failed', 'not_configured'])
  await app.authorizeHost('owner')
  await page.goto(app.url + (await app.meetState()).hostBookingPath)
  await expect(page.getByRole('link', { name: 'Join Google Meet', exact: true })).toBeVisible()
  const retried = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/calendar-copy/retry'),
  )
  await page.getByRole('button', { name: 'Recheck my calendar copy', exact: true }).click()
  expect((await retried).status()).toBe(204)
  await app.advanceMeet('success')
  await expect(
    page.getByText('Your original calendar copy is up to date.', { exact: true }),
  ).toBeVisible()
  expect((await app.meetState()).imports).toBe(2)
})
