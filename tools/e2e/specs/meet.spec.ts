import { icsHasLocation } from '../../../packages/mail/src/booking-link-testing.ts'
import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'

test.use({ automaticMeet: true })
const join = 'https://meet.google.com/abc-defg-hij'
test('a host explicitly enables automatic Meet and language switching preserves the draft', async ({
  page,
  app,
}) => {
  await app.authorizeHost()
  await page.goto(`${app.url}/app/event-types/new`)
  await page.getByLabel('Title', { exact: true }).fill('Automatic browser Meet')
  await page.getByLabel('Where the meeting happens', { exact: true }).selectOption('google_meet')
  const optIn = page.getByRole('checkbox', {
    name: 'Create a unique Google Meet link for each booking',
    exact: true,
  })
  await expect(optIn).not.toBeChecked()
  await optIn.check()
  await page
    .getByRole('combobox', { name: 'Interface language', exact: true })
    .selectOption('zh-CN')
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue('Automatic browser Meet')
  await expect(
    page.getByRole('checkbox', { name: '为每次预约创建独立的 Google Meet 链接', exact: true }),
  ).toBeChecked()
  await page.getByRole('button', { name: '创建活动类型', exact: true }).click()
  await expect(page.getByRole('heading', { name: '活动类型', exact: true })).toBeVisible()
  await page.goto(`${app.url}/fixture-host/automatic-browser-meet`)
  await pickSlot(page, page)
  await fillInvitee(page)
  await page.getByRole('button', { name: '确认预约', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '时段已保留，会议链接待生成', exact: true }),
  ).toBeVisible()
  expect((await app.meetState()).rows).toBe(1)
  expect((await app.meetState()).imports).toBe(0)
})
for (const selected of ['en', 'zh-CN'] as const) {
  const chinese = selected === 'zh-CN'
  const text = {
    confirm: chinese ? '确认预约' : 'Confirm booking',
    pending: chinese ? '时段已保留，会议链接待生成' : 'Time reserved; meeting link pending',
    join: chinese ? '加入 Google Meet' : 'Join Google Meet',
    ics: chinese ? '下载 .ics 文件' : 'Download .ics file',
    move: chinese ? '改期' : 'Reschedule',
    confirmMove: chinese ? '确认新时间' : 'Confirm new time',
    moved: chinese ? '你的预约已改至新时间。' : 'Your booking is moved to the new time.',
    cancel: chinese ? '取消预约' : 'Cancel booking',
    cancelled: chinese ? '已取消的预约' : 'Cancelled booking',
  }
  test(`${selected} Meet waits for readiness, keeps one root across reschedule, then cancels`, async ({
    page,
    app,
  }) => {
    await page.addInitScript(
      (language) => localStorage.setItem('hourmere-language', language),
      selected,
    )
    let privateReads = 0,
      unsafeRequest = false
    const secrets: string[] = []
    page.on('request', (request) => {
      const target = new URL(request.url())
      if (
        ['/api/v1/me', '/api/v1/profile'].includes(target.pathname) ||
        target.pathname.startsWith('/api/auth/')
      )
        privateReads++
      unsafeRequest ||= secrets.some(
        (value) =>
          request.url().includes(value) || (request.headers().referer ?? '').includes(value),
      )
    })
    await page.goto(app.url + app.meetPath)
    await pickSlot(page, page)
    await fillInvitee(page)
    const creating = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/bookings'),
    )
    await page.getByRole('button', { name: text.confirm, exact: true }).click()
    const created = (await (await creating).json()) as { manageToken: string }
    secrets.push(created.manageToken, join)
    await expect(page.getByRole('heading', { name: text.pending, exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: text.ics, exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: text.join, exact: true })).toHaveCount(0)
    await app.advanceMeet('pending')
    expect(await app.meetState()).toMatchObject({
      requests: 0,
      imports: 1,
      privateImports: true,
      conferencePatches: 1,
      conferenceSafe: true,
      deletes: 0,
    })
    await app.advanceMeet('success')
    await expect(page.getByRole('link', { name: text.join, exact: true })).toBeVisible()
    expect(
      (await page.getByRole('link', { name: text.join, exact: true }).getAttribute('href')) ===
        join,
    ).toBe(true)
    const download =
      (await page.getByRole('link', { name: text.ics, exact: true }).getAttribute('href')) ?? ''
    const dataPrefix = 'data:text/calendar;charset=utf-8,'
    expect(download.startsWith(dataPrefix)).toBe(true)
    expect(
      icsHasLocation(decodeURIComponent(download.slice(dataPrefix.length)), `Google Meet: ${join}`),
    ).toBe(true)
    expect((await app.meetState()).requests).toBe(2)
    expect((await app.meetState()).linkedRequests).toBe(true)
    await page.goto(`${app.url}/booking`)
    await page.evaluate((token) => {
      window.location.hash = new URLSearchParams({ token }).toString()
    }, created.manageToken)
    await expect(page.getByRole('button', { name: text.move, exact: true })).toBeVisible()
    expect(await page.evaluate(() => location.hash === '')).toBe(true)
    await page.getByRole('button', { name: text.move, exact: true }).click()
    await pickSlot(page, page)
    const moving = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/reschedule'),
    )
    await page.getByRole('button', { name: text.confirmMove, exact: true }).click()
    const moved = (await (await moving).json()) as { manageToken: string }
    secrets.push(moved.manageToken)
    await expect(page.getByText(text.moved, { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: text.join, exact: true })).toHaveCount(0)
    await app.advanceMeet('success')
    await expect(page.getByRole('link', { name: text.join, exact: true })).toBeVisible()
    expect((await app.meetState()).imports).toBe(1)
    expect((await app.meetState()).rootUidPreserved).toBe(true)
    expect((await app.meetState()).requests).toBe(4)
    await page.getByRole('button', { name: text.cancel, exact: true }).click()
    await page.getByRole('button', { name: text.cancel, exact: true }).click()
    await expect(page.getByRole('heading', { name: text.cancelled, exact: true })).toBeVisible()
    await app.advanceMeet('success')
    await expect(
      page.getByText(
        chinese
          ? 'Google 日历中的副本已取消。取消预约不会撤销现有 Meet 链接的访问权限。'
          : 'The Google calendar copy is cancelled. Cancelling does not revoke access to an existing Meet link.',
        { exact: true },
      ),
    ).toBeVisible()
    await expect(page.getByRole('link', { name: text.join, exact: true })).toHaveCount(0)
    expect((await app.meetState()).cancellations).toBe(2)
    expect(await app.meetState()).toMatchObject({
      imports: 1,
      privateImports: true,
      conferencePatches: 1,
      conferenceSafe: true,
      deletes: 0,
    })
    expect(privateReads).toBe(0)
    expect(unsafeRequest).toBe(false)
    expect(
      await page.evaluate(
        (values) =>
          Object.values(localStorage).every(
            (value) => !values.some((secret) => value.includes(secret)),
          ),
        secrets,
      ),
    ).toBe(true)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true)
  })

  test(`${selected} lost provider response offers a protected safe recheck without another import`, async ({
    page,
    app,
  }) => {
    await page.addInitScript(
      (language) => localStorage.setItem('hourmere-language', language),
      selected,
    )
    await page.goto(app.url + app.meetPath)
    await pickSlot(page, page)
    await fillInvitee(page)
    await page.getByRole('button', { name: text.confirm, exact: true }).click()
    await expect(page.getByRole('heading', { name: text.pending, exact: true })).toBeVisible()
    await app.advanceMeet('lost')
    await expect(
      page.getByText(
        chinese
          ? 'Google 可能已创建会议。重新检查只会查找该会议，不会另外创建。'
          : 'Google may have created the meeting. Rechecking only looks for that meeting and never creates a replacement.',
        { exact: true },
      ),
    ).toBeVisible()
    expect((await app.meetState()).requests).toBe(0)
    expect((await app.meetState()).failures).toBe(2)
    await app.authorizeHost()
    await page.goto(app.url + (await app.meetState()).hostBookingPath)
    const retry = page.getByRole('button', {
      name: chinese ? '重新查找现有会议' : 'Recheck existing meeting',
      exact: true,
    })
    await expect(retry).toBeVisible()
    const retrying = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/conference/retry'),
    )
    await retry.click()
    const retried = await retrying
    expect(retried.status()).toBe(204)
    expect(retried.request().postData()).toBe('{}')
    await expect(retry).toHaveCount(0)
    await app.advanceMeet('success')
    await expect(page.getByRole('link', { name: text.join, exact: true })).toBeVisible()
    expect(await app.meetState()).toMatchObject({
      imports: 1,
      privateImports: true,
      conferencePatches: 1,
      conferenceSafe: true,
      deletes: 0,
    })
    expect((await app.meetState()).requests).toBe(2)
    expect((await app.meetState()).linkedRequests).toBe(true)
  })
}
