import type { Browser, Locator, Page } from '@playwright/test'
import { expect, test } from '../departure-handoff-fixtures.ts'

test.use({ colorScheme: 'light' })

function handoffStatus(region: Locator, name = 'Handoff status') {
  return region.getByRole('region', { name }).getByRole('status')
}

function applyResponse(page: Page, sourceId: string) {
  return page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname
    return (
      response.request().method() === 'POST' &&
      path.startsWith(`/api/v1/team/bookings/${sourceId}/handoff-offers/`) &&
      path.endsWith('/apply')
    )
  })
}

test('one silent guest blocks confirmation and expiry leaves the original confirmed', async ({
  page,
  handoff,
}, testInfo) => {
  const chinese = testInfo.project.name === 'mobile'
  const labels = chinese
    ? {
        handoff: '预约交接',
        status: '交接状态',
        preview: '试算交接',
        confirm: '确认交接',
        refresh: '刷新交接状态',
        pending: '正在等待参加者同意。',
        outstanding: '待确认人数：1',
        expired: '同意期限已过。',
        proposal: '交接提议',
        newVersion: '新版本',
        version: '版本 2',
      }
    : {
        handoff: 'Booking handoff',
        status: 'Handoff status',
        preview: 'Preview handoff',
        confirm: 'Confirm handoff',
        refresh: 'Refresh handoff',
        pending: 'Participant consent is pending.',
        outstanding: 'Pending approvals: 1',
        expired: 'Consent has expired.',
        proposal: 'Handoff proposal',
        newVersion: 'New version',
        version: 'Version 2',
      }
  await handoff.offer('pending')
  await handoff.signIn('owner', chinese ? 'zh-CN' : 'en')
  await page.setViewportSize({ width: 320, height: 800 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(handoff.url + handoff.sourcePath)

  const region = page.getByRole('region', { name: labels.handoff })
  const status = handoffStatus(region, labels.status)
  const preview = region.getByRole('button', { name: labels.preview })
  const confirm = region.getByRole('button', { name: labels.confirm })
  await preview.focus()
  await preview.press('Enter')
  await expect(status).toContainText(labels.pending)
  await expect(status).toContainText(labels.outstanding)
  await expect(region.getByRole('region', { name: labels.status })).toBeFocused()
  await expect(confirm).toBeDisabled()
  expect(await region.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(
    await page.evaluate(() => {
      const root = document.documentElement
      return root.scrollWidth <= root.clientWidth
    }),
  ).toBe(true)

  handoff.expireOffer()
  await region.getByRole('button', { name: labels.refresh }).click()
  await expect(status).toContainText(labels.expired)
  await expect(confirm).toBeDisabled()
  const proposal = region.getByRole('region', { name: labels.proposal })
  await region.getByRole('button', { name: labels.newVersion }).click()
  await expect(proposal.getByText(labels.version, { exact: true })).toBeVisible()
  await expect(confirm).toBeDisabled()
  expect(await handoff.result()).toMatchObject({
    source: 'confirmed',
    bookingCount: 1,
    replacementId: undefined,
    notificationCount: 0,
  })
})

test('confirmation rechecks a slot taken after preview', async ({ page, handoff }) => {
  await handoff.offer()
  await handoff.signIn()
  await page.goto(handoff.url + handoff.sourcePath)
  const region = page.getByRole('region', { name: 'Booking handoff' })
  const confirm = region.getByRole('button', { name: 'Confirm handoff' })
  await region.getByRole('button', { name: 'Preview handoff' }).click()
  await expect(handoffStatus(region)).toContainText('All participants have approved.')
  await expect(confirm).toBeEnabled()

  await handoff.occupySlot()
  const response = applyResponse(page, handoff.sourceId)
  await confirm.click()
  expect((await response).status()).toBe(409)
  await expect(handoffStatus(region)).toContainText(
    'That time is unavailable for the replacement host.',
  )
  await expect(confirm).toBeDisabled()
  await region.getByRole('button', { name: 'Refresh handoff' }).click()
  await expect(handoffStatus(region)).toContainText(
    'That time is unavailable for the replacement host.',
  )
  await expect(confirm).toBeDisabled()
  expect(await handoff.result()).toMatchObject({
    source: 'confirmed',
    bookingCount: 2,
    replacementId: undefined,
    notificationCount: 0,
  })
})

test('notification enqueue failure rolls back and a refreshed confirmation delivers each notice once', async ({
  page,
  handoff,
}) => {
  await handoff.offer()
  await handoff.signIn()
  await page.goto(handoff.url + handoff.sourcePath)
  const region = page.getByRole('region', { name: 'Booking handoff' })
  const confirm = region.getByRole('button', { name: 'Confirm handoff' })
  const refresh = region.getByRole('button', { name: 'Refresh handoff' })
  await region.getByRole('button', { name: 'Preview handoff' }).click()
  await expect(confirm).toBeEnabled()

  handoff.failEnqueue(true)
  const failed = applyResponse(page, handoff.sourceId)
  await confirm.click()
  expect((await failed).status()).toBe(503)
  await expect(handoffStatus(region)).toContainText(
    'Could not confirm whether the handoff completed.',
  )
  await expect(confirm).toBeDisabled()
  expect(await handoff.result()).toMatchObject({
    source: 'confirmed',
    bookingCount: 1,
    replacementId: undefined,
    notificationCount: 0,
  })

  handoff.failEnqueue(false)
  await refresh.click()
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(handoffStatus(region)).toContainText('Booking handoff completed.')
  const result = await handoff.result()
  expect(result).toMatchObject({
    source: 'cancelled',
    bookingCount: 2,
    replacementConfirmed: true,
    notificationCount: 2,
  })
  const replacementId = result.replacementId
  if (!replacementId) throw new Error('Expected a replacement receipt')
  await expect(region.getByRole('link', { name: 'View replacement booking' })).toHaveAttribute(
    'href',
    `/app/bookings/${replacementId}`,
  )

  await handoff.mail(handoff.sourceId, 'cancelled')
  await expect(handoff.mail(replacementId, 'confirmed', true)).rejects.toThrow(
    'Synthetic mail service unavailable',
  )
  expect(await handoff.result()).toEqual(result)
  await handoff.mail(replacementId, 'confirmed')
  const sent = handoff.mailState()
  const cancellations = sent.filter((message) => !message.method)
  const invitations = sent.filter((message) => message.method === 'REQUEST')
  expect(cancellations.map((message) => message.to).sort()).toEqual(
    [handoff.emails.booker, handoff.emails.guest, handoff.emails.departing].sort(),
  )
  expect(invitations.map((message) => message.to).sort()).toEqual(
    [handoff.emails.booker, handoff.emails.guest, handoff.emails.candidate].sort(),
  )
  expect(cancellations.every((mail) => !mail.uid && !mail.sequence)).toBe(true)
  expect(
    invitations.every((mail) => mail.uid === `${replacementId}@hourmere` && mail.sequence === '0'),
  ).toBe(true)
  await handoff.mail(handoff.sourceId, 'cancelled')
  await handoff.mail(replacementId, 'confirmed')
  expect(handoff.mailState()).toEqual(sent)
})

test.describe('provider ambiguity after commit', () => {
  test.use({ handoffZoom: true })

  test('the administrator sees safe recovery and a replacement host recheck never repeats create', async ({
    page,
    handoff,
  }) => {
    await handoff.offer()
    await handoff.signIn()
    const url = handoff.url + handoff.sourcePath
    await page.goto(url)
    const region = page.getByRole('region', { name: 'Booking handoff' })
    const refresh = region.getByRole('button', { name: 'Refresh handoff' })
    const status = handoffStatus(region)
    await region.getByRole('button', { name: 'Preview handoff' }).click()
    await region.getByRole('button', { name: 'Confirm handoff' }).click()
    await expect(status).toContainText('Booking handoff completed.')
    const result = await handoff.result()
    const replacementId = result.replacementId
    if (!replacementId) throw new Error('Expected a replacement receipt')
    expect(result).toMatchObject({ source: 'cancelled', replacementConfirmed: true })

    await refresh.click()
    await expect(status).toContainText('The replacement meeting link is being prepared.')
    await expect(status).toContainText(
      'Cleanup in the original calendar or meeting account is pending.',
    )
    await handoff.loseProviderResponse(replacementId)
    await refresh.click()
    await expect(status).toContainText('The replacement meeting link could not be verified.')
    await expect(status).toContainText('Ask its host to check their meeting account')
    await expect(region.getByRole('link', { name: /join|start/i })).toHaveCount(0)
    await expect(region.getByRole('button', { name: /retry/i })).toHaveCount(0)
    expect(await handoff.result()).toEqual(result)
    expect(handoff.providerState()).toEqual({ newCreates: 1, newMeetings: 1, oldMeetings: 1 })

    await handoff.mail(replacementId, 'confirmed')
    expect(handoff.mailState()).toEqual([])
    await handoff.mail(replacementId, 'conference_failed')
    const failureNotices = handoff.mailState()
    expect(failureNotices).toContainEqual({
      to: handoff.emails.booker,
      method: undefined,
      uid: undefined,
      sequence: undefined,
      hasZoomLink: false,
    })
    expect(failureNotices.every((notice) => !notice.method && !notice.hasZoomLink)).toBe(true)

    const retry = () =>
      page.request.post(`${handoff.url}/api/v1/bookings/${replacementId}/conference/retry`, {
        headers: { Origin: handoff.url, 'X-Expected-Organization-Id': handoff.teamId },
        data: {},
      })
    expect((await retry()).status()).toBe(404)
    await handoff.signIn('candidate')
    expect((await retry()).status()).toBe(204)
    await handoff.reconcileProvider(replacementId)
    expect(handoff.providerState()).toEqual({ newCreates: 1, newMeetings: 1, oldMeetings: 0 })
    expect(await handoff.result()).toEqual(result)

    await handoff.signIn()
    await page.goto(url)
    await region.getByRole('button', { name: 'Preview handoff' }).click()
    await expect(status).toContainText('The replacement meeting link could not be verified.')
    await expect(status).not.toContainText(
      'Cleanup in the original calendar or meeting account is pending.',
    )
    await expect(status).not.toContainText(
      'Cleanup in the original calendar or meeting account could not be verified.',
    )
  })
})

async function removeDepartingHost(page: Page, url: string) {
  await page.goto(`${url}/app/settings`)
  await page.getByRole('button', { name: 'Remove member: Departing host' }).click()
  const review = page.getByRole('region', { name: 'Remove team member' })
  await review.getByRole('button', { name: 'Remove member', exact: true }).click()
  await expect(review.getByText('Member removed. Access was revoked immediately.')).toBeVisible()
  return review
}

async function openSourceBooking(page: Page, removal: Locator) {
  await removal.getByRole('link', { name: 'Review team bookings' }).click()
  await page.getByRole('button', { name: 'Intro call', exact: true }).click()
  const handoff = page.getByRole('region', { name: 'Booking handoff' })
  await expect(handoff.getByRole('button', { name: 'Create proposal' })).toHaveCount(0)
  await expect(handoff.getByRole('button', { name: 'Confirm handoff' })).toHaveCount(0)
  await handoff.getByRole('button', { name: 'Preview handoff' }).press('Enter')
  return handoff
}

async function confirmAutomaticHandoffStart(page: Page, start: Locator) {
  await start.click()
  const dialog = page.getByRole('dialog', { name: 'Start automatic handoff?' })
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await expect(dialog).toContainText(
    'This run processes up to 10 fully approved bookings, with at least 10 seconds between bookings. You can pause or stop it.',
  )
  await dialog.getByRole('button', { name: 'Start automatic handoff', exact: true }).click()
}

async function openParticipantContext(browser: Browser, url: string) {
  const participant = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' })
  await participant.route('**/*', (route) =>
    new URL(route.request().url()).origin === url ? route.continue() : route.abort(),
  )
  return participant
}

async function openPrivateOffer(page: Page, link: URL) {
  await page.goto('about:blank')
  // Keep the private fragment out of Playwright's navigation diagnostics.
  await page.evaluate((href) => {
    window.setTimeout(() => window.location.replace(href), 0)
  }, link.href)
}

async function decide(
  page: Page,
  link: URL,
  decision: 'Accept' | 'Decline',
  proposedStart?: Temporal.Instant,
) {
  await openPrivateOffer(page, link)
  if (proposedStart) {
    const terms = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Proposed booking', exact: true }),
    })
    await expect(terms.getByText('Replacement host', { exact: true })).toBeVisible()
    await expect
      .poll(async () => {
        const value = await terms.locator('time').first().getAttribute('datetime')
        return value !== null && Temporal.Instant.from(value).equals(proposedStart)
      })
      .toBe(true)
  }
  await page.getByRole('radio', { name: decision, exact: true }).check()
  await page.getByRole('button', { name: 'Submit decision' }).click()
  await expect(
    page.getByRole('heading', {
      name: decision === 'Accept' ? 'Acceptance recorded' : 'Decline recorded',
    }),
  ).toBeVisible()
}

const originalBooking = {
  source: 'confirmed',
  bookingCount: 1,
  replacementId: undefined,
  replacementConfirmed: false,
  notificationCount: 0,
}

test.describe('departure handoff acceptance', () => {
  test.use({ handoffZoom: true })

  test('the administrator re-versions a declined proposal and completes an automatic handoff from the UI', async ({
    browser,
    page,
    handoff,
  }) => {
    await handoff.signIn()
    // Pin the original organizer so its cancellation can reuse the original UID.
    await handoff.mail(handoff.sourceId, 'confirmed')
    const initialMail = handoff.mailState()
    expect(initialMail).toHaveLength(3)
    expect(initialMail.every((mail) => mail.method === 'REQUEST' && mail.hasZoomLink)).toBe(true)

    const removal = await removeDepartingHost(page, handoff.url)
    const queue = page.getByRole('region', { name: 'Automatic handoff' })
    const start = queue.getByRole('button', {
      name: 'Start automatic handoff for this departed member',
    })
    await confirmAutomaticHandoffStart(page, start)
    await expect(queue.getByRole('alert')).toContainText(
      'No fully approved proposals are eligible for automatic handoff.',
    )
    expect(await handoff.result()).toEqual(originalBooking)

    const region = await openSourceBooking(page, removal)
    const status = handoffStatus(region)
    const proposal = region.getByRole('region', { name: 'Handoff proposal' })
    const booker = proposal.getByRole('article', { name: 'Booker' })
    const guest = proposal.getByRole('article', { name: 'Guest' })
    const confirm = region.getByRole('button', { name: 'Confirm handoff' })
    const refresh = region.getByRole('button', { name: 'Refresh handoff' })
    await expect(region.locator('dd').getByText('Replacement host', { exact: true })).toBeVisible()
    await expect(region.locator('dd').getByText('Departing host', { exact: true })).toBeVisible()
    await expect(region.locator('dt').getByText('Departed host', { exact: true })).toBeVisible()
    await region.getByRole('button', { name: 'Create proposal' }).click()
    await expect(proposal.getByText('Version 1', { exact: true })).toBeVisible()
    await expect(proposal.getByText('Expires at', { exact: true })).toBeVisible()
    await expect(proposal.locator('time')).toHaveAttribute('datetime', /Z$/)
    await expect(
      region.getByRole('button', { name: /^(Create proposal|New version)$/ }),
    ).toHaveCount(0)
    await expect(confirm).toBeDisabled()
    for (const recipient of [booker, guest]) {
      await expect(recipient).toContainText('Awaiting decision')
      await expect(recipient).toContainText('Queued')
      await expect(recipient).toContainText('Resend unavailable')
    }
    for (const email of [handoff.emails.booker, handoff.emails.guest])
      await expect(proposal).not.toContainText(email)
    const first = await handoff.deliverParticipantLinks()
    const participant = await openParticipantContext(browser, handoff.url)
    try {
      const reader = await participant.newPage()
      await decide(reader, first.booker, 'Accept')
      await refresh.click()
      await expect(status).toContainText('Pending approvals: 1')
      await expect(booker).toContainText('Approved')
      await expect(guest).toContainText('Accepted by the mail server')
      await expect(confirm).toBeDisabled()

      await decide(reader, first.guest, 'Decline')
      await refresh.click()
      await expect(status).toContainText('This handoff offer is closed.')
      await expect(guest).toContainText('Declined')
      await expect(confirm).toBeDisabled()
      expect(await handoff.result()).toEqual(originalBooking)

      const proposedStart = handoff.sourceStart.add({ minutes: 30 })
      await region
        .getByLabel('Start time (optional)')
        .fill(
          proposedStart
            .toZonedDateTimeISO('UTC')
            .toPlainDateTime()
            .toString({ smallestUnit: 'minute' }),
        )
      await region.getByRole('button', { name: 'New version' }).click()
      await expect(proposal.getByText('Version 2', { exact: true })).toBeVisible()
      await expect(status).toContainText('Pending approvals: 2')
      await expect(confirm).toBeDisabled()
      const second = await handoff.deliverParticipantLinks()
      await decide(reader, second.guest, 'Accept', proposedStart)
      await refresh.click()
      await expect(status).toContainText('Pending approvals: 1')
      await expect(confirm).toBeDisabled()
      await decide(reader, second.booker, 'Accept')
      await refresh.click()
      await expect(status).toContainText('All participants have approved.')
      await expect(confirm).toBeEnabled()

      await page.getByRole('link', { name: 'Manage automatic handoff' }).click()
      await confirmAutomaticHandoffStart(page, start)
      await expect(queue.getByRole('status')).toContainText('Running')
      const receipt = queue.getByRole('list')
      await expect(queue.getByRole('heading', { name: 'Run receipt' })).toBeVisible()
      await expect(receipt.getByRole('listitem')).toHaveCount(1)
      await expect(receipt).toContainText('Proposal version 2 · Pending')
      await queue.getByRole('button', { name: 'Pause', exact: true }).click()
      await expect(queue.getByRole('status')).toContainText('Paused')
      await handoff.processRun()
      expect(await handoff.result()).toEqual(originalBooking)
      await queue.getByRole('button', { name: 'Resume', exact: true }).click()
      await expect(queue.getByRole('status')).toContainText('Running')
      await handoff.processRun()
      await queue.getByRole('button', { name: 'Refresh run receipt' }).click()
      await expect(queue.getByRole('status')).toContainText('Completed')
      await expect(receipt).toContainText('Proposal version 2 · Applied')
      const result = await handoff.result()
      const replacementId = result.replacementId
      if (!replacementId) throw new Error('Expected one completed replacement')
      expect(result).toEqual({
        source: 'cancelled',
        bookingCount: 2,
        replacementId,
        replacementConfirmed: true,
        notificationCount: 2,
      })
      await expect(queue.getByRole('link', { name: 'View replacement booking' })).toHaveAttribute(
        'href',
        `/app/bookings/${replacementId}`,
      )

      await receipt.getByRole('link', { name: 'View original booking' }).click()
      await region.getByRole('button', { name: /^(Preview|Refresh) handoff$/ }).click()
      await expect(status).toContainText('Booking handoff completed.')
      await expect(status).toContainText('The replacement meeting link is being prepared.')
      await expect(status).toContainText(
        'Cleanup in the original calendar or meeting account is pending.',
      )
      await handoff.reconcileProvider(replacementId)
      expect(handoff.providerState()).toEqual({ newCreates: 1, newMeetings: 1, oldMeetings: 0 })

      await handoff.mail(handoff.sourceId, 'cancelled')
      await handoff.mail(replacementId, 'confirmed')
      const handoffMail = handoff.mailState().slice(initialMail.length)
      expect(handoffMail.filter((mail) => mail.method === 'CANCEL')).toHaveLength(2)
      expect(handoffMail.filter((mail) => mail.method === 'REQUEST')).toHaveLength(3)
      for (const recipient of [handoff.emails.booker, handoff.emails.guest]) {
        expect(handoffMail).toContainEqual({
          to: recipient,
          method: 'CANCEL',
          uid: `${handoff.sourceId}@hourmere`,
          sequence: '1',
          hasZoomLink: false,
        })
        expect(handoffMail).toContainEqual({
          to: recipient,
          method: 'REQUEST',
          uid: `${replacementId}@hourmere`,
          sequence: '0',
          hasZoomLink: true,
        })
      }
      await refresh.click()
      await expect(status).toContainText('The replacement meeting link is ready.')
      await expect(status).toContainText(
        'Cleanup of the tracked entries in the original calendar or meeting account is complete.',
      )
      await expect(status.getByText('Accepted by the mail server')).toHaveCount(2)
      const replacement = region.getByRole('link', { name: 'View replacement booking' })
      await expect(replacement).toHaveAttribute('href', `/app/bookings/${replacementId}`)
      await replacement.click()
      await expect(
        page
          .getByRole('region', { name: 'Team booking details' })
          .getByText('Replacement host', { exact: true }),
      ).toBeVisible()
    } finally {
      await participant.close()
    }
  })
})

test('the administrator can resend individual links, stop a run and withdraw through the UI', async ({
  browser,
  page,
  handoff,
}) => {
  await handoff.signIn()
  await page.setViewportSize({ width: 320, height: 800 })
  await page.emulateMedia({ colorScheme: 'dark' })
  const removal = await removeDepartingHost(page, handoff.url)
  const region = await openSourceBooking(page, removal)
  const proposal = region.getByRole('region', { name: 'Handoff proposal' })
  const booker = proposal.getByRole('article', { name: 'Booker' })
  const guest = proposal.getByRole('article', { name: 'Guest' })
  const resend = booker.getByRole('button', { name: 'Resend' })
  const refresh = region.getByRole('button', { name: 'Refresh handoff' })
  await region.getByRole('button', { name: 'Create proposal' }).click()
  await expect(proposal.getByText('Version 1', { exact: true })).toBeVisible()
  const first = await handoff.deliverParticipantLinks()
  await refresh.click()
  await expect(resend).toBeEnabled()

  const resendDialog = page.getByRole('dialog', { name: 'Resend proposal link?' })
  await resend.press('Enter')
  await expect(resendDialog).toBeVisible()
  await expect(
    await resendDialog.evaluate((element) => element.contains(document.activeElement)),
  ).toBe(true)
  await page.keyboard.press('Escape')
  await expect(resendDialog).toHaveCount(0)
  await expect(resend).toBeFocused()

  const requestKeys: string[] = []
  async function resendBooker() {
    await resend.press('Enter')
    const request = page.waitForRequest(
      (candidate) =>
        candidate.method() === 'POST' && new URL(candidate.url()).pathname.endsWith('/resend'),
    )
    await resendDialog.getByRole('button', { name: 'Resend', exact: true }).click()
    const key = await (await request).headerValue('idempotency-key')
    if (!key) throw new Error('The resend request needs a key')
    requestKeys.push(key)
    await expect(booker).toContainText('Queued')
    await expect(guest).toContainText('Accepted by the mail server')
    const link = await handoff.deliverResentLink('booker')
    await refresh.click()
    await expect(booker).toContainText('Accepted by the mail server')
    return link
  }

  await resendBooker()
  const latest = await resendBooker()
  expect(new Set(requestKeys).size).toBe(2)
  await expect(booker).toContainText('Resend unavailable')
  await expect(resend).toHaveCount(0)
  await expect(guest.getByRole('button', { name: 'Resend' })).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  const participant = await openParticipantContext(browser, handoff.url)
  try {
    const reader = await participant.newPage()
    await openPrivateOffer(reader, first.booker)
    await expect(
      reader.getByRole('heading', { name: 'This handoff link is unavailable' }),
    ).toBeVisible()
    await decide(reader, latest, 'Accept')
    await decide(reader, first.guest, 'Accept')
  } finally {
    await participant.close()
  }

  await refresh.click()
  await expect(handoffStatus(region)).toContainText('All participants have approved.')
  await page.getByRole('link', { name: 'Manage automatic handoff' }).click()
  const queue = page.getByRole('region', { name: 'Automatic handoff' })
  await confirmAutomaticHandoffStart(
    page,
    queue.getByRole('button', { name: 'Start automatic handoff for this departed member' }),
  )
  await expect(queue.getByRole('status')).toContainText('Running')
  const stop = queue.getByRole('button', { name: 'Stop', exact: true })
  await stop.click()
  const stopDialog = page.getByRole('dialog', { name: 'Stop automatic handoff?' })
  await expect(stopDialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await expect(stopDialog).toContainText(
    'Remaining bookings will not be processed. Their original bookings stay unchanged.',
  )
  await page.keyboard.press('Escape')
  await expect(stopDialog).toBeHidden()
  await expect(stop).toBeFocused()
  await expect(queue.getByRole('status')).toContainText('Running')
  await stop.click()
  await stopDialog.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(queue.getByRole('status')).toContainText('Stopped')
  await expect(queue.getByRole('heading', { name: 'Run receipt' })).toBeVisible()
  const receipt = queue.getByRole('list')
  await expect(receipt).toContainText('Proposal version 1 · Stopped')
  await expect(queue.getByRole('link', { name: 'View replacement booking' })).toHaveCount(0)
  await handoff.processRun()
  expect(await handoff.result()).toEqual(originalBooking)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await receipt.getByRole('link', { name: 'View original booking' }).click()
  await region.getByRole('button', { name: /^(Preview|Refresh) handoff$/ }).click()
  await proposal.getByRole('button', { name: 'Withdraw', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Withdraw proposal?' })
  await dialog.getByRole('button', { name: 'Withdraw', exact: true }).click()
  await expect(proposal.getByText('Withdrawn', { exact: true })).toBeVisible()
  expect(await handoff.result()).toEqual(originalBooking)
})
