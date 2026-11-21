import type { Page } from '@playwright/test'
import type { components } from '../../../apps/web/src/api/schema.d.ts'
import { common } from '../../../apps/web/src/i18n/catalogues/en/common.ts'
import { PATHS } from '../../../apps/web/src/paths.ts'
import { expect, test } from '../fixtures.ts'

const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'

async function openPollLink(page: Page, link: URL) {
  // Pass the fragment in page memory so neither navigation nor failure diagnostics
  // render the capability. The real router still consumes and removes the fragment.
  await page.goto(link.origin + link.pathname)
  await page.getByRole('heading', { level: 1 }).waitFor()
  await page.evaluate((fragment) => {
    window.location.hash = fragment
  }, link.hash)
  await page.waitForFunction(() => window.location.hash === '')
}

async function expectNarrowBallot(page: Page) {
  expect(
    await page.evaluate(() => innerWidth === 320 && document.documentElement.scrollWidth <= 320),
    'The public page fits in a 320px viewport',
  ).toBe(true)
}

test.use({ viewport: { width: 320, height: 844 } })

test('creates, verifies, votes across three zones and schedules a poll from the UI', async ({
  app,
  context,
  page,
}) => {
  await app.auditSignIn(true)
  await page.goto(app.url + PATHS.meetingPolls)
  await page.getByRole('link', { name: 'Create meeting poll', exact: true }).press('Enter')
  const create = page.getByTestId('meeting-poll-create')
  await create.locator('#poll-create-event').selectOption({ label: 'Fixture call' })

  const now = Temporal.Now.instant().toZonedDateTimeISO('UTC')
  let day = now.toPlainDate().add({ days: 3 })
  while (day.dayOfWeek > 5) day = day.add({ days: 1 })
  await create.locator('#poll-create-date').fill(day.toString())
  const times = create.locator('#poll-create-candidates')
  await times.getByRole('checkbox', { name: /3:30\s*PM.*4:00\s*PM/ }).check()
  await times.getByRole('checkbox', { name: /4:00\s*PM.*4:30\s*PM/ }).check()
  await create
    .locator('#poll-create-deadline')
    .fill(now.add({ hours: 12 }).toPlainDateTime().toString({ smallestUnit: 'minute' }))
  await create.locator('#poll-create-admission').selectOption('public_link')
  await create.getByRole('button', { name: 'Create meeting poll', exact: true }).press('Enter')

  const share = page.getByTestId('meeting-poll-public-link')
  await expect(share).toBeVisible()
  const link = URL.parse((await share.locator('[data-private]').textContent())?.trim() ?? '')
  if (!link) throw new Error('Expected a valid public poll link')
  expect(
    link.origin === app.url && link.pathname === '/poll' && !link.search && link.hash.length > 1,
    'The public link discloses its capability in the fragment only',
  ).toBe(true)
  await share.getByRole('button', { name: 'Hide voting link' }).press('Enter')
  await expect(share).toHaveCount(0)
  const hostPath = await page.getByRole('link', { name: 'Open meeting poll' }).getAttribute('href')
  if (!hostPath) throw new Error('Expected the host results path')
  expect(
    new RegExp(`^${PATHS.meetingPolls}/${uuid}\\?organizationId=${uuid}$`).test(hostPath),
    'The host results link contains only the poll and organization IDs',
  ).toBe(true)

  const anonymousRequests: { url: string; referrer: string | undefined }[] = []
  const capabilities = [link.hash.slice(1)]
  page.on('request', (request) => {
    anonymousRequests.push({ url: request.url(), referrer: request.headers().referer })
  })
  await app.auditSignIn(false)
  expect((await context.cookies()).some(({ name }) => name === 'better-auth.session_token')).toBe(
    false,
  )
  await openPollLink(page, link)
  const voterName = 'Synthetic poll booker'
  const email = 'synthetic-poll-booker@hourmere.invalid'
  await page.getByLabel(common['meetingPoll.name'], { exact: true }).fill(voterName)
  await page.getByLabel(common['meetingPoll.email'], { exact: true }).fill(email)
  await expectNarrowBallot(page)
  await page.getByRole('button', { name: common['meetingPoll.enroll'] }).press('Enter')
  await expect(page.getByRole('heading', { name: common['meetingPoll.checkEmail'] })).toBeVisible()

  const verification = await app.meetingPollVerificationLink(email)
  capabilities.push(verification.hash.slice(1))
  expect(
    verification.origin === app.url &&
      verification.pathname === '/poll/voter' &&
      !verification.search &&
      verification.hash.length > 1,
    'The verification link discloses its capability in the fragment only',
  ).toBe(true)
  await openPollLink(page, verification)
  const verified = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/v1/public/meeting-polls/verify',
  )
  await page.getByRole('button', { name: common['meetingPoll.verify'] }).press('Enter')
  const verifyResponse = await verified
  expect(verifyResponse.status()).toBe(200)
  const { votingToken } =
    (await verifyResponse.json()) as components['schemas']['MeetingPollVerification']
  if (!votingToken) throw new Error('Verification did not issue a voting capability')
  capabilities.push(votingToken)

  const ballot = page.locator('.meeting-poll')
  const options = ballot.locator('.poll-option')
  const first = options.first()
  const second = options.nth(1)
  await expect(options).toHaveCount(2)
  const choices = first.getByRole('radio')
  const conditional = first.getByRole('radio', { name: common['meetingPoll.ifNeedBe'] })
  const unavailable = second.getByRole('radio', { name: common['meetingPoll.no'], exact: true })
  const firstSlot = (await conditional.getAttribute('name'))?.replace(/^slot-/, '')
  if (!firstSlot) throw new Error('Ballot time is missing its slot identifier')
  const zone = ballot.getByRole('combobox', { name: common['meetingPoll.timeZone'] })
  await zone.selectOption('America/Los_Angeles')
  await expect(first.locator('legend')).toContainText(/GMT-0[78]:00/)
  await choices.first().focus()
  await choices.first().press('ArrowDown')
  await expect(conditional).toBeFocused()
  await expect(conditional).toBeChecked()
  await unavailable.check()

  await zone.selectOption('Asia/Shanghai')
  const monthDay = (date: Temporal.PlainDate) =>
    date.toLocaleString('en-US', { month: 'short', day: 'numeric' })
  await expect(first.locator('legend')).toContainText(monthDay(day))
  await expect(first.locator('legend')).toContainText(monthDay(day.add({ days: 1 })))
  await expect(first.locator('legend')).toContainText('GMT+08:00')
  await expect(conditional).toBeChecked()
  await expect(unavailable).toBeChecked()

  await zone.selectOption('Europe/London')
  const londonOffset = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/London',
    timeZoneName: 'longOffset',
  })
    .formatToParts(new Date(`${day}T15:30:00Z`))
    .find(({ type }) => type === 'timeZoneName')?.value
  await expect
    .poll(async () =>
      (await first.locator('legend').textContent())?.match(/\bGMT(?:[+-]\d{2}:\d{2})?/g),
    )
    .toEqual([londonOffset, londonOffset])
  await expect(first.locator('legend')).toContainText(monthDay(day))
  await expect(first.locator('legend')).not.toContainText(monthDay(day.add({ days: 1 })))
  await expect(conditional).toBeChecked()
  await expect(unavailable).toBeChecked()
  await expectNarrowBallot(page)
  expect(
    await choices.evaluateAll((inputs) => {
      const tops = inputs.map((input) => input.getBoundingClientRect().top)
      const [first, second, third] = tops
      return (
        first !== undefined &&
        second !== undefined &&
        third !== undefined &&
        first < second &&
        second < third
      )
    }),
    'The ballot radios occupy three stacked rows at 320px',
  ).toBe(true)
  await ballot.getByRole('checkbox', { name: common['meetingPoll.consent'] }).press('Space')
  await ballot.getByRole('button', { name: common['meetingPoll.save'] }).press('Enter')
  await expect(ballot.getByText(common['meetingPoll.saved'], { exact: true })).toBeVisible()

  await app.auditSignIn(true)
  await page.goto(app.url + hostPath)
  const finalize = page.getByTestId('meeting-poll-finalize')
  await finalize.getByRole('combobox', { name: 'Meeting time' }).selectOption(firstSlot)
  const booker = finalize.getByRole('combobox', { name: 'Booker', exact: true })
  await expect(booker).toBeVisible()
  await booker.selectOption({ label: `${voterName} (${email})` })
  const schedule = finalize.getByRole('button', { name: 'Schedule meeting', exact: true })
  await expect(schedule).toBeDisabled()
  await finalize
    .getByRole('checkbox', { name: 'I acknowledge the selected conditional votes.' })
    .press('Space')
  await schedule.press('Enter')
  const booking = page.getByTestId('meeting-poll-booking-link')
  expect(
    new RegExp(`^${PATHS.bookings}/${uuid}$`).test((await booking.getAttribute('href')) ?? ''),
    'The host booking link contains only the booking ID',
  ).toBe(true)
  await expect(booking).toBeFocused()
  expect(await app.rows()).toEqual([{ source: 'web', status: 'confirmed' }])

  await app.auditSignIn(false)
  const publicRead = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/v1/public/meeting-polls/read',
  )
  await openPollLink(page, link)
  await expect(ballot.getByText(common['meetingPoll.scheduled'], { exact: true })).toBeVisible()
  await expect(first.getByText(common['meetingPoll.chosen'], { exact: true })).toBeVisible()
  await expect(ballot.getByRole('button', { name: common['meetingPoll.save'] })).toHaveCount(0)
  await expectNarrowBallot(page)

  const publicBody = await (await publicRead).text()
  expect(/"(?:source|manageToken|bookingId)"/.test(publicBody)).toBe(false)
  expect([voterName, email, ...capabilities].some((value) => publicBody.includes(value))).toBe(
    false,
  )
  expect(anonymousRequests.length).toBeGreaterThan(0)
  expect(
    anonymousRequests.every(({ url, referrer }) =>
      capabilities.every((token) => !url.includes(token) && !referrer?.includes(token)),
    ),
    'Poll capabilities stay out of browser request URLs and referrers',
  ).toBe(true)
})
