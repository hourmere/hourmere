import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { components } from '../../../apps/web/src/api/schema.d.ts'
import { expect, test } from '../departure-handoff-fixtures.ts'

type Schemas = components['schemas']

test.use({ colorScheme: 'light' })

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
      }
  await handoff.offer('pending')
  await handoff.signIn('owner', chinese ? 'zh-CN' : 'en')
  await page.setViewportSize({ width: 320, height: 800 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(handoff.url + handoff.sourcePath)

  const region = page.getByRole('region', { name: labels.handoff })
  const status = region.getByRole('status')
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
  await expect(region.getByRole('status')).toContainText('All participants have approved.')
  await expect(confirm).toBeEnabled()

  await handoff.occupySlot()
  const response = applyResponse(page, handoff.sourceId)
  await confirm.click()
  expect((await response).status()).toBe(409)
  await expect(region.getByRole('status')).toContainText(
    'That time is unavailable for the replacement host.',
  )
  await expect(confirm).toBeDisabled()
  await region.getByRole('button', { name: 'Refresh handoff' }).click()
  await expect(region.getByRole('status')).toContainText(
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
  await expect(region.getByRole('status')).toContainText(
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
  await expect(region.getByRole('status')).toContainText('Booking handoff completed.')
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
    const status = region.getByRole('status')
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

test.describe('departure handoff acceptance', () => {
  test.use({ handoffZoom: true })

  test('a declined proposal needs fresh consent before the automatic run hands off the booking', async ({
    browser,
    page,
    handoff,
  }) => {
    await handoff.signIn()
    // The original invitation pins the organizer so the later cancellation can use its UID.
    await handoff.mail(handoff.sourceId, 'confirmed')
    const initialMail = handoff.mailState()
    expect(initialMail).toHaveLength(3)
    expect(initialMail.every((mail) => mail.method === 'REQUEST' && mail.hasZoomLink)).toBe(true)

    const headers = { Origin: handoff.url, 'X-Expected-Organization-Id': handoff.teamId }
    const post = (path: string, data: object) =>
      page.request.post(handoff.url + path, { headers, data })
    const booking = `/api/v1/team/bookings/${handoff.sourceId}`
    const proposals = `${booking}/handoff-offers`
    const runs = '/api/v1/team/bookings/handoff-runs'
    const { departingUserId } = handoff
    const run = { runId: randomUUID(), departingUserId }
    const runPath = `${runs}/${run.runId}`
    const original = {
      source: 'confirmed',
      bookingCount: 1,
      replacementId: undefined,
      replacementConfirmed: false,
      notificationCount: 0,
    }
    async function expectRunBlocked() {
      const response = await post(runs, run)
      expect(response.status()).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'handoff_run_no_eligible_offers' })
      expect(await handoff.result()).toEqual(original)
    }
    async function propose(data: object) {
      const response = await post(proposals, { departingUserId, ...data })
      expect(response.status()).toBe(201)
      return (await response.json()) as Schemas['DepartureHandoffProposal']
    }
    async function control(action: 'pause' | 'resume') {
      const response = await post(`${runPath}/control`, { action })
      expect(response.status()).toBe(200)
      return (await response.json()) as Schemas['DepartureHandoffRun']
    }
    const removal = await post(`/api/v1/team/members/${departingUserId}/removal`, {
      teamId: handoff.teamId,
    })
    expect(removal.status()).toBe(200)
    const first = await propose({})
    expect(first.version).toBe(1)
    const firstLinks = await handoff.deliverParticipantLinks()

    const participant = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' })
    try {
      await participant.route('**/*', (route) =>
        new URL(route.request().url()).origin === handoff.url ? route.continue() : route.abort(),
      )
      const reader = await participant.newPage()
      async function decide(link: URL, decision: 'Accept' | 'Decline', version: number) {
        await reader.goto('about:blank')
        const terms = reader.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/v1/booking-handoffs/offer',
        )
        // Keep the private fragment out of Playwright's navigation diagnostics.
        await reader.evaluate((href) => {
          window.setTimeout(() => window.location.replace(href), 0)
        }, link.href)
        const offer = await terms
        expect(offer.status()).toBe(200)
        expect(await offer.json()).toMatchObject({ version })
        await reader.getByRole('radio', { name: decision, exact: true }).check()
        await reader.getByRole('button', { name: 'Submit decision' }).click()
        await expect(
          reader.getByRole('heading', {
            name: decision === 'Accept' ? 'Acceptance recorded' : 'Decline recorded',
          }),
        ).toBeVisible()
      }

      await decide(firstLinks.booker, 'Accept', 1)
      await page.goto(handoff.url + handoff.sourcePath)
      const region = page.getByRole('region', { name: 'Booking handoff' })
      const status = region.getByRole('status')
      const confirm = region.getByRole('button', { name: 'Confirm handoff' })
      const refresh = region.getByRole('button', { name: 'Refresh handoff' })
      await region.getByRole('button', { name: 'Preview handoff' }).click()
      await expect(status).toContainText('Pending approvals: 1')
      await expect(confirm).toBeDisabled()
      await expectRunBlocked()

      await decide(firstLinks.guest, 'Decline', 1)
      await refresh.click()
      await expect(status).toContainText('This handoff offer is closed.')
      await expect(confirm).toBeDisabled()
      await expectRunBlocked()

      const proposedStart = handoff.sourceStart.add({ minutes: 30 })
      const second = await propose({
        start: proposedStart.toString(),
        previous: { offerId: first.id, version: first.version },
      })
      expect(second.id).toBe(first.id)
      expect(second.version).toBe(2)
      expect(second.recipients.map(({ decision }) => decision)).toEqual(['pending', 'pending'])
      await refresh.click()
      await expect(status).toContainText('Pending approvals: 2')
      await expect(confirm).toBeDisabled()
      const secondLinks = await handoff.deliverParticipantLinks()
      await decide(secondLinks.guest, 'Accept', 2)
      await expectRunBlocked()
      await decide(secondLinks.booker, 'Accept', 2)
      await refresh.click()
      await expect(status).toContainText('All participants have approved.')
      await expect(confirm).toBeEnabled()

      const start = await post(runs, run)
      expect(start.status()).toBe(200)
      const pending = {
        sourceBookingId: handoff.sourceId,
        offerId: second.id,
        version: 2,
        outcome: 'pending',
        replacementBookingId: null,
      }
      expect(await start.json()).toMatchObject({ state: 'running', items: [pending] })
      expect(await control('pause')).toMatchObject({ state: 'paused', items: [pending] })
      await handoff.processRun()
      expect(await handoff.result()).toEqual(original)
      expect(await control('resume')).toMatchObject({ state: 'running', items: [pending] })
      await handoff.processRun()

      const receipt = await page.request.get(handoff.url + runPath, { headers })
      expect(receipt.status()).toBe(200)
      const completed = (await receipt.json()) as Schemas['DepartureHandoffRun']
      const [item] = completed.items
      const replacementId = item?.replacementBookingId
      if (!replacementId) throw new Error('Expected one completed replacement')
      expect(completed).toMatchObject({
        state: 'completed',
        items: [{ ...pending, outcome: 'applied', replacementBookingId: replacementId }],
      })
      const result = await handoff.result()
      expect(result).toEqual({
        source: 'cancelled',
        bookingCount: 2,
        replacementId,
        replacementConfirmed: true,
        notificationCount: 2,
      })
      const replay = await post(runs, run)
      expect(replay.status()).toBe(200)
      expect(await replay.json()).toEqual(completed)
      expect(await handoff.result()).toEqual(result)
      const replacementBooking = await page.request.get(
        `${handoff.url}/api/v1/team/bookings/${replacementId}`,
        { headers },
      )
      expect(replacementBooking.status()).toBe(200)
      const detail = (await replacementBooking.json()) as Schemas['TeamAdminBookingDetail']
      expect(Temporal.Instant.from(detail.start).equals(proposedStart)).toBe(true)
      expect(detail.hosts.map(({ name }) => name)).toEqual(['Replacement host'])

      await refresh.click()
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
    } finally {
      await participant.close()
    }
  })
})
