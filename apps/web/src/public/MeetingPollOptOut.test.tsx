import { interfaceLanguages } from '@hourmere/core/language'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { BrowserRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from '../App.tsx'
import { catalogTemplate } from '../i18n/catalogues.ts'
import { fakeApi, json } from '../test/fake-api.tsx'

// Reminder mails link here (packages/mail meeting-polls): the poll page's opt-out entry.
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
  expect(await screen.findByText('Reminders for this poll are stopped.')).toBeDefined()
  const heading = screen.getByRole('heading', { name: 'Stop poll reminders' })
  await waitFor(() => expect(document.activeElement).toBe(heading))
  expect(screen.queryByRole('button', { name: 'Stop reminders' })).toBeNull()
})

it.each([PAGE, `${PAGE}?token=${TOKEN}`])(
  'asks for the email link when the fragment is missing (%s)',
  async (path) => {
    const net = fakeApi({})
    open(path)
    expect(await screen.findByText('This poll is unavailable.')).toBeDefined()
    expect(window.location.hash).toBe('')
    expect(net.to(POST)).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Stop reminders' })).toBeNull()
  },
)

it('shows the unavailable state for a rejected capability without reflecting server details', async () => {
  const user = userEvent.setup()
  fakeApi({ [POST]: () => json(404, { error: 'poll_not_found', message: TOKEN }) })
  const { container } = open(`${PAGE}#${TOKEN}`)
  await user.click(await screen.findByRole('button', { name: 'Stop reminders' }))
  expect(await screen.findByText('This poll is unavailable.')).toBeDefined()
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
  await user.click(await screen.findByRole('button', { name: 'Stop reminders' }))
  expect((await screen.findByRole('alert')).textContent).toBe(
    'We couldn’t stop reminders. Try again.',
  )
  expect(container.innerHTML).not.toContain(TOKEN)
  expect(send).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('button', { name: 'Stop reminders' }))
  await screen.findByText('Reminders for this poll are stopped.')
  expect(send).toHaveBeenCalledTimes(2)
})

it.each(interfaceLanguages('public'))('translates the opt-out failure in %s', (locale) => {
  expect(catalogTemplate(locale, 'meetingPoll.optOutError')).toBeTruthy()
})
