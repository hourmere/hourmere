import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { EventType } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'

function setup(saved = eventType()) {
  return fakeApi({
    ...signedInAs(ME),
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, saved),
    'POST /api/v1/event-types': ({ body }) => {
      saved = eventType(body as Partial<EventType>)
      return json(201, saved)
    },
    [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: ({ body }) => {
      saved = { ...saved, ...(body as Partial<EventType>) }
      return json(200, saved)
    },
  })
}

function disclosureFor(field: HTMLElement) {
  const group = field.closest('details')
  expect(group).not.toBeNull()
  return group as HTMLDetailsElement
}

it('shows precisely four editable controls outside closed settings on create', async () => {
  chooseLanguage('en')
  setup()
  const view = renderApp('/app/event-types/new')
  await screen.findByLabelText('Title', { exact: true })
  const controls = [
    ...view.container.querySelectorAll('form input, form select, form textarea'),
  ].filter((control) => !control.closest('details'))
  expect(controls.map((control) => control.id)).toEqual([
    'title',
    'slug',
    'durationMinutes',
    'location-kind',
  ])
  const groups = [...view.container.querySelectorAll('details')]
  expect(groups.length).toBeGreaterThanOrEqual(8)
  expect(groups.every((group) => !group.open)).toBe(true)
  for (const group of groups)
    expect(group.querySelector('summary')?.textContent?.trim()).toBeTruthy()
})

it('submits the exact pre-disclosure create body when only essentials are filled', async () => {
  chooseLanguage('en')
  const api = setup()
  const user = userEvent.setup()
  renderApp('/app/event-types/new')
  await user.type(await screen.findByLabelText('Title', { exact: true }), 'Intro')
  await user.selectOptions(screen.getByLabelText('Where the meeting happens'), 'google_meet')
  await user.click(screen.getByRole('button', { name: 'Create event type' }))
  await waitFor(() => expect(api.to('POST /api/v1/event-types')).toHaveLength(1))
  // Literal captured from the old form's emptyDraft/toInput contract, not computed by new code.
  expect(api.to('POST /api/v1/event-types')[0]?.body).toEqual({
    title: 'Intro',
    slug: 'intro',
    description: null,
    durationMinutes: 30,
    slotStepMinutes: null,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    maxBookingsPerDay: null,
    maxBookingsPerWeek: null,
    maxBookingsPerMonth: null,
    bookingWindowDays: null,
    location: { kind: 'google_meet' },
    questions: [],
    scheduleId: null,
    position: 0,
    isActive: true,
    isHidden: false,
    allowGuests: false,
  })
})

describe.each(['en', 'zh-CN'] as const)('settings disclosures in %s', (language) => {
  it('uses native keyboard-operable summaries and preserves entered values when collapsed', async () => {
    chooseLanguage(language)
    setup()
    const user = userEvent.setup()
    renderApp('/app/event-types/new')
    await screen.findByLabelText(language === 'en' ? 'Title' : '标题', { exact: true })
    const field = document.getElementById('description') as HTMLTextAreaElement
    const group = disclosureFor(field)
    const summary = group.querySelector('summary') as HTMLElement
    summary.focus()
    expect(document.activeElement).toBe(summary)
    // jsdom does not implement summary's native keyboard default; click is its activation event.
    await user.click(summary)
    expect(group.open).toBe(true)
    await user.type(field, 'Keep this description')
    await user.click(summary)
    expect(group.open).toBe(false)
    await user.click(summary)
    expect(field.value).toBe('Keep this description')
  })

  it('opens a closed settings group and focuses its invalid field on submit', async () => {
    chooseLanguage(language)
    setup()
    const user = userEvent.setup()
    renderApp('/app/event-types/new')
    await user.type(
      await screen.findByLabelText(language === 'en' ? 'Title' : '标题', { exact: true }),
      'Intro',
    )
    const field = document.getElementById('bufferBeforeMinutes') as HTMLInputElement
    const group = disclosureFor(field)
    group.open = true
    fireEvent.change(field, { target: { value: '-1' } })
    group.open = false
    await user.click(
      screen.getByRole('button', {
        name: language === 'en' ? 'Create event type' : '创建活动类型',
      }),
    )
    await waitFor(() => expect(group.open).toBe(true))
    await waitFor(() => expect(document.activeElement).toBe(field))
    expect(field.getAttribute('aria-invalid')).toBe('true')
  })
})

