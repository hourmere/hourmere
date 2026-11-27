import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import type { components } from '../../../apps/web/src/api/schema.d.ts'
import { bookingPath, PATHS } from '../../../apps/web/src/paths.ts'
import { expect, pickSlot, test } from '../fixtures.ts'

type Schemas = components['schemas']

const slug = 'fixture-intake'
const formTitle = 'Synthetic intake form'
const intakeLabel = 'Intake topic'
const intakeAnswer = 'Synthetic routing answer'
const bookingLabel = 'Booking topic'
const bookingAnswer = 'Edited booking answer'
const questionId = 'booking-topic'
const inviteeEmail = 'routing-invitee@hourmere.invalid'

async function publishFixture(request: APIRequestContext, origin: string) {
  const events = await request.get(`${origin}/api/v1/event-types`)
  expect(events.status()).toBe(200)
  const { data } = (await events.json()) as Schemas['EventTypeList']
  const event = data.find(({ slug }) => slug === 'call')
  if (!event) throw new Error('Missing the personal fixture event type')
  const headers = { origin, 'x-expected-organization-id': event.organizationId }
  const hiddenSlug = 'synthetic-hidden-routing-target'
  const change = await request.patch(`${origin}/api/v1/event-types/${event.id}`, {
    headers,
    data: {
      slug: hiddenSlug,
      isHidden: true,
      questions: [{ id: questionId, type: 'short_text', label: bookingLabel, required: true }],
    } satisfies Schemas['EventTypeUpdate'],
  })
  expect(change.status()).toBe(200)

  const intakeId = randomUUID()
  const emailId = randomUUID()
  const ruleId = randomUUID()
  const forms = `${origin}/api/v1/routing-forms`
  const draft = await request.post(forms, {
    headers,
    data: {
      slug,
      title: formTitle,
      questions: [
        { id: intakeId, type: 'short_text', label: intakeLabel, required: true },
        { id: emailId, type: 'email', label: 'Contact email', required: true },
      ],
      rules: [
        {
          id: ruleId,
          conditions: [{ questionId: intakeId, operator: 'equals', value: intakeAnswer }],
          target: {
            kind: 'event',
            eventTypeId: event.id,
            mappings: [
              { questionId: intakeId, destination: { kind: 'question', questionId } },
              { questionId: emailId, destination: { kind: 'inviteeEmail' } },
            ],
          },
        },
      ],
      fallback: { kind: 'message', message: 'Contact the synthetic host' },
    } satisfies Schemas['CreateRoutingForm'],
  })
  expect(draft.status()).toBe(201)
  const { id, draftRevision } = (await draft.json()) as Schemas['RoutingForm']
  const publication = await request.post(`${forms}/${id}/publish`, {
    headers,
    data: { expectedRevision: draftRevision },
  })
  expect(publication.status()).toBe(201)
  const { form, version } = (await publication.json()) as Schemas['RoutingFormPublication']
  const enabled = await request.patch(`${forms}/${id}`, {
    headers,
    data: { expectedRevision: form.draftRevision, enabled: true },
  })
  expect(enabled.status()).toBe(200)
  return { id, versionId: version.id, ruleId, hiddenSlug, eventTitle: event.title }
}

async function downloadCsv(page: Page) {
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click()
  const download = await downloading
  const stream = await download.createReadStream()
  stream.setEncoding('utf8')
  let csv = ''
  for await (const chunk of stream) csv += chunk
  return csv
}

