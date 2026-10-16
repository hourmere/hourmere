import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { EventType } from '../../api/resources.ts'
import {
  emptyAccount,
  fakeApi,
  json,
  later,
  profile,
  type Routes,
  renderApp,
  signedIn,
} from '../../test/fake-api.tsx'
import {
  EVENT_TYPE_ID,
  eventType,
  OTHER_SCHEDULE_ID,
  SCHEDULE_ID,
  schedule,
} from '../../test/fixtures.ts'
import { LEAVE_WITH_UNSAVED_CHANGES } from '../../unsaved-changes.tsx'

const location = () => screen.getByTestId('location').textContent
const field = (name: string | RegExp) => screen.getByLabelText<HTMLInputElement>(name)

/** The event type endpoints over an in-memory list, plus profile and schedules. */
function eventTypeServer(
  initial: EventType[] = [eventType()],
  extra: Routes = {},
): ReturnType<typeof fakeApi> {
  let list = [...initial]
  return fakeApi({
    ...signedIn,
    ...profile(),
    'GET /api/v1/schedules': () =>
      json(200, {
        data: [schedule(), schedule({ id: OTHER_SCHEDULE_ID, name: 'Evenings', isDefault: false })],
      }),
    'GET /api/v1/event-types': () => json(200, { data: list }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => {
      const found = list.find((e) => e.id === EVENT_TYPE_ID)
      return found ? json(200, found) : json(404, { error: 'event_type_not_found' })
    },
    'POST /api/v1/event-types': ({ body }) => {
      const created = eventType({
        ...(body as Partial<EventType>),
        id: 'e0000000-0000-7000-8000-000000000002',
      })
      list = [...list, created]
      return json(201, created)
    },
    [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: ({ body }) => {
      const updated = { ...(list[0] as EventType), ...(body as Partial<EventType>) }
      list = [updated, ...list.slice(1)]
      return json(200, updated)
    },
    [`DELETE /api/v1/event-types/${EVENT_TYPE_ID}`]: () => {
      list = list.filter((e) => e.id !== EVENT_TYPE_ID)
      return new Response(null, { status: 204 })
    },
    ...extra,
  })
}

async function openNew() {
  renderApp('/app/event-types/new')
  return screen.findByRole('heading', { name: 'New event type', level: 1 })
}

async function openExisting() {
  renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
  return screen.findByRole('heading', { name: 'Edit “Intro call”', level: 1 })
}

describe('the event types list', () => {
  it('lists event types with duration, status and a booking link to copy', async () => {
    const user = userEvent.setup()
    eventTypeServer([
      eventType(),
      eventType({
        id: 'e0000000-0000-7000-8000-000000000003',
        slug: 'deep-dive',
        title: 'Deep dive',
        durationMinutes: 90,
        isActive: false,
      }),
    ])
    renderApp('/app/event-types')
    const intro = (await screen.findByRole('rowheader', { name: 'Intro call' })).closest('tr')
    const cells = within(intro as HTMLElement)
    expect(cells.getByText('30 min')).toBeDefined()
    expect(cells.getByText('Active')).toBeDefined()
    const link = cells.getByRole('link', { name: /\/ada\/intro-call/ })
    expect(link.getAttribute('href')).toBe(`${window.location.origin}/ada/intro-call`)
    expect(link.getAttribute('target')).toBe('_blank')
    await user.click(cells.getByRole('button', { name: 'Copy link for Intro call' }))
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/ada/intro-call`)

    const deep = within(
      screen.getByRole('rowheader', { name: 'Deep dive' }).closest('tr') as HTMLElement,
    )
    expect(deep.getByText('1 h 30 min')).toBeDefined()
    expect(deep.getByText('Inactive')).toBeDefined()
    expect(deep.getByRole('link', { name: 'Edit Deep dive' }).getAttribute('href')).toBe(
      '/app/event-types/e0000000-0000-7000-8000-000000000003',
    )
    // Nothing is missing before people can book.
    expect(screen.queryByText(/Choose your handle/)).toBeNull()
  })

  it('says what is missing before anyone can book', async () => {
    fakeApi({ ...signedIn, ...emptyAccount })
    renderApp('/app/event-types')
    expect(await screen.findByText(/You have no event types yet/)).toBeDefined()
    expect(screen.getByRole('link', { name: 'Choose your handle' }).getAttribute('href')).toBe(
      '/app/settings',
    )
    expect(screen.getByRole('link', { name: 'Set your weekly hours' }).getAttribute('href')).toBe(
      '/app/availability/new',
    )
  })

  it('offers a retry when the list cannot be loaded', async () => {
    let up = false
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [] }),
      'GET /api/v1/event-types': () =>
        up ? json(200, { data: [] }) : json(500, { error: 'internal_error' }),
    })
    renderApp('/app/event-types')
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load/)
    up = true
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/You have no event types yet/)).toBeDefined()
  })
})

describe('creating an event type', () => {
  it('sends every setting the form has', async () => {
    const user = userEvent.setup()
    const api = eventTypeServer([])
    await openNew()

    await user.type(field('Title'), 'Intro call')
    // The link follows the title until edited.
    expect(field('Booking link').value).toBe('intro-call')
    expect(screen.getByText(`${window.location.origin}/ada/intro-call`)).toBeDefined()
    await user.type(field(/Description/), 'Let us talk.{Enter}Bring questions.')
    await user.clear(field('Duration (minutes)'))
    await user.type(field('Duration (minutes)'), '45')
    await user.clear(field('Position'))
    await user.type(field('Position'), '2')
    await user.click(screen.getByRole('checkbox', { name: 'Active: invitees can book it' }))
    await user.selectOptions(screen.getByLabelText('Where the meeting happens'), 'phone')
    await user.type(field('Your phone number'), '+14155550123')
    await user.selectOptions(screen.getByLabelText('Schedule'), 'Evenings')
    await user.type(field(/Start times every/), '15')
    await user.clear(field('Minimum notice (minutes)'))
    await user.type(field('Minimum notice (minutes)'), '240')
    await user.type(field(/Booking window/), '60')
    await user.type(field(/Daily limit/), '4')
    await user.clear(field('Buffer before (minutes)'))
    await user.type(field('Buffer before (minutes)'), '5')
    await user.clear(field('Buffer after (minutes)'))
    await user.type(field('Buffer after (minutes)'), '10')
    await user.click(screen.getByRole('button', { name: 'Create event type' }))

    expect(await screen.findByText('Created “Intro call”.')).toBeDefined()
    expect(location()).toBe('/app/event-types')
    expect(api.to('POST /api/v1/event-types').map((c) => c.body)).toEqual([
      {
        title: 'Intro call',
        slug: 'intro-call',
        description: 'Let us talk.\nBring questions.',
        durationMinutes: 45,
        slotStepMinutes: 15,
        bufferBeforeMinutes: 5,
        bufferAfterMinutes: 10,
        minimumNoticeMinutes: 240,
        maxBookingsPerDay: 4,
        bookingWindowDays: 60,
        location: { kind: 'phone', number: '+14155550123' },
        questions: [],
        scheduleId: OTHER_SCHEDULE_ID,
        position: 2,
        isActive: false,
      },
    ])
  })

  it.each([
    ['google_meet', { kind: 'google_meet' }],
    ['zoom', { kind: 'zoom' }],
    ['in_person', { kind: 'in_person', address: 'Unter den Linden 1, Berlin' }],
    ['link', { kind: 'link', url: 'https://meet.example.com/ada' }],
  ])('sends a %s location', async (kind, expected) => {
    const user = userEvent.setup()
    const api = eventTypeServer([])
    await openNew()
    await user.type(field('Title'), 'Chat')
    await user.selectOptions(screen.getByLabelText('Where the meeting happens'), kind)
    if (kind === 'in_person') await user.type(field('Address'), 'Unter den Linden 1, Berlin')
    if (kind === 'link') await user.type(field('Meeting link'), 'https://meet.example.com/ada')
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    await screen.findByText('Created “Chat”.')
    expect(api.to('POST /api/v1/event-types')[0]?.body).toMatchObject({
      location: expected,
      scheduleId: null,
      slotStepMinutes: null,
      bookingWindowDays: null,
      maxBookingsPerDay: null,
      description: null,
    })
  })

  it('checks the form before sending, and leads to each problem', async () => {
    const user = userEvent.setup()
    const api = eventTypeServer([])
    await openNew()
    await user.type(field('Booking link'), 'Not A Slug')
    await user.clear(field('Duration (minutes)'))
    await user.type(field('Duration (minutes)'), '0')
    await user.type(field(/Daily limit/), '1.5')
    await user.type(field(/Booking window/), '4000')
    await user.selectOptions(screen.getByLabelText('Where the meeting happens'), 'phone')
    await user.type(field('Your phone number'), '0301234567')
    await user.click(screen.getByRole('button', { name: 'Create event type' }))

    const summary = await screen.findByRole('alert')
    expect(document.activeElement).toBe(summary)
    expect(within(summary).getByRole('heading').textContent).toBe('Please check the form')
    const problems = within(summary)
      .getAllByRole('link')
      .map((a) => a.textContent)
    expect(problems).toEqual([
      'Title: Enter a title.',
      'Booking link: Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.',
      'Duration: Enter a number from 1 to 1,440.',
      'Daily limit: Enter a whole number.',
      'Booking window: Enter a number from 1 to 3,650.',
      'Phone number: Enter the number in international format, e.g. +14155550123.',
    ])
    expect(field('Title').getAttribute('aria-invalid')).toBe('true')
    expect(field('Title').getAttribute('aria-describedby')).toContain('title-error')
    expect(document.getElementById('title-error')?.textContent).toBe('Error: Enter a title.')

    await user.click(within(summary).getByRole('link', { name: /Duration/ }))
    expect(document.activeElement).toBe(field('Duration (minutes)'))
    expect(api.to('POST /api/v1/event-types')).toHaveLength(0)
  })

  it.each([
    [
      'slug_taken',
      json(409, {
        error: 'slug_taken',
        message: 'Another event type on this page already uses this slug',
      }),
      'Booking link',
      'Another of your event types already uses this link. Choose another.',
    ],
    [
      'invalid_slug',
      json(400, { error: 'invalid_slug', message: 'slug must be …' }),
      'Booking link',
      'Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.',
    ],
    [
      'invalid_event_type (a rule)',
      json(400, {
        error: 'invalid_event_type',
        message: 'durationMinutes must be a whole number from 1 to 1440, got 30',
      }),
      'Duration (minutes)',
      'Enter a number from 1 to 1,440.',
    ],
    [
      'invalid_location',
      json(400, {
        error: 'invalid_location',
        message: 'location.url must be an http or https URL of at most 2000 characters',
      }),
      'Meeting link',
      'Enter an http or https link of up to 2000 characters.',
    ],
    [
      'invalid_schedule_id',
      json(400, {
        error: 'invalid_schedule_id',
        message: "scheduleId must be one of the host's schedules",
      }),
      'Schedule',
      'This schedule no longer exists. Choose another one.',
    ],
  ])('shows the server refusing it (%s) at the field', async (_, response, label, message) => {
    const user = userEvent.setup()
    eventTypeServer([], { 'POST /api/v1/event-types': () => response })
    await openNew()
    await user.type(field('Title'), 'Intro call')
    await user.selectOptions(screen.getByLabelText('Where the meeting happens'), 'link')
    await user.type(field('Meeting link'), 'https://meet.example.com/ada')
    await user.click(screen.getByRole('button', { name: 'Create event type' }))

    const summary = await screen.findByRole('alert')
    expect(summary.textContent).toContain(message)
    const control = screen.getByLabelText(label)
    expect(control.getAttribute('aria-invalid')).toBe('true')
    const errorId = control
      .getAttribute('aria-describedby')
      ?.split(' ')
      .find((id) => id.endsWith('-error'))
    expect(document.getElementById(errorId ?? '')?.textContent).toBe(`Error: ${message}`)
    expect(location()).toBe('/app/event-types/new')
  })

  it('shows a refusal that names no field for the whole form', async () => {
    const user = userEvent.setup()
    eventTypeServer([], {
      'POST /api/v1/event-types': () =>
        json(403, {
          error: 'insufficient_role',
          message: "Only the organization's owners and admins can manage its event types",
        }),
    })
    await openNew()
    await user.type(field('Title'), 'Intro call')
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    const summary = await screen.findByRole('alert')
    expect(within(summary).getByRole('heading').textContent).toBe('Could not save')
    expect(summary.textContent).toContain(
      "Could not save the event type. Only the organization's owners and admins can manage its event types",
    )
  })
})

describe('the questions editor', () => {
  const questionLabels = () =>
    screen.getAllByLabelText<HTMLInputElement>('Question').map((input) => input.value)

  it('adds, reorders and removes questions, with focus following', async () => {
    const user = userEvent.setup()
    const api = eventTypeServer([])
    await openNew()
    await user.type(field('Title'), 'Intro call')
    expect(screen.getByText('No extra questions.')).toBeDefined()

    for (const label of ['Company', 'Topic', 'Phone']) {
      await user.click(screen.getByRole('button', { name: 'Add a question' }))
      // Focus goes to the new question's label.
      expect(document.activeElement).toBe(screen.getAllByLabelText('Question').at(-1))
      await user.keyboard(label)
    }
    expect(questionLabels()).toEqual(['Company', 'Topic', 'Phone'])
    expect(screen.getByRole('button', { name: 'Move up: question 1, “Company”' })).toHaveProperty(
      'disabled',
      true,
    )

    await user.click(screen.getByRole('button', { name: 'Move up: question 3, “Phone”' }))
    expect(questionLabels()).toEqual(['Company', 'Phone', 'Topic'])
    // Focus stays on the moved question's button; the move is announced.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Move up: question 2, “Phone”' }),
    )
    expect(screen.getByText('Moved “Phone” to position 2 of 3.')).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Move up: question 2, “Phone”' }))
    expect(questionLabels()).toEqual(['Phone', 'Company', 'Topic'])
    // At the top, Move up is disabled: focus goes to Move down.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Move down: question 1, “Phone”' }),
    )

    await user.click(screen.getByRole('button', { name: 'Move down: question 2, “Company”' }))
    expect(questionLabels()).toEqual(['Phone', 'Topic', 'Company'])

    await user.click(screen.getByRole('button', { name: 'Remove question: question 1, “Phone”' }))
    expect(questionLabels()).toEqual(['Topic', 'Company'])
    expect(document.activeElement).toBe(screen.getAllByLabelText('Question')[0])
    expect(screen.getByText('Removed question 1, “Phone”.')).toBeDefined()

    await user.selectOptions(screen.getAllByLabelText('Answer type')[1] as HTMLElement, 'long_text')
    await user.click(screen.getAllByRole('checkbox', { name: 'Required' })[1] as HTMLElement)
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    await screen.findByText('Created “Intro call”.')
    expect(api.to('POST /api/v1/event-types')[0]?.body).toMatchObject({
      questions: [
        { id: 'topic', label: 'Topic', type: 'short_text', required: false },
        { id: 'company', label: 'Company', type: 'long_text', required: true },
      ],
    })
  })

  it('edits the options of choice questions', async () => {
    const user = userEvent.setup()
    const api = eventTypeServer([])
    await openNew()
    await user.type(field('Title'), 'Intro call')
    await user.click(screen.getByRole('button', { name: 'Add a question' }))
    await user.keyboard('Team size')
    await user.selectOptions(screen.getByLabelText('Answer type'), 'select')

    // A choice starts with one empty option.
    const options = screen.getByRole('group', { name: 'Options for question 1' })
    expect(within(options).getAllByRole('textbox')).toHaveLength(1)
    await user.type(within(options).getByLabelText('Option 1 of question 1'), '1–10')
    await user.click(within(options).getByRole('button', { name: 'Add an option' }))
    expect(document.activeElement).toBe(within(options).getByLabelText('Option 2 of question 1'))
    await user.keyboard('11–50')
    await user.click(within(options).getByRole('button', { name: 'Add an option' }))
    await user.keyboard('More')
    await user.click(
      within(options).getByRole('button', { name: 'Remove option 2, “11–50”, of question 1' }),
    )
    // Focus goes to the option that took its place.
    expect(document.activeElement).toBe(within(options).getByLabelText('Option 2 of question 1'))
    expect(
      within(options)
        .getAllByRole<HTMLInputElement>('textbox')
        .map((i) => i.value),
    ).toEqual(['1–10', 'More'])

    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    await screen.findByText('Created “Intro call”.')
    expect(api.to('POST /api/v1/event-types')[0]?.body).toMatchObject({
      questions: [
        { id: 'team-size', label: 'Team size', type: 'select', options: ['1–10', 'More'] },
      ],
    })
  })

  it('refuses empty and repeated options, and questions without a label', async () => {
    const user = userEvent.setup()
    const api = eventTypeServer([])
    await openNew()
    await user.type(field('Title'), 'Intro call')
    await user.click(screen.getByRole('button', { name: 'Add a question' }))
    await user.click(screen.getByRole('button', { name: 'Add a question' }))
    await user.keyboard('Interests')
    await user.selectOptions(
      screen.getAllByLabelText('Answer type')[1] as HTMLElement,
      'multi_select',
    )
    await user.type(screen.getByLabelText('Option 1 of question 2'), 'Billing')
    await user.click(screen.getByRole('button', { name: 'Add an option' }))
    await user.keyboard('Billing')
    await user.click(screen.getByRole('button', { name: 'Add an option' }))
    await user.click(screen.getByRole('button', { name: 'Create event type' }))

    const summary = await screen.findByRole('alert')
    expect(
      within(summary)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual([
      'Question 1: Enter a question.',
      'Question 2, option 2: This option is already in the list.',
      'Question 2, option 3: Enter an option.',
    ])
    expect(screen.getByLabelText('Option 2 of question 2').getAttribute('aria-invalid')).toBe(
      'true',
    )
    expect(api.to('POST /api/v1/event-types')).toHaveLength(0)
  })

  it('maps the server refusing a question to that question', async () => {
    const user = userEvent.setup()
    eventTypeServer([], {
      'POST /api/v1/event-types': () =>
        json(400, {
          error: 'invalid_questions',
          message:
            'questions.1.options.0: must be a single line of text without control characters',
        }),
    })
    await openNew()
    await user.type(field('Title'), 'Intro call')
    await user.click(screen.getByRole('button', { name: 'Add a question' }))
    await user.keyboard('Company')
    await user.click(screen.getByRole('button', { name: 'Add a question' }))
    await user.keyboard('Plan')
    await user.selectOptions(screen.getAllByLabelText('Answer type')[1] as HTMLElement, 'select')
    await user.type(screen.getByLabelText('Option 1 of question 2'), 'Pro')
    await user.click(screen.getByRole('button', { name: 'Create event type' }))

    const summary = await screen.findByRole('alert')
    expect(summary.textContent).toContain(
      'Question 2, option 1: must be a single line of text without control characters',
    )
    expect(screen.getByLabelText('Option 1 of question 2').getAttribute('aria-invalid')).toBe(
      'true',
    )
  })
})

describe('editing an event type', () => {
  const saved = eventType({
    description: 'A first call.',
    durationMinutes: 45,
    location: { kind: 'in_person', address: 'Unter den Linden 1' },
    scheduleId: SCHEDULE_ID,
    minimumNoticeMinutes: 1440,
    maxBookingsPerDay: 3,
    questions: [
      { id: 'company', label: 'Company', type: 'short_text', required: true },
      { id: 'plan', label: 'Plan', type: 'select', required: false, options: ['Free', 'Pro'] },
    ],
  })

  it('shows what is saved and saves changes', async () => {
    const user = userEvent.setup()
    const api = eventTypeServer([saved])
    await openExisting()
    expect(field('Title').value).toBe('Intro call')
    expect(field('Address').value).toBe('Unter den Linden 1')
    expect(field('Minimum notice (minutes)').value).toBe('1440')
    expect(screen.getByText(/= 1 day\./)).toBeDefined()
    expect(screen.getByLabelText<HTMLSelectElement>('Schedule').value).toBe(SCHEDULE_ID)

    await user.clear(field('Title'))
    await user.type(field('Title'), 'First call')
    // Editing the title of a saved event type leaves its link alone.
    expect(field('Booking link').value).toBe('intro-call')
    expect(screen.getByText('Unsaved changes')).toBeDefined()
    await user.type(screen.getAllByLabelText('Question')[1] as HTMLElement, ' tier')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Saved.')).toBeDefined()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Edit “First call”')
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`).map((c) => c.body)).toEqual([
      {
        title: 'First call',
        slug: 'intro-call',
        description: 'A first call.',
        durationMinutes: 45,
        slotStepMinutes: null,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minimumNoticeMinutes: 1440,
        maxBookingsPerDay: 3,
        bookingWindowDays: null,
        location: { kind: 'in_person', address: 'Unter den Linden 1' },
        // Saved questions keep their ids, so earlier answers stay attached.
        questions: [
          { id: 'company', label: 'Company', type: 'short_text', required: true },
          {
            id: 'plan',
            label: 'Plan tier',
            type: 'select',
            required: false,
            options: ['Free', 'Pro'],
          },
        ],
        scheduleId: SCHEDULE_ID,
        position: 0,
        isActive: true,
      },
    ])
  })

  it('says when the event type does not exist', async () => {
    eventTypeServer([])
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    expect(await screen.findByRole('heading', { name: 'Event type not found' })).toBeDefined()
    expect(screen.getByRole('link', { name: 'Back to event types' }).getAttribute('href')).toBe(
      '/app/event-types',
    )
  })

  it('deletes it after confirmation', async () => {
    const user = userEvent.setup()
    const api = eventTypeServer([saved])
    await openExisting()
    await user.click(screen.getByRole('button', { name: 'Delete event type' }))
    const confirm = screen.getByRole('group', {
      name: /Delete “Intro call”\? This cannot be undone\./,
    })
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }))
    await user.keyboard('{Enter}')
    // Cancelled: back to the button, nothing deleted.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete event type' }))
    expect(api.to(`DELETE /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Delete event type' }))
    await user.click(
      within(screen.getByRole('group', { name: /Delete “Intro call”/ })).getByRole('button', {
        name: 'Delete event type',
      }),
    )
    expect(await screen.findByText('Deleted “Intro call”.')).toBeDefined()
    expect(location()).toBe('/app/event-types')
    expect(api.to(`DELETE /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(1)
    // The list loads again after the navigation.
    expect(await screen.findByText(/You have no event types yet/)).toBeDefined()
  })
})

