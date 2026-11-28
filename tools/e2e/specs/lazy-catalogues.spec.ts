import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures.ts'

const chineseChunk = /\/assets\/locales\/zh-CN-common-[^/]+\.js(?:\?.*)?$/
const germanChunk = /\/assets\/locales\/de-common-[^/]+\.js(?:\?.*)?$/

async function chooseLanguage(page: Page, currentLabel: string, nativeName: string) {
  await page.getByRole('button', { name: currentLabel, exact: true }).click()
  await page.getByRole('menuitemradio', { name: nativeName, exact: true }).click()
}

test.describe('on-demand booking translations', () => {
  test.use({ locale: 'zh-CN' })

  test('loads the browser language and reuses chunks when switching back', async ({
    page,
    app,
  }) => {
    const requests = { chinese: 0, german: 0 }
    page.on('request', (request) => {
      if (chineseChunk.test(request.url())) requests.chinese++
      if (germanChunk.test(request.url())) requests.german++
    })
    const requested = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    await page.route(germanChunk, async (route) => {
      requested.resolve()
      await release.promise
      await route.fallback()
    })

    try {
      await page.goto(app.url + app.personalPath)
      await expect(page.getByRole('button', { name: '下个月', exact: true })).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
      expect(requests).toEqual({ chinese: 1, german: 0 })

      await chooseLanguage(page, '语言：简体中文', 'Deutsch')
      await requested.promise
      await expect(page.getByRole('button', { name: '下个月', exact: true })).toBeVisible()
      release.resolve()
      await expect(page.getByRole('button', { name: 'Nächster Monat', exact: true })).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('lang', 'de')

      await chooseLanguage(page, 'Sprache: Deutsch', '简体中文')
      await expect(page.getByRole('button', { name: '下个月', exact: true })).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
      expect(requests).toEqual({ chinese: 1, german: 1 })
    } finally {
      release.resolve()
    }
  })

  test('shows English after a chunk failure and retries the same language choice', async ({
    page,
    app,
  }) => {
    let requests = 0
    let fail = true
    await page.route(germanChunk, async (route) => {
      requests++
      if (fail) await route.abort('failed')
      else await route.fallback()
    })

    await page.goto(app.url + app.personalPath)
    await chooseLanguage(page, '语言：简体中文', 'Deutsch')
    await expect(page.getByRole('button', { name: 'Next month', exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    expect(requests).toBeGreaterThan(0)
    const failedAttempts = requests

    fail = false
    await chooseLanguage(page, 'Language: English', 'Deutsch')
    await expect(page.getByRole('button', { name: 'Nächster Monat', exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    expect(requests).toBeGreaterThan(failedAttempts)
  })
})
