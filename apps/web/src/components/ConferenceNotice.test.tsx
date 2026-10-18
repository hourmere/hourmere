import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LanguageSwitcher } from '../i18n/runtime.tsx'
import { fakeApi, json } from '../test/fake-api.tsx'
import { booking, TOKEN } from '../test/public-fixtures.ts'
import { ConferenceNotice } from './ConferenceNotice.tsx'

const JOIN = 'https://meet.google.com/abc-defg-hij'
const pending = () =>
  booking({
    start: '2030-11-02T14:00:00.000Z',
    location: { kind: 'google_meet', autoCreate: true },
    conference: { provider: 'google_meet', status: 'pending', errorCode: null },
  })
const ready = () => ({
  ...pending(),
  location: { kind: 'google_meet' as const, autoCreate: true, url: JOIN },
  conference: { provider: 'google_meet' as const, status: 'ready' as const, errorCode: null },
})
const failed = () => ({
  ...pending(),
  conference: {
    provider: 'google_meet' as const,
    status: 'failed' as const,
    errorCode: 'ambiguous_create',
  },
})
afterEach(() => vi.useRealTimers())
const advance = async (ms = 2500) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('protected meeting link status', () => {
  it('polls with the private capability in a header only, then stops when ready', async () => {
    vi.useFakeTimers()
    const api = fakeApi({ 'GET /api/v1/bookings/manage': () => json(200, ready()) }),
      changed = vi.fn()
    render(<ConferenceNotice booking={pending()} manageToken={TOKEN} onChange={changed} />)
    expect(screen.queryByRole('link')).toBeNull()
    await advance()
    expect(screen.getByRole('link', { name: 'Join Google Meet' }).getAttribute('href')).toBe(JOIN)
    await advance(60_000)
    expect(api.calls).toHaveLength(1)
    expect(api.calls[0]?.headers.get('x-manage-token')).toBe(TOKEN)
    expect(api.calls[0]?.path).toBe('/api/v1/bookings/manage')
    expect(changed.mock.calls[0]?.[0]).toEqual(ready())
    expect(localStorage.getItem(TOKEN)).toBeNull()
  })
  it('never requests a session, account profile or write on a tokenless replay', async () => {
    vi.useFakeTimers()
    const api = fakeApi({})
    render(<ConferenceNotice booking={pending()} />)
    await advance(120_000)
    expect(api.calls).toHaveLength(0)
    expect(
      screen.getByText('Use the booking or failure email to check the meeting link.'),
    ).toBeDefined()
  })
  it('a failed read pauses; a manual read rechecks without creating a meeting', async () => {
    vi.useFakeTimers()
    let reject = true
    const api = fakeApi({
      'GET /api/v1/bookings/manage': () =>
        reject ? json(503, { error: 'unavailable' }) : json(200, ready()),
    })
    render(<ConferenceNotice booking={pending()} manageToken={TOKEN} />)
    await advance()
    expect(screen.getByRole('alert').textContent).toContain('Could not check')
    await advance(60_000)
    expect(api.calls).toHaveLength(1)
    reject = false
    fireEvent.click(screen.getByRole('button', { name: 'Check meeting link status' }))
    await advance(1)
    expect(screen.getByRole('link', { name: 'Join Google Meet' })).toBeDefined()
    expect(api.calls.every((c) => c.method === 'GET')).toBe(true)
  })
  it('unknown creation has only a safe host retry, with no force-create payload or automatic write', async () => {
    vi.useFakeTimers()
    const api = fakeApi({
      [`POST /api/v1/bookings/${pending().id}/conference/retry`]: () =>
        new Response(null, { status: 204 }),
      [`GET /api/v1/bookings/${pending().id}`]: () => json(200, pending()),
    })
    render(<ConferenceNotice booking={failed()} host />)
    await advance(60_000)
    expect(api.calls).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Recheck existing meeting' }))
    await advance(1)
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(api.calls[0]?.body).toEqual({})
    expect(api.calls[0]?.headers.has('x-manage-token')).toBe(false)
    expect(screen.getByText(/Your time is reserved. The Google Meet link/)).toBeDefined()
  })
  it('never retries a host write whose response is lost', async () => {
    vi.useFakeTimers()
    const api = fakeApi({
      [`POST /api/v1/bookings/${pending().id}/conference/retry`]: () => {
        throw new TypeError('lost')
      },
    })
    render(<ConferenceNotice booking={failed()} host />)
    fireEvent.click(screen.getByRole('button', { name: 'Recheck existing meeting' }))
    await advance()
    expect(screen.getByRole('alert').textContent).toContain('Could not request a safe retry')
    await advance(60_000)
    expect(api.calls).toHaveLength(1)
  })
  it('retains capability, requests and form draft across language changes', async () => {
    vi.useFakeTimers()
    const api = fakeApi({ 'GET /api/v1/bookings/manage': () => json(200, pending()) })
    render(
      <>
        <LanguageSwitcher />
        <input aria-label="Synthetic draft" defaultValue="keep me" />
        <ConferenceNotice booking={pending()} manageToken={TOKEN} />
      </>,
    )
    fireEvent.change(screen.getByLabelText('Synthetic draft'), {
      target: { value: 'unsaved text' },
    })
    fireEvent.change(screen.getByLabelText('Interface language'), { target: { value: 'zh-CN' } })
    expect(screen.getByRole('heading', { name: '会议链接' })).toBeDefined()
    await advance()
    expect((screen.getByLabelText('Synthetic draft') as HTMLInputElement).value).toBe(
      'unsaved text',
    )
    expect(api.calls).toHaveLength(1)
    expect(api.calls[0]?.headers.get('x-manage-token')).toBe(TOKEN)
    expect(localStorage.getItem('hourmere-language')).toBe('zh-CN')
    expect(Object.values(localStorage)).not.toContain(TOKEN)
    expect(Object.values(localStorage)).not.toContain(JOIN)
  })
  it('aborts and ignores an old booking read after unmount', async () => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void, request: Request | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((input: Request) => {
        request = input
        return new Promise<Response>((resolve) => {
          finish = resolve
        })
      }),
    )
    const changed = vi.fn(),
      view = render(<ConferenceNotice booking={pending()} manageToken={TOKEN} onChange={changed} />)
    await advance()
    view.unmount()
    expect(request?.signal.aborted).toBe(true)
    await act(async () => {
      finish(json(200, ready()))
      await Promise.resolve()
    })
    expect(changed).not.toHaveBeenCalled()
  })
  it('retains a cancelled cleanup retry after the start and never offers its old join link', () => {
    fakeApi({})
    render(
      <ConferenceNotice
        booking={{
          ...failed(),
          status: 'cancelled',
          start: '2000-01-01T00:00:00Z',
          location: ready().location,
        }}
        host
      />,
    )
    expect(screen.getByRole('button', { name: 'Retry Google calendar cleanup' })).toBeDefined()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(/cleanup needs the host/)).toBeDefined()
  })
  it('cancellation aborts a same-id pending read and discards its late confirmed-ready result', async () => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void, request: Request | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((input: Request) => {
        request = input
        return new Promise<Response>((resolve) => {
          finish = resolve
        })
      }),
    )
    const changed = vi.fn(),
      view = render(<ConferenceNotice booking={pending()} manageToken={TOKEN} onChange={changed} />)
    await advance()
    view.rerender(
      <ConferenceNotice
        booking={{ ...pending(), status: 'cancelled' }}
        manageToken={TOKEN}
        onChange={changed}
      />,
    )
    expect(request?.signal.aborted).toBe(true)
    await act(async () => {
      finish(json(200, ready()))
      await Promise.resolve()
    })
    expect(changed).not.toHaveBeenCalled()
    expect(screen.queryByRole('link')).toBeNull()
    expect(
      screen.getByText('Your booking is cancelled. The Google calendar update is pending.'),
    ).toBeDefined()
  })
  it('cancellation aborts an in-flight safe retry and discards its late completion', async () => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void, request: Request | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((input: Request) => {
        request = input
        return new Promise<Response>((resolve) => {
          finish = resolve
        })
      }),
    )
    const view = render(<ConferenceNotice booking={failed()} host />)
    fireEvent.click(screen.getByRole('button', { name: 'Recheck existing meeting' }))
    await advance(1)
    view.rerender(<ConferenceNotice booking={{ ...failed(), status: 'cancelled' }} host />)
    expect(request?.signal.aborted).toBe(true)
    await act(async () => {
      finish(new Response(null, { status: 204 }))
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: 'Retry Google calendar cleanup' })).toBeDefined()
    expect(
      screen.queryByText('Your booking is cancelled. The Google calendar update is pending.'),
    ).toBeNull()
  })
})