describe('the unsaved-changes guard', () => {
  it('asks before a link leaves unsaved changes, and stays when told to', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    eventTypeServer([eventType()], {
      'GET /api/v1/bookings': () => json(200, { data: [], nextCursor: null }),
    })
    await openExisting()
    await user.type(field('Title'), ' (new)')

    await user.click(screen.getByRole('link', { name: 'Bookings' }))
    expect(confirm).toHaveBeenCalledWith(LEAVE_WITH_UNSAVED_CHANGES)
    expect(location()).toBe(`/app/event-types/${EVENT_TYPE_ID}`)
    expect(field('Title').value).toBe('Intro call (new)')

    // The page's own back link asks too.
    await user.click(screen.getByRole('link', { name: 'Back to event types' }))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(location()).toBe(`/app/event-types/${EVENT_TYPE_ID}`)

    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('link', { name: 'Bookings' }))
    expect(await screen.findByRole('heading', { name: 'Bookings', level: 1 })).toBeDefined()
    expect(location()).toBe('/app/bookings')
  })

  it('does not ask without changes, nor after saving them', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    eventTypeServer([eventType()])
    await openExisting()
    await user.type(field('Title'), '!')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    await user.click(screen.getByRole('link', { name: 'Back to event types' }))
    expect(await screen.findByRole('heading', { name: 'Event types', level: 1 })).toBeDefined()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('does not ask when changes are undone', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    eventTypeServer([eventType()])
    await openExisting()
    await user.click(screen.getByRole('button', { name: 'Add a question' }))
    await user.click(screen.getByRole('button', { name: 'Remove question: question 1' }))
    await user.click(screen.getByRole('link', { name: 'Back to event types' }))
    expect(await screen.findByRole('heading', { name: 'Event types', level: 1 })).toBeDefined()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks before signing out with unsaved changes', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const api = eventTypeServer([eventType()], {
      'POST /api/auth/sign-out': () => json(200, { success: true }),
    })
    await openExisting()
    await user.type(field('Title'), '!')
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(confirm).toHaveBeenCalledWith(LEAVE_WITH_UNSAVED_CHANGES)
    expect(api.to('POST /api/auth/sign-out')).toHaveLength(0)
  })

  it('has the browser ask before reloading or closing the tab', async () => {
    const user = userEvent.setup()
    eventTypeServer([eventType()])
    await openExisting()
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(unload()).toBe(false)
    await user.type(field('Title'), '!')
    expect(unload()).toBe(true)
    await user.clear(field('Title'))
    await user.type(field('Title'), 'Intro call')
    expect(unload()).toBe(false)
  })

  it('leaves new-tab clicks and links on the same page alone', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    eventTypeServer([eventType()])
    await openExisting()
    await user.clear(field('Title'))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const summary = await screen.findByRole('alert')
    // A link of the error summary (#title) stays on the page.
    await user.click(within(summary).getByRole('link'))
    expect(document.activeElement).toBe(field('Title'))
    // A click that opens a new tab leaves this page as it is.
    await user.keyboard('{Control>}')
    await user.click(screen.getByRole('link', { name: 'Bookings' }))
    await user.keyboard('{/Control}')
    expect(location()).toBe(`/app/event-types/${EVENT_TYPE_ID}`)
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('answers that arrive after leaving or editing on', () => {
  const disabled = (element: Element) => element.matches(':disabled')

  it('does not leave the page the person went to when a create finishes late', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const create = later()
    eventTypeServer([], { 'POST /api/v1/event-types': () => create.response })
    await openNew()
    await user.type(field('Title'), 'Intro call')
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDefined()

    // On to Settings (agreeing to leave), and editing there.
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    await user.type(await screen.findByLabelText('Handle'), '-l')
    await create.answer(json(201, eventType()))

    expect(location()).toBe('/app/settings')
    expect(field('Handle').value).toBe('ada-l')
    expect(screen.queryByText(/Created “Intro call”/)).toBeNull()
  })

  it('does not leave the page the person went to when a delete finishes late', async () => {
    const user = userEvent.setup()
    const remove = later()
    eventTypeServer([eventType()], {
      [`DELETE /api/v1/event-types/${EVENT_TYPE_ID}`]: () => remove.response,
    })
    await openExisting()
    await user.click(screen.getByRole('button', { name: 'Delete event type' }))
    await user.click(
      within(screen.getByRole('group', { name: /Delete “Intro call”/ })).getByRole('button', {
        name: 'Delete event type',
      }),
    )
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    await user.type(await screen.findByLabelText('Handle'), '-l')
    await remove.answer(new Response(null, { status: 204 }))

    expect(location()).toBe('/app/settings')
    expect(field('Handle').value).toBe('ada-l')
  })

  it('locks the form while saving, so no edit is overwritten by the answer', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const save = later()
    const api = eventTypeServer([eventType()], {
      [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: () => save.response,
    })
    await openExisting()
    await user.type(field('Title'), ' (new)')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    // Focus moves to the status, which says what is happening; the fields are locked.
    const status = screen.getByText('Saving…', { selector: '[role="status"]' })
    expect(document.activeElement).toBe(status)
    expect(disabled(field('Title'))).toBe(true)
    expect(disabled(screen.getByRole('button', { name: 'Add a question' }))).toBe(true)
    await user.type(field('Title'), ' again')
    await user.type(field(/Description/), 'Typed while saving')
    expect(field('Title').value).toBe('Intro call (new)')
    expect(field(/Description/).value).toBe('')

    // The server stores the title normalized (trimmed); the form shows what was saved.
    await save.answer(json(200, eventType({ title: 'Intro call (new)', description: null })))
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(1)
    expect(screen.getByText('Saved.')).toBeDefined()
    expect(disabled(field('Title'))).toBe(false)
    expect(field('Title').value).toBe('Intro call (new)')
    // Saved means nothing is left unsaved: leaving does not ask.
    await user.click(screen.getByRole('link', { name: 'Back to event types' }))
    expect(await screen.findByRole('heading', { name: 'Event types', level: 1 })).toBeDefined()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('unlocks the form with the edits kept when saving fails', async () => {
    const user = userEvent.setup()
    const save = later()
    eventTypeServer([eventType()], {
      [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: () => save.response,
    })
    await openExisting()
    await user.type(field('Title'), ' (new)')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await save.answer(json(500, { error: 'internal_error' }))
    expect(screen.getByRole('alert').textContent).toContain('Could not save the event type.')
    expect(disabled(field('Title'))).toBe(false)
    expect(field('Title').value).toBe('Intro call (new)')
    expect(screen.queryByText('Saving…', { selector: '[role="status"]' })).toBeNull()
    expect(screen.getByText('Unsaved changes')).toBeDefined()
  })

  it('keeps asking after a sign-out that failed', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    eventTypeServer([eventType()], {
      'POST /api/auth/sign-out': () => json(500, { message: 'Database unavailable' }),
    })
    await openExisting()
    await user.type(field('Title'), ' (new)')
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not sign out/)
    expect(confirm).toHaveBeenCalledTimes(1)

    // Still here with the draft, so leaving still asks.
    confirm.mockReturnValue(false)
    await user.click(screen.getByRole('link', { name: 'Bookings' }))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(location()).toBe(`/app/event-types/${EVENT_TYPE_ID}`)
    expect(field('Title').value).toBe('Intro call (new)')
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
  })
})
