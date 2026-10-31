import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { EventType } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import {
  emptyAccount,
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  type Routes,
  renderApp,
  signedIn,
  signedInAs,
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
const CREATED_ID = 'e0000000-0000-7000-8000-000000000002'

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
    'GET /api/v1/event-type-hosts': () =>
      json(200, { data: [{ id: ME.user.id, name: ME.user.name }], nextAfter: null }),
    'GET /api/v1/event-types': () => json(200, { data: list }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => {
      const found = list.find((e) => e.id === EVENT_TYPE_ID)
      return found ? json(200, found) : json(404, { error: 'event_type_not_found' })
    },
    [`GET /api/v1/event-types/${CREATED_ID}`]: () => {
      const found = list.find((e) => e.id === CREATED_ID)
      return found ? json(200, found) : json(404, { error: 'event_type_not_found' })
    },
    'POST /api/v1/event-types': ({ body }) => {
      const created = eventType({
        ...(body as Partial<EventType>),
        id: CREATED_ID,
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

describe('automatic Meet opt-in', () => {
  it('keeps a legacy provider label inert and disabled when the instance capability is off', async () => {
    const user = userEvent.setup()
    eventTypeServer([eventType({ location: { kind: 'google_meet' } })])
    await openExisting()
    const optIn = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Create a unique Google Meet link for each booking',
    })
    expect(optIn.checked).toBe(false)
    expect(optIn.disabled).toBe(true)
    await user.clear(field('Title'))
    await user.type(field('Title'), 'Metadata only')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
  })
  it('preserves an existing opt-in during metadata edits after flag-off, and allows an explicit opt-out', async () => {
    const user = userEvent.setup(),
      api = eventTypeServer([eventType({ location: { kind: 'google_meet', autoCreate: true } })])
    await openExisting()
    const optIn = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Create a unique Google Meet link for each booking',
    })
    expect(optIn.checked).toBe(true)
    expect(optIn.disabled).toBe(false)
    await user.clear(field('Title'))
    await user.type(field('Title'), 'Metadata only')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    const metadata = api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body
    expect(metadata).not.toHaveProperty('location')
    expect(metadata).not.toHaveProperty('scheduleId')
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', {
        name: 'Create a unique Google Meet link for each booking',
      }).checked,
    ).toBe(true)
    await user.click(optIn)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[1]?.body).toHaveProperty(
      'location',
      { kind: 'google_meet' },
    )
  })
})

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
    expect(screen.queryByRole('region', { name: 'Set up your booking page' })).toBeNull()
  })

  it('says what is missing before anyone can book', async () => {
    fakeApi({ ...signedIn, ...emptyAccount })
    renderApp('/app/event-types')
    expect(await screen.findByText(/You have no event types yet/)).toBeDefined()
    expect(
      screen
        .getByRole('link', { name: 'Create your first event type' })
        .classList.contains('button'),
    ).toBe(true)
    expect(screen.getByRole('link', { name: 'Complete your profile' }).getAttribute('href')).toBe(
      '/app/settings',
    )
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Use Monday–Friday, 09:00–17:00' })
        .disabled,
    ).toBe(true)
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
  it.each(['en', 'zh-CN'] as const)(
    'keeps the editor preview handle and slug separate in %s with a complete URL to copy',
    async (language) => {
      const user = userEvent.setup()
      chooseLanguage(language)
      const handle = 'alexandria-review-very-long-host-handle'
      const slug = 'paused-very-long-slug-for-the-booking-link-truncation-check-r3'
      eventTypeServer([eventType({ slug })], profile({ ...PROFILE, handle }))
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      await screen.findByRole('heading', {
        name: language === 'en' ? 'Edit “Intro call”' : '编辑“Intro call”',
        level: 1,
      })
      const preview = document.querySelector('.booking-link .preview')
      expect(preview?.classList.contains('booking-link-path')).toBe(true)
      expect(preview?.querySelector('.booking-link-handle')?.textContent).toBe(`/${handle}`)
      expect(preview?.querySelector('.booking-link-slug')?.textContent).toBe(`/${slug}`)
      expect(preview?.textContent).toBe(`/${handle}/${slug}`)
      expect(preview?.getAttribute('title')).toBe(`${window.location.origin}/${handle}/${slug}`)
      expect(preview?.querySelector('wbr')).toBeNull()
      await user.click(
        screen.getByRole('button', { name: language === 'en' ? 'Copy link' : '复制链接' }),
      )
      expect(await navigator.clipboard.readText()).toBe(
        `${window.location.origin}/${handle}/${slug}`,
      )
    },
  )

  it('separates the English minimum notice description, range and day equivalent with spaces', async () => {
    const user = userEvent.setup()
    eventTypeServer([])
    await openNew()
    const hint = document.getElementById('minimumNoticeMinutes-hint')
    expect(hint?.textContent).toBe('How far ahead a meeting must be booked. 0–525,600.')
    await user.clear(field('Minimum notice (minutes)'))
    await user.type(field('Minimum notice (minutes)'), '1440')
    expect(hint?.textContent).toBe('How far ahead a meeting must be booked. 0–525,600. = 1 day.')
  })

  it('translates the minimum notice and buffer hints in Simplified Chinese', async () => {
    chooseLanguage('zh-CN')
    eventTypeServer([])
    renderApp('/app/event-types/new')
    await screen.findByRole('heading', { name: '新活动类型', level: 1 })
    for (const [id, hint] of [
      ['minimumNoticeMinutes', '会议至少需要提前多久预约。'],
      ['bufferBeforeMinutes', '每次会议前保留的空闲时间。'],
      ['bufferAfterMinutes', '每次会议后保留的空闲时间。'],
    ]) {
      expect(document.getElementById(`${id}-hint`)?.textContent).toContain(hint)
    }
    expect(document.body.textContent).not.toMatch(/How far ahead|Free time kept/)
  })

  it('offers an optional random unlisted suffix on plain HTTP without changing the link until accepted', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.set([0x06, 0xbd, 0x00, 0x31])
        return bytes
      },
    })
    const api = eventTypeServer([])
    await openNew()
    await user.type(field('Title'), 'A private chat')
    await user.click(field('Hide from your booking page'))
    expect(field('Booking link').value).toBe('a-private-chat')
    expect(screen.queryByText('a-private-chat-06bd0031')).not.toBeNull()
    expect(screen.getByText(/Unlisted is not access control/)).toBeDefined()
    expect(screen.getByText(/This is optional/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    await screen.findByText('Created “A private chat”.')
    expect(api.to('POST /api/v1/event-types')[0]?.body).toHaveProperty('slug', 'a-private-chat')
  })

  it('uses a bounded suffix only when the host accepts it and keeps later title edits independent', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.set([0x06, 0xbd, 0x00, 0x31])
        return bytes
      },
    })
    eventTypeServer([])
    await openNew()
    await user.type(field('Title'), 'x'.repeat(64))
    await user.click(field('Hide from your booking page'))
    await user.click(screen.getByRole('button', { name: 'Use suggested link' }))
    const chosen = `${'x'.repeat(55)}-06bd0031`
    expect(field('Booking link').value).toBe(chosen)
    await user.type(field('Title'), ' changed')
    expect(field('Booking link').value).toBe(chosen)
    await user.click(field('Hide from your booking page'))
    expect(screen.queryByRole('button', { name: 'Use suggested link' })).toBeNull()
    expect(field('Booking link').value).toBe(chosen)
  })

  it('sends every setting the form has', async () => {
    const user = userEvent.setup()
    const api = eventTypeServer([])
    await openNew()

    await user.type(field('Title'), 'Intro call')
    // The link follows the title until edited.
    expect(field('Booking link').value).toBe('intro-call')
    expect(document.querySelector('.booking-link .preview')?.textContent).toBe('/ada/intro-call')
    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/ada/intro-call`)
    await user.type(field(/Description/), 'Let us talk.{Enter}Bring questions.')
    await user.clear(field('Duration (minutes)'))
    await user.type(field('Duration (minutes)'), '45')
    await user.clear(field('Position'))
    await user.type(field('Position'), '2')
    await user.click(screen.getByRole('checkbox', { name: 'Active: invitees can book it' }))
    expect(field('Allow invitees to add guests').checked).toBe(false)
    await user.click(field('Allow invitees to add guests'))
    expect(field('Hide from your booking page').checked).toBe(false)
    await user.click(field('Hide from your booking page'))
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
    expect(location()).toBe(`/app/event-types/${CREATED_ID}`)
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
        isHidden: true,
        allowGuests: true,
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
        { id: expect.any(String), label: 'Topic', type: 'short_text', required: false },
        { id: expect.any(String), label: 'Company', type: 'long_text', required: true },
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
        { id: expect.any(String), label: 'Team size', type: 'select', options: ['1–10', 'More'] },
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
        isHidden: false,
        allowGuests: false,
      },
    ])
  })

  it('loads guest opt-in, preserves unsaved opt-out across failure, and saves a retry', async () => {
    const user = userEvent.setup()
    let first = true
    const api = eventTypeServer([eventType({ allowGuests: true })], {
      [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: ({ body }) => {
        if (first) {
          first = false
          return json(503, { error: 'unavailable' })
        }
        return json(200, eventType(body as Partial<EventType>))
      },
    })
    await openExisting()
    expect(field('Allow invitees to add guests').checked).toBe(true)
    expect(
      screen.getByText(/changing this does not remove guests from existing bookings/),
    ).toBeDefined()
    await user.click(field('Allow invitees to add guests'))
    expect(screen.getByText('Unsaved changes')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('alert')
    expect(field('Allow invitees to add guests').checked).toBe(false)
    expect(screen.getByText('Unsaved changes')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`).map((c) => c.body)).toEqual([
      expect.objectContaining({ allowGuests: false }),
      expect.objectContaining({ allowGuests: false }),
    ])
  })

  it('loads and changes hidden state, preserves it on unrelated saves, and keeps the copy link', async () => {
    const user = userEvent.setup()
    const api = eventTypeServer([eventType({ isHidden: true })])
    await openExisting()
    expect(field('Hide from your booking page').checked).toBe(true)
    expect(
      screen.getByText(/Anyone who knows or guesses the direct link can still book it/),
    ).toBeDefined()
    await user.clear(field('Title'))
    await user.type(field('Title'), 'Unlisted call')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).toMatchObject({
      isHidden: true,
    })
    await user.click(screen.getByRole('link', { name: 'Back to event types' }))
    expect(await screen.findByText('Unlisted')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Copy link for Unlisted call' }))
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/ada/intro-call`)
    await user.click(screen.getByRole('link', { name: 'Edit Unlisted call' }))
    await screen.findByRole('heading', { name: 'Edit “Unlisted call”' })
    await user.click(field('Hide from your booking page'))
    expect(screen.getByText('Unsaved changes')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[1]?.body).toMatchObject({
      isHidden: false,
    })
  })

  it('uses a fresh identity after deleting, saving and re-adding a question with the same label', async () => {
    const user = userEvent.setup()
    const api = eventTypeServer([saved])
    await openExisting()
    await user.click(screen.getByRole('button', { name: 'Remove question: question 1, “Company”' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    await user.click(screen.getByRole('link', { name: 'Back to event types' }))
    await user.click(await screen.findByRole('link', { name: 'Edit Intro call' }))
    await screen.findByLabelText('Question')
    await user.click(screen.getByRole('button', { name: 'Add a question' }))
    await user.type(screen.getAllByLabelText('Question')[1] as HTMLElement, 'Company')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    const calls = api
      .to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)
      .map((call) => call.body as EventType)
    expect(calls).toHaveLength(2)
    const added = calls[1]?.questions[1]
    expect(added?.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(added?.id).not.toBe('company')
    expect(calls[1]?.questions[0]?.id).toBe('plan')
    await user.type(screen.getAllByLabelText('Question')[1] as HTMLElement, ' renamed')
    await user.click(screen.getByRole('button', { name: 'Move up: question 2, “Company renamed”' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    const renamed =
      api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`).map((call) => call.body as EventType)[2]
        ?.questions ?? []
    expect(renamed.map((q) => q.id)).toEqual([added?.id, 'plan'])
    expect(renamed[0]?.label).toBe('Company renamed')
  })

  it('reuses a new question identity when a failed save is retried', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const api = eventTypeServer([saved], {
      [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: ({ body }) =>
        ++attempts === 1
          ? json(500, { error: 'internal_error' })
          : json(200, { ...saved, ...(body as object) }),
    })
    await openExisting()
    await user.click(screen.getByRole('button', { name: 'Add a question' }))
    await user.type(screen.getAllByLabelText('Question')[2] as HTMLElement, 'Company')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    const [first, second] = api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)
    expect(second?.body).toEqual(first?.body)
    const questions = (second?.body as EventType | undefined)?.questions ?? []
    expect(questions[0]?.id).toBe('company')
    expect(questions[2]?.id).not.toBe('company')
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

    const link = screen.getByRole('link', { name: 'Bookings' })
    const click = createEvent.click(link)
    expect(fireEvent(link, click)).toBe(false)
    expect(click.defaultPrevented).toBe(true)
    expect(confirm).toHaveBeenCalledWith(LEAVE_WITH_UNSAVED_CHANGES)
    expect(location()).toBe(`/app/event-types/${EVENT_TYPE_ID}`)
    expect(field('Title').value).toBe('Intro call (new)')

    // The page's own back link asks too.
    expect(fireEvent.click(screen.getByRole('link', { name: 'Back to event types' }))).toBe(false)
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

describe('team booking links', () => {
  it('shares and previews a team link without requiring a personal profile', async () => {
    const user = userEvent.setup()
    const me = {
      ...ME,
      organization: { ...ME.organization, name: 'Cobaltmere', slug: 'Cobaltmere', personal: false },
    }
    eventTypeServer([eventType({ ownerUserId: null, organizationId: me.organization.id })], {
      ...signedInAs(me),
      'GET /api/v1/profile': () => json(404, { error: 'profile_not_found' }),
    })
    renderApp('/app/event-types')
    const row = within(
      (await screen.findByRole('rowheader', { name: 'Intro call' })).closest('tr') as HTMLElement,
    )
    const url = `${window.location.origin}/team/Cobaltmere/intro-call`
    expect(
      row.getByRole('link', { name: /team\/Cobaltmere\/intro-call/ }).getAttribute('href'),
    ).toBe(url)
    await user.click(row.getByRole('button', { name: 'Copy link for Intro call' }))
    expect(await navigator.clipboard.readText()).toBe(url)
    expect(screen.queryByText(/Choose your handle/)).toBeNull()
    await user.click(row.getByRole('link', { name: 'Edit Intro call' }))
    await screen.findByRole('heading', { name: 'Edit “Intro call”' })
    expect(document.querySelector('.booking-link .preview')?.textContent).toBe(
      new URL(url).pathname,
    )
    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(await navigator.clipboard.readText()).toBe(url)
  })
})

describe('unavailable team booking links', () => {
  it.each([
    { slug: 'Team_Name', mode: 'individual' },
    { slug: 'a'.repeat(65), mode: 'individual' },
    { slug: 'api', mode: 'individual' },
    { slug: 'Team', mode: 'round_robin' },
    { slug: 'Team', mode: 'collective' },
  ] as const)('does not advertise a dead link for $slug/$mode', async ({ slug, mode }) => {
    const user = userEvent.setup()
    const me = { ...ME, organization: { ...ME.organization, slug, personal: false } }
    eventTypeServer([eventType({ ownerUserId: null, schedulingType: mode })], {
      ...signedInAs(me),
      'GET /api/v1/profile': () => json(404, { error: 'profile_not_found' }),
    })
    renderApp('/app/event-types')
    const row = within(
      (await screen.findByRole('rowheader', { name: 'Intro call' })).closest('tr') as HTMLElement,
    )
    expect(row.queryByRole('button', { name: 'Copy link for Intro call' })).toBeNull()
    expect(row.queryByRole('link', { name: /\/team\// })).toBeNull()
    await user.click(row.getByRole('link', { name: 'Edit Intro call' }))
    await screen.findByRole('heading', { name: 'Edit “Intro call”' })
    expect(screen.queryByText(`${window.location.origin}/team/${slug}/intro-call`)).toBeNull()
    expect(
      screen.getByText(
        mode === 'individual'
          ? /Choose a non-reserved team slug/
          : mode === 'collective'
            ? 'Choose two to eight required hosts to get a collective booking link.'
            : 'Activate round robin to get a public booking link.',
      ),
    ).toBeDefined()
  })
})

describe('collective host assignment', () => {
  const secondId = '00000000-0000-7000-8000-000000000003'
  const me = {
    ...ME,
    organization: { ...ME.organization, name: 'Team', slug: 'Team', personal: false },
  }
  it('loads member pages, validates required hosts and saves a collective type with default schedules', async () => {
    const user = userEvent.setup()
    const calls = eventTypeServer([eventType({ ownerUserId: null })], {
      ...signedInAs(me),
      'GET /api/v1/event-type-hosts': ({ path }) =>
        path.includes('after=')
          ? json(200, { data: [{ id: secondId, name: 'Grace' }], nextAfter: null })
          : json(200, { data: [{ id: ME.user.id, name: 'Ada' }], nextAfter: ME.user.id }),
    })
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByRole('heading', { name: 'Edit “Intro call”' })
    await user.selectOptions(screen.getByLabelText('Scheduling'), 'collective')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.getAllByText('Choose two to eight required hosts.').length).toBeGreaterThan(0)
    expect(calls.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(0)
    await user.click(await screen.findByRole('button', { name: 'Load more members' }))
    await user.click(await screen.findByLabelText('Grace'))
    expect(screen.queryByLabelText('Schedule')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    const request = calls.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body
    expect(request).toMatchObject({
      schedulingType: 'collective',
      hosts: [{ userId: ME.user.id }, { userId: secondId }],
      scheduleId: null,
    })
    expect(calls.to('GET /api/v1/event-type-hosts')).toHaveLength(2)
  })
  it('requires an explicit organizer from paged selected hosts and keeps it out of metadata-only PATCH', async () => {
    const user = userEvent.setup()
    const calls = eventTypeServer(
      [
        eventType({
          ownerUserId: null,
          schedulingType: 'collective',
          hosts: [{ userId: ME.user.id }, { userId: secondId }],
          location: { kind: 'google_meet', autoCreate: true },
          conferenceOrganizer: { userId: secondId },
        }),
      ],
      {
        ...signedInAs(me),
        'GET /api/v1/instance': () =>
          json(200, { signup: { mode: 'closed' }, automaticGoogleMeet: true }),
        'GET /api/v1/event-type-hosts': ({ path }) =>
          path.includes('after=')
            ? json(200, { data: [{ id: secondId, name: 'Grace' }], nextAfter: null })
            : json(200, { data: [{ id: ME.user.id, name: 'Ada' }], nextAfter: ME.user.id }),
      },
    )
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByRole('heading', { name: 'Edit “Intro call”' })
    expect((screen.getByLabelText('Meeting organizer') as HTMLSelectElement).value).toBe(secondId)
    await user.clear(field('Title'))
    await user.type(field('Title'), 'Metadata panel')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(calls.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).not.toHaveProperty(
      'conferenceOrganizer',
    )
    await user.click(screen.getByRole('button', { name: 'Load more members' }))
    await screen.findByLabelText('Grace')
    await user.selectOptions(screen.getByLabelText('Meeting organizer'), '')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(
      screen.getAllByText('Choose the meeting organizer from the required hosts.').length,
    ).toBeGreaterThan(0)
    expect(calls.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(1)
    await user.selectOptions(screen.getByLabelText('Meeting organizer'), ME.user.id)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(calls.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[1]?.body).toHaveProperty(
      'conferenceOrganizer',
      { userId: ME.user.id },
    )
  })
  it('shows member directory failures and retries without losing existing configuration', async () => {
    const user = userEvent.setup()
    let attempt = 0
    eventTypeServer([eventType({ ownerUserId: null })], {
      ...signedInAs(me),
      'GET /api/v1/event-type-hosts': () =>
        ++attempt === 1
          ? json(403, { error: 'insufficient_role' })
          : json(200, { data: [{ id: ME.user.id, name: 'Ada' }], nextAfter: null }),
    })
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load team members')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(((await screen.findByLabelText('Ada')) as HTMLInputElement).checked).toBe(true)
  })
})

describe('round-robin pool and explicit activation', () => {
  const me = {
    ...ME,
    organization: { ...ME.organization, name: 'Team', slug: 'Cobaltmere', personal: false },
  }
  const base = (overrides: Partial<EventType> = {}) =>
    eventType({
      ownerUserId: null,
      schedulingType: 'round_robin',
      roundRobinActive: false,
      ...overrides,
    })
  it('saves only metadata for an unchanged zero-member pool and never activates it', async () => {
    const user = userEvent.setup()
    const calls = eventTypeServer([base({ hosts: [], scheduleId: SCHEDULE_ID })], {
      ...signedInAs(me),
    })
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByRole('heading', { name: 'Edit “Intro call”' })
    await user.type(field('Title'), ' updated')
    expect(
      (screen.getByRole('button', { name: 'Activate round robin' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    const body = calls.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body as Record<
      string,
      unknown
    >
    expect(body.title).toBe('Intro call updated')
    expect(body).not.toHaveProperty('hosts')
    expect(body).not.toHaveProperty('schedulingType')
    expect(body).not.toHaveProperty('scheduleId')
    expect(calls.to(`POST /api/v1/event-types/${EVENT_TYPE_ID}/round-robin/activate`)).toHaveLength(
      0,
    )
    expect(screen.getByText('Needs activation')).toBeDefined()
  })

  it('uses defaults explicitly, reports activation failure, then activates on a separate retry', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const calls = eventTypeServer([base({ scheduleId: SCHEDULE_ID })], {
      ...signedInAs(me),
      [`POST /api/v1/event-types/${EVENT_TYPE_ID}/round-robin/activate`]: () =>
        ++attempts === 1
          ? json(403, { error: 'insufficient_role' })
          : json(200, base({ roundRobinActive: true, scheduleId: null })),
    })
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByRole('heading', { name: 'Edit “Intro call”' })
    await user.click(screen.getByRole('button', { name: 'Use hosts’ default availability' }))
    await screen.findByText(
      'Default availability saved. Activate round robin separately when ready.',
    )
    expect(calls.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).toEqual({
      schedulingType: 'round_robin',
      hosts: [{ userId: ME.user.id }],
      scheduleId: null,
    })
    expect(attempts).toBe(0)
    await user.click(screen.getByRole('button', { name: 'Activate round robin' }))
    await screen.findByText(/Could not update round robin/)
    expect(screen.getByRole('button', { name: 'Activate round robin' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Activate round robin' }))
    await screen.findByText('Round robin activated.')
    expect(screen.queryByRole('button', { name: 'Activate round robin' })).toBeNull()
    expect(
      calls.to(`POST /api/v1/event-types/${EVENT_TYPE_ID}/round-robin/activate`).map((c) => c.body),
    ).toEqual([{}, {}])
  })

  it('removes an unavailable selected host without showing its private identity, then saves a current pool', async () => {
    const user = userEvent.setup(),
      stale = '00000000-0000-7000-8000-000000000099'
    const calls = eventTypeServer([base({ hosts: [{ userId: stale }] })], { ...signedInAs(me) })
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByRole('heading', { name: 'Edit “Intro call”' })
    expect(screen.queryByText(stale)).toBeNull()
    await user.click(await screen.findByRole('button', { name: 'Remove selected host 1' }))
    await user.click(await screen.findByLabelText('Ada'))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(calls.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).toMatchObject({
      schedulingType: 'round_robin',
      hosts: [{ userId: ME.user.id }],
      scheduleId: null,
    })
  })

  it('advertises activated pool links and leaves dormant pools awaiting activation', async () => {
    eventTypeServer([base({ roundRobinActive: true })], { ...signedInAs(me) })
    renderApp('/app/event-types')
    expect(await screen.findByRole('button', { name: 'Copy link for Intro call' })).toBeDefined()
    expect(screen.queryByText('Needs activation')).toBeNull()
  })
})

describe('explicit private Zoom opt-in', () => {
  const pin = '00000000-0000-7000-8000-000000000099'
  const connections = {
    zoomEnabled: true,
    zoomMeetingsEnabled: true,
    maximumConnections: 5,
    pendingAttempts: 0,
    data: [
      {
        id: pin,
        displayName: 'Settings',
        accountEmail: 'synthetic@hourmere.invalid',
        status: 'active',
        mode: 'meetings',
      },
      {
        id: 'identity-only',
        displayName: 'Identity only secret',
        status: 'active',
        mode: 'identity',
      },
    ],
  }
  const capability = {
    'GET /api/v1/instance': () =>
      json(200, { registrationMode: 'closed', socialProviders: [], automaticZoom: true }),
  }
  it('does not fetch private accounts for passive Zoom; requires an explicit account and retains draft when errors translate', async () => {
    const user = userEvent.setup(),
      api = eventTypeServer([eventType({ location: { kind: 'zoom' } })], {
        ...capability,
        'GET /api/v1/conference-connections': () => json(200, connections),
      })
    await openExisting()
    expect(api.to('GET /api/v1/conference-connections')).toHaveLength(0)
    await user.click(
      screen.getByRole('checkbox', { name: 'Create a unique Zoom meeting for each booking' }),
    )
    const select = await screen.findByLabelText('Zoom meetings account')
    expect((select as HTMLSelectElement).value).toBe('')
    expect(screen.queryByRole('option', { name: 'Identity only secret' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(
      await screen.findByText('Choose your own authorized Zoom meetings account.'),
    ).toBeDefined()
    await user.selectOptions(select, pin)
    await user.clear(field('Title'))
    await user.type(field('Title'), 'Settings')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).toMatchObject({
      location: { kind: 'zoom', autoCreate: true },
      zoomConnectionId: pin,
      title: 'Settings',
    })
  })
  it('retains an existing pin with flag-off metadata saves and explicit disable without a private list read', async () => {
    const user = userEvent.setup(),
      api = eventTypeServer([
        eventType({ location: { kind: 'zoom', autoCreate: true }, zoomConnectionId: pin }),
      ])
    await openExisting()
    await user.clear(field('Title'))
    await user.type(field('Title'), 'Metadata only')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    for (const key of ['location', 'hosts', 'zoomConnectionId', 'scheduleId'])
      expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).not.toHaveProperty(key)
    expect(api.to('GET /api/v1/conference-connections')).toHaveLength(0)
    await user.click(
      screen.getByRole('checkbox', { name: 'Create a unique Zoom meeting for each booking' }),
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[1]?.body).toMatchObject({
      location: { kind: 'zoom' },
    })
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[1]?.body).not.toHaveProperty(
      'zoomConnectionId',
    )
  })
  it('shows private list errors with an explicit retry without choosing or losing the selected draft', async () => {
    const user = userEvent.setup()
    let failed = true
    eventTypeServer([eventType({ location: { kind: 'zoom' } })], {
      ...capability,
      'GET /api/v1/conference-connections': () =>
        failed ? json(503, { error: 'failed' }) : json(200, connections),
    })
    await openExisting()
    await user.click(
      screen.getByRole('checkbox', { name: 'Create a unique Zoom meeting for each booking' }),
    )
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeDefined()
    failed = false
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('option', { name: 'Settings' })
    expect((screen.getByLabelText('Zoom meetings account') as HTMLSelectElement).value).toBe('')
  })
})

it('an API key principal cannot enable automatic Zoom or read the private connection picker', async () => {
  const user = userEvent.setup()
  const principal = {
    ...ME,
    principal: { kind: 'api_key' as const, apiKeyId: '00000000-0000-7000-8000-000000000099' },
  }
  const api = eventTypeServer([eventType({ location: { kind: 'zoom' } })], {
    ...signedInAs(principal),
    ...profile(),
    'GET /api/v1/instance': () => json(200, { automaticZoom: true }),
  })
  await openExisting()
  const checkbox = screen.getByRole<HTMLInputElement>('checkbox', {
    name: 'Create a unique Zoom meeting for each booking',
  })
  expect(checkbox.disabled).toBe(true)
  await user.click(checkbox)
  expect(api.to('GET /api/v1/conference-connections')).toHaveLength(0)
})

it('a different team administrator can edit saved Zoom metadata without reading or rebinding the actual host account', async () => {
  const user = userEvent.setup()
  const me = { ...ME, organization: { ...ME.organization, personal: false } }
  const other = '00000000-0000-7000-8000-000000000100'
  const api = eventTypeServer(
    [
      eventType({
        schedulingType: 'individual',
        hosts: [{ userId: other }],
        location: { kind: 'zoom', autoCreate: true },
        zoomConnectionId: '00000000-0000-7000-8000-000000000099',
      }),
    ],
    {
      ...signedInAs(me),
      ...profile(),
      'GET /api/v1/instance': () => json(200, { automaticZoom: true }),
    },
  )
  await openExisting()
  expect(
    screen.getByText('The assigned host must configure Zoom in their own signed-in session.'),
  ).toBeDefined()
  await user.clear(field('Title'))
  await user.type(field('Title'), 'Metadata by another admin')
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('Saved.')
  for (const key of ['location', 'hosts', 'zoomConnectionId', 'scheduleId'])
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).not.toHaveProperty(key)
  expect(api.to('GET /api/v1/conference-connections')).toHaveLength(0)
})

describe('event type editor layout', () => {
  it('keeps only saving and its status in the sticky bar, with return navigation outside it', async () => {
    eventTypeServer()
    const heading = await openExisting()
    expect(heading.closest('.page-header')).not.toBeNull()
    const save = screen.getByRole('button', { name: 'Save changes' })
    const bar = save.closest('.sticky-form-actions')
    expect(bar).not.toBeNull()
    expect(bar?.parentElement?.tagName).toBe('FORM')
    expect(bar?.previousElementSibling?.previousElementSibling?.tagName).toBe('FIELDSET')
    expect(
      within(bar as HTMLElement)
        .getByRole('status')
        .getAttribute('tabindex'),
    ).toBe('-1')
    expect(within(bar as HTMLElement).queryByRole('link')).toBeNull()
    expect(bar?.children).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Back to event types' }).parentElement).toBe(
      bar?.previousElementSibling,
    )
  })

  it('uses an accessible compact icon for each question option removal', async () => {
    const user = userEvent.setup()
    eventTypeServer([])
    await openNew()
    await user.click(screen.getByRole('button', { name: 'Add a question' }))
    await user.keyboard('Team size')
    await user.selectOptions(screen.getByLabelText('Answer type'), 'select')
    const remove = screen.getByRole('button', { name: 'Remove option 1, of question 1' })
    expect(remove.classList.contains('button-icon')).toBe(true)
    expect(remove.querySelector('[aria-hidden="true"]')?.textContent).toBe('×')
    expect(remove.closest('.option-row')?.querySelector('input')).toBe(
      screen.getByLabelText('Option 1 of question 1'),
    )
    await user.click(remove)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add an option' }))
  })
})

describe('event type booking link previews', () => {
  it('shows only the path while copying the complete ready booking URL', async () => {
    const user = userEvent.setup()
    eventTypeServer()
    await openExisting()
    const preview = document.querySelector('.booking-link .preview') as HTMLElement
    expect(preview?.textContent).toBe('/ada/intro-call')
    expect(preview.classList.contains('preview')).toBe(true)
    expect(preview.querySelectorAll('wbr')).toHaveLength(0)
    expect(screen.queryByText(`${window.location.origin}/ada/intro-call`)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/ada/intro-call`)
  })

  it('keeps the localized setup explanation when a booking URL is not ready', async () => {
    chooseLanguage('zh-CN')
    eventTypeServer([], profile(null))
    renderApp('/app/event-types/new')
    await screen.findByRole('heading', { name: '新活动类型', level: 1 })
    expect(screen.getByText('请在设置中选择用户名，以获得预约链接。')).toBeDefined()
    expect(screen.queryByRole('button', { name: '复制链接' })).toBeNull()
  })
})

it('keeps the event type editor inside the app shell while its skeleton loads', async () => {
  const loading = later()
  const answered = vi.fn()
  void loading.response.then(answered)
  const api = eventTypeServer([eventType()], {
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => loading.response,
  })
  renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
  // AdminLoading uses the same label before the session and lazy route are ready.
  await screen.findByRole('navigation', { name: 'Main' })
  await waitFor(() => expect(api.to(`GET /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(1))
  const skeleton = await within(screen.getByRole('main')).findByRole('status', {
    name: 'Loading…',
  })
  expect(skeleton.classList.contains('page-skeleton')).toBe(true)
  expect(skeleton.closest('[aria-busy="true"]')).toBeNull()
  expect(answered).not.toHaveBeenCalled()
  await loading.answer(json(200, eventType()))
  expect(screen.getByRole('heading', { name: 'Edit “Intro call”', level: 1 })).toBeDefined()
})
