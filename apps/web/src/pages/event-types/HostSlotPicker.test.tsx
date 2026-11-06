import '../../i18n/admin.ts'
import * as snippet from '@hourmere/core/slot-snippet'
import { formatSlotLabel } from '@hourmere/core/slot-snippet'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as zonePicker from '../../components/TimeZonePicker.tsx'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { chooseLanguage } from '../../i18n/store.ts'
import type { Slot } from '../../public/api.ts'
import { addDays, parseDateKey } from '../../public/calendar.ts'
import { dateKeyIn, instantOf } from '../../public/time.ts'
import { fakeApi, json, later, PROFILE } from '../../test/fake-api.tsx'
import { eventType } from '../../test/fixtures.ts'
import { HostSlotPicker, type HostSlotPickerProps } from './HostSlotPicker.tsx'

const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(() => {
  if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

const DAY = dateKeyIn(Date.now(), PROFILE.timeZone)
const slots = (count = 2, minutes = 30, day = DAY): Slot[] =>
  Array.from({ length: count }, (_, index) => {
    const start = Date.parse(`${day}T09:00:00.000Z`) + index * 30 * 60_000
    return {
      start: new Date(start).toISOString(),
      end: new Date(start + minutes * 60_000).toISOString(),
    }
  })
const publicEvent = (overrides = {}) => ({
  title: 'Intro call',
  handle: 'ada',
  slug: 'intro-call',
  durationMinutes: 30,
  allowedDurationsMinutes: [30, 60],
  host: { name: 'Ada', timeZone: 'Europe/Berlin' },
  description: null,
  location: null,
  questions: [],
  allowGuests: false,
  ...overrides,
})
const ROUTE = 'GET /api/v1/public/ada/intro-call/slots'
const META = 'GET /api/v1/public/ada/intro-call'
const props = (overrides: Partial<HostSlotPickerProps> = {}): HostSlotPickerProps => ({
  event: eventType({ allowedDurationsMinutes: [30, 60] }),
  profile: PROFILE,
  address: { kind: 'personal', handle: 'ada', slug: 'intro-call' },
  publicUrl: 'https://booking.example.com',
  verifyAccess: vi.fn(async () => {}),
  ...overrides,
})
const element = (value: HostSlotPickerProps) => (
  <InterfaceScope surface="admin">
    <HostSlotPicker {...value} />
  </InterfaceScope>
)
function renderPicker(value = props()) {
  return render(element(value))
}
function available() {
  return within(screen.getByRole('group', { name: 'Available times' }))
}
async function choose(indices = [0]) {
  await waitFor(() => expect(available().getAllByRole('checkbox').length).toBeGreaterThan(0))
  for (const index of indices)
    fireEvent.click(available().getAllByRole('checkbox')[index] as HTMLInputElement)
}
async function preview() {
  fireEvent.click(screen.getByRole('button', { name: 'Preview email' }))
  await screen.findByRole('textbox', { name: 'Complete plain-text email preview' })
}
const textPreview = () =>
  screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Complete plain-text email preview' })
function clipboard() {
  const writeText = vi.fn(async (_text: string) => {})
  const write = vi.fn(async (_items: unknown[]) => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, write } })
  return { writeText, write }
}
class PromiseItem {
  readonly data: Record<string, Blob | Promise<Blob>>
  constructor(data: Record<string, Blob | Promise<Blob>>) {
    this.data = data
  }
  get types() {
    return Object.keys(this.data)
  }
  async getType(type: string) {
    const blob = await this.data[type]
    if (!blob) throw new Error('missing_type')
    return blob
  }
}
function promiseClipboard() {
  const clip = clipboard()
  const committed = vi.fn()
  clip.write.mockImplementation(async (items) => {
    for (const item of items as PromiseItem[])
      await Promise.all(item.types.map((type) => item.getType(type)))
    committed()
  })
  vi.stubGlobal('ClipboardItem', PromiseItem)
  return { ...clip, committed }
}
function server(offered = slots()) {
  return fakeApi({
    [ROUTE]: ({ path }) => {
      const query = new URL(path, location.origin).searchParams
      const duration = Number(query.get('durationMinutes'))
      return json(200, {
        data: offered.map((slot) => ({
          ...slot,
          end: new Date(Date.parse(slot.start) + duration * 60_000).toISOString(),
        })),
      })
    },
    [META]: () => json(200, publicEvent()),
  })
}

