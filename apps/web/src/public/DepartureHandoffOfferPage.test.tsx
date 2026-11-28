import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../App.tsx'
import type { Schemas } from '../api/client.ts'
import { chooseLanguage } from '../i18n/store.ts'
import { fakeApi, json } from '../test/fake-api.tsx'

const path = '/booking/handoff'
const read = 'POST /api/v1/booking-handoffs/offer'
const answer = 'POST /api/v1/booking-handoffs/answer'
const capability = `00000000-0000-4000-8000-000000000001.${'A'.repeat(43)}`
const link = `${path}#token=${capability}`
const offer: Schemas['DepartureHandoffParticipantOffer'] = {
  version: 4,
  expiresAt: '2026-12-05T18:30:00Z',
  role: 'booker',
  current: {
    start: '2026-12-06T18:00:00Z',
    end: '2026-12-06T18:30:00Z',
    timeZone: 'America/Los_Angeles',
    hostName: 'Current host',
    location: { kind: 'phone' },
  },
  proposed: {
    start: '2026-12-06T18:30:00Z',
    end: '2026-12-06T18:45:00Z',
    timeZone: 'America/Los_Angeles',
    hostName: 'New host',
    location: { kind: 'in_person', address: 'Main office' },
  },
  answers: [{ label: 'Meeting topic', value: 'Private booker details' }],
}

describe('the participant handoff page', () => {
  let router: ReturnType<typeof createAppRouter> | undefined

  function open(url: string) {
    window.history.replaceState(null, '', url)
    router = createAppRouter()
    render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    )
  }

  afterEach(() => {
    router?.dispose()
    router = undefined
    window.history.replaceState(null, '', '/')
  })

  it('clears the private link before reading and submits the reviewed version only after a separate action', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      [read]: () => {
        expect(window.location.hash).toBe('')
        expect(window.location.search).toBe('')
        expect(JSON.stringify(window.history.state)).not.toContain(capability)
        return json(200, offer)
      },
      [answer]: () => json(200, { decision: 'accept' }),
    })
    open(link)

    await screen.findByRole('heading', { name: 'Review booking handoff' })
    expect(screen.getByText(/A decline or a missing reply blocks the handoff/)).toBeDefined()
    expect(screen.getByText(/Only the latest link works/)).toBeDefined()
    expect(screen.getByText('Private booker details')).toBeDefined()
    expect(screen.getByText('Main office')).toBeDefined()
    expect(document.body.innerHTML).not.toContain(capability)
    expect(api.to(read).map(({ body }) => body)).toEqual([{ token: capability }])
    const accept = screen.getByRole<HTMLInputElement>('radio', { name: 'Accept' })
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Submit decision' })
    expect(accept.checked).toBe(false)
    expect(submit.disabled).toBe(true)
    act(() => accept.focus())
    await user.keyboard(' ')
    expect(api.to(answer)).toHaveLength(0)
    await user.tab()
    expect(document.activeElement).toBe(submit)
    await user.keyboard('{Enter}')

    const outcome = await screen.findByRole('heading', { name: 'Acceptance recorded' })
    expect(document.activeElement).toBe(outcome)
    expect(screen.getByText(/Your current booking stays confirmed/)).toBeDefined()
    expect(screen.queryByText('Private booker details')).toBeNull()
    expect(api.calls.map(({ method, path: url }) => `${method} ${url}`)).toEqual([read, answer])
    expect(api.to(answer)[0]?.body).toEqual({ token: capability, version: 4, decision: 'accept' })
    for (const [request] of vi.mocked(fetch).mock.calls) {
      expect(request).toMatchObject({
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      })
    }
  })

  it('explains in Simplified Chinese that one missing reply blocks handoff and a decline closes the proposal', async () => {
    chooseLanguage('zh-CN')
    const user = userEvent.setup()
    fakeApi({
      [read]: () => json(200, { ...offer, role: 'guest', answers: [] }),
      [answer]: () => json(200, { decision: 'decline' }),
    })
    open(link)

    await screen.findByRole('heading', { name: '查看预约交接提议' })
    expect(screen.getByText(/只要有一人拒绝或未回复，交接就无法进行/)).toBeDefined()
    expect(screen.getByText(/仅最新链接有效/)).toBeDefined()
    await user.click(screen.getByRole('radio', { name: '拒绝' }))
    await user.click(screen.getByRole('button', { name: '提交决定' }))
    await screen.findByRole('heading', { name: '已记录拒绝' })
    expect(screen.getByText('你已拒绝这份提议，提议随之关闭。当前预约保持原样。')).toBeDefined()
  })

  it('shows recovery for query-only capabilities without reading or submitting', async () => {
    const api = fakeApi({})
    open(`${path}?token=${capability}`)
    await screen.findByRole('heading', { name: 'This handoff link is unavailable' })
    expect(window.location.search).toBe('')
    expect(screen.queryByRole('radio')).toBeNull()
    expect(api.calls).toEqual([])
  })

  it('checks a new fragment in place, conceals booker fields from guests and handles a stale answer neutrally', async () => {
    const user = userEvent.setup()
    const guestCapability = `00000000-0000-4000-8000-000000000002.${'B'.repeat(43)}`
    const api = fakeApi({
      [read]: ({ body }) =>
        json(
          200,
          (body as { token: string }).token === capability ? offer : { ...offer, role: 'guest' },
        ),
      [answer]: () =>
        json(404, { error: 'handoff_offer_unavailable', message: 'Internal stale version reason' }),
    })
    open(link)
    await screen.findByRole('heading', { name: 'Answers shared with the new host' })
    await act(async () => {
      window.location.hash = `token=${guestCapability}`
    })
    await waitFor(() => expect(api.to(read)).toHaveLength(2))
    await screen.findByRole('radio', { name: 'Decline' })
    expect(screen.queryByText('Private booker details')).toBeNull()
    expect(window.location.hash).toBe('')
    expect(api.to(read).map(({ body }) => body)).toEqual([
      { token: capability },
      { token: guestCapability },
    ])

    await user.click(screen.getByRole('radio', { name: 'Decline' }))
    await user.click(screen.getByRole('button', { name: 'Submit decision' }))
    await screen.findByRole('heading', { name: 'This handoff link is unavailable' })
    expect(screen.queryByText('Internal stale version reason')).toBeNull()
    expect(screen.queryByText('New host')).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(api.to(answer).map(({ body }) => body)).toEqual([
      { token: guestCapability, version: 4, decision: 'decline' },
    ])
  })
})
