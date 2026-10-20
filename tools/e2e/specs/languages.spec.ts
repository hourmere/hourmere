import type { Locator, Page } from '@playwright/test'
import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'

type Language = 'en' | 'zh-CN'
const text = {
  en: {
    name: 'Your name',
    email: 'Email',
    confirm: 'Confirm booking',
    booked: 'You’re booked',
    reschedule: 'Reschedule',
    confirmTime: 'Confirm new time',
    moved: 'Your booking is moved to the new time.',
    cancel: 'Cancel booking',
    cancelHeading: 'Cancel this booking?',
    cancelled: 'Cancelled booking',
    openLink: 'Open your booking link',
    popup: 'Book a meeting',
    iframe: 'Book a meeting with Hourmere',
    close: 'Close booking',
    title: 'Title',
    duration: 'Duration (minutes)',
    create: 'Create event type',
    numberError: 'Enter a number.',
    navBookings: 'Bookings',
  },
  'zh-CN': {
    name: '你的姓名',
    email: '邮箱',
    confirm: '确认预约',
    booked: '预约成功',
    reschedule: '改期',
    confirmTime: '确认新时间',
    moved: '你的预约已改至新时间。',
    cancel: '取消预约',
    cancelHeading: '取消此预约？',
    cancelled: '已取消的预约',
    openLink: '打开预约链接',
    popup: '预约会议',
    iframe: '通过 Hourmere 预约会议',
    close: '关闭预约窗口',
    title: '标题',
    duration: '时长（分钟）',
    create: '创建活动类型',
    numberError: '请输入数字。',
    navBookings: '预约',
  },
} as const
const other = (language: Language): Language => (language === 'en' ? 'zh-CN' : 'en')
async function language(scope: Page | Locator, value: Language) {
  await scope.getByRole('combobox', { name: /^(Interface language|界面语言)$/ }).selectOption(value)
}
async function initialLanguage(page: Page, value: Language) {
  await page.addInitScript((selected) => localStorage.setItem('hourmere-language', selected), value)
}
function observePublic(page: Page) {
  const capabilities: string[] = []
  let sessionReads = 0,
    privateChunks = 0,
    capabilityInRequest = false
  page.on('request', (request) => {
    const url = new URL(request.url()),
      headers = request.headers()
    if (url.pathname === '/api/v1/me' || url.pathname === '/api/v1/profile') sessionReads++
    if (url.pathname.startsWith('/api/auth/')) sessionReads++
    if (
      /\/assets\/(?:session|AppShell|Settings|ApiKeys|EventTypeEditor|Analytics|admin)-[^/]+\.js$/.test(
        url.pathname,
      )
    )
      privateChunks++
    capabilityInRequest ||=
      Boolean(url.hash) ||
      [...url.searchParams.keys()].some((key) => /token|api.?key/i.test(key)) ||
      capabilities.some(
        (token) => request.url().includes(token) || headers.referer?.includes(token),
      )
  })
  return {
    remember: (token: string) => capabilities.push(token),
    check: () => {
      expect(sessionReads, 'Public language choice must not request account data').toBe(0)
      expect(privateChunks, 'Public language choice must not load the account graph').toBe(0)
      expect(capabilityInRequest, 'Capabilities must stay out of URLs and Referer').toBe(false)
    },
  }
}

