import type { Page } from '@playwright/test'
import { runCli } from '../../cli/src/cli.ts'
import { a11yFindings, scanA11y } from '../a11y.ts'
import { AUDIT_DESCRIPTION, AUDIT_TEAM_NAME, AUDIT_TITLE } from '../audit-data.ts'
import {
  DISABLED_TEAM_DIRECTORY_SLUG,
  EMPTY_TEAM_DIRECTORY_SLUG,
  expect,
  fillInvitee,
  pickSlot,
  TEAM_DIRECTORY_SLUG,
  test,
} from '../fixtures.ts'
import { measureKeyboard, measureLayout } from '../layout.ts'
import { selectPublicLanguage } from '../public-language.ts'

test.use({ teamPublicHome: true })

const homePath = `/team/${TEAM_DIRECTORY_SLUG}`
const apiPath = `/api/v1/public/teams/${TEAM_DIRECTORY_SLUG}`
const unavailableTeam = { error: 'team_not_found', message: 'No such team booking page' }
const listedEvents = [
  {
    slug: 'public-event',
    title: AUDIT_TITLE,
    description: AUDIT_DESCRIPTION,
    durationMinutes: 30,
    location: null,
  },
  {
    slug: 'public-round-robin',
    title: 'Public round-robin fixture event',
    description: null,
    durationMinutes: 30,
    location: null,
  },
]

async function visitWithResponse(page: Page, url: string, view: string, api: string) {
  const [response] = await Promise.all([page.waitForResponse(url + api), page.goto(url + view)])
  return response
}

function expectPrivateValuesAbsent(
  privateValues: readonly string[],
  content: string,
  surface: string,
) {
  expect(
    privateValues.some((value) => content.includes(value)),
    `${surface} excludes private fixture values`,
  ).toBe(false)
}

async function confirmBooking(page: Page, url: string) {
  await pickSlot(page, page)
  await fillInvitee(page)
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) => response.url() === url && response.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Confirm booking' }).click(),
  ])
  expect(response.status()).toBe(201)
  await expect(page.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
}

test('the visit exposes only public directory data and every listed link completes a booking', async ({
  page,
  app,
}) => {
  const { teamDirectory } = app
  if (!teamDirectory) throw new Error('Team directory fixtures are required')
  const response = await visitWithResponse(page, app.url, homePath, apiPath)
  expect(response.status()).toBe(200)
  expect(response.headers()['cache-control']).toBe('no-store')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 1, name: AUDIT_TEAM_NAME })).toBeVisible()
  const body = await response.text()
  expectPrivateValuesAbsent(teamDirectory.privateValues, body, 'Directory API')
  const directoryHtml = await page.content()
  expectPrivateValuesAbsent(teamDirectory.privateValues, directoryHtml, 'Directory DOM')
  const directory = {
    team: { name: AUDIT_TEAM_NAME, slug: TEAM_DIRECTORY_SLUG },
    eventTypes: listedEvents,
  }
  expect(JSON.parse(body)).toEqual(directory)
  for (const slug of [
    'unlisted-event',
    'one-time-event',
    'route-target',
    'inactive-event',
    'deleted-event',
  ])
    expect(directoryHtml.includes(slug), `Directory DOM omits ${slug}`).toBe(false)

  const key = await app.createReadApiKey()
  const privateValues = [...teamDirectory.privateValues, key]
  const args = { handle: TEAM_DIRECTORY_SLUG }
  const mcp = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_public_team', arguments: args },
    }),
  })
  expect(mcp.status).toBe(200)
  const rawMcp = await mcp.text()
  expectPrivateValuesAbsent(privateValues, rawMcp, 'MCP output')
  const data = rawMcp.split('\n').find((line) => line.startsWith('data: '))
  const { result } = JSON.parse(data ? data.slice(6) : rawMcp)
  expect(result.isError).toBeFalsy()
  expect(result.structuredContent).toEqual(directory)
  expect(result.content).toHaveLength(1)
  expect(JSON.parse(result.content[0].text)).toEqual(directory)

  let stdout = ''
  let stderr = ''
  const exit = await runCli({
    argv: ['team-home', '--input', '-'],
    env: { HOURMERE_URL: app.url, HOURMERE_API_KEY: key },
    stdin: (async function* () {
      yield JSON.stringify(args)
    })(),
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  })
  expectPrivateValuesAbsent(privateValues, stdout + stderr, 'CLI output')
  expect(exit).toBe(0)
  expect(stderr).toBe('')
  expect(JSON.parse(stdout)).toEqual(directory)
  const links = main.getByRole('link')
  await expect(links).toHaveCount(listedEvents.length)
  expect(
    await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href'))),
  ).toEqual(listedEvents.map(({ slug }) => `${homePath}/${slug}`))

  for (const event of listedEvents) {
    const [bookingPage] = await Promise.all([
      page.waitForResponse(`${app.url}${apiPath}/${event.slug}`),
      main.getByRole('link', { name: new RegExp(event.title, 'u') }).click(),
    ])
    expect(bookingPage.status()).toBe(200)
    expectPrivateValuesAbsent(
      teamDirectory.privateValues,
      await bookingPage.text(),
      'Booking page API',
    )
    await expect(page).toHaveURL(`${app.url}${homePath}/${event.slug}`)
    await expect(main.getByRole('heading', { name: event.title, exact: true })).toBeVisible()
    expectPrivateValuesAbsent(teamDirectory.privateValues, await page.content(), 'Booking page DOM')
    await confirmBooking(page, `${app.url}${apiPath}/${event.slug}/bookings`)
    await page.goto(app.url + homePath)
  }
  expect(await app.rows()).toEqual([
    { source: 'web', status: 'confirmed' },
    { source: 'web', status: 'confirmed' },
  ])
})

