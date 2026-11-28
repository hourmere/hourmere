import type { Page, Response } from '@playwright/test'
import { scanA11y } from '../a11y.ts'
import { expect, test } from '../departure-handoff-fixtures.ts'

const offerPath = '/booking/handoff'
const readPath = '/api/v1/booking-handoffs/offer'
const answerPath = '/api/v1/booking-handoffs/answer'

const labels = {
  en: {
    review: 'Review booking handoff',
    current: 'Current booking',
    proposed: 'Proposed booking',
    answers: 'Answers shared with the new host',
    accept: 'Accept',
    decline: 'Decline',
    submit: 'Submit decision',
    accepted: 'Acceptance recorded',
    declined: 'Decline recorded',
    unavailable: 'This handoff link is unavailable',
  },
  'zh-CN': {
    review: '查看预约交接提议',
    current: '当前预约',
    proposed: '拟议预约',
    answers: '将与新主持人共享的回答',
    accept: '接受',
    decline: '拒绝',
    submit: '提交决定',
    accepted: '已记录接受',
    declined: '已记录拒绝',
    unavailable: '此交接链接不可用',
  },
}

function fragmentToken(link: URL) {
  return new URLSearchParams(link.hash.slice(1)).get('token') ?? ''
}

function expectPrivateHeaders(response: Response) {
  expect(response.headers()['referrer-policy']).toBe('no-referrer')
  expect(response.headers()['cache-control']).toContain('no-store')
}

async function openParticipantLink(page: Page, link: URL) {
  await page.goto('about:blank')
  const pageResponse = page.waitForResponse(
    (response) =>
      response.request().isNavigationRequest() && new URL(response.url()).pathname === offerPath,
  )
  const read = page.waitForResponse((response) => new URL(response.url()).pathname === readPath)
  // Keep the full mail link out of Playwright navigation and assertion diagnostics.
  await page.evaluate((href) => {
    window.setTimeout(() => window.location.replace(href), 0)
  }, link.href)
  const navigation = await pageResponse
  expect(navigation.status()).toBe(200)
  expectPrivateHeaders(navigation)
  const response = await read
  expect(response.request().method()).toBe('POST')
  expectPrivateHeaders(response)
  expect(new URL(page.url()).hash === '').toBe(true)
  await expect(page.locator('html')).toHaveAttribute('data-fragment-cleared-before-read', 'true')
  return response
}

test.use({ viewport: { width: 320, height: 844 } })