for (const selected of ['en', 'zh-CN'] as const) {
  for (const kind of ['personal', 'team'] as const) {
    test(`${selected} ${kind} booking survives a committed lost response and language changes`, async ({
      page,
      app,
    }) => {
      const privacy = observePublic(page),
        switched = other(selected)
      await initialLanguage(page, selected)
      await page.goto(app.url + (kind === 'personal' ? app.personalPath : app.teamPath))
      await pickSlot(page, page)
      await fillInvitee(page)
      const originalName = await page
        .getByLabel(text[selected].name, { exact: true })
        .elementHandle()
      let firstBody = '',
        firstKey = '',
        firstToken = '',
        posts = 0,
        sameBody = false,
        sameKey = false,
        replayWithoutToken = false,
        committedBeforeLoss = false
      await page.route('**/api/v1/public/**/bookings', async (route) => {
        posts++
        const request = route.request(),
          body = request.postData() ?? '',
          key = request.headers()['idempotency-key'] ?? ''
        const response = await route.fetch()
        if (posts === 1) {
          firstBody = body
          firstKey = key
          const result = (await response.json()) as { manageToken?: unknown }
          expect(response.status()).toBe(201)
          expect(typeof result.manageToken === 'string').toBe(true)
          firstToken = result.manageToken as string
          privacy.remember(firstToken)
          const state = await app.bookingState()
          committedBeforeLoss = state.total === 1 && state.roots === 1 && state.fingerprints === 1
          // The real HTTP handler has committed. Withhold its response from the browser.
          await route.abort('connectionclosed')
        } else {
          sameBody = body === firstBody
          sameKey = key.length > 0 && key === firstKey
          const result = (await response.json()) as { manageToken?: unknown }
          replayWithoutToken = response.status() === 200 && result.manageToken === null
          await route.fulfill({ response })
        }
      })
      await page.getByRole('button', { name: text[selected].confirm, exact: true }).click()
      await expect(page.getByRole('alert')).toContainText(
        selected === 'en' ? 'Your booking is not confirmed yet.' : '你的预约尚未确认。',
      )
      expect(committedBeforeLoss).toBe(true)
      await language(page, switched)
      await expect(page.getByRole('alert')).toContainText(
        switched === 'en' ? 'Your booking is not confirmed yet.' : '你的预约尚未确认。',
      )
      expect(
        await page
          .getByLabel(text[switched].name, { exact: true })
          .evaluate((element, old) => element === old, originalName),
      ).toBe(true)
      await expect(page.getByLabel(text[switched].name, { exact: true })).toHaveValue(
        'Fixture Invitee',
      )
      await expect(page.getByLabel(text[switched].email, { exact: true })).toHaveValue(
        'fixture-invitee@hourmere.invalid',
      )
      await page.getByRole('button', { name: text[switched].confirm, exact: true }).click()
      await expect(
        page.getByRole('heading', { name: text[switched].booked, exact: true }),
      ).toBeVisible()
      expect({ posts, sameBody, sameKey, replayWithoutToken }).toEqual({
        posts: 2,
        sameBody: true,
        sameKey: true,
        replayWithoutToken: true,
      })
      expect(JSON.parse(firstBody).invitee.locale === selected).toBe(true)
      expect(await app.bookingState()).toEqual({
        total: 1,
        roots: 1,
        successors: 0,
        bookerLocales: [selected],
        fingerprints: 1,
        originalFingerprintPreserved: true,
      })
      await language(page, selected)
      await expect(
        page.getByRole('heading', { name: text[selected].booked, exact: true }),
      ).toBeVisible()
      // A test-only in-memory copy of the withheld response exercises the private link;
      // the actual replay UI correctly has no capability to recover or display.
      await page.goto(`${app.url}/booking`)
      await expect(page.getByRole('heading', { name: text[selected].openLink })).toBeVisible()
      await page.evaluate((token) => {
        window.location.hash = new URLSearchParams({ token }).toString()
      }, firstToken)
      await expect.poll(() => page.evaluate(() => window.location.hash === '')).toBe(true)
      const managed: boolean[] = []
      page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/api/v1/bookings/manage'))
          managed.push(Boolean(request.headers()['x-manage-token']) && !request.headers().referer)
      })
      await page.getByRole('button', { name: text[selected].reschedule, exact: true }).click()
      await pickSlot(page, page)
      await language(page, switched)
      const moving = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/bookings/manage/reschedule' &&
          response.request().method() === 'POST',
      )
      await page.getByRole('button', { name: text[switched].confirmTime, exact: true }).click()
      const move = (await (await moving).json()) as { manageToken?: unknown }
      expect(typeof move.manageToken === 'string' && move.manageToken !== firstToken).toBe(true)
      privacy.remember(move.manageToken as string)
      await expect(page.getByText(text[switched].moved, { exact: true })).toBeVisible()
      await page.getByRole('button', { name: text[switched].cancel, exact: true }).click()
      await expect(page.getByRole('heading', { name: text[switched].cancelHeading })).toBeVisible()
      await page.getByLabel(/^(Reason|原因)/).fill('Custom reason stays unchanged')
      await language(page, selected)
      await expect(page.getByLabel(/^(Reason|原因)/)).toHaveValue('Custom reason stays unchanged')
      await page.getByRole('button', { name: text[selected].cancel, exact: true }).click()
      await expect(
        page.getByRole('heading', { name: text[selected].cancelled, exact: true }),
      ).toBeVisible()
      expect(await app.rows()).toEqual([
        { source: 'web', status: 'cancelled' },
        { source: 'web', status: 'cancelled' },
      ])
      expect((await app.bookingState()).roots).toBe(1)
      expect((await app.bookingState()).successors).toBe(1)
      expect(managed.length >= 3 && managed.every(Boolean)).toBe(true)
      privacy.check()
    })
  }

  test(`${selected} inline and popup widgets preserve language, resize and sender privacy`, async ({
    page,
    app,
  }) => {
    const privacy = observePublic(page)
    await page.goto(`${app.parentUrl}/?language=${selected}`)
    const inline = page.locator('[data-hourmere-inline] > iframe'),
      inlineBody = inline.contentFrame().locator('body')
    await expect(inline).toHaveAttribute('title', text[selected].iframe)
    await expect(inlineBody.getByRole('heading', { name: 'Fixture call' })).toBeVisible()
    expect(new URL((await inline.getAttribute('src')) ?? '').searchParams.get('language')).toBe(
      selected,
    )
    await expect(
      inlineBody.getByRole('combobox', { name: /^(Interface language|界面语言)$/ }),
    ).toHaveCount(0)
    await expect(inline.contentFrame().locator('html')).toHaveAttribute('lang', selected)
    await expect
      .poll(async () =>
        Number.parseInt(await inline.evaluate((element) => element.style.height), 10),
      )
      .toBeGreaterThanOrEqual(240)
    expect(
      await inline.evaluate((element) => Number.parseInt(element.style.height, 10) <= 2000),
    ).toBe(true)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const frame = document.querySelector<HTMLIFrameElement>('[data-hourmere-inline] > iframe')
          if (!frame) return false
          const id = new URL(frame.src).searchParams.get('embedId')
          return (
            window as unknown as { fixtureMessages: Record<string, unknown>[] }
          ).fixtureMessages.some(
            (message) =>
              message.type === 'hourmere:resize' &&
              message.id === id &&
              message.height === Number.parseInt(frame.style.height, 10),
          )
        }),
      )
      .toBe(true)
    const opener = page.getByRole('button', { name: 'Book a meeting', exact: true })
    await opener.click()
    const dialog = page.getByRole('dialog', { name: text[selected].popup }),
      popupFrame = dialog.locator('iframe'),
      popupBody = popupFrame.contentFrame().locator('body')
    await expect(popupFrame).toHaveAttribute('title', text[selected].iframe)
    await expect(popupBody.getByRole('heading', { name: 'Fixture call' })).toBeVisible()
    const popupUrl = (await popupFrame.getAttribute('src')) ?? '',
      popupId = new URL(popupUrl).searchParams.get('embedId') ?? ''
    async function rejectMessages(sender: Locator, id: string) {
      const before = await popupFrame.evaluate((frame) => frame.style.height)
      await page.evaluate((messageId) => {
        const state = window as unknown as { fixtureProbeMessages: number }
        state.fixtureProbeMessages = 0
        const received = (event: MessageEvent) => {
          if (
            event.isTrusted &&
            event.data?.id === messageId &&
            (event.data?.type === 'hourmere:close' ||
              (event.data?.type === 'hourmere:resize' && event.data?.height === 1999))
          ) {
            state.fixtureProbeMessages++
            if (state.fixtureProbeMessages === 2) window.removeEventListener('message', received)
          }
        }
        window.addEventListener('message', received)
      }, id)
      await sender.evaluate(
        (_, { id, target }) => {
          for (const type of ['hourmere:resize', 'hourmere:close'])
            window.parent.postMessage({ type, id, height: 1999 }, target)
        },
        { id, target: app.parentUrl },
      )
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { fixtureProbeMessages: number }).fixtureProbeMessages,
          ),
        )
        .toBe(2)
      await expect(dialog).toBeVisible()
      expect(await popupFrame.evaluate((frame) => frame.style.height)).toBe(before)
    }
    // Keep the popup WindowProxy, but retire the actual app/ResizeObserver before
    // comparing heights. Navigation preserves sender identity across documents.
    const appSenderUrl = `${app.url}/sender-probe`,
      parentSenderUrl = `${app.parentUrl}/sender-probe`
    for (const url of [appSenderUrl, parentSenderUrl])
      await page.route(url, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
          body: '<!doctype html><title>Owned sender probe</title><body>Sender probe</body>',
        }),
      )
    try {
      await popupFrame.evaluate((frame, url) => {
        frame.setAttribute('src', url)
      }, appSenderUrl)
      await expect(popupBody).toHaveText('Sender probe')
      // A valid real sender is accepted; this also follows any messages queued by
      // the retired app. The earlier inline assertions still exercise its real observer.
      await popupBody.evaluate(
        (_, { id, target }) =>
          window.parent.postMessage({ type: 'hourmere:resize', id, height: 777 }, target),
        { id: popupId, target: app.parentUrl },
      )
      await expect(popupFrame).toHaveCSS('height', '777px')
      // Expected origin and ID, but a different sender WindowProxy.
      await rejectMessages(inlineBody, popupId)
      // Expected origin and sender Window, but a different correlation ID.
      await rejectMessages(popupBody, 'different_embed_id')
      // Expected sender Window and ID, but a different origin.
      await popupFrame.evaluate((frame, url) => {
        frame.setAttribute('src', url)
      }, parentSenderUrl)
      await expect(popupBody).toHaveText('Sender probe')
      await rejectMessages(popupBody, popupId)
    } finally {
      await page.unroute(appSenderUrl)
      await page.unroute(parentSenderUrl)
    }
    await popupFrame.evaluate((frame, url) => {
      frame.setAttribute('src', url)
    }, popupUrl)
    await expect(popupBody.getByRole('heading', { name: 'Fixture call' })).toBeVisible()
    await expect(
      popupBody.getByRole('combobox', { name: /^(Interface language|界面语言)$/ }),
    ).toHaveCount(0)
    await popupBody.evaluate(
      (_, saved) => localStorage.setItem('hourmere-language', saved),
      other(selected),
    )
    await popupBody.getByRole('button', { name: /^(Next month|下个月)$/ }).focus()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
    await opener.click()
    const body = page.locator('dialog iframe').contentFrame().locator('body')
    // The declared embed option wins over the stored standalone-page preference.
    await expect(
      body.getByRole('combobox', { name: /^(Interface language|界面语言)$/ }),
    ).toHaveCount(0)
    await expect(dialog.locator('iframe').contentFrame().locator('html')).toHaveAttribute(
      'lang',
      selected,
    )
    await pickSlot(body, page)
    await fillInvitee(body)
    await body.getByRole('button', { name: text[selected].confirm, exact: true }).click()
    await expect(body.getByRole('heading', { name: text[selected].booked })).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { fixtureMessages: { type: string }[] }).fixtureMessages.filter(
              (message) => message.type === 'hourmere:booked',
            ).length,
        ),
      )
      .toBe(1)
    const privateContract = await page.evaluate(() => {
      const messages = (window as unknown as { fixtureMessages: Record<string, unknown>[] })
        .fixtureMessages
      return messages.every(
        (message) =>
          Object.keys(message).every((key) => ['type', 'id', 'height'].includes(key)) &&
          !JSON.stringify(message).includes('fixture-invitee@hourmere.invalid'),
      )
    })
    expect(privateContract).toBe(true)
    expect(await app.rows()).toEqual([{ source: 'embed', status: 'confirmed' }])
    await page.getByRole('button', { name: text[selected].close }).click()
    await expect(opener).toBeFocused()
    privacy.check()
  })

  test(`${selected} admin draft, localized validation and real saves survive language switches`, async ({
    page,
    app,
  }) => {
    await app.authorizeHost()
    await initialLanguage(page, selected)
    await page.goto(`${app.url}/app/event-types/new`)
    const title = page.getByLabel(text[selected].title, { exact: true })
    await title.fill('Settings')
    await page.getByLabel(text[selected].duration, { exact: true }).fill('')
    await page.getByRole('button', { name: text[selected].create, exact: true }).click()
    await expect(page.getByRole('alert')).toContainText(text[selected].numberError)
    const original = await title.elementHandle()
    await language(page, other(selected))
    await expect(page.getByRole('alert')).toContainText(text[other(selected)].numberError)
    const translatedTitle = page.getByLabel(text[other(selected)].title, { exact: true })
    expect(await translatedTitle.evaluate((element, old) => element === old, original)).toBe(true)
    await expect(translatedTitle).toHaveValue('Settings')
    let leaveConfirmed = false
    page.once('dialog', async (dialog) => {
      leaveConfirmed = dialog.type() === 'confirm' && /未保存|unsaved/.test(dialog.message())
      await dialog.dismiss()
    })
    await page.getByRole('link', { name: text[other(selected)].navBookings, exact: true }).click()
    expect(leaveConfirmed).toBe(true)
    expect(new URL(page.url()).pathname).toBe('/app/event-types/new')
    await expect(translatedTitle).toHaveValue('Settings')
    await page.getByLabel(text[other(selected)].duration, { exact: true }).fill('25')
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/event-types' &&
        response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: text[other(selected)].create, exact: true }).click()
    const response = await saved
    expect(response.status()).toBe(201)
    const event = (await response.json()) as { title: string; durationMinutes: number }
    expect(event.title === 'Settings' && event.durationMinutes === 25).toBe(true)
    await expect.poll(() => new URL(page.url()).pathname).toBe('/app/event-types')
    await language(page, selected)
    await expect(page.getByText('Settings', { exact: true })).toBeVisible()
  })
}

