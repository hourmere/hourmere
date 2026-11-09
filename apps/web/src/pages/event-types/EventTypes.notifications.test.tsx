import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import type { EventType } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'
import { NotificationsEditor } from './NotificationsEditor.tsx'
import { defaultNotificationsDraft, type NotificationsDraft } from './notifications-form.ts'

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Expected a fixture value')
  return value
}

type Settings = EventType['notifications']

const custom: Settings = {
  reminders: [
    {
      id: 'saved-reminder',
      offsetMinutes: 120,
      recipients: { invitee: true, guests: false, host: true },
    },
  ],
  followUps: [
    {
      id: 'saved-follow-up',
      offsetMinutes: 60,
      recipients: { invitee: true, guests: false, host: false },
      hostNote: 'Thanks for your time.',
    },
  ],
}

function editorApi(initial = eventType(), hostNotesEnabled = true) {
  let saved = initial
  const api = fakeApi({
    ...signedInAs(ME),
    ...profile(),
    'GET /api/v1/instance': () =>
      json(200, {
        automaticGoogleMeet: false,
        followUpHostNotesEnabled: hostNotesEnabled,
        signIn: { email: true, google: false, microsoft: false },
      }),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, saved),
    [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: ({ body }) => {
      saved = { ...saved, ...(body as Partial<EventType>) }
      saved = {
        ...saved,
        notifications: {
          reminders: [...saved.notifications.reminders].sort(
            (a, b) => b.offsetMinutes - a.offsetMinutes,
          ),
          followUps: [...saved.notifications.followUps].sort(
            (a, b) => a.offsetMinutes - b.offsetMinutes,
          ),
        },
      }
      return json(200, saved)
    },
    'POST /api/v1/event-types': ({ body }) => {
      saved = eventType(body as Partial<EventType>)
      return json(201, saved)
    },
  })
  return {
    ...api,
    saved: () => saved,
    replace: (value: EventType) => {
      saved = value
    },
  }
}

function Harness({
  initial = defaultNotificationsDraft(),
  enabled = true,
}: {
  initial?: NotificationsDraft
  enabled?: boolean
}) {
  const [notifications, setNotifications] = useState(initial)
  return (
    <NotificationsEditor
      notifications={notifications}
      errors={{}}
      hostNotesEnabled={enabled}
      onChange={setNotifications}
    />
  )
}