test('default routing accepts a public submission and protects saved answers on each surface', async ({
  app,
  context,
  page,
}) => {
  const publicPath = `/route/fixture-host/${slug}`
  await app.auditSignIn(true)
  await page.goto(app.url + PATHS.eventTypes)
  await page.getByRole('link', { name: 'Routing forms', exact: true }).click()
  await expect(page.getByText('No routing forms yet.', { exact: true })).toBeVisible()

  for (const path of [publicPath, `/route/team/FixtureTeam/${slug}`]) {
    await page.goto(app.url + path)
    await expect(page.getByRole('heading', { name: 'This form is unavailable' })).toBeVisible()
  }

  await app.configureSuccessRedirect(false)
  const fixture = await publishFixture(context.request, app.url)
  await app.auditSignIn(false)
  const outbound: { url: string; referrer?: string }[] = []
  page.on('request', (request) => {
    const referrer = request.headers().referer
    outbound.push({ url: request.url(), ...(referrer && { referrer }) })
  })

  await page.goto(app.url + publicPath)
  await expect(page.getByRole('heading', { name: formTitle, exact: true })).toBeVisible()
  await page.getByLabel(intakeLabel).fill(intakeAnswer)
  await page.getByLabel('Contact email').fill(inviteeEmail)
  const submitUrl = `${app.url}/api/v1/public/-/routing/fixture-host/${slug}/route`
  let outcome: Schemas['RoutingSubmissionResponse'] | undefined
  await page.route(submitUrl, async (route) => {
    // Read the real response before forwarding it unchanged. The ensuing document
    // navigation discards the browser's response body as soon as the form submits.
    const response = await route.fetch({ maxRedirects: 0 })
    outcome = (await response.json()) as Schemas['RoutingSubmissionResponse']
    await route.fulfill({ response })
  })
  const routing = page.waitForResponse(submitUrl)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  expect((await routing).status()).toBe(200)
  if (outcome?.kind !== 'continuation') throw new Error('The matching rule should offer a booking')
  const { routeToken } = outcome
  const handoff = URL.parse(outcome.continuationUrl)
  expect(
    handoff?.origin === app.url &&
      handoff.pathname === '/route/continue' &&
      handoff.search === '' &&
      new URLSearchParams(handoff.hash.slice(1)).get('token') === routeToken &&
      [...new URLSearchParams(handoff.hash.slice(1)).keys()].length === 1,
    'The continuation link carries only its private capability in the fragment',
  ).toBe(true)
  await expect(page.getByRole('heading', { name: fixture.eventTitle, exact: true })).toBeVisible()
  await expect
    .poll(() => page.url() === `${app.url}/route/continue`, {
      message: 'The continuation page clears the private fragment',
    })
    .toBe(true)
  await pickSlot(page, page)
  await page.getByLabel('Your name', { exact: true }).fill('Synthetic routing invitee')
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(inviteeEmail)
  const topic = page.getByLabel(bookingLabel)
  await expect(topic).toHaveValue(intakeAnswer)
  await topic.fill(bookingAnswer)
  const committing = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/v1/routing-continuations/bookings',
  )
  await page.getByRole('button', { name: 'Confirm booking', exact: true }).click()
  const committed = await committing
  expect(committed.status()).toBe(201)
  const result = (await committed.json()) as Schemas['RoutedBookingResult']
  expect(
    !Object.hasOwn(result, 'successRedirect') &&
      !JSON.stringify(result).includes(fixture.hiddenSlug),
    'The confirmation does not expose the selected address or its after-booking redirect',
  ).toBe(true)
  await expect(page.getByRole('heading', { name: 'You’re booked', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Continue', exact: true })).toHaveCount(0)
  const manage = URL.parse(
    await page.getByLabel('Your link to change or cancel this booking').inputValue(),
  )
  if (manage?.origin !== app.url || manage.pathname !== '/booking' || !manage.hash)
    throw new Error('Expected a private link to manage the committed booking')

  await page.goto(`${app.url}/booking`)
  await expect(page.getByRole('heading', { name: 'Open your booking link' })).toBeVisible()
  const loading = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/v1/bookings/manage',
  )
  await page.evaluate((hash) => {
    window.location.hash = hash
  }, manage.hash)
  const loaded = await loading
  expect(loaded.status()).toBe(200)
  const managed = (await loaded.json()) as Schemas['ManagedBooking']
  expect(managed.routingAnswers).toEqual([
    { label: intakeLabel, answer: intakeAnswer },
    { label: 'Contact email', answer: inviteeEmail },
  ])
  const managedText = JSON.stringify(managed)
  expect(
    [fixture.id, fixture.ruleId, fixture.versionId, routeToken].some((value) =>
      managedText.includes(value),
    ),
    'The invitee projection omits routing identifiers and the continuation capability',
  ).toBe(false)
  const answers = page.getByRole('region', { name: 'Your routing form answers' })
  await expect(answers.getByText(intakeAnswer, { exact: true })).toBeVisible()
  await expect
    .poll(() => page.url() === `${app.url}/booking`, {
      message: 'The manage page clears the private fragment',
    })
    .toBe(true)
  expect(
    outbound.every(({ url, referrer }) =>
      [routeToken, result.manageToken, inviteeEmail, fixture.hiddenSlug].every(
        (value) => !value || (!url.includes(value) && !referrer?.includes(value)),
      ),
    ),
    'Public request URLs and referrers omit private capabilities, answers and the hidden target',
  ).toBe(true)

  await app.auditSignIn(true)
  await page.goto(app.url + bookingPath(result.booking.id))
  await expect(
    page.getByRole('region', { name: 'Original routing answers' }).getByText(intakeAnswer),
  ).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Final booking answers' }).getByText(bookingAnswer),
  ).toBeVisible()

  await page.goto(app.url + PATHS.bookings)
  await page.getByText('Export bookings as CSV', { exact: true }).press('Enter')
  const day = result.booking.start.slice(0, 10)
  await page.getByLabel('Bookings starting at or after (UTC)').fill(`${day}T00:00`)
  await page.getByLabel('Bookings starting before (UTC)').fill(`${day}T23:59`)
  const include = page.getByRole('checkbox', { name: 'Include routing form answers' })
  await expect(include).not.toBeChecked()
  const ordinaryCsv = await downloadCsv(page)
  expect(ordinaryCsv).toContain(bookingAnswer)
  expect(ordinaryCsv).not.toContain('routing_answers')
  expect(ordinaryCsv).not.toContain(intakeAnswer)
  await include.check()
  const routingCsv = await downloadCsv(page)
  expect(routingCsv).toContain('routing_answers')
  expect(routingCsv).toContain(intakeLabel)
  expect(routingCsv).toContain(intakeAnswer)
  expect(routingCsv).toContain(fixture.ruleId)
})
