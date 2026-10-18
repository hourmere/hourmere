import type { Page } from '@playwright/test'
import { expect, fillInvitee, pickSlot, test } from '../automatic-zoom-fixtures.ts'

const labels = (zh: boolean) => ({
  title: zh ? '标题' : 'Title',
  confirm: zh ? '确认预约' : 'Confirm booking',
  pending: zh ? '时段已保留，会议链接待生成' : 'Time reserved; meeting link pending',
  join: zh ? '加入 Zoom 会议' : 'Join Zoom meeting',
  move: zh ? '改期' : 'Reschedule',
  moved: zh ? '你的预约已改至新时间。' : 'Your booking is moved to the new time.',
  confirmMove: zh ? '确认新时间' : 'Confirm new time',
  cancel: zh ? '取消预约' : 'Cancel booking',
  cancelled: zh ? '已取消的预约' : 'Cancelled booking',
  cleanup: zh ? '原 Zoom 会议已取消。' : 'The original Zoom meeting has been cancelled.',
})
async function language(page: Page, locale: 'en' | 'zh-CN') {
  await page.addInitScript((locale) => localStorage.setItem('hourmere-language', locale), locale)
}
async function book(page: Page, url: string, zh: boolean) {
  await page.goto(url)
  await pickSlot(page, page)
  await fillInvitee(page)
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/bookings'),
  )
  await page.getByRole('button', { name: labels(zh).confirm, exact: true }).click()
  const created = await response
  expect(created.status()).toBe(201)
  return {
    response: created,
    value: (await created.json()) as { booking: { id: string }; manageToken: string },
  }
}
for (const locale of ['en', 'zh-CN'] as const) {
  const zh = locale === 'zh-CN',
    text = labels(zh)
  test(`Zoom ${locale}: explicit own account, lazy passive label and translated draft/error retry`, async ({
    page,
    zoomMeetingApp: app,
  }) => {
    await app.signIn('personal')
    await page.goto(app.url + app.eventPath)
    let reads = 0
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/v1/conference-connections') reads++
    })
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Synthetic Zoom call')
    expect(reads).toBe(0)
    app.failAccountRead(true)
    await page
      .getByRole('checkbox', { name: 'Create a unique Zoom meeting for each booking' })
      .check()
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await page.getByLabel('Title', { exact: true }).fill('Settings')
    if (zh) await page.getByLabel('Interface language', { exact: true }).selectOption(locale)
    await expect(page.getByLabel(text.title, { exact: true })).toHaveValue('Settings')
    app.failAccountRead(false)
    await page.getByRole('button', { name: zh ? '重试' : 'Retry', exact: true }).click()
    const account = page.getByLabel(zh ? 'Zoom 会议账号' : 'Zoom meetings account', { exact: true })
    await expect(account).toHaveValue('')
    await expect(account.getByRole('option', { name: 'Identity only account' })).toHaveCount(0)
    await page.getByRole('button', { name: zh ? '保存更改' : 'Save changes', exact: true }).click()
    await expect(page.locator('#zoomConnectionId-error')).toContainText(
      zh
        ? '请选择自己已授权会议权限的 Zoom 账号。'
        : 'Choose your own authorized Zoom meetings account.',
    )
    await account.selectOption({ label: 'Settings' })
    const selectedPin = await account.inputValue()
    expect(
      await page.evaluate(
        (pin) =>
          [...Object.values(localStorage), ...Object.values(sessionStorage)].every(
            (value) => !value.includes(pin),
          ),
        selectedPin,
      ),
    ).toBe(true)
    const saving = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().includes('/event-types/'),
    )
    await page.getByRole('button', { name: zh ? '保存更改' : 'Save changes', exact: true }).click()
    expect((await saving).status()).toBe(200)
    await expect(page.getByText(zh ? '已保存。' : 'Saved.', { exact: true })).toBeVisible()
    const metadata = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().includes('/event-types/'),
    )
    await page.getByLabel(text.title, { exact: true }).fill('Literal Zoom title')
    await page.getByRole('button', { name: zh ? '保存更改' : 'Save changes', exact: true }).click()
    const body = (await metadata).request().postDataJSON()
    for (const key of ['zoomConnectionId', 'hosts', 'location', 'scheduleId'])
      expect(body).not.toHaveProperty(key)
    expect(await app.foreignAndKey()).toEqual({ foreign: 403, key: 403, privateKey: 403 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true)
  })
  for (const scope of ['personal', 'team'] as const)
    test(`Zoom ${locale} ${scope}: book, same-key replay, ready, move same identity and cancel without Google`, async ({
      page,
      zoomMeetingApp: app,
    }) => {
      await language(page, locale)
      await app.configure(scope === 'team')
      let privateReads = 0,
        unsafe = false
      const secrets: string[] = []
      page.on('request', (r) => {
        const path = new URL(r.url()).pathname
        if (
          ['/api/v1/me', '/api/v1/profile'].includes(path) ||
          path.startsWith('/api/auth/') ||
          path.startsWith('/api/v1/conference-connections')
        )
          privateReads++
        unsafe ||= secrets.some(
          (s) => r.url().includes(s) || (r.headers().referer ?? '').includes(s),
        )
      })
      const created = await book(
        page,
        app.url + (scope === 'personal' ? app.personalPath : app.teamPath),
        zh,
      )
      secrets.push(created.value.manageToken)
      await expect(page.getByRole('heading', { name: text.pending, exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: text.join, exact: true })).toHaveCount(0)
      expect(await app.state()).toMatchObject({ posts: 0, calendars: 0, requestMail: 0 })
      const request = created.response.request()
      const replay = await page.request.post(request.url(), {
        data: request.postDataJSON(),
        headers: {
          'idempotency-key': (await request.headerValue('idempotency-key')) ?? '',
          origin: app.url,
        },
      })
      expect(replay.status()).toBe(200)
      expect((await replay.json()).booking.id === created.value.booking.id).toBe(true)
      await app.advance()
      const joinLink = page.getByRole('link', { name: text.join, exact: true })
      await expect(joinLink).toBeVisible()
      const join = await joinLink.getAttribute('href')
      expect(typeof join === 'string').toBe(true)
      secrets.push(join as string)
      expect((await joinLink.getAttribute('rel'))?.includes('noreferrer')).toBe(true)
      expect(await app.state()).toMatchObject({
        roots: 1,
        posts: 1,
        requestMail: 2,
        rootStable: true,
        calendars: 0,
        mailSafe: true,
        mirrors: ['not_configured'],
      })
      await page.goto(`${app.url}/booking`)
      await page.evaluate((token) => {
        window.location.hash = new URLSearchParams({ token }).toString()
      }, created.value.manageToken)
      await expect(page.getByRole('button', { name: text.move, exact: true })).toBeVisible()
      expect(await page.evaluate(() => location.hash === '')).toBe(true)
      await page.getByRole('button', { name: text.move, exact: true }).click()
      await pickSlot(page, page)
      const moving = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/reschedule'),
      )
      await page.getByRole('button', { name: text.confirmMove, exact: true }).click()
      expect((await moving).status()).toBe(200)
      await expect(page.getByText(text.moved, { exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: text.join, exact: true })).toHaveCount(0)
      await app.advance()
      await expect(joinLink).toBeVisible()
      expect((await joinLink.getAttribute('href')) === join).toBe(true)
      expect(await app.state()).toMatchObject({
        roots: 1,
        posts: 1,
        patches: 1,
        requestMail: 4,
        rootStable: true,
        mailSafe: true,
      })
      await page.getByRole('button', { name: text.cancel, exact: true }).click()
      const cancelling = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/cancel'),
      )
      await page.getByRole('button', { name: text.cancel, exact: true }).click()
      expect((await cancelling).status()).toBe(200)
      await expect(page.getByRole('heading', { name: text.cancelled, exact: true })).toBeVisible()
      await app.advance()
      await expect(page.getByText(text.cleanup, { exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: text.join, exact: true })).toHaveCount(0)
      expect(await app.state()).toMatchObject({
        posts: 1,
        deletes: 1,
        meetings: 0,
        cancelMail: 2,
        rootStable: true,
      })
      expect(privateReads).toBe(0)
      expect(unsafe).toBe(false)
      expect(
        await page.evaluate(
          (secrets) =>
            [...Object.values(localStorage), ...Object.values(sessionStorage)].every(
              (value) => !secrets.some((s) => value.includes(s)),
            ),
          secrets,
        ),
      ).toBe(true)
    })
  test(`Zoom ${locale}: accepted unknown creation offers manual orphan inspection and never a second POST`, async ({
    page,
    zoomMeetingApp: app,
  }) => {
    await language(page, locale)
    await app.configure()
    await book(page, app.url + app.personalPath, zh)
    await app.advance('lost')
    await expect(
      page.getByText(
        zh ? /主持人必须检查自己的 Zoom 账号/ : /host must inspect their Zoom account/,
      ),
    ).toBeVisible()
    expect(await app.state()).toMatchObject({ posts: 1, meetings: 1, requestMail: 0 })
    await app.signIn('personal')
    await page.goto(app.url + (await app.state()).hostPath)
    await expect(
      page.getByText(
        zh ? /主持人必须检查自己的 Zoom 账号/ : /host must inspect their Zoom account/,
      ),
    ).toBeVisible()
    await expect(
      page.getByRole('button', {
        name: /^(Retry meeting link|Recheck existing meeting|重试生成会议链接|重新查找现有会议)$/,
      }),
    ).toHaveCount(0)
    await app.advance()
    expect((await app.state()).posts).toBe(1)
  })
  test(`Zoom ${locale}: known-ID invalid link can be safely retried and never creates a replacement`, async ({
    page,
    zoomMeetingApp: app,
  }) => {
    await language(page, locale)
    await app.configure()
    await book(page, app.url + app.personalPath, zh)
    await app.advance('unsafe')
    await expect(
      page.getByRole('heading', {
        name: zh ? '时段已保留，会议链接需要处理' : 'Time reserved; meeting link needs attention',
        exact: true,
      }),
    ).toBeVisible()
    await expect(page.getByRole('link', { name: text.join, exact: true })).toHaveCount(0)
    await app.signIn('personal')
    await page.goto(app.url + (await app.state()).hostPath)
    const retrying = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/conference/retry'),
    )
    await page
      .getByRole('button', { name: zh ? '重试生成会议链接' : 'Retry meeting link', exact: true })
      .click()
    const retry = await retrying
    expect(retry.status()).toBe(204)
    expect(retry.request().postData()).toBe('{}')
    await app.advance()
    await expect(page.getByRole('link', { name: text.join, exact: true })).toBeVisible()
    expect(await app.state()).toMatchObject({ posts: 1, meetings: 1, requestMail: 2 })
  })
}