describe('host open-time picker', () => {
  it('requires 1–10 choices, sorts reverse selection, and rechecks bounded exact intervals with explicit length', async () => {
    const client = server(slots(11))
    const clip = clipboard()
    const value = props()
    renderPicker(value)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Preview email' }).disabled).toBe(
      true,
    )
    await choose([9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
    expect(available().getAllByRole<HTMLInputElement>('checkbox')[10]?.disabled).toBe(true)
    expect(screen.getByText('Selected times: 10 (maximum 10)')).toBeDefined()
    await preview()
    const text = textPreview().value
    expect(text.indexOf(encodeURIComponent(slots(11)[0]?.start ?? ''))).toBeLessThan(
      text.indexOf(encodeURIComponent(slots(11)[9]?.start ?? '')),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
    await screen.findByText('Plain text copied.')
    expect(clip.writeText).toHaveBeenCalledOnce()
    expect(value.verifyAccess).toHaveBeenCalledTimes(3)
    const checks = client.to(ROUTE).slice(1)
    expect(checks).toHaveLength(10)
    for (const check of checks) {
      const query = new URL(check.path, location.origin).searchParams
      expect(query.get('durationMinutes')).toBe('30')
      expect(Date.parse(query.get('end') ?? '') - Date.parse(query.get('start') ?? '')).toBe(
        30 * 60_000,
      )
    }
    expect(client.calls.every((call) => call.method === 'GET' && call.body === undefined)).toBe(
      true,
    )
  })

  it('clears selection and preview when duration changes, with the saved default preselected', async () => {
    const client = server()
    renderPicker()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Meeting length' }).value).toBe(
      '30',
    )
    await choose()
    await preview()
    fireEvent.change(screen.getByRole('combobox', { name: 'Meeting length' }), {
      target: { value: '60' },
    })
    expect(screen.getByText('Selected times: 0 (maximum 10)')).toBeDefined()
    expect(screen.queryByRole('textbox', { name: 'Complete plain-text email preview' })).toBeNull()
    await waitFor(() => expect(client.to(ROUTE)).toHaveLength(2))
    expect(
      new URL(client.to(ROUTE)[1]?.path ?? '', location.origin).searchParams.get('durationMinutes'),
    ).toBe('60')
  })

  it('keeps selected instants and URLs when display settings change and reloads the new zone day', async () => {
    // Tokyo can already be tomorrow while the default Berlin fixture is still today.
    const client = server(slots(2, 30, dateKeyIn(Date.now(), 'Asia/Tokyo')))
    renderPicker(props({ profile: { ...PROFILE, locale: 'fr-CA', timeZone: 'Asia/Tokyo' } }))
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Email language' }).value).toBe(
      'fr',
    )
    await choose([1, 0])
    await preview()
    const urls = textPreview().value.match(/https:\/\/\S+/g)
    fireEvent.change(screen.getByRole('combobox', { name: 'Email language' }), {
      target: { value: 'zh-CN' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Display time zone' }), {
      target: { value: 'America/New_York' },
    })
    expect(textPreview().value.match(/https:\/\/\S+/g)).toEqual(urls)
    expect(textPreview().value).toContain('America/New_York')
    expect(screen.getByText('Selected times: 2 (maximum 10)')).toBeDefined()
    await waitFor(() => expect(client.to(ROUTE)).toHaveLength(2))
    expect(
      screen.getByRole('combobox', { name: 'Email language' }).querySelectorAll('option'),
    ).toHaveLength(6)
  })

  it('uses English and UTC without a supported profile and warns before sharing hidden event types', async () => {
    server()
    renderPicker(
      props({
        profile: { ...PROFILE, locale: 'unsupported', timeZone: 'invalid' },
        event: eventType({ isHidden: true }),
      }),
    )
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Email language' }).value).toBe(
      'en',
    )
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Display time zone' }).value,
    ).toBe('UTC')
    expect(
      screen.getByText(
        'This event type is unlisted. Anyone with these links can open the booking page and book an available time.',
      ),
    ).toBeDefined()
    await choose()
    await preview()
    expect(textPreview().value).toContain('UTC')
  })

  it('copies nothing when any exact end disappears, retains every selected row, and requires explicit stale removal', async () => {
    let checks = false
    const chosen = slots()
    fakeApi({
      [META]: () => json(200, publicEvent()),
      [ROUTE]: ({ path }) => {
        const start = new URL(path, location.origin).searchParams.get('start')
        return json(200, {
          data:
            checks && start === chosen[0]?.start ? [{ ...chosen[0], end: chosen[1]?.end }] : chosen,
        })
      },
    })
    const clip = clipboard()
    renderPicker()
    await choose([0, 1])
    await preview()
    checks = true
    fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
    await screen.findByText(
      'Some selected times are no longer offered. Nothing was copied. Remove those times manually before trying again.',
    )
    expect(clip.writeText).not.toHaveBeenCalled()
    expect(screen.getByText('Selected times: 2 (maximum 10)')).toBeDefined()
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2)
    expect(screen.getByText('No longer offered')).toBeDefined()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Preview email' }).disabled).toBe(
      true,
    )
    fireEvent.click(screen.getAllByRole('button', { name: /^Remove / })[0] as HTMLButtonElement)
    expect(screen.getByText('Selected times: 1 (maximum 10)')).toBeDefined()
    await preview()
    fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
    await screen.findByText('Plain text copied.')
    expect(clip.writeText).toHaveBeenCalledOnce()
  })

  it.each([401, 403, 429, 500, 409])(
    'keeps unknown copy-time HTTP %s neutral and retryable without marking taken',
    async (status) => {
      let checks = false
      fakeApi({
        [META]: () => json(200, publicEvent()),
        [ROUTE]: () =>
          checks
            ? json(status, { error: 'calendar_sync_unavailable' })
            : json(200, { data: slots() }),
      })
      const clip = clipboard()
      renderPicker()
      await choose()
      await preview()
      checks = true
      fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
      await screen.findByText(
        'We could not check the selected times. Nothing was copied. Please try again.',
      )
      expect(screen.queryByText('No longer offered')).toBeNull()
      expect(screen.queryByText('No times are offered on this date.')).toBeNull()
      expect(screen.getByText('Selected times: 1 (maximum 10)')).toBeDefined()
      expect(clip.writeText).not.toHaveBeenCalled()
      expect(screen.queryByRole('button', { name: 'Copy plain text' })).toBeNull()
      checks = false
      await preview()
      fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
      await screen.findByText('Plain text copied.')
    },
  )

  it('keeps unknown day reads neutral and offers a retry', async () => {
    let failure = true
    fakeApi({
      [ROUTE]: () => (failure ? json(403, { error: 'forbidden' }) : json(200, { data: slots() })),
    })
    renderPicker()
    await screen.findByText('We could not load available times. Please try again.')
    expect(screen.getByRole('alert').textContent).toBe(
      'We could not load available times. Please try again.',
    )
    expect(screen.queryByText('No times are offered on this date.')).toBeNull()
    failure = false
    fireEvent.click(screen.getByRole('button', { name: 'Check availability again' }))
    await choose()
    expect(screen.getByText('Selected times: 1 (maximum 10)')).toBeDefined()
  })

  it('refuses a duration removed from current public metadata', async () => {
    const client = fakeApi({
      [ROUTE]: () => json(200, { data: slots() }),
      [META]: () => json(200, publicEvent({ durationMinutes: 60, allowedDurationsMinutes: [60] })),
    })
    const clip = clipboard()
    renderPicker()
    await choose()
    await preview()
    fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
    await screen.findByText(
      'This meeting length is no longer offered. Reload the saved event type before trying again.',
    )
    expect(clip.writeText).not.toHaveBeenCalled()
    expect(client.to(ROUTE)).toHaveLength(1)
    expect(screen.getByText('Selected times: 1 (maximum 10)')).toBeDefined()
  })

  it('writes both rich MIME types in one action with complete plain text', async () => {
    server()
    const clip = clipboard()
    class Item {
      readonly data: Record<string, Blob | Promise<Blob>>
      constructor(data: Record<string, Blob | Promise<Blob>>) {
        this.data = data
      }
      getType(type: string) {
        return Promise.resolve(this.data[type] as Blob | Promise<Blob>)
      }
    }
    vi.stubGlobal('ClipboardItem', Item)
    renderPicker()
    await choose()
    await preview()
    const text = textPreview().value
    fireEvent.click(screen.getByRole('button', { name: 'Copy rich text' }))
    await screen.findByText('Rich text copied with a plain-text fallback.')
    expect(clip.write).toHaveBeenCalledOnce()
    const item = clip.write.mock.calls[0]?.[0]?.[0] as Item
    expect(Object.keys(item.data).sort()).toEqual(['text/html', 'text/plain'])
    expect((await item.getType('text/plain')).size).toBe(new TextEncoder().encode(text).byteLength)
    expect(clip.writeText).not.toHaveBeenCalled()
  })

  it.each(['plain', 'rich', 'unsupported'] as const)(
    'provides complete selectable manual copy after %s clipboard failure',
    async (kind) => {
      server()
      const clip = clipboard()
      clip.writeText.mockRejectedValue(new Error('denied'))
      clip.write.mockRejectedValue(new Error('denied'))
      if (kind !== 'unsupported') vi.stubGlobal('ClipboardItem', class {})
      else vi.stubGlobal('ClipboardItem', undefined)
      renderPicker()
      await choose([0, 1])
      await preview()
      const text = textPreview().value
      fireEvent.click(
        screen.getByRole('button', {
          name: kind === 'plain' ? 'Copy plain text' : 'Copy rich text',
        }),
      )
      await screen.findByText(
        'Clipboard access was unavailable. Select and copy the complete plain-text preview manually.',
      )
      expect(textPreview().value).toBe(text)
      await waitFor(() => expect(document.activeElement).toBe(textPreview()))
      expect(textPreview().selectionEnd - textPreview().selectionStart).toBe(text.length)
      expect(screen.queryByText('Plain text copied.')).toBeNull()
      expect(screen.queryByText('Rich text copied with a plain-text fallback.')).toBeNull()
    },
  )

  it('rechecks current access after availability and refuses a removed manager', async () => {
    server()
    const clip = clipboard()
    const verifyAccess = vi
      .fn(async () => {})
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('role_changed'))
    renderPicker(props({ verifyAccess }))
    await choose()
    await preview()
    fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
    await screen.findByText(
      'We could not check the selected times. Nothing was copied. Please try again.',
    )
    expect(verifyAccess).toHaveBeenCalledTimes(3)
    expect(clip.writeText).not.toHaveBeenCalled()
  })

  it('ignores late copy checks when the saved event changes', async () => {
    const pending = later()
    fakeApi({ [ROUTE]: () => json(200, { data: slots() }), [META]: () => pending.response })
    const clip = clipboard()
    const value = props()
    const view = renderPicker(value)
    await choose()
    await preview()
    fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
    await screen.findByText('Checking selected times…')
    view.rerender(element({ ...value, event: eventType({ id: 'new-event' }) }))
    await pending.answer(json(200, publicEvent()))
    expect(clip.writeText).not.toHaveBeenCalled()
    expect(screen.getByText('Selected times: 0 (maximum 10)')).toBeDefined()
  })

  it('ignores late copy checks after disabled context or unmount', async () => {
    const pending = later()
    fakeApi({ [ROUTE]: () => json(200, { data: slots() }), [META]: () => pending.response })
    const clip = clipboard()
    const value = props()
    const view = renderPicker(value)
    await choose()
    await preview()
    fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
    await screen.findByText('Checking selected times…')
    view.rerender(element({ ...value, disabled: true }))
    await pending.answer(json(200, publicEvent()))
    expect(clip.writeText).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Copy plain text' })).toBeNull()
    view.unmount()
  })

  it('keeps later day results when an older request resolves last', async () => {
    const pending = later()
    const tomorrow = new Date(Date.parse(`${DAY}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
    const next = { start: `${tomorrow}T14:00:00.000Z`, end: `${tomorrow}T14:30:00.000Z` }
    fakeApi({
      [ROUTE]: ({ path }) =>
        dateKeyIn(
          Date.parse(new URL(path, location.origin).searchParams.get('start') ?? ''),
          PROFILE.timeZone,
        ) === DAY
          ? pending.response
          : json(200, { data: [next] }),
    })
    renderPicker()
    fireEvent.change(screen.getByLabelText(`Availability date (${PROFILE.timeZone})`), {
      target: { value: tomorrow },
    })
    await choose()
    await pending.answer(json(200, { data: slots() }))
    expect(available().getAllByRole('checkbox')).toHaveLength(1)
    expect(
      available().getByRole('checkbox', {
        name: formatSlotLabel(next.start, next.end, 'en', PROFILE.timeZone),
      }),
    ).toBeDefined()
  })

  it('supports keyboard checkbox selection and descriptive rows with DST/cross-midnight labels', async () => {
    const user = userEvent.setup()
    const start = `${DAY}T23:30:00.000Z`
    const end = new Date(Date.parse(start) + 60 * 60_000).toISOString()
    fakeApi({ [ROUTE]: () => json(200, { data: [{ start, end }] }) })
    renderPicker(
      props({
        event: eventType({ durationMinutes: 60 }),
        profile: { ...PROFILE, timeZone: 'UTC' },
      }),
    )
    await waitFor(() => expect(available().getAllByRole('checkbox')).toHaveLength(1))
    const checkbox = available().getByRole('checkbox')
    act(() => checkbox.focus())
    await user.keyboard(' ')
    expect((checkbox as HTMLInputElement).checked).toBe(true)
    expect(checkbox.getAttribute('aria-label')).toBeNull()
    expect(checkbox.parentElement?.textContent).toContain('UTC')
    expect(checkbox.parentElement?.textContent).toContain(
      new Date(end).toLocaleDateString('en-US', { day: 'numeric' }),
    )
    expect(
      screen
        .getByText('Selected times: 1 (maximum 10)')
        .closest('[role="status"]')
        ?.getAttribute('aria-live'),
    ).toBe('polite')
  })

  it('uses Chinese admin strings without changing email language', async () => {
    chooseLanguage('zh-CN')
    server()
    renderPicker()
    expect(screen.getByRole('heading', { name: '将可约时间复制到邮件' })).toBeDefined()
    expect(screen.getByLabelText<HTMLSelectElement>('邮件语言').value).toBe('en')
    await waitFor(() => expect(screen.queryByText('正在加载可约时间……')).toBeNull())
  })

  it('checks fresh authorization before preview and allows a neutral retry after denial', async () => {
    const client = server()
    const verifyAccess = vi.fn(async () => {}).mockRejectedValueOnce(new Error('manager_removed'))
    renderPicker(props({ verifyAccess }))
    await choose()
    fireEvent.click(screen.getByRole('button', { name: 'Preview email' }))
    await screen.findByText(
      'We could not prepare the preview. Nothing was copied. Please try again.',
    )
    expect(screen.queryByRole('textbox', { name: 'Complete plain-text email preview' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy plain text' })).toBeNull()
    expect(screen.getByText('Selected times: 1 (maximum 10)')).toBeDefined()
    expect(client.to(META)).toHaveLength(0)
    await preview()
    expect(verifyAccess).toHaveBeenCalledTimes(2)
  })

  it.each(['event', 'disabled', 'unmount'] as const)(
    'discards a delayed preview after %s changes',
    async (change) => {
      server()
      let answer = () => {}
      const pending = new Promise<void>((resolve) => {
        answer = resolve
      })
      const verifyAccess = vi.fn(() => pending)
      const value = props({ verifyAccess })
      const view = renderPicker(value)
      await choose()
      fireEvent.click(screen.getByRole('button', { name: 'Preview email' }))
      await screen.findByText('Checking that you can preview these times…')
      if (change === 'unmount') view.unmount()
      else if (change === 'disabled') view.rerender(element({ ...value, disabled: true }))
      else view.rerender(element({ ...value, event: eventType({ id: 'changed-event' }) }))
      await act(async () => {
        answer()
        await pending
      })
      expect(
        screen.queryByRole('textbox', { name: 'Complete plain-text email preview' }),
      ).toBeNull()
      expect(screen.queryByRole('button', { name: 'Copy plain text' })).toBeNull()
    },
  )

  it('splits only an oversized start day into two bounded requests including full long intervals', async () => {
    const start = `${DAY}T10:00:00.000Z`
    const end = new Date(Date.parse(start) + 1440 * 60_000).toISOString()
    const client = fakeApi({
      [ROUTE]: ({ path }) => {
        const query = new URL(path, location.origin).searchParams
        const width = Date.parse(query.get('end') ?? '') - Date.parse(query.get('start') ?? '')
        return width > 36 * 60 * 60_000
          ? json(400, { error: 'range_too_long' })
          : json(200, { data: [{ start, end }] })
      },
    })
    renderPicker(props({ event: eventType({ durationMinutes: 1440, slotStepMinutes: 1 }) }))
    await choose()
    expect(client.to(ROUTE)).toHaveLength(3)
    for (const call of client.to(ROUTE).slice(1)) {
      const query = new URL(call.path, location.origin).searchParams
      expect(query.get('durationMinutes')).toBe('1440')
      expect(Date.parse(query.get('end') ?? '') - Date.parse(query.get('start') ?? '')).toBe(
        36 * 60 * 60_000,
      )
    }
    expect(available().getAllByRole('checkbox')).toHaveLength(1)
  })

  it('uses current saved public metadata in both clipboard output and the manual preview', async () => {
    fakeApi({
      [ROUTE]: () => json(200, { data: slots() }),
      [META]: () => json(200, publicEvent({ title: 'Saved updated title' })),
    })
    const clip = clipboard()
    clip.writeText.mockRejectedValue(new Error('denied'))
    renderPicker(props({ event: eventType({ description: 'private-description' }) }))
    await choose()
    await preview()
    expect(textPreview().value).toContain('Intro call')
    fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
    await screen.findByText(
      'Clipboard access was unavailable. Select and copy the complete plain-text preview manually.',
    )
    expect(textPreview().value).toContain('Saved updated title')
    expect(textPreview().value).not.toContain('private-description')
    expect(clip.writeText.mock.calls[0]?.[0]).toBe(textPreview().value)
    expect(textPreview().value).toContain('https://booking.example.com/ada/intro-call?')
  })

  it('loads personal or team public slots and metadata without native browser Temporal', async () => {
    vi.stubGlobal('Temporal', undefined)
    const client = fakeApi({
      'GET /api/v1/public/teams/design-team/intro-call/slots': () => json(200, { data: slots() }),
      'GET /api/v1/public/teams/design-team/intro-call': () =>
        json(200, publicEvent({ team: { name: 'Design team', slug: 'design-team' } })),
    })
    const clip = clipboard()
    renderPicker(
      props({
        address: { kind: 'team', teamSlug: 'design-team', slug: 'intro-call' },
        event: eventType({ ownerUserId: null, schedulingType: 'collective' }),
      }),
    )
    await choose()
    await preview()
    fireEvent.click(screen.getByRole('button', { name: 'Copy plain text' }))
    await screen.findByText('Plain text copied.')
    expect(clip.writeText.mock.calls[0]?.[0]).toContain(
      'https://booking.example.com/team/design-team/intro-call?',
    )
    expect(
      client.calls.every(
        (call) => call.method === 'GET' && call.path.startsWith('/api/v1/public/teams/'),
      ),
    ).toBe(true)
  })

  it.each(['plain', 'rich'] as const)(
    'starts %s clipboard writing inside the click, then resolves checked blobs and retains focus',
    async (kind) => {
      server()
      const clip = promiseClipboard()
      let release = () => {}
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      const verifyAccess = vi.fn(async () => {}).mockImplementationOnce(async () => {})
      renderPicker(props({ verifyAccess }))
      await choose()
      await preview()
      expect(screen.getByText('Email preview ready.').closest('[role="status"]')).not.toBeNull()
      verifyAccess.mockImplementationOnce(() => pending)
      const button = screen.getByRole<HTMLButtonElement>('button', {
        name: kind === 'plain' ? 'Copy plain text' : 'Copy rich text',
      })
      fireEvent.click(button)
      expect(clip.write).toHaveBeenCalledOnce()
      expect(clip.committed).not.toHaveBeenCalled()
      expect(verifyAccess).toHaveBeenCalledTimes(2)
      expect(button.disabled).toBe(false)
      expect(button.getAttribute('aria-disabled')).toBe('true')
      expect(document.activeElement).toBe(button)
      const item = clip.write.mock.calls[0]?.[0]?.[0] as PromiseItem
      expect(item.types.sort()).toEqual(
        kind === 'plain' ? ['text/plain'] : ['text/html', 'text/plain'],
      )
      for (const value of Object.values(item.data)) expect(value).toBeInstanceOf(Promise)
      await act(async () => release())
      await screen.findByText(
        kind === 'plain' ? 'Plain text copied.' : 'Rich text copied with a plain-text fallback.',
      )
      const blob = await item.getType('text/plain')
      expect(blob.type).toBe('text/plain')
      expect(blob.size).toBe(new TextEncoder().encode(textPreview().value).byteLength)
      if (kind === 'rich') expect((await item.getType('text/html')).type).toBe('text/html')
      expect(clip.committed).toHaveBeenCalledOnce()
      expect(clip.writeText).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(button)
    },
  )

  it.each([
    'initial access',
    'final access',
    'metadata',
    'unavailable interval',
    'unknown interval',
  ])('rejects every promised rich representation after a failed %s recheck', async (failure) => {
    let recheck = false
    fakeApi({
      [META]: () =>
        failure === 'metadata' ? json(403, { error: 'forbidden' }) : json(200, publicEvent()),
      [ROUTE]: () =>
        recheck && failure === 'unknown interval'
          ? json(403, { error: 'forbidden' })
          : json(200, { data: recheck && failure === 'unavailable interval' ? [] : slots() }),
    })
    const clip = promiseClipboard()
    const verifyAccess = vi.fn(async () => {})
    renderPicker(props({ verifyAccess }))
    await choose()
    await preview()
    if (failure === 'initial access') verifyAccess.mockRejectedValueOnce(new Error('forbidden'))
    if (failure === 'final access')
      verifyAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('forbidden'))
    recheck = true
    const button = screen.getByRole('button', { name: 'Copy rich text' })
    act(() => button.focus())
    fireEvent.click(button)
    expect(clip.write).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByText('Checking selected times…')).toBeNull())
    const item = clip.write.mock.calls[0]?.[0]?.[0] as PromiseItem
    await expect(item.getType('text/plain')).rejects.toBeInstanceOf(Error)
    await expect(item.getType('text/html')).rejects.toBeInstanceOf(Error)
    expect(clip.committed).not.toHaveBeenCalled()
    expect(clip.writeText).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Check availability again' }),
    )
    expect(screen.queryByText('Rich text copied with a plain-text fallback.')).toBeNull()
  })

  it.each(['throws', 'stringifies'] as const)(
    'feature-detects a legacy ClipboardItem that %s promise data and offers complete manual rich copy',
    async (support) => {
      server()
      const clip = clipboard()
      class LegacyItem {
        readonly value: Blob
        constructor(data: Record<string, Blob | Promise<Blob>>) {
          if (support === 'throws') throw new TypeError('Blob required')
          this.value = new Blob([String(data['text/plain'])], { type: 'text/plain' })
        }
        async getType() {
          return this.value
        }
      }
      vi.stubGlobal('ClipboardItem', LegacyItem)
      renderPicker()
      await choose()
      await preview()
      fireEvent.click(screen.getByRole('button', { name: 'Copy rich text' }))
      await screen.findByText(
        'Clipboard access was unavailable. Select and copy the complete plain-text preview manually.',
      )
      expect(clip.write).not.toHaveBeenCalled()
      await waitFor(() => expect(document.activeElement).toBe(textPreview()))
      expect(textPreview().selectionEnd - textPreview().selectionStart).toBe(
        textPreview().value.length,
      )
    },
  )

  it('filters browser zone names the snippet formatter rejects and catches label errors neutrally', async () => {
    vi.spyOn(zonePicker, 'timeZoneNames').mockReturnValue(['UTC', 'Europe/Berlin', 'EST5EDT'])
    vi.spyOn(snippet, 'formatSlotLabel').mockImplementation(() => {
      throw new RangeError('Intl failure')
    })
    server()
    renderPicker()
    const options = [
      ...screen.getByRole<HTMLSelectElement>('combobox', { name: 'Display time zone' }).options,
    ]
    expect(options.map(({ value }) => value)).toEqual(['Europe/Berlin', 'UTC'])
    await choose()
    expect(
      available().getAllByRole('checkbox', {
        name: 'This time could not be displayed. Please try another display time zone.',
      }),
    ).toHaveLength(2)
    expect(screen.getByText('Selected times: 1 (maximum 10)')).toBeDefined()
  })

  it.each([
    ['Pacific/Kiritimati', '2026-03-07T12:30:00Z', '2026-03-08', 24],
    ['America/Los_Angeles', '2026-03-09T01:00:00Z', '2026-03-08', 23],
    ['America/Los_Angeles', '2026-11-02T01:00:00Z', '2026-11-01', 25],
  ] as const)(
    'loads the local calendar day and DST boundary in %s at %s',
    async (zone, now, day, hours) => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now))
      const start = instantOf(parseDateKey(day), 0, 0, zone)
      const boundary = instantOf(parseDateKey(addDays(day, 1)), 0, 0, zone)
      const onDay = {
        start: new Date(start).toISOString(),
        end: new Date(start + 30 * 60_000).toISOString(),
      }
      const outside = {
        start: new Date(boundary).toISOString(),
        end: new Date(boundary + 30 * 60_000).toISOString(),
      }
      const client = fakeApi({ [ROUTE]: () => json(200, { data: [onDay, outside] }) })
      renderPicker(props({ profile: { ...PROFILE, timeZone: zone } }))
      expect(screen.getByLabelText<HTMLInputElement>(`Availability date (${zone})`).value).toBe(day)
      await choose()
      expect(available().getAllByRole('checkbox')).toHaveLength(1)
      const query = new URL(client.to(ROUTE)[0]?.path ?? '', location.origin).searchParams
      expect(query.get('start')).toBe(onDay.start)
      expect(Date.parse(query.get('end') ?? '')).toBe(boundary + 30 * 60_000)
      expect(boundary - start).toBe(hours * 60 * 60_000)
      expect(dateKeyIn(Date.parse(onDay.start), zone)).toBe(day)
    },
  )

  it.each([
    [
      'invalid_title',
      'The saved event title is invalid. Reload the saved event type and try again.',
    ],
    [
      'invalid_address',
      'The saved booking link is invalid. Reload the saved event type and try again.',
    ],
    [
      'snippet_too_large',
      'The email preview could not be created. Please choose fewer times and try again.',
    ],
    [
      'invalid_slots',
      'The email preview could not be created. Reload the saved event type and try again.',
    ],
  ] as const)('explains the formatter cause %s accurately', async (code, message) => {
    server()
    vi.spyOn(snippet, 'formatSlotSnippet').mockImplementation(() => {
      throw new snippet.SlotSnippetError(code)
    })
    renderPicker()
    await choose()
    fireEvent.click(screen.getByRole('button', { name: 'Preview email' }))
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.queryByText('Email preview ready.')).toBeNull()
  })
})
