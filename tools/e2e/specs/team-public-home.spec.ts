import { a11yFindings, scanA11y } from '../a11y.ts'
import { AUDIT_TEAM_NAME, AUDIT_TITLE } from '../audit-data.ts'
import {
  DISABLED_TEAM_DIRECTORY_SLUG,
  EMPTY_TEAM_DIRECTORY_SLUG,
  expect,
  TEAM_DIRECTORY_SLUG,
  test,
} from '../fixtures.ts'
import { measureKeyboard, measureLayout } from '../layout.ts'
import { selectPublicLanguage } from '../public-language.ts'

test.use({ teamPublicHome: true })

const homePath = `/team/${TEAM_DIRECTORY_SLUG}`

test('the team directory reflows and opens booking by keyboard in both public languages and themes', async ({
  page,
  app,
}, testInfo) => {
  // 320 CSS pixels is the reflow baseline. The desktop project checks the shared
  // public column's readable width instead of relying on font-dependent snapshots.
  if (testInfo.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 568 })
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('Team directory checks require a CSS viewport')
  const main = page.getByRole('main')
  await page.goto(app.url + homePath)
  await expect(main.getByRole('heading', { level: 1, name: AUDIT_TEAM_NAME })).toBeVisible()
  await expect(main.getByText(app.url + homePath, { exact: true })).toBeVisible()
  const event = main.getByRole('link', { name: new RegExp(AUDIT_TITLE, 'u') })
  await expect(event).toHaveAttribute('href', `${homePath}/public-event`)
  await expect(main.getByRole('link', { name: /Unlisted fixture event/ })).toHaveCount(0)

  for (const language of ['en', 'zh-CN'] as const) {
    if (language === 'zh-CN') await selectPublicLanguage(page, language)
    await expect(page.locator('html')).toHaveAttribute('lang', language)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      const variant = `${viewport.width}px ${language} ${colorScheme}`
      expect(await page.evaluate(measureLayout, viewport), variant).toEqual([])
      expect(await measureKeyboard(page), variant).toEqual([])
      const scan = await scanA11y(page)
      expect(a11yFindings('team-public-home', scan.violations, []).findings, variant).toEqual([])
    }
  }
  expect((await main.boundingBox())?.width).toBeLessThanOrEqual(720)
  await event.focus()
  await expect(event).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(`${app.url}${homePath}/public-event`)
  await expect(page.getByRole('heading', { name: AUDIT_TITLE, exact: true })).toBeVisible()
  await page.goto(`${app.url}${homePath}/unlisted-event`)
  await expect(
    page.getByRole('heading', { name: 'Unlisted fixture event', exact: true }),
  ).toBeVisible()
})

test('empty, unavailable and retry states preserve the directory visibility boundary', async ({
  page,
  app,
}) => {
  const main = page.getByRole('main')
  const emptyPath = `/team/${EMPTY_TEAM_DIRECTORY_SLUG}`
  await page.goto(app.url + emptyPath)
  await expect(
    main.getByRole('heading', { level: 1, name: EMPTY_TEAM_DIRECTORY_SLUG }),
  ).toBeVisible()
  await expect(main.getByText(app.url + emptyPath, { exact: true })).toBeVisible()
  await expect(main.getByText('This team has no public events right now.')).toBeVisible()
  await selectPublicLanguage(page, 'zh-CN')
  await expect(main.getByText('此团队目前没有公开活动。')).toBeVisible()
  await selectPublicLanguage(page, 'en')

  for (const slug of [
    DISABLED_TEAM_DIRECTORY_SLUG,
    'UnknownDirectory',
    TEAM_DIRECTORY_SLUG.toLowerCase(),
  ]) {
    const [response] = await Promise.all([
      page.waitForResponse(`${app.url}/api/v1/public/teams/${slug}`),
      page.goto(`${app.url}/team/${slug}`),
    ])
    expect(response.status()).toBe(404)
    await expect(main).toHaveText('This team page is unavailable.')
    await expect(main.getByRole('link')).toHaveCount(0)
  }
  await page.goto(`${app.url}/team/${DISABLED_TEAM_DIRECTORY_SLUG}/direct-event`)
  await expect(
    page.getByRole('heading', { name: 'Direct fixture event', exact: true }),
  ).toBeVisible()

  const intercepted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await page.route(
    `${app.url}/api/v1/public/teams/${TEAM_DIRECTORY_SLUG}`,
    async (route) => {
      intercepted.resolve()
      await release.promise
      await route.fulfill({
        status: 503,
        json: { error: 'fixture_failure', message: 'Fixture error detail' },
      })
    },
    { times: 1 },
  )
  try {
    await page.goto(app.url + homePath)
    await intercepted.promise
    await expect(main.getByRole('status')).toHaveText('Loading…')
  } finally {
    release.resolve()
  }
  await expect(main.getByRole('heading', { name: 'Couldn’t load this team page.' })).toBeVisible()
  await expect(main.getByText('Fixture error detail')).toHaveCount(0)
  await expect(main.getByText(app.url + homePath, { exact: true })).toHaveCount(0)
  await main.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(main.getByRole('heading', { level: 1, name: AUDIT_TEAM_NAME })).toBeVisible()
})