for (const selected of ['en', 'zh-CN'] as const) {
  test(`${selected} booking activity preserves filters and enforces real team permissions`, async ({
    page,
    app,
  }) => {
    await initialLanguage(page, selected)
    await page.goto(app.url + app.personalPath)
    await pickSlot(page, page)
    await fillInvitee(page)
    await page.getByRole('button', { name: text[selected].confirm, exact: true }).click()
    await expect(page.getByRole('heading', { name: text[selected].booked })).toBeVisible()
    await app.authorizeHost()
    await page.goto(`${app.url}/app/analytics`)
    await expect(
      page.getByRole('table', { name: /^(Daily booking activity|每日预约统计)$/ }),
    ).toBeVisible()
    await expect(page.locator('dl.details dd').first()).toHaveText('1')
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true)
    const today = Temporal.Now.plainDateISO('UTC').toString()
    await page.getByLabel(/^(Start date|开始日期)$/).fill(today)
    await language(page, other(selected))
    await expect(page.getByLabel(/^(Start date|开始日期)$/)).toHaveValue(today)
    await page.getByLabel(/^(End date|结束日期)$/).fill(today)
    await page.getByRole('button', { name: /^(Update report|更新统计)$/ }).click()
    await expect(page.getByRole('rowheader', { name: today, exact: true })).toHaveCount(1)
    await expect(page.locator('dl.details dd').first()).toHaveText('1')
    await language(page, selected)
    await expect(
      page.getByRole('heading', { name: /^(Booking activity|预约统计)$/, level: 1 }),
    ).toBeVisible()
    await expect(
      page.getByRole('table', { name: /^(Daily booking activity|每日预约统计)$/ }),
    ).toBeVisible()
    await app.authorizeHost('member')
    const denied = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/analytics/bookings',
    )
    await page.reload()
    expect((await denied).status()).toBe(403)
    await expect(
      page.getByText(
        /Your current team role does not permit this report|你当前的团队角色无权查看此统计/,
      ),
    ).toBeVisible()
    await expect(page.getByRole('table')).toHaveCount(0)
    await language(page, other(selected))
    await expect(
      page.getByText(
        /Your current team role does not permit this report|你当前的团队角色无权查看此统计/,
      ),
    ).toBeVisible()
    await expect(page.getByRole('table')).toHaveCount(0)
    await app.authorizeHost('owner')
    await page.reload()
    await expect(
      page.getByRole('table', { name: /^(Daily booking activity|每日预约统计)$/ }),
    ).toBeVisible()
    await expect(page.locator('dl.details dd').first()).toHaveText('0')
  })
}

