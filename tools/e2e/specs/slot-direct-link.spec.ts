import type { Page } from '@playwright/test'
import { expect, type FixtureApp, fillInvitee, pickSlot, test } from '../fixtures.ts'

type Slot = { start: string; end: string }
const unavailable = 'That time is no longer available. Please pick another one.'

function apiPath(path: string) {
  return path.startsWith('/team/')
    ? `/api/v1/public/teams/${path.slice('/team/'.length)}`
    : `/api/v1/public${path}`
}

async function offered(page: Page, app: FixtureApp, path: string, durationMinutes = 30) {
  const start = Temporal.Now.instant().add({ hours: 48 })
  const range = new URLSearchParams({
    start: start.toString(),
    end: start.add({ hours: 168 }).toString(),
    durationMinutes: String(durationMinutes),
  })
  const response = await page.request.get(`${app.url}${apiPath(path)}/slots?${range}`)
  expect(response.status()).toBe(200)
  const body = (await response.json()) as { data: Slot[] }
  const slot = body.data[0]
  if (!slot) throw new Error('No synthetic fixture interval is offered')
  return slot
}

function link(app: FixtureApp, path: string, slot: Slot, durationMinutes = 30) {
  return `${app.url}${path}?${new URLSearchParams({ start: slot.start, durationMinutes: String(durationMinutes) })}`
}

async function take(page: Page, app: FixtureApp, path: string, slot: Slot) {
  const result = await page.request.post(`${app.url}${apiPath(path)}/bookings`, {
    headers: { 'idempotency-key': crypto.randomUUID() },
    data: {
      start: slot.start,
      durationMinutes: 30,
      invitee: { name: 'Other invitee', email: 'other@example.test', timeZone: 'UTC' },
    },
  })
  expect(result.status()).toBe(201)
}

