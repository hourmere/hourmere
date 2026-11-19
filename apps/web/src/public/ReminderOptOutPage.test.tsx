import { interfaceLanguages } from '@hourmere/core/language'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { BrowserRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from '../App.tsx'
import { catalogTemplate } from '../i18n/catalogues.ts'
import { chooseLanguage } from '../i18n/store.ts'
import { fakeApi, json } from '../test/fake-api.tsx'

const PAGE = '/poll/reminder-opt-out'
const ENDPOINT = '/api/v1/public/meeting-polls/reminder-opt-out'
const POST = `POST ${ENDPOINT}`
const TOKEN = 'a'.repeat(43)
const SUCCESS = {
  pollId: '00000000-0000-4000-8000-000000000001',
  optedOutAt: '2099-01-01T00:00:00Z',
}

function open(path: string) {
  window.history.replaceState(null, '', path)
  return render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  )
}

beforeEach(() => {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
})
afterEach(() => window.history.replaceState(null, '', '/'))

it('removes the fragment, then sends an anonymous opt-out only on confirmation', async () => {
  const user = userEvent.setup()
  const pending = Promise.withResolvers<Response>()
  const net = fakeApi({ [POST]: () => pending.promise })
  const { container } = open(`${PAGE}#${TOKEN}`)
  const confirm = await screen.findByRole<HTMLButtonElement>('button', { name: 'Stop reminders' })
  expect(window.location.hash).toBe('')
  expect(JSON.stringify(window.history.state)).not.toContain(TOKEN)
  expect(container.innerHTML).not.toContain(TOKEN)
  expect(net.calls.filter((call) => call.path !== '/api/v1/instance')).toEqual([])

  await user.click(confirm)
  expect(confirm.disabled).toBe(true)
  await user.click(confirm)
  await waitFor(() => expect(net.to(POST)).toHaveLength(1))
  expect(net.to(POST)[0]).toMatchObject({ path: ENDPOINT, body: { token: TOKEN } })
  const request = vi
    .mocked(fetch)
    .mock.calls.find(([value]) => value instanceof Request && value.method === 'POST')?.[0]
  expect(request).toMatchObject({
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
  })
  pending.resolve(json(200, SUCCESS))
  const done = await screen.findByRole('heading', { name: 'Meeting poll reminders turned off' })
  await waitFor(() => expect(document.activeElement).toBe(done))
  expect(screen.queryByRole('button', { name: 'Stop reminders' })).toBeNull()
})

it.each([PAGE, `${PAGE}#malformed`, `${PAGE}?token=${TOKEN}`])(
  'asks for the email link when a fragment is missing or malformed (%s)',
  async (path) => {
    const net = fakeApi({})
    open(path)
    expect(
      await screen.findByText('Open the reminder opt-out link from your meeting poll email.'),
    ).toBeDefined()
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(PAGE)
    expect(net.to(POST)).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Stop reminders' })).toBeNull()
  },
)

it('shows the same link prompt for a rejected capability without reflecting server details', async () => {
  const user = userEvent.setup()
  fakeApi({ [POST]: () => json(404, { error: 'poll_not_found', message: TOKEN }) })
  const { container } = open(`${PAGE}#${TOKEN}`)
  await user.click(await screen.findByRole('button', { name: 'Stop reminders' }))
  expect(
    await screen.findByText('Open the reminder opt-out link from your meeting poll email.'),
  ).toBeDefined()
  expect(container.innerHTML).not.toContain(TOKEN)
})

it('keeps a neutral error on a refused request and retries only on another explicit click', async () => {
  const user = userEvent.setup()
  const send = vi
    .fn()
    .mockReturnValueOnce(json(403, { error: 'forbidden', message: TOKEN }))
    .mockReturnValueOnce(json(200, SUCCESS))
  fakeApi({ [POST]: send })
  const { container } = open(`${PAGE}#${TOKEN}`)
  const confirm = await screen.findByRole('button', { name: 'Stop reminders' })
  await user.click(confirm)
  expect((await screen.findByRole('alert')).textContent).toBe(
    'We couldn’t stop reminders. Try again.',
  )
  expect(container.innerHTML).not.toContain(TOKEN)
  expect(send).toHaveBeenCalledTimes(1)
  await user.click(confirm)
  await screen.findByRole('heading', { name: 'Meeting poll reminders turned off' })
  expect(send).toHaveBeenCalledTimes(2)
})

it.each(interfaceLanguages('public'))(
  'offers translated confirmation and feedback in %s',
  async (locale) => {
    chooseLanguage(locale)
    fakeApi({})
    open(`${PAGE}#${TOKEN}`)
    for (const message of [
      'Meeting poll reminders',
      'Confirm to stop receiving reminders for this meeting poll.',
      'Stop reminders',
      'Meeting poll reminders turned off',
      'Open the reminder opt-out link from your meeting poll email.',
      'We couldn’t stop reminders. Try again.',
    ])
      expect(catalogTemplate(locale, message), message).toBeTruthy()
    expect(
      await screen.findByRole('button', { name: catalogTemplate(locale, 'Stop reminders') ?? '' }),
    ).toBeDefined()
    expect(document.documentElement.lang).toBe(locale)
  },
)
