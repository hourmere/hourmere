import { expect, test } from '../zoom-fixtures.ts'

const labels = {
  en: {
    title: 'Conference accounts',
    connect: 'Connect Zoom',
    connected: 'Zoom account connected.',
    refresh: 'Refresh Zoom account',
    refreshed: 'Zoom account refreshed.',
    reconnect: 'Reconnect Zoom',
    disconnect: 'Disconnect Zoom',
    disconnected: 'No Zoom accounts connected.',
    cancel: 'Cancel',
    permission:
      'Zoom did not return exactly the requested permissions. Check the app configuration and reconnect.',
    reauth: 'Reconnection required',
    disabled: 'Zoom connections are not configured on this instance.',
  },
  'zh-CN': {
    title: '会议账号',
    connect: '连接 Zoom',
    connected: 'Zoom 账号已连接。',
    refresh: '刷新 Zoom 账号',
    refreshed: 'Zoom 账号已刷新。',
    reconnect: '重新连接 Zoom',
    disconnect: '断开 Zoom',
    disconnected: '尚未连接 Zoom 账号。',
    cancel: '取消',
    permission: 'Zoom 返回的权限与所请求的权限不完全一致。请检查应用配置后重新连接。',
    reauth: '需要重新连接',
    disabled: '此实例尚未配置 Zoom 连接。',
  },
} as const
for (const language of ['en', 'zh-CN'] as const) {
  const text = labels[language]
  test(`Zoom ${language}: real session OAuth callback, refresh, owner isolation and local disconnect`, async ({
    page,
    zoomApp,
  }) => {
    await page.goto(`${zoomApp.url}/app/conferences`)
    await page.getByRole('combobox', { name: 'Interface language' }).selectOption(language)
    await expect(page.getByRole('heading', { name: text.title, level: 1 })).toBeVisible()
    await page.keyboard.press('Tab')
    await page.getByRole('button', { name: text.connect, exact: true }).click()
    await expect(page.getByText(text.connected, { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible()
    await expect(page.getByText('zoom@example.com', { exact: true })).toBeVisible()
    expect(await zoomApp.state()).toMatchObject({
      connections: 1,
      active: 1,
      secrets: 1,
      attempts: 0,
      calendars: 0,
      identityLiteral: true,
    })
    expect(await zoomApp.disconnectForeign()).toBe(404)
    const apiKeyList = await zoomApp.apiKeyListStatus()
    expect(apiKeyList.status).toBe(200)
    expect(apiKeyList.body.data.map((connection) => connection.id).sort()).toEqual(
      apiKeyList.ownConnectionIds.sort(),
    )
    expect(apiKeyList.browserPendingAttempts).toBe(1)
    expect(apiKeyList.body.pendingAttempts).toBe(0)
    expect(Object.keys(apiKeyList.body).sort()).toEqual([
      'data',
      'maximumConnections',
      'pendingAttempts',
      'zoomEnabled',
      'zoomMeetingsEnabled',
    ])
    for (const connection of apiKeyList.body.data)
      expect(Object.keys(connection).sort()).toEqual([
        'accountEmail',
        'createdAt',
        'displayName',
        'id',
        'lastError',
        'mode',
        'provider',
        'status',
        'updatedAt',
      ])
    await page.getByRole('button', { name: text.refresh, exact: true }).click()
    await expect(page.getByText(text.refreshed, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: text.disconnect, exact: true }).click()
    await expect(page.getByRole('button', { name: text.cancel, exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    expect((await zoomApp.state()).active).toBe(1)
    await page.getByRole('button', { name: text.disconnect, exact: true }).click()
    await page
      .getByRole('group')
      .getByRole('button', { name: text.disconnect, exact: true })
      .click()
    await expect(page.getByText(text.disconnected, { exact: true })).toBeVisible()
    expect(await zoomApp.state()).toMatchObject({
      connections: 1,
      disconnected: 1,
      secrets: 0,
      attempts: 0,
      calendars: 0,
    })
    const width = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }))
    expect(width.document <= width.viewport, 'Conference controls must fit the viewport').toBe(true)
  })
  test(`Zoom ${language}: scope failure retires access, error translates in place and reconnect restores the same record`, async ({
    page,
    zoomApp,
  }) => {
    await page.goto(`${zoomApp.url}/app/conferences`)
    await page.getByRole('combobox', { name: 'Interface language' }).selectOption(language)
    await page.getByRole('button', { name: text.connect, exact: true }).click()
    await expect(page.getByText(text.connected, { exact: true })).toBeVisible()
    zoomApp.setScopeFailure()
    await page.getByRole('button', { name: text.refresh, exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(text.permission)
    await expect(page.getByText(text.reauth, { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: text.refresh, exact: true })).toBeDisabled()
    expect(await zoomApp.state()).toMatchObject({ connections: 1, active: 0, secrets: 0 })
    const alternative = language === 'en' ? 'zh-CN' : 'en',
      other = labels[alternative]
    await page.locator('.language-picker select').selectOption(alternative)
    await expect(page.getByRole('alert')).toHaveText(other.permission)
    await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible()
    zoomApp.restoreScope()
    await page.getByRole('button', { name: other.reconnect, exact: true }).click()
    await expect(page.getByText(other.connected, { exact: true })).toBeVisible()
    expect(await zoomApp.state()).toMatchObject({
      connections: 1,
      active: 1,
      secrets: 1,
      attempts: 0,
    })
  })
}
test.describe('Zoom disabled by default', () => {
  test.use({ zoomEnabled: false })
  for (const language of ['en', 'zh-CN'] as const)
    test(`Zoom ${language}: truthful disabled UI and public session isolation`, async ({
      page,
      context,
      zoomApp,
    }) => {
      await page.goto(`${zoomApp.url}/app/conferences`)
      await page.getByRole('combobox', { name: 'Interface language' }).selectOption(language)
      await expect(page.getByText(labels[language].disabled, { exact: true })).toBeVisible()
      await expect(
        page.getByRole('button', { name: labels[language].connect, exact: true }),
      ).toBeDisabled()
      expect(await zoomApp.state()).toMatchObject({
        connections: 0,
        secrets: 0,
        attempts: 0,
        calendars: 0,
      })
      await context.clearCookies()
      let privateRequests = 0,
        conferenceChunks = 0
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname
        if (
          path === '/api/v1/me' ||
          path.startsWith('/api/auth/get-session') ||
          path === '/api/v1/profile' ||
          path.startsWith('/api/v1/conference-connections')
        )
          privateRequests++
        if (/\/Conferences-[^/]*\.js$/.test(path)) conferenceChunks++
      })
      await page.goto(`${zoomApp.url}/zoom-fixture/call`)
      await expect(page.getByRole('heading', { name: 'Synthetic call' })).toBeVisible()
      expect(
        privateRequests,
        'Public booking must not request a private session or Zoom connections',
      ).toBe(0)
      expect(conferenceChunks, 'Public booking must not load the conference admin chunk').toBe(0)
    })
})

test.describe('Zoom explicit meeting authorization', () => {
  test.use({ zoomMeetingsEnabled: true })
  for (const language of ['en', 'zh-CN'] as const)
    test(`Zoom ${language}: explicit upgrade, wrong-mode retirement and saved-mode reconnect`, async ({
      page,
      zoomApp,
    }) => {
      const text = labels[language],
        meeting = language === 'en' ? 'Authorize Zoom meetings' : '授权 Zoom 会议',
        identity = language === 'en' ? 'Identity only' : '仅身份访问',
        permission = language === 'en' ? 'Meeting permissions' : '会议权限'
      await page.goto(`${zoomApp.url}/app/conferences`)
      await page.getByRole('combobox', { name: 'Interface language' }).selectOption(language)
      await page.getByRole('button', { name: text.connect, exact: true }).click()
      await expect(page.getByText(text.connected, { exact: true })).toBeVisible()
      await expect(page.getByText(identity, { exact: true })).toBeVisible()
      expect(await zoomApp.state()).toMatchObject({
        connections: 1,
        identityConnections: 1,
        meetingConnections: 0,
        calendars: 0,
      })
      await page
        .locator('article.conference-account')
        .getByRole('button', { name: meeting, exact: true })
        .click()
      await expect(page.getByText(permission, { exact: true })).toBeVisible()
      expect(await zoomApp.state()).toMatchObject({
        connections: 1,
        identityConnections: 0,
        meetingConnections: 1,
        secrets: 1,
        attempts: 0,
        calendars: 0,
      })
      await page.getByRole('button', { name: text.connect, exact: true }).click()
      await expect(
        page
          .getByRole('status')
          .filter({
            hasText:
              language === 'en'
                ? 'Identity-only authorization cannot replace meeting permissions'
                : '仅身份授权不能替换会议权限',
          })
          .first(),
      ).toBeVisible()
      await expect(page.getByRole('button', { name: text.refresh, exact: true })).toBeDisabled()
      expect(await zoomApp.state()).toMatchObject({
        connections: 1,
        meetingConnections: 1,
        active: 0,
        secrets: 0,
        attempts: 0,
      })
      await page.getByRole('button', { name: text.reconnect, exact: true }).click()
      await expect(page.getByText(text.connected, { exact: true })).toBeVisible()
      await expect(page.getByText(permission, { exact: true })).toBeVisible()
      expect(await zoomApp.state()).toMatchObject({
        connections: 1,
        meetingConnections: 1,
        active: 1,
        secrets: 1,
        attempts: 0,
      })
      await page.getByRole('button', { name: text.disconnect, exact: true }).click()
      await page
        .getByRole('group')
        .getByRole('button', { name: text.disconnect, exact: true })
        .click()
      await expect(page.getByText(text.disconnected, { exact: true })).toBeVisible()
      await page.getByRole('button', { name: text.connect, exact: true }).click()
      await expect(page.getByText(identity, { exact: true })).toBeVisible()
      expect(await zoomApp.state()).toMatchObject({
        connections: 1,
        identityConnections: 1,
        meetingConnections: 0,
        active: 1,
        secrets: 1,
      })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true)
    })
})
