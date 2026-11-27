import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, expect, it } from 'vitest'
import { chooseLanguage } from '../../i18n/store.ts'
import { resolveEventTypeEditor } from '../../test/event-type-editor.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { schedule } from '../../test/fixtures.ts'

beforeAll(resolveEventTypeEditor)

function disclosure(label: string) {
  return screen.getByText(label, { selector: 'summary' })
}

function summary(label: string) {
  return disclosure(label).querySelector('.event-settings-summary')?.textContent
}

it('updates every personal settings summary and leaves the values visible when groups close', async () => {
  chooseLanguage('en')
  const api = fakeApi({
    ...signedInAs(ME),
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: [schedule({ name: 'Weekdays' })] }),
  })
  const user = userEvent.setup()
  renderApp('/app/event-types/new')
  await screen.findByRole('heading', { name: 'New event type', level: 1 })

  const basics = within(screen.getByRole('region', { name: 'Basics' }))
  expect(basics.getByText('30 min · No location')).toBeDefined()
  const defaults = {
    'Description and visibility': 'Active · Listed · No description · Position 0',
    'Group events': 'One invitee per session',
    'Additional durations': 'No additional durations',
    'Location options and conferencing': 'No location',
    'Booking waitlist': 'Disabled',
    'Reminders and follow-ups': '1 reminder · 0 follow-ups',
    'Booking form': '0 questions · Guests off',
    'After booking': 'Booking confirmation',
    'When people can book': 'Weekdays · Default timing rules',
  }
  for (const [label, text] of Object.entries(defaults)) {
    expect(disclosure(label).closest('details')?.open).toBe(false)
    expect(summary(label)).toBe(text)
  }

  await user.click(basics.getByRole('button', { name: '45 minutes' }))
  await user.selectOptions(basics.getByLabelText('Where the meeting happens'), 'google_meet')
  expect(basics.getByText('45 min · Google Meet')).toBeDefined()
  expect(summary('Location options and conferencing')).toBe('Google Meet')

  async function edit(
    label: string,
    update: (controls: ReturnType<typeof within>) => Promise<void>,
  ) {
    const header = disclosure(label)
    const group = header.closest('details') as HTMLDetailsElement
    await user.click(header)
    await update(within(group))
    await user.click(header)
    expect(group.open).toBe(false)
  }

  await edit('Description and visibility', async (controls) => {
    await user.type(controls.getByLabelText(/^Description/), 'A new description')
    await user.click(controls.getByLabelText('Hide from your booking page'))
  })
  expect(summary('Description and visibility')).toBe(
    'Active · Unlisted · Description added · Position 0',
  )

  await edit('Group events', async (controls) => {
    await user.selectOptions(controls.getByLabelText('Booking mode'), 'group')
    fireEvent.change(controls.getByLabelText('Seats per session'), { target: { value: '8' } })
  })
  expect(summary('Group events')).toBe('8 seats per session')
  await edit('Group events', async (controls) => {
    await user.selectOptions(controls.getByLabelText('Booking mode'), 'individual')
  })

  await edit('Additional durations', async (controls) => {
    await user.click(controls.getByRole('button', { name: 'Add 1 h' }))
  })
  expect(summary('Additional durations')).toBe('45 min · 1 h')

  await edit('Location options and conferencing', async (controls) => {
    await user.selectOptions(controls.getByLabelText('Add location option'), 'in_person')
    await user.click(controls.getByRole('button', { name: 'Add location option' }))
  })
  expect(summary('Location options and conferencing')).toBe(
    'Google Meet (default location) · In person',
  )

  await edit('Booking waitlist', async (controls) => {
    await user.click(
      controls.getByLabelText('Let invitees join a waitlist when no times are available'),
    )
  })
  expect(summary('Booking waitlist')).toBe('Enabled')

  await edit('Reminders and follow-ups', async (controls) => {
    await user.click(controls.getByRole('button', { name: 'Add follow-up' }))
    await user.click(controls.getByLabelText('SMS reminders'))
  })
  expect(summary('Reminders and follow-ups')).toBe('1 reminder · 1 follow-up · SMS reminders')

  await edit('Booking form', async (controls) => {
    await user.click(controls.getByRole('button', { name: 'Add a question' }))
    await user.click(controls.getByLabelText('Allow invitees to add guests'))
  })
  expect(summary('Booking form')).toBe('1 question · Guests allowed')

  await edit('After booking', async (controls) => {
    fireEvent.change(controls.getByLabelText(/^Continue to URL/), {
      target: { value: 'https://example.com/thanks?private=draft' },
    })
    await user.click(controls.getByLabelText('Start time'))
  })
  expect(summary('After booking')).toBe('Continue to example.com · 1 URL parameter')

  await edit('When people can book', async (controls) => {
    fireEvent.change(controls.getByLabelText('Minimum notice'), { target: { value: '120' } })
    fireEvent.change(controls.getByLabelText(/^Daily limit/), { target: { value: '2' } })
  })
  expect(summary('When people can book')).toBe('Weekdays · 2 h notice · Daily limit 2')
  expect(api.calls.some((call) => call.method !== 'GET')).toBe(false)
})

it('reports the absence of a default schedule when the loaded schedule list is empty', async () => {
  chooseLanguage('en')
  fakeApi({
    ...signedInAs(ME),
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: [] }),
  })
  renderApp('/app/event-types/new')

  await screen.findByRole('link', { name: 'Set your availability' }, { timeout: 5000 })
  expect(summary('When people can book')).toBe('No default schedule · Default timing rules')
})

it('summarizes team scheduling and the selected host count as the assignment changes', async () => {
  chooseLanguage('zh-CN')
  const team = { ...ME, organization: { ...ME.organization, personal: false } }
  fakeApi({
    ...signedInAs(team),
    'GET /api/v1/schedules': () => json(200, { data: [] }),
    'GET /api/v1/event-type-hosts': () =>
      json(200, {
        data: [
          { id: ME.user.id, name: 'Ada' },
          { id: 'peer', name: 'Peer' },
        ],
        nextAfter: null,
      }),
  })
  const user = userEvent.setup()
  renderApp('/app/event-types/new')
  await screen.findByLabelText('标题', { exact: true }, { timeout: 5000 })
  const header = disclosure('主持人')
  expect(summary('主持人')).toBe('单一主持人；已选 1 位主持人')
  await user.click(header)
  const controls = within(header.closest('details') as HTMLDetailsElement)
  await user.selectOptions(controls.getByRole('combobox'), 'collective')
  await user.click(await controls.findByRole('checkbox', { name: 'Peer' }))
  await user.click(header)
  expect(summary('主持人')).toBe('共同主持；已选 2 位主持人')
  expect(summary('何时可预约')).toBe('使用主持人的可用时间；默认预约时间规则')
})