test('zh-CN collective host drafts, validation and public booking preserve every required host', async ({
  page,
  app,
}) => {
  await initialLanguage(page, 'zh-CN')
  await app.authorizeHost('owner')
  await page.goto(`${app.url}/app/event-types/new`)
  const title = page.getByLabel('标题', { exact: true })
  await title.fill('Chinese panel interview')
  await page.getByLabel('排期方式', { exact: true }).selectOption('collective')
  await page.getByRole('button', { name: '创建活动类型', exact: true }).click()
  await expect(page.getByText('请选择两至八位必选主持人。').first()).toBeVisible()
  await language(page, 'en')
  await expect(page.getByText('Choose two to eight required hosts.').first()).toBeVisible()
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Chinese panel interview')
  await page.getByLabel('Second Required Host', { exact: true }).check()
  await language(page, 'zh-CN')
  await expect(page.getByLabel('Second Required Host', { exact: true })).toBeChecked()
  await page.getByRole('button', { name: '创建活动类型', exact: true }).click()
  await expect(page.getByRole('heading', { name: '活动类型', exact: true })).toBeVisible()
  await page.goto(`${app.url}/team/FixtureTeam/chinese-panel-interview`)
  await expect(
    page.getByRole('heading', { name: 'Chinese panel interview', exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/必选主持人：/)).toContainText('Second Required Host')
  await pickSlot(page, page)
  await fillInvitee(page)
  await page.getByRole('button', { name: '确认预约', exact: true }).click()
  await expect(page.getByRole('heading', { name: '预约成功', exact: true })).toBeVisible()
  expect(await app.hostCounts()).toEqual([2])
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)
})

