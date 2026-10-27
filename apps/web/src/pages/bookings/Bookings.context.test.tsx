import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { chooseLanguage } from '../../i18n/store.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import { BOOKING_ID, booking, EVENT_TYPE_ID, eventType } from '../../test/fixtures.ts'
import { LEAVE_WITH_UNSAVED_CHANGES } from '../../unsaved-changes.tsx'

const team = {
  ...ME,
  organization: {
    ...ME.organization,
    id: '00000000-0000-7000-8000-000000000003',
    name: 'Original team',
    slug: 'original-team',
    personal: false,
  },
}
const detail = `/app/bookings/${BOOKING_ID}`
const cancelPath = `/api/v1/bookings/${BOOKING_ID}/cancel`
const refusal = () => json(409, { error: 'organization_context_changed' })

function server(overrides: Routes = {}) {
  return fakeApi({
    ...signedInAs(team),
    ...profile(),
    [`GET /api/v1/bookings/${BOOKING_ID}`]: () => json(200, booking()),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, eventType()),
    [`POST ${cancelPath}`]: refusal,
    ...overrides,
  })
}

describe('booking actions bound to their opening organization', () => {
  it.each([
    ['en', 'Cancel booking…', 'Cancel booking', 'Reason', 'Reload'],
    ['zh-CN', '取消预约…', '取消预约', '原因', '重新加载'],
  ] as const)(
    'keeps the cancellation reason and original organization through a conflict in %s',
    async (locale, open, submit, reason, reload) => {
      chooseLanguage(locale)
      const user = userEvent.setup()
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      let active = team
      const api = server({
        ...profile({ ...PROFILE, locale }),
        'GET /api/v1/me': () => json(200, active),
      })
      renderApp(detail)
      await user.click(await screen.findByRole('button', { name: open }))
      await user.type(screen.getByLabelText(reason, { exact: false }), 'Original team reason')
      active = { ...ME }
      await user.click(screen.getByRole('button', { name: submit }))
      await waitFor(() => expect(screen.queryByRole('button', { name: reload })).not.toBeNull())
      const reloadButton = screen.getByRole('button', { name: reload })
      const guidance =
        locale === 'en'
          ? 'Your team context changed. Reload before making changes.'
          : '你的团队上下文已改变。请重新加载后再进行修改。'
      expect(screen.getByRole('alert').textContent).toContain(guidance)
      expect(api.to(`POST ${cancelPath}`)).toHaveLength(1)
      expect(api.to(`POST ${cancelPath}`)[0]?.headers.get('X-Expected-Organization-Id')).toBe(
        team.organization.id,
      )
      expect(api.to(`POST ${cancelPath}`)[0]?.body).toEqual({ reason: 'Original team reason' })
      expect(
        screen.getByRole<HTMLTextAreaElement>('textbox', { name: new RegExp(reason) }).value,
      ).toBe('Original team reason')
      expect(screen.getByRole<HTMLButtonElement>('button', { name: submit }).disabled).toBe(true)
      await user.click(reloadButton)
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(api.to('GET /api/v1/me')).toHaveLength(1)
      expect(
        screen.getByRole<HTMLTextAreaElement>('textbox', { name: new RegExp(reason) }).value,
      ).toBe('Original team reason')
      confirm.mockReturnValue(true)
      await user.click(reloadButton)
      await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
      expect(api.to('GET /api/v1/me')).toHaveLength(2)
      expect(api.to(`POST ${cancelPath}`)).toHaveLength(1)
    },
  )

  it.each([
    ['conference/retry', 'Recheck existing meeting'],
    ['calendar-copy/retry', 'Recheck my calendar copy'],
  ])('binds %s to the opening team and offers reload without replaying', async (suffix, button) => {
    const user = userEvent.setup()
    const path = `/api/v1/bookings/${BOOKING_ID}/${suffix}`
    let active = team
    const api = server({
      'GET /api/v1/me': () => json(200, active),
      [`GET /api/v1/bookings/${BOOKING_ID}`]: () =>
        json(
          200,
          booking({
            conference: {
              provider: 'google_meet',
              status: 'failed',
              errorCode: 'ambiguous_create',
            },
            calendarCopy: { status: 'failed', errorCode: 'provider_unavailable', canRetry: true },
          }),
        ),
      [`POST ${path}`]: refusal,
    })
    renderApp(detail)
    await screen.findByRole('button', { name: button })
    active = { ...ME }
    await user.click(screen.getByRole('button', { name: button }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeNull())
    expect(screen.getByRole('alert').textContent).toContain(
      'Your team context changed. Reload before making changes.',
    )
    expect(api.to(`POST ${path}`)).toHaveLength(1)
    expect(api.to(`POST ${path}`)[0]?.headers.get('X-Expected-Organization-Id')).toBe(
      team.organization.id,
    )
    expect(screen.getByRole<HTMLButtonElement>('button', { name: button }).disabled).toBe(true)
  })

  it('retains the reason when current membership no longer authorizes the explicit booking', async () => {
    const user = userEvent.setup()
    const api = server({
      [`POST ${cancelPath}`]: () =>
        json(404, { error: 'booking_not_found', message: 'Booking not found' }),
    })
    renderApp(detail)
    await user.click(await screen.findByRole('button', { name: 'Cancel booking…' }))
    await user.type(screen.getByLabelText(/Reason/), 'Keep this reason after removal')
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not cancel the booking.',
    )
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: /Reason/ }).value).toBe(
      'Keep this reason after removal',
    )
    expect(api.to(`POST ${cancelPath}`)).toHaveLength(1)
    expect(api.to(`POST ${cancelPath}`)[0]?.headers.get('X-Expected-Organization-Id')).toBe(
      team.organization.id,
    )
    expect(screen.queryByText('The booking is cancelled.')).toBeNull()
  })

  it('discards a late cancellation validation answer after a confirmed multi-tab team switch', async () => {
    const user = userEvent.setup()
    const delayed = later()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    let active = team
    const api = server({
      'GET /api/v1/me': () => json(200, active),
      [`POST ${cancelPath}`]: () => delayed.response,
    })
    renderApp(detail)
    await user.click(await screen.findByRole('button', { name: 'Cancel booking…' }))
    await user.type(screen.getByLabelText(/Reason/), 'Old team reason')
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    active = { ...ME }
    await act(async () => fireEvent.focus(window))
    await screen.findByRole('button', { name: 'Cancel booking…' })
    expect(confirm).toHaveBeenCalledWith(LEAVE_WITH_UNSAVED_CHANGES)
    await user.click(screen.getByRole('button', { name: 'Cancel booking…' }))
    await user.type(screen.getByLabelText(/Reason/), 'New team reason')
    const keep = screen.getByRole('button', { name: 'Keep booking' })
    keep.focus()
    await delayed.answer(json(400, { error: 'invalid_reason' }))
    expect(document.activeElement).toBe(keep)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: /Reason/ }).value).toBe(
      'New team reason',
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.to(`POST ${cancelPath}`)).toHaveLength(1)
  })
})