test('a private handoff link shows only that participant’s terms and records an explicit decision', async ({
  handoff,
  page,
}, testInfo) => {
  const locale = testInfo.project.name === 'mobile' ? 'zh-CN' : 'en'
  const copy = labels[locale]
  await page.emulateMedia({ colorScheme: locale === 'zh-CN' ? 'dark' : 'light' })
  await page.addInitScript(
    ({ language, path }) => {
      Object.defineProperty(navigator, 'languages', { value: [language] })
      const fetch = window.fetch.bind(window)
      window.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input, location.href)
        if (url.pathname === path)
          document.documentElement.dataset.fragmentClearedBeforeRead = String(!location.hash)
        return fetch(input, init)
      }
    },
    { language: locale, path: readPath },
  )

  const links = await handoff.participantLinks()
  expect(
    Object.values(links).every(
      (link) =>
        link.origin === handoff.url &&
        link.pathname === offerPath &&
        !link.search &&
        /^#token=[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(link.hash),
    ),
    'The mail provides an opaque link with its capability confined to the fragment',
  ).toBe(true)
  const capabilities = Object.values(links).flatMap((link) => {
    const token = fragmentToken(link)
    return [token, ...token.split('.')]
  })

  let answerRequests = 0
  let leakedCapability = false
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === answerPath) answerRequests++
    leakedCapability ||= capabilities.some(
      (value) => request.url().includes(value) || request.headers().referer?.includes(value),
    )
  })

  const main = page.getByRole('main')
  const heading = (name: string) => main.getByRole('heading', { level: 1, name })
  const submit = main.getByRole('button', { name: copy.submit })
  const answer = async (decision: 'accept' | 'decline', link: URL) => {
    const pending = page.waitForResponse(
      (response) => new URL(response.url()).pathname === answerPath,
    )
    await submit.press('Enter')
    const response = await pending
    expect(response.status()).toBe(200)
    expectPrivateHeaders(response)
    const body = response.request().postDataJSON()
    expect(body?.token === fragmentToken(link)).toBe(true)
    expect(body?.version).toBe(1)
    expect(body?.decision).toBe(decision)
    await expect(heading(decision === 'accept' ? copy.accepted : copy.declined)).toBeVisible()
  }

  const booker = await openParticipantLink(page, links.booker)
  expect(booker.status()).toBe(200)
  await expect(heading(copy.review)).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  for (const name of [copy.current, copy.proposed, copy.answers])
    await expect(main.getByRole('heading', { level: 2, name })).toBeVisible()
  await expect(main.getByText('Approved answer', { exact: true })).toBeVisible()
  await expect(main.getByText('Departing host', { exact: true })).toBeVisible()
  await expect(main.getByText('Replacement host', { exact: true })).toBeVisible()
  const bookerTerms = await booker.text()
  expect(
    [...Object.values(handoff.emails), 'Private Guest', ...capabilities].some((value) =>
      bookerTerms.includes(value),
    ),
  ).toBe(false)
  expect(
    await page.evaluate(() => innerWidth === 320 && document.documentElement.scrollWidth <= 320),
  ).toBe(true)
  const axe = await scanA11y(page)
  expect(
    axe.violations.filter(({ impact }) => impact === 'critical' || impact === 'serious'),
  ).toEqual([])

  const accept = main.getByRole('radio', { name: copy.accept, exact: true })
  const decline = main.getByRole('radio', { name: copy.decline, exact: true })
  await expect(accept).not.toBeChecked()
  await expect(decline).not.toBeChecked()
  await expect(submit).toBeDisabled()
  await accept.press('Space')
  await expect(accept).toBeChecked()
  expect(answerRequests).toBe(0)
  expect(await handoff.participantDecisions()).toEqual({ booker: null, guest: null })
  await answer('accept', links.booker)
  expect(await handoff.participantDecisions()).toEqual({ booker: 'approved', guest: null })

  const used = await openParticipantLink(page, links.booker)
  expect(used.status()).toBe(404)
  await expect(heading(copy.unavailable)).toBeVisible()
  await expect(submit).toHaveCount(0)

  const guest = await openParticipantLink(page, links.guest)
  expect(guest.status()).toBe(200)
  await expect(heading(copy.review)).toBeVisible()
  await expect(main.getByRole('heading', { level: 2, name: copy.answers })).toHaveCount(0)
  await expect(main.getByText('Approved answer', { exact: true })).toHaveCount(0)
  const guestTerms = await guest.text()
  expect(
    [...Object.values(handoff.emails), 'Approved answer', 'Private Booker', ...capabilities].some(
      (value) => guestTerms.includes(value),
    ),
  ).toBe(false)
  await accept.focus()
  await page.keyboard.press('ArrowDown')
  await expect(decline).toBeFocused()
  await expect(decline).toBeChecked()
  await page.keyboard.press('Tab')
  await expect(submit).toBeFocused()
  await answer('decline', links.guest)
  expect(answerRequests).toBe(2)
  expect(await handoff.participantDecisions()).toEqual({ booker: 'approved', guest: 'declined' })
  expect(await handoff.result()).toMatchObject({
    source: 'confirmed',
    bookingCount: 1,
    replacementId: undefined,
    notificationCount: 0,
  })
  const declined = await openParticipantLink(page, links.guest)
  expect(declined.status()).toBe(404)
  await expect(heading(copy.unavailable)).toBeVisible()
  await expect(submit).toHaveCount(0)
  expect(leakedCapability, 'The capability stays out of request URLs and referrers').toBe(false)
})
