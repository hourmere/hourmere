import type { Page } from '@playwright/test'
import { expect, test } from '../departure-handoff-fixtures.ts'

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