test.describe('optional Google copy and embedding', () => {
  test.use({ zoomMirror: true })
  for (const locale of ['en', 'zh-CN'] as const)
    test(`Zoom ${locale}: one ordinary ready copy and private embed isolation`, async ({
      page,
      zoomMeetingApp: app,
    }) => {
      const zh = locale === 'zh-CN',
        text = labels(zh)
      await language(page, locale)
      await app.configure()
      let privateReads = 0
      page.on('request', (r) => {
        const path = new URL(r.url()).pathname
        if (
          ['/api/v1/me', '/api/v1/profile'].includes(path) ||
          path.startsWith('/api/auth/') ||
          path.startsWith('/api/v1/conference-connections')
        )
          privateReads++
      })
      const source = `/embed${app.personalPath}?${new URLSearchParams({ parentOrigin: app.url, embedId: 'syntheticZoomEmbed01', language: locale })}`
      await page.route(`${app.url}/synthetic-zoom-parent`, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.messages=[];addEventListener('message',e=>window.messages.push(e.data))</script><iframe title="Synthetic Zoom booking" src="${source}" style="width:100%;height:900px;border:0"></iframe>`,
        }),
      )
      await page.goto(`${app.url}/synthetic-zoom-parent`)
      const frame = page.getByTitle('Synthetic Zoom booking').contentFrame()
      await pickSlot(frame, page)
      await fillInvitee(frame)
      const creating = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/bookings'),
      )
      await frame.getByRole('button', { name: text.confirm, exact: true }).click()
      expect((await creating).status()).toBe(201)
      await app.advance()
      await expect(frame.getByRole('link', { name: text.join, exact: true })).toBeVisible()
      expect(await app.state()).toMatchObject({
        roots: 1,
        posts: 1,
        mirrors: ['ready'],
        ordinaryCopies: 1,
        ordinarySafe: true,
        calendars: 1,
      })
      const publicData = await page.request.get(`${app.url}/api/v1/public/zoom-booking/call`)
      expect(
        /zoomConnectionId|synthetic-zoom-identity|invitation_organizer|us02web|calendarCopy/.test(
          await publicData.text(),
        ),
      ).toBe(false)
      const messages = await page.evaluate(
        () => (window as unknown as { messages: unknown[] }).messages,
      )
      expect(messages.some((m) => (m as { type?: string }).type === 'hourmere:booked')).toBe(true)
      expect(
        /token|zoomConnectionId|us02web|calendarCopy|synthetic-zoom-identity/i.test(
          JSON.stringify(messages),
        ),
      ).toBe(false)
      expect(privateReads).toBe(0)
      await app.signIn('personal')
      await page.goto(app.url + (await app.state()).hostPath)
      await expect(
        page.getByText(
          zh ? '您的原日历副本已更新。' : 'Your original calendar copy is up to date.',
          { exact: true },
        ),
      ).toBeVisible()
    })
})
test.describe('automatic Zoom defaults off', () => {
  test.use({ automaticZoom: false })
  test('passive Zoom stays inert and does not load private accounts', async ({
    page,
    zoomMeetingApp: app,
  }) => {
    await app.signIn('personal')
    await page.goto(app.url + app.eventPath)
    let reads = 0
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/v1/conference-connections')) reads++
    })
    await expect(
      page.getByRole('checkbox', { name: 'Create a unique Zoom meeting for each booking' }),
    ).toBeDisabled()
    await page.getByLabel('Title', { exact: true }).fill('Metadata while disabled')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
    expect(reads).toBe(0)
    expect(await app.state()).toMatchObject({ roots: 0, posts: 0, meetings: 0 })
  })
})
