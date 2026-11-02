import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { EventType } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, later, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'

const entriesPath = `/api/v1/event-types/${EVENT_TYPE_ID}/waitlist/entries`
const entryId = 'd0000000-0000-7000-8000-000000000001'
const entry = {
  id: entryId,
  state: 'active',
  email: 'grace@example.com',
  name: 'Grace Hopper',
  preferredWindow: {
    start: '2030-03-04T09:00:00.000Z',
    end: '2030-03-04T17:00:00.000Z',
    timeZone: 'Europe/Berlin',
  },
  createdAt: '2030-03-01T09:00:00.000Z',
  lastNotifiedAt: null,
}
const team = { ...ME, organization: { ...ME.organization, personal: false } }

function editorApi(initial = eventType(), me = ME, role = 'owner') {
  let saved = initial
  const api = fakeApi({
    ...signedInAs(me),
    ...profile(),
    'GET /api/auth/organization/get-active-member': () =>
      json(200, { userId: me.user.id, organizationId: me.organization.id, role }),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/v1/event-type-hosts': () =>
      json(200, { data: [{ id: me.user.id, name: me.user.name }], nextAfter: null }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, saved),
    [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: ({ body }) => {
      saved = { ...saved, ...(body as Partial<EventType>) }
      return json(200, saved)
    },
    'POST /api/v1/event-types': ({ body }) => {
      saved = eventType(body as Partial<EventType>)
      return json(201, saved)
    },
    [`GET ${entriesPath}`]: () => json(200, { data: [entry], nextAfter: null }),
    [`DELETE ${entriesPath}/${entryId}`]: () => json(200, { removed: true }),
  })
  return {
    ...api,
    saved: () => saved,
    replace: (next: EventType) => {
      saved = next
    },
  }
}

const checkboxName = 'Let invitees join a waitlist when no times are available'

async function showEntries() {
  await userEvent
    .setup()
    .click(await screen.findByRole('button', { name: 'View waitlist entries' }))
  return screen.findByRole('region', { name: 'Waitlist entries' })
}

describe('event type waitlist management', () => {
  it('paginates entries within the current event type and can return to the first page', async () => {
    const routes = fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, eventType()),
      [`GET ${entriesPath}`]: ({ path }) => {
        const next = new URL(path, location.origin).searchParams.get('after')
        return json(200, {
          data: [{ ...entry, email: next ? 'second@example.com' : entry.email }],
          nextAfter: next ? null : entryId,
        })
      },
    })
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const section = await showEntries()
    await within(section).findByText(entry.email)
    const user = userEvent.setup()
    await user.click(within(section).getByRole('button', { name: 'Next page' }))
    await within(section).findByText('second@example.com')
    expect(routes.to(`GET ${entriesPath}`)[1]?.path).toContain(`after=${entryId}`)
    await user.click(within(section).getByRole('button', { name: 'Back to first page' }))
    await within(section).findByText(entry.email)
    expect(routes.to(`GET ${entriesPath}`)[2]?.path).not.toContain('after=')
  })

  it('announces unsupported waitlist settings and links the error to the switch', async () => {
    fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, eventType()),
      [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: () =>
        json(400, { error: 'waitlist_unsupported', message: 'Unsupported event shape' }),
    })
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const user = userEvent.setup()
    const checkbox = await screen.findByRole('checkbox', { name: checkboxName })
    await user.click(checkbox)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const summary = await screen.findByRole('alert', { name: 'Please check the form' })
    expect(document.activeElement).toBe(summary)
    expect(checkbox.getAttribute('aria-invalid')).toBe('true')
    expect(checkbox.getAttribute('aria-describedby')).toContain('waitlist-error')
    await user.click(within(summary).getByRole('link', { name: /^Booking waitlist:/ }))
    expect(document.activeElement).toBe(checkbox)
  })

  it('defaults off on creation and sends an explicit opt-in', async () => {
    const api = editorApi()
    const user = userEvent.setup()
    renderApp('/app/event-types/new')
    const checkbox = await screen.findByRole<HTMLInputElement>(
      'checkbox',
      { name: checkboxName },
      { timeout: 5000 },
    )
    expect(checkbox.checked).toBe(false)
    await user.type(screen.getByLabelText('Title', { exact: true }), 'Consultation')
    await user.click(checkbox)
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    await screen.findByRole('region', { name: 'View and share' })
    expect(api.to('POST /api/v1/event-types')[0]?.body).toHaveProperty('waitlist', {
      enabled: true,
    })
  })

  it('round-trips enable and disable and adopts each new saved baseline', async () => {
    const api = editorApi()
    const user = userEvent.setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const checkbox = await screen.findByRole<HTMLInputElement>('checkbox', { name: checkboxName })
    expect(checkbox.checked).toBe(false)
    await user.click(checkbox)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.saved().waitlist).toEqual({ enabled: true })
    expect(checkbox.checked).toBe(true)
    await user.click(checkbox)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[1]?.body).toHaveProperty(
      'waitlist',
      { enabled: false },
    )
    expect(api.saved().waitlist).toEqual({ enabled: false })
    await user.type(screen.getByLabelText('Title', { exact: true }), ' renamed')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[2]?.body).not.toHaveProperty(
      'waitlist',
    )
  })

  it.each([false, true])(
    'preserves concurrent settings after an untouched or reverted edit (%s)',
    async (enabled) => {
      const api = editorApi(eventType({ waitlist: { enabled } }))
      const user = userEvent.setup()
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      const checkbox = await screen.findByRole('checkbox', { name: checkboxName })
      api.replace({ ...api.saved(), waitlist: { enabled: !enabled } })
      await user.click(checkbox)
      await user.click(checkbox)
      await user.type(screen.getByLabelText('Title', { exact: true }), ' renamed')
      await user.click(screen.getByRole('button', { name: 'Save changes' }))
      await screen.findByText('Saved.')
      expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).not.toHaveProperty(
        'waitlist',
      )
      expect(api.saved().waitlist).toEqual({ enabled: !enabled })
    },
  )

  it.each(['owner', 'admin'])(
    'shows contact details only after a manager opens the team list (%s)',
    async (role) => {
      const api = editorApi(eventType(), team, role)
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      await screen.findByRole('button', { name: 'View waitlist entries' })
      expect(api.to(`GET ${entriesPath}`)).toHaveLength(0)
      const section = await showEntries()
      expect(await within(section).findByRole('heading', { name: entry.email })).toBeDefined()
      expect(within(section).getByText(entry.name)).toBeDefined()
      expect(within(section).getByText('Waiting for a time')).toBeDefined()
      expect(within(section).getByText(/Europe\/Berlin/)).toBeDefined()
      expect([...section.querySelectorAll('time')].map((node) => node.dateTime)).toEqual([
        entry.preferredWindow.start,
        entry.preferredWindow.end,
        entry.createdAt,
      ])
      expect(api.to(`GET ${entriesPath}`)[0]?.headers.get('X-Expected-Organization-Id')).toBe(
        team.organization.id,
      )
    },
  )

  it('never requests or displays contact details for an ordinary team member', async () => {
    const api = editorApi(eventType(), team, 'member')
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByText('Only team owners and admins can manage the waitlist.')
    expect(screen.queryByRole('checkbox', { name: checkboxName })).toBeNull()
    expect(screen.queryByRole('button', { name: 'View waitlist entries' })).toBeNull()
    expect(screen.queryByText(entry.email)).toBeNull()
    expect(api.to(`GET ${entriesPath}`)).toHaveLength(0)
  })

  it('keeps unknown team access neutral and withholds the list', async () => {
    const pending = later()
    const api = fakeApi({
      ...signedInAs(team),
      ...profile(),
      'GET /api/auth/organization/get-active-member': () => pending.response,
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, eventType()),
    })
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByText('Checking waitlist management access…')
    expect(screen.queryByRole('checkbox', { name: checkboxName })).toBeNull()
    expect(api.to(`GET ${entriesPath}`)).toHaveLength(0)
    await pending.answer(json(500, { error: 'internal_error' }))
    await screen.findByText('Could not check waitlist management access. Try again.')
    expect(screen.queryByText('Waitlist management is unavailable for this account.')).toBeNull()
    expect(screen.queryByText('Only team owners and admins can manage the waitlist.')).toBeNull()
  })

  it('requires confirmation before removal and immediately clears displayed contact details', async () => {
    const api = editorApi()
    const user = userEvent.setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const section = await showEntries()
    await within(section).findByText(entry.email)
    await user.click(within(section).getByRole('button', { name: 'Remove entry' }))
    expect(api.to(`DELETE ${entriesPath}/${entryId}`)).toHaveLength(0)
    expect(document.activeElement).toBe(within(section).getByRole('button', { name: 'Cancel' }))
    await user.click(within(section).getByRole('button', { name: 'Cancel' }))
    expect(api.to(`DELETE ${entriesPath}/${entryId}`)).toHaveLength(0)
    await user.click(within(section).getByRole('button', { name: 'Remove entry' }))
    expect(
      within(section).getByText(
        'Remove this waitlist entry? Their contact details will be cleared. No email will be sent.',
      ),
    ).toBeDefined()
    await user.click(within(section).getByRole('button', { name: 'Remove entry' }))
    await within(section).findByText('Removed')
    expect(within(section).queryByText(entry.email)).toBeNull()
    expect(within(section).queryByText(entry.name)).toBeNull()
    expect(within(section).queryByText(/Europe\/Berlin/)).toBeNull()
    expect(api.to(`DELETE ${entriesPath}/${entryId}`)).toHaveLength(1)
    expect(
      api.to(`DELETE ${entriesPath}/${entryId}`)[0]?.headers.get('X-Expected-Organization-Id'),
    ).toBe(ME.organization.id)
  })

  it('discards displayed contacts when refreshed access is refused', async () => {
    let allowed = true
    fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, eventType()),
      [`GET ${entriesPath}`]: () =>
        allowed ? json(200, { data: [entry], nextAfter: null }) : json(403, { error: 'forbidden' }),
    })
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const section = await showEntries()
    await within(section).findByText(entry.email)
    allowed = false
    await userEvent.setup().click(within(section).getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.queryByText(entry.email)).toBeNull())
    expect(screen.getByText('Could not check waitlist management access. Try again.')).toBeDefined()
    expect(screen.queryByText('No waitlist entries.')).toBeNull()
  })

  it.each(['en', 'zh-CN'] as const)(
    'localizes every state and provides requested and notification dates in %s',
    async (locale) => {
      chooseLanguage(locale)
      fakeApi({
        ...signedInAs(ME),
        ...profile(),
        'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
        [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, eventType()),
        [`GET ${entriesPath}`]: () =>
          json(200, {
            data: [
              'pending_verification',
              'active',
              'notified',
              'booked',
              'removed',
              'expired',
            ].map((state, index) => ({
              ...entry,
              id: `${entryId}-${index}`,
              state,
              email: index > 3 ? null : entry.email,
              preferredWindow: index > 3 ? null : entry.preferredWindow,
              lastNotifiedAt: state === 'notified' ? '2030-03-02T09:00:00.000Z' : null,
            })),
            nextAfter: null,
          }),
      })
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      const user = userEvent.setup()
      await user.click(
        await screen.findByRole('button', {
          name: locale === 'en' ? 'View waitlist entries' : '查看候补名单',
        }),
      )
      const states =
        locale === 'en'
          ? [
              'Pending verification',
              'Waiting for a time',
              'Notified',
              'Booked',
              'Removed',
              'Expired',
            ]
          : ['等待邮箱验证', '等待空闲时段', '已通知', '已预约', '已移除', '已过期']
      for (const state of states) expect(await screen.findByText(state)).toBeDefined()
      const rows = screen
        .getAllByRole('listitem')
        .filter(
          (row) => row.querySelector('dt')?.textContent === (locale === 'en' ? 'Status' : '状态'),
        )
      expect(rows).toHaveLength(6)
      const neverNotified = locale === 'en' ? 'Not notified yet' : '尚未通知'
      const unknown = locale === 'en' ? 'Notification time unavailable' : '通知时间未知'
      for (const index of [0, 1]) {
        expect(within(rows[index] as HTMLElement).getByText(neverNotified)).toBeDefined()
        expect(within(rows[index] as HTMLElement).queryByText(unknown)).toBeNull()
      }
      expect(within(rows[3] as HTMLElement).getByText(unknown)).toBeDefined()
      expect(document.querySelector('time[datetime="2030-03-02T09:00:00.000Z"]')).not.toBeNull()
      if (locale === 'zh-CN') expect(screen.queryByText('Waitlist entries')).toBeNull()
    },
  )
})
