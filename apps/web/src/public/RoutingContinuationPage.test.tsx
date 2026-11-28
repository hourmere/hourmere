import { interfaceLanguages } from '@hourmere/core/language'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../api/client.ts'
import { commonCatalogues } from '../i18n/catalogues.fixture.ts'
import { fakeApi, json } from '../test/fake-api.tsx'
import { booking, NEW_TOKEN, slot, TOKEN } from '../test/public-fixtures.ts'
import { selectPublicLanguage } from '../test/public-language.ts'
import { createRoutedBooking } from './api.ts'
import { RoutingContinuationPage } from './RoutingContinuationPage.tsx'

vi.mock('./env.ts', async (original) => ({
  ...(await original<typeof import('./env.ts')>()),
  detectTimeZone: () => 'UTC',
  preferredLocale: () => 'en-US',
  now: () => Date.parse('2026-11-01T12:00:00Z'),
}))

const endpoint = '/api/v1/routing-continuations'
const resolveRoute = `POST ${endpoint}/resolve`
const slotsRoute = `POST ${endpoint}/slots`
const bookingsRoute = `POST ${endpoint}/bookings`
const start = '2026-11-02T14:00:00.000Z'
const firstSlot = slot(start)
const projection: Schemas['RoutingContinuation'] = {
  eventType: {
    title: 'Private discovery call',
    description: 'Bring a short description of your project.',
    durationMinutes: 30,
    allowedDurationsMinutes: [30, 45],
    location: { kind: 'phone' },
    locations: [
      { id: 'default-phone', kind: 'phone', isDefault: true },
      { id: 'office', kind: 'in_person', label: 'Office' },
    ],
    host: { name: 'Ada Lovelace' },
    allowGuests: false,
    smsRemindersEnabled: false,
    questions: [
      { id: 'topic', label: 'Topic', type: 'short_text', required: true },
      { id: 'reference', label: 'Project reference', type: 'short_text', required: true },
    ],
  },
  prefill: {
    inviteeName: 'Original invitee',
    inviteeEmail: 'original@example.invalid',
    responses: { topic: 'Original topic' },
  },
  expiresAt: '2026-11-01T12:30:00.000Z',
}

const unavailableResponse = () =>
  json(409, { error: 'routing_unavailable', message: `Private capability ${TOKEN}` })
const slotsResponse = () => json(200, { slots: [firstSlot] })
const result = {
  booking: booking({ title: projection.eventType.title }),
  manageToken: NEW_TOKEN,
}

async function chooseTime(user: ReturnType<typeof userEvent.setup>) {
  const date = await screen.findByRole('button', { name: /November 2, available/ })
  await user.click(date)
  await user.click(within(screen.getByRole('list', { name: /^Times on/ })).getByRole('button'))
  return await screen.findByRole('heading', { name: 'Your details' })
}