test('zh-CN collective popup keeps language and capability-free completion for both hosts', async ({
  page,
  app,
}) => {
  await page.goto(`${app.parentUrl}/collective?language=zh-CN`)
  await page.getByRole('button', { name: 'Book a meeting', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '预约会议', exact: true })
  const frame = dialog.locator('iframe').contentFrame()
  await expect(
    frame.getByRole('heading', { name: 'Collective fixture call', exact: true }),
  ).toBeVisible()
  await expect(frame.getByLabel('界面语言')).toHaveCount(0)
  await expect(frame.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(frame.getByText(/必选主持人：/)).toContainText('Second Required Host')
  await pickSlot(frame.locator('body'), page)
  await fillInvitee(frame.locator('body'))
  await frame.getByRole('button', { name: '确认预约', exact: true }).click()
  await expect(frame.getByRole('heading', { name: '预约成功', exact: true })).toBeVisible()
  expect(await app.rows()).toEqual([{ source: 'embed', status: 'confirmed' }])
  expect(await app.hostCounts()).toEqual([2])
  await expect
    .poll(() =>
      page.evaluate(() => {
        const messages = (window as unknown as { fixtureMessages: unknown[] }).fixtureMessages
        return messages.some((value) => {
          if (!value || typeof value !== 'object') return false
          const message = value as Record<string, unknown>
          return (
            message.type === 'hourmere:booked' &&
            Object.keys(message).sort().join(',') === 'id,type' &&
            typeof message.id === 'string'
          )
        })
      }),
    )
    .toBe(true)
})