describe('event type reminders and follow-ups editor', () => {
  it('shows the legacy default and preserves omitted notification settings on create', async () => {
    const api = editorApi()
    const user = userEvent.setup()
    renderApp('/app/event-types/new')
    await user.type(await screen.findByLabelText('Title', { exact: true }), 'Intro')
    const reminder = screen.getByRole('group', { name: 'Reminder 1' })
    expect(
      within(reminder).getByLabelText<HTMLInputElement>('Minutes before the meeting').value,
    ).toBe('1440')
    for (const name of ['Invitee', 'Guests', 'Host'])
      expect(within(reminder).getByRole<HTMLInputElement>('checkbox', { name }).checked).toBe(true)
    expect(screen.queryByRole('group', { name: 'Follow-up 1' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    await screen.findByRole('region', { name: 'View and share' })
    expect(api.to('POST /api/v1/event-types')[0]?.body).not.toHaveProperty('notifications')
    expect(api.saved().notifications).toEqual(eventType().notifications)
  })

  it('round trips add, remove, presets, custom timing, recipients and a plain-text host note', async () => {
    const api = editorApi()
    const user = userEvent.setup()
    const view = renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const first = await screen.findByRole('group', { name: 'Reminder 1' })
    await user.selectOptions(within(first).getByLabelText('Timing preset'), '120')
    await user.click(within(first).getByRole('checkbox', { name: 'Guests' }))
    await user.click(screen.getByRole('button', { name: 'Add reminder' }))
    const second = screen.getByRole('group', { name: 'Reminder 2' })
    await user.selectOptions(within(second).getByLabelText('Timing preset'), '30')
    await user.click(screen.getByRole('button', { name: 'Add follow-up' }))
    const followUp = screen.getByRole('group', { name: 'Follow-up 1' })
    await user.selectOptions(within(followUp).getByLabelText('Timing preset'), '1440')
    const offset = within(followUp).getByLabelText('Minutes after the meeting')
    await user.clear(offset)
    await user.type(offset, '90')
    expect(within(followUp).getByLabelText<HTMLSelectElement>('Timing preset').value).toBe('')
    await user.click(within(followUp).getByRole('checkbox', { name: 'Host' }))
    await user.click(within(followUp).getByLabelText('Host note (optional)'))
    await user.paste('A plain note: <b>thanks</b> {name}.')
    await user.click(screen.getByRole('button', { name: 'Remove reminder 1' }))
    expect(screen.getByRole('group', { name: 'Reminder 1' })).toBe(second)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    const sent = (
      required(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]).body as {
        notifications: Settings
      }
    ).notifications
    expect(sent).toMatchObject({
      reminders: [{ offsetMinutes: 30, recipients: { invitee: true, guests: true, host: true } }],
      followUps: [
        {
          offsetMinutes: 90,
          recipients: { invitee: true, guests: true, host: false },
          hostNote: 'A plain note: <b>thanks</b> {name}.',
        },
      ],
    })
    expect(sent.reminders[0]?.id).not.toBe('default-24h')
    expect(new Set([...sent.reminders, ...sent.followUps].map(({ id }) => id)).size).toBe(2)
    view.unmount()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const reloaded = await screen.findByRole('group', { name: 'Follow-up 1' })
    expect(within(reloaded).getByLabelText<HTMLTextAreaElement>('Host note (optional)').value).toBe(
      'A plain note: <b>thanks</b> {name}.',
    )
    expect(
      within(reloaded).getByLabelText<HTMLInputElement>('Minutes after the meeting').value,
    ).toBe('90')
    await user.click(screen.getByRole('button', { name: 'Remove follow-up 1' }))
    await user.click(screen.getByRole('button', { name: 'Remove reminder 1' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.saved().notifications).toEqual({ reminders: [], followUps: [] })
  })

  it.each([eventType().notifications, custom])(
    'keeps a concurrent API policy when only metadata changes (baseline %j)',
    async (notifications) => {
      const api = editorApi(eventType({ notifications }))
      const user = userEvent.setup()
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      const title = await screen.findByLabelText('Title', { exact: true })
      const concurrent: Settings = {
        reminders: [],
        followUps: [
          {
            id: 'api-rule',
            offsetMinutes: 180,
            recipients: { invitee: true, guests: false, host: false },
          },
        ],
      }
      api.replace({ ...api.saved(), notifications: concurrent })
      await user.clear(title)
      await user.type(title, 'Renamed')
      await user.click(screen.getByRole('button', { name: 'Save changes' }))
      await screen.findByText('Saved.')
      expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).not.toHaveProperty(
        'notifications',
      )
      expect(api.saved().notifications).toEqual(concurrent)
    },
  )

  it('adopts the canonical server reply and keeps its stable ids for the next metadata save', async () => {
    const api = editorApi()
    const user = userEvent.setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const first = await screen.findByRole('group', { name: 'Reminder 1' })
    await user.selectOptions(within(first).getByLabelText('Timing preset'), '30')
    await user.click(screen.getByRole('button', { name: 'Add reminder' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    const saved = api.saved().notifications
    expect(saved.reminders.map(({ offsetMinutes }) => offsetMinutes)).toEqual([1440, 30])
    expect(saved.reminders[1]?.id).toBe('default-24h')
    const canonicalFirst = screen.getByRole('group', { name: 'Reminder 1' })
    expect(
      within(canonicalFirst).getByLabelText<HTMLInputElement>('Minutes before the meeting').value,
    ).toBe('1440')
    await user.type(screen.getByLabelText('Title', { exact: true }), ' renamed')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[1]?.body).not.toHaveProperty(
      'notifications',
    )
    expect(api.saved().notifications).toEqual(saved)
  })

  it('does not send settings when an edit is reverted to its session baseline', async () => {
    const api = editorApi(eventType({ notifications: custom }))
    const user = userEvent.setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const reminder = await screen.findByRole('group', { name: 'Reminder 1' })
    const preset = within(reminder).getByLabelText('Timing preset')
    await user.selectOptions(preset, '30')
    await user.selectOptions(preset, '120')
    await user.type(screen.getByLabelText('Title', { exact: true }), ' renamed')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).not.toHaveProperty(
      'notifications',
    )
  })

  it('maps server field details to the same stable rule after an earlier rule is removed', async () => {
    const initial = eventType({
      notifications: {
        reminders: [
          { ...required(custom.reminders[0]), id: 'remove-me', offsetMinutes: 30 },
          required(custom.reminders[0]),
        ],
        followUps: [],
      },
    })
    // Return a field refusal after client validation succeeds.
    const routes = fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, initial),
      [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: () =>
        json(400, {
          error: 'invalid_notifications',
          message: 'notifications.reminders[0].recipients: at least one recipient must be selected',
        }),
    })
    const user = userEvent.setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByRole('group', { name: 'Reminder 2' })
    await user.click(screen.getByRole('button', { name: 'Remove reminder 1' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const summary = await screen.findByRole('alert', { name: 'Please check the form' })
    expect(document.activeElement).toBe(summary)
    const reminder = screen.getByRole('group', { name: 'Reminder 1' })
    const recipients = within(reminder).getByRole('group', { name: 'Recipients' })
    expect(recipients.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(`${recipients.id}-error`)?.textContent).toContain(
      'Choose at least one recipient',
    )
    await user.click(within(summary).getByRole('link'))
    expect(document.activeElement?.id).toMatch(new RegExp(`^${recipients.id}`))
    expect(routes.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(1)
  })

  it('validates changed offsets and recipients locally and announces the error summary on every save', async () => {
    const api = editorApi()
    const user = userEvent.setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByLabelText('Title')
    const disclosure = screen.getByText('Reminders and follow-ups', { selector: 'summary' })
    if (!disclosure.closest('details')?.open) await user.click(disclosure)
    const reminder = await screen.findByRole('group', { name: 'Reminder 1' })
    const offset = within(reminder).getByLabelText('Minutes before the meeting')
    for (const invalid of ['4', '43201', '5.5']) {
      await user.clear(offset)
      await user.type(offset, invalid)
      await user.click(screen.getByRole('button', { name: 'Save changes' }))
      const summary = await screen.findByRole('alert', { name: 'Please check the form' })
      expect(document.activeElement).toBe(summary)
      expect(offset.getAttribute('aria-invalid')).toBe('true')
      expect(offset.getAttribute('aria-describedby')).toContain(`${offset.id}-error`)
      expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(0)
    }
    await user.clear(offset)
    await user.type(offset, '30')
    for (const name of ['Invitee', 'Guests', 'Host'])
      await user.click(within(reminder).getByRole('checkbox', { name }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(document.activeElement).toBe(
      await screen.findByRole('alert', { name: 'Please check the form' }),
    )
    expect(
      within(reminder).getByRole('group', { name: 'Recipients' }).getAttribute('aria-invalid'),
    ).toBe('true')
  })

  it('keeps field ids unique when saved rule ids contain field-name suffixes', async () => {
    const initial = eventType({
      notifications: {
        reminders: [
          { ...required(custom.reminders[0]), id: 'x' },
          { ...required(custom.reminders[0]), id: 'x-offsetMinutes', offsetMinutes: 30 },
        ],
        followUps: [],
      },
    })
    fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, initial),
      [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: () =>
        json(400, {
          error: 'invalid_notifications',
          message: 'notifications.reminders[1].id: must be unique across reminders and followUps',
        }),
    })
    const user = userEvent.setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const first = await screen.findByRole('group', { name: 'Reminder 1' })
    const second = screen.getByRole('group', { name: 'Reminder 2' })
    const section = screen.getByRole('region', { name: 'Reminders and follow-ups' })
    const ids = [...section.querySelectorAll('[id]')].map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    const input = within(first).getByLabelText<HTMLInputElement>('Minutes before the meeting')
    expect(input.value).toBe('120')
    expect(
      within(second).getByLabelText<HTMLInputElement>('Minutes before the meeting').value,
    ).toBe('30')
    await user.clear(input)
    await user.type(input, '60')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const summary = await screen.findByRole('alert', { name: 'Please check the form' })
    await user.click(within(summary).getByRole('link'))
    expect(document.activeElement).toBe(second)
  })

  it('removes error-summary targets with deleted rules and keeps surviving rule errors reachable', async () => {
    const api = editorApi()
    const user = userEvent.setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const first = await screen.findByRole('group', { name: 'Reminder 1' })
    const firstOffset = within(first).getByLabelText('Minutes before the meeting')
    await user.clear(firstOffset)
    await user.type(firstOffset, '4')
    await user.click(screen.getByRole('button', { name: 'Add reminder' }))
    const second = screen.getByRole('group', { name: 'Reminder 2' })
    const secondOffset = within(second).getByLabelText('Minutes before the meeting')
    await user.clear(secondOffset)
    await user.type(secondOffset, '5.5')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const summary = await screen.findByRole('alert', { name: 'Please check the form' })
    expect(within(summary).getAllByRole('link')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Remove reminder 1' }))
    const link = within(summary).getByRole('link')
    expect(link.getAttribute('href')).toBe(`#${secondOffset.id}`)
    expect(document.getElementById(firstOffset.id)).toBeNull()
    await user.click(link)
    expect(document.activeElement).toBe(secondOffset)
    await user.click(screen.getByRole('button', { name: 'Remove reminder 1' }))
    expect(screen.queryByRole('alert', { name: 'Please check the form' })).toBeNull()
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(0)
  })

  it('hides host note editing when disabled, preserves a saved note and only deletes it explicitly', async () => {
    const api = editorApi(eventType({ notifications: custom }), false)
    const user = userEvent.setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const followUp = await screen.findByRole('group', { name: 'Follow-up 1' })
    expect(followUp.querySelector('textarea')).toBeNull()
    expect(
      within(followUp).queryByText(required(required(custom.followUps[0]).hostNote)),
    ).toBeNull()
    expect(
      within(followUp).getByText(/Notes will not be sent while this feature is disabled/),
    ).toBeDefined()
    expect(
      screen.getByText(
        'Host notes are disabled on this instance. Remove saved notes before changing reminders or follow-ups.',
      ),
    ).toBeDefined()
    await user.type(screen.getByLabelText('Title', { exact: true }), ' renamed')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).not.toHaveProperty(
      'notifications',
    )
    expect(api.saved().notifications).toEqual(custom)
    await user.click(screen.getByRole('button', { name: 'Remove saved host note' }))
    expect(screen.queryByText(/Remove saved notes before changing/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.saved().notifications.followUps[0]).not.toHaveProperty('hostNote')
  })

  it.each([false, true])(
    'explains disabled notes without asking to remove absent notes (follow-up: %s)',
    async (hasFollowUp) => {
      const settings = hasFollowUp
        ? {
            ...custom,
            followUps: [{ ...required(custom.followUps[0]), hostNote: undefined }],
          }
        : eventType().notifications
      editorApi(eventType({ notifications: settings }), false)
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      await screen.findByRole('region', { name: 'Reminders and follow-ups' })
      expect(
        screen.getAllByText(
          'Host notes are unavailable because the instance operator has disabled them.',
        ),
      ).toHaveLength(hasFollowUp ? 2 : 1)
      expect(screen.queryByText(/Remove saved notes before changing/)).toBeNull()
      expect(screen.queryByRole('button', { name: 'Remove saved host note' })).toBeNull()
    },
  )

  it.each(['en', 'zh-CN'] as const)(
    'keeps keyboard focus on each custom timing select and announces the next field in %s',
    async (language) => {
      chooseLanguage(language)
      render(
        <Harness
          initial={{
            ...defaultNotificationsDraft(),
            followUps: [
              {
                id: 'follow-up',
                offsetMinutes: '60',
                recipients: { invitee: true, guests: false, host: false },
              },
            ],
          }}
        />,
      )
      const user = userEvent.setup()
      const status = screen.getByRole('status')
      const selects = screen.getAllByRole<HTMLSelectElement>('combobox')
      const fields = screen.getAllByRole<HTMLInputElement>('textbox')
      const announcements =
        language === 'en'
          ? [
              'Custom timing selected for reminder 1. Enter minutes before the meeting in the next field.',
              'Custom timing selected for follow-up 1. Enter minutes after the meeting in the next field.',
            ]
          : [
              '已为提醒 1 选择自定义时间。请在下一栏输入会议开始前的分钟数。',
              '已为会后消息 1 选择自定义时间。请在下一栏输入会议结束后的分钟数。',
            ]
      for (const [index, select] of selects.entries()) {
        // A closed select can emit change from arrow keys; no pointer activation is needed.
        while (document.activeElement !== select) await user.tab()
        fireEvent.change(select, { target: { value: '' } })
        expect(document.activeElement).toBe(select)
        await waitFor(() => expect(status.textContent).toBe(announcements[index]))
        expect(document.activeElement).toBe(select)
        await user.tab()
        expect(document.activeElement).toBe(fields[index])
      }
    },
  )

  it('announces keyboard additions and removals and respects per-category limits', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    const section = screen.getByRole('region', { name: 'Reminders and follow-ups' })
    const status = within(section).getByRole('status')
    const add = screen.getByRole('button', { name: 'Add reminder' })
    add.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(status.textContent).toBe('Added reminder 2.'))
    await user.click(screen.getByRole('button', { name: 'Remove reminder 2' }))
    await waitFor(() => expect(status.textContent).toBe('Removed reminder 2.'))
    expect(document.activeElement).toBe(screen.getByLabelText('Minutes before the meeting'))
    for (let i = 0; i < 4; i++) await user.click(add)
    expect((add as HTMLButtonElement).disabled).toBe(true)
    const addFollowUp = screen.getByRole('button', { name: 'Add follow-up' })
    for (let i = 0; i < 3; i++) await user.click(addFollowUp)
    expect((addFollowUp as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Remove follow-up 3' }))
    await waitFor(() => expect(status.textContent).toBe('Removed follow-up 3.'))
    expect((addFollowUp as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows a UTF-16 character counter and permits newlines in host notes', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add follow-up' }))
    const followUp = screen.getByRole('group', { name: 'Follow-up 1' })
    const note = within(followUp).getByLabelText('Host note (optional)')
    await user.type(note, 'Thanks{Enter}🙂')
    expect((note as HTMLTextAreaElement).value).toBe('Thanks\n🙂')
    expect(within(followUp).getByText(/9\s*\/\s*2,?000/)).toBeDefined()
  })

  it('retains an over-limit pasted host note, shows its real count and blocks saving until corrected', async () => {
    const api = editorApi(eventType({ notifications: custom }))
    const user = userEvent.setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const followUp = await screen.findByRole('group', { name: 'Follow-up 1' })
    const note = within(followUp).getByLabelText<HTMLTextAreaElement>('Host note (optional)')
    const pasted = '🙂'.repeat(1001)
    await user.clear(note)
    await user.paste(pasted)
    expect(note.value).toBe(pasted)
    expect(within(followUp).getByText(/2,?002\s*\/\s*2,?000 characters/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const summary = await screen.findByRole('alert', { name: 'Please check the form' })
    expect(document.activeElement).toBe(summary)
    expect(note.getAttribute('aria-invalid')).toBe('true')
    expect(note.getAttribute('aria-describedby')).toContain(`${note.id}-error`)
    expect(document.getElementById(`${note.id}-error`)?.textContent).toContain(
      'Use at most 2000 characters (now 2002).',
    )
    expect(note.value).toBe(pasted)
    expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(0)
    await user.clear(note)
    await user.paste('Thanks for your time again.')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.saved().notifications.followUps[0]?.hostNote).toBe('Thanks for your time again.')
  })

  it.each(['en', 'zh-CN'] as const)(
    'explains booking snapshots, skipped reminders and scheduled-end follow-ups in %s',
    (language) => {
      chooseLanguage(language)
      render(<Harness />)
      if (language === 'en') {
        expect(screen.getByText(/new bookings only/i)).toBeDefined()
        expect(
          screen.getByText(
            'Reminders are sent only if the send time is more than 1 hour after the booking or reschedule; otherwise they are skipped and not sent late.',
          ),
        ).toBeDefined()
        expect(screen.getByText(/regardless of attendance/i)).toBeDefined()
        expect(
          screen.getByText(
            'Cancel in Hourmere before the meeting starts. Invitees cannot stop follow-ups after the start.',
          ),
        ).toBeDefined()
      } else {
        expect(screen.getByText(/仅.*新预约|只.*新预约/)).toBeDefined()
        expect(
          screen.getByText(
            '仅当提醒的发送时间在预约创建或改期之后，且间隔超过 1 小时时才会发送；否则会跳过，不会补发。',
          ),
        ).toBeDefined()
        expect(screen.getByText(/是否.*出席|是否.*参加/)).toBeDefined()
        expect(
          screen.getByText(
            '请在会议开始前于 Hourmere 中取消预约。会议开始后，受邀人无法停止会后消息。',
          ),
        ).toBeDefined()
        expect(screen.queryByText('Reminders and follow-ups')).toBeNull()
      }
    },
  )
})