describe('routing continuation', () => {
  it('books the hidden selection with keyboard navigation, editable prefill and no persistent storage', async () => {
    const user = userEvent.setup()
    const hiddenPath = '/ada/private-discovery'
    const redirect = 'https://example.invalid/after-booking'
    const title = 'جلسة (Private discovery)'
    const host = 'נועה (Noa 42)'
    const location = 'המשרד (Office 7)'
    const referenceLabel = 'رقم المشروع (Reference)'
    const updatedName = 'ليلى (Layla)'
    const updatedTopic = 'עדכון (Design) — agenda@example.invalid'
    const address = 'المكتب (Office 7), 42 Main Street'
    const description = ['شارك خطة المشروع.', 'Read the agenda (שלום).']
    const api = fakeApi({
      [resolveRoute]: () =>
        json(200, {
          ...projection,
          eventType: {
            ...projection.eventType,
            title,
            host: { name: host },
            description: description.join('\n'),
            locations: [
              { id: 'default-phone', kind: 'phone', isDefault: true },
              { id: 'office', kind: 'in_person', label: location },
            ],
            questions: [
              ...projection.eventType.questions.slice(0, 1),
              { id: 'reference', label: referenceLabel, type: 'short_text', required: true },
            ],
          },
        }),
      [slotsRoute]: ({ body }) =>
        json(200, {
          slots: [slot(start, (body as Schemas['RoutingContinuationSlotsInput']).durationMinutes)],
        }),
      [bookingsRoute]: () =>
        json(201, {
          ...result,
          booking: {
            ...result.booking,
            title,
            assignedHost: { name: host, timeZone: 'Europe/Berlin' },
            location: { kind: 'in_person', address },
            end: slot(start, 45).end,
          },
          eventPath: hiddenPath,
          successRedirect: { url: redirect, allowEmbedParent: true },
        }),
    })
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem')
    const storageRead = vi.spyOn(Storage.prototype, 'getItem')
    const openDatabase = vi.fn()
    vi.stubGlobal('indexedDB', { open: openDatabase })
    render(<RoutingContinuationPage routeToken={TOKEN} />)

    const event = await screen.findByRole('complementary', { name: 'About this event' })
    expect(within(event).getByRole('heading', { name: title }).dir).toBe('auto')
    expect(within(event).getByText(host).tagName).toBe('BDI')
    expect(
      Array.from(event.querySelectorAll('.event-description bdi'), (value) => value.textContent),
    ).toEqual(description)
    const picker = screen.getByRole('heading', { name: 'Pick a time' })
    await waitFor(() => expect(document.activeElement).toBe(picker))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Phone call' }))
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole<HTMLInputElement>('radio', { name: location }).checked).toBe(true)
    expect(within(event).getByText(location).tagName).toBe('BDI')
    await user.click(screen.getByRole('radio', { name: '45 min' }))
    await user.click(screen.getByRole('button', { name: /^Time zone/ }))
    await user.type(screen.getByRole('combobox', { name: 'Search time zones' }), 'Berlin')
    await user.click(screen.getByRole('option', { name: /Europe\s*\/\s*Berlin/ }))

    const calendar = screen.getByRole('grid')
    await waitFor(() => expect(calendar.getAttribute('aria-busy')).toBe('false'))
    const today = within(calendar).getByRole('button', { name: /November 1, no times available/ })
    act(() => today.focus())
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(
      within(calendar).getByRole('button', { name: /November 2, available/ }),
    )
    await user.keyboard('{Enter}')
    const meetingTime = within(screen.getByRole('list', { name: /^Times on/ })).getByRole('button')
    act(() => meetingTime.focus())
    await user.keyboard('{Enter}')
    const details = await screen.findByRole('heading', { name: 'Your details' })
    expect(document.activeElement).toBe(details)
    const name = screen.getByRole<HTMLInputElement>('textbox', { name: 'Your name' })
    const email = screen.getByRole<HTMLInputElement>('textbox', { name: 'Email' })
    const topic = screen.getByRole<HTMLInputElement>('textbox', { name: 'Topic' })
    const reference = screen.getByRole<HTMLInputElement>('textbox', { name: referenceLabel })
    expect(name.value).toBe('Original invitee')
    expect(email.value).toBe('original@example.invalid')
    expect(topic.value).toBe('Original topic')
    expect(name.form?.getAttribute('autocomplete')).toBe('off')
    expect(name.form?.method).toBe('post')
    expect(name.getAttribute('autocomplete')).toBe('off')
    expect(email.getAttribute('autocomplete')).toBe('off')
    expect(name.dir).toBe('auto')
    expect(reference.dir).toBe('auto')
    expect(reference.getAttribute('aria-required')).toBe('true')
    fireEvent.change(name, { target: { value: updatedName } })
    fireEvent.change(email, { target: { value: 'updated@example.invalid' } })
    fireEvent.change(topic, { target: { value: updatedTopic } })

    await selectPublicLanguage(user, 'es')
    expect(screen.getByRole('textbox', { name: 'Su nombre' })).toBe(name)
    expect(name.value).toBe(updatedName)
    await selectPublicLanguage(user, 'en')

    act(() => details.focus())
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: location }))
    for (const control of [name, email, topic, reference]) {
      await user.tab()
      expect(document.activeElement).toBe(control)
    }
    const book = screen.getByRole('button', { name: 'Confirm booking' })
    await user.tab()
    expect(document.activeElement).toBe(book)
    await user.keyboard('{Enter}')
    const alert = await screen.findByRole('alert')
    expect(document.activeElement).toBe(alert)
    const errorLink = within(alert).getByRole('link', {
      name: `${referenceLabel}: This answer is required.`,
    })
    expect(errorLink.querySelector('bdi')?.textContent).toBe(referenceLabel)
    expect(reference.getAttribute('aria-invalid')).toBe('true')
    expect(
      screen.getByRole('textbox', {
        name: referenceLabel,
        description: 'This answer is required.',
      }),
    ).toBe(reference)
    expect(api.to(bookingsRoute)).toHaveLength(0)
    await user.click(errorLink)
    expect(document.activeElement).toBe(reference)
    await user.type(reference, 'PRJ-42')
    await user.tab()
    await user.keyboard('{Enter}')

    const confirmation = await screen.findByRole('heading', { name: 'You’re booked' })
    expect(document.activeElement).toBe(confirmation)
    const summary = confirmation.closest('.confirmation')
    expect(
      Array.from(summary?.querySelectorAll('dd bdi') ?? [], (value) => value.textContent),
    ).toEqual([title, address, host])
    expect(screen.queryByRole('link', { name: /continue/i })).toBeNull()
    for (const privateValue of [hiddenPath, redirect, TOKEN])
      expect(document.body.innerHTML).not.toContain(privateValue)
    expect(api.to(resolveRoute)).toMatchObject([{ body: { routeToken: TOKEN } }])
    expect(api.to(slotsRoute).at(-1)?.body).toMatchObject({
      routeToken: TOKEN,
      durationMinutes: 45,
      locationOptionId: 'office',
    })
    expect(api.to(bookingsRoute)).toMatchObject([
      {
        body: {
          routeToken: TOKEN,
          start,
          durationMinutes: 45,
          locationOptionId: 'office',
          invitee: {
            name: updatedName,
            email: 'updated@example.invalid',
            timeZone: 'Europe/Berlin',
            locale: 'en',
          },
          responses: { topic: updatedTopic, reference: 'PRJ-42' },
        },
      },
    ])
    expect(api.to(bookingsRoute)[0]?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i)
    const routedRequests = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => input as Request)
      .filter((request) => new URL(request.url).pathname.startsWith(endpoint))
    expect(routedRequests.length).toBeGreaterThanOrEqual(3)
    for (const request of routedRequests) {
      const url = new URL(request.url)
      expect(url.search + url.hash).toBe('')
      expect(request.cache).toBe('no-store')
      expect(request.referrerPolicy).toBe('no-referrer')
      expect(request.credentials).toBe('omit')
    }
    expect(storageWrite).not.toHaveBeenCalled()
    expect(storageRead).not.toHaveBeenCalled()
    expect(openDatabase).not.toHaveBeenCalled()
  })

  it('keeps the identical attempt when a successful booking response was lost', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const api = fakeApi({
      [resolveRoute]: () => json(200, projection),
      [slotsRoute]: slotsResponse,
      [bookingsRoute]: () => {
        attempts += 1
        if (attempts === 1) throw new TypeError('Failed to fetch')
        return json(200, { ...result, manageToken: null })
      },
    })
    render(<RoutingContinuationPage routeToken={TOKEN} />)
    await chooseTime(user)
    await user.type(screen.getByRole('textbox', { name: 'Project reference' }), 'PRJ-42')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Your booking is not confirmed yet.',
    )
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    expect(await screen.findByRole('heading', { name: 'You’re booked' })).toBeDefined()
    expect(screen.getByText(/Use the link in your confirmation email instead/)).toBeDefined()
    const [first, replay] = api.to(bookingsRoute)
    expect(first?.headers.has('Idempotency-Key')).toBe(true)
    expect(replay?.headers.get('Idempotency-Key')).toBe(first?.headers.get('Idempotency-Key'))
    expect(replay?.body).toEqual(first?.body)
  })

  it.each(['submitted', 'newly required'] as const)(
    'marks a rejected %s answer against the refreshed questions',
    async (kind) => {
      const user = userEvent.setup()
      const added = kind === 'newly required'
      const ticket = { id: 'ticket', label: 'Support ticket', type: 'short_text', required: true }
      const question = added ? ticket : { id: 'reference', label: 'Project reference' }
      const refreshed = added
        ? {
            ...projection,
            eventType: {
              ...projection.eventType,
              locations: [{ id: 'office', kind: 'in_person', label: 'Office' }],
              questions: [...projection.eventType.questions, ticket],
            },
          }
        : projection
      let rejected = false
      const message = `Unexpected private content ${TOKEN}`
      const api = fakeApi({
        [resolveRoute]: () => json(200, rejected ? refreshed : projection),
        [slotsRoute]: slotsResponse,
        [bookingsRoute]: () => {
          if (rejected) return json(201, result)
          rejected = true
          return json(400, {
            error: 'invalid_responses',
            field: `responses.${question.id}`,
            message,
          })
        },
      })
      render(<RoutingContinuationPage routeToken={TOKEN} />)
      await chooseTime(user)
      await user.type(screen.getByRole('textbox', { name: 'Project reference' }), 'PRJ-42')
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      if (added) await chooseTime(user)

      const alert = await screen.findByRole('alert')
      expect(document.activeElement).toBe(alert)
      const link = within(alert).getByRole('link', {
        name: `${question.label}: Check this answer.`,
      })
      const field = screen.getByRole<HTMLInputElement>('textbox', {
        name: question.label,
        description: 'Check this answer.',
      })
      expect(field.getAttribute('aria-invalid')).toBe('true')
      expect(field.value).toBe(added ? '' : 'PRJ-42')
      expect(screen.queryByText(/This form has changed/)).toBeNull()
      expect(document.body.textContent).not.toContain(message)
      expect(api.to(resolveRoute)).toHaveLength(2)
      await user.click(link)
      expect(document.activeElement).toBe(field)
      fireEvent.change(field, { target: { value: 'PRJ-43' } })
      expect(field.getAttribute('aria-invalid')).toBeNull()
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))

      expect(await screen.findByRole('heading', { name: 'You’re booked' })).toBeDefined()
      expect(api.to(bookingsRoute).at(-1)?.body).toMatchObject({
        start,
        responses: { topic: 'Original topic', [question.id]: 'PRJ-43' },
      })
    },
  )

  it('discards prose in the field of a private booking error', async () => {
    const user = userEvent.setup()
    const field = 'responses.Unexpected private detail'
    const message = 'Unfiltered server error detail'
    fakeApi({
      [resolveRoute]: () => json(200, projection),
      [slotsRoute]: slotsResponse,
      [bookingsRoute]: () => json(400, { error: 'invalid_responses', field, message }),
    })

    await expect(
      createRoutedBooking(
        {
          routeToken: TOKEN,
          start,
          durationMinutes: 30,
          invitee: { name: 'Test invitee', email: 'invitee@example.invalid', timeZone: 'UTC' },
          responses: { topic: 'Original topic', reference: 'PRJ-42' },
        },
        crypto.randomUUID(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: 'PublicRequestError',
      code: 'invalid_responses',
      field: undefined,
    })

    render(<RoutingContinuationPage routeToken={TOKEN} />)
    await chooseTime(user)
    const reference = screen.getByRole('textbox', { name: 'Project reference' })
    await user.type(reference, 'PRJ-42')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))

    expect(
      await screen.findByText('This form has changed. Review your answers before continuing.'),
    ).toBeDefined()
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull()
    expect(document.body.textContent).not.toContain(field)
    expect(document.body.textContent).not.toContain(message)
  })

  it('refreshes changed questions and keeps compatible answers and the chosen time', async () => {
    const user = userEvent.setup()
    let changed = false
    const previous = {
      ...projection,
      eventType: {
        ...projection.eventType,
        questions: [
          ...projection.eventType.questions,
          {
            id: 'track',
            label: 'Track',
            type: 'multi_select',
            required: false,
            options: ['A', 'B'],
          },
          {
            id: 'choice',
            label: 'Choice',
            type: 'select',
            required: false,
            options: ['Old', 'New'],
          },
        ],
      },
    } satisfies Schemas['RoutingContinuation']
    const updated = {
      ...previous,
      eventType: {
        ...previous.eventType,
        questions: [
          { id: 'topic', label: 'Updated topic', type: 'short_text', required: true },
          {
            id: 'track',
            label: 'Track',
            type: 'multi_select',
            required: false,
            options: ['A', 'C'],
          },
          { id: 'choice', label: 'Choice', type: 'select', required: false, options: ['New'] },
          { id: 'reference', label: 'New reference', type: 'checkbox', required: true },
        ],
      },
    } satisfies Schemas['RoutingContinuation']
    const api = fakeApi({
      [resolveRoute]: () => json(200, changed ? updated : previous),
      [slotsRoute]: slotsResponse,
      [bookingsRoute]: () => {
        if (changed) return json(201, result)
        changed = true
        return json(400, { error: 'invalid_responses', field: `responses.${TOKEN}` })
      },
    })
    render(<RoutingContinuationPage routeToken={TOKEN} />)
    await chooseTime(user)
    fireEvent.change(screen.getByRole('textbox', { name: 'Your name' }), {
      target: { value: 'Edited name' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Topic' }), {
      target: { value: 'Edited topic' },
    })
    await user.type(screen.getByRole('textbox', { name: 'Project reference' }), 'PRJ-42')
    await user.click(screen.getByRole('checkbox', { name: 'A' }))
    await user.click(screen.getByRole('checkbox', { name: 'B' }))
    await user.selectOptions(screen.getByRole('combobox', { name: /^Choice/ }), 'Old')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))

    expect(
      await screen.findByText('This form has changed. Review your answers before continuing.'),
    ).toBeDefined()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Your name' }).value).toBe(
      'Edited name',
    )
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Updated topic' }).value).toBe(
      'Edited topic',
    )
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'A' }).checked).toBe(true)
    expect(screen.queryByRole('checkbox', { name: 'B' })).toBeNull()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: /^Choice/ }).value).toBe('')
    const reference = screen.getByRole<HTMLInputElement>('checkbox', { name: 'New reference' })
    expect(reference.checked).toBe(false)
    expect(document.body.innerHTML).not.toContain(TOKEN)
    await user.click(reference)
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))

    expect(await screen.findByRole('heading', { name: 'You’re booked' })).toBeDefined()
    const [first, second] = api.to(bookingsRoute)
    expect(second?.headers.get('Idempotency-Key')).not.toBe(first?.headers.get('Idempotency-Key'))
    const body = second?.body as Schemas['RoutedBookingInput'] | undefined
    expect(body?.start).toBe(start)
    expect(body?.responses).toEqual({ topic: 'Edited topic', track: ['A'], reference: true })
    expect(api.to(resolveRoute)).toHaveLength(2)
  })

  it('returns to the picker when the submitted meeting length is no longer offered', async () => {
    const user = userEvent.setup()
    let changed = false
    const api = fakeApi({
      [resolveRoute]: () =>
        json(
          200,
          changed
            ? {
                ...projection,
                eventType: {
                  ...projection.eventType,
                  durationMinutes: 60,
                  allowedDurationsMinutes: [60, 90],
                },
              }
            : projection,
        ),
      [slotsRoute]: ({ body }) =>
        json(200, {
          slots: [slot(start, (body as Schemas['RoutingContinuationSlotsInput']).durationMinutes)],
        }),
      [bookingsRoute]: () => {
        changed = true
        return json(422, { error: 'invalid_duration' })
      },
    })
    render(<RoutingContinuationPage routeToken={TOKEN} />)
    await user.click(await screen.findByRole('radio', { name: '45 min' }))
    await chooseTime(user)
    await user.type(screen.getByRole('textbox', { name: 'Project reference' }), 'PRJ-42')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))

    expect(await screen.findByRole('heading', { name: 'Pick a time' })).toBeDefined()
    expect(
      screen.getByText('This meeting length is no longer offered. Please choose a time again.'),
    ).toBeDefined()
    expect(screen.queryByRole('radio', { name: '45 min' })).toBeNull()
    await chooseTime(user)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Project reference' }).value).toBe(
      'PRJ-42',
    )
    expect(api.to(resolveRoute)).toHaveLength(2)
    expect(api.to(slotsRoute).at(-1)?.body).toMatchObject({ durationMinutes: 60 })
  })

  it('refreshes a stale location while loading slots and keeps the draft', async () => {
    const user = userEvent.setup()
    let changed = false
    const api = fakeApi({
      [resolveRoute]: () =>
        json(
          200,
          changed
            ? {
                ...projection,
                eventType: {
                  ...projection.eventType,
                  locations: [{ id: 'default-phone', kind: 'phone', isDefault: true }],
                },
              }
            : projection,
        ),
      [slotsRoute]: ({ body }) =>
        changed && (body as Schemas['RoutingContinuationSlotsInput']).locationOptionId === 'office'
          ? json(422, { error: 'invalid_location_choice' })
          : slotsResponse(),
    })
    render(<RoutingContinuationPage routeToken={TOKEN} />)
    await user.click(await screen.findByRole('radio', { name: 'Office' }))
    await chooseTime(user)
    await user.type(screen.getByRole('textbox', { name: 'Project reference' }), 'PRJ-42')
    changed = true
    await user.click(screen.getByRole('button', { name: 'Change time' }))

    expect(await screen.findByText('Choose one of the available locations.')).toBeDefined()
    expect(screen.queryByRole('radio', { name: 'Office' })).toBeNull()
    await chooseTime(user)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Project reference' }).value).toBe(
      'PRJ-42',
    )
    expect(api.to(resolveRoute)).toHaveLength(2)
    expect(api.to(slotsRoute).at(-1)?.body).toMatchObject({ locationOptionId: 'default-phone' })
  })

  it('shows the usual recovery if the link expires while refreshing', async () => {
    let changed = false
    const api = fakeApi({
      [resolveRoute]: () => (changed ? unavailableResponse() : json(200, projection)),
      [slotsRoute]: () => {
        changed = true
        return json(422, { error: 'invalid_duration' })
      },
    })
    render(<RoutingContinuationPage routeToken={TOKEN} />)
    expect(
      await screen.findByRole('heading', { name: 'This booking link is unavailable' }),
    ).toBeDefined()
    expect(api.to(resolveRoute)).toHaveLength(2)
    expect(document.body.innerHTML).not.toContain(TOKEN)
  })

  it('keeps waitlist controls and direct event addresses out of an empty routed picker', async () => {
    const hiddenPath = '/ada/private-discovery'
    const api = fakeApi({
      [resolveRoute]: () => json(200, projection),
      [slotsRoute]: () => json(200, { slots: [] }),
    })
    render(<RoutingContinuationPage routeToken={TOKEN} />)
    expect(await screen.findByText('No available times this month.')).toBeDefined()
    expect(screen.queryByRole('button', { name: /waitlist/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /waitlist/i })).toBeNull()
    expect(api.to(slotsRoute).length).toBeGreaterThan(0)
    expect(document.body.innerHTML).not.toContain(hiddenPath)
  })

  it.each(['resolve', 'slots', 'bookings'] as const)(
    'shows the same recovery if the link is unusable on %s',
    async (endpointName) => {
      const user = userEvent.setup()
      const requestStarted = Promise.withResolvers<void>()
      const response = Promise.withResolvers<Response>()
      const rejectLink = () => {
        requestStarted.resolve()
        return response.promise
      }
      fakeApi({
        [resolveRoute]: endpointName === 'resolve' ? rejectLink : () => json(200, projection),
        [slotsRoute]: endpointName === 'slots' ? rejectLink : slotsResponse,
        [bookingsRoute]: rejectLink,
      })
      render(<RoutingContinuationPage routeToken={TOKEN} />)
      if (endpointName === 'bookings') {
        await chooseTime(user)
        await user.type(screen.getByRole('textbox', { name: 'Project reference' }), 'PRJ-42')
        await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      }
      // Wait for the request before answering in act, which flushes the heading's focus effect.
      await requestStarted.promise
      await act(async () => response.resolve(unavailableResponse()))
      const heading = screen.getByRole('heading', {
        name: 'This booking link is unavailable',
      })
      expect(document.activeElement).toBe(heading)
      expect(
        screen.getByText('Open the original form to request a new booking link.'),
      ).toBeDefined()
      expect(screen.queryByRole('heading', { name: projection.eventType.title })).toBeNull()
      expect(document.body.innerHTML).not.toContain(TOKEN)
    },
  )

  it('renders the recovery text in all shipped public languages', async () => {
    const user = userEvent.setup()
    const api = fakeApi({})
    render(<RoutingContinuationPage routeToken={null} />)
    for (const locale of interfaceLanguages('public')) {
      await selectPublicLanguage(user, locale)
      const recovery =
        commonCatalogues[`./catalogues/${locale}/common.ts`]?.[
          'Open the original form to request a new booking link.'
        ]
      expect(recovery).toBeTruthy()
      expect(screen.getByText(recovery ?? '')).toBeDefined()
    }
    expect(api.to(resolveRoute)).toHaveLength(0)
  })

  it('localizes the fallback without displaying private response prose', async () => {
    const user = userEvent.setup()
    fakeApi({
      [resolveRoute]: () => json(422, { error: 'unknown_error', message: `Private link ${TOKEN}` }),
    })
    render(<RoutingContinuationPage routeToken={TOKEN} />)
    expect((await screen.findByRole('alert')).textContent).toBe('That did not work. Try again.')
    await selectPublicLanguage(user, 'es')
    expect(screen.getByRole('alert').textContent).toBe('No ha funcionado. Vuelva a intentarlo.')
    expect(document.body.innerHTML).not.toContain(TOKEN)
  })
})