test('omitted events preserve their existing direct booking boundaries', async ({ page, app }) => {
  const { teamDirectory } = app
  if (!teamDirectory) throw new Error('Team directory fixtures are required')
  const main = page.getByRole('main')
  // Holding a regular link continues to allow access to a hidden event, even when
  // the host also shares it through a one-time link or a routing form.
  for (const [slug, title] of [
    ['unlisted-event', 'Unlisted fixture event'],
    ['one-time-event', 'One-time fixture event'],
    ['route-target', 'Hidden routing fixture event'],
  ] as const) {
    const response = await visitWithResponse(
      page,
      app.url,
      `${homePath}/${slug}`,
      `${apiPath}/${slug}`,
    )
    expect(response.status()).toBe(200)
    const body = await response.text()
    expectPrivateValuesAbsent(teamDirectory.privateValues, body, 'Direct booking page API')
    expect(JSON.parse(body)).toMatchObject({ slug, title })
    await expect(main.getByRole('heading', { name: title, exact: true })).toBeVisible()
    expectPrivateValuesAbsent(
      teamDirectory.privateValues,
      await page.content(),
      'Direct booking page DOM',
    )
    if (slug === 'unlisted-event')
      await confirmBooking(page, `${app.url}${apiPath}/${slug}/bookings`)
  }
  for (const slug of ['inactive-event', 'deleted-event', 'unknown-event']) {
    const response = await visitWithResponse(
      page,
      app.url,
      `${homePath}/${slug}`,
      `${apiPath}/${slug}`,
    )
    expect(response.status()).toBe(404)
    expect(await response.json()).toEqual({
      error: 'event_type_not_found',
      message: 'No such event type',
    })
    await expect(
      main.getByRole('heading', { name: 'This booking page doesn’t exist', exact: true }),
    ).toBeVisible()
  }
  const missingLink = await page.request.get(`${app.url}/api/v1/book/${'x'.repeat(43)}`)
  expect(missingLink.status()).toBe(404)
  expect(await missingLink.json()).toHaveProperty('error', 'one_time_link_not_found')
  const disabledPath = `/team/${DISABLED_TEAM_DIRECTORY_SLUG}/direct-event`
  const disabledApi = `/api/v1/public/teams/${DISABLED_TEAM_DIRECTORY_SLUG}/direct-event`
  await page.goto(app.url + disabledPath)
  await expect(
    main.getByRole('heading', { name: 'Direct fixture event', exact: true }),
  ).toBeVisible()
  await confirmBooking(page, `${app.url}${disabledApi}/bookings`)
  expect(await app.rows()).toEqual([
    { source: 'web', status: 'confirmed' },
    { source: 'web', status: 'confirmed' },
  ])
})

test('publication follows a renamed SSO-enforced team and cannot transfer to a reused slug', async ({
  page,
  app,
}) => {
  if (!app.teamDirectory) throw new Error('Team directory fixtures are required')
  const main = page.getByRole('main')
  await page.goto(app.url + homePath)
  await expect(main.getByRole('heading', { level: 1, name: AUDIT_TEAM_NAME })).toBeVisible()

  const newSlug = 'RenamedDirectory'
  const newPath = `/team/${newSlug}`
  const newApi = `/api/v1/public/teams/${newSlug}`
  await app.teamDirectory.rename(newSlug)
  const previous = await visitWithResponse(page, app.url, homePath, apiPath)
  expect(previous.status()).toBe(404)
  expect(await previous.json()).toEqual(unavailableTeam)
  await expect(main).toHaveText('This team page is unavailable.')
  const previousEvent = await visitWithResponse(
    page,
    app.url,
    `${homePath}/public-event`,
    `${apiPath}/public-event`,
  )
  expect(previousEvent.status()).toBe(404)
  await expect(
    main.getByRole('heading', { name: 'This booking page doesn’t exist', exact: true }),
  ).toBeVisible()

  await app.teamDirectory.reusePreviousSlug()
  const reused = await visitWithResponse(page, app.url, homePath, apiPath)
  expect(reused.status()).toBe(404)
  expect(await reused.json()).toEqual(unavailableTeam)
  await expect(main).toHaveText('This team page is unavailable.')
  const reusedDirect = await visitWithResponse(
    page,
    app.url,
    `${homePath}/direct-event`,
    `${apiPath}/direct-event`,
  )
  expect(reusedDirect.status()).toBe(200)
  await expect(
    main.getByRole('heading', { name: 'Direct fixture event', exact: true }),
  ).toBeVisible()

  await app.teamDirectory.enforceSso()
  const current = await visitWithResponse(page, app.url, newPath, newApi)
  expect(current.status()).toBe(200)
  expect(await current.json()).toEqual({
    team: { name: AUDIT_TEAM_NAME, slug: newSlug },
    eventTypes: listedEvents,
  })
  await expect(main.getByText(app.url + newPath, { exact: true })).toBeVisible()
  const primary = main.getByRole('link', { name: new RegExp(AUDIT_TITLE, 'u') })
  await expect(primary).toHaveAttribute('href', `${newPath}/public-event`)
  await primary.click()
  await expect(page).toHaveURL(`${app.url}${newPath}/public-event`)
  await confirmBooking(page, `${app.url}${newApi}/public-event/bookings`)
  expect(await app.rows()).toEqual([{ source: 'web', status: 'confirmed' }])
})

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
    expect(response.headers()['cache-control']).toBe('no-store')
    expect(await response.json()).toEqual(unavailableTeam)
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