it('opens nondefault settings and preserves their values after a collapsed title-only save', async () => {
  chooseLanguage('en')
  const original = eventType({
    description: 'Retained description',
    isActive: false,
    isHidden: true,
    position: 9,
    allowedDurationsMinutes: [15, 30, 60],
    bufferBeforeMinutes: 10,
    bufferAfterMinutes: 15,
    minimumNoticeMinutes: 120,
    bookingWindowDays: 42,
    slotStepMinutes: 15,
    maxBookingsPerDay: 2,
    maxBookingsPerWeek: 5,
    maxBookingsPerMonth: 12,
    allowGuests: true,
    waitlist: { enabled: true },
    questions: [{ id: 'topic', label: 'Topic', type: 'short_text', required: true }],
    notifications: {
      reminders: [],
      followUps: [
        {
          id: 'thanks',
          offsetMinutes: 60,
          recipients: { invitee: true, host: false, guests: false },
        },
      ],
    },
    successRedirect: {
      url: 'https://example.com/thanks',
      parameters: ['start'],
      includeInviteePersonalData: false,
      allowEmbedParent: true,
    },
  })
  const api = setup(original)
  const user = userEvent.setup()
  const view = renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
  const title = await screen.findByLabelText('Title', { exact: true })
  for (const id of [
    'description',
    'bufferBeforeMinutes',
    'allowedDurationsMinutes',
    'waitlist',
    'questions-heading',
    'successRedirect.url',
    'notifications',
  ]) {
    expect(disclosureFor(document.getElementById(id) as HTMLElement).open).toBe(true)
  }
  for (const group of view.container.querySelectorAll('details')) group.open = false
  await user.clear(title)
  await user.type(title, 'Renamed')
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('Saved.')
  const body = api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body as Partial<EventType>
  expect({ ...original, ...body }).toEqual({ ...original, title: 'Renamed' })
})

it('reopens a group when returning from the error summary after it was collapsed again', async () => {
  chooseLanguage('en')
  setup()
  const user = userEvent.setup()
  renderApp('/app/event-types/new')
  await user.type(await screen.findByLabelText('Title', { exact: true }), 'Intro')
  const field = document.getElementById('bufferAfterMinutes') as HTMLInputElement
  const group = disclosureFor(field)
  fireEvent.change(field, { target: { value: '-1' } })
  await user.click(screen.getByRole('button', { name: 'Create event type' }))
  await waitFor(() => expect(group.open).toBe(true))
  await user.click(group.querySelector('summary') as HTMLElement)
  expect(group.open).toBe(false)
  const link = document.querySelector('a[href="#bufferAfterMinutes"]') as HTMLAnchorElement
  expect(link).not.toBeNull()
  await user.click(link)
  expect(group.open).toBe(true)
  expect(document.activeElement).toBe(field)
})

describe.each(['en', 'zh-CN'] as const)('first-screen feedback in %s', (language) => {
  it('keeps an invalid single duration error on the duration input', async () => {
    chooseLanguage(language)
    setup()
    const user = userEvent.setup()
    renderApp('/app/event-types/new')
    await screen.findByLabelText(language === 'en' ? 'Title' : '标题', { exact: true })
    fireEvent.change(document.getElementById('title') as HTMLElement, {
      target: { value: 'Intro' },
    })
    const duration = document.getElementById('durationMinutes') as HTMLInputElement
    fireEvent.change(duration, { target: { value: '2000' } })
    await user.click(
      screen.getByRole('button', {
        name: language === 'en' ? 'Create event type' : '创建活动类型',
      }),
    )
    expect(document.activeElement).toBe(duration)
    expect(duration.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelectorAll('.field-error')).toHaveLength(1)
    expect(
      disclosureFor(document.getElementById('allowedDurationsMinutes') as HTMLElement).open,
    ).toBe(false)
    const links = document.querySelectorAll('.error-summary a')
    expect(links).toHaveLength(1)
    expect(links[0]?.textContent).toContain(
      language === 'en' ? 'Duration (minutes)' : '时长（分钟）',
    )
  })
})

it('keeps focus on a reminder edit after the user closes a failed field group', async () => {
  chooseLanguage('en')
  setup()
  const user = userEvent.setup()
  renderApp('/app/event-types/new')
  await user.type(await screen.findByLabelText('Title', { exact: true }), 'Intro')
  const invalid = document.getElementById('bufferAfterMinutes') as HTMLInputElement
  fireEvent.change(invalid, { target: { value: '-1' } })
  await user.click(screen.getByRole('button', { name: 'Create event type' }))
  const group = disclosureFor(invalid)
  await user.click(group.querySelector('summary') as HTMLElement)
  expect(group.open).toBe(false)
  const notifications = disclosureFor(document.getElementById('notifications') as HTMLElement)
  await user.click(notifications.querySelector('summary') as HTMLElement)
  const offset = notifications.querySelector('input[inputmode="numeric"]') as HTMLInputElement
  await user.click(offset)
  fireEvent.change(offset, { target: { value: '120' } })
  expect(group.open).toBe(false)
  expect(document.activeElement).toBe(offset)
})

it('shows the no-schedule notice on create without opening settings', async () => {
  chooseLanguage('en')
  fakeApi({
    ...signedInAs(ME),
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: [] }),
  })
  renderApp('/app/event-types/new')
  await screen.findByLabelText('Title', { exact: true })
  const notice = screen.getByText(/You have no schedule yet/)
  expect(notice.closest('details')).toBeNull()
  expect(screen.getByRole('link', { name: 'Set your availability' })).toBeTruthy()
})

it('shows a team-role failure on create without opening settings', async () => {
  chooseLanguage('en')
  const me = { ...ME, organization: { ...ME.organization, personal: false } }
  fakeApi({
    ...signedInAs(me),
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/auth/organization/get-active-member': () => json(500, { message: 'Unavailable' }),
  })
  renderApp('/app/event-types/new')
  await screen.findByLabelText('Title', { exact: true })
  const notice = await screen.findByText('Could not load your team role.')
  expect(notice.closest('details')).toBeNull()
  expect(notice.closest('[role="alert"]')).not.toBeNull()
})
