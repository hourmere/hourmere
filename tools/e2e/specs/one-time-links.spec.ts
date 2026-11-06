import type { BrowserContext, Page } from '@playwright/test'
import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'

const copy = {
  en: {
    edit: 'Edit Fixture call',
    manage: 'Manage one-time links',
    create: 'Create one-time link',
    name: /^Prefilled invitee name/,
    dialog: 'Copy your one-time link',
    url: 'One-time booking URL',
    copy: 'Copy one-time link',
    copied: 'Copied',
    forget: 'Close and forget URL',
    confirm: 'Confirm booking',
    booked: 'You’re booked',
    unavailable: 'This booking link is unavailable',
    contact: 'Contact the host for a new booking link.',
    used: 'Used',
    revoked: 'Revoked',
    revoke: /^Revoke one-time link /,
    revokePrompt: 'Revoke this one-time link? It will stop accepting new bookings.',
    revokeConfirm: 'Revoke link',
  },
  'zh-CN': {
    edit: '编辑 Fixture call',
    manage: '管理一次性链接',
    create: '创建一次性链接',
    name: /^预填受邀人姓名/,
    dialog: '复制你的一次性链接',
    url: '一次性预约网址',
    copy: '复制一次性链接',
    copied: '已复制',
    forget: '关闭并清除网址',
    confirm: '确认预约',
    booked: '预约成功',
    unavailable: '此预约链接不可用',
    contact: '请联系主持人，获取新的预约链接。',
    used: '已使用',
    revoked: '已撤销',
    revoke: /^撤销一次性链接/,
    revokePrompt: '撤销此一次性链接？撤销后将不再接受新预约。',
    revokeConfirm: '撤销链接',
  },
} as const

async function openPrivateLink(page: Page, url: string) {
  try {
    await page.goto(url)
  } catch {
    // Playwright navigation errors can otherwise include the capability path.
    throw new Error('Could not open the synthetic one-time booking page')
  }
}