for (const kind of ['personal', 'team'] as const) {
  for (const durationMinutes of [30, 60]) {
    test(`${kind} suggested slot uses explicit ${durationMinutes} minutes and requires deliberate confirmation`, async ({
      page,
      app,
    }) => {
      if (durationMinutes === 60) await app.configureDurations()
      const path = kind === 'team' ? app.teamPath : app.personalPath
      const slot = await offered(page, app, path, durationMinutes)
      const exactReads: URL[] = []
      page.on('request', (request) => {
        const url = new URL(request.url())
        if (url.pathname.endsWith('/slots')) exactReads.push(url)
      })
      await page.goto(link(app, path, slot, durationMinutes))
      await expect(page.getByRole('button', { name: 'Confirm booking', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Change time', exact: true })).toBeVisible()
      expect(await app.rows()).toEqual([])
      expect(
        exactReads.some(
          (url) =>
            url.searchParams.get('start') === slot.start &&
            Temporal.Instant.compare(url.searchParams.get('end') as string, slot.end) === 0 &&
            url.searchParams.get('durationMinutes') === String(durationMinutes),
        ),
      ).toBe(true)
      await fillInvitee(page)
      const created = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' && response.url().endsWith('/bookings'),
      )
      await page.getByRole('button', { name: 'Confirm booking', exact: true }).click()
      const response = await created
      expect(response.status()).toBe(201)
      const submitted = response.request().postDataJSON() as {
        durationMinutes: number
        start: string
      }
      expect(submitted.durationMinutes).toBe(durationMinutes)
      expect(submitted.start).toBe(slot.start)
      const result = (await response.json()) as { booking: Slot & { source: string } }
      expect(result.booking).toMatchObject({ ...slot, source: 'web' })
      await expect(page.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
      expect(await app.rows()).toEqual([{ source: 'web', status: 'confirmed' }])
    })
  }
}

test('canonical case redirects retain the suggested interval and unrelated query fields do not change invitee preferences', async ({
  page,
  app,
}) => {
  const slot = await offered(page, app, app.personalPath)
  const href = new URL(link(app, app.personalPath.toUpperCase(), slot))
  href.searchParams.set('locale', 'de')
  href.searchParams.set('timeZone', 'Asia/Tokyo')
  href.searchParams.set('hostId', 'untrusted-host')
  href.searchParams.set('end', '2099-01-01T00:00:00Z')
  await page.goto(href.href)
  await expect(page.getByRole('button', { name: 'Confirm booking', exact: true })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe(app.personalPath)
  expect(new URL(page.url()).searchParams.get('start')).toBe(slot.start)
  expect(new URL(page.url()).searchParams.get('durationMinutes')).toBe('30')
  await expect(page.getByRole('button', { name: 'Language: English', exact: true })).toBeVisible()
  expect(await app.rows()).toEqual([])
})

test('change time consumes the suggestion and preserves the invitee draft for a manual choice', async ({
  page,
  app,
}) => {
  const slot = await offered(page, app, app.personalPath)
  await page.goto(link(app, app.personalPath, slot))
  await expect(page.getByRole('button', { name: 'Confirm booking', exact: true })).toBeVisible()
  await fillInvitee(page)
  await page.getByRole('button', { name: 'Change time', exact: true }).click()
  await expect(page.locator('.calendar-month')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm booking', exact: true })).toHaveCount(0)
  await pickSlot(page, page)
  await expect(page.getByLabel('Your name', { exact: true })).toHaveValue('Fixture Invitee')
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(
    'fixture-invitee@hourmere.invalid',
  )
  expect(await app.rows()).toEqual([])
})

test('a slot taken before opening falls back generically without other booking details', async ({
  page,
  app,
}) => {
  const slot = await offered(page, app, app.personalPath)
  await take(page, app, app.personalPath, slot)
  await page.goto(link(app, app.personalPath, slot))
  await expect(page.getByText(unavailable, { exact: true })).toBeVisible()
  await expect(page.locator('.calendar-month')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm booking', exact: true })).toHaveCount(0)
  await expect(page.getByText('Other invitee', { exact: true })).toHaveCount(0)
  await expect(page.getByText('other@example.test', { exact: true })).toHaveCount(0)
  expect(await app.rows()).toEqual([{ source: 'web', status: 'confirmed' }])
})

test('a suggested slot taken after preselection keeps the draft and uses generic final-submit fallback', async ({
  page,
  app,
}) => {
  const slot = await offered(page, app, app.personalPath)
  await page.goto(link(app, app.personalPath, slot))
  await expect(page.getByRole('button', { name: 'Confirm booking', exact: true })).toBeVisible()
  await fillInvitee(page)
  await take(page, app, app.personalPath, slot)
  const conflict = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/bookings'),
  )
  await page.getByRole('button', { name: 'Confirm booking', exact: true }).click()
  expect((await conflict).status()).toBe(409)
  await expect(page.getByText(unavailable, { exact: true })).toBeVisible()
  await expect(
    page.getByText('Someone else just booked that time. Please pick another.', { exact: true }),
  ).toHaveCount(0)
  await pickSlot(page, page)
  await expect(page.getByLabel('Your name', { exact: true })).toHaveValue('Fixture Invitee')
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(
    'fixture-invitee@hourmere.invalid',
  )
  expect(await app.rows()).toEqual([{ source: 'web', status: 'confirmed' }])
})

test('dedicated embeds ignore direct-slot query hints and retain their ordinary picker', async ({
  page,
  app,
}) => {
  const slot = await offered(page, app, app.personalPath)
  await page.goto(app.parentUrl)
  const iframe = page.locator('iframe').first()
  await expect(iframe).toBeVisible()
  await iframe.evaluate((element, suggested) => {
    const frame = element as HTMLIFrameElement
    const url = new URL(frame.src)
    url.searchParams.set('start', suggested.start)
    url.searchParams.set('durationMinutes', '30')
    frame.src = url.href
  }, slot)
  const frame = iframe.contentFrame()
  await expect(frame.locator('.calendar-month')).toBeVisible()
  await expect(frame.getByRole('button', { name: 'Confirm booking', exact: true })).toHaveCount(0)
  expect(await app.rows()).toEqual([])
})
