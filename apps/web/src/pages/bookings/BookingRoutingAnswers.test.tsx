import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { browserLocale } from '../../test/browser-locale.ts'
import { fakeApi, json, later, profile, renderApp, signedIn } from '../../test/fake-api.tsx'
import { BOOKING_ID, booking } from '../../test/fixtures.ts'

const detail = (id: string) => `GET /api/v1/bookings/${id}`
const path = (id: string) => `/app/bookings/${id}`

const selectId = 'a0000000-0000-7000-8000-000000000001'
const optionId = 'a0000000-0000-7000-8000-000000000002'
const noteId = 'a0000000-0000-7000-8000-000000000003'
const snapshot: Schemas['BookingRouting'] = {
  formId: 'a0000000-0000-7000-8000-000000000004',
  versionId: 'a0000000-0000-7000-8000-000000000005',
  versionNumber: 2,
  matchedRuleId: 'a0000000-0000-7000-8000-000000000006',
  resolvedRuleId: 'fallback',
  questions: [
    {
      id: selectId,
      type: 'select',
      required: true,
      label: 'Original <b>department</b>',
      options: [{ id: optionId, label: 'Sales & <em>support</em>' }],
    },
    { id: noteId, type: 'short_text', required: false, label: 'Original note' },
  ],
  answers: { [selectId]: optionId, [noteId]: 'Use <strong>exact text</strong> & quotes' },
}
const historyBooking = booking({
  eventTypeId: null,
  start: '2020-03-04T09:00:00Z',
  end: '2020-03-04T09:30:00Z',
  createdAt: '2020-03-01T09:00:00Z',
  responses: { topic: 'Planning' },
})

it('preserves the host detail markup for an ordinary booking', async () => {
  browserLocale('en-US')
  chooseLanguage('en')
  fakeApi({
    ...signedIn,
    ...profile(),
    [detail(BOOKING_ID)]: () => json(200, historyBooking),
  })
  renderApp(path(BOOKING_ID))
  await screen.findByRole('region', { name: 'Answers' })
  expect(
    Array.from(screen.getByRole('main').children, (child) => child.outerHTML),
  ).toMatchSnapshot()
})

it.each([
  ['en', 'Original routing answers', 'Final booking answers'],
  ['zh-CN', '原始分流表单答案', '最终预约答案'],
] as const)(
  'keeps the historical routing labels and final booking responses distinct in %s',
  async (locale, originalHeading, finalHeading) => {
    chooseLanguage(locale)
    fakeApi({
      ...signedIn,
      ...profile(),
      [detail(BOOKING_ID)]: () =>
        json(200, {
          ...historyBooking,
          questions: [
            { id: 'department', label: 'Final department', type: 'short_text', required: true },
          ],
          responses: { department: 'Engineering <em>review</em>' },
          routing: snapshot,
        }),
    })
    renderApp(path(BOOKING_ID))
    const original = await screen.findByRole('region', { name: originalHeading })
    const final = screen.getByRole('region', { name: finalHeading })
    expect(original.nextElementSibling).toBe(final)
    expect(
      within(original)
        .getAllByRole('term')
        .map((term) => term.textContent),
    ).toEqual(['Original <b>department</b>', 'Original note'])
    expect(
      within(original)
        .getAllByRole('definition')
        .map((term) => term.textContent),
    ).toEqual(['Sales & <em>support</em>', 'Use <strong>exact text</strong> & quotes'])
    expect(within(final).getByRole('term').textContent).toBe('Final department')
    expect(within(final).getByRole('definition').textContent).toBe('Engineering <em>review</em>')
    expect(original.querySelector('b, em, strong')).toBeNull()
    expect(final.querySelector('em')).toBeNull()
  },
)

it('acknowledges a routed booking whose form collected no answers', async () => {
  fakeApi({
    ...signedIn,
    ...profile(),
    [detail(BOOKING_ID)]: () =>
      json(200, { ...historyBooking, routing: { ...snapshot, questions: [], answers: {} } }),
  })
  renderApp(path(BOOKING_ID))
  const original = await screen.findByRole('region', { name: 'Original routing answers' })
  expect(within(original).getByText('No routing answers were submitted.')).toBeDefined()
  expect(screen.getByRole('region', { name: 'Final booking answers' })).toBeDefined()
})

it('shows the original snapshot on both sides of the reschedule history', async () => {
  const successorId = 'b0000000-0000-7000-8000-000000000002'
  const successor = later()
  fakeApi({
    ...signedIn,
    ...profile(),
    [detail(BOOKING_ID)]: () =>
      json(200, {
        ...historyBooking,
        status: 'cancelled',
        rescheduledToId: successorId,
        routing: snapshot,
      }),
    [detail(successorId)]: () => successor.response,
  })
  renderApp(path(BOOKING_ID))
  const original = await screen.findByRole('region', { name: 'Original routing answers' })
  await userEvent.click(screen.getByRole('link', { name: 'View rescheduled booking' }))
  await screen.findByRole('status', { name: 'Loading the booking…' })
  expect(screen.queryByRole('region', { name: 'Original routing answers' })).toBeNull()
  await successor.answer(
    json(200, {
      ...historyBooking,
      id: successorId,
      rescheduledFromId: BOOKING_ID,
      routing: snapshot,
    }),
  )
  expect(
    (await screen.findByRole('region', { name: 'Original routing answers' })).textContent,
  ).toBe(original.textContent)
  await userEvent.click(screen.getByRole('link', { name: 'an earlier booking' }))
  expect(await screen.findByRole('link', { name: 'View rescheduled booking' })).toBeDefined()
  expect(screen.getByRole('region', { name: 'Original routing answers' }).textContent).toBe(
    original.textContent,
  )
})

it('keeps the routing snapshot when a cancellation returns an ordinary booking', async () => {
  const current = booking({ eventTypeId: null })
  fakeApi({
    ...signedIn,
    ...profile(),
    [detail(BOOKING_ID)]: () => json(200, { ...current, routing: snapshot }),
    [`POST /api/v1/bookings/${BOOKING_ID}/cancel`]: () =>
      json(200, { ...current, status: 'cancelled' }),
  })
  renderApp(path(BOOKING_ID))
  await userEvent.click(await screen.findByRole('button', { name: 'Cancel booking…' }))
  await userEvent.click(screen.getByRole('button', { name: 'Cancel booking' }))
  await screen.findByText('The booking is cancelled.')
  expect(screen.getByRole('region', { name: 'Original routing answers' })).toBeDefined()
})

it('shows only the booking load error when the snapshot status is unknown', async () => {
  fakeApi({
    ...signedIn,
    ...profile(),
    [detail(BOOKING_ID)]: () => json(403, { error: 'forbidden' }),
  })
  renderApp(path(BOOKING_ID))
  expect((await screen.findByRole('alert')).textContent).toContain('Could not load the booking.')
  expect(screen.queryByRole('region', { name: 'Original routing answers' })).toBeNull()
  expect(screen.queryByText('No routing answers were submitted.')).toBeNull()
})