async function urlIsAbsent(page: Page, url: string) {
  return page.evaluate(
    (privateUrl) =>
      !document.body.textContent?.includes(privateUrl) &&
      [...document.querySelectorAll<HTMLInputElement>('input')].every(
        (input) => !input.value.includes(privateUrl),
      ) &&
      [...document.querySelectorAll<HTMLAnchorElement>('a')].every(
        (link) => !link.href.includes(privateUrl),
      ),
    url,
  )
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`${locale}: editor one-time links copy once, allow one concurrent invitee, and revoke neutrally`, async ({
    page: host,
    context,
    browser,
    app,
  }, testInfo) => {
    const text = copy[locale]
    await app.auditSignIn(true, locale)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.url })
    await host.addInitScript(() => {
      const write = navigator.clipboard.writeText.bind(navigator.clipboard)
      let copied = ''
      navigator.clipboard.writeText = async (value) => {
        await write(value)
        copied = value
      }
      Object.defineProperty(window, 'takeOneTimeClipboardCopy', {
        value: async () => {
          const value = copied
          copied = ''
          await write('')
          return value
        },
      })
    })
    await host.goto(`${app.url}/app/event-types`)
    await host
      .getByRole('combobox', { name: /^(Interface language|界面语言)$/ })
      .selectOption(locale)
    await host.getByRole('link', { name: text.edit, exact: true }).click()
    const manager = host.getByRole('region', {
      name: locale === 'en' ? 'One-time links' : '一次性链接',
      exact: true,
    })
    await manager.getByRole('button', { name: text.manage, exact: true }).click()

    async function createAndCopy(name: string) {
      await manager.getByLabel(text.name).fill(name)
      const creating = host.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.endsWith('/one-time-links'),
      )
      await manager.getByRole('button', { name: text.create, exact: true }).click()
      expect((await creating).status()).toBe(201)
      const dialog = host.getByRole('dialog', { name: text.dialog, exact: true })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: text.copy, exact: true }).click()
      await expect(dialog.locator('.copy-status')).toHaveText(text.copied)
      // Remember this page's successful native write, since the OS clipboard is
      // shared by concurrent Playwright workers. Taking it clears both copies.
      const url = await host.evaluate(() =>
        (
          window as unknown as { takeOneTimeClipboardCopy: () => Promise<string> }
        ).takeOneTimeClipboardCopy(),
      )
      let ownedUrl = false
      try {
        const parsed = new URL(url)
        ownedUrl = parsed.origin === app.url && /^\/book\/[A-Za-z0-9_-]{43}$/.test(parsed.pathname)
      } catch {
        throw new Error('The copied one-time booking URL is malformed')
      }
      expect(ownedUrl, 'The copied value is an owned one-time booking URL').toBe(true)
      expect((await dialog.getByLabel(text.url, { exact: true }).inputValue()) === url).toBe(true)
      await dialog.getByRole('button', { name: text.forget, exact: true }).click()
      await expect(dialog).toHaveCount(0)
      expect(await urlIsAbsent(host, url), 'Closing forgets the shown-once URL').toBe(true)
      await expect(manager.getByRole('button', { name: text.copy, exact: true })).toHaveCount(0)
      return url
    }

    const usedName = 'Concurrent one-time invitee'
    const url = await createAndCopy(usedName)
    await host.reload()
    await manager.getByRole('button', { name: text.manage, exact: true }).click()
    await expect(
      manager.locator('.one-time-links-list > li').filter({ hasText: usedName }),
    ).toBeVisible()
    expect(await urlIsAbsent(host, url), 'Reloading never recovers the URL from history').toBe(true)
    await expect(manager.getByRole('button', { name: text.copy, exact: true })).toHaveCount(0)

    const invitees: BrowserContext[] = []
    let externalRequests = 0
    let release: (() => void) | undefined
    try {
      for (let index = 0; index < 2; index++) {
        const invitee = await browser.newContext({
          viewport: host.viewportSize(),
          isMobile: testInfo.project.name === 'mobile',
          hasTouch: testInfo.project.name === 'mobile',
          locale: locale === 'zh-CN' ? 'zh-CN' : 'en-US',
          timezoneId: 'UTC',
          serviceWorkers: 'block',
        })
        invitees.push(invitee)
        await invitee.route('**/*', async (route) => {
          if (new URL(route.request().url()).origin === app.url) await route.continue()
          else {
            externalRequests++
            await route.abort('blockedbyclient')
          }
        })
        await invitee.addInitScript(
          (language) => localStorage.setItem('hourmere-language', language),
          locale,
        )
      }
      const pages = await Promise.all(invitees.map((invitee) => invitee.newPage()))
      for (const invitee of pages) {
        await openPrivateLink(invitee, url)
        await pickSlot(invitee, invitee)
        await fillInvitee(invitee)
      }

      // Both browsers hold valid forms before either request is allowed to reach
      // the real server. Only transport timing is controlled; responses are real.
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let arrived = 0
      for (const invitee of pages) {
        await invitee.route('**/api/v1/book/*/bookings', async (route) => {
          arrived++
          if (arrived === 2) release?.()
          await gate
          await route.continue()
        })
      }
      const results = pages.map((invitee) =>
        invitee.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            /^\/api\/v1\/book\/[^/]+\/bookings$/.test(new URL(response.url()).pathname),
        ),
      )
      await Promise.all(
        pages.map((invitee) =>
          invitee.getByRole('button', { name: text.confirm, exact: true }).click(),
        ),
      )
      const responses = await Promise.all(results)
      expect(arrived, 'Both isolated browsers submitted concurrently').toBe(2)
      expect(responses.map((response) => response.status()).sort()).toEqual([201, 404])
      let neutral = ''
      for (const [index, response] of responses.entries()) {
        const invitee = pages[index]
        if (!invitee) throw new Error('Missing isolated invitee browser')
        if (response.status() === 201) {
          await expect(
            invitee.getByRole('heading', { name: text.booked, exact: true }),
          ).toBeVisible()
        } else {
          expect(((await response.json()) as { error: string }).error).toBe(
            'one_time_link_not_found',
          )
          await expect(
            invitee.getByRole('heading', { name: text.unavailable, exact: true }),
          ).toBeVisible()
          await expect(invitee.getByText(text.contact, { exact: true })).toBeVisible()
          await expect(invitee.locator('.calendar-month, form')).toHaveCount(0)
          neutral = (await invitee.locator('.public-card').textContent()) ?? ''
        }
      }
      expect(await app.rows()).toEqual([{ source: 'web', status: 'confirmed' }])

      await host.reload()
      await manager.getByRole('button', { name: text.manage, exact: true }).click()
      const used = manager.locator('.one-time-links-list > li').filter({ hasText: usedName })
      await expect(used.locator('.badge')).toHaveText(text.used)
      await expect(used.getByRole('button', { name: text.revoke })).toHaveCount(0)
      expect(await urlIsAbsent(host, url)).toBe(true)

      const revokedName = 'Revoked one-time invitee'
      const revokedUrl = await createAndCopy(revokedName)
      const revoked = manager.locator('.one-time-links-list > li').filter({ hasText: revokedName })
      await revoked.getByRole('button', { name: text.revoke }).click()
      const confirmation = revoked.getByRole('group', { name: text.revokePrompt, exact: true })
      const revoking = host.waitForResponse(
        (response) =>
          response.request().method() === 'DELETE' &&
          /\/one-time-links\/[^/]+$/.test(new URL(response.url()).pathname),
      )
      await confirmation.getByRole('button', { name: text.revokeConfirm, exact: true }).click()
      expect((await revoking).status()).toBe(200)
      await expect(revoked.locator('.badge')).toHaveText(text.revoked)
      const retry = pages[0]
      if (!retry) throw new Error('Missing isolated invitee browser')
      for (const privateUrl of [url, revokedUrl]) {
        await openPrivateLink(retry, privateUrl)
        await expect(
          retry.getByRole('heading', { name: text.unavailable, exact: true }),
        ).toBeVisible()
        await expect(retry.getByText(text.contact, { exact: true })).toBeVisible()
        await expect(retry.locator('.calendar-month, form')).toHaveCount(0)
        expect(
          (await retry.locator('.public-card').textContent()) === neutral,
          'Used and revoked links show the same neutral page',
        ).toBe(true)
      }
      expect(await app.rows()).toEqual([{ source: 'web', status: 'confirmed' }])
      expect(externalRequests, 'Isolated invitee browsers make no external requests').toBe(0)
    } finally {
      release?.()
      await Promise.all(invitees.map((invitee) => invitee.close()))
    }
  })
}
